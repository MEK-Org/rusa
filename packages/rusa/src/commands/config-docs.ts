export const CONFIG_DOCS = `
Rusa config file

Location:
  RUSA_HOME/config.yaml, or ~/.rusa/config.yaml when RUSA_HOME is unset.

Related files:
  RUSA_HOME/.env is loaded before config validation.
  RUSA_HOME/invocations/<invocation-id>/ stores invocation debug artifacts when enabled.

Minimal example:

  # Optional. "quickstart" enables the local quick-start profile.
  # profile: quickstart

  github:
    account: CodeChopsBot
    pollIntervalSeconds: 300
    # ingestionMode: poll  # webhook (default) or poll
    repos:
      - example-org/example-repo
    # orgs:
    #   - org: example-org
    #     excludedRepos: [example-org/ignored-repo]

  providers:
    claude:
      cliCommand: claude
    copilot:
      cliCommand: copilot

  # Instances sharing provider credentials should use the same quota DB and pool id.
  quota:
    databasePath: /home/rusa/.rusa-shared/quota.db
    throttle:
      enabled: true
      maxIntervalSeconds: 3600
      tickSeconds: 300

  geminiApiKey: GEMINI_API_KEY_VALUE

  # Branch used by the root self-update tool (optional; defaults to master).
  deployBranch: master

  # Which provider/model the root actor runs on (optional; defaults to agy).
  rootActor:
    provider: antigravity
    # model: "Gemini 3.1 Pro (High)"   # optional; omit for the provider default
    # context:                       # optional; omit for native provider sessions
    #   type: portable
    #   mode: ledger                # ledger (requires geminiApiKey) or tail
    #   compactionModel: gemini-3.1-flash-lite
    # handle: ember-familiar           # optional; a secondary instance's own display handle 
    # avatar: /path/to/ember.jpg       # optional; overrides the bundled root avatar image

  webhook:
    port: 9742
    secret: GENERATED_SECRET
    externalUrl: https://example.ngrok-free.app/webhook

  dashboard:
    port: 8080
    quotaProviders:
      claude:
        primaryWindow: weekly
      codex:
        primaryWindow: weekly
      agy:
        primaryWindow: weekly

  # Walkie-talkie voice tuning . Optional; the feature itself is gated on
  # geminiApiKey being set. Defaults shown.
  # voice:
  #   transcriptionModel: gemini-2.5-flash
  #   ttsModel: gemini-3.1-flash-tts-preview
  #   voiceName: Laomedeia

  invocationDebug:
    enabled: true
    retentionDays: 30
    maxBytesPerInvocation: 209715200

  observability:
    diskAlert:
      # enabled: true
      # volume: "/"
      # thresholdPercent: 10
      # thresholdBytes: 2000000000
      # intervalSeconds: 600
      # cooldownSeconds: 21600

Top-level fields:

  profile                  Optional. Named config profile. "quickstart" enables local git bridge delivery
                           and GitHub poll ingestion unless explicitly overridden.
  github                   Required. GitHub polling and bot identity.
  providers                Required. Coding providers available to tasks.
  quota                    Optional. Shared quota evidence, persisted controller state, and launch coordination.
  mesh                     Optional. Mesh concurrency settings.
  geminiApiKey             Optional. Enables Gemini features (quota-error classification, avatar generation, understanding retrieval/distill); each skips gracefully when absent.
  deployBranch             Optional. Branch the root self-update tool deploys from. Defaults to master.
  webhook                  Required. Local webhook listener settings.
  rootActor                Optional. Provider/model the root actor runs on and its display identity. Provider
                           defaults to agy (antigravity); identity defaults to root-actor.
  chat                     Optional. Google Chat Workspace Events ingestion and REST write settings.
  dashboard                Optional. Dashboard listener and Tailscale settings.
  voice                    Optional. Walkie-talkie transcription/TTS model and voice overrides .
                           The feature is enabled by geminiApiKey; this section only tunes it.
  invocationDebug          Optional. Full invocation artifact capture controls.
  observability            Optional. Operational alerting controls.
  understanding            Optional. Integrated Understanding settings (rootNodeId, glassGoals backend).
  glassGoals               Optional legacy IU storage section (prefer nesting under understanding.glassGoals).
  smokeTest                Optional legacy runtime smoke-test settings.

github:

  account                  GitHub username used by this Rusa instance, for example CodeChopsBot.
  pollIntervalSeconds      Optional. GitHub poll interval in seconds when ingestionMode is poll; defaults to 300. Must be a positive number when set.
  ingestionMode            Optional. "webhook" (default) binds the webhook listener; "poll" fetches GitHub updates without binding it.
  repos                    Optional list. GitHub repositories in owner/name format to subscribe to and poll. The poller also watches deployBranch head changes for these explicit repositories.
  orgs                     Optional list of objects. Each requires org and may include excludedRepos. Organization repositories are subscribed to and polled; exclusions are suppressed at webhook and poll ingestion.
  workerTokenPath          Optional. Path to read-mostly fine-grained GitHub PAT file visible to sandboxed workers.

providers:

  providers is a map from provider name to provider configuration. The provider name is the
  logical name used by model routing, while cliCommand selects the executable for CLI providers.

  cliCommand               Required. The CLI executable. Example: claude, codex, agy, kimi, copilot.
  dailyCap                 Optional string budget marker, for example "$50".

quota:

  databasePath             Dedicated SQLite path for quota evidence and controller decisions; required when
                           quota.throttle.enabled is true. Instances sharing provider credentials should point at
                           the same file outside either RUSA_HOME.
                           Relative paths resolve against RUSA_HOME; ~/ and absolute paths are supported.
quota.throttle:

  enabled                  Optional boolean. Enables persisted closed-loop launch pacing.
  maxIntervalSeconds       Optional cap on normal launch spacing; defaults to 3600.
  tickSeconds              Optional positive integer quota refresh interval.

rootActor:

  provider                 Required. Provider key (in providers) the root actor runs on.
  model                    Optional. Model id passed to the provider CLI's --model. Provider default if omitted.
  fallbackModel            Optional string or list. Model(s) the root actor falls back to when the primary
                           model is overloaded or unavailable, tried in order via a freshly resolved
                           provider (root-only — ISSUE_NUM; providers.<name>.fallbackModel is rejected).
  context                  Optional. Working-memory policy. Omit for native provider sessions, or set
                           {type: portable, mode: ledger|tail}. Ledger mode requires geminiApiKey and
                           optionally accepts compactionModel; tail mode never compacts.
  charter                  Optional. The root actor's standing charter, prepended to every wake. Built-in
                           default if omitted.
  handle                   Optional. Overrides the root actor's display handle (default: derived, "root-actor").
                           Lets a secondary instance sharing the bot account (e.g. staging) present under its own
                           identity in GitHub signing bylines, the dashboard, and its avatar .
                           Also titles the dashboard page and names the installed PWA ("Ember Familiar").
  avatar                   Optional. Path to a root avatar image, overriding the bundled default. Falls back to
                           the bundled image when unset or the path doesn't resolve to an existing file.
                           A root image — this or one uploaded from the dashboard — also becomes the dashboard's
                           favicon and app icon (#48).

webhook:

  port                     Required. Local HTTP port for GitHub webhooks and API routes.
  secret                   Required. GitHub webhook secret.
  externalUrl              Optional. Public webhook URL, typically an ngrok or Tailscale URL.
  ignoreSelfEvents         Optional. Suppress events from this instance's own bot account (default true). Set false on a secondary instance that shares the account (e.g. staging) so cross-instance direction isn't filtered as self-activity .

chat:

  projectId                Required. GCP project that hosts the Pub/Sub topic + subscription.
  subscription             Required. Pull subscription id that receives Workspace Events chat messages.
                           For multi-instance setups (e.g. prod and staging), configure dedicated
                           subscriptions against the shared topic so instances do not compete for messages.
  topic                    Optional. Pub/Sub topic id the Workspace Events subscription delivers to.
                           Defaults to "chat-events".
  pubsubKeyPath            Required. Path to the chat-puller service-account key JSON (Pub/Sub auth).
  gchatConfigDir           Optional. Directory holding gchat user-OAuth tokens (minted by gchat-auth).
                           Defaults to ~/.config/gchat.
  errorChat                Optional space resource name (e.g. spaces/AAAA) that receives mechanical failure notices.
  gchat                    Optional. "all" or a list of space resource names (e.g. ["spaces/AAAA"]) granting
                           the root actor outbound write capability to those spaces.
  excludedSpaces           Optional list of space resource names (e.g. ["spaces/AAAA_STAGING"]). Inbound
                           messages from these spaces are dropped early before mesh delivery.

dashboard:

  port                     Required when dashboard is present. Default from init: 8080.
  quotaProviders           Optional. Per-provider quota UI config for the header rings.
                           Supported providers: claude, codex, agy. kimi is intentionally unsupported.
                           Each provider entry carries primaryWindow; each defaults to weekly.
  tailscaleHostname        Optional MagicDNS hostname used by install-service for tailscale serve.
  tailscaleServiceName     Optional Tailscale Service name, without the "svc:" prefix.

invocationDebug:

  enabled                  Optional boolean. Capture prompts, raw stdout/stderr, rendered transcript,
                           metadata, and failure patches for every provider invocation. Default: true.
  retentionDays            Optional number. Delete invocation artifact directories older than this.
                           Default: 30.
  maxBytesPerInvocation    Optional number. Hard cap in bytes across prompt, transcript, raw streams,
                           and failure patch for one invocation. Default: 209715200 (200 MB).

observability.diskAlert:

  Configuring this section implicitly subscribes root to responsive system.disk events.
  enabled                  Optional boolean. Disk headroom alert is enabled by default;
                           set enabled: false to deactivate.
  volume                   Optional string. The path to the relevant volume to check.
                           Default: "/".
  thresholdPercent         Optional number. Free disk space percentage threshold (0-100).
                           Default: undefined.
  thresholdBytes           Optional number. Free disk space threshold in bytes. Evaluated
                           along with thresholdPercent if both are set. Default: 2147483648 (2 GB)
                           when neither threshold is set.
  intervalSeconds          Optional number. Scan cadence. Default: 600 (10 minutes).
  cooldownSeconds          Optional number. Cooldown in seconds before alerting again
                           after a threshold is crossed. Default: 21600 (6 hours).

understanding:

  rootNodeId               Optional provider-neutral IU scope anchor. Local-only
                           instances can set this without configuring glassGoals.
                           Existing glassGoals.rootNodeId remains a compatibility fallback.
                           The nightly distiller's chat read set is not configured
                           here: it is every space the Chat identity is a member of,
                           enumerated per run via chat-read's list_spaces. What
                           belongs in a durable node is decided per message at
                           distillation time, not per space up front.

understanding.glassGoals:

  username                 Required when understanding.glassGoals is present.
  firebaseServiceAccountKeyPath
                           Optional path to a Firebase service account key.
  rootNodeId               Legacy remote-backed knowledge graph root. Usually written
                           by rusa understanding seed-from-ops.

glassGoals:

  Legacy top-level Integrated Understanding storage section. Retained as a compatibility
  fallback; prefer nesting under understanding.glassGoals .
  username                 Required when glassGoals is present.
  firebaseServiceAccountKeyPath
                           Optional path to a Firebase service account key.
  rootNodeId               Legacy remote-backed knowledge graph root. Usually written
                           by rusa understanding seed-from-ops.

smokeTest:

  This block is retained for compatibility with older runtime smoke-test flows.

  enabled                  Required when smokeTest is present.
  startupTimeoutSeconds    Optional. Default: 30.
  testTimeoutSeconds       Optional. Default: 120.
  blockOnExhaustedRetries  Optional. Default: true.
  runtimeProbePort         Optional. Default: 3000.
  runtimeCommand           Optional command used to start the runtime under test.

Operational notes:

  Run rusa init to create or update config.yaml interactively.
  Run rusa init --non-interactive --defaults for a generated default config.
  Run RUSA_HOME=/path/to/home rusa start to use a non-default home directory.

Multi-instance staging recipe:

  When running multiple Rusa instances (such as production and staging) on the same network/GCP project:
  1. Dedicated Pub/Sub subscription on staging:
     Configure chat.subscription to a dedicated pull subscription (e.g. rusa-chat-staging)
     against the shared chat-events topic so staging and prod do not compete for messages.
  2. Excluded spaces on prod:
     Configure chat.excludedSpaces: ["spaces/AAAA_STAGING"] on prod so messages sent in the staging
     test space are ignored by the production instance.
  3. Outbound permission scoping:
     Scope chat.gchat (e.g. ["spaces/AAAA_STAGING"] on staging) to restrict where each instance can post.
`;

export function printConfigDocs(): void {
  console.log(CONFIG_DOCS.trim());
}
