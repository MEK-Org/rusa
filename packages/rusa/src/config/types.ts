/**
 * Configuration types for rusa.
 */

import type { ContextConfig } from "../actor/actor-record.js";
import type { ProviderModelConfig } from "../providers/model-config.js";

export const DEFAULT_DEPLOY_BRANCH = "master";
export type SandboxMode = "container-boundary" | "bwrap";

export interface ProviderConfig {
  /** CLI command name, e.g. "claude", "codex", "agy" */
  cliCommand?: string;
  dailyCap?: string;
}

export interface GitHubOrgConfig {
  /** The GitHub organization name */
  org: string;
  /**
   * Optional list of repository full names ("owner/name") to exclude from this organization's
   * events/subscriptions.
   */
  excludedRepos?: string[];
}

export interface GitHubConfig {
  account?: string;
  /**
   * GitHub poll interval, used only when {@link GitHubConfig.ingestionMode} is
   * "poll". Optional because `config.yaml` need not supply it; the poller applies
   * `DEFAULT_POLL_INTERVAL_SECONDS` when it is absent .
   */
  pollIntervalSeconds?: number;
  /** GitHub event ingestion edge. Defaults to "webhook" for existing installs. */
  ingestionMode?: "webhook" | "poll";
  /**
   * GitHub repositories in "owner/name" format that this instance subscribes to
   * and polls.
   */
  repos?: string[];
  /**
   * GitHub organizations that this instance subscribes to and polls. Repositories
   * listed in `excludedRepos` are suppressed at both webhook and poll ingestion.
   */
  orgs?: GitHubOrgConfig[];
  /**
   * Path to a read-mostly fine-grained GitHub PAT file (Contents R/W for git
   * push; Issues/PRs/Actions/Checks read-only) that sandboxed mesh workers see
   * INSTEAD of the host's full-scope classic token (worker-sandbox credential
   * split, ISSUE_NUM/ISSUE_NUM-adjacent).
   *
   * Unset (default): every sandboxed worker sees the host's real
   * `~/.config/gh` — identical to pre-split behavior. Logged loudly, once, at
   * the first sandboxed spawn (see providers/sandbox.ts) so the exposure
   * stays visible even when nobody reads this doc comment.
   *
   * Set but the file doesn't exist at spawn time: sandboxed workers REFUSE to
   * spawn (fail-closed, mirroring ISSUE_NUM's boot-gate precedent) rather than
   * silently falling back to the write-capable host token — a silent
   * fallback would defeat the point of the split. Root is never affected
   * either way: it runs unsandboxed on the host plane and keeps host
   * credentials regardless of this setting.
   */
  workerTokenPath?: string;
}

export interface WebhookConfig {
  port: number;
  secret: string;
  externalUrl?: string;
  /**
   * Suppress inbound webhook events whose sender is this instance's own bot
   * account — its own actions are consequences of its work, not new triggers
   * (default true). Set false for a secondary instance (e.g. staging) that
   * shares the bot account with prod, so cross-instance GitHub direction isn't
   * filtered as self-activity .
   */
  ignoreSelfEvents?: boolean;
  /**
   * Optional target for the webhook silence detector's active probe.
   * When configured, the detector posts a comment here instead of alarming immediately.
   */
  proberTarget?: { repo: string; issueNumber: number };
}

export interface DashboardQuotaProviderConfig {
  /** Window id that drives this provider's header quota ring. Defaults to "weekly". */
  primaryWindow: string;
}

/** Adaptive provider launch pacing driven by quota observations. */
export interface QuotaThrottleConfig {
  /** Enable per-provider adaptive pacing from the cached quota windows. Default false. */
  enabled?: boolean;
  /** Longest acceptable interval between normal starts. Default 3600 (one hour). */
  maxIntervalSeconds?: number;
  /** Quota sample/controller cadence in seconds. Default 300 (five minutes). */
  tickSeconds?: number;
}

/** Shared quota evidence, controller state, and launch pacing. */
export interface QuotaConfig {
  /**
   * SQLite database used for quota scrapes, canonical observations, and pacing state.
   * Multiple rusa instances that share provider credentials should point at the same file.
   * Required when quota.throttle is enabled.
   */
  databasePath?: string;
  /** Closed-loop launch pacing configuration. */
  throttle?: QuotaThrottleConfig;
}

export type DashboardQuotaProvidersConfig = Partial<
  Record<"claude" | "codex" | "agy" | "kimi", DashboardQuotaProviderConfig>
>;

export interface ChatConfig {
  /** GCP project that hosts the Pub/Sub topic + subscription. */
  projectId: string;
  /** Pull subscription id that receives Workspace Events chat messages. */
  subscription: string;
  /**
   * Pub/Sub topic id the Workspace Events subscription delivers chat messages
   * to (the `subscription` pull-subscribes to this). Defaults to "chat-events".
   * rusa keeps the Workspace Events subscription against this topic alive
   * (4h TTL → renewal loop).
   */
  topic?: string;
  /** Path to the chat-puller service-account key JSON (Pub/Sub auth). */
  pubsubKeyPath: string;
  /**
   * Directory holding the gchat user-OAuth creds (client.json + token.json,
   * minted by `gchat-auth`), used for outbound Chat REST calls (react/send).
   * Defaults to ~/.config/gchat.
   */
  gchatConfigDir?: string;
  /**
   * Chat space (resource name, e.g. `spaces/AAAA`) that receives mechanical
   * failure notices when the *root* actor's run fails — the root has no parent
   * inbox to fall back to. Rote, not judgment: the failure sink posts here
   * directly without the agent. Unset → root failures are journal-only.
   */
  errorChat?: string;
  /**
   * Configuration-driven root grant. A single string "all", or an array of
   * specific space resource names (e.g. `["spaces/AAAA"]`). Grants the root
   * actor the ability to send messages to those spaces.
   */
  gchat?: "all" | string[];
  /**
   * Space resource names (e.g. `["spaces/AAAA_STAGING"]`) to ignore at ingestion.
   * When an inbound message is received from any of these spaces, it is dropped
   * early in `onChat` before trigger evaluation, halt handling, or mesh delivery.
   * Used by production instances sharing a Workspace Events subscription topic
   * to avoid processing messages meant for a staging instance.
   */
  excludedSpaces?: string[];
}

export interface DashboardConfig {
  /** Port to serve the dashboard on (default: 8080) */
  port: number;
  /** Host/interface to bind the dashboard server to (default: 127.0.0.1). */
  bindHost?: string;
  /**
   * Per-provider quota UI config . Each provider owns the window selected
   * for its header ring; there is intentionally no global primary provider.
   * kimi is deliberately unsupported here because probing it can mutate auth.
   */
  quotaProviders?: DashboardQuotaProvidersConfig;
  /**
   * MagicDNS hostname of this machine on the Tailscale network
   * (e.g. "my-server.tailnet-name.ts.net").
   * When set, `rusa install-service` configures `tailscale serve`
   * automatically and the dashboard URL is shown as https://<tailscaleHostname>/.
   */
  tailscaleHostname?: string;
  /**
   * Optional Tailscale Service name (without the "svc:" prefix), e.g.
   * "rusa-staging". When set, `rusa install-service` will
   * attach the dashboard to that Tailscale Service on HTTPS port 443.
   */
  tailscaleServiceName?: string;
}

export interface GlassGoalsConfig {
  username: string;
  firebaseServiceAccountKeyPath?: string;
  /**
   * The root node ID of the knowledge graph in glass_goals.
   * Set by `rusa understanding seed-from-ops` and used by the distiller
   * to anchor subsequent runs to the correct conceptual root.
   */
  rootNodeId?: string;
}

export interface UnderstandingMountConfig {
  /**
   * Whether to mount the Integrated Understanding as a read-only filesystem
   * inside sandboxed worker containers at /tmp/understanding.
   * Default: false.
   */
  enabled?: boolean;
}

export interface UnderstandingConfig {
  /**
   * Provider-neutral root node used to scope IU reads and dashboard rendering.
   * Local-only instances can set this without configuring a Glass Goals remote.
   * When omitted, the legacy glassGoals.rootNodeId remains the fallback.
   */
  rootNodeId?: string;
  /**
   * Remote Glass Goals persistence settings for Integrated Understanding.
   */
  glassGoals?: GlassGoalsConfig;
  /**
   * Read-only filesystem mount prototype settings.
   */
  mount?: UnderstandingMountConfig;
  // The nightly distiller's chat read set is NOT configured here. It is every
  // space the Chat identity is a member of, enumerated per run via `list_spaces`
  // (see chat/spaces.ts). The former `chatSpaces` allowlist carved personal
  // spaces out of the read set up front; Operator's ruling replaces that with
  // per-message judgment at distillation time, so nothing is excluded before the
  // distiller has looked at it. A run that cannot enumerate membership reports
  // unknown — never an empty read set.
}

export interface SmokeTestConfig {
  enabled: boolean;
  /** Max seconds to wait for the test instance to start */
  startupTimeoutSeconds?: number; // default: 30
  /** Max seconds for the entire smoke test run */
  testTimeoutSeconds?: number; // default: 120
  /** If true, runtime probe failures after max rounds block for manual intervention */
  blockOnExhaustedRetries?: boolean; // default: true
  /** Port to use for probing the runtime instance (defaults to 3000) */
  runtimeProbePort?: number;
  /** Command to start the runtime instance (defaults to "node index.js" or "pnpm start" if available) */
  runtimeCommand?: string;
}

export interface InvocationDebugConfig {
  /** Capture full invocation prompts, raw provider streams, and rendered transcripts. Default: true. */
  enabled?: boolean;
  /** Number of days to retain full invocation artifacts. Default: 30. */
  retentionDays?: number;
  /** Maximum bytes to store per invocation artifact directory. Default: 200MB. */
  maxBytesPerInvocation?: number;
}

export interface DiskAlertConfig {
  /** Enable disk-usage alert. Defaults to true. */
  enabled?: boolean;
  /** The path to the relevant volume to check. Defaults to "/". */
  volume?: string;
  /** Free disk space percentage threshold (0-100). Defaults to undefined. */
  thresholdPercent?: number;
  /** Free disk space threshold in bytes. Evaluated along with thresholdPercent if both are set. Defaults to 2G (2,147,483,648 bytes) when neither threshold is set. */
  thresholdBytes?: number;
  /** Scan interval in seconds. Defaults to 600 (10 mins). */
  intervalSeconds?: number;
  /** Cooldown in seconds before alerting again after a threshold is crossed. Defaults to 21600 (6 hours) */
  cooldownSeconds?: number;
}

export interface ObservabilityConfig {
  diskAlert?: DiskAlertConfig;
  logging?: LoggingConfig;
}

/** Application logger settings. See `docs/logging.md`. */
export interface LoggingConfig {
  /**
   * Minimum level recorded: `debug`, `info` (default), `warn`, `error`, or
   * `silent`. The `RUSA_LOG_LEVEL` environment variable overrides it, so an
   * operator can raise verbosity for one run without editing config.
   */
  level?: string;
  /**
   * How records are rendered: `json`, `pretty`, or `auto` (the default —
   * `pretty` when stdout is a terminal, `json` otherwise). This picks the
   * presentation of the one record stream; it never duplicates a record.
   * The `RUSA_LOG_FORMAT` environment variable overrides it.
   */
  format?: string;
}

export interface RootActorConfig {
  /**
   * Which configured provider the root actor runs on — a key in `providers`
   * (e.g. "antigravity", "claude"). Defaults to "antigravity" (the `agy` CLI).
   * The root model is config-driven and intentionally independent of the
   * persona/quota model routing.
   */
  provider: string;
  /**
   * Optional model id for the root provider (passed to the CLI's --model).
   * Omit to use the provider's own default model.
   */
  model?: string;
  /**
   * Optional provider-native reasoning level, independent of `model`.
   * Omit to preserve the provider/model default.
   */
  effort?: string;
  /**
   * Optional fallback model(s) the root tries, in order, when the primary
   * `model` is overloaded or unavailable. Keeps a strong root responsive under
   * transient throttling by degrading that turn to a weaker model instead of
   * failing. A single id or an ordered list; only honoured by providers that
   * support it.
   */
  fallbackModel?: string | string[];
  /**
   * Working-memory ownership and policy for the root. Omit for the native,
   * provider-session-backed default; portable roots run stateless and receive
   * mesh-managed context using the same ledger/tail modes as spawned actors.
   */
  context?: ContextConfig;
  /**
   * The root actor's standing charter (its identity + how it should behave),
   * prepended to every wake. Per-instance customization — the identity is the
   * specific instance, not the "rusa" system. Omit to use the built-in
   * default (`ROOT_ACTOR_CHARTER`).
   */
  charter?: string;
  /**
   * Optional display handle for this instance's root actor, overriding the
   * default derived from `generateHandle("root")` (`root-actor`). Lets a
   * secondary instance (e.g. a staging deploy sharing the same bot account)
   * present under its own identity — GitHub signing byline, dashboard display,
   * avatar — instead of the default persona. Resolve via `resolveRootHandle`
   * rather than reading this field directly; omit to leave every root-identity
   * surface unchanged .
   */
  handle?: string;
  /**
   * Optional path to a root avatar image, overriding the bundled default
   * (`assets/silicon-familiar.jpg`). Falls back to the bundled image when
   * unset or when the path doesn't resolve to an existing file.
   */
  avatar?: string;
}

/**
 * Walkie-talkie voice settings . Entirely optional — the feature itself
 * is gated on `geminiApiKey` being present; these only override the model and
 * voice defaults. No secrets live here.
 */
export interface VoiceConfig {
  /** Audio-capable Gemini model for memo transcription. Default "gemini-2.5-flash". */
  transcriptionModel?: string;
  /** Gemini TTS model for reply audio. Default "gemini-3.1-flash-tts-preview". */
  ttsModel?: string;
  /** Prebuilt Gemini voice name (Laomedeia, Charon, Puck, Kore, ...). Default "Laomedeia". */
  voiceName?: string;
}

export interface RusaConfig {
  /** Optional named config profile. "quickstart" enables the local quick-start profile. */
  profile?: string;
  github: GitHubConfig;
  providers: Record<string, ProviderConfig>;
  /** Branch the root self-update tool deploys from. Defaults to "master". */
  deployBranch?: string;
  /**
   * Gemini API key. Optional (ISSUE_NUM-adjacent): enables LLM-based quota-error
   * classification, avatar generation, and understanding retrieval/distill —
   * each degrades or skips gracefully when absent. Omit on an instance that
   * doesn't need those (e.g. a staging deploy).
   */
  geminiApiKey?: string;
  /** Mistral API key. Optional; grantable to sandboxed actors as MISTRAL_API_KEY. */
  mistralApiKey?: string;
  webhook: WebhookConfig;
  /** Which provider/model the root actor runs on (optional; defaults to agy). */
  rootActor?: RootActorConfig;
  /** Google Chat inbound/outbound integration (optional; disabled if absent). */
  chat?: ChatConfig;
  dashboard?: DashboardConfig;
  /** Shared provider-quota storage and identity. */
  quota?: QuotaConfig;
  /** Walkie-talkie voice tuning ; the feature is gated on geminiApiKey. */
  voice?: VoiceConfig;
  smokeTest?: SmokeTestConfig;
  invocationDebug?: InvocationDebugConfig;
  /** Observability automation controls. */
  observability?: ObservabilityConfig;
  /** Provider-neutral Integrated Understanding settings. */
  understanding?: UnderstandingConfig;
  /**
   * @deprecated Legacy top-level Glass Goals configuration.
   * Prefer nesting under `understanding.glassGoals` . Retained as a compatibility fallback.
   */
  glassGoals?: GlassGoalsConfig;
  /**
   * Named model classes: an operator-defined label for a modelConfig pool, so a
   * spawn can ask for `{ class: "fast" }` instead of restating a provider/model
   * tuple. Optional and never implicit — a caller that omits `model_config`
   * still gets no default, and editing a class here does not retro-apply to
   * actors that already resolved it.
   *
   * Entries are the same {@link ProviderModelConfig} tuple a resolved pool is
   * made of, deliberately shared rather than redeclared: a class is just a
   * named pool, and config loading validates it through the very same
   * `validateModelConfigPool` the runtime uses, so the two cannot drift as pool
   * fields evolve. `model` is required for the same reason it is required at
   * spawn — a class is an explicit, named selection and must never resolve to a
   * provider's own default.
   */
  modelClasses?: Record<string, ProviderModelConfig[]>;
  /** Mesh safety/throughput controls (concurrency cap, provider rate limit). */
  mesh?: MeshConfig;
  /** Worker isolation mode. Defaults to "bwrap". */
  sandbox?: SandboxMode;
  /** If true, serve local git bare repositories via a local Git HTTP server and redirect sandbox clones to them. */
  gitBridge?: boolean;
  /** Port the local Git HTTP server binds to (default: 8085). */
  gitBridgePort?: number;
  /** Host/interface the local Git HTTP server binds to (default: 127.0.0.1). */
  gitBridgeBindHost?: string;
}

/** Tunables for the actor mesh's safety governors; all fields optional. */
export interface MeshConfig {
  /** Cross-actor concurrency cap for non-responsive runs. Default 4. */
  maxConcurrent?: number;
}
