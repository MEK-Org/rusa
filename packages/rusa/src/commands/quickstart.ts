import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { input, password } from "@inquirer/prompts";
import { stringify as toYaml } from "yaml";
import { generateRandomRootHandle } from "../actor/handle-generator.js";
import { GEMINI_API_KEY_SECRET_FILENAME, writeHostSecret } from "../config/secrets.js";
import type { RusaConfig } from "../config/types.js";
import { formatDoctorResults, runQuickstartDoctor } from "./quickstart-doctor.js";

export const QUICKSTART_DASHBOARD_PORT = 8080;
export const QUICKSTART_GIT_BRIDGE_PORT = 8085;
const QUICKSTART_WEBHOOK_PORT = 9742;

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

const UNSUPPORTED_QUICKSTART_LOGIN_PROVIDERS = new Set(["kimi"]);

export interface QuickstartOptions {
  image?: string;
  container?: string;
  volume?: string;
  skipBuild?: boolean;
  reconfigure?: boolean;
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

export async function runQuickstart(opts: QuickstartOptions = {}): Promise<void> {
  const image = opts.image ?? "rusa:quickstart";
  const container = opts.container ?? "rusa-quickstart";
  const setupContainer = `${container}-setup`;
  const volume = opts.volume ?? "rusa-quickstart-home";

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
    "/home/node/.rusa/config.yaml",
  ]);
  const hasExistingConfig = checkConfigRes.status === 0;

  if (hasExistingConfig && !opts.reconfigure) {
    console.log("\n[quickstart] Existing configuration found in container volume.");
    console.log(
      "[quickstart] Skipping interactive configuration wizard. (Pass --reconfigure to update settings).\n"
    );
  } else {
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

  console.log("\n[quickstart] Replacing setup container with the app container...");
  runDocker(["rm", "-f", setupContainer], { allowFailure: true });
  runDocker(buildAppDockerRunArgs({ image, container, volume }));

  console.log(`\nDashboard: http://localhost:${QUICKSTART_DASHBOARD_PORT}\n`);
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

export interface QuickstartConfigureOptions {
  home?: string;
  executeProviderCommand?: ProviderCommandExecutor;
}

export async function runQuickstartConfigure(opts: QuickstartConfigureOptions = {}): Promise<void> {
  const mcHome = resolveHomeOverride(opts.home);
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

  const localRepoPathAnswer = await input({
    message:
      "Target local git repository path (optional — leave blank to skip; re-run configure later to select one):",
  });
  const localRepoPath = localRepoPathAnswer.trim();
  if (localRepoPath) {
    // TODO(#69): copy the selected host repository into the container volume and expose it through
    // the local Git bridge. The configure command runs inside the setup container, so it cannot
    // complete that host-to-container handoff by itself.
    console.log(`[quickstart] Local repository selected: ${resolve(localRepoPath)}`);
  }

  const suggestedRootHandle = generateRandomRootHandle();
  const rootHandleAnswer = await input({
    message: `Root entity handle/name (leave blank for suggested: "${suggestedRootHandle}"):`,
    default: suggestedRootHandle,
  });
  const rootHandle = rootHandleAnswer.trim() || suggestedRootHandle;

  const config: RusaConfig = {
    profile: "quickstart",
    github: {
      pollIntervalSeconds: 30,
      ingestionMode: "poll",
    },
    providers: Object.fromEntries(
      providers.map((provider) => [provider, { cliCommand: PROVIDER_CLI_COMMANDS[provider] }])
    ),
    rootActor: {
      provider: providers[0],
      handle: rootHandle,
      ...(providers[0] === "antigravity" ? { effort: "high" } : {}),
    },
    webhook: {
      port: QUICKSTART_WEBHOOK_PORT,
      secret: randomBytes(32).toString("hex"),
    },
    dashboard: {
      port: QUICKSTART_DASHBOARD_PORT,
    },
  };

  const configPath = join(mcHome, "config.yaml");
  writeFileSync(configPath, toYaml(config), { encoding: "utf8", mode: 0o600 });
  chmodSync(configPath, 0o600);

  console.log(`\nConfig written to ${configPath}`);
  console.log("Provider login state is stored in the quickstart volume for the app container.");
  console.log(`\nDashboard: http://localhost:${QUICKSTART_DASHBOARD_PORT}`);
  console.log();
}
