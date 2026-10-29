import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { assertSpawnContextSupported, resolveContextConfig } from "../actor/context-selection.js";
import { resolveErrorSink } from "../observability/error-sink.js";
import { validateModelConfigPool } from "../providers/model-config.js";
import { providerCapabilityName } from "../providers/provider-selection.js";
import { normalizeModelEffortSelection } from "../providers/reasoning-effort.js";
import { isSafeFollowerBind } from "../remote-instances/safe-bind.js";
import { parseVoiceDefinitions } from "../voice/voice-catalog.js";
import { validateDashboardAuth } from "./dashboard-auth.js";
import {
  ELEVENLABS_API_KEY_SECRET_FILENAME,
  GEMINI_API_KEY_SECRET_FILENAME,
  MISTRAL_API_KEY_SECRET_FILENAME,
  readHostSecret,
  resolveHome,
  SECRETS_DIRNAME,
  WEBHOOK_SECRET_FILENAME,
} from "./secrets.js";
import {
  DEFAULT_DEPLOY_BRANCH,
  type GitHubConfig,
  type GitHubOrgConfig,
  type InstanceIdentity,
  type InstanceRole,
  type PeerConfig,
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
  /** `--leader`: URL of the single `leader` peer entry, overriding or creating it. */
  leader?: string;
  /** `--token-file`: token file of the single `leader` peer entry, overriding config.yaml. */
  tokenFile?: string;
  /** Override local instance ID. */
  instanceId?: string;
}

export const QUICKSTART_PROFILE = {
  // No separate single-user config toggle exists today; the current root/operator shape is structural.
  github: { account: "quickstart-user" },
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
  if (
    quotaThrottle.manualHardStaleSeconds !== undefined &&
    (!Number.isFinite(quotaThrottle.manualHardStaleSeconds) ||
      !Number.isInteger(quotaThrottle.manualHardStaleSeconds) ||
      quotaThrottle.manualHardStaleSeconds <= 0)
  ) {
    throw new Error(
      "config.yaml: quota.throttle.manualHardStaleSeconds must be a positive integer"
    );
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
  if ("role" in rawParsed || "peer" in rawParsed) {
    throw new Error(
      "config.yaml: top-level role and peer are not supported; describe instance relationships with peers (a leader entry makes this instance a follower)"
    );
  }
  if (options?.leader !== undefined || options?.tokenFile !== undefined) {
    applyLeaderShorthand(rawParsed, options.leader, options.tokenFile);
  }
  if (options?.instanceId !== undefined) {
    rawParsed.instance = {
      ...(rawParsed.instance && typeof rawParsed.instance === "object" ? rawParsed.instance : {}),
      id: options.instanceId,
    };
  }

  const parsed = applyProfile(rawParsed);

  // Validate peer relationships before side effects
  validatePeers(parsed);
  const role = instanceRoleOf(parsed);

  if (parsed.instance !== undefined) {
    if (
      typeof parsed.instance !== "object" ||
      parsed.instance === null ||
      Array.isArray(parsed.instance)
    ) {
      throw new Error("config.yaml: instance must be a mapping when set");
    }
    if (parsed.instance.id !== undefined) {
      if (typeof parsed.instance.id !== "string" || !parsed.instance.id.trim()) {
        throw new Error("config.yaml: instance.id must be a non-empty string when set");
      }
      parsed.instance.id = parsed.instance.id.trim();
      // Refuse an ID a leader's follower gateway would reject at enrollment.
      if (!PEER_ID_PATTERN.test(parsed.instance.id)) {
        throw new Error(
          'config.yaml: instance.id must be 1-64 letters, digits, "_" or "-" (the instance ID followers enroll with)'
        );
      }
    }
  }

  if (role === "follower" && parsed.followers !== undefined) {
    throw new Error(
      "config.yaml: a follower (peers has a leader entry) cannot configure followers gateway"
    );
  }
  const allowlist = followerAllowlistOf(parsed);
  if (allowlist.length > 0 && parsed.followers === undefined) {
    throw new Error(
      "config.yaml: peers follower entries require the followers gateway (followers.bind/port/tokenFile)"
    );
  }
  if (parsed.followers !== undefined && allowlist.length === 0) {
    throw new Error(
      'config.yaml: followers gateway requires at least one peers entry with type: follower; only listed follower instance IDs may enroll (e.g. peers: [{ id: "<follower instance id>", type: follower }])'
    );
  }
  if (role === "follower" && parsed.instance?.id === undefined) {
    throw new Error(
      "config.yaml: a follower (peers has a leader entry) requires instance.id (or --instance-id) matching a follower entry in the leader's peers allowlist"
    );
  }

  validateDashboardAuth(parsed.auth);
  resolveErrorSink(parsed);

  // Basic validation & defaulting
  if (role !== "follower" && !parsed.github) {
    throw new Error("config.yaml: github configuration is required");
  }
  if (parsed.github) {
    if (!parsed.github.account) {
      parsed.github.account = "quickstart-user";
    }
    rejectRemovedGitHubPollingKeys(parsed.github);
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
                  typeof repo !== "string" ||
                  !repo.trim() ||
                  !/^[^/\s]+\/[^/\s]+$/.test(repo.trim())
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
  }
  if (!parsed.providers || Object.keys(parsed.providers).length === 0) {
    throw new Error("config.yaml: at least one provider is required");
  }
  if (parsed.rootActor !== undefined) {
    if (
      !parsed.rootActor ||
      typeof parsed.rootActor !== "object" ||
      Array.isArray(parsed.rootActor)
    ) {
      throw new Error("config.yaml: rootActor must be a mapping when set");
    }
    if (parsed.rootActor.context !== undefined) {
      try {
        parsed.rootActor.context = resolveContextConfig(parsed.rootActor.context);
      } catch (err) {
        throw new Error(
          `config.yaml: rootActor.context: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const rootActor = parsed.rootActor;
    if ("fallbackModel" in rootActor) {
      throw new Error(
        "config.yaml: rootActor.fallbackModel has been removed; for portable roots (context.type: portable), configure the ordered root model pool with set_actor_model instead. Native-session roots do not support multi-entry model pools."
      );
    }
    const provider = rootActor.provider?.trim();
    if (!provider) throw new Error("config.yaml: rootActor.provider must be a non-empty string");
    const capabilityName = providerCapabilityName(provider, parsed);
    if (capabilityName === "agy" && rootActor.effort === undefined) {
      const { effort: parsedEffort } = normalizeModelEffortSelection(
        capabilityName,
        rootActor.model,
        undefined
      );
      if (parsedEffort === undefined) {
        console.warn(
          `[migration] defaulting omitted config rootActor effort to "high" for antigravity model "${rootActor.model || ""}"`
        );
        rootActor.effort = "high";
      }
    }
    const [selection] = validateModelConfigPool(
      parsed,
      { provider, model: rootActor.model, effort: rootActor.effort },
      { portable: rootActor.context?.type === "portable" }
    );
    if (!selection) throw new Error("config.yaml: rootActor requires one provider/model entry");
    rootActor.provider = selection.provider;
    rootActor.model = selection.model;
    rootActor.effort = selection.effort;
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
  // Model-only fallback settings are no longer supported: a root recovers using
  // its ordered configured model pool, while workers report quota exhaustion to
  // their parent. Fail loud rather than silently ignoring a key operators
  // believe is doing something.
  for (const [providerName, providerConfig] of Object.entries(parsed.providers)) {
    if (providerConfig && "fallbackModel" in providerConfig) {
      throw new Error(
        `config.yaml: providers.${providerName}.fallbackModel is no longer supported: fallbacks are ` +
          "the root uses its ordered model pool and workers report quota exhaustion to their parent. " +
          "Remove the key."
      );
    }
    // OpenRouter is an ordinary provider now. Its former opt-in block (and the
    // piCommand inside it) would otherwise be silently ignored.
    if (providerConfig && "openrouterPoc" in providerConfig) {
      throw new Error(
        `config.yaml: providers.${providerName}.openrouterPoc has been removed: OpenRouter is an ` +
          "ordinary provider that runs Pi through cliCommand. Delete the key and set cliCommand: pi."
      );
    }
    if (providerConfig && "authBroker" in providerConfig) {
      if (providerName !== "codex") {
        throw new Error(
          `config.yaml: providers.${providerName}.authBroker is only supported for codex`
        );
      }
      if (typeof providerConfig.authBroker !== "boolean") {
        throw new Error("config.yaml: providers.codex.authBroker must be true or false");
      }
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
    if (quota.coordinator !== undefined) {
      if (
        typeof quota.coordinator !== "object" ||
        quota.coordinator === null ||
        Array.isArray(quota.coordinator)
      ) {
        throw new Error("config.yaml: quota.coordinator must be a mapping when set");
      }
      const allowedCoordinatorKeys = new Set([
        "socketPath",
        "databasePath",
        "backupDir",
        "backupRetention",
      ]);
      for (const k of Object.keys(quota.coordinator)) {
        if (!allowedCoordinatorKeys.has(k)) {
          throw new Error(`config.yaml: unknown key quota.coordinator.${k}`);
        }
      }
      for (const key of ["socketPath", "databasePath", "backupDir"] as const) {
        const value = quota.coordinator[key];
        if (value !== undefined) {
          if (typeof value !== "string" || !value.trim()) {
            throw new Error(
              `config.yaml: quota.coordinator.${key} must be a non-empty string when set`
            );
          }
          quota.coordinator[key] = value.trim();
        }
      }
      const retention = quota.coordinator.backupRetention;
      if (retention !== undefined) {
        // Retention zero would mean "delete the backup you just took", so the
        // floor is one rather than zero: turning backups off is not spelled
        // "keep none of them".
        if (typeof retention !== "number" || !Number.isInteger(retention) || retention < 1) {
          throw new Error(
            "config.yaml: quota.coordinator.backupRetention must be a positive integer when set"
          );
        }
      }
    }
    if (quota.throttle?.enabled === true && !quota.coordinator?.socketPath) {
      throw new Error(
        "config.yaml: quota.coordinator.socketPath is required when quota.throttle.enabled is true"
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
  const loggingLevel = parsed.observability?.logging?.level;
  if (loggingLevel !== undefined) {
    // Validated here rather than clamped in the logger: a typo in config is a
    // mistake worth failing boot over, while `RUSA_LOG_LEVEL` is an ad-hoc
    // override that falls back to the default instead of killing the service.
    const allowed = ["debug", "info", "warn", "error", "silent"];
    if (typeof loggingLevel !== "string" || !allowed.includes(loggingLevel.trim().toLowerCase())) {
      throw new Error(
        `config.yaml: observability.logging.level must be one of ${allowed.join(", ")}`
      );
    }
  }
  const loggingFormat = parsed.observability?.logging?.format;
  if (loggingFormat !== undefined) {
    // Same reasoning as the level: a typo in config is worth failing boot over,
    // while `RUSA_LOG_FORMAT` falls back to the default rather than dying.
    const allowed = ["json", "pretty", "auto"];
    if (
      typeof loggingFormat !== "string" ||
      !allowed.includes(loggingFormat.trim().toLowerCase())
    ) {
      throw new Error(
        `config.yaml: observability.logging.format must be one of ${allowed.join(", ")}`
      );
    }
  }
  const chat = parsed.chat;
  if (parsed.slack !== undefined) {
    const slack = parsed.slack;
    if (!slack || typeof slack !== "object" || Array.isArray(slack)) {
      throw new Error("config.yaml: slack must be a mapping");
    }
    for (const key of ["appTokenPath", "botTokenPath"] as const) {
      if (typeof slack[key] !== "string" || !slack[key].trim()) {
        throw new Error(`config.yaml: slack.${key} must be a non-empty file path`);
      }
    }
    if ("channels" in slack) {
      throw new Error("config.yaml: slack.channels is not supported yet");
    }
  }
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

  if (parsed.customMcpServers !== undefined) {
    if (
      typeof parsed.customMcpServers !== "object" ||
      parsed.customMcpServers === null ||
      Array.isArray(parsed.customMcpServers)
    ) {
      throw new Error("config.yaml: customMcpServers must be a mapping when set");
    }
    for (const [capability, server] of Object.entries(parsed.customMcpServers)) {
      const source = `config.yaml: customMcpServers.${capability}`;
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(capability)) {
        throw new Error(
          `${source} capability name must use lowercase letters, digits, or underscores`
        );
      }
      if (typeof server !== "object" || server === null || Array.isArray(server)) {
        throw new Error(`${source} must be a mapping`);
      }
      if (typeof server.command !== "string" || !server.command.trim()) {
        throw new Error(`${source}.command must be a non-empty string`);
      }
      server.command = server.command.trim();
      if (server.args !== undefined) {
        if (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string")) {
          throw new Error(`${source}.args must be an array of strings when set`);
        }
      }
      if (server.cwd !== undefined) {
        if (typeof server.cwd !== "string" || !server.cwd.trim()) {
          throw new Error(`${source}.cwd must be a non-empty string when set`);
        }
        server.cwd = server.cwd.trim();
      }
      if ("env" in (server as object)) {
        throw new Error(
          `${source}.env is not supported; the host-owned executable must resolve its own credentials`
        );
      }
      if (
        typeof server.userId !== "string" ||
        !server.userId.trim() ||
        server.userId.includes(":")
      ) {
        throw new Error(`${source}.userId must be a non-empty colon-free string`);
      }
      server.userId = server.userId.trim();
      for (const key of ["readTools", "writeTools"] as const) {
        const tools = server[key];
        if (
          !Array.isArray(tools) ||
          tools.some((tool) => typeof tool !== "string" || !/^[A-Za-z0-9_.-]+$/.test(tool))
        ) {
          throw new Error(`${source}.${key} must be an array of MCP tool names`);
        }
        if (new Set(tools).size !== tools.length) {
          throw new Error(`${source}.${key} must not contain duplicate tool names`);
        }
      }
      if (server.readTools.length + server.writeTools.length === 0) {
        throw new Error(`${source} must list at least one tool in readTools or writeTools`);
      }
      if (server.readTools.some((tool) => server.writeTools.includes(tool))) {
        throw new Error(`${source} must classify each tool as read or write, not both`);
      }
    }
  }
  // geminiApiKey and mistralApiKey are optional at config-validation time;
  // individual consumers gate the features that require them.
  if (parsed.jevApiKeyFile !== undefined) {
    if (typeof parsed.jevApiKeyFile !== "string" || !parsed.jevApiKeyFile.trim()) {
      throw new Error("config.yaml: jevApiKeyFile must be a non-empty secret filename when set");
    }
    parsed.jevApiKeyFile = parsed.jevApiKeyFile.trim();
  }
  if (parsed.jevMode !== undefined) {
    if (
      typeof parsed.jevMode !== "string" ||
      !["shadow", "active"].includes(parsed.jevMode.trim())
    ) {
      throw new Error('config.yaml: jevMode must be "shadow" or "active" when set');
    }
    parsed.jevMode = parsed.jevMode.trim() as "shadow" | "active";
  }
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

  // Optional voice tuning; startup checks the selected transcription provider key.
  if (
    parsed.elevenlabsApiKey !== undefined &&
    (typeof parsed.elevenlabsApiKey !== "string" || !parsed.elevenlabsApiKey.trim())
  ) {
    throw new Error("config.yaml: elevenlabsApiKey must be a non-empty string when set");
  }
  const voice = parsed.voice;
  if (voice !== undefined) {
    if (typeof voice !== "object" || voice === null || Array.isArray(voice)) {
      throw new Error("config.yaml: voice must be a mapping when set");
    }
    if (
      voice.transcriptionProvider !== undefined &&
      !["google", "elevenlabs"].includes(voice.transcriptionProvider)
    ) {
      throw new Error("config.yaml: voice.transcriptionProvider must be google or elevenlabs");
    }
    if (voice.supportedVoices !== undefined) {
      try {
        voice.supportedVoices = parseVoiceDefinitions(voice.supportedVoices);
      } catch (error) {
        throw new Error(
          `config.yaml: voice.supportedVoices: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    for (const key of [
      "transcriptionModel",
      "ttsModel",
      "voiceName",
      "elevenlabsTtsModel",
    ] as const) {
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

  const followers = parsed.followers;
  if (followers !== undefined) {
    if (typeof followers !== "object" || followers === null || Array.isArray(followers)) {
      throw new Error("config.yaml: followers must be a mapping when set");
    }
    if (typeof followers.bind !== "string" || !followers.bind.trim()) {
      throw new Error("config.yaml: followers.bind must be a non-empty string when set");
    }
    followers.bind = followers.bind.trim();
    if (!isSafeFollowerBind(followers.bind)) {
      throw new Error(
        `config.yaml: followers.bind must be an explicit loopback (127.0.0.1) or Tailscale IPv4 address (100.64.0.0/10), got ${JSON.stringify(followers.bind)}`
      );
    }
    if (
      typeof followers.port !== "number" ||
      !Number.isInteger(followers.port) ||
      followers.port <= 0 ||
      followers.port > 65535
    ) {
      throw new Error("config.yaml: followers.port must be a valid port integer (1-65535)");
    }
    if (typeof followers.tokenFile !== "string" || !followers.tokenFile.trim()) {
      throw new Error("config.yaml: followers.tokenFile must be a non-empty string when set");
    }
    const rawTokenFile = followers.tokenFile.trim();
    followers.tokenFile =
      rawTokenFile === "~" || rawTokenFile.startsWith("~/")
        ? join(homedir(), rawTokenFile.slice(2))
        : rawTokenFile;
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
function warnDuplicateSecret(inlineName: string, secretFilename: string, term = "key"): void {
  console.warn(
    `[config] ${inlineName} is set inline in config.yaml AND ${SECRETS_DIRNAME}/${secretFilename} exists — the secrets file wins. Remove the inline ${term}.`
  );
}

function applySecretFiles(parsed: RusaConfig, mcHome: string): void {
  const fileElevenLabsKey = readHostSecret(ELEVENLABS_API_KEY_SECRET_FILENAME, mcHome);
  if (fileElevenLabsKey) {
    if (parsed.elevenlabsApiKey) {
      warnDuplicateSecret("elevenlabsApiKey", ELEVENLABS_API_KEY_SECRET_FILENAME);
    }
    parsed.elevenlabsApiKey = fileElevenLabsKey;
  }
  const fileGeminiKey = readHostSecret(GEMINI_API_KEY_SECRET_FILENAME, mcHome);
  if (fileGeminiKey) {
    if (parsed.geminiApiKey) {
      warnDuplicateSecret("geminiApiKey", GEMINI_API_KEY_SECRET_FILENAME);
    }
    parsed.geminiApiKey = fileGeminiKey;
  }

  const fileMistralKey = readHostSecret(MISTRAL_API_KEY_SECRET_FILENAME, mcHome);
  if (fileMistralKey) {
    if (parsed.mistralApiKey) {
      warnDuplicateSecret("mistralApiKey", MISTRAL_API_KEY_SECRET_FILENAME);
    }
    parsed.mistralApiKey = fileMistralKey;
  }

  const fileWebhookSecret = readHostSecret(WEBHOOK_SECRET_FILENAME, mcHome);
  if (fileWebhookSecret && parsed.webhook) {
    if (parsed.webhook.secret) {
      warnDuplicateSecret("webhook.secret", WEBHOOK_SECRET_FILENAME, "value");
    }
    parsed.webhook.secret = fileWebhookSecret;
  }
}

/** Instance IDs a follower sends at enrollment; the follower gateway's own check. */
const PEER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Keys a `peers` entry may carry; follower entries are further limited to type/id. */
const PEER_KEYS = new Set(["type", "id", "url", "token", "tokenFile"]);

/**
 * This instance's local role, derived from `peers`: a `leader` entry makes it a
 * follower; otherwise it is a leader (#1024).
 */
export function instanceRoleOf(config: Pick<RusaConfig, "peers">): InstanceRole {
  return leaderPeerOf(config) ? "follower" : "leader";
}

/**
 * This instance's identity from config (#1019). {@link loadConfig} has already
 * refused a follower without `instance.id`.
 */
export function instanceIdentityOf(
  config: Pick<RusaConfig, "peers" | "instance">
): InstanceIdentity {
  const instanceId = config.instance?.id;
  if (instanceRoleOf(config) === "leader") return { role: "leader", instanceId };
  if (instanceId === undefined) {
    throw new Error("A follower requires instance.id; loadConfig validates this");
  }
  return { role: "follower", instanceId };
}

/** The single configured `leader` peer entry, if this instance is a follower. */
export function leaderPeerOf(config: Pick<RusaConfig, "peers">): PeerConfig | undefined {
  return config.peers?.find((peer) => peer.type === "leader");
}

/** Follower instance IDs a leader allows to enroll through its gateway. */
export function followerAllowlistOf(config: Pick<RusaConfig, "peers">): string[] {
  return (config.peers ?? [])
    .filter((peer) => peer.type === "follower")
    .map((peer) => peer.id as string);
}

/**
 * `--leader` / `--token-file` are shorthand for one `leader` peer entry: they
 * override the configured leader entry's url/tokenFile, or create the entry
 * when none exists. Other entries are left for {@link validatePeers} to judge.
 */
function applyLeaderShorthand(
  rawParsed: RusaConfig,
  leader: string | undefined,
  tokenFile: string | undefined
): void {
  if (rawParsed.peers !== undefined && !Array.isArray(rawParsed.peers)) {
    throw new Error("config.yaml: peers must be a list when set");
  }
  const peers: unknown[] = rawParsed.peers ? [...rawParsed.peers] : [];
  const index = peers.findIndex(
    (peer) => isPlainObject(peer) && (peer as { type?: unknown }).type === "leader"
  );
  if (index < 0 && leader === undefined) {
    throw new Error("--token-file requires --leader or a configured leader peer entry");
  }
  const entry: Record<string, unknown> =
    index >= 0 ? { ...(peers[index] as Record<string, unknown>) } : { type: "leader" };
  if (leader !== undefined) entry.url = leader;
  if (tokenFile !== undefined) {
    entry.tokenFile = tokenFile;
    delete entry.token;
  }
  if (index >= 0) peers[index] = entry;
  else peers.push(entry);
  rawParsed.peers = peers as PeerConfig[];
}

function validatePeers(parsed: RusaConfig): void {
  if (parsed.peers === undefined) return;
  if (!Array.isArray(parsed.peers)) {
    throw new Error("config.yaml: peers must be a list when set");
  }
  const seenIds = new Set<string>();
  let leaders = 0;
  let followers = 0;
  parsed.peers.forEach((peer, index) => {
    const at = `config.yaml: peers[${index}]`;
    if (!isPlainObject(peer)) throw new Error(`${at} must be a mapping`);
    if (peer.type === "peer") {
      throw new Error(
        `${at}: type peer is not supported yet; cross-instance peers are tracked in #1101`
      );
    }
    if (peer.type !== "leader" && peer.type !== "follower") {
      throw new Error(`${at}.type must be "leader" or "follower"`);
    }
    for (const key of Object.keys(peer)) {
      if (!PEER_KEYS.has(key)) {
        throw new Error(`${at}.${key} is not a supported peer key`);
      }
    }
    if (peer.id !== undefined || peer.type === "follower") {
      if (typeof peer.id !== "string" || !PEER_ID_PATTERN.test(peer.id.trim())) {
        throw new Error(
          `${at}.id must be an instance ID of 1-64 letters, digits, "_" or "-"${peer.type === "follower" ? " (required on follower entries)" : ""}`
        );
      }
      peer.id = peer.id.trim();
      if (seenIds.has(peer.id)) throw new Error(`${at}.id duplicates ${JSON.stringify(peer.id)}`);
      seenIds.add(peer.id);
    }
    if (peer.type === "follower") {
      followers++;
      for (const key of ["url", "token", "tokenFile"] as const) {
        if (peer[key] !== undefined) {
          throw new Error(
            `${at}.${key} is not used on a follower entry; the leader's followers gateway holds the enrollment token`
          );
        }
      }
      return;
    }
    leaders++;
    if (typeof peer.url !== "string" || !peer.url.trim()) {
      throw new Error(`${at}.url must be the leader's http or https URL`);
    }
    peer.url = peer.url.trim();
    try {
      const u = new URL(peer.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      throw new Error(`${at}.url must be a valid http or https URL`);
    }
    if (peer.token !== undefined && peer.tokenFile !== undefined) {
      throw new Error(`${at}: cannot configure both token and tokenFile; choose one`);
    }
    if (peer.token === undefined && peer.tokenFile === undefined) {
      throw new Error(`${at}: a leader entry requires token or tokenFile`);
    }
    if (peer.token !== undefined) {
      if (typeof peer.token !== "string" || !peer.token.trim()) {
        throw new Error(`${at}.token must be a non-empty string when set`);
      }
      peer.token = peer.token.trim();
    }
    if (peer.tokenFile !== undefined) {
      if (typeof peer.tokenFile !== "string" || !peer.tokenFile.trim()) {
        throw new Error(`${at}.tokenFile must be a non-empty string when set`);
      }
      const rawTokenFile = peer.tokenFile.trim();
      peer.tokenFile =
        rawTokenFile === "~" || rawTokenFile.startsWith("~/")
          ? join(homedir(), rawTokenFile.slice(2))
          : rawTokenFile;
    }
  });
  if (leaders > 1) throw new Error("config.yaml: peers may contain at most one leader entry");
  if (leaders > 0 && followers > 0) {
    throw new Error(
      "config.yaml: peers cannot contain both a leader entry and follower entries; chained followers are not supported"
    );
  }
}

/**
 * GitHub polling was removed; webhooks are the only ingestion edge. A config
 * that still carries a polling key is refused rather than ignored, because a
 * key that used to change how events arrive going silent is exactly how a
 * stale install would run in a mode its operator never chose. `in` rather than
 * `!== undefined` so an explicit null still names the removal.
 */
const REMOVED_GITHUB_POLLING_KEYS = ["ingestionMode", "pollIntervalSeconds"] as const;

function rejectRemovedGitHubPollingKeys(github: GitHubConfig): void {
  for (const key of REMOVED_GITHUB_POLLING_KEYS) {
    if (key in github) {
      throw new Error(
        `config.yaml: github.${key} was removed along with GitHub polling; GitHub events now arrive only through the webhook listener (webhook.port). Delete the key from config.yaml.`
      );
    }
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
