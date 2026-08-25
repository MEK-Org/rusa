import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { ensureWakeToken, preflightCron } from "../actor/wake-cron.js";
import { loadConfig, resolveHome } from "../config/index.js";
import type { RusaConfig } from "../config/types.js";
import {
  addWorktree,
  generateRepoKey,
  getRemoteUrl,
  initializeWorkspace,
} from "../gitops/worktree.js";
import { writeBuildSentinel } from "../update/build-sentinel.js";
import {
  type DeploymentMode,
  type ExecutableSource,
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
  errorChat?: string;
  gchatConfigDir?: string;
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
  if (opts.errorChat) unit.push(`Environment=RUSA_ERROR_CHAT=${opts.errorChat}`);
  if (opts.gchatConfigDir) unit.push(`Environment=GCHAT_CONFIG_DIR=${opts.gchatConfigDir}`);
  unit.push(
    `ExecStart=${quoteExecArg(opts.nodePath)} ${quoteExecArg(opts.notifyScript)} ${quoteExecArg(opts.message)}`,
    ""
  );
  return unit.join("\n");
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
      errorChat: config.chat?.errorChat,
      gchatConfigDir: config.chat?.gchatConfigDir,
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
