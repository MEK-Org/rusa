import { execFileSync } from "node:child_process";
import { accessSync, existsSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type ServiceEnvironment = "production" | "staging";
export type DeploymentMode = "package" | "self";

export interface ServiceInstanceInfo {
  environment: ServiceEnvironment;
  serviceBasename: string;
  serviceUnit: string;
  mcHome: string;
  logPath: string;
}

export interface ExecutableSource {
  cliPath: string;
  nodePath: string;
}

function resolveGitRepoRoot(dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function resolveCurrentPackageDir(): string | null {
  const entry = process.argv[1];
  if (!entry) return null;
  try {
    return dirname(dirname(realpathSync(resolve(entry))));
  } catch {
    return null;
  }
}

function resolveServiceBasename(environment: ServiceEnvironment): string {
  return environment === "production" ? "rusa" : "rusa-staging";
}

export function resolveServiceHome(environment: ServiceEnvironment, homeOverride?: string): string {
  if (homeOverride) return resolve(homeOverride);
  return environment === "production" ? join(homedir(), ".rusa") : join(homedir(), ".rusa-staging");
}

export function resolveServiceInstance(
  environment: ServiceEnvironment,
  homeOverride?: string
): ServiceInstanceInfo {
  const serviceBasename = resolveServiceBasename(environment);
  const mcHome = resolveServiceHome(environment, homeOverride);
  return {
    environment,
    serviceBasename,
    serviceUnit: `${serviceBasename}.service`,
    mcHome,
    logPath: join(mcHome, "logs", "rusa.log"),
  };
}

export function resolveCurrentRepoRoot(): string | null {
  const packageDir = resolveCurrentPackageDir();
  if (!packageDir) return null;
  return resolveGitRepoRoot(packageDir);
}

export function resolveRepoRoot(repoPath?: string): string {
  if (repoPath) {
    const resolvedPath = resolve(repoPath);
    const repoRoot = resolveGitRepoRoot(resolvedPath);
    if (!repoRoot) {
      throw new Error(`Could not determine git repo root for ${resolvedPath}.`);
    }
    return repoRoot;
  }

  const currentRepoRoot = resolveCurrentRepoRoot();
  if (!currentRepoRoot) {
    throw new Error("Could not infer the current git repo root. Re-run with --repo-path.");
  }
  return currentRepoRoot;
}

function resolveSelfPackageDir(repoPath?: string): string {
  if (repoPath) {
    const repoRoot = resolve(repoPath);
    const monorepoPackageDir = join(repoRoot, "packages", "rusa");
    if (existsSync(join(monorepoPackageDir, "package.json"))) {
      return monorepoPackageDir;
    }
    if (existsSync(join(repoRoot, "package.json"))) {
      return repoRoot;
    }
    throw new Error(
      `Could not find rusa package.json under ${repoRoot}. Pass the repo root or package directory.`
    );
  }

  const packageDir = resolveCurrentPackageDir();
  if (!packageDir) {
    throw new Error("Could not infer the current rusa package directory. Re-run with --repo-path.");
  }
  return packageDir;
}

export function resolveExecutableSource(
  deploymentMode: DeploymentMode,
  repoPath?: string
): ExecutableSource {
  if (deploymentMode === "package") {
    return {
      cliPath: resolve(process.argv[1] ?? "rusa"),
      nodePath: process.execPath,
    };
  }

  const packageDir = resolveSelfPackageDir(repoPath);
  const cliPath = join(packageDir, "dist", "cli.js");
  if (!existsSync(cliPath)) {
    throw new Error(
      `Self deployment expects a built CLI at ${cliPath}. Run 'pnpm build' in that checkout first.`
    );
  }

  return {
    cliPath,
    nodePath: process.execPath,
  };
}

export function resolvePathForUnit(pathValue: string): string {
  const multishell = process.env.FNM_MULTISHELL_PATH;
  const fnmDir = process.env.FNM_DIR;

  if (multishell && fnmDir && pathValue.startsWith(multishell)) {
    const stableBase = join(fnmDir, "node-versions", process.version, "installation");
    return pathValue.replace(multishell, stableBase);
  }

  return pathValue;
}

// fnm "multishell" bins live under a per-shell ephemeral dir (e.g.
// /run/user/<uid>/fnm_multishells/<id>/bin) that vanishes across reboots and is unique
// per shell session — so a long-lived systemd unit must never bake one in. We rewrite
// ANY such segment (not just the current shell's) to the stable node-versions bin.
const FNM_MULTISHELL_BIN_RE = /\/fnm_multishells\/[^/]+\/bin\/?$/;

export function resolvePathEnvForUnit(): string {
  const rawPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const fnmDir = process.env.FNM_DIR;
  const stableBin = fnmDir
    ? join(fnmDir, "node-versions", process.version, "installation", "bin")
    : undefined;

  // Normalize each segment to absolute, rewrite ephemeral fnm bins to the stable bin,
  // then dedupe (keeping first occurrence) so the unit's PATH is stable and tidy.
  const seen = new Set<string>();
  const segments: string[] = [];
  for (const segment of rawPath.split(":")) {
    if (!segment) continue;
    let absPath = isAbsolute(segment) ? segment : resolve(segment);
    if (stableBin && FNM_MULTISHELL_BIN_RE.test(absPath)) {
      absPath = stableBin;
    }
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    segments.push(absPath);
  }
  return segments.join(":");
}

/**
 * Read the `PATH` a unit file assigns to the service it describes.
 *
 * systemd resolves repeated assignments to one variable last-wins, so the last
 * `Environment=PATH=` line is the one the service actually runs with. Both the
 * bare and double-quoted spellings are accepted because both are legal and an
 * operator drop-in may use either; `install-service` itself writes the bare form.
 *
 * Returns null when the unit assigns no `PATH`, which is a real case — a unit
 * written before this directive existed inherits systemd's `/usr/bin:/bin`.
 */
export function readUnitPathEnv(unitContents: string): string | null {
  let found: string | null = null;
  for (const line of unitContents.split("\n")) {
    const match = /^\s*Environment=(?:"PATH=([^"]*)"|PATH=(.*))$/.exec(line.trimEnd());
    if (!match) continue;
    found = (match[1] ?? match[2] ?? "").trim();
  }
  return found ? found : null;
}

/** Where a probe `PATH` came from, so the installer can say so rather than imply it. */
export interface ProbePathEnv {
  path: string;
  source: "instance-unit" | "process";
}

/**
 * Resolve the `PATH` the quota coordinator unit should run with.
 *
 * The coordinator scrapes by launching provider CLIs, so its `PATH` has to
 * contain them. Deriving it from `process.env.PATH` alone made that a property
 * of whichever shell happened to run the installer: an install from a minimal
 * environment (a unit, a cron job, a non-login shell) wrote a unit whose `PATH`
 * had no `codex` in it, the coordinator still started and answered `healthz`,
 * and only the scrape failed — which is issue #525.
 *
 * The installed instance unit is the durable source of truth instead. It is on
 * disk, it is the environment the instance already resolves provider CLIs in,
 * and it does not change when the installing shell does. The process `PATH` is
 * the fallback for the one case where there is no such unit yet — a coordinator
 * installed before any instance — and the caller reports which one it used.
 */
export function resolveProbePathEnv(instanceUnitContents: string | null): ProbePathEnv {
  const fromUnit = instanceUnitContents ? readUnitPathEnv(instanceUnitContents) : null;
  if (fromUnit) return { path: fromUnit, source: "instance-unit" };
  return { path: resolvePathEnvForUnit(), source: "process" };
}

/**
 * Resolve `command` against an explicit `PATH` rather than this process's.
 *
 * Install-time checks have to ask about the `PATH` the *unit* will have; using
 * `command -v` asks about the installer's shell, which is the very thing #525
 * is about. A command containing a slash is a path already and is only checked
 * for being an executable file.
 */
export function resolveExecutableOnPath(command: string, pathEnv: string): string | null {
  if (command.includes("/")) {
    const candidate = isAbsolute(command) ? command : resolve(command);
    return isExecutableFile(candidate) ? candidate : null;
  }
  for (const segment of pathEnv.split(":")) {
    if (!segment) continue;
    const candidate = join(segment, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveServiceDashboardUrl(
  tailscaleHostname?: string,
  tailscaleServiceName?: string,
  magicDnsSuffix?: string
): string | null {
  if (tailscaleHostname) {
    return `https://${tailscaleHostname}/`;
  }
  if (tailscaleServiceName && magicDnsSuffix) {
    return `https://${tailscaleServiceName}.${magicDnsSuffix}/`;
  }
  return null;
}
