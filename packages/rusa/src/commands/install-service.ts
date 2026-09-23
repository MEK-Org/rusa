import { execFileSync } from "node:child_process";
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { preflightAt } from "../actor/at-queue.js";
import { preflightCron } from "../actor/crontab.js";
import { ensureWakeToken } from "../actor/wake-callback.js";
import { loadConfig, resolveHome } from "../config/index.js";
import type { RusaConfig } from "../config/types.js";
import {
  addWorktree,
  generateRepoKey,
  getRemoteUrl,
  initializeWorkspace,
} from "../gitops/worktree.js";
import { resolveErrorSink } from "../observability/error-sink.js";
import { writeBuildSentinel } from "../update/build-sentinel.js";
import {
  COORDINATOR_HOME_ENV,
  type CoordinatorServiceContext,
  POOL_COORDINATOR_UNIT,
  planCoordinatorTransition,
  poolClientUnitNames,
  readInstalledCoordinatorUnits,
  resolveCoordinatorServiceContext,
  resolvePoolProbePath,
} from "./coordinator-provisioning.js";
import {
  defaultQuotaBackupDir,
  defaultQuotaCoordinatorSocketPath,
  resolveCoordinatorDatabasePaths,
} from "./quota-coordinator.js";
import {
  type DeploymentMode,
  type ExecutableSource,
  type ProbePathEnv,
  readUnitEnvironment,
  resolveExecutableOnPath,
  resolveExecutableSource,
  resolvePathEnvForUnit,
  resolvePathForUnit,
  resolveRepoRoot,
  resolveServiceDashboardUrl,
  resolveServiceInstance,
  type ServiceEnvironment,
} from "./service-instance.js";

function quoteExecArg(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function runOrThrow(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function runInDirOrThrow(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Run a command whose failure is an expected outcome rather than an error.
 *
 * `systemctl stop`/`disable` on a unit that is already stopped or was never
 * enabled exits non-zero, and the transition off the environment-derived
 * coordinator units has to be idempotent: the second run finds nothing to stop
 * and must still succeed.
 */
function runQuietly(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function hasCommand(command: string): boolean {
  try {
    runOrThrow("sh", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

function isDebianPackageInstalled(packageName: string): boolean {
  if (!hasCommand("dpkg-query")) return false;
  try {
    const status = runOrThrow("dpkg-query", ["-W", "-f=$" + "{Status}", packageName]);
    return status.includes("install ok installed");
  } catch {
    return false;
  }
}

function ensureDbusUserSessionPackage(): void {
  if (!hasCommand("dpkg-query")) return;
  if (isDebianPackageInstalled("dbus-user-session")) return;

  throw new Error(
    "Required package 'dbus-user-session' is not installed. install-service requires a user D-Bus session.\n" +
      "Install it first:\n" +
      "  sudo apt update && sudo apt install dbus-user-session"
  );
}

function ensureUserSystemdBusAvailable(): void {
  try {
    runOrThrow("systemctl", ["--user", "show-environment"]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const packageHint = hasCommand("dpkg-query")
      ? "\nIf you're on Debian/Ubuntu, install:\n  sudo apt update && sudo apt install dbus-user-session"
      : "";
    throw new Error(
      "Could not connect to the user systemd D-Bus session. install-service requires an active user bus." +
        packageHint +
        `\nOriginal error: ${msg}`
    );
  }
}

// ISSUE_NUM: the orchestrator now self-updates by drain + clean exit(0) (the `update`
// tool), so the unit must restart on a CLEAN exit too — hence Restart=always.
// StartLimit gives up on a fast crash-loop; OnFailure fires the standalone alert;
// ExecStartPre (self-deploy only) refuses to boot a partial/mismatched dist.
export function buildServiceUnit(opts: {
  description: string;
  mcHome: string;
  cliPath: string;
  nodePath: string;
  userPath: string;
  deployOnMergeBranch?: string;
  /** Restart policy. The orchestrator uses "always" (clean exit(0) → restart). */
  restart?: "always" | "on-failure";
  /** Give-up window for a FAST crash-loop (systemd StartLimit, in [Unit]). */
  startLimit?: { intervalSec: number; burst: number };
  /** OnFailure unit (the alert oneshot). */
  onFailureUnit?: string;
  /**
   * The quota coordinator unit this instance reads from, when one is installed.
   * Declared `After=`/`Wants=` and deliberately never `Requires=`: under v1 an
   * instance without the coordinator is degraded — it paces on its last applied
   * interval — not stopped, and `Requires=` would convert a coordinator failure
   * into an orchestrator outage.
   */
  coordinatorUnit?: string;
  /** Boot gate command (verify-build); only set for self-deploy. */
  execStartPre?: string;
  /**
   * Send stdout/stderr to the systemd journal (self-rotating, queryable with
   * `journalctl`/`rusa logs`) instead of appending to a never-rotated file that
   * can balloon. Default false (append-to-file) to preserve existing install behavior.
   */
  logToJournal?: boolean;
}): string {
  const logFile = join(opts.mcHome, "logs", "rusa.log");
  const startArgs = ["start"];
  if (opts.deployOnMergeBranch) {
    startArgs.push("--deploy-on-merge-branch", opts.deployOnMergeBranch);
  }
  const quotedStartArgs = startArgs.map(quoteExecArg).join(" ");

  const unit: string[] = [
    "[Unit]",
    `Description=${opts.description}`,
    "After=network-online.target",
    "Wants=network-online.target",
  ];
  if (opts.coordinatorUnit) {
    unit.push(`After=${opts.coordinatorUnit}`);
    unit.push(`Wants=${opts.coordinatorUnit}`);
  }
  if (opts.startLimit) {
    unit.push(`StartLimitIntervalSec=${opts.startLimit.intervalSec}`);
    unit.push(`StartLimitBurst=${opts.startLimit.burst}`);
  }
  if (opts.onFailureUnit) {
    unit.push(`OnFailure=${opts.onFailureUnit}`);
  }
  unit.push("", "[Service]", "Type=simple");
  if (opts.execStartPre) {
    unit.push(`ExecStartPre=${opts.execStartPre}`);
  }
  unit.push(
    `ExecStart=${quoteExecArg(opts.nodePath)} ${quoteExecArg(opts.cliPath)} ${quotedStartArgs}`,
    `WorkingDirectory=${opts.mcHome}`,
    `Environment=RUSA_HOME=${opts.mcHome}`,
    `Environment=PATH=${opts.userPath}`,
    `EnvironmentFile=-${join(opts.mcHome, ".env")}`,
    `Restart=${opts.restart ?? "on-failure"}`,
    "RestartSec=10",
    `StandardOutput=${opts.logToJournal ? "journal" : `append:${logFile}`}`,
    `StandardError=${opts.logToJournal ? "journal" : `append:${logFile}`}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  );
  return unit.join("\n");
}

/**
 * The `OnFailure=` alert oneshot (ISSUE_NUM, elder fixes #5/#6): when the orchestrator
 * enters a failed state (e.g. a crash-loop that trips StartLimit), systemd runs
 * this, which invokes the STANDALONE, build-independent notifier — journal ERROR +
 * marker file always, Google Chat best-effort.
 */
export function buildAlertUnit(opts: {
  description: string;
  nodePath: string;
  notifyScript: string;
  mcHome: string;
  errorSink?: string;
  gchatConfigDir?: string;
  slackBotTokenPath?: string;
  message: string;
}): string {
  const unit: string[] = [
    "[Unit]",
    `Description=${opts.description}`,
    "",
    "[Service]",
    "Type=oneshot",
    `Environment=RUSA_HOME=${opts.mcHome}`,
  ];
  if (opts.errorSink) unit.push(`Environment=RUSA_ERROR_SINK=${opts.errorSink}`);
  if (opts.gchatConfigDir) unit.push(`Environment=GCHAT_CONFIG_DIR=${opts.gchatConfigDir}`);
  if (opts.slackBotTokenPath)
    unit.push(`Environment=RUSA_SLACK_BOT_TOKEN_PATH=${opts.slackBotTokenPath}`);
  unit.push(
    `ExecStart=${quoteExecArg(opts.nodePath)} ${quoteExecArg(opts.notifyScript)} ${quoteExecArg(opts.message)}`,
    ""
  );
  return unit.join("\n");
}

/**
 * The quota coordinator unit.
 *
 * This is deliberately not a stripped-down copy of the orchestrator unit. The
 * coordinator *scrapes*, so it needs the environment a probe actually runs in,
 * and every omission here produces the same failure: a service that starts,
 * answers `healthz`, and never successfully scrapes — the silent failure the
 * design's second rollback drill exists to catch. Concretely it needs
 *
 * - the provider CLIs on `PATH` with their authentication state readable,
 *   which is why `PATH` is the same resolved user `PATH` the instance units get
 *   rather than systemd's default `/usr/bin:/bin`;
 * - `bwrap`, because the probe sandboxes itself, and `tmux`, because one
 *   provider's usage panel is only reachable through a PTY — both are on that
 *   same `PATH` and are preflighted at install time;
 * - `XDG_RUNTIME_DIR`, for both the tmux socket and the service's own listener.
 *   The user manager normally exports it, but it is set explicitly because a
 *   coordinator that silently falls back to `/tmp` for its socket is one whose
 *   clients then cannot find it;
 * - a writable workers directory to create `quota-probe-<provider>` under,
 *   which is `$RUSA_HOME/workers` and is created by the installer.
 *
 * The unit runs at the default log level. The metric series ride the
 * structured logger at `info` under their own event name (`quota_metric`), so
 * the journal carries lifecycle records and metrics side by side and a reader
 * selects either by `msg` — no unit-wide level override is needed.
 */
export function buildQuotaCoordinatorUnit(opts: {
  description: string;
  mcHome: string;
  cliPath: string;
  nodePath: string;
  userPath: string;
  xdgRuntimeDir: string;
  onFailureUnit?: string;
  startLimit?: { intervalSec: number; burst: number };
}): string {
  const execArgs = ["quota-coordinator", "--home", opts.mcHome].map(quoteExecArg).join(" ");

  const unit: string[] = [
    "[Unit]",
    `Description=${opts.description}`,
    "After=network-online.target",
    "Wants=network-online.target",
  ];
  if (opts.startLimit) {
    unit.push(`StartLimitIntervalSec=${opts.startLimit.intervalSec}`);
    unit.push(`StartLimitBurst=${opts.startLimit.burst}`);
  }
  if (opts.onFailureUnit) {
    unit.push(`OnFailure=${opts.onFailureUnit}`);
  }
  unit.push(
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${quoteExecArg(opts.nodePath)} ${quoteExecArg(opts.cliPath)} ${execArgs}`,
    `WorkingDirectory=${opts.mcHome}`,
    `Environment=RUSA_HOME=${opts.mcHome}`,
    `Environment=PATH=${opts.userPath}`,
    `Environment=XDG_RUNTIME_DIR=${opts.xdgRuntimeDir}`,
    // JSON so the metric records are selectable by field from the journal.
    "Environment=RUSA_LOG_FORMAT=json",
    `EnvironmentFile=-${join(opts.mcHome, ".env")}`,
    // on-failure, not always: unlike the orchestrator, a clean exit here is a
    // requested stop (SIGTERM from `systemctl stop`), never a self-update.
    "Restart=on-failure",
    "RestartSec=10",
    // The journal is self-rotating and is what `journalctl --user -u <unit>`
    // reads; the metric stream would otherwise grow an unrotated file forever.
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  );
  return unit.join("\n");
}

/**
 * Add `After=`/`Wants=` on the coordinator unit to an existing instance unit.
 *
 * `install-service` writes the ordering only when the coordinator unit is
 * already on disk, but the runbook installs the coordinator *after* the
 * instances — so the unit that was there first has to acquire the ordering
 * from the coordinator's installer, or the operator is left with an
 * undocumented second `install-service` pass. The insertion is idempotent: a
 * unit that already declares both lines comes back unchanged, and a repeated
 * install adds nothing. Any other line in the unit is left exactly as it was,
 * because this edits a unit the instance installer owns.
 */
export function withCoordinatorOrdering(unitContents: string, coordinatorUnit: string): string {
  const lines = unitContents.split("\n");
  const missing = orderingDirectivesMissing(lines, coordinatorUnit);
  if (missing.length === 0) return unitContents;

  // Insert at the end of the [Unit] section: after its last directive, before
  // the blank line (or the next section header) that closes it.
  const unitHeader = lines.findIndex((line) => line.trim() === "[Unit]");
  if (unitHeader < 0) {
    throw new Error("Cannot add coordinator ordering: the unit has no [Unit] section");
  }
  let insertAt = unitHeader + 1;
  while (
    insertAt < lines.length &&
    lines[insertAt].trim() !== "" &&
    !lines[insertAt].trim().startsWith("[")
  ) {
    insertAt += 1;
  }
  lines.splice(insertAt, 0, ...missing.map((directive) => `${directive}=${coordinatorUnit}`));
  return lines.join("\n");
}

function orderingDirectivesMissing(
  lines: readonly string[],
  coordinatorUnit: string
): ("After" | "Wants")[] {
  const has = (directive: string) =>
    lines.some((line) => line.trim() === `${directive}=${coordinatorUnit}`);
  return (["After", "Wants"] as const).filter((directive) => !has(directive));
}

/**
 * The pool coordinator an instance unit should order after, or undefined when
 * none is installed.
 *
 * One unit for every client of the pool, whatever environment the client is:
 * the ordering is a statement about the shared service, not about a companion
 * this instance owns. Only once that unit is actually on disk, because an
 * ordering dependency on a unit systemd does not know about is a warning on
 * every start of an instance that has no coordinator to wait for.
 */
export function coordinatorUnitForClient(systemdUserDir: string): string | undefined {
  return existsSync(join(systemdUserDir, POOL_COORDINATOR_UNIT))
    ? POOL_COORDINATOR_UNIT
    : undefined;
}

/**
 * Whether an instance unit already declares both ordering directives on the
 * coordinator. The read half of {@link withCoordinatorOrdering}, used where the
 * answer is reported to an operator rather than acted on.
 */
export function unitOrdersAfter(unitContents: string, coordinatorUnit: string): boolean {
  return orderingDirectivesMissing(unitContents.split("\n"), coordinatorUnit).length === 0;
}

function installUnit(systemdUserDir: string, serviceUnit: string, contents: string): void {
  const unitPath = join(systemdUserDir, serviceUnit);
  writeFileSync(unitPath, contents, "utf-8");
  console.log(`✓ Wrote ${unitPath}`);
}

function enableAndRestartUnit(serviceUnit: string): void {
  runOrThrow("systemctl", ["--user", "enable", "--now", serviceUnit]);
  runOrThrow("systemctl", ["--user", "restart", serviceUnit]);
  console.log(`✓ Enabled and started ${serviceUnit}`);
}

function getMagicDnsSuffix(): string | undefined {
  try {
    const rawStatus = execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    const parsed = JSON.parse(rawStatus) as { MagicDNSSuffix?: unknown };
    return typeof parsed.MagicDNSSuffix === "string" ? parsed.MagicDNSSuffix : undefined;
  } catch {
    return undefined;
  }
}

function configureTailscaleDashboard(config: RusaConfig): void {
  const tailscaleServiceName = config.dashboard?.tailscaleServiceName?.trim();
  const tailscaleHostname = config.dashboard?.tailscaleHostname;
  const dashboardPort = config.dashboard?.port ?? 8080;
  let tailscaleMagicDnsSuffix: string | undefined;

  if (!tailscaleHostname && !tailscaleServiceName) return;

  if (!hasCommand("tailscale")) {
    console.log(
      "⚠️  tailscale CLI not found — skipping tailscale serve setup.\n" +
        `   Run manually: tailscale serve --https=443 http://127.0.0.1:${dashboardPort}`
    );
    return;
  }

  try {
    const tailscaleArgs = tailscaleServiceName
      ? [
          "serve",
          "--bg",
          "--yes",
          `--service=svc:${tailscaleServiceName}`,
          "--https=443",
          `127.0.0.1:${dashboardPort}`,
        ]
      : ["serve", "--bg", "--yes", String(dashboardPort)];
    execFileSync("tailscale", tailscaleArgs, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
    tailscaleMagicDnsSuffix = getMagicDnsSuffix();
    const dashboardUrl = resolveServiceDashboardUrl(
      tailscaleHostname,
      tailscaleServiceName,
      tailscaleMagicDnsSuffix
    );
    if (dashboardUrl) {
      console.log(`✓ tailscale serve configured: ${dashboardUrl}`);
    } else if (tailscaleServiceName) {
      console.log(`✓ tailscale serve configured for service ${tailscaleServiceName}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `⚠️  tailscale serve failed: ${msg}\n` +
        `   Run manually: tailscale serve --bg --yes --https=443 http://127.0.0.1:${dashboardPort}`
    );
  }
}

function printDashboardSummary(mcHome: string, config: RusaConfig): void {
  const dashboardUrl = resolveServiceDashboardUrl(
    config.dashboard?.tailscaleHostname,
    config.dashboard?.tailscaleServiceName?.trim(),
    getMagicDnsSuffix()
  );
  if (dashboardUrl) {
    console.log(`- Dashboard: ${dashboardUrl}`);
  } else if (config.dashboard?.tailscaleServiceName) {
    console.log(`- Dashboard Service: ${config.dashboard.tailscaleServiceName}`);
  } else {
    console.log(`- Dashboard: http://localhost:${config.dashboard?.port ?? 8080}/`);
  }
  console.log(`- Logs: tail -f ${join(mcHome, "logs", "rusa.log")}`);
}

function installSingleRusaService(opts: {
  environment: ServiceEnvironment;
  executableSource?: ExecutableSource;
  deploymentMode?: DeploymentMode;
  repoPath?: string;
  systemdUserDir: string;
  deployOnMergeBranch?: string;
  /** Log to the systemd journal instead of an append-to-file sink. */
  logToJournal?: boolean;
  /**
   * Restart the unit after installing it. Default true (fresh installs). Set false to
   * re-apply policy to an already-running instance WITHOUT bouncing it — the unit is
   * rewritten + reloaded, and the new policy takes effect on the next restart/self-update.
   */
  restart?: boolean;
}): { mcHome: string; config: RusaConfig } {
  const homeOverride =
    opts.environment === "production" ? resolveHome() : (process.env.RUSA_HOME ?? undefined);
  const instance = resolveServiceInstance(opts.environment, homeOverride);
  const configPath = join(instance.mcHome, "config.yaml");
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}. Run 'rusa init' first.`);
  }

  mkdirSync(join(instance.mcHome, "logs"), { recursive: true });

  const deploymentMode = opts.deploymentMode ?? "package";
  const executableSource =
    opts.executableSource ?? resolveExecutableSource(deploymentMode, opts.repoPath);
  const cliPath = resolvePathForUnit(executableSource.cliPath);
  const nodePath = resolvePathForUnit(executableSource.nodePath);
  const userPath = resolvePathEnvForUnit();
  const config = loadConfig(instance.mcHome);

  // ── ISSUE_NUM phase 1c: cron-backed nightly wake ──
  // Mint the bearer token (chmod-600) the wake endpoint requires and the cron job
  // sends; idempotent, so re-install keeps the existing token. Preflight that cron
  // can actually run so a later schedule_wake doesn't silently no-op.
  ensureWakeToken(instance.mcHome);
  const cron = preflightCron();
  if (!cron.ok) {
    console.warn(
      `⚠️  cron preflight: ${cron.issues.join("; ")} — nightly wakes won't fire until fixed`
    );
  } else {
    console.log("✓ cron preflight passed (crontab + daemon present)");
  }

  const atInfo = preflightAt();
  if (!atInfo.ok) {
    console.warn(
      `⚠️  at preflight: ${atInfo.issues.join("; ")} — interval obligations won't wake until fixed`
    );
  } else {
    console.log("✓ at preflight passed (at + daemon present)");
  }

  // ── ISSUE_NUM: self-update safety wiring ──
  // The `update` tool restarts the daemon by drain + exit(0), so the unit restarts
  // on a clean exit (Restart=always) with a StartLimit give-up + an OnFailure alert.
  // In SELF-deploy mode (the only mode that can rebuild in place) we additionally
  // gate boot on the build-complete sentinel and stamp it for the current HEAD so
  // the first boot passes.
  const alertUnitName = `${instance.serviceBasename}-alert.service`;
  let execStartPre: string | undefined;
  if (deploymentMode === "self") {
    // cliPath = <checkout>/packages/rusa/dist/cli.js
    const packageDir = dirname(dirname(executableSource.cliPath));
    const checkoutRoot = dirname(dirname(packageDir));
    const scriptsDir = join(packageDir, "scripts");
    const distDir = join(packageDir, "dist");
    execStartPre = `${quoteExecArg(nodePath)} ${quoteExecArg(join(scriptsDir, "verify-build.mjs"))} ${quoteExecArg(checkoutRoot)}`;
    // Stamp the sentinel for the freshly-built dist so the gate passes on first boot.
    try {
      const headSha = runInDirOrThrow(checkoutRoot, "git", ["rev-parse", "HEAD"]);
      writeBuildSentinel(distDir, headSha);
      console.log(`✓ Stamped build sentinel for ${headSha.slice(0, 7)} at ${distDir}`);
    } catch (err) {
      console.warn(
        `[install] could not stamp build sentinel: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Install the OnFailure alert oneshot (build-independent notifier).
  installUnit(
    opts.systemdUserDir,
    alertUnitName,
    buildAlertUnit({
      description: `Rusa failure alert (${instance.serviceBasename})`,
      nodePath,
      notifyScript: join(
        dirname(dirname(executableSource.cliPath)),
        "scripts",
        "notify-failure.mjs"
      ),
      mcHome: instance.mcHome,
      errorSink: resolveErrorSink(config)?.ref,
      gchatConfigDir: config.chat?.gchatConfigDir,
      slackBotTokenPath: config.slack?.botTokenPath,
      message: `${instance.serviceUnit} entered a failed state`,
    })
  );

  // Install the primary orchestrator service unit.
  installUnit(
    opts.systemdUserDir,
    instance.serviceUnit,
    buildServiceUnit({
      description:
        opts.environment === "production"
          ? "Rusa Autonomous Coding Agent"
          : "Rusa Autonomous Coding Agent (Staging)",
      mcHome: instance.mcHome,
      cliPath,
      nodePath,
      userPath,
      deployOnMergeBranch: opts.deployOnMergeBranch,
      restart: "always",
      startLimit: { intervalSec: 300, burst: 5 },
      onFailureUnit: alertUnitName,
      coordinatorUnit: coordinatorUnitForClient(opts.systemdUserDir),
      execStartPre,
      logToJournal: opts.logToJournal,
    })
  );

  runOrThrow("systemctl", ["--user", "daemon-reload"]);
  if (opts.restart === false) {
    // Non-disruptive re-apply: ensure enabled + reload (above) so the new unit is on
    // disk and known to systemd, but leave the running process alone. The new policy
    // (boot-gate, OnFailure, Restart=always) takes effect on the next restart/self-update.
    runOrThrow("systemctl", ["--user", "enable", instance.serviceUnit]);
    console.log(
      `✓ Installed ${instance.serviceUnit} (--no-restart): rewrote unit + reloaded systemd, ` +
        "left the running process untouched. New policy applies on the next restart/self-update."
    );
  } else {
    enableAndRestartUnit(instance.serviceUnit);
  }

  configureTailscaleDashboard(config);

  console.log(`\n${instance.serviceUnit} installed.`);
  console.log(`- Status: systemctl --user status ${instance.serviceBasename}`);
  console.log(`- Restart: systemctl --user restart ${instance.serviceBasename}`);
  console.log(`- Stop: systemctl --user stop ${instance.serviceBasename}`);
  printDashboardSummary(instance.mcHome, config);

  return { mcHome: instance.mcHome, config };
}

function parseRepoIdFromRemote(remoteUrl: string): string {
  const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (match) {
    return `${match[1]}/${match[2]}`;
  }
  return "dummy-org/rusa";
}

function prepareSelfHostedInstanceExecutable(opts: {
  mcHome: string;
  sourceRepoRoot: string;
  branchName: string;
}): ExecutableSource {
  const remoteUrl = getRemoteUrl(opts.sourceRepoRoot);
  if (!remoteUrl) {
    throw new Error(`Could not determine git remote for ${opts.sourceRepoRoot}.`);
  }
  const repoId = parseRepoIdFromRemote(remoteUrl);

  const workspace = initializeWorkspace({
    mcHome: opts.mcHome,
    repoId,
    remoteUrl,
    slotCount: 1,
  });
  if (!workspace.success) {
    throw new Error(
      `Failed to initialize self-hosted workspace for ${repoId} in ${opts.mcHome}: ${workspace.error ?? "unknown error"}`
    );
  }

  const repoKey = generateRepoKey(repoId);
  const worktree = addWorktree({
    mcHome: opts.mcHome,
    repoKey,
    key: "deploy",
    branchName: opts.branchName,
    baseBranch: opts.branchName,
    sourceRepoPath: opts.sourceRepoRoot,
  });
  if (!worktree.success) {
    throw new Error(
      `Failed to provision deploy worktree for ${repoId} in ${opts.mcHome}: ${worktree.error ?? "unknown error"}`
    );
  }

  runInDirOrThrow(worktree.path, "pnpm", ["install", "--frozen-lockfile"]);
  runInDirOrThrow(worktree.path, "pnpm", ["build"]);

  return resolveExecutableSource("self", join(worktree.path, "packages", "rusa"));
}

/**
 * Install (or re-apply policy to) the single production self-deploy instance — the only
 * supported self-deploy topology. Prod runs on master and deploys manually (or via the
 * ISSUE_NUM self-update tool); there is no staging/forwarder multi-instance install.
 *
 * Create-or-reuse, idempotent, non-destructive:
 * - If the deploy worktree already exists, reuse it IN PLACE — never move its branch,
 *   never rebuild, and (with restart=false) never bounce the running root.
 * - If it doesn't exist (fresh install), bootstrap it on master (clone + build).
 *
 * Either way it rewrites the unit + OnFailure alert oneshot, stamps the build sentinel
 * for the current HEAD, and applies the full ISSUE_NUM policy (Restart=always + StartLimit +
 * OnFailure + boot-gate) with journal logging. No `deployOnMergeBranch` → manual deploy.
 */
function installSingleSelfDeploy(opts: {
  repoPath?: string;
  systemdUserDir: string;
  restart: boolean;
}): void {
  const mcHome = resolveHome();
  const repoKey = generateRepoKey("Rusa-Org/rusa");
  const deployWorktree = join(mcHome, "workspaces", repoKey, "worktrees", "deploy");
  const cliPath = join(deployWorktree, "packages", "rusa", "dist", "cli.js");

  const executableSource = existsSync(cliPath)
    ? // Reuse the existing built worktree in place.
      resolveExecutableSource("self", deployWorktree)
    : // Fresh install: clone the deploy worktree on master and build it.
      prepareSelfHostedInstanceExecutable({
        mcHome,
        sourceRepoRoot: resolveRepoRoot(opts.repoPath),
        branchName: "master",
      });

  installSingleRusaService({
    environment: "production",
    executableSource,
    deploymentMode: "self",
    systemdUserDir: opts.systemdUserDir,
    restart: opts.restart,
    // Journal logging self-rotates and feeds `rusa logs`; the append-to-file sink
    // is never rotated and previously ballooned to tens of MB on this box.
    logToJournal: true,
    // No deployOnMergeBranch: production deploys manually (or via the self-update tool).
  });
}

/**
 * The provider CLIs this coordinator will have to launch, as commands to resolve.
 *
 * `cliCommand` is optional and defaults to the provider key — the same rule the
 * scrapers apply when they spawn one.
 */
export function configuredProviderCommands(config: RusaConfig): string[] {
  const commands = new Set<string>();
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    const command = provider?.cliCommand?.trim() || name;
    if (command) commands.add(command);
  }
  return [...commands];
}

/**
 * Preflight the probe environment the coordinator unit will run in.
 *
 * These are checked at install time rather than left to fail at scrape time
 * because every one of them fails *quietly*: the service starts, `healthz`
 * passes, and only the per-provider scrape outcome in `readyz` ever says
 * otherwise. Missing tools are reported rather than fatal — a host may install
 * them after the unit — but an unwritable workers directory is fatal, because
 * no probe can run at all without it.
 *
 * Everything looked up here is resolved against the `PATH` the *unit* will
 * carry, not the installer's own. Asking `sh -lc command -v` answered for the
 * login shell running the install, which is the mismatch behind #525: the check
 * passed while the service it was vouching for could not find `codex`.
 */
function preflightProbeEnvironment(
  workersDir: string,
  probePath: ProbePathEnv,
  providerCommands: readonly string[]
): { workersDir: string; missingProviderCommands: string[] } {
  mkdirSync(workersDir, { recursive: true });
  try {
    accessSync(workersDir, fsConstants.W_OK);
  } catch {
    throw new Error(
      `Workers directory ${workersDir} is not writable. The quota coordinator creates ` +
        "quota-probe-<provider> directories under it for every scrape."
    );
  }

  for (const [command, why] of [
    ["bwrap", "the quota probe sandboxes itself with bubblewrap"],
    ["tmux", "one provider's usage panel is only reachable through a PTY"],
  ] as const) {
    if (!resolveExecutableOnPath(command, probePath.path)) {
      console.warn(`⚠️  ${command} not found on the service PATH — ${why}; those scrapes will fail`);
    }
  }

  // A provider CLI missing under the process fallback is unsurprising — that
  // PATH was never the instance's. Missing from the *instance unit's* PATH is a
  // stranger state: the instance itself cannot launch that provider either, so
  // the thing to fix is the instance, not the coordinator.
  const missingProviderCommands = providerCommands.filter(
    (command) => !resolveExecutableOnPath(command, probePath.path)
  );
  for (const command of missingProviderCommands) {
    console.warn(
      `⚠️  Provider CLI ${command} not found on the service PATH — the probe ` +
        "launches it through tmux, so its scrapes will fail" +
        (probePath.source === "process"
          ? ""
          : "; the instance unit cannot launch it either, so fix the instance first")
    );
  }
  return { workersDir, missingProviderCommands };
}

/**
 * Say where the probe `PATH` came from, in terms that are true of each case.
 *
 * The whole argument for printing this is that the choice is never silent, so
 * the three sources have to read differently. Falling back to the shell because
 * the unit assigns no `PATH` is the case an operator most needs to act on — a
 * host upgrading from an older instance unit — and it is not the same as having
 * no instance unit at all.
 */
export function describeProbePathSource(
  probePath: ProbePathEnv,
  unitName: string,
  instanceUnitInstalled: boolean
): string {
  switch (probePath.source) {
    case "instance-unit-systemd":
      return `taken from ${unitName} as systemd resolves it (drop-ins included)`;
    case "instance-unit-file":
      return `taken from the ${unitName} unit file (systemd could not report it; any drop-in PATH was not seen)`;
    default:
      return instanceUnitInstalled
        ? `from this shell — ${unitName} assigns no PATH of its own; reinstall the instance to give it one`
        : `from this shell (no ${unitName} installed yet)`;
  }
}

/**
 * The same account for the pool coordinator, which has no single instance unit.
 *
 * It borrows from whichever client unit can supply a `PATH`, so the line has to
 * name the donor rather than a unit fixed in advance. The two shell fallbacks
 * are kept apart for the same reason as above: a client that is installed but
 * assigns no `PATH` is the case that reproduces #525 and the one an operator can
 * act on, while no client at all is expected on a host that provisions the
 * coordinator first.
 */
export function describePoolProbePathSource(
  probePath: ProbePathEnv,
  donorUnit: string | null,
  installedClientUnits: readonly string[]
): string {
  if (donorUnit !== null) return describeProbePathSource(probePath, donorUnit, true);
  if (installedClientUnits.length > 0) {
    return (
      `from this shell — none of ${installedClientUnits.join(", ")} assigns a PATH of its own; ` +
      "reinstall a client instance to give it one"
    );
  }
  return `from this shell (no pool client unit installed yet: ${poolClientUnitNames().join(", ")})`;
}

/**
 * Install the pool-owned quota coordinator unit and its failure-alert companion.
 *
 * Separate from `install-service` rather than folded into it: the coordinator is
 * one service per *pool*, and the pool is the set of instances sharing a quota
 * database — installing it implicitly alongside every instance would start a
 * second collector against the same providers, which is precisely the
 * duplicate-probe behaviour the coordinator exists to remove.
 *
 * It is also no longer installed *for* an instance. Under #507 the unit name is
 * fixed, the home is named explicitly (or adopted from the unit already on
 * disk), and nothing here edits an instance unit: provisioning the service and
 * connecting a client to it are separate acts, and the installer says so rather
 * than reaching into a unit `install-service` owns.
 */
export async function runInstallQuotaCoordinator(opts?: {
  /** The coordinator's own home. Falls back to the env var, then to adoption. */
  home?: string;
  deploymentMode?: DeploymentMode;
  repoPath?: string;
  /** Start/restart the unit after installing. Default true. */
  restart?: boolean;
  /**
   * Allow this install to point the pool coordinator at a different database
   * than the installed unit opens. Off by default: that is the pool's
   * authoritative quota history changing identity.
   */
  allowDatabaseChange?: boolean;
}): Promise<void> {
  const deploymentMode = opts?.deploymentMode ?? "package";

  if (!hasCommand("systemctl")) {
    throw new Error(
      "systemctl is not available on this host. install-quota-coordinator supports systemd only."
    );
  }
  ensureDbusUserSessionPackage();
  ensureUserSystemdBusAvailable();

  const systemdUserDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(systemdUserDir, { recursive: true });
  const installedUnitNames = readdirSync(systemdUserDir).filter((name) =>
    name.endsWith(".service")
  );

  const context = resolveCoordinatorServiceContext({
    home: opts?.home,
    envHome: process.env[COORDINATOR_HOME_ENV],
    installedUnits: readInstalledCoordinatorUnits(systemdUserDir, installedUnitNames),
  });
  if (!existsSync(context.configPath)) {
    throw new Error(
      `Config file not found at ${context.configPath}. The pool coordinator reads its ` +
        "own service home; run 'rusa init' against that home, or pass --home <path>."
    );
  }
  const config = loadConfig(context.home);

  // The unit runs `quota-coordinator` with no `--database`, so the preflight
  // applies the same rule the service will: only the service-owned path
  // starts, and a config still naming the pre-service file is refused here
  // rather than by a unit that fails on its first start.
  const { databasePath } = resolveCoordinatorDatabasePaths(config, context.home);
  assertDatabaseIdentityPreserved({
    systemdUserDir,
    serviceUnit: context.serviceUnit,
    home: context.home,
    databasePath,
    allowDatabaseChange: opts?.allowDatabaseChange === true,
  });

  // #525: the provider-capable PATH is borrowed from an installed client unit,
  // which is where it is already written down, rather than inherited from
  // whichever shell ran this installer. That shell dependence is the bug — an
  // install from a minimal environment wrote a unit with no `codex` on its
  // PATH, and the coordinator then started, answered `healthz`, and never
  // scraped. Nothing else about the coordinator is taken from that unit, and
  // the borrow is reported below.
  const {
    probePath,
    donorUnit,
    installedUnits: installedClientUnits,
  } = resolvePoolProbePath(systemdUserDir, poolClientUnitNames());
  const userPath = probePath.path;

  const providerCommands = configuredProviderCommands(config);
  const { workersDir, missingProviderCommands } = preflightProbeEnvironment(
    context.workersDir,
    probePath,
    providerCommands
  );

  const executableSource = resolveExecutableSource(deploymentMode, opts?.repoPath);
  const cliPath = resolvePathForUnit(executableSource.cliPath);
  const nodePath = resolvePathForUnit(executableSource.nodePath);
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR?.trim() || `/run/user/${userInfo().uid}`;

  installUnit(
    systemdUserDir,
    context.alertUnit,
    buildAlertUnit({
      description: "Rusa quota coordinator failure alert",
      nodePath,
      notifyScript: join(
        dirname(dirname(executableSource.cliPath)),
        "scripts",
        "notify-failure.mjs"
      ),
      mcHome: context.home,
      errorSink: resolveErrorSink(config)?.ref,
      gchatConfigDir: config.chat?.gchatConfigDir,
      slackBotTokenPath: config.slack?.botTokenPath,
      message: `${context.serviceUnit} entered a failed state`,
    })
  );

  installUnit(
    systemdUserDir,
    context.serviceUnit,
    buildQuotaCoordinatorUnit({
      description: "Rusa Quota Coordinator",
      mcHome: context.home,
      cliPath,
      nodePath,
      userPath,
      xdgRuntimeDir,
      onFailureUnit: context.alertUnit,
      startLimit: { intervalSec: 300, burst: 5 },
    })
  );

  const removed = retireEnvironmentDerivedCoordinators(systemdUserDir, installedUnitNames);

  runOrThrow("systemctl", ["--user", "daemon-reload"]);
  if (opts?.restart === false) {
    runOrThrow("systemctl", ["--user", "enable", context.serviceUnit]);
    console.log(`✓ Installed ${context.serviceUnit} (--no-restart)`);
  } else {
    enableAndRestartUnit(context.serviceUnit);
  }

  reportClientOrdering(systemdUserDir, context.serviceUnit);

  const socketPath =
    config.quota?.coordinator?.socketPath?.trim() || defaultQuotaCoordinatorSocketPath();
  console.log(`\n${context.serviceUnit} installed.`);
  console.log(`- Service home: ${context.home} (${describeHomeSource(context)})`);
  console.log(`- Socket: ${socketPath}`);
  console.log(`- Database: ${databasePath}`);
  console.log(
    `- Backups: ${config.quota?.coordinator?.backupDir?.trim() ?? defaultQuotaBackupDir(databasePath)}`
  );
  console.log(`- Workers dir: ${workersDir}`);
  console.log(
    `- Probe PATH: ${describePoolProbePathSource(probePath, donorUnit, installedClientUnits)}`
  );
  console.log(
    `- Provider CLIs: ${providerCommands.length - missingProviderCommands.length} of ` +
      `${providerCommands.length} resolved on that PATH` +
      (missingProviderCommands.length > 0
        ? ` (missing: ${missingProviderCommands.join(", ")})`
        : "")
  );
  if (removed.length > 0) {
    console.log(`- Retired duplicate pool coordinators: ${removed.join(", ")}`);
  }
  console.log(`- Status: systemctl --user status ${context.serviceUnit}`);
  console.log(`- Logs: journalctl --user -u ${context.serviceUnit} -f`);
  console.log(`- Readiness: curl --unix-socket ${socketPath} http://localhost/v1/readyz`);
}

function describeHomeSource(context: CoordinatorServiceContext): string {
  switch (context.homeSource) {
    case "flag":
      return "named with --home";
    case "env":
      return `named by ${COORDINATOR_HOME_ENV}`;
    default:
      return `adopted from ${context.adoptedFrom}`;
  }
}

/**
 * Refuse to silently change which quota database the pool coordinator opens.
 *
 * The one thing a packaging change must not do is move the pool's authoritative
 * quota history. If a coordinator unit is already installed against a different
 * home, this compares the file that unit resolves with the file this install
 * would resolve, and stops when they differ. It does not read the old home's
 * config to decide whether to *proceed* — an unreadable old home is simply
 * unknown and not an obstacle — only to decide whether to *stop*.
 */
function assertDatabaseIdentityPreserved(opts: {
  systemdUserDir: string;
  serviceUnit: string;
  home: string;
  databasePath: string;
  allowDatabaseChange: boolean;
}): void {
  if (opts.allowDatabaseChange) return;
  const unitPath = join(opts.systemdUserDir, opts.serviceUnit);
  if (!existsSync(unitPath)) return;
  const priorHome = readUnitEnvironment(readFileSync(unitPath, "utf-8"), "RUSA_HOME");
  if (!priorHome || priorHome === opts.home) return;

  let priorDatabase: string;
  try {
    priorDatabase = resolveCoordinatorDatabasePaths(loadConfig(priorHome), priorHome).databasePath;
  } catch {
    return;
  }
  if (priorDatabase === opts.databasePath) return;

  throw new Error(
    `${opts.serviceUnit} currently opens ${priorDatabase} (home ${priorHome}); installing against ` +
      `${opts.home} would point it at ${opts.databasePath}. That changes which database holds the ` +
      "pool's authoritative quota history, which is not something an install should do on its own. " +
      "Re-run with --allow-database-change if that is the intent; neither file is touched either way."
  );
}

/**
 * Stop, disable, and remove the environment-derived coordinator units.
 *
 * These are the duplicate pool coordinators: a second unit, derived from a
 * second instance's basename, probing the same providers against the same
 * pool. Removal is idempotent — a host that has already transitioned has
 * nothing to remove — and it removes *units*, never databases: a retired
 * coordinator's database file is left exactly where it is, and is named here so
 * an operator can see what it was.
 *
 * `stopUnit` is the seam a test drives this through: the decision of what to
 * retire, the removal, and the reporting are the parts worth exercising, and
 * none of them should require a live user manager to observe.
 */
export function retireEnvironmentDerivedCoordinators(
  systemdUserDir: string,
  installedUnitNames: readonly string[],
  stopUnit: (unit: string) => void = (unit) => {
    runQuietly("systemctl", ["--user", "disable", "--now", unit]);
  }
): string[] {
  const { removeUnits } = planCoordinatorTransition(installedUnitNames);
  const retired: string[] = [];
  for (const unit of removeUnits) {
    const unitPath = join(systemdUserDir, unit);
    const retiredHome = existsSync(unitPath)
      ? readUnitEnvironment(readFileSync(unitPath, "utf-8"), "RUSA_HOME")
      : null;
    stopUnit(unit);
    rmSync(unitPath, { force: true });
    retired.push(unit);
    console.log(`✓ Retired duplicate pool coordinator ${unit}`);
    if (retiredHome) {
      console.log(`  its home ${retiredHome} and any database under it are left untouched on disk`);
    }
  }
  return retired;
}

/**
 * Report, without editing, which client instance units order after the pool
 * coordinator.
 *
 * The old installer retrofitted `After=`/`Wants=` into the instance unit that
 * matched its `--environment`. That is the coupling #507 removes: provisioning
 * the pool service is not the moment to rewrite a unit `install-service` owns,
 * and under a pool model there is no single matching instance to rewrite
 * anyway. The ordering is still wanted — it is written by `install-service`,
 * which owns those units — so this says which instances are missing it and how
 * to get it, and changes nothing.
 */
function reportClientOrdering(systemdUserDir: string, coordinatorUnit: string): void {
  for (const unit of poolClientUnitNames()) {
    const unitPath = join(systemdUserDir, unit);
    if (!existsSync(unitPath)) continue;
    const contents = readFileSync(unitPath, "utf-8");
    if (unitOrdersAfter(contents, coordinatorUnit)) {
      console.log(`✓ ${unit} already orders after ${coordinatorUnit}`);
    } else {
      console.warn(
        `⚠️  ${unit} does not order after ${coordinatorUnit}. Re-run ` +
          "`rusa install-service` for that instance to add it; this installer no longer " +
          "edits instance units."
      );
    }
  }
}

/**
 * Install and enable the systemd user service for rusa.
 */
export async function runInstallService(opts?: {
  environment?: ServiceEnvironment;
  deploymentMode?: DeploymentMode;
  repoPath?: string;
  /** Restart running instances after install. Default true; false = non-disruptive re-apply. */
  restart?: boolean;
}): Promise<void> {
  const environment = opts?.environment ?? "production";
  const deploymentMode = opts?.deploymentMode ?? "package";
  const restart = opts?.restart ?? true;

  if (!hasCommand("systemctl")) {
    throw new Error(
      "systemctl is not available on this host. install-service currently supports systemd only."
    );
  }

  ensureDbusUserSessionPackage();
  ensureUserSystemdBusAvailable();

  const systemdUserDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(systemdUserDir, { recursive: true });

  if (deploymentMode === "self") {
    // Self-deploy is always the single prod-on-master instance (create-or-reuse).
    if (environment !== "production") {
      throw new Error("--deployment-mode self installs the single production instance only.");
    }
    installSingleSelfDeploy({ repoPath: opts?.repoPath, systemdUserDir, restart });
  } else {
    installSingleRusaService({
      environment,
      deploymentMode,
      repoPath: opts?.repoPath,
      systemdUserDir,
      restart,
    });
  }

  try {
    runOrThrow("loginctl", ["enable-linger", userInfo().username]);
    console.log("✓ Enabled linger for this user");
  } catch {
    console.log(
      "⚠️  Could not enable linger automatically. If needed, run: " +
        `loginctl enable-linger ${userInfo().username}`
    );
  }
}
