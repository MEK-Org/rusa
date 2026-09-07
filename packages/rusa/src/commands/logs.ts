import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveServiceInstance, type ServiceEnvironment } from "./service-instance.js";

function hasCommand(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function follow(command: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code);
    });
  });
}

export async function runLogs(opts?: { environment?: ServiceEnvironment }): Promise<void> {
  const instance = resolveServiceInstance(opts?.environment ?? "production");
  const logPath = instance.logPath;

  if (hasCommand("journalctl")) {
    console.log("Following systemd logs (no history). Press Ctrl-C to stop.\n");

    const code = await follow("journalctl", [
      "--user",
      "-u",
      instance.serviceUnit,
      "-f",
      "-n",
      "0",
      "-o",
      "cat",
    ]);

    // Usually Ctrl-C ends the process; only fall back on explicit failure.
    if (code === 0 || code === null) {
      return;
    }

    console.log("journalctl follow failed; falling back to log file tail.\n");
  }

  if (!existsSync(logPath)) {
    throw new Error(
      `No log file found at ${logPath}. Start the service or run 'rusa install-service' first.`
    );
  }

  console.log(`Following ${logPath} (no history). Press Ctrl-C to stop.\n`);
  await follow("tail", ["-n", "0", "-F", logPath]);
}

/**
 * `rusa logs --actor <id>`: a raw tail of one actor's model output.
 *
 * The service log and the actor stream are different things read different
 * ways. `journalctl -u rusa` is the mesh describing what it did; an actor's
 * prose never reaches it, so this mode does not read the journal at all. It
 * follows the same dashboard live-output SSE stream a browser tab subscribes
 * to, which is why a terminal tail and the dashboard show the same bytes.
 */

/** Where the running service serves the dashboard API for this home. */
export function actorStreamUrl(
  dashboard: { port?: number; bindHost?: string } | undefined,
  actorId: string
): string {
  const port = dashboard?.port ?? 8080;
  const bindHost = dashboard?.bindHost?.trim() || "0.0.0.0";
  // A wildcard bind is an address to listen on, not one to dial: reach the
  // local service over loopback in both families.
  const host =
    bindHost === "0.0.0.0" || bindHost === "::" || bindHost === "*"
      ? "127.0.0.1"
      : bindHost.includes(":")
        ? `[${bindHost}]`
        : bindHost;
  return `http://${host}:${port}/api/mesh/stream?actors=${encodeURIComponent(actorId)}`;
}

/** Split a read buffer into complete SSE frames, keeping the partial tail. */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { frames: parts.filter((frame) => frame.length > 0), rest };
}

/** The payload of one SSE frame, or null for comments and other channels. */
export function frameLiveOutput(frame: string): { actorId: string; text: string } | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat / connection comment
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) {
      const value = line.slice("data:".length);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  if (event !== "live_output" || data.length === 0) return null;
  try {
    const parsed = JSON.parse(data.join("\n")) as { actorId?: unknown; text?: unknown };
    if (typeof parsed.text !== "string" || typeof parsed.actorId !== "string") return null;
    return { actorId: parsed.actorId, text: parsed.text };
  } catch {
    // A frame we cannot parse is not the actor's words; dropping it keeps the
    // tail faithful to what the dashboard renders.
    return null;
  }
}

/**
 * The stream could not be opened at all — nothing to tail, so the command
 * reports the reason and exits rather than printing a transport stack trace.
 */
export class ActorStreamUnavailable extends Error {
  readonly name = "ActorStreamUnavailable";
}

export interface FollowActorOutputOptions {
  url: string;
  /**
   * Print only this actor's chunks. The endpoint already filters by the
   * `actors` query parameter, so this is the same answer reached twice — but
   * the guarantee the command makes ("one actor's words, pipeable") is then
   * true locally, rather than resting on a remote filter staying correct.
   */
  actorId?: string;
  /** Where the actor's prose goes — process.stdout in the command. */
  write: (text: string) => void;
  /** Out-of-band notices (elisions, connection state) that must not pollute the prose. */
  notify?: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * Follow one actor's live output until the stream ends or `signal` aborts.
 *
 * Prose is written verbatim and nothing else joins it on that channel, so
 * `rusa logs --actor <id> > run.txt` captures exactly what the actor said. The
 * hub drops the oldest frames rather than growing an unbounded buffer for a
 * slow reader; when it does it says so, and that gap is reported out of band
 * instead of being passed off as silence.
 */
export async function followActorOutput(opts: FollowActorOutputOptions): Promise<void> {
  let response: Response;
  try {
    response = await fetch(opts.url, {
      headers: { Accept: "text/event-stream" },
      signal: opts.signal,
    });
  } catch (err) {
    // The usual reason a tail cannot start is that nothing is listening — the
    // service is down, or the dashboard is on a different port than the config
    // being read. Say that, rather than letting a transport error surface as an
    // undici stack trace over a one-line CLI.
    throw new ActorStreamUnavailable(
      `Could not reach the actor output stream at ${opts.url}: ${
        err instanceof Error ? err.message : String(err)
      }. Is the service running, and is its dashboard on that address?`
    );
  }
  if (!response.ok || !response.body) {
    throw new ActorStreamUnavailable(
      `Actor output stream returned HTTP ${response.status} from ${opts.url}. Is the service running?`
    );
  }

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });
      const { frames, rest } = splitSseFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        const chunk = frameLiveOutput(frame);
        if (chunk) {
          if (opts.actorId === undefined || chunk.actorId === opts.actorId) opts.write(chunk.text);
        } else if (frame.startsWith("event: elided")) {
          opts.notify?.("[rusa] some output was dropped (reader too slow)\n");
        }
      }
    }
  } catch (err) {
    // A tail ends when its source goes away — a service restart, a Ctrl-C, a
    // dropped socket. That is the end of the follow, not a crash to raise a
    // stack trace over; a stream that never opened at all still throws above.
    if (opts.signal?.aborted) return;
    opts.notify?.(
      `[rusa] actor output stream ended: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

export interface DashboardAddress {
  port?: number;
  bindHost?: string;
}

/**
 * Read just the dashboard address out of a home's `config.yaml`.
 *
 * Deliberately not `loadConfig`: that validates the whole file and throws on
 * anything it does not like, and a tail of an actor's output should not stop
 * working because some unrelated section is mid-edit. Two fields are read, each
 * only when it has the right type; anything else falls through to the same
 * defaults the loader applies. `null` means the file could not be read at all,
 * which the caller reports before falling back.
 */
export function readDashboardAddress(mcHome: string): DashboardAddress | null {
  try {
    const parsed = parseYaml(readFileSync(join(mcHome, "config.yaml"), "utf8")) as {
      dashboard?: { port?: unknown; bindHost?: unknown };
    } | null;
    const dashboard = parsed?.dashboard;
    return {
      port: typeof dashboard?.port === "number" ? dashboard.port : undefined,
      bindHost: typeof dashboard?.bindHost === "string" ? dashboard.bindHost : undefined,
    };
  } catch {
    return null;
  }
}

export async function runActorLogs(opts: {
  actorId: string;
  environment?: ServiceEnvironment;
  home?: string;
}): Promise<void> {
  const instance = resolveServiceInstance(opts.environment ?? "production", opts.home);
  const address = readDashboardAddress(instance.mcHome);
  if (!address) {
    console.error(
      `Could not read ${join(instance.mcHome, "config.yaml")}; trying the default dashboard address.`
    );
  }
  const url = actorStreamUrl(address ?? undefined, opts.actorId);

  // Everything this command says about itself goes to stderr, so stdout carries
  // the actor's words and only those: `rusa logs --actor <id> > run.txt` is the
  // transcript of the run, not a transcript with a banner on top.
  console.error(
    `Following output for actor ${opts.actorId} (the same stream the dashboard shows). Press Ctrl-C to stop.\n`
  );
  try {
    await followActorOutput({
      url,
      actorId: opts.actorId,
      write: (text) => {
        process.stdout.write(text);
      },
      notify: (text) => {
        process.stderr.write(text);
      },
    });
  } catch (err) {
    if (!(err instanceof ActorStreamUnavailable)) throw err;
    console.error(err.message);
    process.exitCode = 1;
  }
}
