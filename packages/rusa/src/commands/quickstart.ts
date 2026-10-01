import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { input, password } from "@inquirer/prompts";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { generateRandomRootHandle } from "../actor/handle-generator.js";
import { GEMINI_API_KEY_SECRET_FILENAME, writeHostSecret } from "../config/secrets.js";
import type { RusaConfig } from "../config/types.js";
import { seedBareRepoFromLocalPath } from "../gitops/worktree.js";
import { formatDoctorResults, runQuickstartDoctor } from "./quickstart-doctor.js";

export const QUICKSTART_DASHBOARD_PORT = 8080;
export const QUICKSTART_GIT_BRIDGE_PORT = 8085;
const QUICKSTART_WEBHOOK_PORT = 9742;
const LOCAL_REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface ProviderLoginCommand {
  cliCommand: string;
  loginArgs: string[];
  statusArgs: string[];
}

/**
 * Vendor-owned interactive login and verification commands. These run with the
 * real terminal attached; quickstart deliberately never inspects their output.
 */
export const PROVIDER_LOGIN_COMMANDS: Record<string, ProviderLoginCommand> = {
  claude: {
    cliCommand: "claude",
    loginArgs: ["auth", "login"],
    statusArgs: ["auth", "status"],
  },
  codex: {
    cliCommand: "codex",
    loginArgs: ["login", "--device-auth"],
    statusArgs: ["login", "status"],
  },
  antigravity: {
    cliCommand: "agy",
    loginArgs: [],
    statusArgs: ["-p", "ping", "--dangerously-skip-permissions"],
  },
};

/** CLI command used for each provider's generated quickstart configuration. */
export const PROVIDER_CLI_COMMANDS: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy",
  kimi: "kimi",
};

const QUICKSTART_ROOT_MODELS: Record<string, string> = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.6-sol",
  antigravity: "Gemini 3.7 Flash",
  kimi: "kimi-for-coding",
};

const UNSUPPORTED_QUICKSTART_LOGIN_PROVIDERS = new Set(["kimi"]);

export interface LocalRepoValidation {
  valid: boolean;
  repoName?: string;
  repoKey?: string;
  resolvedPath?: string;
  branch?: string;
  error?: string;
}

export type GitCommandExecutor = (args: string[]) => {
  status: number | null;
  stdout?: string;
  stderr?: string;
};

export function validateLocalGitRepo(
  repoPath: string,
  executeGit: GitCommandExecutor = (args) =>
    spawnSync("git", args, { encoding: "utf8", stdio: "pipe" })
): LocalRepoValidation {
  const trimmed = repoPath.trim();
  if (!trimmed) {
    return { valid: false, error: "Repository path cannot be empty." };
  }
  const resolvedPath = resolve(trimmed);
  if (!existsSync(resolvedPath)) {
    return { valid: false, error: `Path does not exist: ${resolvedPath}` };
  }
  try {
    const stat = statSync(resolvedPath);
    if (!stat.isDirectory()) {
      return { valid: false, error: `Path is not a directory: ${resolvedPath}` };
    }
  } catch {
    return { valid: false, error: `Cannot access path: ${resolvedPath}` };
  }

  const insideWorkTree = executeGit(["-C", resolvedPath, "rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree.status !== 0 || insideWorkTree.stdout?.trim() !== "true") {
    return {
      valid: false,
      error: `Not a git repository: ${resolvedPath}. Run "git init" first.`,
    };
  }

  const headCheck = executeGit(["-C", resolvedPath, "rev-parse", "--verify", "HEAD"]);
  if (headCheck.status !== 0) {
    return {
      valid: false,
      error: `Git repository has no commits: ${resolvedPath}. Create an initial commit before running quickstart.`,
    };
  }

  const branchCheck = executeGit(["-C", resolvedPath, "symbolic-ref", "--short", "-q", "HEAD"]);
  const branch = branchCheck.status === 0 ? branchCheck.stdout?.trim() : "";
  if (!branch) {
    return {
      valid: false,
      error: `HEAD is detached in ${resolvedPath}. Check out the branch Rusa should work from.`,
    };
  }

  // The name becomes the `local/<name>` key in github.repos and a path segment of
  // the bridge URL, so it must pass the config loader's repo pattern and route
  // through the bridge without percent-encoding.
  const repoName = basename(resolvedPath);
  if (!LOCAL_REPO_NAME_PATTERN.test(repoName)) {
    return {
      valid: false,
      error: `Repository directory name "${repoName}" can only contain letters, digits, ".", "_" and "-": ${resolvedPath}`,
    };
  }

  return {
    valid: true,
    repoName,
    repoKey: `local/${repoName}`,
    resolvedPath,
    branch,
  };
}

export function updateQuickstartRepoConfig(config: RusaConfig, repoKey: string): RusaConfig {
  const currentRepos = config.github?.repos ?? [];
  if (currentRepos.includes(repoKey)) return config;
  return {
    ...config,
    github: {
      ...config.github,
      repos: [...currentRepos, repoKey],
    },
  };
}

export function bridgeRemoteUrl(repoKey: string): string {
  return `http://localhost:${QUICKSTART_GIT_BRIDGE_PORT}/${repoKey}.git`;
}

export function printFallbackCommands(repoPath: string, remoteUrl: string): void {
  const git = `git -C ${shellQuote(repoPath)}`;
  const url = shellQuote(remoteUrl);
  console.log(`[quickstart] You can add the remote yourself:`);
  console.log(`  ${git} remote set-url rusa ${url} || ${git} remote add rusa ${url}`);
}

// Points the host repo's `rusa` remote at the bridge so agent mc/* branches can
// be fetched. The base branch is already seeded; nothing is pushed.
export function configureBridgeRemote(
  repoPath: string,
  repoKey: string,
  executeGit: GitCommandExecutor
): boolean {
  const remoteUrl = bridgeRemoteUrl(repoKey);
  const getUrl = executeGit(["-C", repoPath, "remote", "get-url", "rusa"]);
  const exists = getUrl.status === 0;
  const previousUrl = exists ? getUrl.stdout?.trim() : undefined;
  const res = executeGit(["-C", repoPath, "remote", exists ? "set-url" : "add", "rusa", remoteUrl]);
  if (res.status !== 0) {
    console.warn(
      `[quickstart] Could not set git remote "rusa": ${res.stderr?.trim() || "git remote failed"}`
    );
    printFallbackCommands(repoPath, remoteUrl);
    return false;
  }
  if (previousUrl && previousUrl !== remoteUrl) {
    console.log(
      `[quickstart] Remote "rusa" in ${repoPath} updated: was ${previousUrl}, now points at ${remoteUrl}`
    );
  } else {
    console.log(`[quickstart] Remote "rusa" in ${repoPath} now points at ${remoteUrl}`);
  }
  return true;
}

// Bundles the host branch so the setup container can seed the bridge from it;
// the host repo itself is never mounted into a container.
export function createSeedBundle(
  repoPath: string,
  branch: string,
  outDir: string,
  executeGit: GitCommandExecutor = (args) =>
    spawnSync("git", args, { encoding: "utf8", stdio: "pipe" })
): string {
  const bundlePath = join(outDir, "seed.bundle");
  const res = executeGit(["-C", repoPath, "bundle", "create", bundlePath, `refs/heads/${branch}`]);
  if (res.status !== 0) {
    throw new Error(`git bundle of ${branch} failed: ${res.stderr?.trim() || "unknown error"}`);
  }
  return bundlePath;
}

export interface QuickstartSeedOptions {
  home?: string;
  repo: string;
  bundle: string;
  branch: string;
}

// In-container half of seeding: writes the bundled branch into the bridge repo.
export function runQuickstartSeed(opts: QuickstartSeedOptions): void {
  seedBareRepoFromLocalPath({
    mcHome: resolveHomeOverride(opts.home),
    repoId: opts.repo,
    localPath: resolve(opts.bundle),
    branch: opts.branch,
  });
  console.log(`[quickstart] Seeded ${opts.repo} at ${opts.branch}`);
}

export interface QuickstartOptions {
  image?: string;
  container?: string;
  volume?: string;
  skipBuild?: boolean;
  reconfigure?: boolean;
  localRepo?: string;
  promptLocalRepo?: () => Promise<string>;
  executeGit?: GitCommandExecutor;
}

export interface DockerRunArgsOptions {
  image: string;
  container: string;
  volume: string;
}

export function buildAppDockerRunArgs(opts: DockerRunArgsOptions): string[] {
  return [
    "run",
    "-d",
    "--init",
    "--name",
    opts.container,
    "-v",
    // Login CLIs write below $HOME. Mounting all of /home/node (rather than
    // only RUSA_HOME) preserves that state for the app container.
    `${opts.volume}:/home/node`,
    "-p",
    `127.0.0.1:${QUICKSTART_DASHBOARD_PORT}:${QUICKSTART_DASHBOARD_PORT}`,
    "-p",
    `127.0.0.1:${QUICKSTART_GIT_BRIDGE_PORT}:${QUICKSTART_GIT_BRIDGE_PORT}`,
    opts.image,
  ];
}

export function buildSetupDockerRunArgs(opts: DockerRunArgsOptions): string[] {
  return [
    "run",
    "-d",
    "--init",
    "--name",
    opts.container,
    "-v",
    `${opts.volume}:/home/node`,
    "-p",
    `127.0.0.1:${QUICKSTART_DASHBOARD_PORT}:${QUICKSTART_DASHBOARD_PORT}`,
    "-p",
    `127.0.0.1:${QUICKSTART_GIT_BRIDGE_PORT}:${QUICKSTART_GIT_BRIDGE_PORT}`,
    "--entrypoint",
    "sleep",
    opts.image,
    "infinity",
  ];
}

function runDocker(
  args: string[],
  opts?: {
    inherit?: boolean;
    allowFailure?: boolean;
    env?: Record<string, string>;
  }
): void {
  const result = spawnSync("docker", args, {
    stdio: opts?.inherit ? "inherit" : "pipe",
    encoding: "utf8",
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
  });
  if (result?.status !== 0 && !opts?.allowFailure) {
    const stderr = result?.stderr?.trim();
    throw new Error(`docker ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildQuickstartImage(image: string): void {
  runDocker(["build", "-t", image, "."], {
    inherit: true,
    env: { DOCKER_BUILDKIT: "1" },
  });
}

const VOLUME_CONFIG_PATH = "/home/node/.rusa/config.yaml";

// Adds the repo key to the volume's config.yaml through the setup container.
// Any failure throws: the bridge serves only listed repos, so continuing would
// leave the host pointed at a repo the app never admits.
function registerLocalRepo(setupContainer: string, repoKey: string): void {
  function fail(reason: string): never {
    const message = `Could not register ${repoKey} in ${VOLUME_CONFIG_PATH}: ${reason}`;
    console.error(`[quickstart] ${message}`);
    throw new Error(message);
  }
  const catRes = spawnSync("docker", ["exec", setupContainer, "cat", VOLUME_CONFIG_PATH], {
    encoding: "utf8",
  });
  if (catRes.status !== 0 || !catRes.stdout?.trim()) {
    fail(catRes.stderr?.trim() || "config.yaml is missing or empty");
  }
  let config: RusaConfig;
  try {
    config = parseYaml(catRes.stdout) as RusaConfig;
  } catch (err) {
    fail(`config.yaml did not parse: ${err instanceof Error ? err.message : err}`);
  }
  const writeRes = spawnSync(
    "docker",
    ["exec", "-i", setupContainer, "sh", "-c", `cat > ${VOLUME_CONFIG_PATH}`],
    { input: toYaml(updateQuickstartRepoConfig(config, repoKey)), encoding: "utf8" }
  );
  if (writeRes.status !== 0) {
    fail(writeRes.stderr?.trim() || "write failed");
  }
  console.log(`[quickstart] Registered ${repoKey} in volume config.yaml`);
}

const SETUP_BUNDLE_PATH = "/tmp/rusa-seed.bundle";

// Seeds the bridge repo before the app starts. Any failure throws, so the app
// never comes up serving a repo without its base branch.
function seedLocalRepo(
  setupContainer: string,
  repo: Required<Pick<LocalRepoValidation, "repoKey" | "resolvedPath" | "branch">>,
  executeGit: GitCommandExecutor
): void {
  const dir = mkdtempSync(join(tmpdir(), "rusa-quickstart-"));
  try {
    const bundle = createSeedBundle(repo.resolvedPath, repo.branch, dir, executeGit);
    runDocker(["cp", bundle, `${setupContainer}:${SETUP_BUNDLE_PATH}`]);
    runDocker([
      "exec",
      setupContainer,
      "rusa",
      "quickstart",
      "seed",
      "--repo-key",
      repo.repoKey,
      "--bundle",
      SETUP_BUNDLE_PATH,
      "--branch",
      repo.branch,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`[quickstart] Seeded ${repo.repoKey} from ${repo.branch} at ${repo.resolvedPath}`);
}

export async function runQuickstart(opts: QuickstartOptions = {}): Promise<void> {
  const image = opts.image ?? "rusa:quickstart";
  const container = opts.container ?? "rusa-quickstart";
  const setupContainer = `${container}-setup`;
  const volume = opts.volume ?? "rusa-quickstart-home";
  const executeGit =
    opts.executeGit ?? ((args) => spawnSync("git", args, { encoding: "utf8", stdio: "pipe" }));

  console.log("\nRusa quickstart\n");
  const doctorResults = await runQuickstartDoctor({
    ports: [QUICKSTART_DASHBOARD_PORT, QUICKSTART_GIT_BRIDGE_PORT],
  });
  console.log(formatDoctorResults(doctorResults));
  if (doctorResults.some((result) => result.status === "fail")) {
    console.error(
      "[quickstart] Preflight failed; fix the failed checks above and rerun pnpm start."
    );
    process.exitCode = 1;
    return;
  }

  let localRepoValidation: LocalRepoValidation | null = null;
  if (opts.localRepo?.trim()) {
    const validation = validateLocalGitRepo(opts.localRepo, executeGit);
    if (!validation.valid) {
      console.error(`[quickstart] Invalid repository path: ${validation.error}`);
      throw new Error(validation.error);
    }
    localRepoValidation = validation;
    console.log(`[quickstart] Local repository selected: ${validation.resolvedPath}`);
  }

  runDocker(["rm", "-f", setupContainer], { allowFailure: true });
  runDocker(["rm", "-f", container], { allowFailure: true });

  if (!opts.skipBuild) {
    console.log(`[quickstart] Building local Docker image ${image}...`);
    buildQuickstartImage(image);
  }

  runDocker(["volume", "create", volume]);

  console.log("[quickstart] Starting temporary setup container...");
  runDocker(buildSetupDockerRunArgs({ image, container: setupContainer, volume }));

  const checkConfigRes = spawnSync("docker", [
    "exec",
    setupContainer,
    "test",
    "-f",
    VOLUME_CONFIG_PATH,
  ]);
  const hasExistingConfig = checkConfigRes.status === 0;

  if (hasExistingConfig && !opts.reconfigure) {
    console.log("\n[quickstart] Existing configuration found in container volume.");
    console.log(
      "[quickstart] Skipping interactive configuration wizard. (Pass --reconfigure to update settings).\n"
    );
  } else {
    if (opts.localRepo === undefined) {
      let repoPathInput = "";
      if (opts.promptLocalRepo) {
        repoPathInput = (await opts.promptLocalRepo()).trim();
      } else {
        repoPathInput = (
          await input({
            message:
              "Target local git repository path (optional — leave blank to skip; re-run configure later to select one):",
            validate: (val) => {
              const trimmed = val.trim();
              if (!trimmed) return true;
              const res = validateLocalGitRepo(trimmed, executeGit);
              return res.valid ? true : (res.error ?? "Invalid git repository");
            },
          })
        ).trim();
      }

      if (repoPathInput) {
        const validation = validateLocalGitRepo(repoPathInput, executeGit);
        if (!validation.valid) {
          console.error(`[quickstart] Invalid repository path: ${validation.error}`);
          throw new Error(validation.error);
        }
        localRepoValidation = validation;
        console.log(`[quickstart] Local repository selected: ${validation.resolvedPath}`);
      }
    }

    const ttyFlags = process.stdin.isTTY ? ["-it"] : ["-i"];
    const configureArgs = ["exec", ...ttyFlags, setupContainer, "rusa", "quickstart", "configure"];
    console.log(`\n[quickstart] Running: docker ${configureArgs.map(shellQuote).join(" ")}\n`);

    try {
      runDocker(configureArgs, { inherit: true });
    } catch (err) {
      console.error(
        `\n[quickstart] Configuration failed: ${err instanceof Error ? err.message : err}`
      );
      console.error(
        `[quickstart] You can retry with: docker exec -it ${setupContainer} rusa quickstart configure`
      );
      throw err;
    }
  }

  const localRepo =
    localRepoValidation?.repoKey && localRepoValidation.resolvedPath && localRepoValidation.branch
      ? {
          repoKey: localRepoValidation.repoKey,
          resolvedPath: localRepoValidation.resolvedPath,
          branch: localRepoValidation.branch,
        }
      : null;
  if (localRepo) {
    registerLocalRepo(setupContainer, localRepo.repoKey);
    seedLocalRepo(setupContainer, localRepo, executeGit);
  }

  console.log("\n[quickstart] Replacing setup container with the app container...");
  runDocker(["rm", "-f", setupContainer], { allowFailure: true });
  runDocker(buildAppDockerRunArgs({ image, container, volume }));

  console.log(`\nDashboard: http://localhost:${QUICKSTART_DASHBOARD_PORT}\n`);

  if (localRepo) {
    configureBridgeRemote(localRepo.resolvedPath, localRepo.repoKey, executeGit);
  }
}

function resolveHomeOverride(home?: string): string {
  return home ?? process.env.RUSA_HOME ?? join(homedir(), ".rusa");
}

export function enabledProviders(raw: string): string[] {
  const providers = [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
  if (providers.length === 0) throw new Error("Choose at least one provider.");
  for (const provider of providers) {
    if (PROVIDER_CLI_COMMANDS[provider]) continue;
    throw new Error(
      `Unsupported provider "${provider}". Use one of: ${Object.keys(PROVIDER_CLI_COMMANDS).join(
        ", "
      )}.`
    );
  }
  return providers;
}

export type ProviderCommandExecutor = (command: string, args: string[]) => number | null;

export interface ProviderVerificationResult {
  provider: string;
  outcome: "pass" | "fail";
  exitCode: number | null;
}

export type ProviderVerificationLogger = (result: ProviderVerificationResult) => void;

function executeProviderCommand(command: string, args: string[]): number | null {
  return spawnSync(command, args, { stdio: "inherit" }).status;
}

/** Run and verify every enabled provider before allowing quickstart to continue. */
export function runProviderLogins(
  providers: string[],
  execute: ProviderCommandExecutor = executeProviderCommand,
  logVerification: ProviderVerificationLogger = (result) => {
    console.log(
      `[quickstart] provider_verification provider=${result.provider} outcome=${result.outcome} exit_code=${result.exitCode}`
    );
  }
): void {
  for (const provider of providers) {
    const spec = PROVIDER_LOGIN_COMMANDS[provider];
    if (!spec) {
      if (UNSUPPORTED_QUICKSTART_LOGIN_PROVIDERS.has(provider)) {
        console.log(
          `[quickstart] Quickstart login for ${provider} isn't supported yet (tracked in ISSUE_NUM); complete auth via the vendor's own CLI.`
        );
        continue;
      }
      throw new Error(`No quickstart login configuration found for provider "${provider}".`);
    }
    console.log(`\n[quickstart] Sign in to ${provider} using its official CLI.`);
    if (provider === "antigravity") {
      console.log(
        "[quickstart] Note: After completing sign-in, exit the session (Ctrl+D Ctrl+D or /exit) to proceed."
      );
    }
    const loginExitCode = execute(spec.cliCommand, spec.loginArgs);
    if (loginExitCode !== 0) {
      logVerification({ provider, outcome: "fail", exitCode: loginExitCode });
      throw new Error(`${provider} login did not complete. Resolve it and retry quickstart.`);
    }
    console.log(`[quickstart] Verifying ${provider} login...`);
    const statusExitCode = execute(spec.cliCommand, spec.statusArgs);
    logVerification({
      provider,
      outcome: statusExitCode === 0 ? "pass" : "fail",
      exitCode: statusExitCode,
    });
    if (statusExitCode !== 0) {
      throw new Error(`${provider} login could not be verified. Resolve it and retry quickstart.`);
    }
  }
}

export function readExistingRepos(configPath: string): string[] {
  if (!existsSync(configPath)) return [];
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Could not read existing configuration at ${configPath}: ${err instanceof Error ? err.message : err}`
    );
  }
  const repos = (parsed as RusaConfig | null)?.github?.repos;
  return Array.isArray(repos) ? repos.filter((repo) => typeof repo === "string") : [];
}

export interface QuickstartConfigureOptions {
  home?: string;
  executeProviderCommand?: ProviderCommandExecutor;
}

export async function runQuickstartConfigure(opts: QuickstartConfigureOptions = {}): Promise<void> {
  const mcHome = resolveHomeOverride(opts.home);
  const configPath = join(mcHome, "config.yaml");
  const existingRepos = readExistingRepos(configPath);

  console.log("\nRusa quickstart configuration\n");
  console.log("This writes configuration inside the container.\n");

  const providers = enabledProviders(
    await input({
      message: "Enabled coding providers (comma-separated: codex, claude, antigravity, kimi):",
      default: "codex",
    })
  );

  mkdirSync(mcHome, { recursive: true, mode: 0o700 });
  mkdirSync(join(mcHome, "repos"), { recursive: true });
  mkdirSync(join(mcHome, "data"), { recursive: true });
  mkdirSync(join(mcHome, "logs"), { recursive: true });

  console.log("Each enabled provider will open its official interactive login in this terminal.");
  const verificationLogPath = join(mcHome, "logs", "quickstart-provider-login.jsonl");
  runProviderLogins(providers, opts.executeProviderCommand, (result) => {
    // This records only quickstart's result, never vendor output or credentials.
    appendFileSync(
      verificationLogPath,
      `${JSON.stringify({ event: "quickstart.provider_verification", ...result })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    chmodSync(verificationLogPath, 0o600);
    console.log(
      `[quickstart] provider_verification provider=${result.provider} outcome=${result.outcome} exit_code=${result.exitCode}`
    );
  });

  const defaultGeminiKey = process.env.RUSA_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";
  const geminiApiKey = await password({
    message:
      "Gemini API key (required — used for background tasks such as one-off text classifications and avatar generation):",
    ...(defaultGeminiKey ? { default: defaultGeminiKey } : {}),
    validate: (val) => (val.trim() ? true : "Gemini API key is required"),
  });

  writeHostSecret(GEMINI_API_KEY_SECRET_FILENAME, geminiApiKey.trim(), mcHome);

  const suggestedRootHandle = generateRandomRootHandle();
  const rootHandleAnswer = await input({
    message: `Root entity handle/name (leave blank for suggested: "${suggestedRootHandle}"):`,
    default: suggestedRootHandle,
  });
  const rootHandle = rootHandleAnswer.trim() || suggestedRootHandle;
  const rootProvider = providers[0];
  const rootModel = (
    await input({
      message: `Exact root model pin for ${rootProvider}:`,
      default: QUICKSTART_ROOT_MODELS[rootProvider],
      validate: (value) => (value.trim() ? true : "Root model is required"),
    })
  ).trim();

  // Quickstart is meant to run against a local repository through the Git
  // bridge; nothing here subscribes to GitHub. The webhook stanza below is the
  // only GitHub ingestion edge, and it stays idle until an operator adds
  // `github.repos` and points a reachable webhook at it (docs/quickstart.md).
  // A reconfigure keeps the repositories an earlier run or the operator added.
  const config: RusaConfig = {
    profile: "quickstart",
    github: existingRepos.length > 0 ? { repos: existingRepos } : {},
    providers: Object.fromEntries(
      providers.map((provider) => [provider, { cliCommand: PROVIDER_CLI_COMMANDS[provider] }])
    ),
    rootActor: {
      provider: rootProvider,
      model: rootModel,
      handle: rootHandle,
      ...(rootProvider === "antigravity" ? { effort: "high" } : {}),
    },
    webhook: {
      port: QUICKSTART_WEBHOOK_PORT,
      secret: randomBytes(32).toString("hex"),
    },
    dashboard: {
      port: QUICKSTART_DASHBOARD_PORT,
    },
  };

  writeFileSync(configPath, toYaml(config), { encoding: "utf8", mode: 0o600 });
  chmodSync(configPath, 0o600);

  console.log(`\nConfig written to ${configPath}`);
  console.log("Provider login state is stored in the quickstart volume for the app container.");
  console.log(`\nDashboard: http://localhost:${QUICKSTART_DASHBOARD_PORT}`);
  console.log();
}
