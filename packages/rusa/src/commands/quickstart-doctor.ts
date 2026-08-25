import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { createServer } from "node:net";
import { arch as osArch } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type DoctorStatus = "pass" | "fail" | "warn" | "info";

export interface DoctorResult {
  name: string;
  status: DoctorStatus;
  message: string;
  hint?: string;
  probed?: string[];
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

export interface QuickstartDoctorDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  arch: () => string;
  run: (command: string, args: string[], cwd?: string) => CommandResult;
  readText: (path: string) => string;
  fileExists: (path: string) => boolean;
  freeBytes: (path: string) => number;
  isPortAvailable: (port: number) => Promise<boolean>;
}

export interface QuickstartDoctorOptions {
  repoRoot?: string;
  targetPath?: string;
  minFlutterVersion?: string;
  minFreeDiskBytes?: number;
  ports?: number[];
  providerEnvKeys?: string[];
  deps?: Partial<QuickstartDoctorDeps>;
}

interface QuickstartDoctorCheck {
  id: string;
  run: () => DoctorResult | Promise<DoctorResult>;
}

interface CommandProbe {
  command: string;
  args: string[];
  resolvedCommand: string;
  pathEntries: string[];
  fallbackCandidates: string[];
  env: string[];
  cwd?: string;
}

export const QUICKSTART_MIN_FLUTTER_VERSION = "3.24.0";
export const QUICKSTART_MIN_FREE_DISK_BYTES = 10 * 1024 * 1024 * 1024;
export const QUICKSTART_PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "KIMI_API_KEY",
] as const;

export const QUICKSTART_DOCTOR_CHECKS = [
  "node",
  "pnpm",
  "flutter",
  "docker-daemon",
  "docker-compose",
  "git",
  "arch",
  "free-disk",
  "loopback-ports",
  "provider-env-keys",
] as const;

function buildQuickstartDoctorChecks(opts: {
  deps: QuickstartDoctorDeps;
  repoRoot: string;
  targetPath: string;
  minFlutterVersion: string;
  minFreeDiskBytes: number;
  ports: number[];
  providerEnvKeys: readonly string[];
}): QuickstartDoctorCheck[] {
  const gitCheck = checkCommand("git", "git", ["--version"], REMEDIATION.git);
  const pnpmCheck = checkCommand("pnpm", "pnpm", ["--version"], REMEDIATION.pnpm);

  return [
    { id: "node", run: () => checkNode(opts.repoRoot, opts.deps) },
    { id: "pnpm", run: () => pnpmCheck(opts.deps) },
    { id: "flutter", run: () => checkFlutter(opts.minFlutterVersion, opts.deps) },
    { id: "docker-daemon", run: () => checkDockerDaemon(opts.deps) },
    { id: "docker-compose", run: () => checkDockerCompose(opts.deps) },
    { id: "git", run: () => gitCheck(opts.deps) },
    { id: "arch", run: () => checkArch(opts.deps) },
    {
      id: "free-disk",
      run: () => checkFreeDisk(opts.targetPath, opts.minFreeDiskBytes, opts.deps),
    },
    { id: "loopback-ports", run: () => checkLoopbackPorts(opts.ports, opts.deps) },
    {
      id: "provider-env-keys",
      run: () => checkProviderEnvKeys(opts.deps.env, opts.providerEnvKeys),
    },
  ];
}

const REMEDIATION = {
  node: "Install Node with nvm: curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 20 && nvm use 20",
  pnpm: "Enable pnpm with Corepack: corepack enable && corepack prepare pnpm@10.29.3 --activate",
  flutter:
    "Install Flutter with fvm: dart pub global activate fvm && fvm install stable && fvm global stable",
  docker: "Install and start Docker Desktop, or on Linux run: sudo systemctl enable --now docker",
  compose: "Install the Docker Compose plugin: https://docs.docker.com/compose/install/",
  git: "Install git: brew install git  # macOS, or sudo apt-get install git  # Debian/Ubuntu",
  disk: "Free disk space on the target volume, then rerun pnpm start.",
  ports: "Stop the process using the port, or change the quickstart port before launching.",
  env: "Unset exported provider API keys for this shell: unset ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY KIMI_API_KEY",
};

const RUNTIME_REMEDIATION = {
  node: "Run node --version directly and fix the reported runtime error before rerunning pnpm start.",
  pnpm: "Run pnpm --version directly and fix the reported runtime error before rerunning pnpm start.",
  flutter:
    "Run the reported Flutter/fvm command directly; if using fvm, run inside a Flutter project or configure a global SDK.",
  docker: "Start Docker, then run docker info directly to verify the daemon is reachable.",
  compose: "Run docker compose version directly and fix the reported Docker Compose runtime error.",
  git: "Run git --version directly and fix the reported runtime error before rerunning pnpm start.",
};

function defaultRun(command: string, args: string[], cwd?: string): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe", cwd });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error as NodeJS.ErrnoException | undefined,
  };
}

function defaultIsPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.once("listening", () => {
      server.close(() => resolvePort(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Walk up from `startDir` to the pnpm workspace root (marked by
 * `pnpm-workspace.yaml`, which exists only there — unlike `package.json`,
 * which also exists one level down at `packages/rusa/` and would stop
 * the walk too early).
 */
function findWorkspaceRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not locate the rusa workspace root (pnpm-workspace.yaml) walking up from ${startDir}.`
      );
    }
    dir = parent;
  }
}

/**
 * `checkNode`'s `engines.node` range lives in the workspace-root
 * `package.json`, not `packages/rusa/package.json` — so this must
 * resolve to the workspace root under both the dev (`src/commands/`) and
 * built (`dist/`) module layouts. A fixed `../../..` walk only did that by
 * coincidence for the built layout and landed on `<repo>/packages` (which
 * has no `package.json` at all) for the dev layout — see ISSUE_NUM.
 */
export function defaultRepoRoot(): string {
  return findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
}

export function defaultFlutterDashboardDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, "../../flutter_dashboard"), // source: src/commands/ -> packages/rusa/flutter_dashboard
    resolve(moduleDir, "../flutter_dashboard"), // bundled: dist/ -> packages/rusa/flutter_dashboard
  ];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0];
}

function buildDeps(overrides: Partial<QuickstartDoctorDeps> = {}): QuickstartDoctorDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    arch: osArch,
    run: defaultRun,
    readText: (path) => readFileSync(path, "utf8"),
    fileExists: existsSync,
    freeBytes: (path) => {
      const stats = statfsSync(path);
      return Number(stats.bavail) * Number(stats.bsize);
    },
    isPortAvailable: defaultIsPortAvailable,
    ...overrides,
  };
}

function cleanVersion(raw: string): string | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return match?.[0] ?? null;
}

function parseVersion(version: string): [number, number, number] | null {
  const cleaned = cleanVersion(version);
  if (!cleaned) return null;
  return cleaned.split(".").map((part) => Number(part)) as [number, number, number];
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return Number.NaN;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

export function satisfiesVersionRange(version: string, range: string): boolean {
  const alternatives = range
    .split("||")
    .map((part) => part.trim())
    .filter(Boolean);
  return alternatives.some((alternative) => {
    const constraints = alternative.split(/\s+/).filter(Boolean);
    return constraints.every((constraint) => {
      const match = constraint.match(/^(>=|>|<=|<|=|\^)?\s*v?(\d+\.\d+\.\d+)$/);
      if (!match) return false;
      const operator = match[1] ?? "=";
      const target = match[2];
      const comparison = compareVersions(version, target);
      if (Number.isNaN(comparison)) return false;
      if (operator === ">=") return comparison >= 0;
      if (operator === ">") return comparison > 0;
      if (operator === "<=") return comparison <= 0;
      if (operator === "<") return comparison < 0;
      if (operator === "^") {
        const current = parseVersion(version);
        const minimum = parseVersion(target);
        return !!current && !!minimum && current[0] === minimum[0] && comparison >= 0;
      }
      return comparison === 0;
    });
  });
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

function commandSucceeded(result: CommandResult): boolean {
  return result.status === 0;
}

function commandNotFound(result: CommandResult): boolean {
  return result.error?.code === "ENOENT";
}

function pathEntries(deps: QuickstartDoctorDeps): string[] {
  return (deps.env.PATH ?? "").split(delimiter).filter(Boolean);
}

function homePath(deps: QuickstartDoctorDeps, path: string): string | null {
  const home = deps.env.HOME || deps.env.USERPROFILE;
  return home ? join(home, path) : null;
}

function resolveCommand(
  command: string,
  args: string[],
  deps: QuickstartDoctorDeps,
  fallbackCandidates: string[] = []
): CommandProbe {
  const pathCandidates = isAbsolute(command)
    ? [command]
    : pathEntries(deps).map((entry) => join(entry, command));
  const resolvedCommand =
    [...pathCandidates, ...fallbackCandidates].find((candidate) => deps.fileExists(candidate)) ??
    command;

  return {
    command,
    args,
    resolvedCommand,
    pathEntries: pathEntries(deps),
    fallbackCandidates,
    env: [`PATH=${deps.env.PATH ?? ""}`, `HOME=${deps.env.HOME ?? ""}`],
  };
}

function runProbe(probe: CommandProbe, deps: QuickstartDoctorDeps): CommandResult {
  return deps.run(probe.resolvedCommand, probe.args, probe.cwd);
}

function formatCommand(probe: CommandProbe): string {
  return [probe.command, ...probe.args].join(" ");
}

function formatResolvedCommand(probe: CommandProbe): string {
  return [probe.resolvedCommand, ...probe.args].join(" ");
}

function stderrTail(result: CommandResult): string {
  const detail = result.stderr.trim() || result.error?.message?.trim() || "";
  return detail.split("\n").slice(-8).join("\n");
}

function failedProbeResult(opts: {
  name: string;
  label: string;
  probe: CommandProbe;
  result: CommandResult;
  installHint: string;
  runtimeHint: string;
  notInstalledMessage?: string;
}): DoctorResult {
  if (commandNotFound(opts.result)) {
    return {
      name: opts.name,
      status: "fail",
      message: opts.notInstalledMessage ?? `${opts.label} is not installed or not on PATH.`,
      hint: opts.installHint,
      probed: probeDetails(opts.probe),
    };
  }

  const exitCode = opts.result.status ?? "unknown";
  const detail = stderrTail(opts.result);
  return {
    name: opts.name,
    status: "fail",
    message: `${opts.label} is installed but the probe failed: ${formatResolvedCommand(
      opts.probe
    )} exited with code ${exitCode}${detail ? `; stderr: ${detail}` : "."}`,
    hint: opts.runtimeHint,
    probed: probeDetails(opts.probe),
  };
}

function probeDetails(...probes: CommandProbe[]): string[] {
  const commands = probes.map(formatCommand).join(", ");
  const searched = probes
    .flatMap((probe) => probe.pathEntries)
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
  const fallbacks = probes
    .flatMap((probe) => probe.fallbackCandidates)
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
  const env = probes[0]?.env ?? [];
  return [
    `commands tried: ${commands}`,
    `PATH searched: ${searched.length > 0 ? searched.join(delimiter) : "(empty)"}`,
    `fallback paths: ${fallbacks.length > 0 ? fallbacks.join(", ") : "(none)"}`,
    `env assumptions: ${env.join(", ")}`,
  ];
}

function readNodeRange(repoRoot: string, deps: QuickstartDoctorDeps): string | null {
  try {
    const packageJsonPath = join(repoRoot, "package.json");
    const parsed = JSON.parse(deps.readText(packageJsonPath)) as {
      engines?: { node?: unknown };
    };
    return typeof parsed?.engines?.node === "string" ? parsed.engines.node : null;
  } catch {
    return null;
  }
}

async function checkNode(repoRoot: string, deps: QuickstartDoctorDeps): Promise<DoctorResult> {
  const range = readNodeRange(repoRoot, deps);
  if (!range) {
    const packageJsonPath = join(repoRoot, "package.json");
    let hasValidPackageJson = false;
    try {
      const parsed = JSON.parse(deps.readText(packageJsonPath)) as unknown;
      hasValidPackageJson = typeof parsed === "object" && parsed !== null;
    } catch {
      hasValidPackageJson = false;
    }

    if (!hasValidPackageJson) {
      return {
        name: "node",
        status: "fail",
        message:
          "package.json is missing or unreadable, so quickstart cannot verify Node compatibility.",
        hint: "Ensure package.json exists and is valid JSON, then rerun pnpm start.",
      };
    }

    return {
      name: "node",
      status: "fail",
      message:
        "package.json does not declare engines.node, so quickstart cannot verify Node compatibility.",
      hint: "Add engines.node to package.json, then rerun pnpm start.",
    };
  }
  const probe = resolveCommand("node", ["--version"], deps);
  const result = runProbe(probe, deps);
  if (!commandSucceeded(result)) {
    return failedProbeResult({
      name: "node",
      label: "node",
      probe,
      result,
      installHint: REMEDIATION.node,
      runtimeHint: RUNTIME_REMEDIATION.node,
      notInstalledMessage: `node is not installed or not on PATH; required range is ${range}.`,
    });
  }
  const version = cleanVersion(result.stdout.trim() || result.stderr.trim());
  if (!version || !satisfiesVersionRange(version, range)) {
    return {
      name: "node",
      status: "fail",
      message: `node ${version ?? "version could not be parsed"} does not satisfy ${range}.`,
      hint: REMEDIATION.node,
      probed: probeDetails(probe),
    };
  }
  return { name: "node", status: "pass", message: `node ${version} satisfies ${range}.` };
}

function checkCommand(
  name: string,
  command: string,
  args: string[],
  hint: string
): (deps: QuickstartDoctorDeps) => DoctorResult {
  return (deps) => {
    const probe = resolveCommand(command, args, deps);
    const result = runProbe(probe, deps);
    if (!commandSucceeded(result)) {
      return failedProbeResult({
        name,
        label: command,
        probe,
        result,
        installHint: hint,
        runtimeHint:
          command === "pnpm"
            ? RUNTIME_REMEDIATION.pnpm
            : command === "git"
              ? RUNTIME_REMEDIATION.git
              : `Run ${formatCommand(probe)} directly and fix the reported runtime error.`,
        notInstalledMessage: `${command} is not installed or not on PATH.`,
      });
    }
    const version = (result.stdout.trim() || result.stderr.trim()).split("\n")[0];
    return {
      name,
      status: "pass",
      message: version ? `${command}: ${version}` : `${command} is present.`,
    };
  };
}

function checkFlutter(minVersion: string, deps: QuickstartDoctorDeps): DoctorResult {
  const flutterCwd = defaultFlutterDashboardDir();
  if (!deps.fileExists(flutterCwd)) {
    return {
      name: "flutter/fvm",
      status: "fail",
      message: `Flutter project directory is missing: ${flutterCwd}.`,
      hint: "Ensure the rusa repository is intact and includes packages/rusa/flutter_dashboard.",
      probed: [`flutter project path: ${flutterCwd}`],
    };
  }

  const fvmFallbacks = [homePath(deps, "fvm/bin/fvm")].filter((path): path is string => !!path);
  const fvmProbe: CommandProbe = {
    ...resolveCommand("fvm", ["--version"], deps, fvmFallbacks),
    cwd: flutterCwd,
  };
  const fvm = runProbe(fvmProbe, deps);
  if (commandSucceeded(fvm)) {
    const sdkProbe: CommandProbe = {
      ...fvmProbe,
      args: ["flutter", "--version"],
      cwd: flutterCwd,
    };
    const sdk = runProbe(sdkProbe, deps);
    const fvmVersion = (fvm.stdout.trim() || fvm.stderr.trim()).split("\n")[0];
    if (!commandSucceeded(sdk)) {
      const exitCode = sdk.status ?? "unknown";
      const detail = stderrTail(sdk);
      return {
        name: "flutter/fvm",
        status: "pass",
        message: `fvm${fvmVersion ? ` ${fvmVersion}` : ""} is installed; Flutter version is unresolvable in this directory because ${formatResolvedCommand(
          sdkProbe
        )} exited with code ${exitCode}${detail ? `; stderr: ${detail}` : "."}`,
        hint: RUNTIME_REMEDIATION.flutter,
        probed: probeDetails(fvmProbe, sdkProbe),
      };
    }
    const version = cleanVersion(sdk.stdout.trim() || sdk.stderr.trim());
    if (!version) {
      return {
        name: "flutter/fvm",
        status: "pass",
        message: `fvm${fvmVersion ? ` ${fvmVersion}` : ""} is installed; Flutter version could not be parsed from fvm flutter --version.`,
        hint: RUNTIME_REMEDIATION.flutter,
        probed: probeDetails(fvmProbe, sdkProbe),
      };
    }
    if (compareVersions(version, minVersion) < 0) {
      return {
        name: "flutter/fvm",
        status: "pass",
        message: `fvm${fvmVersion ? ` ${fvmVersion}` : ""} is installed; resolved Flutter ${version} is below required ${minVersion}.`,
        hint: RUNTIME_REMEDIATION.flutter,
        probed: probeDetails(fvmProbe, sdkProbe),
      };
    }
    return {
      name: "flutter/fvm",
      status: "pass",
      message: `fvm${fvmVersion ? ` ${fvmVersion}` : ""} is installed; resolved Flutter ${version} is available.`,
    };
  }
  if (!commandNotFound(fvm)) {
    return failedProbeResult({
      name: "flutter/fvm",
      label: "fvm",
      probe: fvmProbe,
      result: fvm,
      installHint: REMEDIATION.flutter,
      runtimeHint: RUNTIME_REMEDIATION.flutter,
    });
  }
  const flutterProbe: CommandProbe = {
    ...resolveCommand("flutter", ["--version"], deps),
    cwd: flutterCwd,
  };
  const flutter = runProbe(flutterProbe, deps);
  if (!commandSucceeded(flutter)) {
    if (!commandNotFound(flutter)) {
      return failedProbeResult({
        name: "flutter/fvm",
        label: "flutter",
        probe: flutterProbe,
        result: flutter,
        installHint: REMEDIATION.flutter,
        runtimeHint: RUNTIME_REMEDIATION.flutter,
      });
    }
    return {
      name: "flutter/fvm",
      status: "fail",
      message: "Neither fvm nor flutter is installed or on PATH.",
      hint: REMEDIATION.flutter,
      probed: probeDetails(fvmProbe, flutterProbe),
    };
  }
  const version = cleanVersion(flutter.stdout.trim() || flutter.stderr.trim());
  if (!version || compareVersions(version, minVersion) < 0) {
    return {
      name: "flutter/fvm",
      status: "fail",
      message: `Flutter ${version ?? "version could not be parsed"} is below required ${minVersion}.`,
      hint: REMEDIATION.flutter,
      probed: probeDetails(flutterProbe),
    };
  }
  return {
    name: "flutter/fvm",
    status: "pass",
    message: `flutter ${version} is available.`,
  };
}

function checkDockerDaemon(deps: QuickstartDoctorDeps): DoctorResult {
  const probe = resolveCommand("docker", ["info"], deps);
  const result = runProbe(probe, deps);
  if (!commandSucceeded(result)) {
    return failedProbeResult({
      name: "docker daemon",
      label: "docker",
      probe,
      result,
      installHint: REMEDIATION.docker,
      runtimeHint: RUNTIME_REMEDIATION.docker,
      notInstalledMessage: "docker is not installed or not on PATH.",
    });
  }
  return { name: "docker daemon", status: "pass", message: "docker info reached the daemon." };
}

function checkDockerCompose(deps: QuickstartDoctorDeps): DoctorResult {
  const probe = resolveCommand("docker", ["compose", "version"], deps);
  const result = runProbe(probe, deps);
  if (!commandSucceeded(result)) {
    return failedProbeResult({
      name: "docker compose",
      label: "docker compose",
      probe,
      result,
      installHint: REMEDIATION.compose,
      runtimeHint: RUNTIME_REMEDIATION.compose,
      notInstalledMessage: "docker compose plugin is not installed or not on PATH.",
    });
  }
  const version = (result.stdout.trim() || result.stderr.trim()).split("\n")[0];
  return {
    name: "docker compose",
    status: "pass",
    message: version ? version : "docker compose plugin is available.",
  };
}

function checkArch(deps: QuickstartDoctorDeps): DoctorResult {
  const arch = deps.arch();
  const normalized = arch === "x64" ? "amd64" : arch;
  return {
    name: "arch",
    status: "info",
    message: `host architecture: ${normalized}.`,
  };
}

function checkFreeDisk(
  targetPath: string,
  minBytes: number,
  deps: QuickstartDoctorDeps
): DoctorResult {
  const probePath = deps.fileExists(targetPath) ? targetPath : deps.cwd;
  const free = deps.freeBytes(probePath);
  if (free < minBytes) {
    return {
      name: "free disk",
      status: "fail",
      message: `${formatBytes(free)} free on ${probePath}; quickstart requires at least ${formatBytes(minBytes)}.`,
      hint: REMEDIATION.disk,
      probed: [
        `target path: ${targetPath}`,
        `statfs path: ${probePath}`,
        `minimum free bytes: ${minBytes}`,
      ],
    };
  }
  return {
    name: "free disk",
    status: "pass",
    message: `${formatBytes(free)} free on ${probePath}.`,
  };
}

async function checkLoopbackPorts(
  ports: number[],
  deps: QuickstartDoctorDeps
): Promise<DoctorResult> {
  const busy: number[] = [];
  for (const port of ports) {
    if (!(await deps.isPortAvailable(port))) busy.push(port);
  }
  if (busy.length > 0) {
    return {
      name: "loopback ports",
      status: "fail",
      message: `localhost port(s) already in use: ${busy.join(", ")}.`,
      hint: REMEDIATION.ports,
      probed: [`loopback host: 127.0.0.1`, `ports checked: ${ports.join(", ")}`],
    };
  }
  return {
    name: "loopback ports",
    status: "pass",
    message: `localhost port(s) available: ${ports.join(", ")}.`,
  };
}

export function checkProviderEnvKeys(
  env: NodeJS.ProcessEnv,
  providerEnvKeys: readonly string[] = QUICKSTART_PROVIDER_ENV_KEYS
): DoctorResult {
  const exported = providerEnvKeys.filter((key) => env[key]);
  if (exported.length === 0) {
    return {
      name: "provider API key environment",
      status: "pass",
      message: "no exported provider API keys detected.",
    };
  }
  return {
    name: "provider API key environment",
    status: "warn",
    message: `exported provider API key(s) can override subscription auth: ${exported.join(", ")}.`,
    hint: REMEDIATION.env,
    probed: [`environment keys checked: ${providerEnvKeys.join(", ")}`],
  };
}

export async function runQuickstartDoctor(
  options: QuickstartDoctorOptions = {}
): Promise<DoctorResult[]> {
  const deps = buildDeps(options.deps);
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const targetPath = options.targetPath ?? repoRoot;
  const minFlutterVersion = options.minFlutterVersion ?? QUICKSTART_MIN_FLUTTER_VERSION;
  const minFreeDiskBytes = options.minFreeDiskBytes ?? QUICKSTART_MIN_FREE_DISK_BYTES;
  const ports = options.ports ?? [];
  const providerEnvKeys = options.providerEnvKeys ?? QUICKSTART_PROVIDER_ENV_KEYS;
  const checks = buildQuickstartDoctorChecks({
    deps,
    repoRoot,
    targetPath,
    minFlutterVersion,
    minFreeDiskBytes,
    ports,
    providerEnvKeys,
  });

  const results: DoctorResult[] = [];
  for (const check of checks) {
    try {
      results.push(await check.run());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        name: check.id,
        status: "fail",
        message: `check threw an unexpected error: ${message}`,
      });
    }
  }
  return results;
}

export function formatDoctorResults(results: readonly DoctorResult[]): string {
  const label: Record<DoctorStatus, string> = {
    pass: "PASS",
    fail: "FAIL",
    warn: "WARN",
    info: "INFO",
  };
  const lines = ["[quickstart] Preflight doctor:"];
  for (const result of results) {
    lines.push(`  ${label[result.status]} ${result.name}: ${result.message}`);
    if (result.probed?.length) {
      lines.push("       Probed:");
      for (const detail of result.probed) lines.push(`         - ${detail}`);
    }
    if (result.hint) lines.push(`       Fix: ${result.hint}`);
  }
  return lines.join("\n");
}

export async function assertQuickstartDoctor(
  options: QuickstartDoctorOptions = {}
): Promise<DoctorResult[]> {
  const results = await runQuickstartDoctor(options);
  console.log(formatDoctorResults(results));
  if (results.some((result) => result.status === "fail")) {
    throw new Error(
      "quickstart preflight failed; fix the failed checks above and rerun pnpm start"
    );
  }
  return results;
}
