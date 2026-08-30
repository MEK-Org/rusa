import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { assertSpawnContextSupported, resolveContextConfig } from "../actor/context-selection.js";
import {
  GEMINI_API_KEY_SECRET_FILENAME,
  MISTRAL_API_KEY_SECRET_FILENAME,
  readHostSecret,
  resolveHome,
  SECRETS_DIRNAME,
  WEBHOOK_SECRET_FILENAME,
} from "./secrets.js";
import {
  DEFAULT_DEPLOY_BRANCH,
  type GitHubOrgConfig,
  type QuotaThrottleConfig,
  type RusaConfig,
} from "./types.js";

export { resolveHome } from "./secrets.js";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/**
 * Named config profiles the CLI accepts. A profile is a preset bundle of config
 * values applied UNDER the user's config.yaml (explicit user values always win).
 * Extend this union — and the switch in {@link loadConfig} — when adding one.
 */
export type ConfigProfile = "quickstart";

export interface LoadConfigOptions {
  /**
   * Named configuration profile to apply as a preset (see {@link ConfigProfile}
   * and {@link QUICKSTART_PROFILE}). Runtime validation in {@link loadConfig}
   * stays authoritative for profiles supplied via config.yaml; this union is the
   * compile-time set the CLI passes in.
   */
  profile?: ConfigProfile;
}

export const QUICKSTART_PROFILE = {
  // No separate single-user config toggle exists today; the current root/operator shape is structural.
  github: { ingestionMode: "poll", account: "quickstart-user" },
  sandbox: "container-boundary",
  dashboard: { port: 8080, bindHost: "0.0.0.0" },
  gitBridge: true,
  gitBridgePort: 8085,
  gitBridgeBindHost: "0.0.0.0",
} satisfies DeepPartial<RusaConfig>;

const DEFAULT_DASHBOARD_QUOTA_PROVIDERS = {
  claude: { primaryWindow: "weekly" },
  codex: { primaryWindow: "weekly" },
  agy: { primaryWindow: "weekly" },
  kimi: { primaryWindow: "weekly" },
} as const;

function validateQuotaThrottle(quotaThrottle: QuotaThrottleConfig | undefined): void {
  if (quotaThrottle === undefined) return;
  if (typeof quotaThrottle !== "object" || quotaThrottle === null || Array.isArray(quotaThrottle)) {
    throw new Error("config.yaml: quota.throttle must be a mapping when set");
  }
  if (quotaThrottle.enabled !== undefined && typeof quotaThrottle.enabled !== "boolean") {
    throw new Error("config.yaml: quota.throttle.enabled must be a boolean when set");
  }
  if (
    quotaThrottle.maxIntervalSeconds !== undefined &&
    (!Number.isFinite(quotaThrottle.maxIntervalSeconds) || quotaThrottle.maxIntervalSeconds <= 0)
  ) {
    throw new Error("config.yaml: quota.throttle.maxIntervalSeconds must be positive");
  }
  if (
    quotaThrottle.tickSeconds !== undefined &&
    (!Number.isFinite(quotaThrottle.tickSeconds) ||
      !Number.isInteger(quotaThrottle.tickSeconds) ||
      quotaThrottle.tickSeconds <= 0)
  ) {
    throw new Error("config.yaml: quota.throttle.tickSeconds must be a positive integer");
  }
}

/**
 * Load and parse the config.yaml file from the rusa home directory.
 * Also loads .env if present.
 */
export function loadConfig(home?: string, options?: LoadConfigOptions): RusaConfig {
  const mcHome = home ?? resolveHome();

  // Load .env if it exists
  const envPath = join(mcHome, ".env");
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath, quiet: true });
  }

  // Load config.yaml
  const configPath = join(mcHome, "config.yaml");
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}. Run 'rusa init' first.`);
  }

  const raw = readFileSync(configPath, "utf-8");
  const rawParsed = parseYaml(raw) as RusaConfig;
  if ("targets" in (rawParsed as unknown as Record<string, unknown>)) {
    throw new Error(
      "config.yaml: top-level targets is no longer supported; use github.repos and github.orgs"
    );
  }
  if ("eventSources" in (rawParsed as unknown as Record<string, unknown>)) {
    throw new Error(
      "config.yaml: top-level eventSources is no longer supported; use github.repos and github.orgs"
    );
  }
  if (options?.profile !== undefined) {
    rawParsed.profile = options.profile;
  }

  const parsed = applyProfile(rawParsed);

  // Basic validation & defaulting
  if (parsed.github && !parsed.github.account) {
    parsed.github.account = "quickstart-user";
  }
  if (
    parsed.github.ingestionMode !== undefined &&
    parsed.github.ingestionMode !== "webhook" &&
    parsed.github.ingestionMode !== "poll"
  ) {
    throw new Error('config.yaml: github.ingestionMode must be "webhook" or "poll" when set');
  }
  // Validate-when-set rather than default-when-absent: the absent case is already
  // handled at the poller, and defaulting here too would make that guard look
  // unreachable to a later reader — which is how the key came to be treated as
  // deletable in the first place . What the poller's `??` cannot catch is a
  // key that IS set to something non-numeric, so that is what this rejects.
  if (parsed.github.pollIntervalSeconds !== undefined) {
    const interval = parsed.github.pollIntervalSeconds;
    if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) {
      throw new Error(
        "config.yaml: github.pollIntervalSeconds must be a positive number of seconds when set"
      );
    }
  }
  if (parsed.github.workerTokenPath !== undefined) {
    if (
      typeof parsed.github.workerTokenPath !== "string" ||
      !parsed.github.workerTokenPath.trim()
    ) {
      throw new Error("config.yaml: github.workerTokenPath must be a non-empty string when set");
    }
    parsed.github.workerTokenPath = parsed.github.workerTokenPath.trim();
  }
  if (parsed.github.repos !== undefined) {
    if (
      !Array.isArray(parsed.github.repos) ||
      parsed.github.repos.some(
        (repo) =>
          typeof repo !== "string" || !repo.trim() || !/^[^/\s]+\/[^/\s]+$/.test(repo.trim())
      )
    ) {
      throw new Error(
        "config.yaml: github.repos must be an array of repository names in owner/name format when set"
      );
    }
    parsed.github.repos = parsed.github.repos.map((repo) => repo.trim());
  }
  if (parsed.github.orgs !== undefined) {
    if (!Array.isArray(parsed.github.orgs)) {
      throw new Error("config.yaml: github.orgs must be an array of org objects when set");
    }
    const validatedOrgs: GitHubOrgConfig[] = [];
    for (const item of parsed.github.orgs) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const record = item as unknown as Record<string, unknown>;
        const orgName = record.org;

        if (typeof orgName !== "string" || !orgName.trim() || !/^[^/\s]+$/.test(orgName.trim())) {
          throw new Error(
            "config.yaml: github.orgs org object must specify a valid organization name without slashes"
          );
        }

        let excludedRepos: string[] | undefined;
        if (record.excludedRepos !== undefined) {
          if (
            !Array.isArray(record.excludedRepos) ||
            record.excludedRepos.some(
              (repo) =>
                typeof repo !== "string" || !repo.trim() || !/^[^/\s]+\/[^/\s]+$/.test(repo.trim())
            )
          ) {
            throw new Error(
              "config.yaml: github.orgs excludedRepos must be an array of repository names in owner/name format when set"
            );
          }
          excludedRepos = record.excludedRepos.map((repo) => (repo as string).trim());
          if (
            excludedRepos.some(
              (repo) => repo.split("/")[0]?.toLowerCase() !== orgName.trim().toLowerCase()
            )
          ) {
            throw new Error(
              "config.yaml: github.orgs excludedRepos entries must belong to their configured organization"
            );
          }
        }

        validatedOrgs.push({
          org: orgName.trim(),
          ...(excludedRepos ? { excludedRepos } : {}),
        });
      } else {
        throw new Error("config.yaml: github.orgs entries must be org objects");
      }
    }
    parsed.github.orgs = validatedOrgs;
  }
  if (!parsed.providers || Object.keys(parsed.providers).length === 0) {
    throw new Error("config.yaml: at least one provider is required");
  }
  if (parsed.rootActor?.context !== undefined) {
    try {
      parsed.rootActor.context = resolveContextConfig(parsed.rootActor.context);
    } catch (err) {
      throw new Error(
        `config.yaml: rootActor.context: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (parsed.understanding?.rootNodeId !== undefined) {
    if (
      typeof parsed.understanding.rootNodeId !== "string" ||
      !parsed.understanding.rootNodeId.trim()
    ) {
      throw new Error("config.yaml: understanding.rootNodeId must be a non-empty string when set");
    }
    parsed.understanding.rootNodeId = parsed.understanding.rootNodeId.trim();
  }
  // ISSUE_NUM: worker-side fallback is removed outright — fallbacks are root-only,
  // and a worker's parent judges quota exhaustion instead of the worker
  // silently degrading to a weaker model. Fail loud rather than silently
  // ignoring a key operators believe is doing something.
  for (const [providerName, providerConfig] of Object.entries(parsed.providers)) {
    if (providerConfig && "fallbackModel" in providerConfig) {
      throw new Error(
        `config.yaml: providers.${providerName}.fallbackModel is no longer supported: fallbacks are ` +
          "root-only; a worker's parent judges quota exhaustion . Remove the key " +
          "(rootActor.fallbackModel is unaffected)."
      );
    }
  }
  if (
    parsed.mesh &&
    typeof parsed.mesh === "object" &&
    "quotaThrottle" in (parsed.mesh as Record<string, unknown>)
  ) {
    throw new Error("config.yaml: mesh.quotaThrottle has moved to quota.throttle");
  }
  const quota = parsed.quota;
  if (quota !== undefined) {
    if (typeof quota !== "object" || quota === null || Array.isArray(quota)) {
      throw new Error("config.yaml: quota must be a mapping when set");
    }
    if ("poolId" in quota) {
      throw new Error(
        "config.yaml: quota.poolId has been removed; quota.databasePath is the sharing boundary"
      );
    }
    for (const key of ["databasePath"] as const) {
      const value = quota[key];
      if (value !== undefined) {
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(`config.yaml: quota.${key} must be a non-empty string when set`);
        }
        quota[key] = value.trim();
      }
    }
    validateQuotaThrottle(quota.throttle);
    if (quota.throttle?.enabled === true && !quota.databasePath) {
      throw new Error(
        "config.yaml: quota.databasePath is required when quota.throttle.enabled is true"
      );
    }
  }
  const dashboard = parsed.dashboard;
  if (dashboard) {
    if (dashboard.bindHost !== undefined) {
      if (typeof dashboard.bindHost !== "string" || !dashboard.bindHost.trim()) {
        throw new Error("config.yaml: dashboard.bindHost must be a non-empty string when set");
      }
      dashboard.bindHost = dashboard.bindHost.trim();
    }
    const configuredQuotaProviders = dashboard.quotaProviders ?? {};
    for (const [provider, value] of Object.entries(configuredQuotaProviders)) {
      if (
        provider !== "claude" &&
        provider !== "codex" &&
        provider !== "agy" &&
        provider !== "kimi"
      ) {
        throw new Error(
          "config.yaml: dashboard.quotaProviders may only configure claude, codex, agy, or kimi"
        );
      }
      if (
        !value ||
        typeof value !== "object" ||
        typeof value.primaryWindow !== "string" ||
        !value.primaryWindow.trim()
      ) {
        throw new Error(
          `config.yaml: dashboard.quotaProviders.${provider}.primaryWindow must be a non-empty string`
        );
      }
      value.primaryWindow = value.primaryWindow.trim();
    }
    dashboard.quotaProviders = {
      ...DEFAULT_DASHBOARD_QUOTA_PROVIDERS,
      ...configuredQuotaProviders,
    };
  }
  const trackerHygiene = parsed.observability?.trackerHygiene;
  if (trackerHygiene) {
    if (trackerHygiene.closeAction === undefined) {
      trackerHygiene.closeAction = "log";
    } else if (trackerHygiene.closeAction !== "log" && trackerHygiene.closeAction !== "close") {
      throw new Error(
        'config.yaml: observability.trackerHygiene.closeAction must be "log" or "close"'
      );
    }
    for (const [key, value] of Object.entries({
      intervalSeconds: trackerHygiene.intervalSeconds,
      staleAfterHours: trackerHygiene.staleAfterHours,
      closeAfterHours: trackerHygiene.closeAfterHours,
    })) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        throw new Error(`config.yaml: observability.trackerHygiene.${key} must be positive`);
      }
    }
    if (
      trackerHygiene.pingBackoffHours !== undefined &&
      (!Array.isArray(trackerHygiene.pingBackoffHours) ||
        trackerHygiene.pingBackoffHours.some((value) => !Number.isFinite(value) || value < 0))
    ) {
      throw new Error(
        "config.yaml: observability.trackerHygiene.pingBackoffHours must contain non-negative numbers"
      );
    }
  }
  const diskAlert = parsed.observability?.diskAlert;
  if (diskAlert) {
    if (
      diskAlert.thresholdPercent !== undefined &&
      (diskAlert.thresholdPercent < 0 || diskAlert.thresholdPercent > 100)
    ) {
      throw new Error(
        "config.yaml: observability.diskAlert.thresholdPercent must be between 0 and 100"
      );
    }
    if (diskAlert.thresholdBytes !== undefined && diskAlert.thresholdBytes < 0) {
      throw new Error("config.yaml: observability.diskAlert.thresholdBytes must be positive");
    }
    if (diskAlert.cooldownSeconds !== undefined && diskAlert.cooldownSeconds < 0) {
      throw new Error("config.yaml: observability.diskAlert.cooldownSeconds must be positive");
    }
  }
  const chat = parsed.chat;
  if (chat !== undefined) {
    if (chat.gchat !== undefined) {
      if (
        chat.gchat !== "all" &&
        (!Array.isArray(chat.gchat) ||
          chat.gchat.length === 0 ||
          !chat.gchat.every((s) => typeof s === "string" && s.startsWith("spaces/")))
      ) {
        throw new Error(
          'config.yaml: chat.gchat must be "all" or a non-empty array of spaces/... strings'
        );
      }
    }
    if (chat.excludedSpaces !== undefined) {
      if (
        !Array.isArray(chat.excludedSpaces) ||
        !chat.excludedSpaces.every(
          (s) =>
            typeof s === "string" &&
            s.trim().startsWith("spaces/") &&
            s.trim().split("/").length === 2 &&
            Boolean(s.trim().split("/")[1])
        )
      ) {
        throw new Error("config.yaml: chat.excludedSpaces must be an array of spaces/... strings");
      }
      chat.excludedSpaces = chat.excludedSpaces.map((s) => s.trim());
    }
  }

  // Integrated Understanding and Glass Goals validation
  const understanding = parsed.understanding;
  if (understanding !== undefined) {
    if (
      typeof understanding !== "object" ||
      understanding === null ||
      Array.isArray(understanding)
    ) {
      throw new Error("config.yaml: understanding must be a mapping when set");
    }
    if (understanding.rootNodeId !== undefined) {
      if (typeof understanding.rootNodeId !== "string" || !understanding.rootNodeId.trim()) {
        throw new Error(
          "config.yaml: understanding.rootNodeId must be a non-empty string when set"
        );
      }
      understanding.rootNodeId = understanding.rootNodeId.trim();
    }
    if (understanding.mount !== undefined) {
      if (
        typeof understanding.mount !== "object" ||
        understanding.mount === null ||
        Array.isArray(understanding.mount)
      ) {
        throw new Error("config.yaml: understanding.mount must be a mapping when set");
      }
      if (
        understanding.mount.enabled !== undefined &&
        typeof understanding.mount.enabled !== "boolean"
      ) {
        throw new Error("config.yaml: understanding.mount.enabled must be a boolean when set");
      }
    }
  }

  const nestedGg = parsed.understanding?.glassGoals;
  const topLevelGg = parsed.glassGoals;
  if (nestedGg !== undefined && topLevelGg !== undefined) {
    const conflicts =
      nestedGg.username !== topLevelGg.username ||
      nestedGg.firebaseServiceAccountKeyPath !== topLevelGg.firebaseServiceAccountKeyPath ||
      nestedGg.rootNodeId !== topLevelGg.rootNodeId;
    if (conflicts) {
      throw new Error(
        "config.yaml: conflicting glassGoals configurations present in both top-level glassGoals and understanding.glassGoals. Remove the legacy top-level glassGoals section."
      );
    }
  }

  const activeGgList = [
    ...(nestedGg !== undefined ? [{ source: "understanding.glassGoals", config: nestedGg }] : []),
    ...(topLevelGg !== undefined ? [{ source: "glassGoals", config: topLevelGg }] : []),
  ];

  for (const { source, config: gg } of activeGgList) {
    if (typeof gg !== "object" || gg === null || Array.isArray(gg)) {
      throw new Error(`config.yaml: ${source} must be a mapping when set`);
    }
    if (typeof gg.username !== "string" || !gg.username.trim()) {
      throw new Error(`config.yaml: ${source}.username must be a non-empty string when set`);
    }
    gg.username = gg.username.trim();
    if (gg.firebaseServiceAccountKeyPath !== undefined) {
      if (
        typeof gg.firebaseServiceAccountKeyPath !== "string" ||
        !gg.firebaseServiceAccountKeyPath.trim()
      ) {
        throw new Error(
          `config.yaml: ${source}.firebaseServiceAccountKeyPath must be a non-empty string when set`
        );
      }
      gg.firebaseServiceAccountKeyPath = gg.firebaseServiceAccountKeyPath.trim();
    }
    if (gg.rootNodeId !== undefined) {
      if (typeof gg.rootNodeId !== "string" || !gg.rootNodeId.trim()) {
        throw new Error(`config.yaml: ${source}.rootNodeId must be a non-empty string when set`);
      }
      gg.rootNodeId = gg.rootNodeId.trim();
    }
  }
  // geminiApiKey and mistralApiKey are optional at config-validation time;
  // individual consumers gate the features that require them.
  if (parsed.deployBranch !== undefined) {
    if (typeof parsed.deployBranch !== "string" || !parsed.deployBranch.trim()) {
      throw new Error("config.yaml: deployBranch must be a non-empty string when set");
    }
    parsed.deployBranch = parsed.deployBranch.trim();
  } else {
    parsed.deployBranch = DEFAULT_DEPLOY_BRANCH;
  }

  if (parsed.gitBridge !== undefined) {
    if (typeof parsed.gitBridge !== "boolean") {
      throw new Error("config.yaml: gitBridge must be a boolean when set");
    }
  } else {
    parsed.gitBridge = false;
  }

  if (parsed.sandbox !== undefined) {
    if (parsed.sandbox !== "container-boundary" && parsed.sandbox !== "bwrap") {
      throw new Error('config.yaml: sandbox must be "container-boundary" or "bwrap" when set');
    }
  } else {
    parsed.sandbox = "bwrap";
  }

  if (parsed.understanding?.mount?.enabled === true && parsed.sandbox === "container-boundary") {
    throw new Error(
      'config.yaml: understanding.mount.enabled requires sandbox: "bwrap" (found "container-boundary")'
    );
  }

  if (parsed.gitBridgePort !== undefined) {
    if (
      typeof parsed.gitBridgePort !== "number" ||
      !Number.isInteger(parsed.gitBridgePort) ||
      parsed.gitBridgePort <= 0
    ) {
      throw new Error("config.yaml: gitBridgePort must be a positive integer when set");
    }
  } else {
    parsed.gitBridgePort = 8085;
  }

  // Walkie-talkie voice tuning  — optional, additive; the feature is
  // gated on geminiApiKey elsewhere, so an unset section is always valid.
  const voice = parsed.voice;
  if (voice !== undefined) {
    if (typeof voice !== "object" || voice === null || Array.isArray(voice)) {
      throw new Error("config.yaml: voice must be a mapping when set");
    }
    for (const key of ["transcriptionModel", "ttsModel", "voiceName"] as const) {
      const value = voice[key];
      if (value !== undefined) {
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(`config.yaml: voice.${key} must be a non-empty string when set`);
        }
        voice[key] = value.trim();
      }
    }
  }

  if (parsed.gitBridgeBindHost !== undefined) {
    if (typeof parsed.gitBridgeBindHost !== "string" || !parsed.gitBridgeBindHost.trim()) {
      throw new Error("config.yaml: gitBridgeBindHost must be a non-empty string when set");
    }
    parsed.gitBridgeBindHost = parsed.gitBridgeBindHost.trim();
  } else {
    parsed.gitBridgeBindHost = "127.0.0.1";
  }

  applySecretFiles(parsed, mcHome);

  try {
    assertSpawnContextSupported(
      { context: parsed.rootActor?.context },
      { ledgerCompactionAvailable: Boolean(parsed.geminiApiKey?.trim()) }
    );
  } catch (err) {
    throw new Error(
      `config.yaml: rootActor.context: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return parsed;
}

/**
 * File-based secret resolution : `$RUSA_HOME/secrets/<name>` wins
 * over the inline config.yaml value when both exist (inline stays supported for
 * quickstart). Warns — without ever logging a value — when both are set, as a
 * migration nudge to remove the inline copy.
 */
function applySecretFiles(parsed: RusaConfig, mcHome: string): void {
  const fileGeminiKey = readHostSecret(GEMINI_API_KEY_SECRET_FILENAME, mcHome);
  if (fileGeminiKey) {
    if (parsed.geminiApiKey) {
      console.warn(
        `[config] geminiApiKey is set inline in config.yaml AND ${SECRETS_DIRNAME}/${GEMINI_API_KEY_SECRET_FILENAME} exists — the secrets file wins. Remove the inline key.`
      );
    }
    parsed.geminiApiKey = fileGeminiKey;
  }

  const fileMistralKey = readHostSecret(MISTRAL_API_KEY_SECRET_FILENAME, mcHome);
  if (fileMistralKey) {
    if (parsed.mistralApiKey) {
      console.warn(
        `[config] mistralApiKey is set inline in config.yaml AND ${SECRETS_DIRNAME}/${MISTRAL_API_KEY_SECRET_FILENAME} exists — the secrets file wins. Remove the inline key.`
      );
    }
    parsed.mistralApiKey = fileMistralKey;
  }

  const fileWebhookSecret = readHostSecret(WEBHOOK_SECRET_FILENAME, mcHome);
  if (fileWebhookSecret && parsed.webhook) {
    if (parsed.webhook.secret) {
      console.warn(
        `[config] webhook.secret is set inline in config.yaml AND ${SECRETS_DIRNAME}/${WEBHOOK_SECRET_FILENAME} exists — the secrets file wins. Remove the inline value.`
      );
    }
    parsed.webhook.secret = fileWebhookSecret;
  }
}

function applyProfile(config: RusaConfig): RusaConfig {
  if (config.profile === undefined) {
    return config;
  }
  if (typeof config.profile !== "string" || !config.profile.trim()) {
    throw new Error("config.yaml: profile must be a non-empty string when set");
  }
  const profile = config.profile.trim();
  config.profile = profile;

  if (profile === "quickstart") {
    return mergeProfilePreset(QUICKSTART_PROFILE, config);
  }

  throw new Error(`config.yaml: unknown profile "${profile}"`);
}

function mergeProfilePreset<T>(preset: DeepPartial<T>, explicit: T): T {
  return mergeObjects(preset, explicit) as T;
}

function mergeObjects(preset: unknown, explicit: unknown): unknown {
  if (!isPlainObject(preset) || !isPlainObject(explicit)) {
    return explicit === undefined ? preset : explicit;
  }

  const merged: Record<string, unknown> = { ...preset };
  for (const [key, value] of Object.entries(explicit)) {
    merged[key] = mergeObjects(merged[key], value);
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Save the provided configuration back to the config.yaml file.
 */
export function saveConfig(config: RusaConfig, home?: string): void {
  const mcHome = home ?? resolveHome();
  const configPath = join(mcHome, "config.yaml");

  const raw = stringifyYaml(config);
  writeFileSync(configPath, raw, "utf-8");
}
