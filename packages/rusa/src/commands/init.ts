import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { confirm, input, password } from "@inquirer/prompts";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { GLASS_GOALS_PASSWORD_SECRET_FILENAME, writeHostSecret } from "../config/secrets.js";
import type { RusaConfig } from "../config/types.js";
import { initDb } from "../db/index.js";

export interface InitOptions {
  nonInteractive?: boolean;
  /** Optional config file path (YAML or JSON) to use in non-interactive mode. */
  configPath?: string;
  /** Use safe defaults in non-interactive mode when no config is provided. */
  defaults?: boolean;
  /** Override rusa home directory. */
  home?: string;
}

/**
 * Try to load an existing config file. Returns null if not found.
 */
function loadExistingConfig(mcHome: string): RusaConfig | null {
  const configPath = join(mcHome, "config.yaml");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    return parseYaml(raw) as RusaConfig;
  } catch {
    return null;
  }
}

function resolveHomeOverride(opts?: InitOptions): string {
  return opts?.home ?? process.env.RUSA_HOME ?? join(homedir(), ".rusa");
}

function normalizeConfig(config: RusaConfig): RusaConfig {
  const dashboard = config.dashboard
    ? {
        ...config.dashboard,
        quotaProviders: {
          claude: { primaryWindow: "weekly" },
          codex: { primaryWindow: "weekly" },
          agy: { primaryWindow: "weekly" },
          ...config.dashboard.quotaProviders,
        },
      }
    : config.dashboard;
  return { ...config, ...(dashboard ? { dashboard } : {}) };
}

function validateConfig(config: RusaConfig): void {
  if (!config.providers || Object.keys(config.providers).length === 0) {
    throw new Error("config: at least one provider is required");
  }
  if (!config.geminiApiKey?.trim()) {
    throw new Error("config: geminiApiKey is required");
  }
}

function loadConfigFromFile(configPath: string): RusaConfig {
  const raw = readFileSync(configPath, "utf-8");
  return normalizeConfig(parseYaml(raw) as RusaConfig);
}

function buildDefaultConfig(existing?: RusaConfig | null): RusaConfig {
  const geminiApiKey =
    existing?.geminiApiKey?.trim() ||
    process.env.RUSA_GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    "test-gemini-key";

  const baseConfig: RusaConfig = {
    github: {
      ...(existing?.github?.account ? { account: existing.github.account } : {}),
      pollIntervalSeconds: existing?.github?.pollIntervalSeconds ?? 300,
    },
    // No silent provider default — `validateConfig` fails if none are configured.
    providers: existing?.providers ?? {},
    geminiApiKey,
    webhook: {
      port: existing?.webhook?.port ?? 9742,
      secret: existing?.webhook?.secret ?? randomBytes(32).toString("hex"),
      ...(existing?.webhook?.externalUrl ? { externalUrl: existing.webhook.externalUrl } : {}),
    },
    dashboard: {
      port: existing?.dashboard?.port ?? 8080,
      quotaProviders: {
        claude: { primaryWindow: "weekly" },
        codex: { primaryWindow: "weekly" },
        agy: { primaryWindow: "weekly" },
        ...existing?.dashboard?.quotaProviders,
      },
      ...(existing?.dashboard?.tailscaleHostname
        ? { tailscaleHostname: existing.dashboard.tailscaleHostname }
        : {}),
    },
    ...(existing?.understanding || existing?.glassGoals
      ? {
          understanding: {
            ...existing?.understanding,
            ...(existing?.understanding?.glassGoals
              ? { glassGoals: existing.understanding.glassGoals }
              : existing?.glassGoals
                ? { glassGoals: existing.glassGoals }
                : {}),
          },
        }
      : {}),
  };

  return normalizeConfig(baseConfig);
}

async function runInitNonInteractive(opts: InitOptions): Promise<void> {
  const mcHome = resolveHomeOverride(opts);
  const existing = loadExistingConfig(mcHome);

  let config: RusaConfig | null = null;
  if (opts.configPath) {
    config = loadConfigFromFile(opts.configPath);
  } else if (opts.defaults) {
    config = buildDefaultConfig(existing);
  } else if (existing) {
    config = normalizeConfig(existing);
  } else {
    throw new Error("Non-interactive init requires --config or --defaults");
  }

  validateConfig(config);

  // Write everything to disk
  mkdirSync(mcHome, { recursive: true });
  mkdirSync(join(mcHome, "repos"), { recursive: true });
  mkdirSync(join(mcHome, "data"), { recursive: true });
  mkdirSync(join(mcHome, "logs"), { recursive: true });

  const configPath = join(mcHome, "config.yaml");
  writeFileSync(configPath, toYaml(config), "utf-8");
  console.log(`\n✅ Config written to ${configPath}`);

  // Initialize the database schema.
  // IMPORTANT: Provider models are managed EXPLICITLY via the dashboard UI only.
  // We do NOT auto-create models or provider-model associations based on config.
  // This prevents "hallucinated" models (see an issue).
  initDb(mcHome);

  console.log(
    `\nNon-interactive init complete. Run ${"`rusa start`"} to begin, or ${"`rusa install-service`"} to run as a systemd service.\n`
  );
}

function loadExistingEnvVar(mcHome: string, key: string): string | null {
  const envPath = join(mcHome, ".env");
  if (!existsSync(envPath)) return null;

  try {
    const raw = readFileSync(envPath, "utf-8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (!trimmed.startsWith(`${key}=`)) continue;
      return trimmed.slice(key.length + 1).trim();
    }
  } catch {
    // Ignore malformed or unreadable .env
  }

  return null;
}

/**
 * Try to detect the external IP from the GCE metadata server.
 * Returns null if not running on GCE or if the request fails.
 */
function detectGceExternalIp(): string | null {
  try {
    const ip = execSync(
      'curl -s -m 1 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip',
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    // Sanity check: should look like an IP address
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    return null;
  } catch {
    return null;
  }
}

/**
 * Interactive init wizard.
 * When re-running, loads existing config values as defaults.
 */
export async function runInit(opts?: InitOptions): Promise<void> {
  if (opts?.nonInteractive) {
    await runInitNonInteractive(opts);
    return;
  }
  console.log(`\n🔧 Rusa Setup\n${"━".repeat(19)}\n`);

  // 1. Data directory
  const defaultHome = resolveHomeOverride(opts);
  const mcHome = await input({
    message: "Where should rusa store its data?",
    default: defaultHome,
  });

  // Try to load existing config for defaults
  const existing = loadExistingConfig(mcHome);
  if (existing) {
    console.log(`\n  ℹ️  Found existing config — values shown as defaults. Press Enter to keep.\n`);
  }

  // Optional — enables LLM quota-error classification, avatar generation, and
  // understanding retrieval/distill; each is skipped when absent.
  const existingGeminiApiKey =
    existing?.geminiApiKey?.trim() || loadExistingEnvVar(mcHome, "GEMINI_API_KEY") || "";
  let geminiApiKey = existingGeminiApiKey;
  if (existingGeminiApiKey) {
    const keepGeminiApiKey = await confirm({
      message: "Keep existing Gemini API key from config?",
      default: true,
    });
    if (!keepGeminiApiKey) {
      geminiApiKey = "";
    }
  }
  if (!geminiApiKey.trim()) {
    geminiApiKey = await input({
      message:
        "Gemini API key (required — used for background tasks such as one-off text classifications and avatar generation):",
      validate: (val) => (val.trim() ? true : "Gemini API key is required"),
    });
  }

  // 2. GitHub account
  const ghAccount = await input({
    message: "GitHub account to operate as:",
    default: existing?.github?.account ?? "quickstart-user",
  });

  // 2b. Git identity
  console.log("\nGit identity (for commits made by rusa):\n");

  let existingGitName = "";
  let existingGitEmail = "";
  try {
    existingGitName = execSync("git config --global user.name", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    // not set
  }
  try {
    existingGitEmail = execSync("git config --global user.email", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    // not set
  }

  const gitName = await input({
    message: "Git user.name for commits:",
    default: existingGitName || ghAccount,
  });

  const gitEmail = await input({
    message: "Git user.email for commits:",
    default: existingGitEmail || "",
  });

  // Apply git config globally
  execSync(`git config --global user.name "${gitName}"`, { stdio: "pipe" });
  execSync(`git config --global user.email "${gitEmail}"`, { stdio: "pipe" });
  console.log(`  ✓ Git identity set: ${gitName} <${gitEmail}>`);

  // 3. Polling interval
  const pollInterval = await input({
    message: "Polling fallback interval in seconds:",
    default: String(existing?.github?.pollIntervalSeconds ?? 300),
  });

  // 5. Detect CLI providers and configure API keys
  console.log("\nDetecting LLM providers...\n");

  interface CliProbe {
    name: string;
    command: string;
    versionFlag: string;
  }

  const cliProbes: CliProbe[] = [
    { name: "claude", command: "claude", versionFlag: "--version" },
    { name: "codex", command: "codex", versionFlag: "--version" },
    { name: "antigravity", command: "agy", versionFlag: "--version" },
    { name: "kimi", command: "kimi", versionFlag: "--version" },
    { name: "copilot", command: "copilot", versionFlag: "--version" },
  ];

  const envLines: string[] = [];
  const providers: Record<string, RusaConfig["providers"][string]> = {};
  // Carry over existing providers that are not auto-probed.
  const existingProviders = existing?.providers ?? {};
  const probedProviderNames = new Set(cliProbes.map((probe) => probe.name));

  for (const [name, providerConfig] of Object.entries(existingProviders)) {
    if (!probedProviderNames.has(name)) {
      providers[name] = providerConfig;
    }
  }

  for (const probe of cliProbes) {
    let cliFound = false;
    try {
      execSync(`${probe.command} ${probe.versionFlag}`, { stdio: "pipe" });
      cliFound = true;
    } catch {
      // CLI not found or errored
    }

    if (cliFound) {
      console.log(`  ✓ Found ${probe.name} CLI (${probe.command})`);
      providers[probe.name] = {
        cliCommand: probe.command,
      };
    } else if (existingProviders[probe.name]) {
      console.log(`  ✓ Keeping existing ${probe.name} CLI config`);
      providers[probe.name] = existingProviders[probe.name];
    } else {
      console.log(`  ✗ ${probe.name} CLI not found`);
    }
  }

  if (Object.keys(providers).length === 0) {
    console.log("\n  ⚠️  No providers configured. You'll need at least one to use rusa.");
  }

  // 6. Glass Goals configuration
  console.log("\nGlass Goals configuration (for understanding storage):\n");

  const skipGlassGoals = await confirm({
    message: "Configure glass_goals storage backend?",
    default: true,
  });

  let ggConfig: RusaConfig["glassGoals"];
  // Written to $RUSA_HOME/secrets/glass-goals-password (dir 0700, file
  // 0600) after mcHome exists — NOT to .env ; the runtime prefers the
  // secrets file and the sandbox masks the whole secrets dir from workers.
  let ggPasswordToWrite: string | null = null;

  if (skipGlassGoals) {
    const ggUsername = await input({
      message: "glass_goals username (email):",
      default:
        gitEmail ||
        (existing?.understanding?.glassGoals?.username ?? existing?.glassGoals?.username ?? ""),
    });

    const ggPassword = await password({
      message: "glass_goals password:",
      mask: "*",
    });

    if (ggUsername.trim()) {
      const firebaseServiceAccountKeyPath = await input({
        message: "Path to Firebase service account key JSON (optional, for admin tools):",
        default:
          existing?.understanding?.glassGoals?.firebaseServiceAccountKeyPath ??
          existing?.glassGoals?.firebaseServiceAccountKeyPath ??
          "",
      });

      ggConfig = {
        username: ggUsername.trim(),
        ...(firebaseServiceAccountKeyPath.trim()
          ? {
              firebaseServiceAccountKeyPath: firebaseServiceAccountKeyPath.trim(),
            }
          : {}),
      };
      if (ggPassword) {
        ggPasswordToWrite = ggPassword;
      }
    }
  }

  // 7. Webhook configuration
  console.log("\nWebhook configuration (for receiving GitHub events):\n");

  const webhookPort = await input({
    message: "Webhook listener port:",
    default: String(existing?.webhook?.port ?? 9742),
  });
  const port = parseInt(webhookPort, 10) || 9742;

  // Auto-detect external URL from GCE metadata if not already configured
  let urlDefault = existing?.webhook?.externalUrl ?? "";
  if (!urlDefault) {
    const gceIp = detectGceExternalIp();
    if (gceIp) {
      urlDefault = `http://${gceIp}:${port}`;
      console.log(`  ✓ Detected GCE external IP: ${gceIp}`);
    }
  }

  const webhookExternalUrl = await input({
    message: "External URL for webhook callbacks (e.g. http://<your-vm-ip>:9742):",
    default: urlDefault,
  });

  const dashboardPort = await input({
    message: "Dashboard listener port:",
    default: String(existing?.dashboard?.port ?? 8080),
  });

  const tailscaleHostname = await input({
    message:
      "Tailscale MagicDNS hostname for this machine (e.g. my-server.tail1234.ts.net, leave empty to skip):",
    default: existing?.dashboard?.tailscaleHostname ?? "",
  });

  // Reuse existing secret or generate a new one
  const webhookSecret = existing?.webhook?.secret ?? randomBytes(32).toString("hex");
  if (!existing?.webhook?.secret) {
    envLines.push(`WEBHOOK_SECRET=${webhookSecret}`);
    console.log(`  ✓ Generated webhook secret`);
  } else {
    console.log(`  ✓ Keeping existing webhook secret`);
  }

  // Build config object
  const config: RusaConfig = {
    github: {
      account: ghAccount,
      pollIntervalSeconds: parseInt(pollInterval, 10) || 300,
    },
    providers,
    ...(geminiApiKey.trim() ? { geminiApiKey: geminiApiKey.trim() } : {}),
    webhook: {
      port: parseInt(webhookPort, 10) || 9742,
      secret: webhookSecret,
      ...(webhookExternalUrl.trim() ? { externalUrl: webhookExternalUrl.trim() } : {}),
    },
    dashboard: {
      port: parseInt(dashboardPort, 10) || 8080,
      quotaProviders: {
        claude: { primaryWindow: "weekly" },
        codex: { primaryWindow: "weekly" },
        agy: { primaryWindow: "weekly" },
        ...existing?.dashboard?.quotaProviders,
      },
      ...(tailscaleHostname.trim() ? { tailscaleHostname: tailscaleHostname.trim() } : {}),
    },
    ...(existing?.understanding || ggConfig
      ? {
          understanding: {
            ...existing?.understanding,
            ...(ggConfig ? { glassGoals: ggConfig } : {}),
          },
        }
      : {}),
  };

  // Write everything to disk
  mkdirSync(mcHome, { recursive: true });
  mkdirSync(join(mcHome, "repos"), { recursive: true });
  mkdirSync(join(mcHome, "data"), { recursive: true });
  mkdirSync(join(mcHome, "logs"), { recursive: true });

  // config.yaml
  const configPath = join(mcHome, "config.yaml");
  writeFileSync(configPath, toYaml(config), "utf-8");
  console.log(`\n✅ Config written to ${configPath}`);

  // Initialize the database schema.
  // IMPORTANT: Provider models are managed EXPLICITLY via the dashboard UI only.
  // We do NOT auto-create models or provider-model associations based on config.
  // This prevents "hallucinated" models (see an issue).
  initDb(mcHome);

  // Glass-goals password → the host secrets file , never .env.
  if (ggPasswordToWrite) {
    const secretPath = writeHostSecret(
      GLASS_GOALS_PASSWORD_SECRET_FILENAME,
      ggPasswordToWrite,
      mcHome
    );
    console.log(`✅ glass-goals password written to ${secretPath}`);
  }

  // .env
  if (envLines.length > 0) {
    const envPath = join(mcHome, ".env");
    writeFileSync(envPath, `${envLines.join("\n")}\n`, "utf-8");
    console.log(`✅ .env written to ${envPath}`);
  }

  console.log(`
Run ${"`rusa start`"} to begin, or ${"`rusa install-service`"} to run as a systemd service.
`);
}
