import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Actor } from "../actor/actor.js";
import { ActorMesh, type MeshActor, type RetireCleanup } from "../actor/actor-mesh.js";
import {
  CAPABILITY_GRANTS_FILENAME,
  FileCapabilityGrantStore,
  PARENT_GRANTABLE_CAPABILITIES,
} from "../actor/capability-grants.js";
import { CoalescingNotifier } from "../actor/coalescing-notifier.js";
import { assertSpawnContextSupported } from "../actor/context-selection.js";
import { E2EInstanceManager } from "../actor/e2e-instance-manager.js";
import {
  type EventResource,
  FileEventSubscriptionStore,
  isSubResourceOf,
  normalizeEventResource,
  reconcileEventSources,
  resourceKey,
} from "../actor/event-subscriptions.js";
import { ExternalRootDriver } from "../actor/external-root-driver.js";
import {
  type FailureSinkDeps,
  formatProviderLabel,
  routeContinuationCapped,
  routeRunFailure,
} from "../actor/failure-sink.js";
import { GracefulShutdown } from "../actor/graceful-shutdown.js";
import { type HaltCommand, HaltSwitch, parseHaltCommand } from "../actor/halt-switch.js";
import {
  DEFAULT_ROOT_CHARTER,
  generateHandle,
  resolveRootHandle,
} from "../actor/handle-generator.js";
import { handleHostJobExit } from "../actor/host-job-exit.js";
import { ensureWakeOnExitScript } from "../actor/host-job-runner.js";
import { FileHostJobStore } from "../actor/host-job-store.js";
import type { InboxEntry, InboxStore } from "../actor/inbox-store.js";
import {
  type MeshEventSink,
  type RunAbandonedPayload,
  runEndPayload,
} from "../actor/mesh-events.js";
import {
  assemblePortableContext,
  assemblePortableContextV2,
  type InjectRecord,
  PORTABLE_CONTEXT_FOLD_MAX_BYTES,
  PORTABLE_CONTEXT_FOLD_MAX_PAGES,
  portableContextMaxMessages,
  portableContextMaxRuns,
} from "../actor/portable-context.js";
import {
  describeCompaction,
  GeminiPortableContextCompactor,
  type PortableContextCompactionSummary,
  type PortableContextCompactor,
  type QuarantinedOperation,
  quarantineCountsByClass,
  resolvePortableContextCompactorModel,
} from "../actor/portable-context-compactor.js";
import {
  FilePortableContextStore,
  type PortableContextStore,
} from "../actor/portable-context-state.js";
import { ProviderPacer } from "../actor/provider-pacer.js";
import type { QuotaThrottleStatus, QuotaThrottleTick } from "../actor/quota-throttle-status.js";
import { RootControlService } from "../actor/root-control.js";
import { buildRootPrompt } from "../actor/root-prompt.js";
import {
  FileThreadRegistry,
  type PortableContextConfig,
  resolveRootThreadId,
  type ThreadRecord,
} from "../actor/thread-registry.js";
import {
  CrontabWakeCron,
  ensureWakeToken,
  execCrontabIo,
  wakePortPath,
  wakeTokenPath,
  writeWakePort,
} from "../actor/wake-cron.js";
import { buildWorkerPrompt, resolveHandleLabels } from "../actor/worker-prompt.js";
import type { ActorLiveness } from "../actor/workspace-sweep.js";
import {
  removableWorkspaceNames,
  sweepOrphanedWorkspaces,
  unattributedCheckouts,
} from "../actor/workspace-sweep.js";
import { backfillAvatars, kickAvatarGeneration } from "../avatar/avatars.js";
import { GoogleCalendarClientProvider } from "../calendar/calendar-client.js";
import { GchatClient, loadGchatIdentity } from "../chat/gchat-client.js";
import { GchatOAuth } from "../chat/gchat-oauth.js";
import { PubsubChatSource } from "../chat/pubsub-source.js";
import { listAllChatSpaces } from "../chat/spaces.js";
import type { ChatClient, ChatMessage, ChatSource } from "../chat/types.js";
import { WorkspaceEventsSubscriber } from "../chat/workspace-events.js";
import { type ConfigProfile, loadConfig, type RusaConfig, resolveHome } from "../config/index.js";
import { DEFAULT_DEPLOY_BRANCH } from "../config/types.js";
import { MeshEventEmitter } from "../dashboard/mesh-event-emitter.js";
import type { QuotaApiDeps } from "../dashboard/quota-api.js";
import { closeDb, getDb, getRepositories, initDb } from "../db/index.js";
import { isSelfAuthoredLedgerSource } from "../db/repositories/mesh-event-repository.js";
import type { ReadyHeadChange } from "../db/repositories/obligation-repository.js";
import { GoogleDriveClient } from "../drive/drive-client.js";
import { GoogleGmailClient } from "../email/gmail-client.js";
import {
  checkSuiteWakesAnyone,
  deriveGitHubInboxNotification,
} from "../github/inbox-notification.js";
import { startGitHubEventPoller } from "../github/poller.js";
import { startGitHttpServer } from "../gitops/git-http-server.js";
import {
  GitBridgeIssueClient,
  type GitHubPollingIssueClient,
  getIssueClient,
  type IssueClient,
} from "../gitops/issue-client.js";
import { initEmptyBareRepo } from "../gitops/worktree.js";
import { AGENT_EXEC_MCP_NAME, createAgentExecMcpServer } from "../mcp/agent-exec-mcp.js";
import {
  CHAT_READ_MCP_NAME,
  CHAT_WRITE_MCP_NAME,
  createChatReadMcpServer,
  createChatWriteMcpServer,
} from "../mcp/chat-mcp.js";
import type { DistillerMcpStore } from "../mcp/distiller-mcp.js";
import {
  buildGrantableServers,
  handleCapabilityRevoked,
  mountGrantedServers,
} from "../mcp/grantable-servers.js";
import { McpHttpServer } from "../mcp/http-server.js";
import { createInboxMcpServer, INBOX_MCP_NAME } from "../mcp/inbox-mcp.js";
import { createMeshChatMcpServer, MESH_CHAT_MCP_NAME } from "../mcp/mesh-chat-mcp.js";
import { createObligationsMcpServer, OBLIGATIONS_MCP_NAME } from "../mcp/obligations-mcp.js";
import {
  createPnpmHardlinksMcpServer,
  PNPM_HARDLINKS_MCP_NAME,
  type PnpmHardlinksToolDeps,
} from "../mcp/pnpm-hardlinks-mcp.js";
import { createPnpmInstallMcpServer, PNPM_INSTALL_MCP_NAME } from "../mcp/pnpm-install-mcp.js";
import { createQuotaMcpServer, createQuotaService, QUOTA_MCP_NAME } from "../mcp/quota-mcp.js";
import { createRepoMcpServer, REPO_MCP_NAME } from "../mcp/repo-mcp.js";
import { resolveStampedAuthor, stampAuthor } from "../mcp/stamp.js";
import {
  createStuckLoopDetectorMcpServer,
  STUCK_LOOP_DETECTOR_MCP_NAME,
} from "../mcp/stuck-loop-detector-mcp.js";
import { createTrackerMcpServer, TRACKER_MCP_NAME } from "../mcp/tracker-mcp.js";
import {
  createUnderstandingReadServer,
  createUnderstandingSyncClientProvider,
  UNDERSTANDING_READ_MCP_NAME,
} from "../mcp/understanding-mcp.js";
import { createUpdateMcpServer, UPDATE_MCP_NAME, type UpdateToolDeps } from "../mcp/update-mcp.js";
import { resolveObligationOwner } from "../obligations/owner.js";
import { DiskUsageAlert } from "../observability/disk-alert.js";
import { antigravityScratchDir } from "../providers/antigravity.js";
import { createExhaustionClassifier } from "../providers/exhaustion-classifier.js";
import {
  ingestKimiHostModels,
  populateModelCatalogsFromDb,
  validateModelPin,
} from "../providers/model-catalog.js";
import { refreshConfiguredProviderModelCatalogs } from "../providers/model-scrape.js";
import {
  DEFAULT_ROOT_PROVIDER,
  normalizeFallbackModel,
  resolveProvider,
  resolveRootProvider,
} from "../providers/registry.js";
import { assertBwrapAvailable, teardownFlutterOverlay } from "../providers/sandbox.js";
import type { McpServerSpec } from "../providers/types.js";
import { resolveQuotaDatabasePath, SharedQuotaStore } from "../quota/shared-store.js";
import { asGitHubIssue, parseReference } from "../references/reference.js";
import { createCommitmentPolarityEvaluator } from "../understanding/commitment-polarity.js";
import {
  DistillerCursorStore,
  latestOpCreatedAt,
  resolveSeed,
} from "../understanding/distiller-cursor.js";
import { SUBSTANTIVE_EVENT_KINDS } from "../understanding/distiller-ops.js";
import {
  createUnderstandingOpsReader,
  createUnderstandingStringsResolver,
  getLocalUnderstandingUnsyncedCount,
  getLocalUnderstandingWriteClient,
  iuReportPaths,
} from "../understanding/persistence-utils.js";
import {
  resolveGlassGoalsConfig,
  resolveUnderstandingRootNodeId,
} from "../understanding/root-scope.js";
import { renderUnderstandingSnapshot } from "../understanding/snapshot.js";
import { readBuildSentinel } from "../update/build-sentinel.js";
import { MeshDrainer } from "../update/drain.js";
import { recordRestartAndCheckFlap } from "../update/flap-detector.js";
import { BuildRunner, GitRunner } from "../update/runner.js";
import { createVoiceService } from "../voice/wiring.js";
import {
  directiveBodyForWebhookPayload,
  parseDirectedDeliveryDirective,
} from "../webhook/directed-delivery.js";
import {
  createDashboardRequestHandler,
  startDashboardServer,
  startWebhookServer,
} from "../webhook/server.js";
import {
  WEBHOOK_SILENCE_CHECK_INTERVAL_MS,
  WebhookSilenceDetector,
} from "../webhook/silence-detector.js";
import { resolveRepoRoot } from "./service-instance.js";

// `update` tool bounds . Per-step HARD timeouts so a hung build can't wedge
// root; a bounded drain so a stuck worker can't block the restart forever.
const UPDATE_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const UPDATE_BUILD_TIMEOUT_MS = 20 * 60 * 1000;
const UPDATE_DRAIN_TIMEOUT_MS = 60 * 1000;

// v1 explicit never-notify list : bot-sender tracker-churn event types
// generated by ownership automation. Keep this SMALL and explicit —
// unknown event types still reach exact subscribers, but do not bubble ;
// extend this sender-level drop only with a ruling. See the
// consuming block in `onEvent` for the full rationale and the workaround
// (post a stamped comment to force delivery).
const BOT_SUPPRESSED_EVENT_TYPES = new Set(["issues/labeled", "issues/unlabeled", "issues/closed"]);

// Sender-independent event classes that should never become actor notifications.
// Keep this data-driven  so adding the next ruled class is a one-line change.
const NEVER_DELIVERED_EVENT_TYPES = new Set(["check_run/created", "check_run/completed"]);

// Slow-flap detector (ISSUE_NUM, elder #6): alert when the mesh restarts too often in a
// longer window than systemd's fast StartLimit (5/300s) covers — catches a service
// that boots, runs, then dies every ~minute, which the fast window never trips.
const FLAP_WINDOW_MS = 60 * 60 * 1000;
const FLAP_THRESHOLD = 5;

const QUOTA_THROTTLE_PROVIDERS = ["claude", "codex", "agy", "kimi"] as const;
type QuotaThrottleProvider = (typeof QUOTA_THROTTLE_PROVIDERS)[number];

/** Fire-and-forget v1 receipts: seen_at is durable, reaction delivery is not retried. */
export function reactToQueuedInboxEntries(
  issueClient: Pick<IssueClient, "addReaction" | "addCommentReaction">,
  entries: readonly InboxEntry[],
  warn: (message: string) => void = console.warn,
  chatClient?: Pick<ChatClient, "react">
): void {
  for (const entry of entries) {
    const target = queuedReactionTarget(entry);
    if (!target) continue;
    try {
      const receipt =
        target.kind === "gchat"
          ? chatClient?.react(target.messageName)
          : target.kind === "comment"
            ? issueClient.addCommentReaction(target.repo, target.commentId, "eyes", target.scope)
            : issueClient.addReaction(target.repo, target.issueNumber, "eyes");
      if (!receipt) continue;
      void receipt.catch((err) => {
        warn(
          `[webhook] queued inbox reaction failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    } catch (err) {
      warn(
        `[webhook] queued inbox reaction failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

type QueuedReactionTarget =
  | { kind: "issue"; repo: string; issueNumber: number }
  | { kind: "comment"; repo: string; commentId: number; scope: "issue" | "review" }
  | { kind: "gchat"; messageName: string };

/**
 * Derive the queue-time receipt from the actual inbox pointer. The inbox never
 * stores a second reaction-target object that can drift from these identifiers.
 */
function queuedReactionTarget(entry: InboxEntry): QueuedReactionTarget | null {
  const { payload } = entry;
  if (payload.type === "gchat.message") {
    return typeof payload.messageName === "string"
      ? { kind: "gchat", messageName: payload.messageName }
      : null;
  }

  let source: { repo: string; number: number } | null = null;
  try {
    const ref = parseReference(normalizeEventResource(entry.source));
    const issueRef = asGitHubIssue(ref);
    if (issueRef) {
      source = { repo: `${issueRef.owner}/${issueRef.repo}`, number: issueRef.number };
    }
  } catch {
    source = null;
  }
  const commentId =
    typeof payload.commentId === "number" && Number.isSafeInteger(payload.commentId)
      ? payload.commentId
      : null;
  if (!source) return null;

  const event = payload.type.split(".", 1)[0];
  if (event === "issue_comment" && commentId !== null) {
    return { kind: "comment", repo: source.repo, commentId, scope: "issue" };
  }
  if (event === "pull_request_review_comment" && commentId !== null) {
    return { kind: "comment", repo: source.repo, commentId, scope: "review" };
  }
  if (event === "issues" || event === "pull_request" || event === "pull_request_review") {
    return { kind: "issue", repo: source.repo, issueNumber: source.number };
  }
  return null;
}

function isQuotaThrottleProvider(value: string): value is QuotaThrottleProvider {
  return (QUOTA_THROTTLE_PROVIDERS as readonly string[]).includes(value);
}

/** Map configured provider names to the canonical quota-probe keys. */
function providerThrottleKey(providerName: string, config: RusaConfig): string {
  const cliCommand = config.providers[providerName]?.cliCommand;
  const key = cliCommand ?? providerName;
  return key === "antigravity" ? "agy" : key;
}

function configuredQuotaThrottleProviders(config: RusaConfig): QuotaThrottleProvider[] {
  const providers = new Set<QuotaThrottleProvider>();
  for (const [configuredName, providerConfig] of Object.entries(config.providers)) {
    const key = providerConfig.cliCommand ?? configuredName;
    const canonical = key === "antigravity" ? "agy" : key;
    if (isQuotaThrottleProvider(canonical)) providers.add(canonical);
  }
  return [...providers];
}

function configuredRootEventSources(config: RusaConfig): EventResource[] {
  const configured: EventResource[] = [];

  for (const entry of config.github.orgs ?? []) {
    configured.push(`github:${entry.org}`);
  }

  for (const repo of config.github.repos ?? []) {
    configured.push(`github:${repo}`);
  }

  if (config.chat) {
    // `chat.gchat` is an outbound capability grant, not an inbound event
    // subscription boundary. Configuring chat keeps the existing all-spaces
    // event ownership; ingestion exclusions remain `chat.excludedSpaces`.
    configured.push("gchat:spaces");
  }

  // Disk alerts are a host-owned event source, so configuring the producer is
  // also the subscription declaration. Keeping that derivation here avoids a
  // second config knob that can drift from observability.diskAlert.
  if (config.observability?.diskAlert !== undefined) {
    configured.push("system:events");
  }

  return configured;
}

/** Legacy cap value retained for event detail; Actor now allows one corrective yield run. */
const WORKER_MAX_CONTINUATIONS = 20;

export function getShutdownExitCode(reason: "deploy" | null): number {
  return reason === "deploy" ? 1 : 0;
}

export function postBackOnlinePing(opts: {
  repoRoot: string;
  sendToErrorChat: (text: string) => void;
  log?: (text: string) => void;
}): void {
  const sha = readBuildSentinel(join(opts.repoRoot, "packages", "rusa", "dist"));
  if (sha) {
    opts.sendToErrorChat(`✅ Back online on ${sha.slice(0, 7)}`);
  } else {
    (opts.log ?? console.warn)("[start] back online ping skipped: no build sentinel found");
  }
}

/**
 * @param scratch Where the provider CLI keeps its own copy of the actor's
 * workspace, and who is running in that area right now. Omitted, the second
 * workspace is simply not cleaned — passing the path in rather than reading the
 * home directory here is what lets a test say which directory it means, and the
 * two travel as one argument because deleting by an eight-character prefix
 * without knowing who else answers to it is the collision this guards.
 */
export function createStartRetireCleanups(
  workersDir: string,
  wakeCron: Pick<CrontabWakeCron, "cancel">,
  e2eInstance?: Pick<E2EInstanceManager, "stopForActorRetirement">,
  scratch?: { dir: string; listActors: () => readonly ActorLiveness[] }
): RetireCleanup[] {
  return [
    ...(e2eInstance
      ? [
          {
            name: "e2e instance",
            run: (record: ThreadRecord) => e2eInstance.stopForActorRetirement(record.id),
          },
        ]
      : []),
    {
      name: "worker workdir",
      deferUntilRunEnd: true,
      run: (record) => {
        // Re-check immediately before deleting the source tree. The first
        // retirement cleanup normally stopped the unit already; this guard
        // makes the ordering fail closed if that stop threw transiently.
        e2eInstance?.stopForActorRetirement(record.id);
        teardownFlutterOverlay(join(workersDir, record.id));
        rmSync(join(workersDir, record.id), { recursive: true, force: true });
      },
    },
    ...(scratch
      ? [
          {
            // The provider CLI keeps a workspace of its own, which nothing used
            // to remove — so it outlived the actor and stayed readable to every
            // worker that came after (#3). Deferred for the same reason as the
            // work directory above: the provider process writes there until the
            // run ends.
            name: "provider scratch workdir",
            deferUntilRunEnd: true,
            run: (record: ThreadRecord) => {
              // Every spelling this actor's workspace may carry that no live
              // actor also answers to: the provider has named this directory
              // differently over time, and two of the three name an actor only
              // by its first eight characters. Removing a path that is not
              // there is a no-op. The registry is read here rather than at
              // construction because who is live changes between retirements.
              for (const name of removableWorkspaceNames(record.id, scratch.listActors())) {
                rmSync(join(scratch.dir, name), { recursive: true, force: true });
              }
            },
          },
        ]
      : []),
    {
      name: "cron wake",
      run: (record) => wakeCron.cancel(record.id),
    },
  ];
}

/** Live handles the e2e runner uses to drive a started mesh in-process. */
export interface RunStartE2EHandles {
  mesh: ActorMesh;
  root: MeshActor;
  rootControl: RootControlService;
  externalRoot: ExternalRootDriver | null;
  inboxStore: InboxStore;
  /** Inject a GitHub-shaped event into the root (the webhook `onEvent` sink). */
  emitGitHubEvent: (
    event: string,
    payload: Record<string, unknown>,
    deliveryId?: string
  ) => Promise<void>;
  /** Trigger the production host disk sensor immediately. */
  emitSystemDiskCheck: () => Promise<void>;
  /** Trigger the same graceful shutdown a SIGTERM would. */
  shutdown: () => Promise<void>;
}

/**
 * E2E injection seam: swap the external chat edges for fakes and receive live
 * handles once everything is wired. When `onReady` is present, `runStart` runs in
 * e2e mode and does not bind the real webhook server. The dashboard is opt-in so
 * long-running experiments can expose the live mesh without enabling webhooks.
 * The issue-client edge is swapped via the existing `setIssueClient` global.
 */
export interface RunStartE2EHooks {
  chatClient?: ChatClient;
  chatSource?: ChatSource;
  rootDriver?: "provider" | "external";
  dashboard?: boolean;
  /** Optional deterministic quota source for dashboard scenarios; production never sets this. */
  quotaApi?: QuotaApiDeps;
  onReady?: (handles: RunStartE2EHandles) => void;
}

export interface RunStartOptions {
  deployOnMergeBranch?: string;
  noDashboardServer?: boolean;
  /** Raw `--profile` CLI flag; validated into a {@link ConfigProfile} by loadConfig. */
  profile?: string;
  e2e?: RunStartE2EHooks;
}

export function shouldBindWebhookServer(params: {
  e2eMode: boolean;
  ingestionMode: string | undefined;
}): boolean {
  return !params.e2eMode && (params.ingestionMode ?? "webhook") === "webhook";
}

export function shouldBindDashboardServer(params: {
  e2eMode: boolean;
  e2eDashboard: boolean;
  noDashboardServer: boolean;
}): boolean {
  return !params.noDashboardServer && (!params.e2eMode || params.e2eDashboard);
}

export function isLegacyWorktreeKey(key: string): boolean {
  return /^wt-\d+$/.test(key);
}

export function mechanicallySubscribeCreatedResource(
  mesh: Pick<ActorMesh, "subscribeEventSource">,
  configuredRoots: readonly EventResource[],
  resource: EventResource,
  actorId: string,
  log: (message: string) => void = console.log
): void {
  try {
    if (!configuredRoots.some((configured) => isSubResourceOf(resource, configured))) {
      log(
        `[mesh] mechanical subscribe of ${resourceKey(resource)} to ${actorId} skipped: not anchored in config`
      );
      return;
    }
    mesh.subscribeEventSource(resource, actorId, actorId);
  } catch (err) {
    log(
      `[mesh] mechanical subscribe of ${resourceKey(resource)} to ${actorId} skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function loadRootSessionId(file: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(file, "utf-8")) as { sessionId?: string }).sessionId;
  } catch {
    return undefined;
  }
}

function saveRootSessionId(file: string, sessionId: string): void {
  try {
    writeFileSync(file, JSON.stringify({ sessionId }, null, 2));
  } catch {
    /* best effort */
  }
}

/**
 * Assemble a portable-context (design ISSUE_NUM) actor's
 * stateless prefix from its own recent `run_end` outputs, plus the per-run inject
 * record that rides on the run's `run_start` event. Returns undefined when there's
 * nothing injectable yet (e.g. the actor's first run).
 *
 * Lifted out of the worker's `buildPrompt` callback so that callback stays a thin
 * composition seam. Deliberately NOT pushed into `buildWorkerPrompt` (Operator's PR
 * suggestion): that formatter lives in `worker-prompt.ts` and is pure — folding
 * this in would couple it to the repository/db layer. A live mesh-log read belongs
 * in the wiring layer (here), which is where the repositories already live.
 */
function assemblePortableInjection(
  id: string,
  mode: "tail" | "ledger",
  store: PortableContextStore
): { priorContext: string; injectRecord: InjectRecord } | undefined {
  const { events } = getRepositories().meshEvents.listEventsByActors([id], {
    kinds: ["run_end"],
    limit: portableContextMaxRuns(),
  });
  const runs = events.map((e) => ({ id: e.id, ts: e.ts, body: e.body }));
  const portable =
    mode === "ledger"
      ? assemblePortableContextV2({
          state: store.load(id),
          messages: getRepositories()
            .meshEvents.listEventsByActors([id], {
              kinds: ["message_received"],
              limit: portableContextMaxMessages(),
            })
            .events.map((event) => ({
              id: event.id,
              ts: event.ts,
              sender: messageSender(event.payload) ?? "unknown",
              body: event.body,
            })),
          runs,
          // Read-through only. The prompt shows work state; it never authors it
          // — the obligation store stays the sole lifecycle authority .
          obligations: getRepositories().obligations.listOwned(id),
        })
      : assemblePortableContext(runs);
  return portable ? { priorContext: portable.section, injectRecord: portable.record } : undefined;
}

function assembleConfiguredPortableInjection(
  record: ThreadRecord,
  apiKey: string | null,
  store: PortableContextStore
): { priorContext: string; injectRecord: InjectRecord } | undefined {
  if (record.context?.type !== "portable") return undefined;
  if (record.context.mode === "ledger" && !apiKey) {
    throw new Error("portable context ledger mode requires geminiApiKey");
  }
  return assemblePortableInjection(record.id, record.context.mode, store);
}

function messageSender(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { from?: unknown };
    return typeof parsed.from === "string" ? parsed.from : null;
  } catch {
    return null;
  }
}

export async function compactPortableContext(input: {
  actorId: string;
  store: PortableContextStore;
  compactor: PortableContextCompactor;
  now?: () => string;
}): Promise<PortableContextCompactionSummary | null> {
  let state = input.store.load(input.actorId);
  const itemsBefore = state.items.length;
  let folded = 0;
  let foldedSelf = 0;
  let operations = 0;
  let bytes = 0;
  let pages = 0;
  let foldStop: PortableContextCompactionSummary["foldStop"] = "drained";
  const quarantinedOperations: QuarantinedOperation[] = [];
  while (true) {
    const page = getRepositories().meshEvents.listLedgerSourcesAfter(
      input.actorId,
      state.lastFoldedMessageEventId,
      50
    );
    if (page.events.length === 0) break;
    const result = await input.compactor.compact({
      actorId: input.actorId,
      state,
      messages: page.events,
      now: (input.now ?? (() => new Date().toISOString()))(),
    });
    state = result.state;
    quarantinedOperations.push(...result.quarantined);
    operations += result.operations;
    input.store.save(state);
    folded += page.events.length;
    foldedSelf += page.events.filter((event) => isSelfAuthoredLedgerSource(event.kind)).length;
    bytes += page.events.reduce(
      (sum, event) => sum + Buffer.byteLength(event.body ?? "", "utf8"),
      0
    );
    pages += 1;
    if (!page.hasMore) break;
    // Both caps are checked AFTER a page lands, so a fold always makes progress
    // and the watermark always advances — the remainder is the next run's work.
    if (pages >= PORTABLE_CONTEXT_FOLD_MAX_PAGES) {
      foldStop = "page-cap";
      break;
    }
    if (bytes >= PORTABLE_CONTEXT_FOLD_MAX_BYTES) {
      foldStop = "byte-cap";
      break;
    }
  }
  return folded > 0
    ? {
        generation: state.generation,
        items: state.items.length,
        itemsAdded: state.items.length - itemsBefore,
        folded,
        foldedSelf,
        operations,
        quarantined: quarantinedOperations.length,
        quarantinedByClass: quarantineCountsByClass(quarantinedOperations),
        quarantinedOperations,
        foldStop,
      }
    : null;
}

/**
 * Start rusa as the single **root actor** over an {@link ActorMesh}.
 *
 * Inbound GitHub webhooks and Google Chat messages wake the root, which runs the
 * configured provider (default agy) with its configured context and MCP tools —
 * tracker + chat + the agent-execution ("mesh") server that lets it delegate to
 * worker actors. Workers are the same {@link Actor} loop, get their own
 * per-actor agent-execution endpoint (identity baked in), report to their parent,
 * and are recorded in a durable {@link FileThreadRegistry} that survives restart.
 * The v2 orchestrator pipeline is not wired (its implementation is retained but
 * unused).
 */
export async function runStart(opts?: RunStartOptions): Promise<void> {
  const mcHome = resolveHome();

  console.log(`\n🚀 Rusa v0.1.0 — root actor\n${"━".repeat(28)}\n`);
  console.log(`Loading config from ${mcHome}/config.yaml`);

  if (opts?.deployOnMergeBranch) {
    console.warn("[start] --deploy-on-merge-branch is not wired in root-actor mode yet; ignoring");
  }

  let config: RusaConfig;
  try {
    // The CLI flag is an untrusted raw string; loadConfig re-validates it and
    // throws on an unknown profile, so the cast to the canonical union is safe.
    config = loadConfig(mcHome, {
      profile: opts?.profile as ConfigProfile | undefined,
    });
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }
  const portableContextStore = new FilePortableContextStore(join(mcHome, "portable-context"));
  const portableContextApiKey = config.geminiApiKey?.trim() || null;
  const portableContextCompactors = new Map<string, PortableContextCompactor>();
  const compactorFor = (context: PortableContextConfig): PortableContextCompactor | null => {
    if (!portableContextApiKey) return null;
    const model = resolvePortableContextCompactorModel(context.compactionModel);
    const existing = portableContextCompactors.get(model);
    if (existing) return existing;
    const compactor = new GeminiPortableContextCompactor(portableContextApiKey, model);
    portableContextCompactors.set(model, compactor);
    return compactor;
  };

  if (config.sandbox !== "container-boundary") {
    // bubblewrap is required for sandboxed worker runs. The root itself is
    // unsandboxed, but fail fast if the host can't sandbox workers at all.
    try {
      assertBwrapAvailable();
    } catch (err) {
      console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }
  }

  console.log("Initializing database...");
  initDb(mcHome);
  console.log("✓ Database ready");

  // #1645 ready-head attention. Attached here, immediately after initDb, rather
  // than beside the mesh: `getRepositories()` throws once the database is
  // closed, and in a process that runs more than one instance (the tests, the
  // e2e manager) a prior shutdown can land mid-startup. The sink is filled in
  // once the mesh exists; until then a head change is simply not routed.
  let readyHeadSink: ((change: ReadyHeadChange) => void) | undefined;
  getRepositories().obligations.setReadyHeadListener((change) => readyHeadSink?.(change));

  try {
    populateModelCatalogsFromDb(getRepositories().modelScrapes);
  } catch (err) {
    console.warn(
      `[start] failed to populate model catalogs from database: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    ingestKimiHostModels({ scrapeStore: getRepositories().modelScrapes });
  } catch (err) {
    console.warn(
      `[start] failed to ingest Kimi host models: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Migration cleanup: releases before #127 copied Codex credentials into
  // /tmp/rusa-auth-codex-* and a crash could strand those copies. New runs bind
  // the live host auth file directly, but retain this small boot sweep so an
  // upgrade removes credential files left by the old implementation.
  if (process.env.NODE_ENV !== "test") {
    try {
      const files = readdirSync("/tmp");
      const now = Date.now();
      for (const file of files) {
        if (file.startsWith("rusa-auth-codex-")) {
          try {
            const stats = statSync(join("/tmp", file));
            if (now - stats.mtimeMs > 5_000) {
              unlinkSync(join("/tmp", file));
            }
          } catch {
            // best effort
          }
        }
      }
    } catch {
      // best effort
    }
  }

  console.log(`Authenticated as ${config.github.account}`);

  // The root's configured identity : the display handle every
  // root-identity surface (signing byline, dashboard, avatar, commitment
  // ledger) routes through. Defaults to today's root-actor when
  // `rootActor.handle` is unset, so an instance with no config is unchanged.
  const rootHandle = resolveRootHandle(config);

  // ── MCP tools: tracker (gh) + chat (gchat) + understanding (read), served
  // in-process over loopback ──
  const baseIssueClient = getIssueClient();
  const gitBridgePort = config.gitBridgePort ?? 8085;
  const gitBridgeBindHost = config.gitBridgeBindHost ?? "127.0.0.1";
  if (config.gitBridge) {
    for (const repo of config.github.repos ?? []) {
      try {
        initEmptyBareRepo(mcHome, repo);
        console.log(`[git-bridge] initialized bare repo for ${repo}`);
      } catch (err) {
        console.warn(
          `[git-bridge] failed to initialize bare repo for ${repo}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  const gitBridgeServer = config.gitBridge
    ? startGitHttpServer(mcHome, gitBridgePort, { bindHost: gitBridgeBindHost })
    : null;
  const issueClient: IssueClient & GitHubPollingIssueClient = config.gitBridge
    ? new GitBridgeIssueClient(baseIssueClient as IssueClient & GitHubPollingIssueClient, {
        port: gitBridgePort,
      })
    : (baseIssueClient as IssueClient & GitHubPollingIssueClient);
  const gitBridgeDeliverables = new Map<string, string>();
  // ONE local-first would-be-graph client (ISSUE_NUM 2b) backs BOTH the read and write
  // understanding servers (no module-global state — Operator's DI review of ISSUE_NUM): a normal
  // SyncClient over LocalFilePersistenceService (one-time read-only baseline pull →
  // append-only local ops-log, AND a live sync to glass-goals via `createRemoteOpSink` —
  // the accumulated ops drain on construction, then each save() syncs per-op). The grantable
  // `understanding-write` writes it; the read MCP serves it. Going-live shipped through this
  // auto-sync path (ISSUE_NUM/ISSUE_NUM/ISSUE_NUM), superseding the v1 dry-run-only model and its planned
  // `flushToRemote()` step, which was never built. Resolves null (→ tools fail soft) when
  // glass-goals is unreachable.
  const localWriteDeps = createUnderstandingSyncClientProvider(() =>
    getLocalUnderstandingWriteClient(config, mcHome)
  );
  // Remote-less installs (quickstart + E2E) own a universal local IU seed. Materialize it
  // before either the dashboard op reader or an actor's understanding MCP can observe the
  // instance, so both surfaces start from the same non-empty graph. Remote-backed installs
  // remain lazy: an unavailable Glass Goals service must not delay or block mesh startup.
  if (!resolveGlassGoalsConfig(config)) {
    await localWriteDeps.getClient();
  }
  // Read-only resolver for externalized node bodies (glass-goals `v001_strings`) so the read
  // MCP serves content, not just structure — held backfill ops are inline; baseline bodies
  // resolve here (the ISSUE_NUM mechanism, server-side).
  const understandingStrings = createUnderstandingStringsResolver(config);
  const cursorStore = new DistillerCursorStore(getDb());
  const distillerStore: DistillerMcpStore = {
    getState: () => cursorStore.getState(),
    setState: (state) => cursorStore.setState(state),
    seedIfUnset: (iso) => cursorStore.seedIfUnset(iso),
    countSubstantiveEvents: (sinceISO, untilISO) =>
      getRepositories().meshEvents.countEventsSince(sinceISO, SUBSTANTIVE_EVENT_KINDS, untilISO),
    resolveSeed: async () => {
      const client = await localWriteDeps.getClient();
      return resolveSeed(client !== null, client ? latestOpCreatedAt(client) : null);
    },
    unsyncedCount: () => getLocalUnderstandingUnsyncedCount(mcHome),
  };
  const registry = new FileThreadRegistry(join(mcHome, "threads.json"));
  // The obligation store's actor guard is only real once it can see the
  // registry. Built from a Database alone, the container cannot do this itself,
  // and without this line every owner check in the repository is inert.
  getRepositories().setActorExists((actorId) => registry.get(actorId)?.status === "active");
  const rootId = resolveRootThreadId(registry);
  const inboxStore = getRepositories().inbox;
  const modelScrapesStore = getRepositories().modelScrapes;
  const workersDir = join(mcHome, "workers");
  mkdirSync(workersDir, { recursive: true });
  // Boot-time sweep of the workspaces of actors that have retired. Retirement
  // deletes both of an actor's directories, so what survives to here is either a
  // restart that interrupted that, or a workspace from before the provider's own
  // scratch area was cleaned at all (#3). Skipped in the test runner alongside
  // the other boot sweeps.
  // Who the registry knows and whether they still run, read fresh at every use:
  // both the boot sweep below and each retirement cleanup decide what to delete
  // from this, and it changes underneath them.
  const actorLiveness = (): ActorLiveness[] =>
    registry.list().map((record) => ({ id: record.id, retired: record.status === "retired" }));
  if (process.env.NODE_ENV !== "test") {
    const sweptWorkspaces = sweepOrphanedWorkspaces({
      workersDir,
      scratchDir: antigravityScratchDir(),
      actors: actorLiveness(),
      log: (message) => console.warn(message),
    });
    if (sweptWorkspaces.length > 0) {
      console.log(`[start] removed ${sweptWorkspaces.length} workspace(s) of retired actors`);
    }
    // Checkouts the sweep will never claim, because they name no actor. Naming
    // them once a boot is what keeps a hand-named directory from holding a
    // repository in the shared area indefinitely without anyone knowing.
    const strayCheckouts = unattributedCheckouts({
      workersDir,
      scratchDir: antigravityScratchDir(),
      actors: actorLiveness(),
    });
    if (strayCheckouts.length > 0) {
      console.warn(
        `[start] ${strayCheckouts.length} checkout(s) in the provider's area name no actor and were left in place: ${strayCheckouts.map((path) => basename(path)).join(", ")}`
      );
    }
  }
  const sharedQuotaStore = config.quota?.databasePath
    ? new SharedQuotaStore(resolveQuotaDatabasePath(config.quota.databasePath, mcHome))
    : null;
  sharedQuotaStore?.configureController({
    maxIntervalSeconds: config.quota?.throttle?.maxIntervalSeconds ?? 3600,
  });
  const quotaScrapesStore = sharedQuotaStore ?? getRepositories().quotaScrapes;
  // Shared across the `get_quota` MCP tool and the dashboard's `/api/quota`
  // endpoint  — one TTL cache, so neither surface probes independently.
  const quotaService = createQuotaService({
    config,
    workersDir,
    scrapeStore: quotaScrapesStore,
  });
  let webhookSilenceDetector: WebhookSilenceDetector | null = null;
  const servers: Record<string, () => McpServer> = {
    // Pull-only read over the integrated understanding — every agent gets it. Serves the
    // local-first would-be graph (incl. the distiller's backfill) with externalized bodies
    // resolved, so agents read the distiller's work directly from the local store rather
    // than waiting on a remote round-trip (it is live-synced to glass-goals in parallel).
    [UNDERSTANDING_READ_MCP_NAME]: () =>
      createUnderstandingReadServer(
        localWriteDeps,
        resolveUnderstandingRootNodeId(config),
        understandingStrings.loadStrings
      ),
    [STUCK_LOOP_DETECTOR_MCP_NAME]: () =>
      createStuckLoopDetectorMcpServer({
        registry,
        meshEvents: getRepositories().meshEvents,
        rootHandle,
      }),
    // One shared QuotaService instance : both actor-invoked `get_quota`
    // calls and the dashboard's `/api/quota` endpoint below read the same TTL
    // cache, so neither surface can double the probe rate.
    [QUOTA_MCP_NAME]: () => createQuotaMcpServer({ config, workersDir }, quotaService),
  };
  let chatClient: ChatClient | null = opts?.e2e?.chatClient ?? null;
  let gchat: GchatClient | null = null;
  if (!chatClient && config.chat && !opts?.e2e) {
    gchat = new GchatClient(config.chat.gchatConfigDir);
    chatClient = gchat;
  }
  if (chatClient) {
    servers[CHAT_READ_MCP_NAME] = () => createChatReadMcpServer(chatClient);
  }

  const mcpHttp = new McpHttpServer({ servers });
  await mcpHttp.start();
  const sharedMcp = mcpHttp.urls();
  console.log(`[mcp] serving ${sharedMcp.map((u) => u.name).join(", ")} on loopback`);

  // ── Provider + thread registry ──
  let provider: ReturnType<typeof resolveRootProvider>;
  try {
    provider = resolveRootProvider(config);
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const fallbackModels = normalizeFallbackModel(config);
  const classifyExhaustion = createExhaustionClassifier(config.geminiApiKey);
  const repoRoot = (() => {
    try {
      return resolveRepoRoot();
    } catch (err) {
      console.error(
        `[start] Could not infer the git repository root: ${err instanceof Error ? err.message : String(err)}. Root actor will lose checkout access (addDirs is empty).`
      );
      return null;
    }
  })();
  const addDirs: string[] = repoRoot ? [repoRoot] : [];
  // Append-only observability log: every message, wake, spawn, and retire lands
  // in `mesh_events` so a run can be replayed as a timeline by `rusa report`.
  // After persisting, broadcast the stored row to any live dashboard SSE clients
  // (best-effort — fan-out must never break the recording or the mesh).
  const meshEmitter = new MeshEventEmitter();
  const meshEvents: MeshEventSink = (e) => {
    const id = getRepositories().meshEvents.record(e);
    try {
      const stored = getRepositories().meshEvents.getById(id);
      if (stored) meshEmitter.emitMeshEvent(stored);
    } catch {
      // SSE fan-out is best-effort; the event is already durably recorded.
    }
  };

  // The actor output firehose: write to the console as before AND mirror each
  // chunk to dashboard SSE clients viewing this actor. Wrapped so a dead browser
  // tab can never throw back into the provider's synchronous onChunk callback.
  const makeFirehose = (actorId: string) => (chunk: string) => {
    process.stdout.write(chunk);
    try {
      meshEmitter.emitLiveOutput({ actorId, text: chunk });
    } catch {
      // live_output fan-out is best-effort; never disturb the run.
    }
  };

  // ── Mesh safety governors ──
  // Emergency brake: the single source of truth is the sentinel file. Halt by
  // hand (`touch ~/.rusa/HALT`), by chat (`/halt`), or pull the plug.
  const haltSwitch = new HaltSwitch(join(mcHome, "HALT"));
  const rootProviderName = config.rootActor?.provider?.trim() || DEFAULT_ROOT_PROVIDER;
  const isProviderHalted = (providerName?: string) =>
    haltSwitch.isHalted(providerName ?? rootProviderName);
  let haltExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  if (haltSwitch.hasActiveHalt()) {
    const why = haltSwitch.reason();
    console.warn(`[mesh] ⛔ HALT sentinel present${why ? ` (${why})` : ""} — runs are paused`);
  }
  // In-memory graceful-shutdown brake : the in-process `update` MCP tool
  // engages this (a direct call — no HTTP, no separate process) to quiesce the
  // mesh before it `exit(0)`s and lets systemd restart onto the freshly-built
  // code. Distinct from HALT and process-local on purpose — a fresh boot comes up
  // with it false, so there is nothing to clear on restart and the operator HALT
  // is never touched.
  const gracefulShutdown = new GracefulShutdown();

  // ── ISSUE_NUM: slow-flap detector. Record this boot; if too many restarts land in the
  // window (a flap StartLimit's fast 5/300s window misses), raise an alert. The
  // signal is chat-INDEPENDENT first (journal ERROR + marker file always), with a
  // best-effort chat DM on top — so a give-up is visible even if gchat is down.
  // Never blocks boot: any failure here is swallowed.
  try {
    const flap = recordRestartAndCheckFlap(join(mcHome, "restart-log.json"), Date.now(), {
      windowMs: FLAP_WINDOW_MS,
      threshold: FLAP_THRESHOLD,
    });
    if (flap.flapping) {
      const mins = Math.round(flap.windowMs / 60_000);
      const alert = `rusa restarted ${flap.count}× in the last ${mins}min — possible crash-loop/flap`;
      console.error(`[flap] ⚠️ ${alert}`); // journal ERROR — always, chat-independent
      try {
        const marker = join(mcHome, "alerts", "last-failure.txt");
        mkdirSync(join(mcHome, "alerts"), { recursive: true });
        appendFileSync(marker, `[${new Date().toISOString()}] ${alert}\n`, "utf8");
      } catch {
        /* best-effort marker */
      }
      if (chatClient && config.chat?.errorChat) {
        void chatClient.send(config.chat.errorChat, `⚠️ ${alert}`).catch(() => {});
      }
    }
  } catch {
    /* the flap check must never wedge startup */
  }
  // Quota pacing is backed exclusively by the configured shared quota store.
  const quotaThrottleConfig = config.quota?.throttle;
  const quotaThrottleEnabled = quotaThrottleConfig?.enabled === true;
  const quotaProviders = configuredQuotaThrottleProviders(config);
  const providerPacers = new Map<string, ProviderPacer>();
  const pacerFor = (providerName: string): ProviderPacer => {
    let pacer = providerPacers.get(providerName);
    if (!pacer) {
      pacer = new ProviderPacer(0);
      providerPacers.set(providerName, pacer);
    }
    return pacer;
  };
  const quotaThrottleStatuses = new Map<QuotaThrottleProvider, QuotaThrottleStatus>();
  const recordQuotaThrottleTick = (
    providerName: QuotaThrottleProvider,
    tick: QuotaThrottleTick,
    persistedUpdatedAt?: string,
    exhaustedUntil?: string | null
  ): void => {
    try {
      const pacer = pacerFor(providerName);
      const safeIntervalSeconds =
        Number.isFinite(tick.intervalSeconds) && tick.intervalSeconds >= 0
          ? tick.intervalSeconds
          : 0;
      pacer.setInterval(safeIntervalSeconds * 1000);
      if (tick.expired) {
        const exhaustedUntilMs = exhaustedUntil ? Date.parse(exhaustedUntil) : Number.NaN;
        if (Number.isFinite(exhaustedUntilMs)) {
          pacer.deferUntil(exhaustedUntilMs);
        }
      }
      quotaThrottleStatuses.set(providerName, {
        ...tick,
        intervalSeconds: safeIntervalSeconds,
        updatedAt: persistedUpdatedAt ?? new Date().toISOString(),
      });
      const errors = tick.buckets
        .map((bucket) => `${bucket.key}=${bucket.error.toFixed(1)}`)
        .join(",");
      const wantedStr = Number.isFinite(tick.uncappedIntervalSeconds)
        ? `${tick.uncappedIntervalSeconds.toFixed(1)}s`
        : "inf";
      const cappedStr = tick.capped ? ` capped(wanted=${wantedStr})` : "";
      console.log(
        `[quota-throttle] provider=${providerName} interval=${safeIntervalSeconds.toFixed(1)}s${cappedStr} ${tick.expired ? "expired" : `error=[${errors}]`}`
      );
    } catch (err) {
      console.warn(
        `[quota-throttle] recordQuotaThrottleTick for provider=${providerName} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
  const applyPersistedQuotaThrottle = (providerName: QuotaThrottleProvider): boolean => {
    if (!sharedQuotaStore) return false;
    const persisted = sharedQuotaStore.getProviderThrottle(providerName);
    if (!persisted) return false;
    recordQuotaThrottleTick(
      providerName,
      {
        intervalSeconds: persisted.intervalSeconds,
        uncappedIntervalSeconds: persisted.uncappedIntervalSeconds,
        expired: persisted.expired,
        capped: persisted.capped,
        buckets: persisted.buckets.map((bucket) => ({
          key: bucket.key,
          percentLeft: bucket.percentLeft,
          timeRemainingPct: bucket.timeRemainingPct,
          error: bucket.error,
          requiredIntervalSeconds: bucket.requiredIntervalSeconds,
        })),
      },
      persisted.updatedAt,
      persisted.exhaustedUntil
    );
    return true;
  };
  sharedQuotaStore?.setControllerUpdatedListener((providerName) => {
    if (quotaThrottleEnabled && isQuotaThrottleProvider(providerName)) {
      applyPersistedQuotaThrottle(providerName);
    }
  });
  if (quotaThrottleEnabled && sharedQuotaStore) {
    for (const providerName of quotaProviders) applyPersistedQuotaThrottle(providerName);
  }
  const tickQuotaThrottle = async (): Promise<void> => {
    if (!quotaThrottleEnabled || !sharedQuotaStore) return;
    try {
      await Promise.all(
        quotaProviders.map(async (providerName) => {
          try {
            await quotaService.getQuota(providerName);
            sharedQuotaStore.advancePendingController(
              { maxIntervalSeconds: quotaThrottleConfig?.maxIntervalSeconds ?? 3600 },
              providerName
            );
            applyPersistedQuotaThrottle(providerName);
          } catch (err) {
            // Keep the last persisted reasoned interval when a scrape fails.
            // Do not turn one provider's probe failure into a mesh failure.
            console.warn(
              `[quota-throttle] provider=${providerName} tick failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })
      );
    } catch (outerErr) {
      console.warn(
        `[quota-throttle] tickQuotaThrottle failed: ${outerErr instanceof Error ? outerErr.message : String(outerErr)}`
      );
    }
  };

  // ── Capability grants  ──
  // Durable, actor-id-keyed grants of extra MCP capabilities beyond the default
  // worker set. `grantableServers` is the production allow-list (see
  // buildGrantableServers): only capabilities with a registered factory can be
  // granted, and the factory is what `createActor` mounts for a grantee. Phase 1b
  // registers the glass-goals `understanding-write` server (claude FS isolation
  // ISSUE_NUM having landed); grantable-servers.test.ts locks the contents.
  const capabilityGrants = new FileCapabilityGrantStore(join(mcHome, CAPABILITY_GRANTS_FILENAME));
  const persistentEventSubscriptions = new FileEventSubscriptionStore(
    join(mcHome, "event-subscriptions.json"),
    rootId
  );
  // Host-plane host-jobs capability : durable per-actor job records, keyed
  // the same way capabilityGrants/eventSubscriptions are.
  const hostJobStore = new FileHostJobStore(join(mcHome, "host-jobs.json"));
  const e2eInstance = new E2EInstanceManager({
    mcHome,
    workersDir,
    handleForId: (id) => (id === rootId ? rootHandle : generateHandle(id)),
  });
  const configuredRoots = configuredRootEventSources(config);
  const rootSourceSync = reconcileEventSources(
    persistentEventSubscriptions,
    configuredRoots,
    rootId,
    () => new Date().toISOString()
  );
  const eventSubscriptions = rootSourceSync.store;
  if (rootSourceSync.droppedDelegations.length > 0) {
    console.log(
      `[mesh] reconciled root event sources: dropped ${rootSourceSync.droppedDelegations.length} orphaned delegations`
    );
  }
  // `const` so the closure below keeps the non-null narrowing (`chatClient` is a
  // reassignable `let` further up).
  const chatClientForSpaces = chatClient;
  const gmailClient = new GoogleGmailClient(config.chat?.gchatConfigDir);
  const calendarClients = new GoogleCalendarClientProvider(config.chat?.gchatConfigDir);
  const driveClients = new GoogleDriveClient(config.chat?.gchatConfigDir);
  const commitmentPolarityEvaluator = createCommitmentPolarityEvaluator(config.geminiApiKey);
  const grantableServers = buildGrantableServers({
    // The nightly-report producer  writes the run-journal / rendered reports /
    // index.json instance-side under <mcHome>/iu-distiller/reports/ — colocated with the
    // IU store, never in the repo (same cross-repo-leak boundary as the store itself).
    // The chat read set is measured, not configured (ISSUE_NUM/ISSUE_NUM): every space
    // the Chat identity belongs to, enumerated per run. Omitting the resolver
    // when no chat client is wired is what lets `distill_status` say "chat is
    // not configured on this host" instead of reporting an empty read set.
    distiller: {
      store: distillerStore,
      reports: {
        paths: iuReportPaths(mcHome),
        // ISSUE_NUM polarity check as a cheap semantic read . Unset key =>
        // undefined => the report says the check did not run, which is the
        // honest answer; it never degrades to a lexical guess.
        ...(commitmentPolarityEvaluator ? { evaluateCommitment: commitmentPolarityEvaluator } : {}),
      },
      ...(chatClientForSpaces
        ? { listChatSpaces: () => listAllChatSpaces(chatClientForSpaces) }
        : {}),
    },
    understanding: localWriteDeps,
    rootNodeId: resolveUnderstandingRootNodeId(config),
    hostJobs: {
      store: hostJobStore,
      // Same handle-derivation the mesh itself uses (see `handleForId` below) —
      // threaded through, never re-derived.
      handleForId: (id) => (id === rootId ? rootHandle : generateHandle(id)),
      mcHome,
      // `mesh` is assigned below; safe because this closure only runs once an
      // actor actually calls a host-jobs tool, well after `mesh` exists —
      // `createActor` already relies on this same self-reference (see
      // `mesh.activeCapabilitiesFor` a few lines down).
      recordEvent: (e) => mesh.recordEvent(e),
    },
    e2eInstance: { manager: e2eInstance },
    gmailClient,
    onEmailSend: (actorId, to, cc) =>
      mesh.recordEvent({
        kind: "email_sent",
        actorId,
        detail: to,
        payload: JSON.stringify({ to, cc }),
      }),
    calendarClients,
    onCalendarRead: (actorId, observation) =>
      meshEvents({
        kind: "calendar_read",
        actorId,
        detail: observation.operation,
        payload: JSON.stringify({
          ...(observation.account ? { account: observation.account } : {}),
          ...(observation.calendarId ? { calendarId: observation.calendarId } : {}),
        }),
      }),
    onCalendarWrite: (actorId, observation) =>
      meshEvents({
        kind: "calendar_write",
        actorId,
        detail: observation.operation,
        payload: JSON.stringify({
          calendarId: observation.calendarId,
          issueNumber: observation.issueNumber,
        }),
      }),
    chatClient: chatClient ?? undefined,
    onChatWrite: (actorId) => mesh.markUnkillable(actorId),
    // Confines chat-write attachment filePaths to the grantee's workdir — same
    // mapping the pnpm-install and root wiring use for actor roots.
    actorRootFor: (actorId) =>
      actorId === rootId ? join(mcHome, "root-agent") : join(workersDir, actorId),
    driveClients,
    onDriveRead: (actorId, observation) =>
      meshEvents({
        kind: "drive_read",
        actorId,
        detail: observation.operation,
        payload: JSON.stringify({
          ...(observation.folderId ? { folderId: observation.folderId } : {}),
          ...(observation.fileId ? { fileId: observation.fileId } : {}),
          ...(observation.recursive !== undefined ? { recursive: observation.recursive } : {}),
          ...(observation.mimeType ? { mimeType: observation.mimeType } : {}),
        }),
      }),
  });
  const wakeCron = new CrontabWakeCron(execCrontabIo(), {
    tokenFile: wakeTokenPath(mcHome),
    portFile: wakePortPath(mcHome),
  });
  // Actor keeps this array by reference and hands its current contents to the
  // provider at run start. A live grant updates it synchronously, which is the
  // latest boundary every provider CLI can reliably consume MCP configuration.
  const liveWorkerMcp = new Map<string, McpServerSpec[]>();
  const rootMcp: McpServerSpec[] = [];
  const rootGrantedMcp: McpServerSpec[] = [];
  const refreshLiveActorMcp = (actorId: string): void => {
    if (actorId === rootId) {
      for (const spec of rootGrantedMcp) {
        const index = rootMcp.indexOf(spec);
        if (index >= 0) rootMcp.splice(index, 1);
      }
      rootGrantedMcp.length = 0;
      rootGrantedMcp.push(
        ...mountGrantedServers(
          rootId,
          mesh.activeCapabilitiesFor(rootId),
          grantableServers,
          mcpHttp,
          { isFenced: (actorId) => mesh.isYielded(actorId) }
        )
      );
      rootMcp.push(...rootGrantedMcp);
      return;
    }
    const workerMcp = liveWorkerMcp.get(actorId);
    if (!workerMcp) return;
    const mounted = mountGrantedServers(
      actorId,
      mesh.activeCapabilitiesFor(actorId),
      grantableServers,
      mcpHttp,
      { isFenced: (actorId) => mesh.isYielded(actorId) }
    );
    for (let index = workerMcp.length - 1; index >= 0; index -= 1) {
      const spec = workerMcp[index];
      if (spec && grantableServers.has(spec.name)) workerMcp.splice(index, 1);
    }
    workerMcp.push(...mounted);
  };

  // Tear down resources the mesh doesn't own: the per-actor MCP endpoints.
  const teardownActorMcp = (actorId: string) => {
    liveWorkerMcp.delete(actorId);
    void mcpHttp.removeServer(actorId);
    void mcpHttp.removeServer(`${actorId}:${INBOX_MCP_NAME}`);
    void mcpHttp.removeServer(`${actorId}:${OBLIGATIONS_MCP_NAME}`);
    void mcpHttp.removeServer(`${actorId}:${MESH_CHAT_MCP_NAME}`);
    void mcpHttp.removeServer(`${actorId}:${PNPM_INSTALL_MCP_NAME}`);
    void mcpHttp.removeServer(`${actorId}:${REPO_MCP_NAME}`);
    void mcpHttp.removeServer(`${actorId}:${TRACKER_MCP_NAME}`);
    void mcpHttp.removeServer(`${actorId}:${UNDERSTANDING_READ_MCP_NAME}`);
    void mcpHttp.removeServer(`${actorId}:${STUCK_LOOP_DETECTOR_MCP_NAME}`);
    void mcpHttp.removeServer(`${actorId}:${QUOTA_MCP_NAME}`);
    void mcpHttp.removeServer(`${actorId}:${CHAT_READ_MCP_NAME}`);
    // Tear down EVERY granted-capability endpoint this actor could have mounted
    //  — iterate the full grantable set, not the current grants, so an
    // endpoint can't leak past retire even after a revoke cleared the grant.
    // removeServer is a no-op for an unmounted name, so this is safe.
    for (const cap of grantableServers.keys()) {
      void mcpHttp.removeServer(`${actorId}:${cap}`);
    }
  };

  const compactPortableActorAfterRun = async (
    actorId: string
  ): Promise<PortableContextCompactionSummary | null> => {
    const current = registry.get(actorId);
    const context = current?.context?.type === "portable" ? current.context : undefined;
    const compactor = context?.mode === "ledger" ? compactorFor(context) : null;
    if (context?.mode !== "ledger" || !compactor) return null;
    try {
      return await compactPortableContext({
        actorId,
        store: portableContextStore,
        compactor,
      });
    } catch (err) {
      // Keep the previous state and watermark. The exact message remains in the
      // recent raw journal and will be retried after the next run.
      console.warn(
        `[portable-context] compaction failed for ${actorId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  };

  // ── Actor mesh: the root plus any worker threads it spawns ──
  const mesh = new ActorMesh({
    registry,
    rootId,
    validateSpawn: (req) => {
      // Portable-context refusals  live here, at the mesh's single spawn
      // choke point, so the MCP tool, root control, the dashboard and the A/B rig
      // are all gated by construction rather than each remembering to check.
      assertSpawnContextSupported(req, {
        ledgerCompactionAvailable: portableContextApiKey !== null,
      });
      const provider = req.provider?.trim();
      if (!provider) throw new Error("provider is required");
      const model = req.model?.trim();
      if (!model) throw new Error("model is required");
      validateModelPin(provider, model);
    },
    validateModel: (record, newModel, newProvider) => {
      const effectiveProvider =
        (newProvider?.trim() || record.provider) ??
        config.rootActor?.provider ??
        DEFAULT_ROOT_PROVIDER;
      validateModelPin(effectiveProvider, newModel);
      resolveProvider(config, effectiveProvider, newModel);
    },
    events: meshEvents,
    recordChat: (opts) => getRepositories().meshChat.record(opts),
    capabilityGrants,
    eventSubscriptions,
    // Ownership authority for issue/PR event sources: a live
    // obligation's owner governs its linked source and supersedes any manual
    // delegation on it.
    //
    // Resolved lazily, like `recordChat` above: the repository container is not
    // guaranteed to exist when the mesh is constructed, and reaching for it
    // here rather than at routing time hangs boot.
    obligations: {
      findLiveByExternalRef: (ref) => getRepositories().obligations.findLiveByExternalRef(ref),
    },
    inboxStore,
    onInboxEntriesSeen: (_actorId, entries) =>
      reactToQueuedInboxEntries(issueClient, entries, console.warn, chatClient ?? undefined),
    // Grantable = every registered MCP-server capability PLUS the secret
    // capabilities . Secrets deliberately have NO server factory: the
    // `grantableServers.get(cap)` loop in createActor skips them safely, and the
    // sandbox honors them instead (see injectSecretsMasking in sandbox.ts).
    grantableCapabilities: new Set([...grantableServers.keys(), ...PARENT_GRANTABLE_CAPABILITIES]),
    maxConcurrent: config.mesh?.maxConcurrent,
    providerGate: (fn, providerName, request) =>
      pacerFor(providerThrottleKey(providerName, config)).submit(fn, {
        responsive: request.responsive,
        threadId: request.threadId,
        enqueueNormal: request.enqueueNormal,
      }),
    isHalted: isProviderHalted,
    isShuttingDown: () => gracefulShutdown.isShuttingDown(),
    handleForId: (id) => (id === rootId ? rootHandle : generateHandle(id)),
    onYield: (actorId, { notifyingParent }) => {
      // Consume-or-flush: surface a pending git-bridge deliverable to the parent
      // only on a parent-triggered yield; on any other yield still clear it so a
      // stale deliverable can't leak into a later, unrelated parent notification.
      const deliverable = gitBridgeDeliverables.get(actorId);
      if (deliverable === undefined) return undefined;
      gitBridgeDeliverables.delete(actorId);
      return notifyingParent ? deliverable : undefined;
    },
    log: (m) => console.log(`[mesh] ${m}`),
    retireCleanups: createStartRetireCleanups(workersDir, wakeCron, e2eInstance, {
      dir: antigravityScratchDir(),
      listActors: actorLiveness,
    }),
    // Eagerly generate this actor's avatar on spawn . Strictly
    // fire-and-forget and failure-isolated inside kickAvatarGeneration — a single
    // attempt, no retries, never blocks or affects wake/run/retry. Root is
    // adopted (not spawned), so it never reaches here; it uses the fixed image.
    onSpawn: (record) =>
      kickAvatarGeneration(record.id, {
        apiKey: config.geminiApiKey ?? "",
        rootId,
        log: (m) => console.log(`[avatar] ${m}`),
      }),
    onCapabilityGranted: refreshLiveActorMcp,
    // Make capability revocation take effect immediately: unmount the granted
    // endpoint so the actor's next write 404s, rather than waiting for it to be
    // reconstructed .
    onCapabilityRevoked: async (actorId, capability) => {
      await handleCapabilityRevoked(
        actorId,
        capability,
        () => mesh.activeCapabilitiesFor(actorId),
        grantableServers,
        mcpHttp
      );
      // removeServer closes active transports first (the fail-closed boundary),
      // then refresh the next-run config with any narrowed replacement URL.
      refreshLiveActorMcp(actorId);
    },
    onRetire: (record) => {
      teardownActorMcp(record.id);
    },
    onModelSet: (actorId, newModel, record) => {
      try {
        const effectiveProvider =
          record.provider ?? config.rootActor?.provider ?? DEFAULT_ROOT_PROVIDER;
        const updatedProvider = resolveProvider(config, effectiveProvider, newModel);
        const liveActor = mesh.get(actorId);
        if (liveActor && typeof liveActor.setProvider === "function") {
          liveActor.setProvider(updatedProvider);
        }
      } catch (err) {
        console.warn(
          `[mesh] failed to update live provider for ${actorId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
    // Recreate the private working directory for the revived actor
    onRevive: (record) => {
      try {
        mkdirSync(join(workersDir, record.id), { recursive: true });
      } catch (err) {
        console.warn(
          `[mesh] workdir recreation for ${record.id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
    createActor: (ctx) => {
      const id = ctx.record.id;
      const rec = ctx.record;
      // Provider/tier: run on the harness+model the spawn requested (e.g. a claude
      // worker, or a stronger model for review). Resolve before registering MCP servers
      // so resolution failures do not leave inert endpoints. Fall back to the root provider.
      let workerProvider = provider;
      if (rec.provider || rec.model) {
        try {
          workerProvider = resolveProvider(
            config,
            rec.provider ?? config.rootActor?.provider ?? DEFAULT_ROOT_PROVIDER,
            rec.model
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          const requestedProvider =
            rec.provider ?? config.rootActor?.provider ?? DEFAULT_ROOT_PROVIDER;
          const requestedModel = rec.model;
          const errorMsg = `worker ${id} spawn failed: requested provider "${requestedProvider}" / model "${requestedModel ?? "default"}" could not be resolved: ${reason}`;
          console.error(`[mesh] ${errorMsg}`);

          teardownActorMcp(id);
          registry.patch(id, { status: "retired" });

          mesh.recordEvent({
            kind: "run_end",
            actorId: id,
            success: false,
            detail: "spawn failed",
            body: errorMsg,
          });

          if (rec.parentId) {
            failureSink.sendToParent(rec.parentId, `[spawn failed] ${errorMsg}`, id);
          } else {
            failureSink.postToErrorChat?.(`⚠️ ${errorMsg}`);
          }
          throw new Error(errorMsg);
        }
      }

      try {
        const isFenced = () => mesh.isYielded(id);
        // A per-actor agent-execution endpoint, with this actor's identity baked in.
        const meshUrl = mcpHttp.addServer(id, () =>
          createAgentExecMcpServer(mesh, id, rootId, undefined, {
            onWrite: () => {
              mesh.markUnkillable(id);
            },
            isFenced,
          })
        );
        const inboxUrl = mcpHttp.addServer(`${id}:${INBOX_MCP_NAME}`, () =>
          createInboxMcpServer(inboxStore, id, {
            select: (entryIds) => mesh.selectInboxEntries(id, entryIds),
            selected: () => mesh.selectedInboxEntries(id),
            onHandled: () => mesh.inboxHandled(id),
            isFenced,
          })
        );
        const obligationsUrl = mcpHttp.addServer(`${id}:${OBLIGATIONS_MCP_NAME}`, () =>
          createObligationsMcpServer(getRepositories().obligations, id, {
            isFenced,
            resolveOwner: (raw) => resolveObligationOwner(registry, raw),
            canManage: (callerId, obligation) => mesh.isAncestorOf(callerId, obligation.ownerId),
          })
        );
        const meshChatUrl = mcpHttp.addServer(`${id}:${MESH_CHAT_MCP_NAME}`, () =>
          createMeshChatMcpServer(getRepositories().meshChat, id, { isFenced })
        );
        const pnpmInstallUrl = mcpHttp.addServer(`${id}:${PNPM_INSTALL_MCP_NAME}`, () =>
          createPnpmInstallMcpServer({ actorRootFor: (actorId) => join(workersDir, actorId) }, id, {
            isFenced,
          })
        );
        const repoUrl = mcpHttp.addServer(`${id}:${REPO_MCP_NAME}`, () =>
          createRepoMcpServer(id, issueClient, {
            onWrite: () => webhookSilenceDetector?.recordOutboundWrite(),
            instanceId: rootHandle,
            isFenced,
          })
        );
        const trackerUrl = mcpHttp.addServer(`${id}:${TRACKER_MCP_NAME}`, () =>
          createTrackerMcpServer(id, issueClient, {
            gitBridge: config.gitBridge ? { port: gitBridgePort } : undefined,
            onGitBridgeDeliverable: (actorId, instructions) => {
              gitBridgeDeliverables.set(actorId, instructions);
            },
            onWrite: () => webhookSilenceDetector?.recordOutboundWrite(),
            instanceId: rootHandle,
            isFenced,
            // Mechanically hand the created issue/PR's exact event source to its
            // creator : follow-up events route here, not the repo/org
            // steward. subscribedBy === actorId is the mechanical-subscription
            // audit marker. Best-effort: another actor may already hold the exact
            // resource (update-existing-PR path) — log and continue.
            onResourceCreated: (resource) => {
              mechanicallySubscribeCreatedResource(mesh, configuredRoots, resource, id);
            },
          })
        );
        const understandingUrl = mcpHttp.addServer(`${id}:${UNDERSTANDING_READ_MCP_NAME}`, () =>
          createUnderstandingReadServer(
            localWriteDeps,
            resolveUnderstandingRootNodeId(config),
            understandingStrings.loadStrings,
            { isFenced }
          )
        );
        const stuckLoopUrl = mcpHttp.addServer(`${id}:${STUCK_LOOP_DETECTOR_MCP_NAME}`, () =>
          createStuckLoopDetectorMcpServer(
            {
              registry,
              meshEvents: getRepositories().meshEvents,
              rootHandle,
            },
            { isFenced }
          )
        );
        const quotaUrl = mcpHttp.addServer(`${id}:${QUOTA_MCP_NAME}`, () =>
          createQuotaMcpServer({ config, workersDir }, quotaService, { isFenced })
        );

        const perActorShared: McpServerSpec[] = [
          { name: TRACKER_MCP_NAME, url: trackerUrl },
          { name: REPO_MCP_NAME, url: repoUrl },
          { name: UNDERSTANDING_READ_MCP_NAME, url: understandingUrl },
          { name: STUCK_LOOP_DETECTOR_MCP_NAME, url: stuckLoopUrl },
          { name: QUOTA_MCP_NAME, url: quotaUrl },
        ];
        if (chatClient) {
          const chatReadUrl = mcpHttp.addServer(`${id}:${CHAT_READ_MCP_NAME}`, () =>
            createChatReadMcpServer(chatClient, { isFenced })
          );
          perActorShared.push({ name: CHAT_READ_MCP_NAME, url: chatReadUrl });
        }

        // Workers get their per-actor shared tools, agent execution, and durable messaging.
        const workerMcp: McpServerSpec[] = [
          ...perActorShared,
          { name: AGENT_EXEC_MCP_NAME, url: meshUrl },
          { name: INBOX_MCP_NAME, url: inboxUrl },
          { name: OBLIGATIONS_MCP_NAME, url: obligationsUrl },
          { name: MESH_CHAT_MCP_NAME, url: meshChatUrl },
          { name: PNPM_INSTALL_MCP_NAME, url: pnpmInstallUrl },
        ];

        // Mount any capabilities granted to this actor (by id) on top of the default
        // worker set (ISSUE_NUM, phase 1a). A granted-but-not-mountable capability (none
        // registered) is skipped safely. Parameterized capabilities (e.g. chat-write:spaces/AAAA)
        // are aggregated by their base name and passed to the factory.
        workerMcp.push(
          ...mountGrantedServers(
            id,
            mesh.activeCapabilitiesFor(rec.id),
            grantableServers,
            mcpHttp,
            {
              isFenced: (actorId) => mesh.isYielded(actorId),
            }
          )
        );

        // Each worker gets its own private working directory and nothing else: its
        // whole scope (which repos to clone, how many PRs) lives in its charter, and
        // it clones whatever it needs in here itself — so it never touches the live
        // dev trees or collides with other actors.
        const cwd = join(workersDir, id);
        mkdirSync(cwd, { recursive: true });

        // Sandbox every worker that has a bwrap layout — agy AND claude .
        // Workers run untrusted code, so isolating them from the privileged plane is
        // mandatory: a fresh tmpfs /tmp stops one actor reading another's MCP-config
        // endpoint token from shared /tmp (identity harvest), and the read-only `/`
        // bind stops tampering ~/.rusa (threads.json / capability-grants.json).
        // Root is NOT built here and stays unsandboxed — it is the trusted plane.
        // The Actor derives the sandbox (rooted at cwd, git+gh); each provider mounts
        // its own auth dir rw (see providerWritableStateDirs).
        const sandbox = config.sandbox !== "container-boundary";
        const understandingMountEnabled = Boolean(config.understanding?.mount?.enabled && sandbox);

        let actor: Actor;
        actor = new Actor({
          id,
          cwd,
          provider: workerProvider,
          mcpServers: workerMcp,
          addDirs: [],
          sandbox,
          prepareUnderstandingMount: understandingMountEnabled
            ? async () => {
                const client = await localWriteDeps.getClient();
                if (!client) {
                  throw new Error("Understanding mount enabled but syncClient is not available");
                }
                const snapshotDir = mkdtempSync(join(tmpdir(), "rusa-iu-snapshot-"));
                try {
                  await renderUnderstandingSnapshot(
                    client,
                    snapshotDir,
                    resolveUnderstandingRootNodeId(config)
                  );
                  return snapshotDir;
                } catch (err) {
                  rmSync(snapshotDir, { recursive: true, force: true });
                  throw err;
                }
              }
            : undefined,
          // Portable-context actors (design ISSUE_NUM) are called STATELESS — never resume a
          // provider session — so the mesh, not the provider, owns their memory.
          loadSessionId: () =>
            registry.get(id)?.context?.type === "portable"
              ? undefined
              : registry.get(id)?.sessionId,
          saveSessionId: (sid) => {
            if (registry.get(id)?.context?.type === "portable") return;
            registry.patch(id, { sessionId: sid });
          },
          buildPrompt: () => {
            const r = registry.get(id);
            if (!r) return { prompt: "No active thread record." };
            const handles = resolveHandleLabels(r.handles, (hid) => registry.get(hid)?.charter);
            // Portable-context actors (design ISSUE_NUM) get their own recent run outputs
            // assembled into a stateless prefix; the per-run inject record rides on
            // this run's `run_start` event, not its own event kind.
            const injection = assembleConfiguredPortableInjection(
              r,
              portableContextApiKey,
              portableContextStore
            );
            return {
              prompt: buildWorkerPrompt(
                r.charter,
                {
                  threadId: id,
                  parentId: r.parentId ?? rootId,
                  handles,
                  understandingMountEnabled,
                },
                injection?.priorContext
              ),
              injectRecord: injection?.injectRecord,
            };
          },
          // No worker-side fallback : fallbacks are root-only. A worker's
          // quota exhaustion is not something it self-heals out of — it's a
          // signal to the worker's parent, who judges what happens next (see
          // the exhaustion-classified onRun failure notice below).
          gate: ctx.gate,
          beforeRun: ctx.beforeRun,
          // Compatibility only: Actor enforces one corrective yield prompt
          // regardless of this legacy cap value.
          maxContinuations: WORKER_MAX_CONTINUATIONS,
          onContinue: (n) =>
            mesh.recordEvent({
              kind: "run_continued",
              actorId: id,
              detail: `yield-elicitation ${n}/1`,
            }),
          onContinuationCapped: (n) => {
            mesh.recordEvent({
              kind: "continuation_capped",
              actorId: id,
              detail: `yield-elicitation exhausted after ${n} corrective run(s)`,
            });
            routeContinuationCapped(failureSink, id, n);
          },
          onQueued: (context) => {
            ctx.onQueued(context);
            mesh.recordEvent({
              kind: "run_queued",
              actorId: id,
              detail: context.mode,
            });
          },
          onRunStart: (responsive, injectRecord) =>
            mesh.recordEvent({
              kind: "run_start",
              actorId: id,
              detail: injectRecord
                ? `ctx ${injectRecord.bytes}B/${injectRecord.runCount}r/${injectRecord.hash.slice(0, 12)}`
                : undefined,
              body: injectRecord ? JSON.stringify(injectRecord) : undefined,
              payload: JSON.stringify({
                provider: providerThrottleKey(actor.getProvider().providerName, config),
                responsive,
              }),
            }),
          onFirstChunk: () =>
            mesh.recordEvent({
              kind: "run_first_chunk",
              actorId: id,
            }),
          onCoalesceAborted: (count, ageMs) => {
            mesh.recordEvent({
              kind: "run_coalesced",
              actorId: ctx.record.id,
              detail: `count=${count} age=${ageMs}ms`,
            });
          },
          onRunAbandoned: ({ reason, started }) =>
            mesh.recordEvent({
              kind: "run_abandoned",
              actorId: id,
              detail: reason,
              payload: JSON.stringify({ started } satisfies RunAbandonedPayload),
            }),
          onRunEnd: async (result) => {
            mesh.recordEvent({
              kind: "run_end",
              actorId: id,
              success: result.success,
              detail: result.exitCode == null ? undefined : `exit ${result.exitCode}`,
              body: result.output,
              payload: runEndPayload(result),
            });
            ctx.onRunEnd(result);
            const compacted = await compactPortableActorAfterRun(id);
            if (compacted) {
              mesh.recordEvent({
                kind: "portable_context_compacted",
                actorId: id,
                detail: describeCompaction(compacted),
                body: JSON.stringify(compacted),
              });
            }
            if (!result.success && !result.capped) {
              await routeRunFailure(
                failureSink,
                id,
                result,
                formatProviderLabel(actor.getProvider(), result.model)
              );
            }
          },
          log: makeFirehose(id), // firehose (4d: session-tag) → console + dashboard SSE
        });
        liveWorkerMcp.set(id, workerMcp);
        return actor;
      } catch (err) {
        teardownActorMcp(id);
        throw err;
      }
    },
  });
  // Route head changes as soon as the mesh exists — ahead of rehydration, which
  // is what registers the per-actor obligations MCP servers, and well ahead of
  // the dashboard binding its port. A head change cannot commit into a sink
  // that is still undefined.
  //
  // Boot sweep below over `readyHeads()` reconciles heads at startup.
  readyHeadSink = ({ ownerId, head, previousHeadId, sequence }) => {
    mesh.deliverReadyHeadAttention(
      ownerId,
      head === null ? null : { id: head.id, intent: head.intent },
      previousHeadId,
      sequence
    );
  };

  const rootControl = new RootControlService({
    mesh,
    rootId: rootId,
    providers: Object.keys(config.providers),
  });

  // Mechanical failure forwarding: a failed run goes to its parent's inbox, or —
  // for the root, which has no parent — to the statically configured error chat.
  const errorChat = config.chat?.errorChat;
  // The raw delivery to the human's error chat.
  const sendToErrorChat =
    chatClient && errorChat
      ? (text: string) => {
          void chatClient?.send(errorChat, text).catch((err) => {
            console.warn(
              `[failure-sink] error chat post failed: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        }
      : null;
  // Governor: alert eagerly on the first failure, then coalesce a storm into one
  // summary per growing window (so a rate-limit cascade can't DM the human 14×).
  const errorNotifier = sendToErrorChat ? new CoalescingNotifier({ send: sendToErrorChat }) : null;
  webhookSilenceDetector = new WebhookSilenceDetector({
    notify: sendToErrorChat ?? undefined,
    log: (m) => console.warn(m),
    proberTarget: config.webhook?.proberTarget,
    probe: async (repo, issueNumber) => {
      const stamp = stampAuthor(rootId, repo, issueNumber, rootHandle);
      await issueClient.postComment(
        repo,
        issueNumber,
        `[webhook-silence-probe] active check from ${rootHandle}\n\n${stamp}`
      );
    },
  });
  const failureSink: FailureSinkDeps = {
    registry,
    sendToParent: (toId, body, fromId, forensics) =>
      mesh.deliverMechanicalInboxNotice(toId, body, fromId, forensics),
    postToErrorChat: errorNotifier ? (text) => errorNotifier.notify(text) : null,
    rootId: rootId,
    log: (m) => console.warn(`[failure-sink] ${m}`),
    workersDir,
    // ISSUE_NUM: name quota exhaustion in the failure notice so a worker's parent
    // (who now owns the fallback judgment) can see the cause up front.
    classify: classifyExhaustion,
  };

  // ── Nightly wake trigger (cron-backed, ISSUE_NUM phase 1c) ──
  // A cron job in the familiar account's OWN crontab pings the loopback /wake
  // endpoint with a bearer token; the endpoint delivers a mechanical wake. Cron
  // owns timing + durability (no in-process scheduler). The token lives in a
  // chmod-600 file; the endpoint's ephemeral port is published to a file so the
  // cron line (which reads it via `$(cat …)`) survives restarts.
  const wakeToken = ensureWakeToken(mcHome);
  writeWakePort(mcHome, mcpHttp.boundPort);
  mcpHttp.setWakeHandler({
    token: wakeToken,
    deliver: (actorId, reason, priority) => mesh.deliverWake(actorId, reason, priority),
  });

  // ── Host-jobs exit endpoint  ──
  // Same bearer token/port as /wake — one host-side secret file. The installed
  // wake-on-exit.sh (ExecStopPost on every job's transient unit) posts here on
  // every stop (clean exit, non-zero exit, OOM-kill, or a stop_job-triggered
  // SIGTERM); this records the job-specific ledger event THEN wakes the
  // submitting actor via the same deliverWake mechanism /wake uses, so a job
  // finishing looks like any other mesh wake to the actor that submitted it.
  ensureWakeOnExitScript(mcHome, {
    tokenFile: wakeTokenPath(mcHome),
    portFile: wakePortPath(mcHome),
  });
  mcpHttp.setHostJobExitHandler({
    token: wakeToken,
    onExit: (payload) =>
      handleHostJobExit(
        {
          store: hostJobStore,
          recordEvent: (event) => mesh.recordEvent(event),
          deliverWake: (actorId, reason) => mesh.deliverWake(actorId, reason),
        },
        payload
      ),
  });

  // ── Root actor ──
  const rootAgentDir = join(mcHome, "root-agent");
  mkdirSync(rootAgentDir, { recursive: true });
  const sessionFile = join(rootAgentDir, "session.json");
  const rootMeshUrl = mcpHttp.addServer(rootId, () =>
    createAgentExecMcpServer(mesh, rootId, rootId, wakeCron, {
      rootControl,
      onWrite: () => {
        mesh.markUnkillable(rootId);
      },
    })
  );
  const rootInboxUrl = mcpHttp.addServer(`${rootId}:${INBOX_MCP_NAME}`, () =>
    createInboxMcpServer(inboxStore, rootId, {
      select: (entryIds) => mesh.selectInboxEntries(rootId, entryIds),
      selected: () => mesh.selectedInboxEntries(rootId),
      onHandled: () => mesh.inboxHandled(rootId),
    })
  );
  const rootMeshChatUrl = mcpHttp.addServer(`${rootId}:${MESH_CHAT_MCP_NAME}`, () =>
    createMeshChatMcpServer(getRepositories().meshChat, rootId)
  );
  const rootObligationsUrl = mcpHttp.addServer(`${rootId}:${OBLIGATIONS_MCP_NAME}`, () =>
    createObligationsMcpServer(getRepositories().obligations, rootId, {
      canManage: () => true,
      resolveOwner: (raw) => resolveObligationOwner(registry, raw),
    })
  );
  const rootPnpmInstallUrl = mcpHttp.addServer(`${rootId}:${PNPM_INSTALL_MCP_NAME}`, () =>
    createPnpmInstallMcpServer(
      {
        actorRootFor: (actorId) => (actorId === rootId ? rootAgentDir : join(workersDir, actorId)),
      },
      rootId
    )
  );
  const rootRepoUrl = mcpHttp.addServer(`${rootId}:${REPO_MCP_NAME}`, () =>
    createRepoMcpServer(rootId, issueClient, {
      onWrite: () => webhookSilenceDetector?.recordOutboundWrite(),
      instanceId: rootHandle,
    })
  );
  const rootTrackerUrl = mcpHttp.addServer(`${rootId}:${TRACKER_MCP_NAME}`, () =>
    createTrackerMcpServer(rootId, issueClient, {
      gitBridge: config.gitBridge ? { port: gitBridgePort } : undefined,
      onWrite: () => webhookSilenceDetector?.recordOutboundWrite(),
      instanceId: rootHandle,
      // Uniform rule : the root gets mechanical subscriptions for what
      // it creates too, and can delegate them onward.
      onResourceCreated: (resource) => {
        mechanicallySubscribeCreatedResource(mesh, configuredRoots, resource, rootId);
      },
    })
  );

  const cc = chatClient;
  let allowedSpaces: string[] = [];
  if (config.chat) {
    if (config.chat.gchat === "all") {
      allowedSpaces = ["*"];
      console.log(`[mesh] root chat capability scoped to all spaces`);
    } else if (Array.isArray(config.chat.gchat)) {
      allowedSpaces = config.chat.gchat;
      console.log(`[mesh] root chat capability scoped to ${allowedSpaces.length} space(s)`);
    } else if (config.chat.gchat === undefined) {
      allowedSpaces = ["*"];
      console.log(`[mesh] root chat capability unrestricted (gchat absent from config)`);
    }
  }

  const rootChatUrl =
    config.chat && cc
      ? mcpHttp.addServer(`${rootId}:${CHAT_WRITE_MCP_NAME}`, () =>
          createChatWriteMcpServer(rootId, cc, {
            allowedSpaces,
            onWrite: (actorId) => {
              mesh.markUnkillable(actorId);
            },
            workDir: rootAgentDir,
          })
        )
      : undefined;

  rootMcp.push(
    ...sharedMcp,
    { name: TRACKER_MCP_NAME, url: rootTrackerUrl },
    { name: REPO_MCP_NAME, url: rootRepoUrl },
    { name: AGENT_EXEC_MCP_NAME, url: rootMeshUrl },
    { name: INBOX_MCP_NAME, url: rootInboxUrl },
    { name: OBLIGATIONS_MCP_NAME, url: rootObligationsUrl },
    { name: MESH_CHAT_MCP_NAME, url: rootMeshChatUrl },
    { name: PNPM_INSTALL_MCP_NAME, url: rootPnpmInstallUrl }
  );
  if (rootChatUrl) {
    rootMcp.push({ name: CHAT_WRITE_MCP_NAME, url: rootChatUrl });
  }
  refreshLiveActorMcp(rootId);

  // ── Self-update tool — ROOT-ONLY . The agent asks `update` to redeploy:
  // pull + build IN PLACE (mesh stays live), and only on a green build engage the
  // in-memory gracefulShutdown brake (a direct call — no HTTP), drain the OTHER
  // actors (self-excluding), and exit(0) so systemd restarts onto the fresh code.
  // Mounted ONLY on root's set here, never the worker set (like chat); the handler
  // also asserts selfId===rootId. Best-effort: if the deploy checkout can't be
  // resolved, the mesh still boots without the tool.
  try {
    const repoRoot = resolveRepoRoot();
    const packageDir = join(repoRoot, "packages", "rusa");
    const errorChatSpace = config.chat?.errorChat;
    const deployBranch = config.deployBranch ?? DEFAULT_DEPLOY_BRANCH;
    if (!errorChatSpace) {
      console.warn("[update] no errorChat configured — lifecycle pings disabled");
    } else if (!chatClient) {
      console.warn("[update] chat client unavailable — lifecycle pings disabled");
    }
    const updateToolDeps: UpdateToolDeps = {
      plan: { branch: deployBranch, drainTimeoutMs: UPDATE_DRAIN_TIMEOUT_MS },
      rootId: rootId,
      deps: {
        git: new GitRunner(repoRoot),
        build: new BuildRunner(
          packageDir,
          { installMs: UPDATE_INSTALL_TIMEOUT_MS, buildMs: UPDATE_BUILD_TIMEOUT_MS },
          (m) => console.log(m)
        ),
        drain: new MeshDrainer(gracefulShutdown, () => mesh.activeRunThreadIds(), rootId),
        notify:
          chatClient && errorChatSpace
            ? { notify: (text) => chatClient.send(errorChatSpace, text).then(() => {}) }
            : undefined,
        // Chat-independent durable marker for the worst states (e.g. a failed
        // rollback) — same file the boot-flap alert appends to.
        alertMarker: (text: string) => {
          try {
            mkdirSync(join(mcHome, "alerts"), { recursive: true });
            appendFileSync(
              join(mcHome, "alerts", "last-failure.txt"),
              `[${new Date().toISOString()}] ${text}\n`,
              "utf8"
            );
          } catch {
            /* best-effort marker */
          }
        },
        recordAction: (text: string) => {
          mkdirSync(join(mcHome, "audit"), { recursive: true });
          appendFileSync(
            join(mcHome, "audit", "update.log"),
            `[${new Date().toISOString()}] ${text}\n`,
            "utf8"
          );
        },
        // A successful self-update is a mesh shutdown even though it exits from
        // inside the update tool instead of the SIGTERM shutdown path.
        exit: (code) => {
          e2eInstance.stopForMeshShutdown();
          process.exit(code);
        },
        log: (m) => console.log(m),
      },
    };
    const updateUrl = mcpHttp.addServer(UPDATE_MCP_NAME, () =>
      createUpdateMcpServer(updateToolDeps, rootId)
    );
    rootMcp.push({ name: UPDATE_MCP_NAME, url: updateUrl });
  } catch (err) {
    console.warn(
      `[update] self-update tool not mounted: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const pnpmHardlinksDeps: PnpmHardlinksToolDeps = {
    rootId: rootId,
    workersDir,
    registry,
    runningThreadIds: () => mesh.activeRunThreadIds(),
  };
  const pnpmHardlinksUrl = mcpHttp.addServer(PNPM_HARDLINKS_MCP_NAME, () =>
    createPnpmHardlinksMcpServer(pnpmHardlinksDeps, rootId)
  );
  rootMcp.push({ name: PNPM_HARDLINKS_MCP_NAME, url: pnpmHardlinksUrl });

  const externalRoot = opts?.e2e?.rootDriver === "external" ? new ExternalRootDriver(rootId) : null;
  let root: MeshActor;
  root =
    externalRoot ??
    new Actor({
      id: rootId,
      cwd: rootAgentDir,
      provider,
      mcpServers: rootMcp,
      addDirs,
      sandbox: Boolean(opts?.e2e),
      isE2eRoot: Boolean(opts?.e2e),
      loadSessionId: () =>
        registry.get(rootId)?.context?.type === "portable"
          ? undefined
          : loadRootSessionId(sessionFile),
      saveSessionId: (id) => {
        if (registry.get(rootId)?.context?.type === "portable") return;
        saveRootSessionId(sessionFile, id); // root session file stays authoritative for the root
        registry.patch(rootId, { sessionId: id });
      },
      buildPrompt: () => {
        const record = registry.get(rootId);
        if (!record) return { prompt: "No active root thread record." };
        const injection = assembleConfiguredPortableInjection(
          record,
          portableContextApiKey,
          portableContextStore
        );
        return {
          prompt: buildRootPrompt(config.rootActor?.charter, rootHandle, injection?.priorContext),
          injectRecord: injection?.injectRecord,
        };
      },
      fallback: fallbackModels
        ? {
            models: fallbackModels,
            resolveProvider: (model) =>
              resolveProvider(config, config.rootActor?.provider ?? DEFAULT_ROOT_PROVIDER, model),
            classify: classifyExhaustion,
          }
        : undefined,
      // Responsive human wakes bypass normal pacing/concurrency; background root
      // wakes use the same normal scheduling path as workers.
      beforeRun: ({ mode }): boolean => {
        if (isProviderHalted(rootProviderName) || gracefulShutdown.isShuttingDown()) {
          return false;
        }
        if (mode === "yield-elicitation") return true;
        const watermark = root.getInterruptedWatermark?.();
        if (watermark) {
          const entries = inboxStore.list(rootId, { status: "unhandled" }).entries;
          return entries.some((e) => e.deliveredAt > watermark);
        }
        return inboxStore.countUnhandled(rootId) > 0;
      },
      gate: (fn, providerName, responsive) => mesh.gateRun(fn, providerName, responsive, rootId),
      onContinue: (n) =>
        mesh.recordEvent({
          kind: "run_continued",
          actorId: rootId,
          detail: `yield-elicitation ${n}/1`,
        }),
      onContinuationCapped: (n) => {
        mesh.recordEvent({
          kind: "continuation_capped",
          actorId: rootId,
          detail: `yield-elicitation exhausted after ${n} corrective run(s)`,
        });
        routeContinuationCapped(failureSink, rootId, n);
      },
      onQueued: (context) => {
        mesh.actorQueued(rootId, context);
        mesh.recordEvent({
          kind: "run_queued",
          actorId: rootId,
          detail: context.mode,
        });
      },
      onRunStart: (responsive, injectRecord) =>
        mesh.recordEvent({
          kind: "run_start",
          actorId: rootId,
          detail: injectRecord
            ? `ctx ${injectRecord.bytes}B/${injectRecord.runCount}r/${injectRecord.hash.slice(0, 12)}`
            : undefined,
          body: injectRecord ? JSON.stringify(injectRecord) : undefined,
          payload: JSON.stringify({
            provider: providerThrottleKey(provider.providerName, config),
            responsive,
          }),
        }),
      onFirstChunk: () =>
        mesh.recordEvent({
          kind: "run_first_chunk",
          actorId: rootId,
        }),
      onCoalesceAborted: (count, ageMs) => {
        mesh.recordEvent({
          kind: "run_coalesced",
          actorId: rootId,
          detail: `count=${count} age=${ageMs}ms`,
        });
      },
      onRunAbandoned: ({ reason, started }) =>
        mesh.recordEvent({
          kind: "run_abandoned",
          actorId: rootId,
          detail: reason,
          payload: JSON.stringify({ started } satisfies RunAbandonedPayload),
        }),
      onRunEnd: async (result) => {
        mesh.finishInboxRun(rootId);
        mesh.recordEvent({
          kind: "run_end",
          actorId: rootId,
          success: result.success,
          detail: result.exitCode == null ? undefined : `exit ${result.exitCode}`,
          body: result.output,
          payload: runEndPayload(result),
        });
        const compacted = await compactPortableActorAfterRun(rootId);
        if (compacted) {
          mesh.recordEvent({
            kind: "portable_context_compacted",
            actorId: rootId,
            detail: describeCompaction(compacted),
            body: JSON.stringify(compacted),
          });
        }
        if (!result.success && !result.capped) {
          await routeRunFailure(
            failureSink,
            rootId,
            result,
            formatProviderLabel(provider, result.model)
          );
        }
      },
      log: makeFirehose(rootId), // firehose → console + dashboard SSE
    });
  const rootRecord: ThreadRecord = {
    id: rootId,
    charter: config.rootActor?.charter ?? DEFAULT_ROOT_CHARTER,
    parentId: null,
    isRoot: true,
    provider: config.rootActor?.provider,
    model: config.rootActor?.model,
    context: config.rootActor?.context,
    sessionId:
      config.rootActor?.context?.type === "portable" ? undefined : loadRootSessionId(sessionFile),
    status: "active",
    createdAt: new Date().toISOString(),
  };
  mesh.adopt(rootRecord, root);
  const scheduleHaltExpiry = (until?: string) => {
    if (haltExpiryTimer) clearTimeout(haltExpiryTimer);
    haltExpiryTimer = null;
    if (!until) return;
    const delay = Date.parse(until) - Date.now();
    if (delay <= 0) {
      mesh.resumeCancelledRuns();
      mesh.reconcileUnseenInbox();
      return;
    }
    haltExpiryTimer = setTimeout(
      () => {
        haltExpiryTimer = null;
        const state = haltSwitch.state();
        if (state?.until) {
          scheduleHaltExpiry(state.until);
          return;
        }
        if (state) return;
        const resumed = mesh.resumeCancelledRuns();
        mesh.reconcileUnseenInbox();
        console.warn(
          `[mesh] ▶ HALT expired${resumed.length ? ` — replayed ${resumed.length} queued run(s)` : ""}`
        );
      },
      Math.min(delay, 2_147_483_647)
    );
    haltExpiryTimer.unref?.();
  };
  if (externalRoot) {
    rootControl.recordDriverAttached("e2e-controller");
    console.log(`[root] driver=external tools=${rootMcp.map((u) => u.name).join(",")}`);
  } else {
    const rootContext = config.rootActor?.context;
    const sessionDescription =
      rootContext?.type === "portable"
        ? `portable/${rootContext.mode} (stateless)`
        : (loadRootSessionId(sessionFile) ?? "(new)");
    console.log(
      `[root] provider=${provider.name} session=${sessionDescription} tools=${rootMcp.map((u) => u.name).join(",")}`
    );
  }

  // Restore live actors for threads the registry persisted across the last
  // restart. Must run after the root is adopted (so a worker's parent is live
  // before the worker). Retired threads stay dead; rehydration never wakes an
  // actor by itself. Message-trigger reconciliation runs immediately after
  // rehydration, replaying any `send_message` trigger claimed by a run that
  // never completed (drain or hard kill). Cron wakes and GitHub events remain
  // outside this path by design.
  mesh.rehydrateAll();
  mesh.reconcilePendingDeliveries();
  mesh.reconcileInbox();
  try {
    mesh.reconcileReadyHeads(getRepositories().obligations);
  } catch (_err) {
    // Database may be closed during test shutdown/teardown races
  }
  const restored = registry.list().filter((r) => r.status === "active" && r.id !== rootId);
  if (restored.length > 0) {
    console.log(`[mesh] rehydrated ${restored.length} active thread(s) from the registry`);
  }

  // One-time avatar backfill : generate a cached avatar for every currently
  // live actor that lacks one, so existing actors get an avatar without waiting to
  // respawn. Strictly fire-and-forget — the root and already-cached handles are
  // no-ops inside the generator, and any failure is isolated to a log line.
  backfillAvatars(
    registry
      .list()
      .filter((r) => r.status === "active")
      .map((r) => r.id),
    { apiKey: config.geminiApiKey ?? "", rootId, log: (m) => console.log(`[avatar] ${m}`) }
  );

  // ── Inbound edges → root inbox ──
  const webhookPort = config.webhook?.port ?? 9742;
  const webhookSecret = config.webhook?.secret ?? "";
  const dashboardPort = config.dashboard?.port ?? 8080;
  const dashboardBindHost = config.dashboard?.bindHost ?? "127.0.0.1";
  const botLogin = config.github.account?.toLowerCase();
  const excludedGitHubRepos = new Set(
    (config.github.orgs ?? [])
      .flatMap((entry) => entry.excludedRepos ?? [])
      .map((repo) => repo.toLowerCase())
  );

  const onEvent = async (
    event: string,
    payload: Record<string, unknown>,
    deliveryId?: string
  ): Promise<void> => {
    // Note: recordInboundEvent MUST be the first statement here.
    // The prober relies on the probe's own echo being recorded as inbound activity before it is
    // suppressed as a self-event. If this is moved after the suppression check, the prober will never succeed.
    webhookSilenceDetector?.recordInboundEvent();
    const sender = (payload.sender as { login?: string } | undefined)?.login;
    const action = (payload.action as string | undefined) ?? "-";
    const repoFullName = (payload.repository as { full_name?: string } | undefined)?.full_name;
    const repo = repoFullName ?? "?";
    if (repoFullName && excludedGitHubRepos.has(repoFullName.toLowerCase())) {
      console.log(
        `[github] configured excluded repository event dropped: ${event} on ${repoFullName}`
      );
      return;
    }
    // Directive-only: this walks a parent fallback chain and must never feed authorship.
    // See authorStampBodyForWebhookPayload.
    const directiveBody = directiveBodyForWebhookPayload(payload);

    const number =
      (payload.pull_request as { number?: number } | undefined)?.number ??
      (payload.issue as { number?: number } | undefined)?.number;

    const stampedAuthor = resolveStampedAuthor({
      event,
      action,
      payload,
      sender,
      botLogin,
      repoFullName,
      number,
      onAnomaly: (anomaly) => {
        if (anomaly.detail === "forgery") {
          console.error(`[webhook] ⚠️ LOUD stamp invalid signal: ${anomaly.reason}`);
        }
        mesh.recordEvent({
          kind: "stamp_invalid",
          actorId: anomaly.actorId,
          detail: anomaly.detail,
          body: anomaly.body,
        });
      },
    });

    const parsedDirective = parseDirectedDeliveryDirective(directiveBody);
    const directedTarget =
      parsedDirective && botLogin != null && sender?.toLowerCase() === botLogin
        ? parsedDirective
        : null;
    if (parsedDirective && !directedTarget) {
      console.log(
        `[webhook] mesh:deliver directive from non-bot sender ${sender ?? "<unknown>"} — directive ignored`
      );
    }
    // Tracker-churn suppression, v1 (ISSUE_NUM; Operator's rulings 2026-07-16). An
    // EXPLICIT list of bot-sender event types that never notify — only the
    // tracker-churn types ownership automation generates, which
    // carry no body a stamp could speak for and were the storm's wake noise
    // ("twenty owner-label wakes in thirty seconds"). An actor that needs a
    // suppressed action to notify anyway has a simple workaround: also post a
    // (stamped) comment — comments are body-ful and ride the stamp tier.
    //
    // Deliberately NOT suppressed (the v1 narrowing, replacing an earlier
    // blanket "all bodiless bot events" rule): `pull_request/closed`, `push`,
    // and `create`/`delete` — humans merge PRs, and `github_branch` event
    // sources rely on push/branch events to notify an exact deploy subscriber.
    // Unknown/new event types reach exact subscribers but do not bubble ;
    // add to this sender-level list only with a ruling.
    //
    // `!directedTarget` keeps a bot-authored mesh:deliver directive working
    // even if it were to arrive on a suppressed event type. Drops are
    // stdout-log-only (Operator's ISSUE_NUM review: a suppressed non-event doesn't
    // warrant a mesh event). A human operating AS the bot account via raw
    // `gh` has these actions suppressed the same way — the rule can't
    // distinguish "the mesh wrote this" from "a human used the bot's
    // credentials to write this."
    if (
      botLogin != null &&
      sender?.toLowerCase() === botLogin &&
      BOT_SUPPRESSED_EVENT_TYPES.has(`${event}/${action}`) &&
      !directedTarget
    ) {
      const summary = `sender=${sender} repo=${repo}${number != null ? `#${number}` : ""}`;
      console.log(`[webhook] suppressed bot-sender event dropped: ${event}/${action} (${summary})`);
      return;
    }
    if (NEVER_DELIVERED_EVENT_TYPES.has(`${event}/${action}`)) {
      const summary = `sender=${sender ?? "<unknown>"} repo=${repo}${number != null ? `#${number}` : ""}`;
      console.log(`[webhook] never-delivered event dropped: ${event}/${action} (${summary})`);
      return;
    }
    // Not in the set above, because the set reads a type string and the
    // deciding field is in the payload: a check suite wakes its owner when it
    // is red and stays quiet when it is green.
    if (event === "check_suite" && action === "completed" && !checkSuiteWakesAnyone(payload)) {
      const summary = `sender=${sender ?? "<unknown>"} repo=${repo}${number != null ? `#${number}` : ""}`;
      console.log(`[webhook] non-actionable check suite dropped: ${event}/${action} (${summary})`);
      return;
    }

    const eventSummary = `GitHub ${event}/${action} on ${repo}`;
    if (repoFullName) {
      const notification = deriveGitHubInboxNotification(event, payload);
      if (!notification) throw new Error("GitHub event repository could not be resolved");
      await mesh.deliverEvent(notification.resource, eventSummary, {
        directedTarget,
        stampedAuthor,
        instanceId: rootHandle,
        inboxPayload: notification.payload,
        inboxDedupeKey: deliveryId ? `github:${deliveryId}` : undefined,
      });
    } else {
      if (stampedAuthor !== null) {
        if (stampedAuthor.actorId === rootId && stampedAuthor.instanceId === rootHandle) {
          console.log(`[webhook] self-event ${event} by root — ignored`);
          return;
        }
      }
      console.warn(`[webhook] event without a durable source pointer dropped: ${eventSummary}`);
    }
  };

  // In e2e mode the runner drives GitHub events in-process via the onReady
  // handle, so we don't bind the real webhook/dashboard servers (avoids port
  // collisions and the need to sign synthetic webhook payloads).
  const e2eMode = Boolean(opts?.e2e?.onReady);
  const noDashboardServer = opts?.noDashboardServer ?? false;
  const ingestionMode = config.github.ingestionMode ?? "webhook";
  const webhookServer = shouldBindWebhookServer({ e2eMode, ingestionMode })
    ? await startWebhookServer({
        secret: webhookSecret,
        onEvent,
        port: webhookPort,
        onNonWebhookRequest: noDashboardServer
          ? createDashboardRequestHandler({ port: webhookPort, serveUi: false })
          : undefined,
      })
    : null;
  const githubPoller =
    !e2eMode &&
    ingestionMode === "poll" &&
    ((config.github.repos?.length ?? 0) > 0 || (config.github.orgs?.length ?? 0) > 0)
      ? startGitHubEventPoller({
          repos: config.github.repos ?? [],
          orgs: config.github.orgs ?? [],
          deployBranch: config.deployBranch ?? DEFAULT_DEPLOY_BRANCH,
          intervalSeconds: config.github.pollIntervalSeconds,
          home: mcHome,
          issueClient,
          onEvent,
        })
      : null;
  // Walkie-talkie mode, server half : gated on geminiApiKey (transcription
  // and TTS are host-side Gemini calls — the key never reaches workers). When
  // absent the voice routes 503 with a clear error and nothing else changes.
  const geminiApiKey = config.geminiApiKey?.trim();
  const voiceService = geminiApiKey
    ? createVoiceService({ home: mcHome, apiKey: geminiApiKey, voice: config.voice })
    : null;
  const dashboardServer = shouldBindDashboardServer({
    e2eMode,
    e2eDashboard: opts?.e2e?.dashboard === true,
    noDashboardServer,
  })
    ? await startDashboardServer({
        port: dashboardPort,
        bindHost: dashboardBindHost,
        // Bind the live mesh so the dashboard Data API + SSE serve real data.
        mesh: {
          mesh,
          registry,
          meshEvents: getRepositories().meshEvents,
          meshChat: getRepositories().meshChat,
          obligations: getRepositories().obligations,
          inbox: getRepositories().inbox,
          emitter: meshEmitter,
          // Read-only exposures: the emergency-brake state and a snapshot of
          // which actors are executing a run right now — for the header HALTED
          // indicator and per-thread run-state dots. No new mesh behavior.
          isHalted: () => haltSwitch.hasActiveHalt(),
          runningThreadIds: () => mesh.runningThreadIds(),
          queuedThreadIds: () => mesh.queuedThreadIds(),
          providerQueueHeads: () =>
            [...providerPacers.values()].flatMap((pacer) => {
              const head = pacer.queueHead;
              return head
                ? [
                    {
                      threadId: head.threadId,
                      availableAt: new Date(head.availableAt).toISOString(),
                    },
                  ]
                : [];
            }),
          rootControl,
          // The configured root identity  — display handle + avatar
          // override — so the dashboard shows this instance's own identity
          // instead of the default root-actor.
          rootIdentity: { id: rootId, handle: rootHandle, avatarPath: config.rootActor?.avatar },
          // On-demand avatar generation  reuses the same key the
          // walkie-talkie transcription/TTS calls above already gate on.
          geminiApiKey,
        },
        // The IU calibration view's server half (ISSUE_NUM 2b): a read-only paginated
        // op-getter over the distiller's LOCAL would-be-graph files (baseline + ops-log),
        // NOT a live Firestore query — this reader is built without a remote op sink, so
        // it stays purely local even though the write client now syncs live. The
        // canonical rootNodeId is surfaced so the view anchors to that root (renders its
        // children as the top level, hides the root) — same root the read MCP anchors on.
        understandingOps: {
          ...createUnderstandingOpsReader(mcHome),
          // Resolve externalized node bodies (glass_goals `v001_strings`) so the view renders
          // content, not just structure — read-only, same trust as the baseline pull.
          ...createUnderstandingStringsResolver(config),
          rootNodeId: resolveUnderstandingRootNodeId(config) ?? null,
        },
        // Cached per-provider quota snapshot : reads the same shared
        // `QuotaService` TTL cache the `get_quota` MCP tool uses above, but via
        // `getQuotaCached`, which never triggers-and-awaits a live PTY probe in
        // the request path (issue #10). It serves the latest known reading
        // immediately (stale-while-revalidate) and kicks any refresh in the
        // background; a cold cache falls back to the durable quota DB below via
        // `listHistory`.
        quotaApi: opts?.e2e?.quotaApi ?? {
          getQuota: async (provider) => quotaService.getQuotaCached(provider),
          providers: quotaProviders,
          getThrottle: (provider) => quotaThrottleStatuses.get(provider) ?? null,
          listHistory: sharedQuotaStore
            ? (provider, sinceIso) => sharedQuotaStore.listHistorySince(provider, sinceIso)
            : undefined,
        },
        // IU reports reader (ISSUE_NUM/ISSUE_NUM): serves GET /api/understanding/reports
        // for the reports tab. The standalone `dashboard` command wires this
        // too (dashboard.ts) — without it the real prod/start server 404s the
        // route. `mcHome` is already in scope (it feeds understandingOps above).
        iuReportsApi: { mcHome },
        dashboardConfig: { quotaProviders: config.dashboard?.quotaProviders },
        // Walkie-talkie voice routes + reply-TTS hook ; undefined when
        // no geminiApiKey is configured (routes then 503).
        voice: voiceService ? { service: voiceService } : undefined,
      })
    : null;
  if (dashboardServer) console.log(`[dashboard] http://${dashboardBindHost}:${dashboardPort}`);

  // ── Google Chat inbound (optional; disabled when config.chat is absent) ──
  let chatSource: ChatSource | null = null;
  let weSubscriber: WorkspaceEventsSubscriber | null = null;
  if (config.chat && chatClient) {
    const cc = chatClient;
    // The inbound handler is the same for the real puller and the e2e fake: a
    // trigger (DM or @mention) persists a source-backed pointer and wakes the root.
    const onChat = async (msg: ChatMessage): Promise<void> => {
      if (config.chat?.excludedSpaces?.includes(msg.spaceName)) {
        return;
      }
      const trigger = msg.isDirectMessage || msg.mentionsSelf;
      const who = msg.senderDisplayName ?? msg.senderName;
      console.log(`[chat] ${trigger ? "▶ trigger" : "·"} ${msg.spaceName} from ${who}`);
      if (!trigger) return;
      // Mechanical emergency brake — matched here at the ingestion edge, with NO
      // LLM in the loop, so it works even when every actor is wedged (the exact
      // situation you'd want it in). It toggles the same HALT sentinel file you
      // can touch by hand; the reply is a direct send, not a root run.
      const cmd = msg.text?.trim() ?? "";
      let haltCommand: HaltCommand | null;
      try {
        haltCommand = parseHaltCommand(cmd);
      } catch (err) {
        void cc
          .send(
            msg.spaceName,
            `⛔ Halt command rejected: ${err instanceof Error ? err.message : String(err)}.`
          )
          .catch(() => {});
        return;
      }
      if (haltCommand) {
        const unknownProviders = (haltCommand.providers ?? []).filter(
          (providerName) => config.providers[providerName] === undefined
        );
        if (unknownProviders.length > 0) {
          void cc
            .send(
              msg.spaceName,
              `⛔ Halt command rejected: provider${unknownProviders.length === 1 ? "" : "s"} ${unknownProviders.join(", ")} ${unknownProviders.length === 1 ? "is" : "are"} not configured.`
            )
            .catch(() => {});
          return;
        }
        if (haltCommand.until && Date.parse(haltCommand.until) <= Date.now()) {
          void cc
            .send(msg.spaceName, "⛔ Halt command rejected: until must be in the future.")
            .catch(() => {});
          return;
        }
        if (!haltSwitch.halt(`chat /halt from ${who}`, haltCommand)) {
          void cc
            .send(
              msg.spaceName,
              "⛔ Cannot halt while a current halt is already in place. Send /resume, then issue a new halt with every provider you wish to halt."
            )
            .catch(() => {});
          return;
        }
        const cancelled = mesh.cancelHaltedQueuedRuns();
        scheduleHaltExpiry(haltCommand.until);
        console.warn(`[mesh] ⛔ HALT engaged via chat by ${who}`);
        const scope = haltCommand.providers?.length
          ? `provider${haltCommand.providers.length === 1 ? "" : "s"} ${haltCommand.providers.join(", ")}`
          : "all actor runs";
        const expiry = haltCommand.until ? ` until ${haltCommand.until}` : "";
        const flushed = cancelled.length ? ` Cleared ${cancelled.length} queued run(s).` : "";
        void cc
          .send(msg.spaceName, `⛔ Halted ${scope}${expiry}.${flushed} Send /resume to continue.`)
          .catch(() => {});
        return;
      }
      if (/^\/(?:resume|continue)$/i.test(cmd)) {
        haltSwitch.resume();
        if (haltExpiryTimer) clearTimeout(haltExpiryTimer);
        haltExpiryTimer = null;
        const resumed = mesh.resumeCancelledRuns();
        mesh.reconcileUnseenInbox();
        console.warn(`[mesh] ▶ HALT cleared via chat by ${who}`);
        void cc
          .send(
            msg.spaceName,
            `▶ Resumed${resumed.length ? ` — replayed ${resumed.length} queued run(s)` : " — actors will run on the next trigger"}.`
          )
          .catch(() => {});
        return;
      }
      await mesh.deliverEvent(
        `gchat:${msg.spaceName.startsWith("spaces/") ? msg.spaceName : `spaces/${msg.spaceName}`}`,
        `chat message from ${who}`,
        {
          inboxPayload: {
            type: "gchat.message",
            messageName: msg.name,
            spaceName: msg.spaceName,
            threadName: msg.threadName,
            senderName: msg.senderName,
            priority: "responsive",
          },
          inboxDedupeKey: msg.name,
          inboxDeliveredAt: msg.createTime ? new Date(msg.createTime) : undefined,
          inboxPriority: "responsive",
        }
      );
    };

    if (opts?.e2e?.chatSource) {
      // e2e: an injected fake source — skip the real pubsub/OAuth subscription.
      chatSource = opts.e2e.chatSource;
      await chatSource.start(onChat);
      console.log("[chat] e2e fake chat source active");
    } else if (gchat) {
      const g = gchat;
      try {
        const identity = loadGchatIdentity(config.chat.gchatConfigDir);

        // Keep the Workspace Events subscription alive (4h TTL) so messages keep
        // flowing into the Pub/Sub topic the pull source reads. Best-effort: a
        // failure here may just mean a still-live subscription, so we log and
        // continue rather than disabling chat.
        const oauth = new GchatOAuth(config.chat.gchatConfigDir);
        const topic = `projects/${config.chat.projectId}/topics/${config.chat.topic ?? "chat-events"}`;
        weSubscriber = new WorkspaceEventsSubscriber({
          topic,
          getToken: () => oauth.token(),
          log: (m) => console.log(`[chat] events: ${m}`),
        });
        try {
          await weSubscriber.start();
          console.log(`[chat] events subscription active → ${topic}`);
        } catch (err) {
          console.warn(
            `[chat] events subscription failed (continuing): ${err instanceof Error ? err.message : String(err)}`
          );
        }

        chatSource = new PubsubChatSource({
          projectId: config.chat.projectId,
          subscription: config.chat.subscription,
          keyFilename: config.chat.pubsubKeyPath,
          selfUserId: identity.userId,
          resolveSpaceType: (space) => g.getSpaceType(space),
          listSpaceMembers: (space, options) => g.listSpaceMembers(space, options),
          log: (m) => console.log(`[chat] ${m}`),
        });
        await chatSource.start(onChat);
        console.log(`[chat] puller active as ${identity.email ?? identity.userId}`);
      } catch (err) {
        console.error(
          `[chat] failed to start chat puller: ${err instanceof Error ? err.message : String(err)}`
        );
        chatSource = null;
      }
    }
  }

  console.log("\n✓ Root actor live. Waiting for events...\n");

  // Mechanical lifecycle ping : emitted by startup once the mesh is up.
  // A lone "back online" with no preceding "updating" ping is the restart/crash signal.
  if (sendToErrorChat) {
    try {
      postBackOnlinePing({ repoRoot: resolveRepoRoot(), sendToErrorChat });
    } catch (err) {
      console.warn(
        `[start] back online ping failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── Lifecycle ──
  let running = true;
  let webhookSilenceCheck: ReturnType<typeof setInterval> | null = null;
  let diskAlertCheck: ReturnType<typeof setInterval> | null = null;
  let quotaThrottleCheck: ReturnType<typeof setInterval> | null = null;
  let modelProbeCheck: ReturnType<typeof setInterval> | null = null;
  // The interval handle says nothing about a probe already in flight, so keep
  // both a way to stop one (the signal) and a way to wait for it (the promise).
  const modelProbeAbort = new AbortController();
  let modelProbeInFlight: Promise<void> | null = null;
  const shutdown = async (reason: "deploy" | null = null) => {
    if (!running) return;
    // Stop the supervised e2e unit before committing this process to shutdown.
    // If systemctl fails, keep the mesh alive and let a later signal retry; do
    // not orphan the instance by proceeding to process.exit.
    e2eInstance.stopForMeshShutdown();
    running = false;
    console.log("\n🛑 Shutting down...");
    if (webhookSilenceCheck) clearInterval(webhookSilenceCheck);
    if (diskAlertCheck) clearInterval(diskAlertCheck);
    if (quotaThrottleCheck) clearInterval(quotaThrottleCheck);
    if (modelProbeCheck) clearInterval(modelProbeCheck);
    // Clearing the interval only stops the next probe. Abort reaches the one
    // running now - it kills the spawned tree synchronously - and awaiting it
    // is what gives the prober's `finally` a turn to remove its temp dir before
    // process.exit ends the loop. Without the await the tree still dies, but the
    // 0-byte socket dir it left behind never gets cleaned up.
    modelProbeAbort.abort();
    if (modelProbeInFlight) await modelProbeInFlight;
    if (haltExpiryTimer) clearTimeout(haltExpiryTimer);
    mesh.shutdownAll(); // stops the root and any live workers (registry untouched)
    errorNotifier?.close(); // cancel any pending coalesced failure summary
    if (weSubscriber) {
      try {
        await weSubscriber.close();
      } catch {
        /* already closed */
      }
    }
    if (chatSource) {
      try {
        await chatSource.close();
      } catch {
        /* already closed */
      }
    }
    try {
      githubPoller?.close();
      await webhookServer?.close();
    } catch {
      /* already closed */
    }
    if (dashboardServer) {
      try {
        await dashboardServer.close();
      } catch {
        /* already closed */
      }
    }
    try {
      await mcpHttp.close();
    } catch {
      /* already closed */
    }
    if (gitBridgeServer) {
      try {
        if (typeof gitBridgeServer.closeAllConnections === "function") {
          gitBridgeServer.closeAllConnections();
        }
        await new Promise<void>((resolve) => gitBridgeServer.close(() => resolve()));
      } catch {
        /* already closed */
      }
    }
    sharedQuotaStore?.close();
    // `closeDb()` below drops the repository container, but the listener it
    // holds is a closure over this `runStart`'s `readyHeadSink`. Clearing the
    // sink first stops a dead mesh being reachable through that closure, and
    // clearing the sink rather than the listener avoids touching the database
    // on a shutdown path that is about to close it.
    readyHeadSink = undefined;
    closeDb();
    console.log("✓ Goodbye!");
    process.exit(getShutdownExitCode(reason));
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Webhook delivery silence needs sub-hour signal: a 10-minute check keeps the
  // default 45-minute threshold close to its intended alert window.
  webhookSilenceCheck = setInterval(
    () => void webhookSilenceDetector?.check(),
    WEBHOOK_SILENCE_CHECK_INTERVAL_MS
  );
  webhookSilenceCheck.unref?.();

  if (quotaThrottleEnabled) {
    // The quota service's cache is the sensor cadence (normally five minutes),
    // so a default five-minute controller tick never adds probe pressure. An
    // immediate pass makes an enabled controller useful after boot rather than
    // leaving a full-rate blind interval.
    void tickQuotaThrottle().catch((err) => {
      console.warn(
        `[quota-throttle] boot tickQuotaThrottle failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    quotaThrottleCheck = setInterval(
      () =>
        void tickQuotaThrottle().catch((err) => {
          console.warn(
            `[quota-throttle] interval tickQuotaThrottle failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }),
      (quotaThrottleConfig?.tickSeconds ?? 300) * 1000
    );
    quotaThrottleCheck.unref?.();
  }

  const diskAlertConfig = config.observability?.diskAlert;
  let diskAlert: DiskUsageAlert | null = null;
  if (diskAlertConfig?.enabled !== false) {
    const activeDiskAlert = new DiskUsageAlert(diskAlertConfig, async (event) => {
      await mesh.deliverEvent("system:events", event.message, {
        inboxPayload: event,
        inboxPriority: "responsive",
      });
    });
    diskAlert = activeDiskAlert;
    // Reuse the 10-minute check interval for disk alerting or the configured one
    diskAlertCheck = setInterval(
      () => void activeDiskAlert.check(),
      (diskAlertConfig?.intervalSeconds ?? 600) * 1000
    );
    diskAlertCheck.unref?.();
  }

  // Probe model catalogs on startup and daily thereafter
  if (running) {
    modelProbeInFlight = refreshConfiguredProviderModelCatalogs({
      config,
      workersDir,
      scrapeStore: modelScrapesStore,
      signal: modelProbeAbort.signal,
    }).catch((err) => {
      console.error(
        `[start] model catalog probe failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    modelProbeCheck = setInterval(
      () => {
        if (!running) return;
        modelProbeInFlight = refreshConfiguredProviderModelCatalogs({
          config,
          workersDir,
          scrapeStore: modelScrapesStore,
          signal: modelProbeAbort.signal,
        }).catch((err) => {
          console.error(
            `[start] scheduled model catalog probe failed: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      },
      24 * 60 * 60 * 1000
    );
    modelProbeCheck.unref?.();
  }

  // E2E: now that every edge is wired and shutdown exists, hand the driving
  // runner live handles so it can inject events and tear down deterministically.
  opts?.e2e?.onReady?.({
    mesh,
    root,
    rootControl,
    externalRoot,
    inboxStore,
    emitGitHubEvent: onEvent,
    emitSystemDiskCheck: () => diskAlert?.check() ?? Promise.resolve(),
    shutdown,
  });

  // Keep the process alive until a signal triggers shutdown().
  await new Promise<void>(() => {});
}
