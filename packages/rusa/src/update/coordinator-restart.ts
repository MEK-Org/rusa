import { execFile, spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { POOL_COORDINATOR_UNIT } from "../commands/coordinator-provisioning.js";
import { resolveQuotaBackupPaths } from "../commands/quota-backup.js";
import {
  coordinatorLoadedRevision,
  defaultQuotaCoordinatorSocketPath,
} from "../commands/quota-coordinator.js";
import { readUnitEnvironment } from "../commands/service-instance.js";
import { loadConfig } from "../config/index.js";
import type {
  CoordinatorOwnership,
  CoordinatorRestartSeam,
  CoordinatorTarget,
} from "./orchestrator.js";
import { runTimedStep } from "./runner.js";

export const COORDINATOR_RESTART_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 200;
/** Each readiness attempt's wall-clock bound: connect, headers, and body together. */
const READY_ATTEMPT_TIMEOUT_MS = 2_000;
/** A ready envelope is a few hundred bytes; anything far larger is not one. */
export const READY_ENVELOPE_MAX_BYTES = 64 * 1024;

type ReadyEnvelope = { service?: { loadedRevision?: unknown } };

/**
 * Read the loaded revision from one readyz response, or null when the
 * coordinator cannot say. The timer bounds the whole exchange rather than
 * inactivity, so a server that keeps writing, never ends, or drops the
 * connection mid-body still settles within `timeoutMs`.
 */
export function readReadyRevision(
  socketPath: string,
  timeoutMs = READY_ATTEMPT_TIMEOUT_MS
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (revision: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(revision);
    };
    const timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
    const request = http.request({ socketPath, path: "/v1/readyz", method: "GET" }, (response) => {
      if (response.statusCode !== 200) {
        finish(null);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > READY_ENVELOPE_MAX_BYTES) finish(null);
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ReadyEnvelope;
          const revision = parsed.service?.loadedRevision;
          finish(typeof revision === "string" && revision ? revision : null);
        } catch {
          finish(null);
        }
      });
      // An aborted body emits `error` and/or `close` without `end`.
      response.on("error", () => finish(null));
      response.on("close", () => finish(null));
    });
    request.on("error", () => finish(null));
    request.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until readyz identifies the exact expected revision. `timeoutMs` is a
 * total bound: every attempt is capped by the time remaining.
 */
export async function waitForCoordinatorRevision(opts: {
  socketPath: string;
  expectedRevision: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? COORDINATOR_RESTART_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? READY_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let observed: string | null = null;
  for (let remaining = timeoutMs; remaining > 0; remaining = deadline - Date.now()) {
    observed = await readReadyRevision(
      opts.socketPath,
      Math.min(READY_ATTEMPT_TIMEOUT_MS, remaining)
    );
    if (observed === opts.expectedRevision) return;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `quota coordinator did not report loaded revision ${opts.expectedRevision.slice(0, 7)} ` +
      `within ${timeoutMs}ms${observed ? ` (last reported ${observed.slice(0, 7)})` : ""}`
  );
}

/** The `systemctl show` properties ownership is decided from. */
export const COORDINATOR_SHOW_PROPERTIES = [
  "LoadState",
  "NeedDaemonReload",
  "ExecStart",
  "Environment",
] as const;

function showProperty(show: string, name: string): string[] {
  const prefix = `${name}=`;
  return show
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Decide from systemd's *effective* view of the pool unit whether this
 * checkout's build is what a restart would launch, and where that coordinator
 * listens.
 *
 * `systemctl show` folds in `<unit>.d/*.conf` drop-ins and resolves repeated
 * assignments, so it is the launch definition rather than the base file. It is
 * also only the definition systemd has *loaded*: `NeedDaemonReload=yes` means
 * the files on disk say something else, so neither view is known to be what a
 * restart runs. Anything not established — no answer from systemd, a reload
 * pending, several or no commands, an argv this parser cannot split
 * unambiguously, a home or config it cannot read — is `unknown`, never
 * inferred from the fixed unit name or from a reachable socket.
 *
 * `show` is the raw output of `systemctl --user show -p …` for
 * {@link COORDINATOR_SHOW_PROPERTIES}, or null when systemd could not be asked.
 */
export function resolvePoolCoordinatorOwnership(opts: {
  /** This checkout's built CLI, e.g. `<checkout>/packages/rusa/dist/cli.js`. */
  cliPath: string;
  show: string | null;
  unit?: string;
  /** The caller's runtime dir, used only when the unit sets none. */
  fallbackRuntimeDir?: string;
}): CoordinatorOwnership {
  const unit = opts.unit ?? POOL_COORDINATOR_UNIT;
  const unknown = (reason: string): CoordinatorOwnership => ({
    ownership: "unknown",
    reason: `${unit}: ${reason}`,
  });
  if (opts.show === null) return unknown("systemd could not be asked for its launch settings");
  const loadState = showProperty(opts.show, "LoadState").at(-1);
  if (loadState === "not-found") {
    return { ownership: "not-owner", reason: `no ${unit} is installed (client-only host)` };
  }
  if (loadState !== "loaded") return unknown(`unit load state is ${loadState ?? "unreported"}`);
  if (showProperty(opts.show, "NeedDaemonReload").at(-1) !== "no") {
    return unknown("its unit files changed since systemd loaded them (daemon-reload pending)");
  }

  // `argv[]=` is systemd's space-joined argv, one per command.
  const commands = showProperty(opts.show, "ExecStart").flatMap((value) =>
    [...value.matchAll(/argv\[\]=(.*?) ; /g)].map((match) => match[1])
  );
  if (commands.length !== 1)
    return unknown(`expected one ExecStart command, found ${commands.length}`);
  const argv = commands[0].split(" ");
  const ownCli = canonicalPath(opts.cliPath);
  if (argv[2] !== "quota-coordinator" || !argv[1]) {
    // Includes a path containing a space, which systemd prints unquoted.
    return unknown(`cannot split its ExecStart unambiguously: ${commands[0]}`);
  }
  if (canonicalPath(argv[1]) !== ownCli) {
    if (!existsSync(argv[1])) return unknown(`its executable ${argv[1]} does not exist`);
    return { ownership: "not-owner", reason: `${unit} runs ${argv[1]}, not this checkout's build` };
  }

  const homeFlag = argv.indexOf("--home");
  const argvHome = homeFlag >= 0 ? argv[homeFlag + 1] : undefined;
  const envHome = readUnitEnvironment(opts.show, "RUSA_HOME") ?? undefined;
  if (argvHome && envHome && canonicalPath(argvHome) !== canonicalPath(envHome)) {
    return unknown(`its --home ${argvHome} disagrees with RUSA_HOME ${envHome}`);
  }
  const home = argvHome ?? envHome;
  if (!home || !isDirectory(home))
    return unknown(`cannot read the coordinator home (${home ?? "unset"})`);
  let configuredSocket: string | undefined;
  try {
    configuredSocket = loadConfig(home).quota?.coordinator?.socketPath?.trim();
  } catch (err) {
    return unknown(
      `cannot load its home config: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const socketPath =
    configuredSocket ||
    defaultQuotaCoordinatorSocketPath(
      readUnitEnvironment(opts.show, "XDG_RUNTIME_DIR") ?? opts.fallbackRuntimeDir
    );
  return { ownership: "owner", target: { unit, home, socketPath } };
}

/** Ask the user manager for the unit's effective launch settings; null when it cannot answer. */
function systemctlShow(unit: string): Promise<string | null> {
  const args = ["--user", "show", ...COORDINATOR_SHOW_PROPERTIES.flatMap((p) => ["-p", p]), unit];
  return new Promise((resolve) => {
    execFile("systemctl", args, { encoding: "utf8", timeout: 10_000 }, (error, stdout) =>
      resolve(error ? null : stdout)
    );
  });
}

/**
 * Pre-restart backups live beside the daily ones, in their own retention
 * directory, so frequent deploys cannot evict the daily history.
 */
export function preRestartBackupDir(home: string): string | null {
  const config = loadConfig(home);
  const { databasePath, backupDir } = resolveQuotaBackupPaths({}, config, home);
  return existsSync(databasePath) ? join(backupDir, "pre-deploy") : null;
}

export interface SystemdCoordinatorRestarterOptions {
  /** This checkout's built CLI; it decides ownership, names the artifact, and runs the backup. */
  cliPath: string;
  unit?: string;
  timeoutMs?: number;
  /** The socket this instance dials (`quota.coordinator.socketPath`); read only to report its revision. */
  dialedSocketPath?: string;
  /** Injection seams for tests; production runs systemctl and the built CLI. */
  showUnit?: (unit: string) => Promise<string | null>;
  restartUnit?: (unit: string) => Promise<void>;
  runBackup?: (home: string, backupDir: string) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * Refresh the one fixed pool-owned coordinator when this checkout owns it,
 * then require its ready envelope to prove it loaded the artifact on disk.
 * No client service is touched here; the normal update drain/restart remains
 * responsible for that.
 */
export class SystemdCoordinatorRestarter implements CoordinatorRestartSeam {
  private readonly timeoutMs: number;
  private readonly showUnit: (unit: string) => Promise<string | null>;
  private readonly restartUnit: (unit: string) => Promise<void>;
  private readonly runBackup: (home: string, backupDir: string) => Promise<void>;

  constructor(private readonly options: SystemdCoordinatorRestarterOptions) {
    this.timeoutMs = options.timeoutMs ?? COORDINATOR_RESTART_TIMEOUT_MS;
    const step = (name: string, args: string[]) =>
      runTimedStep(name, args[0], args.slice(1), {
        cwd: process.cwd(),
        timeoutMs: this.timeoutMs,
        log: options.log,
        spawnImpl: spawn,
      });
    this.showUnit = options.showUnit ?? systemctlShow;
    this.restartUnit =
      options.restartUnit ??
      ((unit) => step("coordinator-restart", ["systemctl", "--user", "restart", unit]));
    // The backup runs in its own process, as `rusa quota-backup` always does,
    // so the `VACUUM INTO` never pauses this instance's event loop.
    this.runBackup =
      options.runBackup ??
      ((home, backupDir) =>
        step("coordinator-backup", [
          process.execPath,
          options.cliPath,
          "quota-backup",
          "--home",
          home,
          "--backup-dir",
          backupDir,
        ]));
  }

  async resolve(): Promise<CoordinatorOwnership> {
    const unit = this.options.unit ?? POOL_COORDINATOR_UNIT;
    return resolvePoolCoordinatorOwnership({
      cliPath: this.options.cliPath,
      show: await this.showUnit(unit),
      unit,
      fallbackRuntimeDir: process.env.XDG_RUNTIME_DIR,
    });
  }

  /** The same sentinel read the coordinator performs at startup, on this checkout's live dist. */
  artifactRevision(): string | null {
    return coordinatorLoadedRevision(dirname(this.options.cliPath));
  }

  loadedRevision(target: CoordinatorTarget): Promise<string | null> {
    return readReadyRevision(target.socketPath);
  }

  async dialedRevision(): Promise<string | null> {
    return this.options.dialedSocketPath ? readReadyRevision(this.options.dialedSocketPath) : null;
  }

  async backup(target: CoordinatorTarget): Promise<void> {
    const backupDir = preRestartBackupDir(target.home);
    if (!backupDir) {
      this.options.log?.("[update] no quota database exists yet; nothing to back up");
      return;
    }
    await this.runBackup(target.home, backupDir);
  }

  async restart(target: CoordinatorTarget, expectedRevision: string): Promise<void> {
    await this.restartUnit(target.unit);
    await waitForCoordinatorRevision({
      socketPath: target.socketPath,
      expectedRevision,
      timeoutMs: this.timeoutMs,
    });
  }
}
