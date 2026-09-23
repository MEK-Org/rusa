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

export function resolveServiceBasename(environment: ServiceEnvironment): string {
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
 * Split one systemd environment string into its `NAME=value` assignments.
 *
 * `Environment=` sets several variables on one line, and either the whole
 * assignment or just its value may be double-quoted — `Environment="PATH=/a"`
 * and `Environment=PATH="/a"` are both legal and mean the same thing. Splitting
 * on whitespace outside quotes handles both, and a PATH segment containing a
 * space (which must be quoted) survives.
 */
function splitEnvironmentAssignments(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const ch of raw.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && /\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * The last `NAME=` among these assignments — last-wins, as systemd resolves it.
 *
 * The prefix is matched whole, so `RUSA_SLACK_BOT_TOKEN_PATH` can never be
 * mistaken for `PATH`.
 */
function lastAssignment(assignments: readonly string[], name: string): string | null {
  const prefix = `${name}=`;
  let found: string | null = null;
  for (const assignment of assignments) {
    if (assignment.startsWith(prefix)) found = assignment.slice(prefix.length);
  }
  return found ? found : null;
}

/**
 * Ask systemd for the `PATH` a loaded unit will actually run with.
 *
 * This is the authoritative answer and the reason it is asked first: `systemctl
 * show` returns the *effective* environment, with `<unit>.d/*.conf` drop-ins
 * folded in, repeated assignments resolved last-wins, and quoting and
 * multi-variable lines already parsed. Reading the unit file sees none of that,
 * so a provider-capable `PATH` that lives in a drop-in — an established
 * operator mechanism here — would be missed entirely.
 *
 * Returns null when systemd cannot answer (no user manager) and equally when
 * it answers that the unit assigns no `PATH`, which is why `readUnitPathEnv`
 * remains as a fallback. {@link probeSystemdUnitPathEnv} keeps those two apart
 * for callers that have to report which one they are looking at.
 */
export function readSystemdUnitPathEnv(unitName: string): string | null {
  return probeSystemdUnitPathEnv(unitName).path;
}

/** What systemd said about a unit's `PATH`, including whether it said anything. */
export interface SystemdUnitPathProbe {
  /**
   * False only when the user manager could not be asked at all — no session
   * bus, no user manager. `systemctl show` answers for a unit it has never
   * heard of (exit 0, empty value), so a failure here is about the manager and
   * never about the unit.
   */
  answered: boolean;
  /** The assigned `PATH`, or null when the unit assigns none — or nobody answered. */
  path: string | null;
}

/**
 * {@link readSystemdUnitPathEnv}, keeping the distinction it throws away.
 *
 * "Systemd reports no PATH for this unit" and "systemd could not be asked" are
 * the same `null` to a caller that only wants a `PATH`, and different answers
 * to one that has to report what it knows: the first means the unit is not
 * assigning a PATH, the second means nothing about the unit has been
 * established at all.
 */
export function probeSystemdUnitPathEnv(unitName: string): SystemdUnitPathProbe {
  try {
    const raw = execFileSync(
      "systemctl",
      ["--user", "show", "-p", "Environment", "--value", unitName],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }
    );
    return { answered: true, path: lastAssignment(splitEnvironmentAssignments(raw), "PATH") };
  } catch {
    return { answered: false, path: null };
  }
}

/**
 * Read the `PATH` a unit file assigns, as a fallback for when systemd cannot say.
 *
 * Drop-ins are deliberately out of scope here: merging `<unit>.d/*.conf` by hand
 * would be reimplementing what `readSystemdUnitPathEnv` already gets for free,
 * and this path only runs when that one could not answer at all.
 *
 * Returns null when the unit assigns no `PATH`, which is a real case — a unit
 * written before this directive existed inherits systemd's `/usr/bin:/bin`.
 */
export function readUnitPathEnv(unitContents: string): string | null {
  return readUnitEnvironment(unitContents, "PATH");
}

/**
 * Read one `Environment=` assignment out of a unit file.
 *
 * Generalized over the variable name because an installed unit is the durable
 * record of more than its `PATH`: the pool coordinator installer reads
 * `RUSA_HOME` back out of a coordinator unit it is about to replace, so a
 * transition adopts the home the running service actually uses rather than one
 * inferred from the unit's name.
 *
 * Splitting each `Environment=` line into assignments rather than matching the
 * rest of the line is what makes `Environment=PATH=/usr/bin FOO=bar` and its
 * mirror both read correctly, and it is why the name is matched as a whole
 * assignment prefix: `RUSA_SLACK_BOT_TOKEN_PATH` is not `PATH`.
 */
export function readUnitEnvironment(unitContents: string, name: string): string | null {
  let found: string | null = null;
  for (const line of unitContents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Environment=")) continue;
    const fromLine = lastAssignment(
      splitEnvironmentAssignments(trimmed.slice("Environment=".length)),
      name
    );
    if (fromLine) found = fromLine;
  }
  return found ? found : null;
}

/** Where a probe `PATH` came from, so the installer can say so rather than imply it. */
export interface ProbePathEnv {
  path: string;
  /**
   * `instance-unit-systemd` is the effective environment including drop-ins;
   * `instance-unit-file` is the unit text alone, taken only when systemd could
   * not answer; `process` is the installing shell, which is what #525 is about.
   */
  source: "instance-unit-systemd" | "instance-unit-file" | "process";
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
 * and it does not change when the installing shell does. systemd is asked for
 * it first so drop-ins count; the unit text is the fallback for a host whose
 * user manager cannot answer. The process `PATH` is the last resort, for the
 * one case where there is no instance unit yet — a coordinator installed before
 * any instance — and the caller reports which of the three it used.
 *
 * `instanceUnitContents` being null means no instance unit is installed, so
 * systemd is not asked: `systemctl show` answers for an unknown unit with an
 * empty environment rather than an error, which would be indistinguishable from
 * a unit that assigns no `PATH`.
 */
export function resolveProbePathEnv(
  unitName: string,
  instanceUnitContents: string | null,
  readSystemdPath: (unit: string) => string | null = readSystemdUnitPathEnv
): ProbePathEnv {
  if (instanceUnitContents !== null) {
    const fromSystemd = readSystemdPath(unitName);
    if (fromSystemd) return { path: fromSystemd, source: "instance-unit-systemd" };
    const fromFile = readUnitPathEnv(instanceUnitContents);
    if (fromFile) return { path: fromFile, source: "instance-unit-file" };
  }
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
