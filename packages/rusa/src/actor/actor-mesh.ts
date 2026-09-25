import { randomUUID } from "node:crypto";
import { assertSecretContainment, secretsDirPath } from "../config/secrets.js";
import { getDb } from "../db/index.js";
import type { MeshChat } from "../db/repositories/mesh-chat-repository.js";
import { HUMAN_OPERATOR, isHumanOperator, MESH_SYSTEM } from "../mcp/stamp.js";
import {
  isBlockingObligationStatus,
  isTerminalObligationStatus,
  type Obligation,
  type ObligationStatus,
  prerequisiteEdgeKey,
} from "../obligations/obligation.js";
import { type Logger, nullLogger } from "../observability/logger.js";
import {
  assertConcreteModelConfig,
  describeModelConfigPool,
  isModelClassReference,
  type ModelConfigInput,
  type ProviderModelConfig,
  type RawProviderModelConfig,
} from "../providers/model-config.js";
import type { RunResult } from "../providers/types.js";
import type { ActorRepository } from "../repositories/actor-repository.js";
import {
  EmptyInboxRepository,
  type InboxEntry,
  type InboxPayload,
  type InboxRepository,
} from "../repositories/inbox-repository.js";
import {
  type DurableEventDelivery,
  deduplicatedInboxEntryId,
  type EventManager,
  type EventRoutingKernel,
  type EventSourceOwnershipDiagnostic,
  type RawIntegrationEvent,
} from "../runtime/event-manager.js";
import {
  type MeshProviderGate,
  type QueuedSelection,
  RunManager,
  VOICE_INBOX_PAYLOAD_TYPE,
} from "../runtime/run-manager.js";
import { randomSupportedVoiceName } from "../voice/tts-voices.js";
import type { VoiceDefinition } from "../voice/voice-catalog.js";
import { googleVoiceConfig } from "../voice/voice-config.js";
import {
  MAX_VOICE_TRANSFER_NOTE_CHARS,
  renderVoiceTransferContext,
} from "../voice/voice-transfer-context.js";
import {
  type ActorLifecycle,
  type ActorLifecycleListener,
  type ActorLifecycleListenerFailure,
  createActorLifecycle,
} from "./actor-lifecycle.js";
import type { ActorHandle, ActorRecord, ActorStatus, ContextConfig } from "./actor-record.js";
import {
  CAPABILITY_ADMIN_CAPABILITY,
  EXPERIMENT_ADMIN_CAPABILITY,
  HOST_GLOBAL_CAPABILITIES,
  MODEL_ADMIN_CAPABILITY,
} from "./administrative-capabilities.js";
import {
  type CapabilityGrantStore,
  InMemoryCapabilityGrantStore,
  PARENT_GRANTABLE_CAPABILITIES,
} from "./capability-grants.js";
import type { RunStartHandle } from "./concurrency-limiter.js";
import {
  type EventResource,
  type EventSourceOwnerStore,
  type EventSourceOwnership,
  type EventSourceSubscription,
  type EventSourceSubscriptionStore,
  InMemoryEventSourceOwnerStore,
  InMemoryEventSourceSubscriptionStore,
  isSubResourceOf,
  resourceKey,
} from "./event-subscriptions.js";
import {
  assertKnownExperiment,
  type ExperimentEnrollment,
  type ExperimentEnrollmentChange,
  type ExperimentEnrollmentStore,
  InMemoryExperimentEnrollmentStore,
  isKnownExperiment,
  STRICT_OBLIGATION_HANDLING_EXPERIMENT,
} from "./experiments.js";
import { generateHandle } from "./handle-generator.js";
import {
  DROPPED_MESSAGE_DETAIL,
  type MeshEventSink,
  NOOP_MESH_EVENT_SINK,
  RUN_TERMINAL_EVENT_KINDS,
} from "./mesh-events.js";
import type { ScheduledMessage, ScheduledMessageScheduler } from "./os-scheduler.js";
import {
  type ResponsiveInterruptionVerdict,
  type ShadowResponsiveInterruptionClassifier,
  shadowPrediction,
  shadowReactionTarget,
} from "./responsive-interruption.js";
import type { ActorRunMode, RunNudge } from "./trigger-runner.js";

/** `from` attributed to a mechanical (cron-driven) wake delivery — not a peer actor. */
export const SCHEDULER_SENDER_ID = "scheduler";

/** Runtime contract the mesh needs for routing; provider-backed Actor is one implementation. */
export interface MeshActor {
  readonly id: string;
  requestRun(nudge?: RunNudge): void;
  declareYield(status?: string, note?: string): void;
  markUnkillable(): void;
  close(): void;
  readonly isRunning: boolean;
  readonly isQueued?: boolean;
  readonly isYielded?: boolean;
  cancelQueuedRun?(): boolean;
  /** Cancel a queued reservation and re-admit its same work against current next-run config. */
  rescheduleQueuedRun?(): boolean;
  resumeCancelledRun?(): boolean;
  preemptForResponsive():
    | { preempted: false }
    | { preempted: true; phase: "running" | "winding_down" | "queued" };
  interrupt?(by?: string): { interrupted: boolean; runStartTime?: Date; wasQueued?: boolean };
  getInterruptedWatermark?(): Date | null;
  clearInterruptWatermark?(): void;
  setModelConfig?(modelConfig: ProviderModelConfig[]): void;
  /** Present on provider-backed actors that receive the lifecycle contract. */
  readonly lifecycle?: ActorLifecycle;
}

export type ActorRuntimeState = "queued" | "running" | "winding_down" | "idle";

export interface ActorRuntimeStateDelta {
  streamId: string;
  revision: number;
  actorId: string;
  runState: ActorRuntimeState;
  /**
   * State-only deltas are patched in the dashboard without a list fetch. Set
   * this when another thread-list field changed while the run state stayed the
   * same, such as the current inbox focus selected by a running actor.
   */
  refreshThreadSnapshot?: boolean;
}

export interface ActorRuntimeStateSnapshot {
  streamId: string;
  revision: number;
  states: ReadonlyMap<string, ActorRuntimeState>;
}

export interface SpawnRequest {
  /**
   * Experimental execution placement, not persisted on the record. A target is
   * only admitted when the runtime declares placement support through
   * {@link ActorMeshOptions.supportsExecutionTarget}; otherwise the spawn is
   * rejected rather than quietly running the actor in this process.
   */
  executionTarget?: string;
  /** What the new actor owns — authored by the spawning message (B.5). */
  charter: string;
  /** The spawning actor's id (becomes the child's parent + gets a handle to the child). */
  parentId: string;
  /**
   * The child's declared provider/model/effort pool — a single entry or a
   * bounded, non-empty, portable-only-above-length-one array (design MEK-Org/rusa#169).
   */
  modelConfig: ModelConfigInput;
  /** Working-memory ownership and portable-context policy. Missing means native. */
  context?: ContextConfig;
  /** Peers to seed the child's address book with (introductions at birth). */
  handles?: ActorHandle[];
  /**
   * Resume an existing provider conversation as this actor's session instead of
   * minting a fresh one. The id is CLI-specific, so it must belong to the chosen
   * `provider` (e.g. an agy conversation for an `antigravity` actor). The actor's
   * charter rides on top of that conversation's accumulated context — this is how
   * you promote an existing conversation into a mesh actor.
   */
  conversationId?: string;
  /** A brief one-line description of what this actor is tasked with, shown under its name in the dashboard. */
  title?: string;
}

export type MessageDeliveryResult =
  | { delivered: true }
  | { delivered: false; status?: ActorStatus };

/**
 * One thread's in-flight run.
 *
 * Scheduling remains keyed by actor: the host-owned run journal carries the
 * execution's durable identity, while this state only answers whether the one
 * actor is queued, running, or winding down. The retire refusal therefore names
 * the thread whose execution prevents retirement.
 */
export interface ActiveRunState {
  actorId: string;
  /** `running` = inside the provider call; `winding_down` = yielded but process still living; `queued` = past its gate, awaiting admission. */
  phase: "running" | "queued" | "winding_down";
}

export interface RetireOptions {
  /**
   * Run-guard override: retire immediately even if a run in the subtree is actively
   * running. Operator / root-control only.
   *
   * Deliberately *not* an override for the undisposed-work preflight (#191). Force
   * exists because a wedged actor must stay retirable, and a wedged run is the mesh's
   * own problem to break; a live obligation or an undelivered message is somebody's
   * work, and no flag turns "I could not wait for this run" into "throw that away".
   */
  force?: boolean;
  /**
   * Retire even if runs in the subtree are queued (cancelling the queued runs),
   * but still refuse if any thread in the subtree is actively running.
   */
  forceQueued?: boolean;
}

/** Host-owned live-session operations used by the actor transfer primitive. */
export interface VoiceSessionTransferPort {
  /** Read the caller's unambiguous active session before any authority moves. */
  activeSessionIdFor(actorId: string): string;
  /** Atomically rebind the caller's active session and return its same UUID. */
  transferActiveSession(fromActorId: string, targetActorId: string): string;
  /** Restore a just-rebound session before its durable handoff was accepted. */
  revertActiveSessionTransfer(sessionId: string, fromActorId: string, targetActorId: string): void;
  /** Tell the dashboard browser that owns this session to reconnect to target. */
  notifySessionTransferred(sessionId: string, targetActorId: string): void;
}

/** One live obligation, in the detail a retirement refusal needs to name it. */
export interface LiveObligationSummary {
  id: string;
  status: string;
  title: string | null;
}

/**
 * The narrow slice of the obligation store the mesh reads.
 *
 * `listLiveOwnedBy` is what lets retirement fail closed on unfinished work; a
 * mesh wired without it — an isolated test, an embedder built before
 * obligations existed — still retires on the run-in-flight guard alone.
 */
export interface MeshObligationPort {
  findLiveByExternalRef(ref: string): { ownerId: string } | null;
  listLiveOwnedBy?(ownerId: string): readonly LiveObligationSummary[];
  /** Point read and unbounded edge reads used only for strict run-local closure. */
  get?(id: string): Obligation | null;
  listDirectChildEdges?(
    parentId: string
  ): Array<{ id: string; status: ObligationStatus; creatorId: string | null }>;
  listPrerequisiteEdges?(
    dependentId: string
  ): Array<{ prerequisiteId: string; status: ObligationStatus }>;
}

/**
 * The narrower contract strict obligation handling (#382) actually requires.
 *
 * These reads stay optional on {@link MeshObligationPort} so an embedder built
 * before #382 keeps working, but they are not optional for an *enrolled* actor:
 * enrollment without this contract is a misconfiguration, not a soft mode.
 * {@link ActorMesh.selectInboxEntries} refuses head attention in that state
 * rather than letting an enrolled run yield cleanly on an untouched head.
 */
export type MeshObligationClosurePort = MeshObligationPort &
  Required<Pick<MeshObligationPort, "get" | "listDirectChildEdges" | "listPrerequisiteEdges">>;

/** Whether a wired port can answer every read strict closure needs. */
export function supportsObligationClosureReads(
  port: MeshObligationPort | undefined
): port is MeshObligationClosurePort {
  return Boolean(port?.get && port.listDirectChildEdges && port.listPrerequisiteEdges);
}

/** One live obligation owned inside a retiring subtree (#191). */
export interface ObligationRetirementBlocker {
  obligationId: string;
  ownerId: string;
  status: string;
  title: string | null;
}

/**
 * One pending scheduled message with an endpoint inside a retiring subtree
 * (#191). `direction` is stated relative to that subtree: `incoming` = awaiting
 * delivery to it, `outgoing` = scheduled by it, `internal` = both.
 */
export interface MessageRetirementBlocker {
  messageId: string;
  fromId: string;
  toId: string;
  deliverAt: string;
  direction: "incoming" | "outgoing" | "internal";
}

/** One live event subscription owned inside a retiring subtree (#540). */
export interface SubscriptionRetirementBlocker {
  resource: string;
  actorId: string;
  kind: "ownership" | "subscription";
}

/** Everything a subtree must dispose of before it can retire — see {@link ActorMesh.retirementBlockers}. */
export interface RetirementBlockers {
  obligations: ObligationRetirementBlocker[];
  messages: MessageRetirementBlocker[];
  subscriptions: SubscriptionRetirementBlocker[];
}

/**
 * Effective event routing authority diagnostic (#369).
 * Distinguishes the governing source, principal, resource level, and liveness for a canonical resource.
 */
/**
 * Public diagnostic from the shared routing kernel (#369). Its field-level
 * #369 semantics live with {@link EventSourceOwnershipDiagnostic}, where the
 * ladder constructs the value.
 */
export type EffectiveRouteDiagnostic = EventSourceOwnershipDiagnostic;

/**
 * Retirement refused because the subtree still holds work someone has to decide
 * about. Carries the blockers structurally as well as in the message, so a
 * caller that wants to act on them doesn't have to parse prose back out.
 */
export class RetirementBlockedError extends Error {
  constructor(
    readonly blockers: RetirementBlockers,
    message: string
  ) {
    super(message);
    this.name = "RetirementBlockedError";
  }
}

/** Human-readable subject line for a retire refusal — see {@link ActorMesh.retire}. */
/**
 * Bare object-or-array normalization for embedders that skip config-aware
 * validation (tests). Still enforces the one invariant that must never be
 * bypassed: a missing/blank model must fail loudly rather than silently
 * resolve to a provider default (#169).
 */
function normalizeModelConfigList(input: ModelConfigInput): ProviderModelConfig[] {
  // No config in hand here, so a named class cannot be resolved — reject the
  // reference rather than reading it as a tuple with a missing provider.
  const concrete = assertConcreteModelConfig(input);
  const list = Array.isArray(concrete) ? concrete : [concrete];
  return list.map((entry) => {
    const model = entry.model?.trim();
    if (!model) {
      throw new Error(
        `modelConfig entry for provider "${entry.provider}" is missing a model — omitted/blank models are not allowed, since that would silently select the provider's default`
      );
    }
    return { provider: entry.provider, model, effort: entry.effort };
  });
}

function describeActiveRuns(target: string, busy: readonly ActiveRunState[]): string {
  const named = busy.map((r) => `${r.actorId} (${r.phase})`).join(", ");
  const self = busy.find((r) => r.actorId === target);
  if (busy.length === 1) {
    return self
      ? `it has a run in flight — ${named}`
      : `a thread in its subtree has a run in flight — ${named}`;
  }
  return `${busy.length} threads in its subtree have runs in flight — ${named}`;
}

/** How many blockers of each kind a refusal spells out before summarising the rest. */
const LISTED_RETIREMENT_BLOCKERS = 10;

function listWithOverflow<T>(items: readonly T[], render: (item: T) => string): string[] {
  const lines = items.slice(0, LISTED_RETIREMENT_BLOCKERS).map(render);
  if (items.length > LISTED_RETIREMENT_BLOCKERS) {
    lines.push(`  …and ${items.length - LISTED_RETIREMENT_BLOCKERS} more`);
  }
  return lines;
}

/**
 * The retirement refusal an actor actually reads. Every blocker is named by a
 * stable id and paired with the operation that clears it, because the whole
 * point of refusing is that the caller can then resolve each one and retry —
 * a refusal that only says "there is pending work" leaves them nothing to do.
 */
function describeRetirementBlockers(target: string, blockers: RetirementBlockers): string {
  const lines: string[] = [];
  if (blockers.obligations.length > 0) {
    lines.push(
      `${blockers.obligations.length} live obligation(s) owned in its subtree — reassign or finish each:`
    );
    lines.push(
      ...listWithOverflow(
        blockers.obligations,
        (o) =>
          `  ${o.obligationId} [${o.status}] owned by ${o.ownerId}${o.title ? ` — ${o.title}` : ""}`
      )
    );
  }
  if (blockers.messages.length > 0) {
    lines.push(
      `${blockers.messages.length} pending scheduled message(s) touching its subtree — ` +
        "cancel each with cancel_scheduled_message, re-sending any that still matter:"
    );
    lines.push(
      ...listWithOverflow(
        blockers.messages,
        (m) => `  ${m.messageId} [${m.direction}] ${m.fromId} -> ${m.toId} at ${m.deliverAt}`
      )
    );
  }
  if (blockers.subscriptions.length > 0) {
    // Each kind names the tool that actually clears it, and each kind has an
    // exit the retirer can take without the holder's cooperation — a wedged
    // holder must not make its subtree unretirable. Ownership is only ever
    // reached by delegation (root owns the configured roots; nothing else mints
    // it), so it leaves the same way: the holder delegates it onward — its
    // parent included — or the owner above it reclaims it. A direct
    // subscription is dropped by its holder, or by any ancestor naming the
    // holder (the same authority that retires it). `unsubscribe_event_source`
    // is deliberately not an ownership release: ownership with no receiver
    // would route by whichever ancestor happens to be live, which is the
    // implicit fallback #540 refuses to add.
    lines.push(
      `${blockers.subscriptions.length} live event subscription(s) owned in its subtree — ` +
        "[ownership]: the holder delegates it onward (delegate_event_source, its parent included) " +
        "or the owner above it reclaims it (reclaim_event_source); " +
        "[subscription]: the holder unsubscribes (unsubscribe_event_source), or an ancestor " +
        "unsubscribes it for them (unsubscribe_event_source with thread_id set to the holder):"
    );
    lines.push(
      ...listWithOverflow(
        blockers.subscriptions,
        (s) => `  ${s.resource} [${s.kind}] held by ${s.actorId}`
      )
    );
  }
  return [
    `cannot retire ${target}: its subtree still holds work that needs an explicit decision.`,
    ...lines,
    "Nothing was retired. Resolve every blocker above, then retire again.",
  ].join("\n");
}

/**
 * Principals that act with operator authority rather than as a thread in the
 * ownership tree: the root LLM's control surface, a human, and the e2e
 * controller. Their scope is enforced by the surface that mints them, not by
 * ancestry, since none of them is a node in the tree to begin with.
 */
function isTrustedControlPrincipal(
  by: string,
  principals?: import("../db/repositories/principal-repository.js").PrincipalRepository
): boolean {
  return (
    by === "root-llm" ||
    by === "human:operator" ||
    by.startsWith("human:") ||
    by === "e2e-controller" ||
    (principals !== undefined && principals.getUser(by) !== undefined)
  );
}

export interface MechanicalInboxForensics {
  runId?: string;
  actorId?: string;
  originalFromId?: string;
  pendingMessageId?: string;
  exitCode?: number;
  status?: string;
}

/** What the mesh hands the factory to build a live {@link Actor} for a record. */
export interface ActorFactoryContext {
  executionTarget?: string;
  /** The record at spawn time. Use {@link getRecord} for the *current* state. */
  record: ActorRecord;
  /** Read the live record (charter + handles can change between wakes). */
  getRecord: () => ActorRecord | undefined;
  mesh: ActorMesh;
  /** Ordered actor/run observers, already registered with mesh bookkeeping first. */
  lifecycle: ActorLifecycle;
  /**
   * Wrap the provider run in the shared cross-actor concurrency gate. The
   * actor supplies its declared candidate pool; the gate atomically selects
   * (quotes/reserves) the earliest-eligible canonical provider pacing lane —
   * declaration order breaks ties — and hands the selected tuple to `fn`.
   */
  gate: <T>(
    fn: (selected: RawProviderModelConfig) => Promise<T>,
    candidates: readonly RawProviderModelConfig[],
    responsive: boolean
  ) => RunStartHandle<T>;
  /** Lease check run before each wake; returns false (and retires) when exhausted. */
  beforeRun: (context: { mode: ActorRunMode }) => boolean;
  /** Final admission after provider pacing selects a run, before it launches. */
  admitRun?: (context: { responsive: boolean; mode: ActorRunMode }) => boolean;
  /** Forward the actor-owned runtime state to the mesh-wide sequencer. */
  onRuntimeStateChanged: (state: ActorRuntimeState) => void;
  /**
   * Fires when a genuinely queued (not yet started) run is cancelled —
   * an operator HALT or an explicit interrupt — so the mesh can clear any
   * recorded {@link QueuedSelection} for this actor. Never fires once the
   * run has actually started; onEnd is the clearing point for that case.
   */
  onQueuedRunCancelled?: () => void;
}

export type ActorFactory = (ctx: ActorFactoryContext) => MeshActor;

export interface RetireCleanup {
  name: string;
  /**
   * Physical teardown that would destroy in-flight work must wait for the
   * actor's active run to emit its matching run_end.
   */
  deferUntilRunEnd?: boolean;
  run: (record: ActorRecord) => void | Promise<void>;
}

export interface ActorMeshOptions {
  actors: ActorRepository;
  principals?: import("../db/repositories/principal-repository.js").PrincipalRepository;
  /** This account/subtree's root id. Also backs the grandfathered `"root"` address alias. */
  rootId?: string;
  /** Builds a live Actor for a thread record (resolves provider/cwd/mcp/session). */
  createActor: ActorFactory;
  /**
   * Synchronous, config-aware normalization/validation gate run before a spawn
   * id or durable record is created — bounds the pool, enforces portable-only
   * above length one, validates each tuple, and rejects duplicates.
   */
  validateSpawn?: (req: SpawnRequest) => ProviderModelConfig[];
  /**
   * Experimental placement gate, consulted for every spawn that names an
   * `executionTarget`. Fail-closed by omission: a runtime that cannot place
   * actors elsewhere leaves this unset, and an explicit target is then refused
   * instead of degrading into a silent local run on the leader.
   */
  supportsExecutionTarget?: (target: string) => boolean;
  /**
   * Synchronous, config-aware validator before staging an actor's
   * `desiredModelConfig` replacement.
   */
  validateModel?: (record: ActorRecord, modelConfig: ModelConfigInput) => ProviderModelConfig[];
  /** Cross-actor concurrency cap for non-responsive runs (default 4). */
  maxConcurrent?: number;
  /**
   * Legacy promise-only rate gate. New runtime wiring should use
   * {@link providerGate}; retained for embedders that do not need promotion.
   */
  rateLimit?: <T>(fn: () => Promise<T>, provider: string) => Promise<T>;
  /**
   * Provider pacing composed with the mesh's normal-run concurrency queue.
   * Given the actor's declared candidate pool, atomically selects (quotes and
   * reserves) the earliest-eligible canonical provider lane — with
   * declaration order breaking unresolvable ties — and invokes `fn` with the
   * winning tuple. A responsive run uses that same selection, then bypasses
   * pacing/concurrency after its candidate is reserved.
   */
  providerGate?: MeshProviderGate;
  /**
   * Mesh-wide emergency brake consulted in every worker's `beforeRun`: when it
   * returns true the run is skipped (and, being a skip, won't self-continue), so
   * the mesh quiesces within one run-cycle. Defaults to never-halted.
   */
  isHalted?: (provider?: string, model?: string) => boolean;
  /**
   * Second, independent run-gate term consulted in every worker's `beforeRun`:
   * the in-memory graceful-shutdown brake (see {@link GracefulShutdown}). Kept
   * separate from {@link isHalted} on purpose — the operator HALT is a durable
   * file-backed emergency brake, this is a transient process-local drain a
   * `redeploy` engages before bouncing the service. A fresh process boots it
   * `false`, so there is nothing to clear on restart. Defaults to never-shutting.
   */
  isShuttingDown?: () => boolean;
  /** Id generator — override in tests for determinism. */
  idgen?: () => string;
  /** Clock for `createdAt` — override in tests. */
  now?: () => string;
  /** Display handle resolver for directed delivery. Defaults to deterministic actor handles. */
  handleForId?: (id: string) => string;
  /**
   * Called once per actor as it's retired (after its actor is closed, before the
   * record is marked retired), for resource teardown the mesh doesn't own — e.g.
   * removing the actor's MCP endpoint and its working directory.
   */
  onRetire?: (record: ActorRecord) => void;
  /**
   * Ordered actor/run observers. The mesh's own queue and terminal bookkeeping
   * is always registered first; host integrations follow this declared order.
   */
  lifecycleListeners?: readonly ActorLifecycleListener[];
  /** Forward observer errors to host telemetry or structured logging. */
  onLifecycleError?: (failure: ActorLifecycleListenerFailure) => void;
  /**
   * Called on every actor yield, for out-of-band handling the mesh doesn't own
   * (e.g. surfacing a git-bridge deliverable). `notifyingParent` is true only
   * when this yield is being mechanically reported to the actor's parent (a
   * parent-triggered run) — the sole case where the returned text is appended
   * to the notification. The hook still fires on non-notifying yields so a
   * consumer can flush any pending per-actor state; otherwise a deliverable
   * produced on an external or scheduled run would linger and leak into a
   * later, unrelated parent notification. Returns optional text to append.
   */
  onYield?: (actorId: string, ctx: { notifyingParent: boolean }) => string | null | undefined;
  /** Persist the active run's yield fact and return its durable run id. */
  recordRunYield?: (actorId: string, status: string, note?: string) => string | null;
  /**
   * Called once per actor at genuine birth — inside {@link spawn}, after the live
   * actor is registered — for out-of-band side effects the mesh doesn't own (e.g.
   * kicking off avatar generation, ISSUE_NUM). Deliberately NOT invoked by
   * {@link rehydrate} (boot restore) or {@link adopt} (the root), so it fires
   * exactly once per real spawn and never re-runs on restart. Mirrors
   * {@link onRetire}: invoked in a try/catch so a hook throw can't break spawning.
   * The hook must not block — it kicks work off and returns immediately; spawn
   * stays synchronous and returns the id right away (B.5's non-blocking rule).
   */
  onSpawn?: (record: ActorRecord) => void;
  /**
   * Called once per actor as it's revived (after its record is marked active,
   * before the live actor is re-instantiated), for out-of-band side effects the
   * mesh doesn't own — e.g. recreating the actor's working directory.
   */
  onRevive?: (record: ActorRecord) => void;
  /**
   * Called after a capability grant is durably recorded, for live resource
   * wiring the mesh does not own. The production wiring uses this to mount the
   * endpoint and update the actor's provider config for its next run.
   */
  onCapabilityGranted?: (actorId: string, capability: string) => void;
  /**
   * Called when a capability is revoked from an actor , for resource
   * teardown the mesh doesn't own — namely unmounting the granted MCP endpoint so
   * revocation takes effect IMMEDIATELY (a 404), not only at the actor's next
   * reconstruction. Invoked in a try/catch so a hook throw can't break revoke.
   */
  onCapabilityRevoked?: (actorId: string, capability: string) => Promise<void> | void;
  /**
   * Called after an actor's model is durably updated in the repository,
   * for live resource / provider updating on the active actor.
   */
  onModelSet?: (actorId: string, modelConfig: ProviderModelConfig[], record: ActorRecord) => void;
  /**
   * Per-actor durable-registration cleanup hooks run during retire. Each hook is
   * failure-isolated so one broken teardown cannot stop the rest of the cascade.
   */
  retireCleanups?: RetireCleanup[];
  events?: MeshEventSink;
  /** Durable record store for message content. */
  recordChat?: (opts: {
    id?: string;
    senderId: string;
    recipientId: string;
    body: string;
    sessionId?: string;
  }) => string;
  /**
   * Durable store of per-actor capability grants (ISSUE_NUM, phase 1a). Defaults to an
   * in-memory store; the wiring supplies the SQLite-backed one. It is also the
   * sole source of administrative authority (#549): a `capability-admin`
   * holder grants, and only allow-listed capabilities can be granted (see
   * {@link grantableCapabilities}).
   */
  capabilityGrants?: CapabilityGrantStore;
  /**
   * Durable store of per-actor experiment enrollments (#394). Defaults to an
   * in-memory store; the wiring supplies the SQLite-backed one, which is what
   * makes an enrollment survive a restart. Only an `experiment-admin` holder
   * administers enrollments and only registered experiment names are accepted
   * — both enforced here in the mesh, never in the store.
   */
  experimentEnrollments?: ExperimentEnrollmentStore;
  eventSourceOwners?: EventSourceOwnerStore;
  eventSourceSubscriptions?: EventSourceSubscriptionStore;
  /**
   * The single external-event seam: the host-assembled EventManager, which
   * carries the one routing kernel as {@link EventManager.routing}. Mesh reads
   * its authority ladder from that manager rather than accepting a resolver
   * beside it, so a mesh with two competing routing policies cannot be
   * constructed at all.
   *
   * Mesh retains the manager only to append through it before dispatching the
   * recipients the delivery persisted entries for.
   */
  eventManager?: EventManager;
  /**
   * The event sources this instance is configured for. Direct subscriptions are
   * refused outside them, which is what keeps a subscription from reopening the
   * scope narrowing `config.yaml` closed. Omitted by meshes built without a
   * config (tests, the e2e runner), where there is no scope to enforce.
   */
  configuredEventSources?: readonly EventResource[];
  /**
   * Ownership authority for issue/PR event sources. Optional: without
   * it, routing falls back entirely to subscriptions, which is what every mesh
   * built before obligations existed does.
   */
  obligations?: MeshObligationPort;
  /** Durable actor inbox used for singleton wake recovery. Optional for isolated tests. */
  inboxStore?: InboxRepository;
  /** Optional voice pool for newly spawned actors. */
  supportedVoices?: readonly VoiceDefinition[];
  /** Host-owned leased walkie authority; absent preserves existing dispatch semantics. */
  isVoiceSessionActive?: (actorId: string) => boolean;
  /**
   * Host-owned in-memory session registry. The mesh owns target authorization,
   * inbox delivery, and the durable handoff projection; this port owns only the
   * atomic live-session rebind and dashboard transport notification.
   */
  voiceSessionTransfer?: VoiceSessionTransferPort;
  /** Read existing durable rows for the session; never creates a transcript store. */
  listVoiceSessionChat?: (sessionId: string) => MeshChat[];
  /** General lifecycle hook matching onYield. */
  onQueued?: (actorId: string, context: { responsive: boolean; mode: ActorRunMode }) => void;
  /** Best-effort receipts for entries first accepted into an execution opportunity. */
  onInboxEntriesSeen?: (actorId: string, entries: readonly InboxEntry[]) => void;
  /** Optional, shadow-only JEV policy; it never changes the v1 dispatch result. */
  responsiveInterruption?: ShadowResponsiveInterruptionClassifier;
  /**
   * Posts a shadow verdict as a reaction on the chat message that arrived.
   * Only ever called when `responsiveInterruption` is also supplied, so an
   * install without the opt-in policy posts nothing even if this is wired.
   */
  reactToChatMessage?: (messageName: string, emoji: string) => Promise<void>;
  /**
   * The allow-list of grantable capability names — typically the keys of the
   * wiring's grantable-MCP registry. A grant of any name outside this set is
   * rejected, bounding what the primitive can ever hand out. Defaults to empty.
   */
  grantableCapabilities?: ReadonlySet<string>;
  /** Host-owned one-shot messages. Production supplies the `at`-backed OS scheduler. */
  scheduledMessages?: ScheduledMessageScheduler;
  /** Atomic boundary for recording a scheduled message's chat/audit rows. */
  withTransaction?: (fn: () => void) => void;
  /** Structured lifecycle records for the host-owned voice transfer boundary. */
  voiceTransferLogger?: Logger;
  /** Host secrets directory for containment checks on generic secret grants. Defaults to secretsDirPath(). */
  secretsDir?: string;
  log?: (msg: string) => void;
}

/**
 * The exits a strict head-obligation run has, worded once. Both halves of the
 * experiment read this string: the discipline an enrolled run is told when its
 * selection arms enforcement, and the rejection raised if it yields cleanly
 * anyway. One wording means the instruction cannot drift from the rule.
 */
const STRICT_HEAD_CLOSURE_EXITS =
  "complete it, cancel it, schedule it, add a new unmet prerequisite, create a new live direct child, or write your own current checkpoint and then reassign the still-ready obligation to a distinct active actor";

/**
 * The actor scheduler (design Part D — the v2 pump repurposed). It owns the
 * {@link ActorRepository} (durable records) and the set of *live* actors,
 * and provides the mesh's primitives:
 *
 * - {@link spawn} — create a child actor (record + live instance) and return its
 *   id immediately (never blocks the parent — B.5's async rule). It does **not**
 *   wake the child: spawn is not an implicit message; a separate {@link sendMessage}
 *   is what puts the actor to work.
 * - {@link sendMessage} — route a message to a thread's inbox (the one primitive
 *   that subsumes dispatch/postComment/report). Async: a reply arrives later as a
 *   new inbound wake, never a blocking return value.
 * - {@link retire} — the parent's judgment that a child is done; closes the actor
 *   and its subtree and marks the records retired (B.5).
 *
 * The root is created by the wiring and {@link adopt}ed so workers can message it.
 * Execution coordination is not Mesh's: {@link RunManager} owns the live
 * actors, their construction, dispatch, admission, and terminal cleanup. Mesh
 * keeps the durable records and hands the manager an actor id.
 */
interface HeadClosureRunState {
  headObligationIds: Set<string>;
  /**
   * Each strict head as it stood when this actor first selected it in this
   * run, or null when the closure could not read it then. Handoff evidence is
   * scoped to the run against this snapshot, exactly as the child and
   * prerequisite exits are scoped against the pre-existing id sets below: the
   * run must have started with this actor owning the head, and the checkpoint
   * it hands off with must be a rewrite made during the run rather than a
   * standing left over from an earlier one.
   *
   * The first observation is the one kept. Re-selecting the same head later in
   * the run must not refresh the baseline, or a mid-run rewrite followed by a
   * re-selection would read as "unchanged" and a mid-run transfer as "never
   * owned".
   */
  selectedHeads: Map<string, SelectedHeadSnapshot | null>;
  preExistingChildIds: Map<string, Set<string>>;
  preExistingPrerequisiteIds: Map<string, Set<string>>;
}

/** The fields of a selected strict head that a handoff is judged against. */
interface SelectedHeadSnapshot {
  ownerId: string;
  checkpoint: string | null;
  checkpointAt: string | null;
  checkpointBy: string | null;
}

export class ActorMesh {
  readonly actors: ActorRepository;
  readonly principals?: import("../db/repositories/principal-repository.js").PrincipalRepository;
  private readonly createActor: ActorFactory;
  private readonly validateSpawn?: (req: SpawnRequest) => ProviderModelConfig[];
  private readonly supportsExecutionTarget?: (target: string) => boolean;
  private readonly validateModel?: (
    record: ActorRecord,
    modelConfig: ModelConfigInput
  ) => ProviderModelConfig[];
  /** The execution coordinator: live actors, construction, dispatch, admission. */
  private readonly runs: RunManager;
  private readonly isHalted: (provider?: string, model?: string) => boolean;
  private readonly isShuttingDown: () => boolean;
  private readonly idgen: () => string;
  private readonly now: () => string;
  private readonly handleForId: (id: string) => string;
  private readonly rootId?: string;
  private readonly onRetire?: (record: ActorRecord) => void;
  private readonly lifecycleListeners: readonly ActorLifecycleListener[];
  private readonly onLifecycleError?: ActorMeshOptions["onLifecycleError"];
  private readonly onYield?: (
    actorId: string,
    ctx: { notifyingParent: boolean }
  ) => string | null | undefined;
  private readonly recordRunYield?: ActorMeshOptions["recordRunYield"];
  private readonly onSpawn?: (record: ActorRecord) => void;
  private readonly onRevive?: (record: ActorRecord) => void;
  private readonly onCapabilityGranted?: (actorId: string, capability: string) => void;
  private readonly onCapabilityRevoked?: (
    actorId: string,
    capability: string
  ) => Promise<void> | void;
  /**
   * The last unresolved-class reason reported per actor, so a permanently
   * broken binding emits one event rather than one per dispatch attempt.
   * Cleared when the class resolves again.
   */
  private readonly reportedModelClassFailures = new Map<string, string>();
  private readonly onModelSet?: (
    actorId: string,
    modelConfig: ProviderModelConfig[],
    record: ActorRecord
  ) => void;
  private readonly retireCleanups: RetireCleanup[];
  private readonly events: MeshEventSink;
  private readonly recordChat?: (opts: {
    id?: string;
    senderId: string;
    recipientId: string;
    body: string;
    sessionId?: string;
  }) => string;
  readonly eventManager?: EventManager;
  private readonly grants: CapabilityGrantStore;
  private readonly experiments: ExperimentEnrollmentStore;
  private readonly eventSourceOwners: EventSourceOwnerStore;
  private readonly eventSourceSubscriptions: EventSourceSubscriptionStore;
  private readonly configuredEventSources: readonly EventResource[] | undefined;
  private readonly obligations?: MeshObligationPort;
  /** Captured at selection so root enrollment changes never alter an active run. */
  private readonly headClosureRuns = new Map<string, HeadClosureRunState>();
  private readonly inboxStore?: InboxRepository;
  private unsubscribeInboxAppends?: () => void;
  private dispatchJoiningActiveRunPort?: (actorId: string) => boolean;
  /**
   * Recipients of durably committed inbox rows that nothing has woken yet.
   * See {@link scheduleAppendedWork}.
   */
  private readonly appendWakesOwed = new Set<string>();
  private readonly supportedVoices: readonly VoiceDefinition[];
  private readonly isVoiceSessionActive: (actorId: string) => boolean;
  private readonly voiceSessionTransfer?: VoiceSessionTransferPort;
  private readonly listVoiceSessionChat?: (sessionId: string) => MeshChat[];
  private readonly onQueued?: ActorMeshOptions["onQueued"];
  private readonly onInboxEntriesSeen?: ActorMeshOptions["onInboxEntriesSeen"];
  private readonly responsiveInterruption?: ShadowResponsiveInterruptionClassifier;
  private readonly reactToChatMessage?: ActorMeshOptions["reactToChatMessage"];
  private readonly grantable: ReadonlySet<string>;
  private readonly secretsDir: string;
  private readonly log: (msg: string) => void;
  private readonly voiceTransferLog: Logger;
  private scheduledMessages?: ScheduledMessageScheduler;
  private readonly withTransaction: (fn: () => void) => void;
  private readonly runtimeStreamId = randomUUID();
  /** Direct callers without repository changes use this mesh-local epoch. */
  private readonly directReadyHeadEpoch = randomUUID();
  private runtimeRevision = 0;
  private readonly runtimeStateListeners = new Set<(delta: ActorRuntimeStateDelta) => void>();
  private readonly activeRunCounts = new Map<string, number>();
  private readonly deferredRetireCleanups = new Map<
    string,
    { record: ActorRecord; cleanups: RetireCleanup[] }
  >();
  setScheduledMessageScheduler(scheduler: ScheduledMessageScheduler): void {
    this.scheduledMessages = scheduler;
  }

  private readonly selectedInboxEntryIds = new Map<string, string[]>();
  /** Actors currently inside a run, for the ready-head window below. */
  private readonly actorsInRun = new Set<string>();
  /**
   * Ready-head churn observed while an actor is mid-run, collapsed at run end
   * into the single net transition (#1645 follow-up, operator 2026-08-30).
   *
   * An actor that files a question under the obligation it is working moves its
   * own head twice in one run — once when the parent is created, again when the
   * child makes that parent wait — so delivering per mutation wakes it about
   * work it just did, and about a head that had already gone waiting by the
   * time the entry landed. `from` is the head the first change displaced; `to`
   * is the head as of the latest change, or null once the queue has no head.
   */
  private readonly runHeadNet = new Map<
    string,
    {
      from: string | null;
      to: { id: string; intent: string | null; responsive?: boolean } | null;
      epoch: string;
    }
  >();
  /**
   * Ids whose {@link retire} is currently unwinding. A subtree retire recurses
   * into children *before* marking itself retired, so an ancestor mid-retire
   * still reads `status: "active"` in the repository — see
   * {@link resolveDropNotifyTarget}, which must not hand a notification to one.
   */
  private readonly retiring = new Set<string>();
  private readonly lifecycles = new Map<string, ActorLifecycle>();

  constructor(opts: ActorMeshOptions) {
    this.actors = opts.actors;
    this.principals = opts.principals;
    this.rootId = opts.rootId;
    this.createActor = opts.createActor;
    this.validateSpawn = opts.validateSpawn;
    this.supportsExecutionTarget = opts.supportsExecutionTarget;
    this.validateModel = opts.validateModel;
    this.grants = opts.capabilityGrants ?? new InMemoryCapabilityGrantStore();
    this.experiments = opts.experimentEnrollments ?? new InMemoryExperimentEnrollmentStore();
    this.eventSourceOwners = opts.eventSourceOwners ?? new InMemoryEventSourceOwnerStore();
    this.eventSourceSubscriptions =
      opts.eventSourceSubscriptions ?? new InMemoryEventSourceSubscriptionStore();
    this.configuredEventSources = opts.configuredEventSources;
    this.obligations = opts.obligations;
    this.inboxStore = opts.inboxStore;
    this.log = opts.log ?? (() => {});
    this.supportedVoices = opts.supportedVoices ?? [];
    this.isVoiceSessionActive = opts.isVoiceSessionActive ?? (() => false);
    this.voiceSessionTransfer = opts.voiceSessionTransfer;
    this.listVoiceSessionChat = opts.listVoiceSessionChat;
    this.onQueued = opts.onQueued;
    this.onInboxEntriesSeen = opts.onInboxEntriesSeen;
    this.responsiveInterruption = opts.responsiveInterruption;
    this.reactToChatMessage = opts.reactToChatMessage;
    // A host-global capability is never grantable through the mesh (#549), so
    // a wiring that lists one — the maintenance servers are registered like
    // any other grantable server — neither advertises nor grants it here.
    this.grantable = new Set(
      [...(opts.grantableCapabilities ?? [])].filter((cap) => !HOST_GLOBAL_CAPABILITIES.has(cap))
    );
    this.secretsDir = opts.secretsDir ?? secretsDirPath();
    if (!opts.inboxStore) {
      this.log(
        "ActorMesh constructed without an inboxStore; dispatch is disabled until durable inbox storage is wired"
      );
    }
    this.runs = new RunManager({
      inbox: opts.inboxStore ?? new EmptyInboxRepository(),
      maxConcurrent: opts.maxConcurrent,
      providerGate: opts.providerGate,
      rateLimit: opts.rateLimit,
      constructActor: (record) => this.createActor(this.factoryContext(record)),
      recordStatus: (actorId) => this.actors.get(actorId)?.status,
      isVoiceSessionActive: (actorId) => this.isVoiceSessionActive(actorId),
      markInboxSeen: (actorId) => {
        this.markInboxSeen(actorId);
      },
      onPreempted: (actorId, phase) => {
        this.recordEvent({
          kind: "run_preempted",
          actorId,
          detail: phase,
          payload: JSON.stringify({ reason: "responsive_notification" }),
        });
      },
      // Only wired when a classifier exists. The hook's presence is what
      // switches `RunManager` into collecting rows, so supplying it
      // unconditionally would make every deployment pay for an observer that
      // has nothing to observe — and would strand the default-path early exit.
      ...(this.responsiveInterruption
        ? {
            onResponsiveArrived: (
              actorId: string,
              entries: readonly InboxEntry[],
              baseline: "interrupt" | "queue"
            ) => {
              this.shadowResponsiveInterruptions(actorId, entries, baseline);
            },
          }
        : {}),
      onInternalPort: (port) => {
        this.dispatchJoiningActiveRunPort = port.dispatchJoiningActiveRun;
      },
      log: (msg) => this.log(msg),
    });
    this.isHalted = opts.isHalted ?? (() => false);
    this.isShuttingDown = opts.isShuttingDown ?? (() => false);
    this.idgen = opts.idgen ?? (() => randomUUID());
    this.now = opts.now ?? (() => new Date().toISOString());
    this.handleForId = opts.handleForId ?? generateHandle;
    this.onRetire = opts.onRetire;
    this.lifecycleListeners = opts.lifecycleListeners ?? [];
    this.onLifecycleError = opts.onLifecycleError;
    this.onYield = opts.onYield;
    this.recordRunYield = opts.recordRunYield;
    this.onSpawn = opts.onSpawn;
    this.onRevive = opts.onRevive;
    this.onCapabilityGranted = opts.onCapabilityGranted;
    this.onCapabilityRevoked = opts.onCapabilityRevoked;
    this.onModelSet = opts.onModelSet;
    this.retireCleanups = [
      ...(opts.retireCleanups ?? []),
      { name: "event subscriptions", run: (record) => this.retireEventSubscriptions(record) },
    ];
    this.events = opts.events ?? NOOP_MESH_EVENT_SINK;
    this.recordChat = opts.recordChat;
    this.voiceTransferLog = opts.voiceTransferLogger ?? nullLogger;
    this.scheduledMessages = opts.scheduledMessages;
    this.withTransaction = opts.withTransaction ?? ((fn) => fn());
    this.eventManager = opts.eventManager;
    if (opts.inboxStore) {
      this.unsubscribeInboxAppends = opts.inboxStore.onItemsAppended((items) => {
        this.scheduleAppendedWork(items);
      });
    }
  }

  /**
   * Standardized message emission for the ISSUE_NUM spine.
   *
   * `opts.id`, when supplied, is a stable idempotency key (e.g. a
   * scheduled-delivery id minted once at schedule time): the chat row
   * and its events all derive their ids from it so a retry after a crash
   * between the chat write and the caller's own durable bookkeeping re-runs
   * this as a safe no-op (`INSERT OR IGNORE`) instead of duplicating the
   * message.
   */
  recordMessageEmitted(opts: {
    id?: string;
    fromId: string;
    toId: string;
    body: string;
    sessionId?: string;
    isDrop: boolean;
  }): string | undefined {
    const fromId = this.resolveThreadId(opts.fromId);
    const toId = this.resolveThreadId(opts.toId);
    const msgId = this.writeChatRow({
      id: opts.id,
      fromId,
      toId,
      body: opts.body,
      sessionId: opts.sessionId,
    });

    this.recordEvent({
      id: opts.id ? `${opts.id}:sent` : undefined,
      kind: "message_sent",
      actorId: fromId,
      detail: opts.sessionId ?? (opts.isDrop ? DROPPED_MESSAGE_DETAIL : undefined),
      payload: msgId ? JSON.stringify({ messageId: msgId, to: toId }) : undefined,
    });

    if (!opts.isDrop) {
      this.recordEvent({
        id: opts.id ? `${opts.id}:received` : undefined,
        kind: "message_received",
        actorId: toId,
        detail: opts.sessionId,
        payload: msgId ? JSON.stringify({ messageId: msgId, from: fromId }) : undefined,
      });
    }
    return msgId;
  }

  private writeChatRow(opts: {
    id?: string;
    fromId: string;
    toId: string;
    body: string;
    sessionId?: string;
  }): string | undefined {
    if (!this.recordChat) return undefined;
    try {
      return this.recordChat({
        id: opts.id,
        senderId: opts.fromId,
        recipientId: opts.toId,
        body: opts.body,
        sessionId: opts.sessionId,
      });
    } catch (err) {
      this.log(`recordChat failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Persist the chat row and sent event when a scheduled message is accepted. */
  recordScheduledMessageSent(opts: ScheduledMessage): string | undefined {
    const fromId = this.resolveThreadId(opts.fromId);
    const toId = this.resolveThreadId(opts.toId);
    if (!this.recordChat) {
      throw new Error("Scheduled message acceptance requires durable chat storage");
    }
    const messageId = this.recordChat({
      id: opts.id,
      senderId: fromId,
      recipientId: toId,
      body: opts.body,
      sessionId: opts.sessionId,
    });
    const event = {
      id: `${opts.id}:sent`,
      kind: "message_sent" as const,
      actorId: fromId,
      detail: opts.sessionId,
      payload: JSON.stringify({ messageId, to: toId }),
    };
    // This is part of the acceptance transaction, so unlike ordinary
    // best-effort observability, a persistence failure must reach the caller.
    this.events(event);
    this.updateActiveRunState(event);
    return messageId;
  }

  private recordScheduledMessageReceived(delivery: ScheduledMessage): void {
    const fromId = this.resolveThreadId(delivery.fromId);
    const toId = this.resolveThreadId(delivery.toId);
    this.recordEvent({
      id: `${delivery.id}:received`,
      kind: "message_received",
      actorId: toId,
      detail: delivery.sessionId,
      payload: JSON.stringify({ messageId: delivery.id, from: fromId }),
    });
  }

  /** Record a mesh event; the sink is best-effort and never breaks routing. */
  recordEvent(...args: Parameters<MeshEventSink>): void {
    const [event] = args;
    try {
      this.events(...args);
    } catch (err) {
      this.log(`event sink failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.updateActiveRunState(event);
  }

  /**
   * Return the one lifecycle fanout for an actor. The execution coordinator
   * receives this before construction so observers cannot be smuggled through
   * actor invocation inputs as logging or accounting callbacks.
   */
  lifecycleFor(actorId: string): ActorLifecycle {
    const existing = this.lifecycles.get(actorId);
    if (existing) return existing;
    const lifecycle = createActorLifecycle(
      [
        {
          onQueued: (event) => {
            this.actorQueued(event.actorId, event);
          },
          onEnd: (event) => {
            if (event.terminal.kind === "result") {
              this.finishInboxRun(event.actorId);
              this.accountRun(event.actorId, event.terminal.result, event.runId);
            } else {
              this.abandonInboxRun(event.actorId);
              // A launched run that ended without a result still ended: a pool
              // staged while it ran is due now, not at some later dispatch (#652).
              if (event.terminal.started) this.applyPendingModel(event.actorId);
            }
            // A selection is run-scoped regardless of its terminal shape.
            this.clearSelection(event.actorId);
          },
        },
        ...this.lifecycleListeners,
      ],
      (failure) => {
        this.log(
          `lifecycle ${failure.event} listener failed: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`
        );
        this.onLifecycleError?.(failure);
      }
    );
    this.lifecycles.set(actorId, lifecycle);
    return lifecycle;
  }

  /**
   * Register an externally-created actor (the root) so the mesh can route
   * messages to it and the repository knows it exists. Idempotent on the record.
   *
   * The wiring rebuilds `record` fresh on every boot : it carries the
   * current config/session while the repository retains durable identity fields.
   * Merge onto any existing record so the freshly configured fields win without
   * changing stable creation metadata.
   */
  adopt(record: ActorRecord, actor: MeshActor): void {
    const existing = this.actors.get(record.id);
    this.actors.upsert(existing ? { ...existing, ...record } : record);
    this.runs.register(record.id, actor);
    if (actor.lifecycle) this.lifecycles.set(record.id, actor.lifecycle);
    else this.lifecycleFor(record.id);
    this.actorRuntimeStateChanged(record.id, this.runtimeStateOf(actor));
  }

  /**
   * Recreate the live {@link Actor} for an existing record — boot restore for
   * actors the repository persisted across a restart. Unlike {@link spawn} it
   * mints no record, grants no handle, and does **not** wake the actor: waking it
   * with no reason would be a phantom run. No-op if it's already live or not
   * active (retired threads stay dead).
   *
   * Rehydration alone does not wake: after all active actors are live, boot-time
   * inbox reconciliation nudges actors with durable work.
   */
  rehydrate(record: ActorRecord): void {
    if (this.runs.isLive(record.id)) return; // already live (e.g. the adopted root)
    if (record.status !== "active") return; // don't revive retired threads
    try {
      const actor = this.runs.instantiate(record);
      this.actorRuntimeStateChanged(record.id, this.runtimeStateOf(actor));
      this.log(`rehydrated ${record.id} (parent ${record.parentId})`);
    } catch (err) {
      this.log(
        `rehydrate(${record.id}) failed, skipping: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Rehydrate every active actor the repository knows about. Call once on boot
   * *after* the root is adopted, so a worker's parent is live before the worker
   * is. Already-live (root) and retired records are skipped.
   */
  rehydrateAll(): void {
    for (const record of this.actors.list()) this.rehydrate(record);
  }

  /**
   * Boot reconciliation for the OS-owned pending-message queue. The `at` jobs
   * are already armed and contain their own payloads; the mesh only removes
   * jobs whose recipients can no longer receive them.
   */
  reconcilePendingDeliveries(): void {
    if (!this.scheduledMessages) return;
    for (const message of this.scheduledMessages.listMessageDeliveries()) {
      const recipient = this.actors.get(message.toId);
      if (recipient?.status === "active") continue;
      try {
        this.notifyScheduledDeliveryDropped(message.toId, message);
        this.scheduledMessages.cancelMessageDelivery(message.id);
        this.log(`cancelled scheduled message ${message.id} for inactive actor ${message.toId}`);
      } catch (err) {
        this.log(
          `failed to cancel scheduled message ${message.id} for inactive actor ${message.toId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /** Boot recovery: nudge each live actor with durable unhandled work at most once. */
  reconcileInbox(): void {
    if (!this.inboxStore) return;
    try {
      for (const work of this.inboxStore.actorsWithUnhandled()) {
        const record = this.actors.get(work.actorId);
        if (record && record.status !== "active") continue;
        this.dispatch(work.actorId);
      }
    } catch (err) {
      // Recovery is a nudge over durable state, not the durability boundary.
      // A later run/sweep can still list the entries; keep boot/shutdown races
      // failure-isolated while making the missed nudge journal-visible.
      this.log(`inbox reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Resume recovery: nudge only work that never passed a pre-run halt gate. */
  reconcileUnseenInbox(): void {
    if (!this.inboxStore) return;
    try {
      for (const work of this.inboxStore.actorsWithUnseen()) {
        const record = this.actors.get(work.actorId);
        if (record && record.status !== "active") continue;
        this.dispatch(work.actorId);
      }
    } catch (err) {
      this.log(
        `unseen inbox reconciliation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Boot recovery for ready-head inbox attention (#1645).
   *
   * Verifies that every active actor with a ready head has durable attention in
   * its inbox. Entries are scoped to the source repository's epoch (#513):
   * dedupe is exactly-once within that repository lifetime, repeated reconcile
   * passes over an unchanged head stay silent, and any restart delivers at
   * most the operator-accepted one duplicate attention entry per ready head.
   * Scoping boot reconciliation to the repository epoch guarantees that a
   * missed recurrence whose live append was lost (e.g.
   * process crash between commit and append) always delivers a recovery
   * attention after restart, without colliding with an earlier handled repair
   * entry from a previous process generation.
   */
  reconcileReadyHeads(obligations: {
    readyHeadEpoch: string;
    readyHeadRecords(): Iterable<{ ownerId: string; headId: string; responsive: boolean }>;
    get(id: string): { id: string; intent: string | null } | null;
  }): void {
    if (!this.inboxStore) return;
    try {
      for (const { ownerId, headId, responsive } of obligations.readyHeadRecords()) {
        if (ownerId.startsWith("human:") || ownerId.startsWith("system:")) continue;
        const actorId = this.resolveThreadId(ownerId);
        const record = this.actors.get(actorId);
        if (!record || record.status !== "active") continue;
        const head = obligations.get(headId);
        if (!head) continue;
        this.appendReadyHeadEntry(
          actorId,
          { id: head.id, intent: head.intent, responsive },
          null,
          null,
          obligations.readyHeadEpoch
        );
      }
    } catch (err) {
      this.log(
        `ready-head reconciliation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * The mesh's only dispatch input: tell a `RunManager` that an actor may have
   * durable work. The call carries no priority, no item, and no nudge — every
   * one of those is read back out of the inbox — so no caller can describe work
   * the durable record does not already hold. It returns whether an execution
   * opportunity was requested; a dispatch against an actor with nothing
   * unhandled is a no-op, and a dispatch lost entirely is recovered by
   * reconciliation rather than by the sender retrying.
   *
   * Dispatch replaces an in-flight run when the durable work is responsive —
   * operator control, human messages, and `runNow` all mean "now". The one wake
   * that may not is an event copy for a recipient other than the effective
   * owner; that decision lives in {@link dispatchJoiningActiveRun}, so no
   * caller of this method can turn preemption off.
   */
  dispatch(actorId: string): boolean {
    const resolved = this.resolveThreadId(actorId);
    this.appendWakesOwed.delete(resolved);
    return this.runs.dispatch(resolved);
  }

  /**
   * Fire-and-forget shadow decisions over the exact rows the durable inbox
   * identified as newly arrived, before its normal preemption path runs. Only
   * ids cross this seam: message bodies, issue text, and other operational
   * content stay in their source stores.
   *
   * The comparison sets are read synchronously, before the `void`, because
   * they describe the actor's state at the moment the row arrived. Deferring
   * the read past the await boundary would let the run this dispatch is about
   * to preempt change its own selection first, and the decision would then be
   * scored against a world that the arrival had already altered.
   */
  private shadowResponsiveInterruptions(
    actorId: string,
    incoming: readonly InboxEntry[],
    baseline: "interrupt" | "queue"
  ): void {
    const classifier = this.responsiveInterruption;
    if (!classifier || incoming.length === 0) return;
    const selectedEntryIds = [...this.selectedInboxEntries(actorId)];
    // Unselected rows are only ever the fallback for an actor holding no
    // selection, so a selection spares the full unhandled scan entirely.
    const pendingEntryIds =
      selectedEntryIds.length > 0 ? [] : this.unselectedInboxEntryIds(actorId, selectedEntryIds);
    for (const entry of incoming) {
      // Explicit Run Now is an operator control, not a classifier candidate.
      // Direct interrupt() does not dispatch at all, preserving its hard path.
      if (entry.payload.type === "operator.run_now") continue;
      const incomingEntryId = entry.id;
      void classifier
        .evaluate({ incomingEntryId, selectedEntryIds, pendingEntryIds })
        .then((decision) => {
          this.recordEvent({
            kind: "responsive_interruption_shadow",
            actorId,
            detail: "shadow",
            payload: JSON.stringify({ baseline, decision }),
          });
          // The audit row is recorded first and independently: a chat space
          // the bot cannot react in must not cost the measurement this whole
          // feature exists to collect.
          const prediction = shadowPrediction(decision);
          if (prediction) this.postShadowReaction(entry.payload, prediction, incomingEntryId);
        })
        .catch(() => {
          // `evaluate` resolves rather than throws, so this arm covers only a
          // failure to record the observation. It emits no decision — one
          // audit shape means a consumer parses one schema — and exists so a
          // fire-and-forget promise cannot reject unhandled.
          this.log(`responsive interruption shadow observation failed for ${incomingEntryId}`);
        });
    }
  }

  /**
   * Show a shadow verdict where the operator already is, on the arriving chat
   * message. Gated on the classifier's own presence rather than a separate
   * knob, so the opt-in that turns the policy on is the same one that turns
   * this on and a default install posts nothing.
   */
  private postShadowReaction(
    payload: Readonly<Record<string, unknown>>,
    outcome: ResponsiveInterruptionVerdict,
    incomingEntryId: string
  ): void {
    const react = this.reactToChatMessage;
    if (!react) return;
    const target = shadowReactionTarget(payload, outcome);
    if (!target) return;
    // A reaction is an observation aid, never a delivery guarantee. Failures
    // are logged rather than retried; the audit event already holds the
    // verdict either way.
    void react(target.messageName, target.emoji).catch(() =>
      this.log(`responsive interruption shadow reaction failed for ${incomingEntryId}`)
    );
  }

  /** Read the entire durable unhandled set minus the selected rows; a
   * classifier must not infer a comparison target from a convenient first page
   * or a racing "latest" row. */
  private unselectedInboxEntryIds(actorId: string, selectedEntryIds: readonly string[]): string[] {
    const inbox = this.inboxStore;
    if (!inbox) return [];
    const selected = new Set(selectedEntryIds);
    let cursor: string | undefined;
    const entryIds: string[] = [];
    do {
      const page = inbox.list(actorId, { status: "unhandled", limit: 100, cursor });
      for (const entry of page.entries) {
        if (!selected.has(entry.id)) entryIds.push(entry.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return entryIds;
  }

  /**
   * The dispatch that schedules without interrupting. Responsive work still
   * passes the voice hold and is admitted; what it does not do is replace a
   * run already in flight. Private and named so "responsive but not
   * preempting" cannot leak into a control path. Its two callers are event
   * fan-out's non-owner copy and self-caused mid-run ready attention.
   */
  private dispatchJoiningActiveRun(dest: string): boolean {
    const resolved = this.resolveThreadId(dest);
    const dispatchJoiningActiveRun = this.dispatchJoiningActiveRunPort;
    if (!dispatchJoiningActiveRun) return false;
    this.appendWakesOwed.delete(resolved);
    return dispatchJoiningActiveRun(resolved);
  }

  /**
   * The seam between a durable inbox write and scheduling (#388).
   *
   * Every row `append` commits leaves its recipient owed one content-free
   * {@link dispatch} attempt. The notification is advisory by the store's
   * contract — a refused or lost attempt costs latency, not correctness, because
   * {@link reconcileInbox} replays the same fact out of `actorsWithUnhandled()`
   * at boot.
   *
   * The debt is settled by whoever reaches the actor first, and this pays only
   * what nobody else did. Every appending path in the mesh still wakes its own
   * recipient in the same turn, some of them deliberately without preempting —
   * an event copy delivered to a recipient that is not its effective owner is
   * entitled to join the run in flight rather than replace it — and those
   * wakes clear the debt, which is what stops a second dispatch from
   * cancelling and re-queueing the run the first one just admitted. What is
   * left over is the case this exists for: work that became durable with no
   * one attempting to schedule it, which now gets that attempt instead of
   * waiting for the next boot.
   *
   * Deferring to a microtask is what gives the appending turn its chance, and
   * the store's contract asks a listener to stay cheap and hand off rather
   * than block the appender.
   */
  private scheduleAppendedWork(items: readonly InboxEntry[]): void {
    let owed = false;
    for (const item of items) {
      // Keyed the way the two dispatches key their deletes, so a row addressed
      // to "root" and a dispatch of the concrete root id are the same debt.
      const actorId = this.resolveThreadId(item.actorId);
      if (this.appendWakesOwed.has(actorId)) continue;
      this.appendWakesOwed.add(actorId);
      owed = true;
    }
    // The only writer above queues this drain whenever it adds a new debt; a
    // drain snapshots and clears the whole set, so an already-owed id is safe
    // to skip here.
    if (!owed) return;
    queueMicrotask(() => {
      const unpaid = [...this.appendWakesOwed];
      this.appendWakesOwed.clear();
      for (const actorId of unpaid) {
        try {
          this.dispatch(actorId);
        } catch (err) {
          // An advisory wake is never allowed to become the appender's
          // problem, and boot reconciliation still covers what it missed.
          this.log(
            `inbox notification dispatch for ${actorId} failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    });
  }

  /** Lifecycle boundary after the halt gate and before scheduler admission. */
  actorQueued(actorId: string, context: { responsive: boolean; mode: ActorRunMode }): InboxEntry[] {
    actorId = this.resolveThreadId(actorId);
    this.selectedInboxEntryIds.delete(actorId);
    this.headClosureRuns.delete(actorId);
    // Open the run-scoped head window. An actor absent from this set delivers
    // head attention immediately, which is what every non-run producer wants.
    this.actorsInRun.add(actorId);
    this.runHeadNet.delete(actorId);
    const entries = context.mode === "ordinary" ? this.markInboxSeen(actorId) : [];
    try {
      this.onQueued?.(actorId, context);
    } catch (err) {
      this.log(`onQueued(${actorId}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return entries;
  }

  private markInboxSeen(actorId: string): InboxEntry[] {
    if (!this.inboxStore) return [];
    const entries = this.inboxStore.markSeen(actorId);
    if (entries.length > 0 && this.onInboxEntriesSeen) {
      try {
        this.onInboxEntriesSeen(actorId, entries);
      } catch (err) {
        this.log(
          `inbox receipt failed for ${actorId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return entries;
  }

  /**
   * Establish the run-scoped subset that may be marked handled. When supplied,
   * `beforeCommit` must durably record the selection; the in-memory guard is
   * installed only after that callback succeeds.
   */
  selectInboxEntries(
    actorId: string,
    entryIds: string[],
    beforeCommit?: (entries: InboxEntry[]) => void,
    focusedObligationId?: string
  ): InboxEntry[] {
    actorId = this.resolveThreadId(actorId);
    const inboxStore = this.inboxStore;
    if (!inboxStore) throw new Error("Inbox is not configured");
    const unique = [...new Set(entryIds)];
    if (unique.length === 0 || unique.length > 100 || unique.length !== entryIds.length) {
      throw new Error("Select between 1 and 100 unique inbox entry ids");
    }
    const entries = unique.map((id) => {
      const entry = inboxStore.read(actorId, id);
      if (!entry) throw new Error(`Inbox entry not found: ${id}`);
      if (entry.handledAt) throw new Error(`Inbox entry already handled: ${id}`);
      if (this.isVoiceSessionActive(actorId) && entry.payload.priority !== "responsive") {
        throw new Error("ordinary inbox work is held while a voice session is active");
      }
      return entry;
    });
    // Capture experiment membership now. Root can revise enrollment later, but
    // that governs a future selection rather than retroactively releasing or
    // constraining this already-running actor.
    // Snapshot the selected focus now. A direct focus and selected ready-head
    // attention both contribute: supplying an explicit id must not let an
    // actor bypass a ready head included in the same selection. Direct focus
    // only arms its owning actor; the resolver may record another live row as
    // context, but strict clean-yield closure is a commitment of its owner.
    const strictEnrolled = this.isEnrolledInExperiment(
      actorId,
      STRICT_OBLIGATION_HANDLING_EXPERIMENT
    );
    const readyHeadObligationIds = strictEnrolled
      ? entries.flatMap((entry) =>
          entry.payload.type === "obligation.ready_head" &&
          typeof entry.payload.obligationId === "string"
            ? [entry.payload.obligationId]
            : []
        )
      : [];
    const focusedObligationIds = strictEnrolled
      ? [
          ...(focusedObligationId !== undefined ? [focusedObligationId] : []),
          ...readyHeadObligationIds,
        ]
      : [];
    // Fail closed, and fail here — before the selection commits, so nothing has
    // run yet and no clean yield can slip past unenforced. An enrolled actor in
    // a mesh without closure reads is a misconfiguration the root must fix by
    // wiring the port or unenrolling, not a run that silently opts out.
    const closure = this.obligations;
    if (focusedObligationIds.length > 0 && !supportsObligationClosureReads(closure)) {
      throw new Error(
        `Cannot select head attention: ${actorId} is enrolled in ${STRICT_OBLIGATION_HANDLING_EXPERIMENT}, but this mesh has no obligation closure reads (get, listDirectChildEdges, listPrerequisiteEdges) wired. Wire the closure port or unenroll the actor.`
      );
    }
    // Membership and status are both selection-time facts. Keeping only ready
    // focuses in the run state makes a later waiting -> ready transition stay
    // unarmed, while a ready -> waiting transition retains the existing legal
    // exit checks for the run that selected it. A transiently unreadable row
    // remains fail-closed, as it did before status-aware selection: silently
    // releasing a strict run on a failed closure read would be less safe.
    const headObligationIds = supportsObligationClosureReads(closure)
      ? [...new Set(focusedObligationIds)].filter((obligationId) => {
          const focused = closure.get(obligationId);
          // A ready-head read that vanishes remains fail-closed as before. A
          // readable focus must belong to this actor at selection before it can
          // arm a run: an explicit id may name a foreign row, and a durable
          // ready-head entry can outlive a reassignment made after delivery.
          // A foreign row is never this actor's closure commitment.
          if (focused === null) return readyHeadObligationIds.includes(obligationId);
          return focused.status === "ready" && this.resolveThreadId(focused.ownerId) === actorId;
        })
      : [];
    beforeCommit?.(entries);
    this.selectedInboxEntryIds.set(actorId, unique);
    if (headObligationIds.length > 0 && supportsObligationClosureReads(closure)) {
      const run: HeadClosureRunState = this.headClosureRuns.get(actorId) ?? {
        headObligationIds: new Set<string>(),
        selectedHeads: new Map<string, SelectedHeadSnapshot | null>(),
        preExistingChildIds: new Map<string, Set<string>>(),
        preExistingPrerequisiteIds: new Map<string, Set<string>>(),
      };
      this.headClosureRuns.set(actorId, run);
      for (const obligationId of headObligationIds) {
        run.headObligationIds.add(obligationId);
        if (!run.selectedHeads.has(obligationId)) {
          // An unreadable head is recorded as such rather than left absent, so
          // a later re-selection cannot quietly supply a baseline the run did
          // not start with. Enforcement then fails closed on a handoff of it;
          // every other exit is judged from the live row as before.
          const selected = closure.get(obligationId);
          run.selectedHeads.set(
            obligationId,
            selected
              ? {
                  ownerId: selected.ownerId,
                  checkpoint: selected.checkpoint,
                  checkpointAt: selected.checkpointAt,
                  checkpointBy: selected.checkpointBy,
                }
              : null
          );
        }
        if (!run.preExistingChildIds.has(obligationId)) {
          run.preExistingChildIds.set(
            obligationId,
            new Set(closure.listDirectChildEdges(obligationId).map((child) => child.id))
          );
        }
        if (!run.preExistingPrerequisiteIds.has(obligationId)) {
          run.preExistingPrerequisiteIds.set(
            obligationId,
            new Set(
              closure
                .listPrerequisiteEdges(obligationId)
                .map((prerequisite) => prerequisite.prerequisiteId)
            )
          );
        }
      }
    }
    const actor = this.runs.liveActor(actorId);
    if (actor) {
      this.actorRuntimeStateChanged(actorId, this.runtimeStateOf(actor), {
        refreshThreadSnapshot: true,
      });
    }
    return entries;
  }

  /**
   * The experiment-specific discipline in force for this actor's current run,
   * or undefined when none is — the text an enrolled actor is told at
   * selection, so a rejected yield is never its first explanation of the rule.
   *
   * This reads the armed run state {@link assertCleanYieldAllowed} enforces
   * rather than re-evaluating enrollment. Instruction and enforcement are then
   * the same decision: a root enrollment change lands on both at the next
   * selection and on neither in between, and an actor that is told nothing is
   * an actor nothing will be enforced against.
   *
   * States the obligation rule directly without experiment framing, and per
   * head: enforcement walks every armed head, so a selection of several is
   * told that each one must take a legal exit, not just the first.
   */
  runDisciplineNotice(actorId: string): string | undefined {
    actorId = this.resolveThreadId(actorId);
    const runState = this.headClosureRuns.get(actorId);
    if (!runState || runState.headObligationIds.size === 0) return undefined;
    const heads = [...runState.headObligationIds];
    const selected =
      heads.length === 1 ? `head obligation ${heads[0]}` : `head obligations ${heads.join(", ")}`;
    return `This run selected ${selected}. Before \`yield_run\`, every selected head must take one of these exits: ${STRICT_HEAD_CLOSURE_EXITS}. A clean yield that leaves any selected head as it was found is rejected.`;
  }

  selectedInboxEntries(actorId: string): readonly string[] {
    actorId = this.resolveThreadId(actorId);
    return this.selectedInboxEntryIds.get(actorId) ?? [];
  }

  finishInboxRun(actorId: string): void {
    actorId = this.resolveThreadId(actorId);
    this.selectedInboxEntryIds.delete(actorId);
    this.headClosureRuns.delete(actorId);
    this.flushRunHeadAttention(actorId);
    // Both factory-created workers and the externally-created root finish runs
    // through this boundary. Applying here covers a tuple staged mid-run: it
    // stays on the launched tuple and only picks up the new one now, for the
    // run after. A tuple set while idle/queued was already applied by
    // {@link setActorModel}, so this call is then a no-op.
    this.applyPendingModel(actorId);
  }

  /**
   * Close the run-scoped inbox state for a run that ended without a result.
   * It does not consume a staged model change itself: the lifecycle `onEnd`
   * applies one only when the abandoned run had actually launched.
   */
  abandonInboxRun(actorId: string): void {
    actorId = this.resolveThreadId(actorId);
    this.selectedInboxEntryIds.delete(actorId);
    this.headClosureRuns.delete(actorId);
    this.flushRunHeadAttention(actorId);
  }

  /**
   * Deliver at most one entry for everything a run did to its own ready head.
   *
   * The net transition is the head the run started with against the head it
   * ended with. If they match, the run churned and settled back — nothing to
   * say. If it ended with no head at all (every ready obligation became a
   * waiting parent, typically because the actor filed a question for a human
   * under it), there is nothing to point at, so nothing is delivered.
   */
  private flushRunHeadAttention(actorId: string): void {
    this.actorsInRun.delete(actorId);
    const net = this.runHeadNet.get(actorId);
    this.runHeadNet.delete(actorId);
    // Nothing moved, it settled back where it started, or it ended with no head
    // at all — in the last case there is no obligation to point the actor at.
    if (!net || net.to === null || net.to.id === net.from) return;
    this.appendReadyHeadEntry(actorId, net.to, net.from, null, net.epoch);
  }

  /**
   * Durable attention for an actor that gained a new ready head (#1645).
   *
   * The obligation store stays the work-state authority; this is only the wake
   * surface. `append` is `ON CONFLICT(id) DO NOTHING`, so exact-once comes from
   * the entry id — but the id is derived from the *transition* (which head this
   * one displaced), not from the resulting head alone.
   *
   * Keying on the head alone made the id permanent per (actor, obligation),
   * which is exactly-once but not live. An actor notified about head H that
   * marked the entry handled while deferring H, then worked a higher-priority
   * H0, got nothing at all when H became its head again: no entry, no nudge,
   * and `reconcileInbox` could not rescue it because the only entry for H was
   * already handled. Keying on `previousHeadId -> head.id` makes that a
   * distinct transition, so the actor is woken again.
   *
   * Dedupe is scoped to the repository's epoch: the
   * repository's sequence numbers restart at 1 on every boot, so a genuine
   * repeated transition (the same `previousHeadId -> headId` recurring after a
   * restart) reuses a triple a handled pre-restart entry already claimed. The
   * epoch keeps that recurrence a distinct inbox entry instead of letting the
   * conflict clause swallow a real wake — exactly-once within a repository
   * lifetime. The accepted cost, per the operator ruling on
   * #513 (recomputable table removed; process-local dedupe), is at most one
   * duplicate attention entry when a committed transition is replayed across
   * a restart. Boot reconciliation in {@link reconcileReadyHeads} likewise
   * scopes its entry to the repository epoch, so a head that recurred
   * after its transition's append was lost does not collide with an already-handled
   * entry from an earlier process generation.
   *
   * A run-collapsed transition has no repository sequence. Repeating its
   * identical net `previousHeadId -> headId` within one repository lifetime
   * therefore remains deliberately deduplicated after the first entry.
   */
  deliverReadyHeadAttention(
    actorId: string,
    /** The new head, or null when the owner no longer has one. */
    head: { id: string; intent: string | null; responsive?: boolean } | null,
    previousHeadId: string | null = null,
    sequence: number | null = null,
    epoch: string = this.directReadyHeadEpoch
  ): boolean {
    actorId = this.resolveThreadId(actorId);
    // Mid-run: accumulate rather than deliver. `from` is fixed by the first
    // change of the run so the collapsed entry describes where the run started,
    // not where its last mutation happened to leave off.
    if (this.actorsInRun.has(actorId)) {
      const net = this.runHeadNet.get(actorId);
      this.runHeadNet.set(actorId, { from: net ? net.from : previousHeadId, to: head, epoch });
      return false;
    }
    if (head === null) return false;
    return this.appendReadyHeadEntry(actorId, head, previousHeadId, sequence, epoch);
  }

  private appendReadyHeadEntry(
    actorId: string,
    head: { id: string; intent: string | null; responsive?: boolean },
    previousHeadId: string | null,
    sequence: number | null,
    /** Epoch from the repository whose sequence produced this transition. */
    epoch: string
  ): boolean {
    if (!this.inboxStore) return false;
    const record = this.actors.get(actorId);
    if (!record || record.status !== "active") return false;
    // Live transitions and boot repairs are keyed on
    // (repository epoch, transition, sequence): exactly-once within that
    // repository lifetime, and never silently suppressed after its sequence
    // restarts in a replacement repository (#513).
    const seqKey = sequence !== null ? `:${sequence}` : "";
    const entryId = deduplicatedInboxEntryId(
      `obligation-head:${epoch}:${actorId}:${previousHeadId ?? "none"}->${head.id}${seqKey}`,
      actorId
    );
    const responsive = head.responsive === true;
    const entries = this.inboxStore.append([
      {
        id: entryId,
        actorId,
        source: `obligation:${head.id}`,
        payload: {
          type: "obligation.ready_head",
          obligationId: head.id,
          intent: head.intent ?? undefined,
          // A responsive head's attention is immediately responsive work:
          // it preempts where the inbox model admits preemption. The priority
          // written here is the only thing that makes the dispatch below
          // responsive.
          ...(responsive ? { priority: "responsive" as const } : {}),
        } as unknown as InboxPayload,
      },
    ]);
    if (entries.length === 0) {
      return false;
    }
    this.dispatch(actorId);
    return true;
  }

  /**
   * Durable attention for a responsive obligation that became ready behind its
   * owner's queue head (#531). The head path announces a new head; this path
   * covers the responsive work that lands behind one, which would otherwise
   * wait for the head to clear before the owner ever heard about it.
   *
   * The dedupe key is per (obligation, ready episode) — one announcement per
   * ready episode, the same one-shot contract as
   * {@link deliverPrerequisiteCancelledAttention} with the episode counter
   * standing in for the permanent cancelled fact. A permanent per-obligation
   * key would be exactly-once but not live: a recurring responsive obligation
   * re-armed behind a persistent head, or a non-recurring one cycling
   * waiting→ready more than once, would re-arm into a key the owner already
   * handled and never be announced again. Keying on the obligation's
   * `readyCount` makes every new episode a distinct entry; a replay of the
   * same committed episode is still a silent `ON CONFLICT DO NOTHING`.
   */
  deliverResponsiveReadyAttention(
    ownerId: string,
    obligation: { id: string; intent: string | null; readyCount?: number },
    /**
     * The owner made its own obligation ready mid-run: it is already running
     * and will see the obligation in its queue, so a normal follow-up nudge
     * joins the run instead of preempting it. Any other cause is responsive
     * and preempts — the v1 interrupt the inbox model admits.
     */
    selfCausedMidRun = false
  ): boolean {
    if (!this.inboxStore) return false;
    const actorId = this.resolveThreadId(ownerId);
    const record = this.actors.get(actorId);
    if (!record || record.status !== "active") return false;
    const episodeKey = obligation.readyCount !== undefined ? `:${obligation.readyCount}` : "";
    const entryId = deduplicatedInboxEntryId(
      `obligation-ready-responsive:${obligation.id}${episodeKey}`,
      actorId
    );
    const entries = this.inboxStore.append([
      {
        id: entryId,
        actorId,
        source: `obligation:${obligation.id}`,
        payload: {
          type: "obligation.ready_responsive",
          obligationId: obligation.id,
          intent: obligation.intent ?? undefined,
          priority: "responsive",
        } as unknown as InboxPayload,
      },
    ]);
    if (entries.length === 0) return false;
    if (selfCausedMidRun && this.actorsInRun.has(actorId)) {
      this.dispatchJoiningActiveRun(actorId);
    } else {
      this.dispatch(actorId);
    }
    return true;
  }

  /**
   * Boot recovery for responsive-ready attention (#531). The fact set is
   * always recoverable from obligation state (ready, responsive-resolved,
   * actor-owned, behind the owner's head), so this replays that query through
   * the same idempotent delivery path used at the moment of transition —
   * `append` is `ON CONFLICT(id) DO NOTHING`, so a transition already delivered
   * is a silent no-op.
   */
  reconcileResponsiveReadyAttention(obligations: {
    listResponsiveReadyAttention(): Iterable<{
      id: string;
      ownerId: string;
      intent: string | null;
      readyCount?: number;
    }>;
  }): void {
    if (!this.inboxStore) return;
    try {
      for (const obligation of obligations.listResponsiveReadyAttention()) {
        if (obligation.ownerId.startsWith("human:") || obligation.ownerId.startsWith("system:")) {
          continue;
        }
        const actorId = this.resolveThreadId(obligation.ownerId);
        const record = this.actors.get(actorId);
        if (!record || record.status !== "active") continue;
        this.deliverResponsiveReadyAttention(obligation.ownerId, obligation);
      }
    } catch (err) {
      this.log(
        `responsive-ready reconciliation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Durable attention for a dependent left permanently blocked because a
   * prerequisite was cancelled (#212). Unlike a ready head, this is a one-shot
   * terminal fact rather than something that keeps changing while an actor
   * runs — no sequence number is needed, only exact-once delivery of the one
   * (dependent, prerequisite) pair.
   */
  deliverPrerequisiteCancelledAttention(
    actorId: string,
    dependentObligationId: string,
    prerequisiteId: string
  ): boolean {
    if (!this.inboxStore) return false;
    actorId = this.resolveThreadId(actorId);
    const record = this.actors.get(actorId);
    if (!record || record.status !== "active") return false;
    const entryId = deduplicatedInboxEntryId(
      `obligation-prereq-cancelled:${prerequisiteEdgeKey(dependentObligationId, prerequisiteId)}`,
      actorId
    );
    const entries = this.inboxStore.append([
      {
        id: entryId,
        actorId,
        source: `obligation:${dependentObligationId}`,
        payload: {
          type: "obligation.prerequisite_cancelled",
          obligationId: dependentObligationId,
          prerequisiteId,
        } as unknown as InboxPayload,
      },
    ]);
    if (entries.length === 0) return false;
    this.dispatch(actorId);
    return true;
  }

  /**
   * Boot recovery for cancellation-repair attention (#212). The fact itself is
   * always recoverable from obligation state (a live dependent whose named
   * prerequisite is cancelled), so this simply replays that query through the
   * same idempotent delivery path used at the moment of cancellation.
   */
  reconcileCancelledPrerequisiteAttention(obligations: {
    listPrerequisiteCancellationAttention(): Iterable<{
      dependentId: string;
      dependentOwnerId: string;
      prerequisiteId: string;
    }>;
  }): void {
    if (!this.inboxStore) return;
    try {
      for (const {
        dependentId,
        dependentOwnerId,
        prerequisiteId,
      } of obligations.listPrerequisiteCancellationAttention()) {
        if (dependentOwnerId.startsWith("human:") || dependentOwnerId.startsWith("system:")) {
          continue;
        }
        const actorId = this.resolveThreadId(dependentOwnerId);
        const record = this.actors.get(actorId);
        if (!record || record.status !== "active") continue;
        this.deliverPrerequisiteCancelledAttention(actorId, dependentId, prerequisiteId);
      }
    } catch (err) {
      this.log(
        `prerequisite-cancellation reconciliation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  inboxHandled(actorId: string): void {
    actorId = this.resolveThreadId(actorId);
    if (this.inboxStore && this.inboxStore.countUnhandled(actorId) > 0) {
      this.dispatch(actorId);
    }
  }

  /**
   * Called once by the leased voice registry on explicit end or lease expiry.
   * The durable inbox remains the source of truth; this is only the one
   * ordinary nudge that lets held background work resume.
   */
  notifyVoiceSessionEnded(actorId: string): boolean {
    actorId = this.resolveThreadId(actorId);
    if (!this.inboxStore) return false;
    const total = this.inboxStore.countUnhandled(actorId);
    const responsive = this.inboxStore.countUnhandled(actorId, { responsiveOnly: true });
    if (total > responsive) return this.dispatch(actorId);
    return false;
  }

  /**
   * Transfer the caller's one active leased voice session to a target the
   * caller already holds as a messaging capability. The session remains
   * process-local; the receiving actor gets a responsive, durable inbox entry
   * whose context is mechanically rendered from existing `mesh_chat` rows.
   */
  transferVoiceSession(
    fromActorId: string,
    targetHandleOrId: string,
    handoffNote?: string
  ): { sessionId: string; targetActorId: string } {
    fromActorId = this.resolveThreadId(fromActorId);
    const source = this.actors.get(fromActorId);
    if (!source || source.status !== "active" || !this.runs.isLive(fromActorId)) {
      throw new Error("source actor is not active");
    }
    const target = this.resolveHeldActiveActor(fromActorId, targetHandleOrId);
    if (target.id === fromActorId) throw new Error("cannot transfer a voice session to itself");
    const transfer = this.voiceSessionTransfer;
    if (!transfer) throw new Error("voice session transfer is unavailable on this instance");
    const inboxStore = this.inboxStore;
    if (!inboxStore) throw new Error("voice session transfer requires a durable inbox");
    if (handoffNote !== undefined && handoffNote.trim().length > MAX_VOICE_TRANSFER_NOTE_CHARS) {
      throw new Error(`handoff note must be at most ${MAX_VOICE_TRANSFER_NOTE_CHARS} characters`);
    }

    // Read and render before rebinding. If the durable context projection is
    // unavailable, no live authority moves and the caller can retry safely.
    const sessionId = transfer.activeSessionIdFor(fromActorId);
    const context = renderVoiceTransferContext(
      this.listVoiceSessionChat?.(sessionId) ?? [],
      handoffNote
    );
    transfer.transferActiveSession(fromActorId, target.id);
    let inserted: InboxEntry[];
    try {
      inserted = inboxStore.append([
        {
          actorId: target.id,
          source: `voice:transfer:${fromActorId}`,
          payload: {
            type: "voice.transfer",
            priority: "responsive",
            fromId: fromActorId,
            sessionId,
            context,
          },
        },
      ]);
      if (inserted.length !== 1) {
        throw new Error("voice session transfer handoff was not durably inserted");
      }
    } catch (error) {
      // Authority moves only after durable context has been rendered, and it
      // moves back if the durable handoff cannot be written. The source is not
      // released until after this point, so a failed write leaves its ordinary
      // work held exactly as it was before the request.
      try {
        transfer.revertActiveSessionTransfer(sessionId, fromActorId, target.id);
      } catch (rollbackError) {
        this.log(
          `voice session transfer rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
      }
      this.voiceTransferLog.error("voice_session_transfer", {
        outcome: "handoff_not_recorded",
        sessionId,
        sourceActorId: fromActorId,
        targetActorId: target.id,
        err: error,
      });
      throw error;
    }
    // The responsive row is now durable; releasing the source through the
    // existing session-end path preserves normal-work deferral semantics.
    this.notifyVoiceSessionEnded(fromActorId);
    if (inserted.length > 0) {
      try {
        this.dispatch(target.id);
      } catch (error) {
        this.log(
          `voice transfer recipient nudge failed after durable handoff: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    // The control is intentionally last: the recipient has durable work before
    // the browser changes selection/reconnects to it.
    try {
      transfer.notifySessionTransferred(sessionId, target.id);
      this.voiceTransferLog.info("voice_session_transfer", {
        outcome: "control_scheduled",
        sessionId,
        sourceActorId: fromActorId,
        targetActorId: target.id,
      });
    } catch (error) {
      // VoiceService records asynchronous leased-SSE dispatch failures itself;
      // retain observability as well for a synchronous transfer-port failure.
      this.voiceTransferLog.warn("voice_session_transfer", {
        outcome: "control_dispatch_failed",
        sessionId,
        sourceActorId: fromActorId,
        targetActorId: target.id,
        err: error,
      });
    }
    return { sessionId, targetActorId: target.id };
  }

  /**
   * The currently leased voice session for an actor, if this host has one.
   * This is intentionally lease-scoped rather than an actor-row capability:
   * a recipient of a transfer may reply during the live handoff without
   * permanently gaining direct-human authority.
   */
  activeVoiceSessionIdFor(actorId: string): string | undefined {
    const transfer = this.voiceSessionTransfer;
    if (!transfer) return undefined;
    try {
      return transfer.activeSessionIdFor(this.resolveThreadId(actorId));
    } catch {
      return undefined;
    }
  }

  /** Resolve an active live actor from the caller's own handle set. */
  private resolveHeldActiveActor(requesterId: string, targetHandleOrId: string): ActorRecord {
    const requested = targetHandleOrId.trim();
    if (!requested) throw new Error("target actor must not be blank");
    const requester = this.actors.get(requesterId);
    if (!requester) throw new Error("source actor not found");

    const normalized = requested.toLowerCase();
    if (requested === requesterId || this.handleForId(requesterId).toLowerCase() === normalized) {
      throw new Error("cannot transfer a voice session to itself");
    }
    const held = requester.handles ?? [];
    const matches = held
      .map((handle) => this.actors.get(handle.id))
      .filter((record): record is ActorRecord =>
        Boolean(
          record &&
            (record.id === requested || this.handleForId(record.id).toLowerCase() === normalized)
        )
      );
    if (matches.length === 0) {
      throw new Error("target actor is not a handle held by the caller");
    }
    if (matches.length > 1) {
      throw new Error(`target actor handle is ambiguous: ${requested}`);
    }
    const target = matches[0];
    if (target.status === "retired") throw new Error("target actor is retired");
    if (!this.runs.isLive(target.id)) throw new Error("target actor is not live");
    return target;
  }

  /**
   * Refuse an execution placement this runtime cannot honour.
   *
   * Called before the spawn id, the record, or the parent's handle exist, so a
   * refused placement leaves nothing behind to clean up — and, more importantly,
   * so a target the runtime does not understand can never fall through to a
   * local Actor. Omitted target still means local; a supplied one means that
   * instance or an error.
   */
  private assertPlacementSupported(executionTarget: string | undefined): void {
    if (executionTarget === undefined) return;
    const target = executionTarget.trim();
    if (target && this.supportsExecutionTarget?.(target)) return;
    throw new Error(
      `executionTarget ${JSON.stringify(executionTarget)} is not available: this runtime has no remote placement support`
    );
  }

  /**
   * Create a child actor (record + live instance) and return its id immediately.
   * Spawning is **not** an implicit message: the child is born idle with an empty
   * inbox and does **not** run. To put it to work, {@link sendMessage} it — that
   * wake is the one and only thing that starts a run. This keeps spawn (bring an
   * actor into existence) and message (give it something to do) as two distinct
   * operations, and is consistent with {@link rehydrate}, which also never wakes.
   */
  spawn(req: SpawnRequest): string {
    const charter = req.charter?.trim();
    if (!charter) throw new Error("charter is required");
    this.assertPlacementSupported(req.executionTarget);
    const modelConfig = this.validateSpawn?.(req) ?? normalizeModelConfigList(req.modelConfig);
    if (modelConfig.length === 0) {
      throw new Error("modelConfig must declare at least one provider/model entry");
    }
    const id = this.idgen();
    const parentId = this.resolveThreadId(req.parentId);
    // Store provenance only when the caller declared a class in modelConfig.
    // The validation gate resolves that reference to this concrete snapshot;
    // an explicit tuple/pool cannot attach an arbitrary class label.
    const modelClass = isModelClassReference(req.modelConfig) ? req.modelConfig.class : undefined;
    const record: ActorRecord = {
      id,
      charter,
      parentId,
      modelConfig,
      ...(modelClass !== undefined ? { modelClass } : {}),
      context: req.context,
      handles: req.handles ? [...req.handles] : undefined,
      // Seed the session so the actor's first run resumes this conversation
      // instead of creating a fresh one (loadSessionId reads record.sessionId).
      sessionId: req.conversationId,
      title: req.title,
      executionTarget: req.executionTarget,
      // Every actor gets its own walkie-talkie voice at birth so a transfer or
      // multi-actor chat is audible as different speakers; the operator can
      // re-pick it from the actor info panel at any time.
      voiceConfig:
        this.supportedVoices.length > 0
          ? structuredClone(
              this.supportedVoices[Math.floor(Math.random() * this.supportedVoices.length)]
                .voiceConfig
            )
          : googleVoiceConfig(randomSupportedVoiceName()),
      status: "active",
      createdAt: this.now(),
    };
    this.actors.upsert(record);
    // Spawning grants the parent a handle to the child, so it can message it.
    // No role — the parent authored the charter, so the child's charter is the
    // truthful label (resolved at prompt time).
    this.grantHandle(parentId, { id });
    let actor: MeshActor;
    try {
      // `record.executionTarget` is `req.executionTarget`, so the placement a
      // spawn asked for reaches the factory through the record like every
      // other construction input.
      actor = this.runs.instantiate(record);
    } catch (err) {
      this.revokeHandle(parentId, id);
      this.actors.patch(id, { status: "retired" });
      throw err;
    }
    this.actorRuntimeStateChanged(id, this.runtimeStateOf(actor));
    void this.lifecycleFor(id).emit("onSpawn", { actorId: id });
    // Genuine-birth side-effect hook (out-of-band, fire-and-forget) — e.g. kick
    // off avatar generation . Guarded like onRetire so a hook throw can
    // never break spawning, and only here (not createActor, which rehydrate
    // shares, nor adopt) so it fires exactly once per real spawn.
    if (this.onSpawn) {
      try {
        this.onSpawn(record);
      } catch (err) {
        this.log(`onSpawn(${id}) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.log(`spawned ${id} (parent ${parentId})`);
    this.recordEvent({
      kind: "actor_spawned",
      actorId: id,
      detail: charter,
      body: `modelConfig=${describeModelConfigPool(modelConfig)}`,
      // TODO: Consider extracting the human or controller principal and storing it in payload.requestedBy
      payload: JSON.stringify({ parentId }),
    });
    return id;
  }

  /**
   * Introduce `handle`'s actor to `toId`'s address book — the parent handing a
   * child a capability to message a peer (e.g. giving a coder the reviewer's
   * handle). Idempotent per id; no-op if `toId` is unknown. Takes effect on the
   * grantee's next wake (its prompt re-renders the address book).
   */
  grantHandle(toId: string, handle: ActorHandle): void {
    toId = this.resolveThreadId(toId);
    handle = { ...handle, id: this.resolveThreadId(handle.id) };
    const rec = this.actors.get(toId);
    if (!rec) return;
    if (handle.id === toId) return; // don't hand an actor its own handle
    const entry: ActorHandle = handle.role
      ? { id: handle.id, role: handle.role }
      : { id: handle.id };
    const handles = (rec.handles ?? []).filter((h) => h.id !== handle.id);
    handles.push(entry);
    this.actors.patch(toId, { handles });
    this.recordEvent({
      kind: "handle_granted",
      actorId: toId,
      detail: entry.role,
      // TODO: Consider threading through the grantor and storing it in payload.grantorId
      payload: JSON.stringify({ handleId: handle.id }),
    });
  }

  /**
   * Remove `targetId` from `toId`'s address book. Idempotent; no-op if `toId` is
   * unknown or does not hold a handle to `targetId`. Takes effect on the actor's
   * next wake.
   */
  revokeHandle(toId: string, targetId: string): void {
    toId = this.resolveThreadId(toId);
    targetId = this.resolveThreadId(targetId);
    const rec = this.actors.get(toId);
    if (!rec) return;
    const current = rec.handles ?? [];
    const handles = current.filter((h) => h.id !== targetId);
    if (handles.length === current.length) return;
    this.actors.patch(toId, { handles });
  }

  /**
   * Whether `actorId` currently holds `capability` as an active grant (#549).
   * This is the only source of administrative authority: a parentless record,
   * the `isRoot` flag, and the literal `root` address confer nothing on their
   * own. Fail-closed — an unknown or unaddressed actor holds nothing.
   */
  hasActiveCapability(actorId: string | undefined, capability: string): boolean {
    if (!actorId) return false;
    return this.grants.activeFor(this.resolveThreadId(actorId)).includes(capability);
  }

  /** Resolve the legacy root address without making the literal id an authority signal. */
  private resolveThreadId(actorId: string): string {
    return actorId === "root" && this.rootId ? this.rootId : actorId;
  }

  /**
   * Grantor authorization for {@link grantCapability}/{@link revokeCapability}.
   * A `capability-admin` holder may grant/revoke anything grantable within its
   * own subtree (itself included); a host-global capability is refused before
   * this runs, for every grantor. Any other grantor may only touch
   * capabilities in {@link PARENT_GRANTABLE_CAPABILITIES} and only where the
   * grantee is its DIRECT child (the repository's `parentId` edge). Enforced
   * HERE — the mesh layer — not just at the tool layer, so the invariant holds
   * for any future caller. Fail-closed: an unknown grantor holds nothing.
   */
  private assertGrantAuthority(
    grantorId: string,
    granteeId: string,
    capability: string,
    verb: "grant" | "revoke"
  ): void {
    const grantee = this.actors.get(granteeId);
    if (!grantee) {
      throw new Error(`unknown thread id: ${granteeId}`);
    }
    if (this.hasActiveCapability(grantorId, CAPABILITY_ADMIN_CAPABILITY)) {
      if (!this.isAncestorOf(grantorId, granteeId)) {
        throw new Error(
          `${grantorId} may only ${verb} capabilities in its own subtree (cannot ${verb} ${granteeId})`
        );
      }
      return;
    }
    let baseCapability = capability;
    if (capability.startsWith("chat-write:")) {
      baseCapability = "chat-write";
    } else if (capability.startsWith("calendar-read:")) {
      baseCapability = "calendar-read";
    } else if (capability.startsWith("calendar-write:")) {
      baseCapability = "calendar-write";
    } else if (capability.startsWith("email-send:")) {
      baseCapability = "email-send";
    } else if (capability.startsWith("drive-read:")) {
      baseCapability = "drive-read";
    }
    // Secret capabilities are deliberately NOT reduced to their `secret` base
    // here: a non-root parent may delegate only the exact
    // `secret:<filename>` names in the allow-list (#542 security review), so a
    // guessed infrastructure filename never rides through on the prefix.
    if (!PARENT_GRANTABLE_CAPABILITIES.has(baseCapability)) {
      throw new Error(
        `only a ${CAPABILITY_ADMIN_CAPABILITY} holder may ${verb} ${capability}; a parent without it may only ${verb}: ${
          [...PARENT_GRANTABLE_CAPABILITIES].join(", ") || "none"
        }`
      );
    }
    if (grantee.parentId !== grantorId) {
      throw new Error(
        `without ${CAPABILITY_ADMIN_CAPABILITY}, an actor may only ${verb} ${capability} to/from its direct children; ${granteeId} is not a child of ${grantorId}`
      );
    }
  }

  /**
   * Grant an extra `capability` to a specific actor by id (ISSUE_NUM, phase 1a).
   * We enforce the allow-list so the primitive can never hand out a capability
   * the wiring didn't mark grantable, plus grantor authorization: a
   * `capability-admin` holder may grant anything grantable in its subtree; any
   * other grantor only a {@link PARENT_GRANTABLE_CAPABILITIES} capability, and
   * only to its direct children. Idempotent per (actorId, capability). MCP-server grants take effect
   * on a live actor's next run; secrets are rebound by its next sandboxed run.
   * Throws if the capability isn't grantable or the grantor lacks authority.
   */
  grantCapability(actorId: string, capability: string, grantedBy: string): void {
    actorId = this.resolveThreadId(actorId);
    grantedBy = this.resolveThreadId(grantedBy);
    if (!actorId.trim()) throw new Error("actorId is required");
    let baseCapability = capability;
    if (capability.startsWith("chat-write:")) {
      baseCapability = "chat-write";
    } else if (capability.startsWith("calendar-read:")) {
      baseCapability = "calendar-read";
    } else if (capability.startsWith("calendar-write:")) {
      baseCapability = "calendar-write";
    } else if (capability.startsWith("email-send:")) {
      baseCapability = "email-send";
    } else if (capability.startsWith("drive-read:")) {
      baseCapability = "drive-read";
    } else if (capability.startsWith("secret:")) {
      baseCapability = "secret";
    }
    if (capability === "chat-write" || capability === "chat-write:") {
      throw new Error(
        `bare chat-write grant is not allowed; must specify a space (e.g. chat-write:spaces/AAAA)`
      );
    }
    if (capability === "calendar-read" || capability === "calendar-read:") {
      throw new Error(
        `bare calendar-read grant is not allowed; must specify a calendar ID or account email`
      );
    }
    if (capability === "calendar-read:account:") {
      throw new Error(`calendar-read grant must specify an account email`);
    }
    if (capability === "calendar-write" || capability === "calendar-write:") {
      throw new Error(`bare calendar-write grant is not allowed; must specify a calendar ID`);
    }
    if (capability === "email-send" || capability === "email-send:") {
      throw new Error(
        `bare email-send grant is not allowed; must specify a recipient (e.g. email-send:person@example.com)`
      );
    }
    if (capability === "secret" || capability === "secret:") {
      throw new Error(
        `bare secret grant is not allowed; must specify a secret filename (e.g. secret:gemini-api-key)`
      );
    }
    // A host-global capability (`update`, `pnpm-hardlinks`, `model-admin`)
    // acts on the whole daemon, so no subtree bound can contain a grant of it:
    // refused for every grantor, the grantee itself included — the self-grant
    // is exactly how a delegated capability-admin holder would otherwise widen
    // into host authority. Only the bootstrap seed creates such a row (#549).
    if (HOST_GLOBAL_CAPABILITIES.has(capability)) {
      throw new Error(
        `${capability} is host-global and is never granted through the mesh; only the bootstrap seed creates it, and a revocation is one-way`
      );
    }
    // One rule: the BASE must be grantable (`secret` for every `secret:<file>`).
    // Per-name authority — which secret files a non-root parent may delegate —
    // lives in assertGrantAuthority, not here.
    if (!this.grantable.has(baseCapability)) {
      throw new Error(
        `not a grantable capability: ${capability} (grantable: ${[...this.grantable].join(", ") || "none"})`
      );
    }
    this.assertGrantAuthority(grantedBy, actorId, capability, "grant");
    if (baseCapability === "secret") {
      const secretFilename = capability.slice("secret:".length);
      assertSecretContainment(secretFilename, this.secretsDir);
    }
    this.grants.grant({ actorId, capability, grantedBy, grantedAt: this.now() });
    this.recordEvent({
      kind: "capability_granted",
      actorId,
      detail: capability,
      payload: JSON.stringify({ grantedBy }),
    });
    if (this.onCapabilityGranted) {
      try {
        this.onCapabilityGranted(actorId, capability);
      } catch (err) {
        this.log(`onCapabilityGranted failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Revoke a previously-granted `capability` from `actorId`, subject to the same
   * grantor authorization as {@link grantCapability}: a `capability-admin`
   * holder revokes anything in its subtree; any other `revokedBy` only a
   * parent-grantable capability from a direct child. No-op on the store if not active, but the unmount hook still
   * fires so a stale mounted endpoint is torn down idempotently. Revocation takes
   * effect immediately via {@link ActorMeshOptions.onCapabilityRevoked} (the
   * wiring unmounts the granted endpoint → a 404), not only at the actor's next
   * reconstruction; a granted secret disappears at the actor's next spawn.
   */
  async revokeCapability(actorId: string, capability: string, revokedBy: string): Promise<void> {
    actorId = this.resolveThreadId(actorId);
    revokedBy = this.resolveThreadId(revokedBy);
    this.assertGrantAuthority(revokedBy, actorId, capability, "revoke");
    this.grants.revoke(actorId, capability, this.now());
    this.recordEvent({ kind: "capability_revoked", actorId, detail: capability });
    if (this.onCapabilityRevoked) {
      try {
        await this.onCapabilityRevoked(actorId, capability);
      } catch (err) {
        this.log(`onCapabilityRevoked failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Enroll an actor in a hard-coded experiment (#394) — the rollout primitive
   * that keeps "try this on a few actors first" from becoming a permanent
   * column on `actors`.
   *
   * Authorized by the `experiment-admin` capability over the caller's own
   * subtree (see {@link assertExperimentAuthority}). Enrollment is strictly post-spawn — the actor must
   * already exist — and a retired actor is refused, matching
   * {@link setActorModel}: enrolling a thread that is not going to run again
   * records an intent nothing will ever read.
   *
   * Idempotent: `changed` is true when this call actually enrolled the actor,
   * false when it was already enrolled; `actorId` is the canonical thread id
   * the enrollment is keyed on (a legacy `"root"` address resolves), so a
   * caller can correlate the response with {@link listExperimentEnrollments}.
   * Only a real change records an event. Throws if the experiment is not
   * registered, the actor is unknown or retired, or the caller lacks authority.
   */
  enrollActorInExperiment(
    actorId: string,
    experiment: string,
    enrolledBy: string
  ): ExperimentEnrollmentChange {
    actorId = this.resolveThreadId(actorId);
    enrolledBy = this.resolveThreadId(enrolledBy);
    const name = assertKnownExperiment(experiment);
    const record = this.assertExperimentAuthority(enrolledBy, actorId, "enroll");
    if (record.status === "retired") {
      throw new Error(`Cannot enroll a retired thread: ${actorId}`);
    }
    const enrollment: ExperimentEnrollment = {
      actorId,
      experiment: name,
      enrolledBy,
      enrolledAt: this.now(),
    };
    if (!this.experiments.enroll(enrollment)) return { actorId, changed: false };
    this.recordEvent({
      kind: "experiment_enrolled",
      actorId,
      detail: name,
      payload: JSON.stringify({ enrolledBy }),
    });
    return { actorId, changed: true };
  }

  /**
   * Remove an actor's enrollment, subject to the same `experiment-admin`
   * authority as {@link enrollActorInExperiment}. Idempotent: `changed` is true when a real
   * enrollment was removed, false when there was nothing to remove, and only a
   * real change records an event.
   *
   * A retired actor may be unenrolled, deliberately unlike enrollment. An
   * enrollment outlives retirement so a revived actor resumes the rollout it
   * was in; withdrawing a rollout from a retired actor must therefore not
   * require reviving it first.
   *
   * Similarly, unenrollment does not require the experiment to still be
   * registered in code: if an experiment was removed from the registry, any
   * lingering durable rows can still be cleanly unenrolled via this path
   * without requiring manual SQL. The event's `detail` is then the stored
   * name, which no consumer checks against the registry.
   */
  unenrollActorFromExperiment(
    actorId: string,
    experiment: string,
    unenrolledBy: string
  ): ExperimentEnrollmentChange {
    actorId = this.resolveThreadId(actorId);
    unenrolledBy = this.resolveThreadId(unenrolledBy);
    this.assertExperimentAuthority(unenrolledBy, actorId, "unenroll");
    if (!this.experiments.unenroll(actorId, experiment)) return { actorId, changed: false };
    this.recordEvent({
      kind: "experiment_unenrolled",
      actorId,
      detail: experiment,
      payload: JSON.stringify({ unenrolledBy }),
    });
    return { actorId, changed: true };
  }

  /**
   * The runtime evaluation API: is this actor in this experiment right now?
   * Read straight through to the durable store, so an enrollment made by
   * another connection takes effect without a restart.
   *
   * An unregistered name answers false rather than throwing. That is not
   * leniency: a name outside the registry can never have been enrolled, so
   * false is the only correct answer, and a call site deciding behavior should
   * not have to guard against its own registry constant.
   */
  isEnrolledInExperiment(actorId: string, experiment: string): boolean {
    if (!isKnownExperiment(experiment)) return false;
    return this.experiments.isEnrolled(this.resolveThreadId(actorId), experiment);
  }

  /** Every current enrollment in (actorId, experiment) order — the administrator's readback view. */
  listExperimentEnrollments(actorId?: string): ExperimentEnrollment[] {
    const enrollments = this.experiments.list();
    if (!actorId) return enrollments;
    const targetId = this.resolveThreadId(actorId);
    return enrollments.filter((enrollment) => enrollment.actorId === targetId);
  }

  /**
   * Authority for experiment administration (#394, #549): an `experiment-admin`
   * holder, over its own subtree (itself included), and only for an actor that
   * exists. Fail-closed — an unknown caller holds nothing — and enforced HERE
   * rather than only at the tool layer, so the boundary holds for any future
   * caller. Returns the target's record, which both callers need next.
   */
  private assertExperimentAuthority(
    callerId: string,
    actorId: string,
    verb: "enroll" | "unenroll"
  ): ActorRecord {
    const preposition = verb === "enroll" ? "in" : "from";
    if (!this.hasActiveCapability(callerId, EXPERIMENT_ADMIN_CAPABILITY)) {
      throw new Error(
        `only an ${EXPERIMENT_ADMIN_CAPABILITY} holder may ${verb} an actor ${preposition} an experiment`
      );
    }
    const record = this.actors.get(actorId);
    if (!record) {
      throw new Error(`unknown thread id: ${actorId}`);
    }
    // Holding the capability is not reach: another top-level tree is a legal
    // shape this holder must not administer. `isAncestorOf` admits the holder itself.
    if (!this.isAncestorOf(callerId, actorId)) {
      throw new Error(
        `${callerId} may only ${verb} actors in its own subtree ${preposition} an experiment (cannot ${verb} ${actorId})`
      );
    }
    return record;
  }

  /** Every grant, active and revoked — for the `list_grants` tool + audit. */
  listGrants(): ReturnType<CapabilityGrantStore["list"]> {
    return this.grants.list();
  }

  /**
   * The capabilities currently active for an actor — consulted by the wiring when
   * building an actor's MCP set, to mount the granted servers on top of the
   * default worker set.
   */
  activeCapabilitiesFor(actorId: string | undefined): string[] {
    return actorId ? this.grants.activeFor(this.resolveThreadId(actorId)) : [];
  }

  private activeSubscriptionHeldBy(actorId: string, resource: EventResource): boolean {
    return this.eventSourceOwners
      .activeForResource(resource)
      .some((subscription) => subscription.actorId === actorId);
  }

  /**
   * The one routing kernel, read off the single event seam. There is no setter
   * and no fallback construction: if the host assembled a manager, its ladder
   * is the mesh's ladder by identity.
   */
  private get routing(): EventRoutingKernel | undefined {
    return this.eventManager?.routing;
  }

  /**
   * The live **owner** destinations for an event, walking the ownership ladder:
   * a live obligation claiming the source, then an explicit ownership row, then
   * (for bubble-eligible event classes) the same two questions of the parent
   * resource.
   *
   * Ownership only. Direct subscribers are resolved and merged by
   * {@link HierarchicalEventSourceResolver.resolveRecipients}, never here —
   * this function is also what {@link effectiveOwnerOf} answers with, so a
   * subscriber appearing in its result would let anyone who subscribed to a
   * source delegate or reclaim it.
   */
  /**
   * Resolve effective event routing decision and diagnostic for an event resource (#369).
   * Single-sources the hierarchy traversal, obligation precedence, exact-resource ignoring,
   * liveness check, and parent bubbling across delivery, delegation guards, and audit inspection.
   *
   * Note: Bubbling policy is enforced only when `opts.enforceBubblingPolicy` is true (for event
   * delivery in {@link deliverExternalEvent}); delegation guards and audit inspection walk
   * ancestors unconditionally to determine governing authority.
   */
  private resolveRoutingDecision(
    resource: EventResource,
    opts: {
      ignoreExactResource?: EventResource;
      eventPayload?: InboxPayload;
      enforceBubblingPolicy?: boolean;
      /** A precomputed exact-resource lookup; `null` means it found no claim. */
      exactObligationOwner?: string | null;
    } = {}
  ): { diagnostic: EffectiveRouteDiagnostic; destinations: string[] } {
    const routing = this.routing;
    if (!routing) {
      throw new Error("Event routing requires a host-assembled EventManager");
    }
    const decision = routing.resolveOwner(resource, opts);
    return { diagnostic: decision.diagnostic, destinations: decision.ownerIds };
  }

  /**
   * The live **owner** destinations for an event, walking the ownership ladder:
   * a live obligation claiming the source, then an explicit ownership row, then
   * (for bubble-eligible event classes) the same two questions of the parent
   * resource.
   *
   * Ownership only. Direct subscribers are resolved and merged by
   * {@link HierarchicalEventSourceResolver.resolveRecipients}, never here —
   * this function is also what {@link effectiveOwnerOf} answers with, so a
   * subscriber appearing in its result would let anyone who subscribed to a
   * source delegate or reclaim it.
   */
  private resolveLiveOwnerDestinations(
    resource: EventResource,
    opts: {
      ignoreExactResource?: EventResource;
      eventPayload?: InboxPayload;
      enforceBubblingPolicy?: boolean;
      /** A precomputed exact-resource lookup; `null` means it found no claim. */
      exactObligationOwner?: string | null;
    } = {}
  ): string[] {
    return this.resolveRoutingDecision(resource, opts).destinations;
  }

  private effectiveOwnerOf(
    resource: EventResource,
    opts: { ignoreExactResource?: EventResource } = {}
  ): string | undefined {
    return this.resolveLiveOwnerDestinations(resource, opts)[0];
  }

  /**
   * Subscribe an actor to an event source. Records an audit event.
   * Throws if another actor is already actively subscribed to the event source.
   */
  subscribeEventSource(resource: EventResource, actorId: string, subscribedBy: string): void {
    actorId = this.resolveThreadId(actorId);
    subscribedBy = this.resolveThreadId(subscribedBy);
    const subscription: EventSourceOwnership = {
      resource: resourceKey(resource),
      actorId,
      subscribedBy,
      subscribedAt: this.now(),
    };
    this.eventSourceOwners.subscribe(subscription);
    this.recordEvent({
      kind: "event_source_subscribed",
      actorId,
      detail: resourceKey(resource),
      payload: JSON.stringify({ subscribedBy }),
    });
  }

  delegateEventSource(resource: EventResource, childThreadId: string, delegatedBy: string): void {
    childThreadId = this.resolveThreadId(childThreadId);
    delegatedBy = this.resolveThreadId(delegatedBy);
    const child = this.actors.get(childThreadId);
    if (!child) {
      throw new Error(`cannot delegate to unknown thread: ${childThreadId}`);
    }
    if (child.status !== "active") {
      throw new Error(
        `cannot delegate to non-active thread: ${childThreadId} (status: ${child.status})`
      );
    }

    if (childThreadId === delegatedBy) {
      if (this.effectiveOwnerOf(resource, { ignoreExactResource: resource }) !== delegatedBy) {
        throw new Error(
          "cannot self-delegate a resource unless it is a strict descendant of an already-owned parent"
        );
      }
    }

    if (this.effectiveOwnerOf(resource) !== delegatedBy) {
      throw new Error(
        `cannot delegate ${resourceKey(resource)}: caller is not the current effective owner`
      );
    }

    // Additive creator subscriptions are delivery-only and do not confer
    // ownership; only an independently effective ancestor owner may delegate
    // when no exact ownership is held. If the delegator holds an exact active
    // ownership claim it is handing off, release it first (mirroring
    // reclaimEventSource) so the store's one-active-subscriber invariant
    // admits the child.
    if (this.activeSubscriptionHeldBy(delegatedBy, resource)) {
      this.unsubscribeEventSource(resource, delegatedBy, this.now());
    }

    this.subscribeEventSource(resource, childThreadId, delegatedBy);
  }

  /**
   * Reclaim an exact delegated event source, pointing it back at the caller when
   * the caller would be the effective owner after that exact delegation is removed.
   */
  reclaimEventSource(resource: EventResource, reclaimedBy: string): void {
    reclaimedBy = this.resolveThreadId(reclaimedBy);
    if (this.activeSubscriptionHeldBy(reclaimedBy, resource)) {
      return;
    }

    const current = this.eventSourceOwners.activeForResource(resource)[0];
    if (!current) {
      throw new Error(`cannot reclaim ${resourceKey(resource)}: no active subscription`);
    }

    if (this.effectiveOwnerOf(resource, { ignoreExactResource: resource }) !== reclaimedBy) {
      throw new Error(
        `cannot reclaim ${resourceKey(resource)}: caller is not the effective owner after reclaim`
      );
    }

    const at = this.now();
    this.unsubscribeEventSource(resource, current.actorId, at);
    this.subscribeEventSource(resource, reclaimedBy, reclaimedBy);
  }

  /**
   * Unsubscribe an actor from an event source. Records an audit event.
   */
  unsubscribeEventSource(resource: EventResource, actorId: string, at: string): void {
    actorId = this.resolveThreadId(actorId);
    this.eventSourceOwners.unsubscribe(resource, actorId, at);
    this.recordEvent({
      kind: "event_source_unsubscribed",
      actorId,
      detail: resourceKey(resource),
      body: `at=${at}`,
    });
  }

  /**
   * List all ownership claims (both active and released) for audit.
   */
  listSubscriptions(): EventSourceOwnership[] {
    return this.eventSourceOwners.list();
  }

  /**
   * Resolve effective event routing authority for a canonical resource (#369).
   *
   * Answers ownership and delegation authority via an unconditional ancestor walk,
   * reconciling the precedence rule used by delegation guards (e.g. {@link delegateEventSource}):
   * a live obligation claim at any rung of the resource hierarchy outranks
   * stored subscriptions at that rung or higher rungs. Stored subscriptions
   * fall back to most-specific-live-subscriber-wins with parent bubbling.
   *
   * Note: This walk is unconditional for authority inspection. A reported
   * ancestor-level route is only deliverable by {@link deliverExternalEvent} for
   * bubble-eligible event classes; non-bubbling event classes are exact-only.
   * Direct subscriptions are delivery-only and never confer ownership.
   */
  resolveEffectiveRoute(
    resource: EventResource,
    opts: { ignoreExactResource?: EventResource } = {}
  ): EffectiveRouteDiagnostic {
    const canonical = resourceKey(resource);
    return this.resolveRoutingDecision(canonical, opts).diagnostic;
  }

  /**
   * Add a direct subscriber to an event source. Records an audit event.
   *
   * Unlike {@link subscribeEventSource} this takes no ownership and refuses
   * nothing on contention: many actors may subscribe to one source, and a
   * subscription neither displaces the owner nor competes for the source.
   *
   * It does refuse a resource outside {@link ActorMeshOptions.configuredEventSources},
   * so subscribing cannot widen this instance past the scope `config.yaml`
   * declares. `reconcileEventSourceSubscriptions` re-applies the same rule to
   * durable rows at every boot, for the case where the config narrows later.
   */
  addEventSourceSubscriber(resource: EventResource, actorId: string, subscribedBy: string): void {
    actorId = this.resolveThreadId(actorId);
    subscribedBy = this.resolveThreadId(subscribedBy);
    if (!this.actors.get(actorId)) {
      throw new Error(`cannot subscribe unknown thread: ${actorId}`);
    }
    if (
      this.configuredEventSources &&
      !this.configuredEventSources.some((configured) => isSubResourceOf(resource, configured))
    ) {
      throw new Error(
        `cannot subscribe to ${resourceKey(resource)}: not anchored in a configured event source`
      );
    }
    this.eventSourceSubscriptions.subscribe({
      resource: resourceKey(resource),
      actorId,
      subscribedBy,
      subscribedAt: this.now(),
    });
    this.recordEvent({
      kind: "event_source_subscriber_added",
      actorId,
      detail: resourceKey(resource),
      payload: JSON.stringify({ subscribedBy }),
    });
  }

  /**
   * Remove a direct subscriber from an event source. Records an audit event
   * naming who removed it.
   *
   * The holder may always drop its own subscription. An ancestor may drop a
   * descendant's, and nobody else may: this is the parent-side exit the
   * retirement guard (#540) needs, because every actor that opens a PR or
   * issue is mechanically subscribed to it, and a holder that has wedged will
   * never unsubscribe itself. Ancestor scope is the same authority that
   * retires the holder, so whoever can retire a subtree can also dispose of
   * what blocks that retirement — explicitly, by naming the resource and the
   * holder, never as a side effect of `retire()` or of any flag.
   */
  removeEventSourceSubscriber(
    resource: EventResource,
    actorId: string,
    removedBy: string = actorId
  ): void {
    actorId = this.resolveThreadId(actorId);
    removedBy = this.resolveThreadId(removedBy);
    if (removedBy !== actorId && !this.isAncestorOf(removedBy, actorId)) {
      throw new Error(
        `actor ${removedBy} may only unsubscribe itself or its descendants from ` +
          `${resourceKey(resource)} (cannot unsubscribe ${actorId})`
      );
    }
    this.eventSourceSubscriptions.unsubscribe(resource, actorId);
    this.recordEvent({
      kind: "event_source_subscriber_removed",
      actorId,
      detail: resourceKey(resource),
      payload: JSON.stringify({ removedBy }),
    });
  }

  /** Every direct subscription — the audit/inspection view. */
  listEventSourceSubscriptions(): EventSourceSubscription[] {
    return this.eventSourceSubscriptions.list();
  }

  /**
   * The one way an event enters the mesh. The host's three ingress paths —
   * GitHub, Chat, and timer — arrive with an explicit raw source shape;
   * EventManager owns normalize → route → append, and Mesh owns the
   * after-commit wake until #384 extracts that notification seam.
   *
   * #393 collapsed the transitional `deliverEvent` into this method: routing,
   * source canonicalization, author suppression, durable append, and
   * owners-then-subscribers ordering now have one implementation, and the
   * characterization suite enters where production enters.
   *
   * That collapse also dropped a capability rather than only a duplicate:
   * `deliverEvent` without an `inboxPayload` could route, suppress, and wake
   * with no inbox row behind the wake. Delivery now always leaves a durable
   * row, and a notification without one is not expressible — which is the
   * point, because a woken actor that restarts before it reads finds nothing
   * to work from. Nothing replaces that shape: {@link deliverWake}, the other
   * way to reach a live actor, records its own durable row too.
   *
   * CRITICAL: the body runs to completion in one turn. No `await` may appear
   * between recipient resolution and the wake — the manager's
   * normalize/route/append is synchronous for exactly this reason, and this
   * method stays async only for its public contract. Yield anywhere in here
   * and an actor can retire after being resolved as live, leaving a durable
   * unhandled row with nobody alive to take it. `actor-mesh.test.ts` pins this
   * with a retirement queued as a microtask before the call.
   */
  async deliverExternalEvent(raw: RawIntegrationEvent): Promise<DurableEventDelivery> {
    if (!this.eventManager) {
      throw new Error("External event delivery requires a host-assembled EventManager");
    }
    const delivery = this.eventManager.handleExternalEvent(raw);
    this.notifyPersistedInboxEntries(delivery);
    // Returned so a host-level alarm can tell an uncovered drop from a delivery
    // and fall back to its own channel rather than trusting mesh routing (#481).
    return delivery;
  }

  /**
   * Every persisted copy is just as durable and just as responsive for
   * scheduling; which recipient's run may be replaced is decided by
   * {@link dispatchJoiningActiveRun}. A subscriber-only route preempts nobody.
   */
  private notifyPersistedInboxEntries(delivery: DurableEventDelivery): void {
    for (const entry of delivery.entries) {
      const dest = entry.actorId;
      const isOwner = delivery.ownerIds.includes(dest);
      const dispatched = isOwner ? this.dispatch(dest) : this.dispatchJoiningActiveRun(dest);
      if (!dispatched) {
        throw new Error(`Delivery target ${dest} is not live after inbox persistence`);
      }
    }
  }

  /** A narrow live-actor read port for the host-assembled routing kernel. */
  isLiveActor(actorId: string): boolean {
    return this.runs.isLive(actorId);
  }

  /** A narrow handle/id resolution port for directed delivery. */
  resolveLiveActorId(handleOrId: string): { id: string } | undefined {
    return this.resolveLiveActor(handleOrId);
  }

  private resolveLiveActor(handleOrId: string): MeshActor | undefined {
    handleOrId = this.resolveThreadId(handleOrId);
    const actor = this.runs.liveActor(handleOrId);
    if (actor) return actor;

    for (const [id, candidate] of this.runs.liveEntries()) {
      if (this.handleForId(id) === handleOrId) return candidate;
    }
    return undefined;
  }

  /**
   * Deliver a message to a thread's inbox. Actor→actor only; the human↔root edge
   * is handled by the wiring (chat/webhook), not here. Async by design.
   */
  sendMessage(
    toId: string,
    body: string,
    fromId: string,
    sessionId?: string,
    deliverAt?: string
  ): MessageDeliveryResult {
    toId = this.resolveThreadId(toId);
    fromId = this.resolveThreadId(fromId);
    if (
      isHumanOperator(fromId) ||
      (this.principals !== undefined && this.principals.getUser(fromId) !== undefined)
    ) {
      throw new Error(
        "Invalid sender ID: actor-facing send path structurally cannot claim human origin"
      );
    }

    if (fromId === toId && !deliverAt) {
      throw new Error(
        "Immediate self-sends are not supported. Use deliver_at for a scheduled wake."
      );
    }

    if (deliverAt) {
      const ms = new Date(deliverAt).getTime();
      if (Number.isNaN(ms)) throw new Error(`Invalid deliverAt timestamp: ${deliverAt}`);
      const delay = ms - Date.now();
      if (delay < 0) throw new Error(`deliver_at must be in the future, got delay=${delay}ms`);
      if (fromId === toId && delay < 60000) {
        throw new Error(
          `Self-send requires a strictly-future deliver_at (minimum 60s delay), got delay=${delay}ms`
        );
      }
      if (delay > 2073600000) {
        // 24 days
        throw new Error(`deliver_at beyond max horizon (24 days), got delay=${delay}ms`);
      }
      const rec = this.actors.get(toId);
      if (!rec || rec.status !== "active") {
        return { delivered: false, status: rec?.status };
      }
      if (!this.scheduledMessages) {
        throw new Error("Scheduled-message OS scheduler is not configured");
      }
      if (
        this.scheduledMessages.listMessageDeliveries().filter((message) => message.toId === toId)
          .length >= 10
      ) {
        throw new Error(
          `Cannot schedule message: recipient ${toId} has reached the cap of 10 pending deliveries.`
        );
      }

      const pending: ScheduledMessage = {
        id: randomUUID(),
        toId,
        fromId,
        body,
        deliverAt,
        sessionId,
      };
      this.scheduledMessages.scheduleMessageDelivery(pending);
      try {
        this.withTransaction(() => this.recordScheduledMessageSent(pending));
      } catch (error) {
        try {
          this.scheduledMessages.cancelMessageDelivery(pending.id);
        } catch (cancelError) {
          this.log(
            `failed to roll back scheduled message ${pending.id}: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`
          );
        }
        throw error;
      }
      return { delivered: true };
    }

    const rec = this.actors.get(toId);
    if (!rec || rec.status !== "active") {
      this.log(`message to ${toId} from ${fromId} dropped — recipient not active`);
      return { delivered: false, status: rec?.status };
    }

    const target = this.runs.liveActor(toId);
    const messageId = this.recordMessageEmitted({
      fromId,
      toId,
      body,
      sessionId,
      isDrop: !target,
    });
    if (!target) {
      this.log(`message to ${toId} from ${fromId} dropped — no live actor`);
      return { delivered: false, status: this.actors.get(toId)?.status };
    }
    if (this.inboxStore) {
      if (!messageId) throw new Error("Actor message delivery requires durable chat storage");
      this.inboxStore.append([
        {
          actorId: toId,
          source: `mesh:${fromId}`,
          payload: { type: "mesh.message", messageId, fromId, sessionId },
        },
      ]);
    }
    this.dispatch(toId);
    return { delivered: true };
  }

  deliverMechanicalInboxNotice(
    toId: string,
    note: string,
    fromId: string,
    forensics: MechanicalInboxForensics = {},
    id?: string
  ): MessageDeliveryResult {
    if (!this.inboxStore) throw new Error("Mechanical inbox delivery requires an inbox store");
    toId = this.resolveThreadId(toId);
    fromId = this.resolveThreadId(fromId);
    const rec = this.actors.get(toId);
    if (!rec || rec.status !== "active") {
      this.log(`mechanical inbox notice to ${toId} from ${fromId} dropped — no active actor`);
      return { delivered: false, status: rec?.status };
    }

    // ISSUE_NUM: a mechanical notice (yield / run-failure / scheduled-drop) is NOT
    // a mesh message and must never surface in the root⇄child conversation. We
    // store the human-readable note INLINE in the inbox payload and record NO
    // mesh_chat row and NO message_sent/received events. The canonical run
    // record already lives in the run subsystem (declareYield emits
    // `run_yielded` with the note as its body); `forensics.runId` carries the
    // pointer back to that run item. Regressed 07-26  by minting the
    // note via recordChat; this restores the 2833bde29 inline-note form.
    const inserted = this.inboxStore.append([
      {
        id,
        actorId: toId,
        source: `mesh:mechanical:${fromId}`,
        payload: {
          type: "mesh.mechanical_note",
          note,
          ...forensics,
          fromId,
        },
      },
    ]);
    if (inserted.length === 0) return { delivered: true };
    this.dispatch(toId);
    return { delivered: true };
  }

  /**
   * Deliver a message to a thread's inbox originating from a human operator.
   * Stamped only at the dashboard API ingress.
   */
  sendHumanMessage(
    toId: string,
    body: string,
    sessionId: string,
    opts?: { voice?: boolean; fromId?: string }
  ): MessageDeliveryResult {
    toId = this.resolveThreadId(toId);
    const fromId = opts?.fromId ?? HUMAN_OPERATOR;
    const rec = this.actors.get(toId);
    if (!rec || rec.status !== "active") {
      this.log(`message to ${toId} from ${fromId} dropped — recipient not active`);
      return { delivered: false, status: rec?.status };
    }
    this.actors.patch(toId, {
      humanUnlocked: true,
      lastChatSessionId: sessionId,
      lastChatPrincipalId: fromId,
    });
    const target = this.runs.liveActor(toId);
    const messageId = this.recordMessageEmitted({
      fromId,
      toId,
      body,
      sessionId,
      isDrop: !target,
    });
    if (!target) {
      this.log(`message to ${toId} from ${fromId} dropped — no live actor`);
      return { delivered: false, status: this.actors.get(toId)?.status };
    }
    const isVoice = opts?.voice || body.startsWith("🎙️ [voice memo");
    if (this.inboxStore) {
      if (!messageId) throw new Error("Human message delivery requires durable chat storage");
      this.inboxStore.append([
        {
          actorId: toId,
          source: `mesh:${fromId}`,
          payload: {
            type: isVoice ? VOICE_INBOX_PAYLOAD_TYPE : "human.message",
            priority: "responsive",
            messageId,
            fromId,
            sessionId,
          },
        },
      ]);
    }
    this.dispatch(toId);
    return { delivered: true };
  }

  /**
   * Deliver a mechanical wake to an actor's inbox — the cron-backed nightly
   * trigger (ISSUE_NUM, phase 1c). The wake endpoint calls this when a cron job fires;
   * timing and durability live in cron, so this is purely stateless delivery. The
   * wake is audited as a `scheduled_wake` mesh_event and, when the actor is live,
   * delivered as a durable chat row referenced by the actor inbox. Returns whether
   * the actor was live, so the endpoint can answer 200 (delivered) vs 404 (no live
   * actor). At-least-once by nature → the nightly distill must be idempotent.
   */
  deliverWake(actorId: string, reason: string, priority?: "normal" | "responsive"): boolean {
    const rawActorId = actorId;
    const colonIdx = actorId.indexOf(":");
    const baseActorId = colonIdx >= 0 ? actorId.slice(0, colonIdx) : actorId;
    const resolvedId = this.resolveThreadId(baseActorId);
    const rec = this.actors.get(resolvedId);
    const isLive = Boolean(rec && rec.status === "active" && this.runs.isLive(resolvedId));
    const target = isLive ? this.runs.liveActor(resolvedId) : undefined;
    const isResponsive = priority === "responsive";
    const messageId = target
      ? this.recordMessageEmitted({
          fromId: SCHEDULER_SENDER_ID,
          toId: resolvedId,
          body: reason,
          isDrop: false,
        })
      : undefined;
    this.recordEvent({
      kind: "scheduled_wake",
      actorId: resolvedId,
      detail: target ? undefined : DROPPED_MESSAGE_DETAIL,
      payload: JSON.stringify({
        from: SCHEDULER_SENDER_ID,
        ...(colonIdx >= 0 ? { slot: rawActorId } : {}),
        ...(messageId ? { messageId } : {}),
        ...(isResponsive ? { priority: "responsive" } : {}),
      }),
    });
    if (!target) {
      this.log(
        `scheduled wake for ${rawActorId} dropped — ${rec?.status === "retired" ? "recipient retired" : "no live actor"}`
      );
      return false;
    }
    if (!this.inboxStore) {
      target.requestRun(isResponsive ? { priority: "responsive" } : {});
      return true;
    }
    if (!messageId) {
      this.log(`scheduled wake for ${resolvedId} could not persist an inbox pointer`);
      return false;
    }
    this.inboxStore.append([
      {
        actorId: resolvedId,
        source: `mesh:${SCHEDULER_SENDER_ID}`,
        payload: {
          type: "scheduled.wake",
          messageId,
          fromId: SCHEDULER_SENDER_ID,
          ...(colonIdx >= 0 ? { slot: rawActorId } : {}),
          ...(isResponsive ? { priority: "responsive" } : {}),
        },
      },
    ]);
    this.dispatch(resolvedId);
    return true;
  }

  /**
   * Record that an actor yielded its run — its current objective is `complete`,
   * or it's `blocked` waiting on someone else. Invoked by the actor's own yield
   * tool. No-op (logged) if it isn't live.
   *
   * Eagerly notifies the parent when the run selected work sent by that parent.
   * External-event and scheduled-wake yields stay silent mechanically; a
   * worker can still escalate by judgment via {@link sendMessage}. Failed runs
   * bypass this path and are forwarded by the failure sink regardless of trigger.
   */
  declareYield(id: string, status: string, note?: string): void {
    id = this.resolveThreadId(id);
    const actor = this.runs.liveActor(id);
    if (!actor) {
      this.recordEvent({
        kind: "run_yielded",
        actorId: id,
        detail: "dropped — no live actor",
        body: note,
      });
      this.log(`yield from ${id} dropped — no live actor`);
      return;
    }
    if (status === "complete" || status === "blocked") {
      this.assertCleanYieldAllowed(id);
    }
    const runId = this.recordRunYield?.(id, status, note) ?? null;
    this.recordEvent({
      kind: "run_yielded",
      actorId: id,
      detail: status,
      body: note,
    });
    actor.declareYield(status, note);
    const parentId = this.actors.get(id)?.parentId;
    const inboxStore = this.inboxStore;
    const notifyingParent = !!(
      parentId &&
      inboxStore &&
      this.selectedInboxEntries(id).some((entryId) => {
        const entry = inboxStore.read(id, entryId);
        return entry?.payload.fromId === parentId;
      })
    );
    const appendix = this.onYield?.(id, { notifyingParent });
    if (notifyingParent && parentId) {
      const summary = note ? `: ${note}` : "";
      const body = appendix
        ? `[yield/${status}] ${id}${summary}\n\n${appendix}`
        : `[yield/${status}] ${id}${summary}`;
      this.deliverMechanicalInboxNotice(parentId, body, id, {
        runId: runId ?? id,
        actorId: id,
        status,
      });
    }
  }

  private assertCleanYieldAllowed(actorId: string): void {
    const runState = this.headClosureRuns.get(actorId);
    if (!runState || runState.headObligationIds.size === 0) return;
    const closure = this.obligations;
    // Selection already refused to arm a run without these reads, so this is
    // the second half of the same fail-closed rule rather than a soft skip: an
    // enforced run never yields cleanly on evidence the mesh cannot read.
    if (!supportsObligationClosureReads(closure)) {
      const [obligationId] = runState.headObligationIds;
      this.rejectCleanYield(
        actorId,
        obligationId ?? "unknown",
        null,
        "the mesh obligation closure port is unavailable, so closure cannot be verified"
      );
    }

    for (const obligationId of runState.headObligationIds) {
      const obligation = closure.get(obligationId);
      if (!obligation || !isBlockingObligationStatus(obligation.status)) continue;

      if (obligation.status === "ready") {
        const shortfall = this.strictHandoffShortfall(
          actorId,
          obligation,
          runState.selectedHeads.get(obligationId) ?? null
        );
        if (shortfall === null) continue;
        this.rejectCleanYield(actorId, obligationId, obligation.title, shortfall);
      }

      const preExistingChildren =
        runState.preExistingChildIds.get(obligationId) ?? new Set<string>();
      const hasNewlyCreatedLiveChild = closure
        .listDirectChildEdges(obligationId)
        .some(
          (child) =>
            child.creatorId === actorId &&
            !isTerminalObligationStatus(child.status) &&
            !preExistingChildren.has(child.id)
        );
      const preExistingPrerequisites =
        runState.preExistingPrerequisiteIds.get(obligationId) ?? new Set<string>();
      const hasNewlyAddedUnmetPrerequisite = closure
        .listPrerequisiteEdges(obligationId)
        .some(
          (prerequisite) =>
            !preExistingPrerequisites.has(prerequisite.prerequisiteId) &&
            !isTerminalObligationStatus(prerequisite.status)
        );
      if (!hasNewlyCreatedLiveChild && !hasNewlyAddedUnmetPrerequisite) {
        this.rejectCleanYield(
          actorId,
          obligationId,
          obligation.title,
          "obligation is waiting on pre-existing work but gained neither a newly created live direct child nor a newly added unmet prerequisite during this run"
        );
      }
    }
  }

  /**
   * Why a still-ready strict head does not count as handed off by this run, or
   * null when it does (#420).
   *
   * A handoff is the outgoing owner's own act: the run started with this actor
   * owning the head, the head now belongs to a distinct actor that can be
   * woken, and the checkpoint it carries was written by this actor during the
   * run. The selection-time owner is load-bearing rather than a restatement of
   * `actorId`: head attention is delivered to the owner, but ownership can move
   * between delivery and selection (an ancestor reassigns it elsewhere), and
   * without the snapshot such a run could yield cleanly on a transfer it never
   * performed. The checkpoint is compared against the same snapshot so a
   * standing left from an earlier run cannot stand in for this one.
   *
   * The obligation row and the ready-head transition are already committed by
   * the repository before this runs, which is what makes the disposition
   * durable: the live listener delivers the recipient's attention in-process,
   * and boot reconciliation restores it if the process is interrupted between
   * that commit and the wake.
   */
  private strictHandoffShortfall(
    outgoingActorId: string,
    obligation: Obligation,
    selected: SelectedHeadSnapshot | null
  ): string | null {
    const recipientId = this.resolveThreadId(obligation.ownerId);
    if (recipientId === outgoingActorId) return "obligation is still ready";
    const moved = `obligation is still ready and moved to ${obligation.ownerId}`;
    if (!selected) {
      return `${moved}, but it could not be read when selected, so the transfer cannot be attributed to this run`;
    }
    if (this.resolveThreadId(selected.ownerId) !== outgoingActorId) {
      return `${moved}, but this actor did not own it when selected, so the transfer is not this run's handoff`;
    }
    if (!obligation.checkpoint || obligation.checkpointBy !== outgoingActorId) {
      return `${moved} without a checkpoint written by this actor`;
    }
    if (
      obligation.checkpoint === selected.checkpoint &&
      obligation.checkpointAt === selected.checkpointAt &&
      obligation.checkpointBy === selected.checkpointBy
    ) {
      return `${moved} with a checkpoint left over from before this run rather than rewritten during it`;
    }
    if (!this.isWakeableRecipient(obligation.ownerId)) {
      return `${moved}, which is not an active actor that can be woken`;
    }
    return null;
  }

  /**
   * Whether a handoff recipient will ever be woken for the work: an actor in
   * the tree — not a human or system principal, which no inbox serves — whose
   * durable record is active and which is not mid-retirement. The durable
   * record is used rather than `live` on purpose: an active recipient may be
   * between process restart and rehydration, when the committed ready-head
   * transition is exactly what restores its queue. Retirement is the one
   * non-restart state that record cannot show (see {@link isActiveActor}).
   */
  private isWakeableRecipient(ownerId: string): boolean {
    if (ownerId.startsWith("human:") || ownerId.startsWith("system:")) return false;
    return this.isActiveActor(this.resolveThreadId(ownerId));
  }

  /**
   * Active by durable record and not currently being torn down. Retiring a
   * subtree recurses into children first and only marks each actor retired on
   * the way back out, so an ancestor unwinding its own retire still reads as
   * active right up until it's torn down.
   */
  private isActiveActor(id: string): boolean {
    return this.actors.get(id)?.status === "active" && !this.retiring.has(id);
  }

  private rejectCleanYield(
    actorId: string,
    obligationId: string,
    title: string | null,
    reason: string
  ): never {
    this.recordEvent({
      kind: "run_yield_rejected",
      actorId,
      detail: `Clean yield rejected for head obligation ${obligationId}: ${reason}`,
      payload: JSON.stringify({ obligationId, title, reason }),
    });
    this.log(
      `clean yield from ${actorId} rejected: head obligation ${obligationId} not finished or decomposed (${reason})`
    );
    throw new Error(
      `Cannot yield run: selected head obligation ${obligationId} ("${title ?? obligationId}") was not finished or decomposed. Reason: ${reason}. Before yielding cleanly, ${STRICT_HEAD_CLOSURE_EXITS}.`
    );
  }

  markUnkillable(actorId: string): void {
    actorId = this.resolveThreadId(actorId);
    const target = this.runs.liveActor(actorId);
    if (target) {
      target.markUnkillable();
    }
  }

  /**
   * Retire a thread and its entire subtree.
   *
   * **Refuses while any thread in that subtree has a run in flight** (an issue),
   * unless `force` or `forceQueued` is set. Retiring mid-run destroys work that is still being done:
   * the actor is `close()`d and marked retired synchronously, its provider call is
   * abandoned, and whatever that run was going to write is lost. The A/B rig learned
   * this the expensive way — the live root read two identically chartered arms as
   * duplicates and retired one *while it was building*, and the survivor's numbers
   * were then reported as a comparison. Deferring the destructive cleanups (which the
   * mesh already does) makes that loss quieter, not smaller.
   *
   * `force` exists for the operator's lever — a wedged actor must stay retirable.
   *
   * `forceQueued` cancels queued runs in the subtree before retirement, but still refuses
   * if any thread in the subtree is actively running (inside the provider call). This is
   * the flag the `retire_thread` MCP tool passes, so an actor's `force: true` overrides
   * only the *queued*-run refusal.
   *
   * **Also refuses while the subtree still holds undisposed work** — a live
   * obligation, a scheduled message in either direction (#191), or a live event
   * subscription (#540). That refusal names every blocker so the retirer can
   * reassign, finish, cancel, transfer, or unsubscribe each one and retry; nothing
   * is dropped mechanically as a fallback, because a dropped delivery is a decision
   * nobody made. **No flag passes it**, `force` included: the two refusals answer
   * different questions, and overriding "someone is still working" was never a licence
   * to destroy the work itself. The subtree cascade skips it by going through
   * {@link retireUnchecked} instead — the entry call already cleared the whole subtree,
   * and re-asking mid-teardown would only re-answer the same question against a tree
   * that is already coming apart.
   *
   * @throws when the subtree has running runs (or queued runs without `force`/`forceQueued`).
   * @throws {RetirementBlockedError} when the subtree holds live obligations, pending messages, or live event subscriptions.
   */
  retire(id: string, opts: RetireOptions = {}): void {
    id = this.resolveThreadId(id);
    if (!opts.force) {
      const busy = this.activeRunsInSubtree(id);
      if (busy.length > 0) {
        if (opts.forceQueued) {
          const runningBusy = busy.filter((r) => r.phase !== "queued");
          if (runningBusy.length > 0) {
            throw new Error(
              `cannot retire ${id}: ${describeActiveRuns(id, runningBusy)}. ` +
                "Retiring mid-run abandons the provider call and destroys that run's work — " +
                "wait for it to end (you'll be woken on its yield) and retire then."
            );
          }
        } else {
          throw new Error(
            `cannot retire ${id}: ${describeActiveRuns(id, busy)}. ` +
              "Retiring mid-run abandons the provider call and destroys that run's work — " +
              "wait for it to end (you'll be woken on its yield) and retire then."
          );
        }
      }
    }
    // Outside the `force` branch on purpose: see the doc comment above.
    const blockers = this.retirementBlockers(id);
    if (
      blockers.obligations.length > 0 ||
      blockers.messages.length > 0 ||
      blockers.subscriptions.length > 0
    ) {
      throw new RetirementBlockedError(blockers, describeRetirementBlockers(id, blockers));
    }
    this.retireUnchecked(id);
  }

  /**
   * Tear down one thread with both retirement guards already answered — the
   * subtree cascade's entry point, and never reachable from outside the mesh.
   */
  private retireUnchecked(id: string): void {
    // Marked before the child recursion: children retiring below us must be able
    // to see that we are on our way out, since the repository won't say so until
    // this call finishes. Cleared in the finally so a throwing cleanup can't
    // leave a live actor permanently marked as retiring.
    this.retiring.add(id);
    try {
      this.retireInner(id);
    } finally {
      this.retiring.delete(id);
    }
  }

  /**
   * Interrupt a running or queued actor.
   *
   * Ancestor or trusted operator principal only: an actor may only interrupt its descendants.
   * Aborts the in-flight provider call cleanly, sets the interrupted watermark to the
   * interrupted run's start time, and only schedules a re-run if newer unhandled inbox
   * items have arrived after the interrupted run started.
   */
  interrupt(
    targetId: string,
    by: string = "human:operator"
  ): { interrupted: boolean; status?: string } {
    targetId = this.resolveThreadId(targetId);
    by = this.resolveThreadId(by);
    const target = this.runs.liveActor(targetId);
    if (!target) {
      return { interrupted: false, status: "not_live" };
    }
    // `root-llm` is a RootControlPrincipal, not a thread id. RootControlService
    // scopes its target to the injected rootId's subtree before calling here;
    // human/e2e principals are operator-level bypasses by design.
    if (!isTrustedControlPrincipal(by, this.principals) && !this.isAncestorOf(by, targetId)) {
      throw new Error(
        `actor ${by} may only interrupt its descendants (cannot interrupt ${targetId})`
      );
    }

    const res = target.interrupt ? target.interrupt(by) : { interrupted: false };
    if (res.interrupted) {
      this.recordEvent({
        kind: "root_control_action",
        actorId: targetId,
        detail: `interrupted by ${by}`,
        payload: JSON.stringify({ action: "interrupt", by, targetId }),
      });

      // If new inbox items arrived after the interrupted run started (and wasn't just a queued run being cancelled), wake the actor.
      const runStartTime = res.runStartTime;
      if (runStartTime && this.inboxStore && !res.wasQueued) {
        const unhandled = this.inboxStore.list(targetId, { status: "unhandled" }).entries;
        const hasNewWork = unhandled.some((e) => e.deliveredAt > runStartTime);
        if (hasNewWork) {
          this.dispatch(targetId);
        }
      }
      return { interrupted: true };
    }
    return { interrupted: false, status: "idle" };
  }

  /**
   * Bypasses quota throttling / queue for an actor by adding a contentless responsive
   * nudge item to the actor's inbox and triggering a responsive run.
   */
  runNow(targetId: string, source: string = "operator"): { queued: boolean } {
    targetId = this.resolveThreadId(targetId);
    const record = this.actors.get(targetId);
    if (!record) {
      throw new Error(`cannot run unknown actor ${targetId}`);
    }
    if (record.status === "retired") {
      throw new Error(`cannot run actor ${targetId}: actor is not active`);
    }
    const target = this.runs.liveActor(targetId);
    target?.clearInterruptWatermark?.();

    if (this.inboxStore) {
      this.inboxStore.append([
        {
          actorId: targetId,
          source: `operator:${source}`,
          payload: {
            type: "operator.run_now",
            priority: "responsive",
          },
        },
      ]);
    }
    this.dispatch(targetId);
    return { queued: true };
  }

  /**
   * In-flight run state for one thread, or null when it has no run in flight.
   *
   * Read from the LIVE ACTOR (`isRunning`/`isQueued`), not from the event counter
   * that {@link runRetireCleanups} uses. The two remain separate on purpose:
   *  - This one is synchronous with the actor itself. The counter is downstream of
   *    the event sink, so it is only ever as correct as the terminal events that
   *    reach it — which is precisely how it drifted before ISSUE_NUM, when the two
   *    result-less terminal paths emitted nothing and it never returned to zero.
   *    It is sound now (every opportunity closes with a `RUN_TERMINAL_EVENT_KINDS`
   *    event, emitted from the same `finally` that clears these flags), but a guard
   *    whose failure mode is "this thread can never be retired" should not depend
   *    on an event arriving.
   *  - Conversely the cleanup path cannot use this one: `retireInner` deletes from
   *    the live registry before it runs the cleanups, so by then every thread reads idle.
   */
  activeRunState(actorId: string): ActiveRunState | null {
    actorId = this.resolveThreadId(actorId);
    const actor = this.runs.liveActor(actorId);
    if (!actor) return null;
    if (actor.isRunning) {
      return {
        actorId,
        phase: actor.isYielded ? "winding_down" : "running",
      };
    }
    if (actor.isQueued) return { actorId, phase: "queued" };
    return null;
  }

  /** One synchronous capture used to populate both the REST cursor and thread states. */
  runtimeStateSnapshot(): ActorRuntimeStateSnapshot {
    return {
      streamId: this.runtimeStreamId,
      revision: this.runtimeRevision,
      states: new Map(
        [...this.runs.liveEntries()].map(([actorId, actor]) => [
          actorId,
          this.runtimeStateOf(actor),
        ])
      ),
    };
  }

  /** Subscribe to already-sequenced runtime deltas. */
  onRuntimeStateDelta(listener: (delta: ActorRuntimeStateDelta) => void): () => void {
    this.runtimeStateListeners.add(listener);
    return () => this.runtimeStateListeners.delete(listener);
  }

  /** The sole revision authority for actor-published runtime transitions. */
  actorRuntimeStateChanged(
    actorId: string,
    runState: ActorRuntimeState,
    options: { refreshThreadSnapshot?: boolean } = {}
  ): void {
    const delta: ActorRuntimeStateDelta = {
      streamId: this.runtimeStreamId,
      revision: ++this.runtimeRevision,
      actorId,
      runState,
      ...(options.refreshThreadSnapshot ? { refreshThreadSnapshot: true } : {}),
    };
    for (const listener of this.runtimeStateListeners) {
      try {
        listener(delta);
      } catch (err) {
        this.log(
          `runtime state listener failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private runtimeStateOf(actor: MeshActor): ActorRuntimeState {
    if (actor.isRunning) return actor.isYielded ? "winding_down" : "running";
    return actor.isQueued ? "queued" : "idle";
  }

  /** True only if the actor is live and declared yield during its active run. */
  isYielded(actorId: string): boolean {
    actorId = this.resolveThreadId(actorId);
    const actor = this.runs.liveActor(actorId);
    return Boolean(actor?.isYielded);
  }

  /**
   * Every thread at or below `id`, the scope each whole-subtree retirement check
   * shares. Whole-subtree because retire is whole-subtree: checking only the named
   * thread would still let a retire two levels up tear down a busy grandchild, or
   * one still holding a live obligation. The visited set is defensive insurance
   * against a pre-corrupted cyclic tree, matching {@link reparentThread}'s cycle guard.
   *
   * `includeRetired` chooses which question is being asked. A retired thread can
   * never have a run in flight, so the run guard stops at active children. Work
   * outlives its owner, though: a subtree retired before #191 landed can still hold
   * live obligations and scheduled messages under a `retired` record, and skipping
   * those rows would let an ancestor retire over exactly the orphans this preflight
   * exists to catch.
   */
  private subtreeActorIds(id: string, opts: { includeRetired?: boolean } = {}): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const walk = (cursor: string): void => {
      if (seen.has(cursor)) return;
      seen.add(cursor);
      ids.push(cursor);
      for (const child of this.actors.children(cursor)) {
        if (opts.includeRetired || child.status === "active") walk(child.id);
      }
    };
    walk(id);
    return ids;
  }

  /**
   * Every thread at or below `id` with a run in flight — the retire guard's input, and
   * what {@link listChildRunStates} reports.
   */
  activeRunsInSubtree(id: string): ActiveRunState[] {
    id = this.resolveThreadId(id);
    const busy: ActiveRunState[] = [];
    for (const actorId of this.subtreeActorIds(id)) {
      const state = this.activeRunState(actorId);
      if (state) busy.push(state);
    }
    return busy;
  }

  /**
   * Everything in `id`'s subtree that needs an explicit decision before it can
   * retire: live obligations owned anywhere in it, pending scheduled
   * messages with either endpoint in it, and live event subscriptions held in it (#540).
   *
   * Both message directions block by decision (#191). Inbound alone is the
   * narrower rule, but it leaves a retired actor able to speak later with no
   * live sender to answer for what it said or to handle a failed delivery. The
   * alternative — letting the retirer name outgoing sends to preserve — is
   * machinery for a case nobody has hit yet; if rescheduling a handoff turns out
   * to be routine, that is the evidence for building it.
   *
   * The walk covers retired descendants as well as active ones. Ownership is a
   * property of the work, not of whether its owner is still running, so an
   * obligation or a send left behind by an already-retired child is still this
   * subtree's to answer for — and answering for it is the whole point.
   *
   * Read-only, and safe to call before deciding to retire: the same list the
   * refusal would print.
   */
  retirementBlockers(id: string): RetirementBlockers {
    id = this.resolveThreadId(id);
    const subtree = new Set(this.subtreeActorIds(id, { includeRetired: true }));
    const obligations: ObligationRetirementBlocker[] = [];
    for (const ownerId of subtree) {
      for (const obligation of this.obligations?.listLiveOwnedBy?.(ownerId) ?? []) {
        obligations.push({
          obligationId: obligation.id,
          ownerId,
          status: obligation.status,
          title: obligation.title,
        });
      }
    }
    const messages: MessageRetirementBlocker[] = [];
    for (const message of this.scheduledMessages?.listMessageDeliveries() ?? []) {
      const incoming = subtree.has(message.toId);
      const outgoing = subtree.has(message.fromId);
      if (!incoming && !outgoing) continue;
      messages.push({
        messageId: message.id,
        fromId: message.fromId,
        toId: message.toId,
        deliverAt: message.deliverAt,
        direction: incoming && outgoing ? "internal" : incoming ? "incoming" : "outgoing",
      });
    }
    const subscriptions: SubscriptionRetirementBlocker[] = [];
    for (const sub of this.eventSourceOwners.list()) {
      if (subtree.has(sub.actorId) && !sub.unsubscribedAt) {
        subscriptions.push({
          resource: sub.resource,
          actorId: sub.actorId,
          kind: "ownership",
        });
      }
    }
    for (const sub of this.eventSourceSubscriptions.list()) {
      if (subtree.has(sub.actorId)) {
        subscriptions.push({
          resource: sub.resource,
          actorId: sub.actorId,
          kind: "subscription",
        });
      }
    }
    return { obligations, messages, subscriptions };
  }

  /**
   * Cancel one pending scheduled message on the authority of an actor entitled
   * to decide its fate: either endpoint, an ancestor of either (the same
   * boundary retirement uses), or a trusted operator principal.
   *
   * The disposition half of the fail-closed retirement boundary (#191).
   * Retirement refuses while a scheduled message touches the subtree; the
   * retirer cancels what no longer matters and re-sends what does, and the
   * `scheduled_message_cancelled` event records who decided — so a message that
   * never arrives has a decider's name on it rather than a teardown's.
   */
  cancelScheduledMessage(
    messageId: string,
    by: string,
    reason?: string
  ): { messageId: string; fromId: string; toId: string; deliverAt: string } {
    by = this.resolveThreadId(by);
    const message = this.scheduledMessages
      ?.listMessageDeliveries()
      .find((entry) => entry.id === messageId);
    if (!message) {
      throw new Error(
        `unknown pending message id: ${messageId} — it may have already been delivered or cancelled`
      );
    }
    const authorized =
      isTrustedControlPrincipal(by, this.principals) ||
      this.isAncestorOf(by, message.fromId) ||
      this.isAncestorOf(by, message.toId);
    if (!authorized) {
      throw new Error(
        `actor ${by} may only cancel scheduled messages it sent or receives, or that involve one of its descendants (cannot cancel ${messageId})`
      );
    }
    this.scheduledMessages?.cancelMessageDelivery(messageId);
    this.recordEvent({
      kind: "scheduled_message_cancelled",
      actorId: by,
      detail: messageId,
      payload: JSON.stringify({
        messageId,
        fromId: message.fromId,
        toId: message.toId,
        deliverAt: message.deliverAt,
        cancelledBy: by,
        ...(reason ? { reason } : {}),
      }),
    });
    this.log(
      `scheduled message ${messageId} (${message.fromId} -> ${message.toId} at ${message.deliverAt}) cancelled by ${by}`
    );
    return {
      messageId,
      fromId: message.fromId,
      toId: message.toId,
      deliverAt: message.deliverAt,
    };
  }

  /**
   * Direct children of `parentId` with their in-flight run state — what `list_threads`
   * needs to show a parent which of its reports is busy. Root had no way to tell a
   * mid-run child from an idle one, which is half of why ISSUE_NUM happened at all: the
   * information that would have made the retire obviously wrong was not on the screen.
   */
  listChildRunStates(
    parentId: string
  ): Map<string, "running" | "queued" | "winding_down" | "idle"> {
    parentId = this.resolveThreadId(parentId);
    const states = new Map<string, "running" | "queued" | "winding_down" | "idle">();
    for (const child of this.actors.children(parentId)) {
      states.set(child.id, this.activeRunState(child.id)?.phase ?? "idle");
    }
    return states;
  }

  /** Return the display handle for an actor thread id. */
  getActorHandle(actorId: string): string {
    return this.handleForId(this.resolveThreadId(actorId));
  }

  /**
   * Resolve a direct child actor record by display handle for a given requester.
   * Performs trim and case-insensitive matching against direct reports.
   * Throws if handle is blank, unknown, or ambiguous.
   */
  resolveDirectChildHandle(requesterId: string, handle: string): ActorRecord {
    requesterId = this.resolveThreadId(requesterId);
    const normalized = handle.trim().toLowerCase();
    if (!normalized) {
      throw new Error("child handle must not be blank");
    }
    const directChildren = this.list().filter(
      (r) => r.parentId === requesterId && r.status === "active"
    );
    const matches = directChildren.filter(
      (r) => this.handleForId(r.id).toLowerCase() === normalized
    );
    if (matches.length === 0) {
      throw new Error(`unknown child handle: "${handle}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `ambiguous child handle "${handle}": matches multiple child threads (${matches.map((m) => m.id).join(", ")})`
      );
    }
    return matches[0];
  }

  private retireInner(id: string): void {
    for (const child of this.actors.children(id)) {
      if (child.status === "active") this.retireUnchecked(child.id);
    }
    this.runs.release(id);
    const record = this.actors.get(id);
    // No mechanical drop of this thread's pending deliveries here (#191). Every
    // entry into retirement now preflights the whole subtree for scheduled
    // messages in either direction, so reaching teardown means someone already
    // decided each one by name through `cancelScheduledMessage` — which is also
    // the only place the `scheduled_message_cancelled` audit record is written.
    // Dropping here would have been a second, unaudited way for a message to
    // die, reachable only by racing a check that cannot actually be raced.
    if (record) void this.lifecycleFor(id).emit("onRetire", { actorId: id });
    if (record && this.onRetire) {
      try {
        this.onRetire(record);
      } catch (err) {
        this.log(`onRetire(${id}) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Revoke any active capabilities on retire, so they aren't auto-restored on revive
    // but the grant records survive (marked with revokedAt).
    const activeCaps = this.grants.activeFor(id);
    for (const cap of activeCaps) {
      this.grants.revoke(id, cap, this.now());
      if (this.onCapabilityRevoked) {
        try {
          const res = this.onCapabilityRevoked(id, cap);
          if (res instanceof Promise) {
            res.catch((err) => {
              this.log(
                `onCapabilityRevoked(${id}, ${cap}) failed: ${err instanceof Error ? err.message : String(err)}`
              );
            });
          }
        } catch (err) {
          this.log(
            `onCapabilityRevoked(${id}, ${cap}) failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // Mark retired before physical teardown so routing/handle resolution stops
    // immediately even when a destructive cleanup is deferred until run_end.
    this.actors.patch(id, { status: "retired" });
    this.recordEvent({
      kind: "actor_retired",
      actorId: id,
    });
    if (record) this.runRetireCleanups(record);
    this.lifecycles.delete(id);
    // Per-actor model-class bookkeeping dies with the actor.
    this.reportedModelClassFailures.delete(id);
    this.log(`retired ${id}`);
  }

  private runRetireCleanups(record: ActorRecord): void {
    const deferred: RetireCleanup[] = [];
    for (const cleanup of this.retireCleanups) {
      if (cleanup.deferUntilRunEnd && this.hasActiveRun(record.id)) {
        deferred.push(cleanup);
        continue;
      }
      this.runRetireCleanup(cleanup, record);
    }
    if (deferred.length > 0) {
      const existing = this.deferredRetireCleanups.get(record.id);
      this.deferredRetireCleanups.set(record.id, {
        record,
        cleanups: [...(existing?.cleanups ?? []), ...deferred],
      });
      this.log(
        `deferred ${deferred.length} retire cleanup(s) for ${record.id} until active run_end`
      );
    }
  }

  private runRetireCleanup(cleanup: RetireCleanup, record: ActorRecord): void {
    try {
      const result = cleanup.run(record);
      if (result && typeof result === "object" && "then" in result) {
        result.catch((err) => this.logRetireCleanupFailure(cleanup.name, record.id, err));
      }
    } catch (err) {
      this.logRetireCleanupFailure(cleanup.name, record.id, err);
    }
  }

  private updateActiveRunState(event: Parameters<MeshEventSink>[0]): void {
    if (!event.actorId) return;
    if (event.kind === "run_queued") {
      this.activeRunCounts.set(event.actorId, (this.activeRunCounts.get(event.actorId) ?? 0) + 1);
      return;
    }
    // Every terminal kind decrements, not just `run_end`. A run that ends without
    // a result emits `run_abandoned` instead, and counting only `run_end` is what
    // made this counter monotonic for any actor that ever hit one .
    if (!(RUN_TERMINAL_EVENT_KINDS as readonly string[]).includes(event.kind)) return;

    const next = (this.activeRunCounts.get(event.actorId) ?? 0) - 1;
    if (next > 0) {
      this.activeRunCounts.set(event.actorId, next);
      return;
    }
    this.activeRunCounts.delete(event.actorId);
    this.flushDeferredRetireCleanups(event.actorId);
  }

  private hasActiveRun(actorId: string): boolean {
    return (this.activeRunCounts.get(actorId) ?? 0) > 0;
  }

  private flushDeferredRetireCleanups(actorId: string): void {
    const pending = this.deferredRetireCleanups.get(actorId);
    if (!pending || this.hasActiveRun(actorId)) return;
    this.deferredRetireCleanups.delete(actorId);
    for (const cleanup of pending.cleanups) {
      try {
        const result = cleanup.run(pending.record);
        if (result && typeof result === "object" && "then" in result) {
          result.catch((err) => this.logRetireCleanupFailure(cleanup.name, actorId, err));
        }
      } catch (err) {
        this.logRetireCleanupFailure(cleanup.name, actorId, err);
      }
    }
  }

  private logRetireCleanupFailure(name: string, actorId: string, err: unknown): void {
    this.log(
      `retire cleanup ${name}(${actorId}) failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  /**
   * Safety net cleanup: removes any lingering event subscriptions or ownerships
   * for the retiring actor.
   *
   * Under standard {@link retire}, this is unreachable because `retirementBlockers`
   * refuses retirement if any active event subscription or ownership remains in the
   * subtree. It is preserved here as a defense-in-depth safety net during teardown
   * so that no active routing records can survive an actor's retirement.
   */
  private retireEventSubscriptions(record: ActorRecord): void {
    const at = this.now();
    for (const subscription of this.eventSourceOwners.list()) {
      if (subscription.actorId !== record.id || subscription.unsubscribedAt) continue;
      this.unsubscribeEventSource(subscription.resource, record.id, at);
    }
    // Ownership is released into a tombstone because the record of who held a
    // source outlives the holder. A subscription has no such record to keep —
    // it is live routing for an actor that no longer runs — so it is removed.
    for (const subscription of this.eventSourceSubscriptions.list()) {
      if (subscription.actorId !== record.id) continue;
      this.removeEventSourceSubscriber(subscription.resource, record.id);
    }
  }

  /**
   * Revive a retired thread — the inverse of {@link retire}. Re-instantiates the
   * actor (a fresh cap-URL endpoint via the rehydrate path) and resumes its
   * provider conversation from the retained sessionId, so it wakes back up knowing
   * what it knew. It comes back **inert**: idle (root must `send_message` it to put
   * it to work), with **no capability grants** (retire revoked them — root
   * re-grants if needed) and an **empty working directory** (retire rmSync'd it; an
   * `onRevive` hook recreates it empty). Revive restores the *conversation*, NOT the
   * *filesystem* — uncommitted work/clones are gone; the actor re-derives its
   * workspace like a spawn. Atomic: a failure mid-revive rolls the record back to
   * retired so it stays re-tryable.
   */
  /**
   * Set a thread's parent-authored display title  on an existing record — the
   * post-spawn path the spawn-time `title` field otherwise lacked. Root-only at the
   * tool layer; here it just validates the thread exists and patches the durable
   * record (the dashboard reads the record, so it reflects immediately). Used to
   * backfill titles on actors spawned before titles existed, or to re-title.
   */
  setThreadTitle(id: string, title: string): void {
    id = this.resolveThreadId(id);
    const record = this.actors.get(id);
    if (!record) {
      throw new Error(`Cannot set title on unknown thread: ${id}`);
    }
    this.actors.patch(id, { title });
  }

  /**
   * Replace a thread's charter on an existing record — the post-spawn path the
   * spawn-time `charter` otherwise lacked (charter was immutable once spawned).
   * Root-only at the tool layer; here it just validates the thread exists and
   * patches the durable record. The charter is the actor's standing brief, read
   * fresh from the record each run and re-injected into its prompt (see
   * `buildWorkerPrompt(r.charter, …)` in start.ts), so a new charter takes effect
   * on the actor's next wake. Use to re-scope a long-lived actor durably (e.g.
   * promote an elder to a steward) rather than re-scoping by message alone, which
   * a session reap can lose — the charter is the durable re-derivation anchor.
   */
  setThreadCharter(id: string, charter: string): void {
    id = this.resolveThreadId(id);
    const record = this.actors.get(id);
    if (!record) {
      throw new Error(`Cannot set charter on unknown thread: ${id}`);
    }
    // A charter is an actor's whole mandate; an empty one would silently wipe it
    // on the next wake (higher stakes than an empty title). Refuse it.
    if (!charter.trim()) {
      throw new Error(`Cannot set an empty charter on thread: ${id}`);
    }
    this.actors.patch(id, { charter });
    // Audit the durable re-scope on the timeline (detail = a charter excerpt, per
    // MeshEventInput) — promotions and other re-charters should be inspectable
    // alongside reparent/grant/retire.
    this.recordEvent({
      kind: "actor_charter_set",
      actorId: id,
      detail: charter.slice(0, 140),
    });
  }

  /**
   * Stage a full replacement of an existing actor's declared modelConfig pool.
   * Capability- or parent-gated: a `model-admin` holder may set the model for
   * any thread in its subtree, itself included; any other caller may only set
   * the model for its own descendants (and never its own).
   * A pool of more than one entry, or a change of provider, requires a
   * portable (ledger/tail) actor — a native provider session can't move.
   * The replacement is atomic (the whole pool or nothing). A run already in
   * flight keeps its launched pool and the replacement applies when that run
   * ends; an idle or queued actor has it applied and persisted now (#652), so
   * it never waits in process memory for a dispatch that may not come before
   * a restart.
   */
  setActorModel(
    id: string,
    modelConfig: ModelConfigInput,
    requestedBy: string
  ): "applied" | "staged" {
    id = this.resolveThreadId(id);
    requestedBy = this.resolveThreadId(requestedBy);
    const record = this.actors.get(id);
    if (!record) {
      throw new Error(`Cannot set model on unknown thread: ${id}`);
    }
    if (record.status === "retired") {
      throw new Error(`Cannot set model on retired thread: ${id}`);
    }
    if (this.hasActiveCapability(requestedBy, MODEL_ADMIN_CAPABILITY)) {
      if (!this.isAncestorOf(requestedBy, id)) {
        throw new Error(
          `Cannot set model on thread ${id}: ${requestedBy} may only set models in its own subtree`
        );
      }
    } else {
      if (requestedBy === id) {
        throw new Error(`Cannot set model: an actor cannot set its own model (${id})`);
      }
      if (!this.isAncestorOf(requestedBy, id)) {
        throw new Error(
          `Cannot set model on thread ${id}: caller ${requestedBy} is not an ancestor of ${id}`
        );
      }
    }
    const validated =
      this.validateModel?.(record, modelConfig) ?? normalizeModelConfigList(modelConfig);
    if (validated.length === 0) {
      throw new Error(`Cannot set an empty modelConfig on thread: ${id}`);
    }
    const portable = record.context?.type === "portable";
    if (validated.length > 1 && !portable) {
      throw new Error(
        `Cannot set a modelConfig pool of more than one entry on non-portable actor ${id} (context mode: ${record.context?.type ?? "native"}). Only portable (ledger/tail) actors can use a multi-candidate pool.`
      );
    }
    const currentProvider = record.modelConfig?.[0]?.provider;
    if (
      !portable &&
      validated.length === 1 &&
      currentProvider !== undefined &&
      validated[0].provider !== currentProvider
    ) {
      throw new Error(
        `Cannot change provider on non-portable actor ${id} (context mode: ${record.context?.type ?? "native"}). Only portable (ledger/tail) actors can be moved across providers.`
      );
    }
    // Boundary contract (#199, #652): an in-flight run completes on its
    // already-launched pool, and the staged pool applies at that run's end
    // (see {@link finishInboxRun}). An idle or queued actor has no launched
    // run, so there is nothing to wait for: apply and persist now. Staging is
    // process memory, so a pool left staged here would be lost to a restart.
    const desiredModelClass = isModelClassReference(modelConfig) ? modelConfig.class : undefined;
    this.actors.patch(id, {
      desiredModelConfig: validated,
      // An explicit replacement deliberately clears any prior class label;
      // equality with a class's current entries is not provenance.
      desiredModelClass,
    });
    const phase = this.activeRunState(id)?.phase;
    const staged = phase === "running" || phase === "winding_down";
    if (!staged) this.applyPendingModel(id);

    // A queued reservation has already quoted one of the old pool's lanes.
    // Replacing that pool must release the old quote now and pass the same
    // single-flight work back through admission, rather than waiting until the
    // stale lane eventually becomes available to discover the change. The
    // actor's dirty bit coalesces repeated updates into exactly one replacement
    // opportunity; a live provider run has no pending reservation, so it keeps
    // its launched pool through its normal run boundary.
    const liveActor = this.runs.liveActor(id);
    // Do not turn a staged move onto an already-halted pool into a transient
    // re-quote that `beforeRun` merely drops: retain the work through the
    // existing halt/resume path instead. Partially healthy pools still
    // re-quote normally, letting provider selection choose an eligible lane.
    if (this.allCandidatesHalted(validated) || this.isShuttingDown()) {
      if (liveActor?.cancelQueuedRun?.()) return staged ? "staged" : "applied";
    } else if (liveActor?.rescheduleQueuedRun?.()) {
      return staged ? "staged" : "applied";
    }

    if (this.inboxStore && this.runs.isLive(id) && this.activeRunState(id) === null) {
      const unhandled = this.inboxStore.list(id, { status: "unhandled" }).entries;
      if (unhandled.length > 0) {
        this.dispatch(id);
      }
    }
    return staged ? "staged" : "applied";
  }

  /**
   * Apply the staged modelConfig replacement at whichever boundary the
   * actor's current state puts it behind next. `setActorModel` applies the
   * normal idle/queued case immediately; dispatch is the fallback for an
   * overlay retained by an admission gap or an all-halted preflight. A
   * mid-run overlay applies at run end (from {@link finishInboxRun}).
   * Public — like {@link finishInboxRun} and {@link actorQueued} — because both
   * factory-created workers and the externally-constructed root invoke it at
   * their dispatch boundary.
   * A no-op when nothing is staged, so calling it from both boundaries on the
   * same run is safe: whichever fires first consumes the pending pool.
   */
  applyPendingModel(id: string): void {
    const record = this.actors.get(id);
    if (!record) return;
    if (record.desiredModelConfig === undefined) {
      this.refreshClassBoundPool(id, record);
      return;
    }

    const oldModelConfig = record.modelConfig;
    const newModelConfig = record.desiredModelConfig;
    const boundClass = record.desiredModelClass;

    // The one deliberate model-configuration write: it restates the row's
    // model-config document, which an ordinary `patch` deliberately does not
    // (#626).
    this.actors.setModelSelection(id, {
      modelConfig: newModelConfig,
      modelClass: boundClass,
      desiredModelConfig: undefined,
      desiredModelClass: undefined,
    });

    const verified = this.actors.get(id);
    if (!verified) throw new Error(`Failed to reload thread after model update: ${id}`);
    if (boundClass !== undefined) {
      // A class binding persists the reference, not the pool the selection
      // resolved to, so the pool is whatever the class says now — verify the
      // binding landed and publish the live definition rather than a snapshot
      // that a concurrent class edit may already have overtaken (#626).
      if (verified.modelClass !== boundClass) {
        throw new Error(`Failed to verify deferred model class update for thread: ${id}`);
      }
      if (!verified.modelConfig) {
        throw new Error(
          `Model class "${boundClass}" applied to thread ${id} no longer resolves: ${verified.modelClassError ?? "unknown reason"}`
        );
      }
    } else if (JSON.stringify(verified.modelConfig) !== JSON.stringify(newModelConfig)) {
      throw new Error(`Failed to verify deferred model update for thread: ${id}`);
    }

    const appliedModelConfig = verified.modelConfig ?? newModelConfig;
    // Publish before journalling. The durable `actor_model_set` event below is
    // the record that this pool reached the actor, so a publication that threw
    // must not leave that claim behind.
    this.onModelSet?.(id, appliedModelConfig, verified);

    this.recordEvent({
      kind: "actor_model_set",
      actorId: id,
      detail: `${oldModelConfig ? describeModelConfigPool(oldModelConfig) : "default"} -> ${describeModelConfigPool(appliedModelConfig)}${boundClass !== undefined ? ` (class "${boundClass}")` : ""}`,
    });
  }

  /**
   * Hand a class-bound actor's current class definition to the live actor
   * object at its dispatch boundary.
   *
   * The record already reads through to the class row, so nothing durable
   * changes here — but a running actor caches the pool it was constructed
   * with, and without this refresh an edit made after construction would not
   * reach the actor's next run (#626). An unresolvable class is left to the
   * pre-run gate, which refuses the run outright.
   */
  private refreshClassBoundPool(id: string, record: ActorRecord): void {
    if (record.modelClass === undefined || !record.modelConfig) return;
    if (!this.runs.liveActor(id)?.setModelConfig) return;
    // Unconditional: the publication is one idempotent field assignment on the
    // live actor, so republishing an unchanged pool costs less than the
    // bookkeeping that would skip it, and every dispatch boundary re-asserts
    // the class's current definition.
    this.onModelSet?.(id, record.modelConfig, record);
  }

  /**
   * Pure read of why a class-bound actor cannot be scheduled. Querying this
   * never emits an event, so dashboard and diagnostic callers can inspect the
   * record without changing its timeline.
   */
  modelClassError(id: string): string | undefined {
    return this.actors.get(id)?.modelClassError;
  }

  /** Record a coalesced visible failure at a boot or dispatch refusal site. */
  reportModelClassFailure(id: string, reason = this.modelClassError(id)): void {
    if (reason === undefined) return;
    if (this.reportedModelClassFailures.get(id) !== reason) {
      this.reportedModelClassFailures.set(id, reason);
      this.recordEvent({
        kind: "actor_model_class_unresolved",
        actorId: id,
        detail: reason,
      });
    }
  }

  /** Forget a prior visible failure after the class resolves again. */
  clearModelClassFailure(id: string): void {
    if (this.reportedModelClassFailures.has(id)) this.reportedModelClassFailures.delete(id);
  }

  /**
   * Move an actor to a new parent (the re-org primitive — e.g. promote a steward
   * and reparent workers under it). Root-only at the tool layer. Changes who
   * receives the actor's yield/completion reports and who may retire it (ownership
   * is the `parentId` edge), and grants the new parent a handle so it can message
   * the actor. The actor's own subtree rides along — it stays attached, so the whole
   * branch moves. Guards: refuses to reparent the root or any existing top-level
   * boundary, a no-op self-parent, an unknown actor/parent, or a move that would
   * create a cycle (the new parent must not be the actor or any of its descendants).
   * Existing handles (incl. the old parent's) are left intact — handles are a graph,
   * ownership is the tree.
   */
  reparentThread(id: string, newParentId: string): void {
    id = this.resolveThreadId(id);
    newParentId = this.resolveThreadId(newParentId);
    const record = this.actors.get(id);
    if (!record) {
      throw new Error(`Cannot reparent unknown thread: ${id}`);
    }
    if (record.isRoot === true) {
      throw new Error(`Cannot reparent the root (${id})`);
    }
    if (record.parentId == null) {
      throw new Error(`Cannot give the top-level thread ${id} a parent`);
    }
    if (id === newParentId) {
      throw new Error(`Cannot reparent ${id} to itself`);
    }
    const newParent = this.actors.get(newParentId);
    if (!newParent) {
      throw new Error(`Cannot reparent ${id} to unknown parent: ${newParentId}`);
    }
    // The new parent must be live, else the actor's yields/reports would drop into
    // a retired void (elder ISSUE_NUM rec a).
    if (newParent.status !== "active") {
      throw new Error(
        `Cannot reparent ${id} under non-active parent ${newParentId} (status: ${newParent.status})`
      );
    }
    // Cycle guard: walk up from the proposed parent; if we reach `id`, the move
    // would make `id` its own ancestor. The visited-set is defensive insurance so a
    // pre-corrupted cyclic tree can't spin this forever (elder ISSUE_NUM rec b).
    const seen = new Set<string>();
    for (
      let cursor: string | null | undefined = newParentId;
      cursor != null && !seen.has(cursor);
      cursor = this.actors.get(cursor)?.parentId
    ) {
      if (cursor === id) {
        throw new Error(`Cannot reparent ${id} under its own descendant ${newParentId} (cycle)`);
      }
      seen.add(cursor);
    }
    this.actors.patch(id, { parentId: newParentId });
    this.grantHandle(newParentId, { id }); // the new parent can now message the actor
    this.recordEvent({
      kind: "actor_reparented",
      actorId: id,
      payload: JSON.stringify({ fromParentId: record.parentId, toParentId: newParentId }),
    });
  }

  reviveThread(id: string): void {
    id = this.resolveThreadId(id);
    const record = this.actors.get(id);
    if (!record) {
      throw new Error(`Cannot revive unknown thread: ${id}`);
    }
    if (record.status !== "retired") {
      throw new Error(`Cannot revive thread ${id}: status is ${record.status} (expected retired)`);
    }

    this.actors.patch(id, { status: "active" });
    const updatedRecord = this.actors.get(id);
    if (!updatedRecord) {
      throw new Error(`Failed to retrieve record for revived thread: ${id}`);
    }

    // Atomic revive: if workdir-recreate, re-instantiate, or endpoint mount throws,
    // roll the record back to retired so a failed revive is immediately re-tryable
    // rather than stranded active-but-not-live (elder review of ISSUE_NUM).
    try {
      this.onRevive?.(updatedRecord);
      const actor = this.runs.instantiate(updatedRecord);
      this.actorRuntimeStateChanged(id, this.runtimeStateOf(actor));
    } catch (err) {
      this.runs.forget(id);
      this.actors.patch(id, { status: "retired" });
      this.log(
        `reviveThread(${id}) failed, rolled back to retired: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    }

    this.recordEvent({
      kind: "actor_revived",
      actorId: id,
      payload: updatedRecord.parentId
        ? JSON.stringify({ parentId: updatedRecord.parentId })
        : undefined,
    });
    this.log(`revived ${id}`);
  }

  /** The live actor for an id, if any. */
  get(id: string): MeshActor | undefined {
    return this.runs.liveActor(this.resolveThreadId(id));
  }

  /** True if `ancestorId` is `id` itself or any ancestor up the ownership tree. */
  isAncestorOf(ancestorId: string, id: string): boolean {
    ancestorId = this.resolveThreadId(ancestorId);
    id = this.resolveThreadId(id);
    let cursor: string | null = id;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      if (cursor === ancestorId) return true;
      seen.add(cursor);
      cursor = this.actors.get(cursor)?.parentId ?? null;
    }
    return false;
  }

  /**
   * Stop all live actors' timers without retiring them (graceful shutdown). The
   * repository is untouched, so active actors can be rehydrated on the next boot.
   */
  shutdownAll(): void {
    this.unsubscribeInboxAppends?.();
    this.unsubscribeInboxAppends = undefined;
    this.appendWakesOwed.clear();
    this.runs.closeAll();
  }

  /** All thread records (active and retired). */
  list(): ActorRecord[] {
    return this.actors.list();
  }

  /** Slots currently running (for diagnostics/tests). */
  get inFlight(): number {
    return this.runs.inFlight;
  }

  /**
   * Schedule a run through provider pacing and the normal-only mesh queue.
   * Given the actor's declared candidate pool, atomically selects the
   * earliest-eligible canonical provider lane (declaration order breaks
   * ties) and invokes `fn` with the winning tuple.
   */
  gateRun<T>(
    fn: (selected: RawProviderModelConfig) => Promise<T>,
    candidates: readonly RawProviderModelConfig[],
    responsive = false,
    threadId?: string
  ): RunStartHandle<T> {
    return this.runs.gateRun(fn, candidates, responsive, threadId);
  }

  /**
   * Read-only snapshot of the declared tuple a queued run has actually
   * reserved, for MCP/dashboard exposure. `undefined` once the run starts,
   * is cancelled, or ends — never a stale reservation.
   */
  getSelection(id: string): QueuedSelection | undefined {
    return this.runs.selectionFor(id);
  }

  /** Clear a recorded selection at start/cancel/end so it never outlives the reservation it describes. */
  clearSelection(id: string): void {
    this.runs.clearSelection(id);
  }

  /**
   * A synchronous, read-only snapshot of the ids of every live actor that is
   * running at the provider right now. Runs waiting in either scheduler queue
   * are deliberately excluded. Built in one synchronous
   * pass over the live map (no awaits), so the dashboard can classify every
   * thread against a single non-torn view. Live actors only (the root included,
   * since it's adopted into `live`); the threads handler joins the repository, so
   * an active-but-not-running thread reads idle and a retired one reads retired.
   * Read-only: observes existing state, never schedules, wakes, or mutates.
   */
  runningThreadIds(): Set<string> {
    const ids = new Set<string>();
    for (const [id, actor] of this.runs.liveEntries()) {
      if (actor.isRunning) ids.add(id);
    }
    return ids;
  }

  /** Actors that passed their pre-run gate but are waiting for their run to start. */
  queuedThreadIds(): Set<string> {
    const ids = new Set<string>();
    for (const [id, actor] of this.runs.liveEntries()) {
      if (actor.isQueued) ids.add(id);
    }
    return ids;
  }

  /** All post-preflight runs, including queued ones; used by shutdown barriers. */
  activeRunThreadIds(): Set<string> {
    return new Set([...this.runningThreadIds(), ...this.queuedThreadIds()]);
  }

  /**
   * The modelConfig pool a thread's next run will actually launch on.
   * An overlay is normally consumed immediately by `setActorModel`; when one
   * remains for a run boundary (mid-run, an admission gap, or an all-halted
   * preflight), every halt-gate check must still consult it instead of the
   * record's current `modelConfig`. Otherwise a staged move to an
   * already-halted pool slips through a still-open old pool's gate.
   */
  private launchModelConfig(id: string): ProviderModelConfig[] | undefined {
    const rec = this.actors.get(id);
    return rec?.desiredModelConfig ?? rec?.modelConfig;
  }

  /** True only when every declared candidate in the pool is halted. */
  private allCandidatesHalted(modelConfig: readonly ProviderModelConfig[] | undefined): boolean {
    if (!modelConfig || modelConfig.length === 0) return false;
    return modelConfig.every((c) => this.isHalted(c.provider, c.model));
  }

  /**
   * Apply the shared pre-run admission rule used by the externally constructed
   * root and every mesh-created actor. It checks the staged-or-current pool
   * before committing it, so an all-held staged pool is left intact for a
   * future eligible run; a pool with any unheld candidate remains schedulable.
   */
  prepareRun(id: string): boolean {
    const rec = this.actors.get(id);
    if (!rec || rec.status !== "active") return false;
    if (this.allCandidatesHalted(this.launchModelConfig(id)) || this.isShuttingDown()) {
      return false;
    }
    this.applyPendingModel(id);
    // A staged rebind or explicit pin is the supported repair path for a
    // broken current class. Apply it before inspecting the current binding so
    // an idle actor can repair itself on its next dispatch (#626).
    const modelClassError = this.modelClassError(id);
    if (modelClassError !== undefined) {
      this.reportModelClassFailure(id, modelClassError);
      return false;
    }
    this.clearModelClassFailure(id);
    return true;
  }

  /**
   * Cancel queued starts whose *actual reserved lane* is halted — keys off
   * the recorded {@link QueuedSelection}, not the whole declared pool, so a
   * halt on one candidate never cancels a reservation already sitting on a
   * different, still-healthy candidate in the same pool. Falls back to the
   * whole-pool check only when no selection has been recorded (a
   * `providerGate` that never wired `onSelected`, or a request gated before
   * this reservation existed).
   */
  cancelHaltedQueuedRuns(): string[] {
    const cancelled: string[] = [];
    for (const [id, actor] of this.runs.liveEntries()) {
      const selection = this.runs.selectionFor(id);
      const halted = selection
        ? this.isHalted(selection.provider, selection.model)
        : this.allCandidatesHalted(this.launchModelConfig(id));
      if (halted && actor.cancelQueuedRun?.()) {
        cancelled.push(id);
      }
    }
    return cancelled;
  }

  /** Replay starts canceled by a halt once at least one pool candidate is no longer blocked. */
  resumeCancelledRuns(): string[] {
    const resumed: string[] = [];
    for (const [id, actor] of this.runs.liveEntries()) {
      if (!this.allCandidatesHalted(this.launchModelConfig(id)) && actor.resumeCancelledRun?.()) {
        resumed.push(id);
      }
    }
    return resumed;
  }

  private factoryContext(record: ActorRecord): ActorFactoryContext {
    return {
      record,
      getRecord: () => this.actors.get(record.id),
      executionTarget: record.executionTarget,
      mesh: this,
      lifecycle: this.lifecycleFor(record.id),
      gate: (fn, candidates, responsive) => this.gateRun(fn, candidates, responsive, record.id),
      beforeRun: ({ mode }) => {
        if (!this.prepareRun(record.id)) return false;
        if (mode === "yield-elicitation") return true;
        if (!this.inboxStore) return true;
        const actor = this.runs.liveActor(record.id);
        const watermark = actor?.getInterruptedWatermark?.();
        if (watermark) {
          const entries = this.inboxStore.list(record.id, { status: "unhandled" }).entries;
          return entries.some((e) => e.deliveredAt > watermark);
        }
        return this.inboxStore.countUnhandled(record.id) > 0;
      },
      admitRun: ({ responsive, mode }) =>
        responsive || mode !== "ordinary" || !this.isVoiceSessionActive(record.id),
      onRuntimeStateChanged: (state) => this.actorRuntimeStateChanged(record.id, state),
      onQueuedRunCancelled: () => this.clearSelection(record.id),
    };
  }

  /** Record per-run token usage for accounting. */
  accountRun(actorId: string, result: RunResult, runId?: string): void {
    if (!result.tokenUsage) return;
    if (!runId) {
      throw new Error(`token accounting requires a runId for actor ${actorId}`);
    }
    const usage = result.tokenUsage;
    try {
      getDb()
        .prepare(
          `INSERT INTO run_token_records
            (id, run_id, provider, model, scraped_at, uncached_input, cache_read, output, reasoning, response)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          runId,
          usage.provider,
          usage.model,
          usage.scrapedAt,
          usage.uncachedInput,
          usage.cacheRead,
          usage.output,
          usage.reasoning,
          usage.response
        );
    } catch (err) {
      this.log(
        `token accounting write failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Who should hear that a scheduled message will never arrive: the sender if
   * it's genuinely live, else its nearest live ancestor.
   *
   * "Live" here is {@link isActiveActor}, narrower than `status === "active"`:
   * notifying an ancestor unwinding its own retire would post into an actor
   * that is about to be closed — the notification is accepted and then
   * destroyed, which looks identical to delivering it.
   *
   * The walk can't stop at the first parent for the same reason: when a whole
   * subtree goes down, that parent is usually mid-retire too.
   */
  private resolveDropNotifyTarget(fromId: string): string | null {
    if (this.isActiveActor(fromId)) return fromId;

    const seen = new Set<string>([fromId]);
    let next = this.actors.get(fromId)?.parentId;
    while (next && !seen.has(next)) {
      if (this.isActiveActor(next)) return next;
      seen.add(next);
      next = this.actors.get(next)?.parentId;
    }
    return null;
  }

  private notifyScheduledDeliveryDropped(toId: string, scheduled: ScheduledMessage): void {
    const notifyTarget = this.resolveDropNotifyTarget(scheduled.fromId);

    if (notifyTarget) {
      this.deliverMechanicalInboxNotice(
        notifyTarget,
        `[scheduled message dropped] recipient ${toId} retired before delivery: ${scheduled.body.slice(0, 800)}`,
        MESH_SYSTEM,
        {
          runId: toId,
          actorId: toId,
          originalFromId: scheduled.fromId,
          pendingMessageId: scheduled.id,
        },
        `${scheduled.id}:dropped`
      );
    }
  }

  deliverScheduledMessage(scheduled: ScheduledMessage): void {
    const { id: messageId, toId } = scheduled;
    // Heal the only cross-system crash window: the host job is installed
    // before acceptance history is committed so a failed DB transaction can
    // still be rolled back by cancelling the job. If the process dies between
    // those steps, the complete payload in `at` can recreate the stable-id chat
    // and sent-event rows before delivery. Normal callbacks simply hit the
    // repositories' INSERT-OR-IGNORE path.
    this.withTransaction(() => this.recordScheduledMessageSent(scheduled));
    const rec = this.actors.get(toId);
    if (!rec || rec.status !== "active") {
      this.log(`scheduled delivery ${messageId} for ${toId} dropped — recipient retired`);
      this.notifyScheduledDeliveryDropped(toId, scheduled);
      return;
    }

    // The endpoint may be retried by curl. Both the inbox entry and event use
    // the message's stable id, so repeated callbacks converge without a local
    // pending-message row.
    this.recordScheduledMessageReceived(scheduled);
    if (this.inboxStore) {
      this.inboxStore.append([
        {
          id: messageId,
          actorId: toId,
          source: `mesh:${scheduled.fromId}`,
          payload: {
            type: "mesh.scheduled_message",
            messageId,
            fromId: scheduled.fromId,
            sessionId: scheduled.sessionId,
          },
        },
      ]);
      this.dispatch(toId);
      return;
    }

    const target = this.runs.liveActor(toId);
    if (!target) throw new Error(`scheduled delivery target ${toId} is not available`);
    target.requestRun();
  }

  /**
   * Scheduled messages visible to an actor, used by the MCP projection.
   *
   * The id leads: it is the only handle on a pending message, so an actor that
   * has to cancel one — because retirement refused until it did (#191) — can
   * name the exact message rather than describing it.
   */
  listPendingMessagesFor(actorId: string): Array<{
    messageId: string;
    recipient: string;
    sender: string;
    deliverAt: string;
    body: string;
  }> {
    return (this.scheduledMessages?.listMessageDeliveries() ?? [])
      .filter((message) => message.fromId === actorId || message.toId === actorId)
      .map((message) => ({
        messageId: message.id,
        recipient: message.toId,
        sender: message.fromId,
        deliverAt: message.deliverAt,
        body: message.body,
      }));
  }
}
