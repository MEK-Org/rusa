import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveRepoRoot } from "../../commands/service-instance.js";
import { createLogger } from "../../observability/logger.js";
import { GitRunner } from "../../update/runner.js";
import { FollowerEventQueue } from "./follower-event-queue.js";
import type { FollowerCommand, FollowerEvent } from "./follower-hub.js";
import { FollowerInstance } from "./follower-instance.js";
import { isFullCommitSha } from "./follower-update-validation.js";
import { executeFollowerUpdate, FollowerBuildRunner } from "./follower-updater.js";
import { type FollowerUpdateCommand, INSTANCE_PROTOCOL_VERSION } from "./protocol.js";

const { values } = parseArgs({
  options: {
    leader: { type: "string" },
    id: { type: "string", default: hostname().replace(/[^a-zA-Z0-9_-]/g, "-") },
    home: { type: "string" },
    "token-file": { type: "string" },
    sandbox: { type: "string" },
    "repo-path": { type: "string" },
  },
});
if (
  !values.leader ||
  !values.home ||
  !values["token-file"] ||
  !["bwrap", "none"].includes(values.sandbox ?? "")
) {
  throw new Error(
    "Required: --leader URL --id NAME --home PATH --token-file PATH --sandbox bwrap|none"
  );
}
const leader = new URL(values.leader);
if (leader.protocol !== "http:" && leader.protocol !== "https:")
  throw new Error("Invalid leader URL");
const token = readFileSync(values["token-file"], "utf8").trim();
// Everything this process has to say about itself is a diagnostic, so it goes
// to the application logger like the leader's. The enrollment secret is
// registered so it is scrubbed if it ever reaches an error message.
const log = createLogger({ secrets: [token], context: { component: "follower", id: values.id } });
const root = resolve(values.home);
mkdirSync(join(root, "workers"), { recursive: true });
// Instance-wide configuration is local; never mutate cwd/env for individual actors.
process.env.RUSA_HOME = root;

function tryGetCommitSha(dir: string): string | undefined {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      encoding: "utf8",
    }).trim();
    if (isFullCommitSha(sha)) return sha;
  } catch {}
  return undefined;
}

const repoRoot = values["repo-path"] ? resolveRepoRoot(values["repo-path"]) : resolveRepoRoot();
const packageDir = join(repoRoot, "packages", "rusa");
try {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    name?: unknown;
  };
  if (manifest.name !== "rusa") throw new Error("unexpected package name");
} catch {
  throw new Error(
    `Refusing follower update outside a rusa checkout: expected ${join(packageDir, "package.json")}`
  );
}

const instance = new FollowerInstance(root, values.sandbox === "bwrap", (event) =>
  emit(event.actorId, event.message, event.eventId)
);
let session = "";
let leaderToken: string | undefined;
let stopped = false;
const eventQueue = new FollowerEventQueue<FollowerEvent>();
let sendTimer: ReturnType<typeof setTimeout> | undefined;

class FollowerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "FollowerHttpError";
  }
}

async function post<T>(path: string, body: object): Promise<T> {
  const response = await fetch(new URL(path, leader), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: values.id, session, ...body }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok)
    throw new FollowerHttpError(`Leader ${path}: HTTP ${response.status}`, response.status);
  return (await response.json()) as T;
}
function emit(actorId: string, message: FollowerEvent["message"], eventId?: string): void {
  if (stopped) return;
  eventQueue.enqueue({ eventId: eventId ?? randomUUID(), actorId, message });
  if (!eventQueue.isFlushing && !sendTimer)
    sendTimer = setTimeout(() => {
      sendTimer = undefined;
      void flush();
    }, 5);
}
async function flush(): Promise<void> {
  if (stopped) return;
  try {
    await eventQueue.flush((batch) => post("/events", batch));
  } catch (error) {
    log.warn("follower_event_flush_failed", { err: error });
    if (error instanceof FollowerHttpError && error.status === 410) {
      session = "";
    }
    if (!stopped && eventQueue.hasPending && !sendTimer) {
      sendTimer = setTimeout(() => {
        sendTimer = undefined;
        void flush();
      }, 500);
    }
  }
}
async function stop(code: number, flushTerminalStatus = false): Promise<void> {
  if (stopped) return;
  // `restarting` is the last status the old process can truthfully emit. Flush
  // it before the shutdown brake rejects events; the force timer keeps a dead
  // leader connection from delaying restart indefinitely.
  const force = setTimeout(() => {
    process.exit(code);
  }, 1500);
  if (flushTerminalStatus) {
    clearTimeout(sendTimer);
    sendTimer = undefined;
    await flush();
  }
  stopped = true;
  clearTimeout(sendTimer);
  instance.close();
  if (session) await post("/unregister", {}).catch(() => {});
  // Give interrupted provider invocations time to unwind, as part of instance shutdown.
  while (instance.actorIds.length) await new Promise((resolve) => setTimeout(resolve, 20));
  clearTimeout(force);
  process.exit(code);
}
process.on("SIGINT", () => {
  void stop(0);
});
process.on("SIGTERM", () => {
  void stop(0);
});

async function run(): Promise<void> {
  let backoffMs = 500;
  const maxBackoffMs = 10_000;

  while (!stopped) {
    if (!session) {
      try {
        const registration = await post<{
          session: string;
          protocolVersion: number;
          leaderToken?: string;
        }>("/register", {
          platform: process.platform,
          pid: process.pid,
          protocolVersion: INSTANCE_PROTOCOL_VERSION,
          commitSha: tryGetCommitSha(repoRoot),
        });
        if (registration.protocolVersion !== INSTANCE_PROTOCOL_VERSION)
          throw new Error("Incompatible instance protocol; rebuild leader and follower");

        if (leaderToken && registration.leaderToken && registration.leaderToken !== leaderToken) {
          log.info("follower_leader_restarted_fencing_pending_events", {
            oldLeaderToken: leaderToken,
            newLeaderToken: registration.leaderToken,
          });
          eventQueue.clear();
        }
        leaderToken = registration.leaderToken;
        session = registration.session;
        backoffMs = 500;
        log.info("follower_registered", {
          leader: leader.origin,
          pid: process.pid,
          sandbox: values.sandbox,
          commitSha: tryGetCommitSha(repoRoot),
        });
        void flush();
      } catch (error) {
        if (stopped) break;
        if (error instanceof Error && error.message.includes("Incompatible instance protocol")) {
          throw error;
        }
        log.warn("follower_registration_failed", { err: error, retryInMs: backoffMs });
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        continue;
      }
    }

    try {
      if (eventQueue.hasPending && !eventQueue.isFlushing) void flush();
      const commands = await post<FollowerCommand[]>("/poll", {});
      for (const command of commands) {
        if ("actorId" in command) {
          instance.dispatch(command);
        } else if (command.type === "update") {
          void handleUpdate(command);
        }
      }
      backoffMs = 500;
    } catch (error) {
      if (stopped) break;
      log.warn("follower_poll_failed", { err: error, retryInMs: backoffMs });
      session = "";
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  }
}

async function handleUpdate(command: FollowerUpdateCommand): Promise<void> {
  log.info("follower_update_received", {
    updateId: command.updateId,
    targetSha: command.targetSha,
    branch: command.branch,
  });
  await executeFollowerUpdate(
    {
      updateId: command.updateId,
      targetSha: command.targetSha,
      branch: command.branch,
    },
    {
      git: new GitRunner(repoRoot),
      build: new FollowerBuildRunner(packageDir, undefined, (m) => log.info(m)),
      drain: {
        drain: async (timeoutMs) => {
          instance.beginDrain();
          const outcome = await instance.waitForQuiescence(timeoutMs);
          log.info("follower_update_drain_complete", outcome);
          return outcome;
        },
      },
      emitter: {
        emitStatus: (statusEvent) => {
          emit("$instance", statusEvent);
        },
      },
      exit: (code) => stop(code, true),
      log: (m) => log.info(m),
    }
  );
  await flush();
}

try {
  await run();
} catch (error) {
  log.error("follower_stopped", { err: error });
  await stop(1);
}
