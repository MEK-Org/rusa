import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  buildToolchainPath,
  ensureTargetParentDirs,
  getCorepackPath,
  realpathIfExists,
  setupFlutterOverlay,
  teardownFlutterOverlay,
} from "../providers/sandbox.js";

export const E2E_INSTANCE_UNIT_NAME = "rusa-e2e-instance";
const E2E_INSTANCE_PORT = 8083 as const;
const DEFAULT_STARTUP_TIMEOUT_MS = 180_000;
const DEFAULT_STARTUP_POLL_MS = 250;

export interface E2EInstanceRecord {
  actorId: string;
  actorHandle: string;
  worktree: string;
  unitName: string;
  startedAt: string;
}

export interface E2EInstanceLiveStatus {
  loadState: string;
  activeState: string;
  subState: string;
  result: string;
}

export interface E2EInstanceStatus {
  state: "up" | "down";
  port: 8083;
  holder?: E2EInstanceRecord;
  liveStatus?: E2EInstanceLiveStatus;
}

export interface E2EInstanceManagerOptions {
  mcHome: string;
  workersDir: string;
  handleForId: (actorId: string) => string;
  now?: () => string;
  hostHome?: string;
  toolchainPath?: string;
  corepackPath?: string;
  flutterRoot?: string;
  providerExecutables?: Readonly<Record<string, string>>;
  startupTimeoutMs?: number;
  startupPollMs?: number;
  isPortReady?: (port: number) => Promise<boolean>;
  delay?: (ms: number) => Promise<void>;
  exec?: (file: string, args: string[]) => string;
}

const isSelfOrDescendant = (root: string, target: string): boolean =>
  target === root || target.startsWith(`${root}/`);

function ensureMountTarget(source: string, target: string): void {
  if (statSync(source).isDirectory()) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    return;
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (!existsSync(target)) writeFileSync(target, "", { mode: 0o600 });
}

function parseSystemdStatus(output: string): E2EInstanceLiveStatus {
  const values = new Map(
    output
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2) as [string, string])
  );
  return {
    loadState: values.get("LoadState") ?? "unknown",
    activeState: values.get("ActiveState") ?? "unknown",
    subState: values.get("SubState") ?? "unknown",
    result: values.get("Result") ?? "unknown",
  };
}

function resolveHostFlutterRoot(): string | undefined {
  try {
    const executable = execFileSync("which", ["flutter"], { encoding: "utf8" }).trim();
    return dirname(dirname(realpathSync(executable)));
  } catch {
    return undefined;
  }
}

function resolveProviderExecutables(): Readonly<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const command of ["claude", "codex", "agy", "kimi"]) {
    try {
      resolved[command] = realpathSync(
        execFileSync("which", [command], { encoding: "utf8" }).trim()
      );
    } catch {
      // A provider absent from the host remains unavailable in the E2E instance.
    }
  }
  return resolved;
}

function isLoopbackPortReady(port: number): Promise<boolean> {
  return new Promise((resolveReady) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveReady(ready);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/**
 * Host-owned lifecycle for the single live-refresh e2e dashboard. The process is
 * a transient user unit, not a child of an actor run. Its bwrap view hides the
 * whole host home and punches through only the caller's selected worktree, this
 * capability's private runtime directory, the read-only Flutter SDK, and the
 * same narrowly selected provider credentials used by staging actors. Provider
 * state that must refresh is mounted writable; static credentials remain
 * read-only. No unrelated home path is exposed.
 *
 * Teardown has exactly three callers: the MCP down/stop tools, the existing
 * actor-retirement cleanup cascade, and the mesh shutdown paths in start.ts.
 * There is deliberately no run-end hook, capability-revoke hook, timeout, or
 * poller. Restart=always keeps unexpected child exits (including OOM) restarting
 * in place, with a start limit preventing a configuration error from crash-looping.
 */
export class E2EInstanceManager {
  private readonly stateFile: string;
  private readonly runtimeDir: string;
  private readonly now: () => string;
  private readonly hostHome: string;
  private readonly toolchainPath: string;
  private readonly corepackPath: string;
  private readonly flutterRoot?: string;
  private readonly pubCache: string;
  private readonly providerExecutables: Readonly<Record<string, string>>;
  private readonly startupTimeoutMs: number;
  private readonly startupPollMs: number;
  private readonly isPortReady: (port: number) => Promise<boolean>;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly exec: (file: string, args: string[]) => string;

  constructor(private readonly opts: E2EInstanceManagerOptions) {
    this.stateFile = join(opts.mcHome, "e2e-instance.json");
    this.runtimeDir = join(opts.mcHome, "e2e-instance", "runtime");
    this.now = opts.now ?? (() => new Date().toISOString());
    this.hostHome = opts.hostHome ?? homedir();
    this.flutterRoot = opts.flutterRoot ?? resolveHostFlutterRoot();
    const baseToolchainPath = opts.toolchainPath ?? buildToolchainPath();
    this.toolchainPath = this.flutterRoot
      ? [join(this.flutterRoot, "bin"), baseToolchainPath].join(":")
      : baseToolchainPath;
    this.corepackPath = opts.corepackPath ?? getCorepackPath();
    // Flutter writes package-resolution bookkeeping even when every package is
    // already cached. Keep that mutable state capability-private instead of
    // exposing the operator's host cache (or mounting it read-only and failing).
    this.pubCache = join(this.runtimeDir, "pub-cache");
    this.providerExecutables = opts.providerExecutables ?? resolveProviderExecutables();
    this.startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.startupPollMs = opts.startupPollMs ?? DEFAULT_STARTUP_POLL_MS;
    this.isPortReady = opts.isPortReady ?? isLoopbackPortReady;
    this.delay =
      opts.delay ?? ((ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)));
    this.exec =
      opts.exec ?? ((file, args) => execFileSync(file, args, { encoding: "utf8", stdio: "pipe" }));
  }

  private readRecord(): E2EInstanceRecord | undefined {
    try {
      const value = JSON.parse(readFileSync(this.stateFile, "utf8")) as E2EInstanceRecord;
      if (!value.actorId || !value.actorHandle || !value.worktree) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  private writeRecord(record: E2EInstanceRecord): void {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temp = `${this.stateFile}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.stateFile);
  }

  private liveStatus(): E2EInstanceLiveStatus {
    try {
      return parseSystemdStatus(
        this.exec("systemctl", [
          "--user",
          "show",
          E2E_INSTANCE_UNIT_NAME,
          "-p",
          "LoadState",
          "-p",
          "ActiveState",
          "-p",
          "SubState",
          "-p",
          "Result",
        ])
      );
    } catch {
      return { loadState: "not-found", activeState: "inactive", subState: "dead", result: "none" };
    }
  }

  private isLive(status: E2EInstanceLiveStatus): boolean {
    return (
      status.loadState !== "not-found" &&
      status.activeState !== "inactive" &&
      status.activeState !== "failed"
    );
  }

  private validateOwnedWorktree(actorId: string, requestedPath: string): string {
    if (!requestedPath.trim()) throw new Error("e2e-instance: worktree path is required");
    if (!isAbsolute(requestedPath)) {
      throw new Error(`e2e-instance: worktree path must be absolute: ${requestedPath}`);
    }
    const actorRoot = join(this.opts.workersDir, actorId);
    let realActorRoot: string;
    let worktree: string;
    try {
      realActorRoot = realpathSync(actorRoot);
    } catch {
      throw new Error(`e2e-instance: calling actor workdir does not exist: ${actorRoot}`);
    }
    try {
      worktree = realpathSync(resolve(requestedPath));
    } catch {
      throw new Error(`e2e-instance: worktree does not exist: ${requestedPath}`);
    }
    if (!statSync(worktree).isDirectory()) {
      throw new Error(`e2e-instance: worktree is not a directory: ${requestedPath}`);
    }
    if (!isSelfOrDescendant(realActorRoot, worktree)) {
      throw new Error(
        `e2e-instance: REFUSED foreign path ${worktree}; it must belong to calling actor ${actorId}'s own workdir ${realActorRoot}`
      );
    }
    for (const required of ["package.json", join("packages", "rusa", "scripts", "e2e.mjs")]) {
      if (!existsSync(join(worktree, required))) {
        throw new Error(`e2e-instance: ${worktree} is not a rusa worktree (missing ${required})`);
      }
    }
    return worktree;
  }

  private buildBwrapArgs(worktree: string): string[] {
    const runtimeHome = join(this.runtimeDir, "home");
    const providerBin = join(this.runtimeDir, "provider-bin");
    const baseConfigHome = join(this.runtimeDir, "base-config");
    mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.runtimeDir, "tmp"), { recursive: true, mode: 0o700 });
    mkdirSync(this.pubCache, { recursive: true, mode: 0o700 });
    mkdirSync(providerBin, { recursive: true, mode: 0o700 });
    mkdirSync(baseConfigHome, { recursive: true, mode: 0o700 });
    const realHostHome = realpathIfExists(this.hostHome);
    const realMcHome = realpathIfExists(this.opts.mcHome);
    const realRuntime = realpathIfExists(this.runtimeDir);
    const toolchainBin = dirname(realpathIfExists(process.execPath));
    const toolchainLib = join(dirname(toolchainBin), "lib");
    const args = [
      "--unshare-all",
      "--share-net",
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      // The installed Node distribution also carries corepack/pnpm. Mount it
      // outside the soon-to-be-hidden host home, matching the actor sandbox's
      // established toolchain projection.
      "--ro-bind",
      toolchainBin,
      "/usr/local/bin",
    ];
    if (existsSync(toolchainLib)) {
      args.push("--ro-bind", toolchainLib, "/usr/local/lib");
    }
    if (existsSync("/dev/fuse")) {
      args.push("--bind", "/dev/fuse", "/dev/fuse");
    }
    args.push("--tmpfs", this.hostHome);
    // The cleared environment removes DBUS_SESSION_BUS_ADDRESS, and masking the
    // per-user runtime tree also removes the discoverable user-manager socket.
    // Code under active development must not be able to control host units.
    if (existsSync("/run/user")) args.push("--tmpfs", "/run/user");
    if (
      !isSelfOrDescendant(realHostHome, realMcHome) &&
      !isSelfOrDescendant(realMcHome, realHostHome)
    ) {
      args.push("--tmpfs", this.opts.mcHome);
    }
    args.push("--tmpfs", "/tmp");
    let wrapperDir: string | undefined;
    if (this.flutterRoot) {
      const result = setupFlutterOverlay(args, this.flutterRoot, realRuntime);
      wrapperDir = result.wrapperDir;
    }
    for (const path of [realRuntime, worktree]) {
      ensureTargetParentDirs(args, path);
      args.push("--bind", path, path);
    }

    // Make the service's provider configuration available to the disposable
    // instance without exposing the rest of RUSA_HOME.
    const configSource = join(this.opts.mcHome, "config.yaml");
    const configTarget = join(baseConfigHome, "config.yaml");
    const hasBaseConfig = existsSync(configSource);
    if (hasBaseConfig) {
      ensureMountTarget(configSource, configTarget);
      args.push("--ro-bind", realpathIfExists(configSource), configTarget);
      const geminiKeySource = join(this.opts.mcHome, "secrets", "gemini-api-key");
      if (existsSync(geminiKeySource)) {
        const geminiKeyTarget = join(baseConfigHome, "secrets", "gemini-api-key");
        ensureMountTarget(geminiKeySource, geminiKeyTarget);
        args.push("--ro-bind", realpathIfExists(geminiKeySource), geminiKeyTarget);
      }
      const mistralKeySource = join(this.opts.mcHome, "secrets", "mistral-api-key");
      if (existsSync(mistralKeySource)) {
        const mistralKeyTarget = join(baseConfigHome, "secrets", "mistral-api-key");
        ensureMountTarget(mistralKeySource, mistralKeyTarget);
        args.push("--ro-bind", realpathIfExists(mistralKeySource), mistralKeyTarget);
      }
    }

    // Mirror staging's provider access at the synthetic HOME expected by the
    // nested actor sandboxes. Claude/Antigravity/Copilot need writable token
    // refresh state; Codex and Kimi copy their credentials before use.
    for (const [relativePath, writable] of [
      [".claude", true],
      [".claude.json", true],
      [".gemini", true],
      [".codex", false],
      [".kimi-code", false],
      [".copilot", true],
      [join(".config", "github-copilot"), true],
      [join(".config", "copilot"), true],
    ] as const) {
      const source = join(this.hostHome, relativePath);
      if (!existsSync(source)) continue;
      const target = join(runtimeHome, relativePath);
      ensureMountTarget(source, target);
      args.push(writable ? "--bind" : "--ro-bind", realpathIfExists(source), target);
    }
    for (const [command, source] of Object.entries(this.providerExecutables)) {
      if (!existsSync(source)) continue;
      const target = join(providerBin, command);
      ensureMountTarget(source, target);
      args.push("--ro-bind", realpathIfExists(source), target);
    }
    args.push(
      "--clearenv",
      "--setenv",
      "HOME",
      runtimeHome,
      "--setenv",
      "RUSA_HOME",
      join(realRuntime, "home", ".rusa"),
      "--setenv",
      "XDG_CONFIG_HOME",
      join(realRuntime, "home", ".config"),
      "--setenv",
      "XDG_CACHE_HOME",
      join(realRuntime, "home", ".cache"),
      "--setenv",
      "TMPDIR",
      join(realRuntime, "tmp")
    );
    args.push("--setenv", "PUB_CACHE", this.pubCache);
    const baseToolchainPath = this.opts.toolchainPath ?? buildToolchainPath();
    const sandboxPath = wrapperDir
      ? [providerBin, wrapperDir, baseToolchainPath].join(":")
      : [providerBin, this.toolchainPath].join(":");
    args.push(
      "--setenv",
      "PATH",
      sandboxPath,
      "--chdir",
      worktree,
      "--",
      "pnpm",
      "run",
      "e2e",
      "am-up",
      "--root-driver",
      "external",
      ...(hasBaseConfig ? ["--base-config-home", baseConfigHome] : []),
      "--watch"
    );
    return args;
  }

  private prepareWorktree(worktree: string): void {
    const manifest = JSON.parse(readFileSync(join(worktree, "package.json"), "utf8")) as {
      packageManager?: unknown;
    };
    if (
      typeof manifest.packageManager !== "string" ||
      !manifest.packageManager.startsWith("pnpm@")
    ) {
      throw new Error(
        `e2e-instance: ${worktree} package.json must declare a pinned pnpm packageManager`
      );
    }
    try {
      this.exec("git", ["-C", worktree, "submodule", "update", "--init", "--recursive"]);
    } catch (err) {
      throw new Error(
        `e2e-instance: submodule setup failed for ${worktree}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    const flutterToolState = join(worktree, "packages", "rusa", "flutter_dashboard", ".dart_tool");
    // package_config.json contains absolute PUB_CACHE paths. A previous E2E run
    // points into its now-deleted private runtime cache, while the host prebuild
    // points at the host cache. Force each side to resolve for its own cache.
    rmSync(flutterToolState, { recursive: true, force: true });
    for (const [description, args] of [
      ["pnpm install", ["--dir", worktree, "install"]],
      [
        "dashboard build",
        ["--dir", worktree, "--filter", "./packages/rusa", "run", "build:dashboard-ui"],
      ],
    ] as const) {
      try {
        this.exec(this.corepackPath, [manifest.packageManager, ...args]);
      } catch (err) {
        throw new Error(
          `e2e-instance: ${description} failed for ${worktree}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }
    rmSync(flutterToolState, { recursive: true, force: true });
  }

  async up(actorId: string, requestedPath: string): Promise<E2EInstanceStatus> {
    const existing = this.readRecord();
    const existingStatus = this.liveStatus();
    // A valid holder record is ownership on its own: the transient unit behind
    // it can be inactive, failed, or gone (host restart, `systemctl stop`, an
    // OOM kill) without releasing that ownership. Reject before touching the
    // worktree or runtime so a stopped-but-still-held instance can only be
    // reclaimed by that actor's own down/stop (or, separately, resumed).
    if (existing) {
      throw new Error(
        `e2e-instance: already held by ${existing.actorHandle} (${existing.actorId}) serving ${existing.worktree}; ` +
          "it comes down only when that actor calls down/stop, that actor is retired, or the mesh shuts down"
      );
    }
    if (this.isLive(existingStatus)) {
      throw new Error(
        `e2e-instance: ${E2E_INSTANCE_UNIT_NAME} is already active but its holder record is missing; ` +
          "an operator must stop the orphaned unit before retrying"
      );
    }
    // No valid holder record and no live unit: any surviving runtime directory
    // is an orphan (its owning record is gone), not preserved state. Clear it
    // before rebuilding mount targets so a stale file-vs-directory shape left
    // by a prior run (e.g. runtime/home/.claude.json) can't reach bwrap.
    this.clearOrphanRuntime();

    const worktree = this.validateOwnedWorktree(actorId, requestedPath);
    this.prepareWorktree(worktree);
    const record: E2EInstanceRecord = {
      actorId,
      actorHandle: this.opts.handleForId(actorId),
      worktree,
      unitName: E2E_INSTANCE_UNIT_NAME,
      startedAt: this.now(),
    };
    this.writeRecord(record);
    try {
      this.exec("systemd-run", [
        "--user",
        `--unit=${E2E_INSTANCE_UNIT_NAME}`,
        "--collect",
        "--property=Description=Rusa live e2e instance",
        "--property=Restart=always",
        "--property=RestartSec=10s",
        "--property=StartLimitIntervalSec=60s",
        "--property=StartLimitBurst=3",
        "--property=KillMode=control-group",
        "--property=TimeoutStopSec=30s",
        "--",
        "bwrap",
        ...this.buildBwrapArgs(worktree),
      ]);
    } catch (err) {
      rmSync(this.stateFile, { force: true });
      throw err;
    }
    const deadline = Date.now() + this.startupTimeoutMs;
    let liveStatus = this.liveStatus();
    while (Date.now() < deadline) {
      if (!this.isLive(liveStatus)) {
        this.cleanupFailedStart();
        throw new Error(
          `e2e-instance: ${E2E_INSTANCE_UNIT_NAME} failed before port ${E2E_INSTANCE_PORT} became ready ` +
            `(active=${liveStatus.activeState}, sub=${liveStatus.subState}, result=${liveStatus.result})`
        );
      }
      if (await this.isPortReady(E2E_INSTANCE_PORT)) {
        return { state: "up", port: E2E_INSTANCE_PORT, holder: record, liveStatus };
      }
      await this.delay(this.startupPollMs);
      liveStatus = this.liveStatus();
    }
    this.cleanupFailedStart();
    throw new Error(
      `e2e-instance: ${E2E_INSTANCE_UNIT_NAME} did not open port ${E2E_INSTANCE_PORT} ` +
        `within ${this.startupTimeoutMs}ms (active=${liveStatus.activeState}, sub=${liveStatus.subState})`
    );
  }

  status(): E2EInstanceStatus {
    const holder = this.readRecord();
    const liveStatus = this.liveStatus();
    return this.isLive(liveStatus)
      ? { state: "up", port: E2E_INSTANCE_PORT, ...(holder ? { holder } : {}), liveStatus }
      : { state: "down", port: E2E_INSTANCE_PORT, ...(holder ? { holder } : {}), liveStatus };
  }

  down(actorId: string): E2EInstanceStatus {
    const holder = this.readRecord();
    if (!holder) return this.status();
    if (holder.actorId !== actorId) {
      throw new Error(
        `e2e-instance: held by ${holder.actorHandle} (${holder.actorId}); only the holder may call down/stop`
      );
    }
    this.stopUnit();
    return this.status();
  }

  stopForActorRetirement(actorId: string): void {
    if (this.readRecord()?.actorId === actorId) this.stopUnit();
  }

  stopForMeshShutdown(): void {
    if (this.readRecord() || this.isLive(this.liveStatus())) this.stopUnit();
  }

  /**
   * Removes a runtime directory left behind with no owning holder record and
   * no live unit — orphaned state, distinct from a preserved holder's runtime
   * (which `up()` never reaches while a record exists) or a live singleton's
   * runtime (torn down only via stopUnit/cleanupFailedStart).
   */
  private clearOrphanRuntime(): void {
    teardownFlutterOverlay(this.runtimeDir);
    rmSync(this.runtimeDir, { recursive: true, force: true });
  }

  private stopUnit(): void {
    // Keep the holder record if systemctl fails: losing attribution while an
    // active unit survives would permit a silent singleton takeover.
    if (this.liveStatus().loadState !== "not-found") {
      this.exec("systemctl", ["--user", "stop", E2E_INSTANCE_UNIT_NAME]);
    }
    teardownFlutterOverlay(this.runtimeDir);
    rmSync(this.stateFile, { force: true });
    rmSync(this.runtimeDir, { recursive: true, force: true });
  }

  private cleanupFailedStart(): void {
    try {
      if (this.liveStatus().loadState !== "not-found") {
        this.exec("systemctl", ["--user", "stop", E2E_INSTANCE_UNIT_NAME]);
      }
    } catch {
      // Best effort: preserve the original startup error for the caller.
    }
    teardownFlutterOverlay(this.runtimeDir);
    rmSync(this.stateFile, { force: true });
    rmSync(this.runtimeDir, { recursive: true, force: true });
  }
}
