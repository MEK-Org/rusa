import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import { join, resolve } from "node:path";
import { POOL_COORDINATOR_UNIT } from "../commands/coordinator-provisioning.js";
import { resolveQuotaBackupPaths } from "../commands/quota-backup.js";
import { defaultQuotaCoordinatorSocketPath } from "../commands/quota-coordinator.js";
import { readUnitEnvironment } from "../commands/service-instance.js";
import { loadConfig } from "../config/index.js";
import type { CoordinatorRestartSeam, CoordinatorTarget } from "./orchestrator.js";
import { runTimedStep } from "./runner.js";

export const COORDINATOR_RESTART_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 200;

type ReadyEnvelope = { service?: { loadedRevision?: unknown } };

function readReadyRevision(socketPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const request = http.request({ socketPath, path: "/v1/readyz", method: "GET" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(body) as ReadyEnvelope;
          const revision = parsed.service?.loadedRevision;
          resolve(typeof revision === "string" ? revision : null);
        } catch {
          resolve(null);
        }
      });
    });
    request.on("error", () => resolve(null));
    request.setTimeout(2_000, () => request.destroy());
    request.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until readyz identifies the exact revision that this update built. */
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
  while (Date.now() <= deadline) {
    observed = await readReadyRevision(opts.socketPath);
    if (observed === opts.expectedRevision) return;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `quota coordinator did not report loaded revision ${opts.expectedRevision.slice(0, 7)} ` +
      `within ${timeoutMs}ms${observed ? ` (last reported ${observed.slice(0, 7)})` : ""}`
  );
}

/** Split an `ExecStart=` value written by the installer's quoting into argv. */
function parseExecStart(value: string): string[] {
  const args: string[] = [];
  for (const match of value.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    args.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]);
  }
  return args;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Establish whether this checkout's build is what the installed pool unit
 * runs, and where that coordinator listens. The unit file is the durable
 * record the installer wrote: its `ExecStart` names the CLI it executes and
 * its `--home` names the coordinator's own config, whose socket setting (or
 * the unit's runtime directory) is the socket readiness must be read from.
 */
export function resolveOwnedPoolCoordinator(opts: {
  systemdUserDir: string;
  /** This checkout's built CLI, e.g. `<checkout>/packages/rusa/dist/cli.js`. */
  cliPath: string;
  unit?: string;
}): CoordinatorTarget | { skip: string } {
  const unit = opts.unit ?? POOL_COORDINATOR_UNIT;
  const unitPath = join(opts.systemdUserDir, unit);
  if (!existsSync(unitPath)) {
    return { skip: `no ${unit} is installed on this host (client-only deployment)` };
  }
  const contents = readFileSync(unitPath, "utf-8");
  const execLine = contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("ExecStart="))
    .at(-1);
  const argv = execLine ? parseExecStart(execLine.slice("ExecStart=".length)) : [];
  const unitCli = argv[1];
  if (!unitCli) throw new Error(`cannot read the executable ${unit} runs from its ExecStart`);
  if (canonicalPath(unitCli) !== canonicalPath(opts.cliPath)) {
    return { skip: `${unit} runs another checkout's build, not this deployment's` };
  }
  const homeFlag = argv.indexOf("--home");
  const home =
    (homeFlag >= 0 ? argv[homeFlag + 1] : undefined) ?? readUnitEnvironment(contents, "RUSA_HOME");
  if (!home) throw new Error(`cannot read the coordinator home from ${unit}`);
  const socketPath =
    loadConfig(home).quota?.coordinator?.socketPath?.trim() ||
    defaultQuotaCoordinatorSocketPath(
      readUnitEnvironment(contents, "XDG_RUNTIME_DIR") ?? process.env.XDG_RUNTIME_DIR
    );
  return { unit, home, socketPath };
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
  systemdUserDir: string;
  /** This checkout's built CLI; it both decides ownership and runs the backup. */
  cliPath: string;
  unit?: string;
  timeoutMs?: number;
  /** Injection seams for tests; production runs systemctl and the built CLI. */
  restartUnit?: (unit: string) => Promise<void>;
  runBackup?: (home: string, backupDir: string) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * Refresh the one fixed pool-owned coordinator when this checkout owns it,
 * then require its ready envelope to prove it loaded the just-built revision.
 * No client service is touched here; the normal update drain/restart remains
 * responsible for that.
 */
export class SystemdCoordinatorRestarter implements CoordinatorRestartSeam {
  private readonly timeoutMs: number;
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

  async resolve(): Promise<CoordinatorTarget | { skip: string }> {
    return resolveOwnedPoolCoordinator({
      systemdUserDir: this.options.systemdUserDir,
      cliPath: this.options.cliPath,
      unit: this.options.unit,
    });
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
