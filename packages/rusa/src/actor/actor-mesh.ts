import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { HUMAN_OPERATOR, isHumanOperator, isSystemActor, MESH_SYSTEM } from "../mcp/stamp.js";
import type { CodingProvider, RunResult } from "../providers/types.js";
import {
  type CapabilityGrantStore,
  InMemoryCapabilityGrantStore,
  PARENT_GRANTABLE_CAPABILITIES,
} from "./capability-grants.js";
import {
  ConcurrencyLimiter,
  RunStartCancelledError,
  type RunStartHandle,
} from "./concurrency-limiter.js";
import {
  type EventResource,
  type EventSubscription,
  type EventSubscriptionStore,
  InMemoryEventSubscriptionStore,
  parentOf,
  resourceKey,
  sameResource,
} from "./event-subscriptions.js";
import { generateHandle } from "./handle-generator.js";
import type { InboxEntry, InboxPayload, InboxStore } from "./inbox-store.js";
import {
  DROPPED_MESSAGE_DETAIL,
  type MeshEventSink,
  NOOP_MESH_EVENT_SINK,
  RUN_TERMINAL_EVENT_KINDS,
} from "./mesh-events.js";
import type {
  ActorBudget,
  ActorHandle,
  ContextConfig,
  PendingMessageDelivery,
  ThreadRecord,
  ThreadRegistry,
  ThreadStatus,
} from "./thread-registry.js";
import type { ActorRunMode, RunNudge } from "./trigger-runner.js";

/** `from` attributed to a mechanical (cron-driven) wake delivery — not a peer actor. */
export const SCHEDULER_SENDER_ID = "scheduler";

/** Runtime contract the mesh needs for routing; provider-backed Actor is one implementation. */
export interface MeshActor {
  readonly id: string;
  requestRun(nudge?: RunNudge): void;
  declareYield(status?: string): void;
  markUnkillable(): void;
  close(): void;
  readonly isRunning: boolean;
  readonly isQueued?: boolean;
  readonly isYielded?: boolean;
  cancelQueuedRun?(): boolean;
  resumeCancelledRun?(): boolean;
  interrupt?(by?: string): { interrupted: boolean; runStartTime?: Date; wasQueued?: boolean };
  getInterruptedWatermark?(): Date | null;
  clearInterruptWatermark?(): void;
  setProvider?(provider: CodingProvider): void;
  getProvider?(): CodingProvider;
}

export interface SpawnRequest {
  /** What the new actor owns — authored by the spawning message (B.5). */
  charter: string;
  /** The spawning actor's id (becomes the child's parent + gets a handle to the child). */
  parentId: string;
  /** Coding harness for the child (a `providers` key). Required . */
  provider: string;
  /** Model/tier id for the child's provider. Required . */
  model: string;
  /** Working-memory ownership and portable-context policy. Missing means native. */
  context?: ContextConfig;
  /** Peers to seed the child's address book with (introductions at birth). */
  handles?: ActorHandle[];
  /** Optional lease bounding the child's subtree (Part E). */
  budget?: ActorBudget;
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
  | { delivered: false; status?: ThreadStatus };

/**
 * One thread's in-flight run.
 *
 * A run has no identity of its own in this mesh — everywhere a `runId` is carried it
 * holds the ACTOR's id (see the mechanical inbox forensics and the failure sink). So
 * the thread id plus its phase is the most specific name a run has here, and it is what
 * the retire refusal reports.
 */
export interface ActiveRunState {
  actorId: string;
  /** `running` = inside the provider call; `winding_down` = yielded but process still living; `queued` = past its gate, awaiting admission. */
  phase: "running" | "queued" | "winding_down";
}

export interface RetireOptions {
  /**
   * Complete override: retire immediately even if a run in the subtree is actively running.
   * Operator / root-control / internal teardown only.
   */
  force?: boolean;
  /**
   * Retire even if runs in the subtree are queued (cancelling the queued runs),
   * but still refuse if any thread in the subtree is actively running.
   */
  forceQueued?: boolean;
}

/** Human-readable subject line for a retire refusal — see {@link ActorMesh.retire}. */
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
  /** The record at spawn time. Use {@link getRecord} for the *current* state. */
  record: ThreadRecord;
  /** Read the live record (charter + handles can change between wakes). */
  getRecord: () => ThreadRecord | undefined;
  mesh: ActorMesh;
  /**
   * Wrap the provider run in the shared cross-actor concurrency gate. The
   * actor supplies its provider; consumers that do not care can ignore it.
   */
  gate: <T>(fn: () => Promise<T>, provider: string, responsive: boolean) => RunStartHandle<T>;
  /** Lease check run before each wake; returns false (and retires) when exhausted. */
  beforeRun: (context: { mode: ActorRunMode }) => boolean;
  /** General lifecycle hook after the pre-run gate and before scheduler admission. */
  onQueued: (context: { responsive: boolean; mode: ActorRunMode }) => void;
  /** Post-run accounting (budget) + completion-review hook. */
  onRunEnd: (result: RunResult) => void;
}

export type ActorFactory = (ctx: ActorFactoryContext) => MeshActor;

export interface EventDeliveryOptions {
  directedTarget?: string | null;
  stampedAuthor?: { actorId: string; instanceId: string } | null;
  instanceId?: string;
  /** When present, persist one notification per destination before waking it. */
  inboxPayload?: InboxPayload;
  /** Stable ingress id; combined with actor identity to make retries no-ops. */
  inboxDedupeKey?: string;
  inboxDeliveredAt?: Date;
  inboxPriority?: "responsive" | "normal";
}

/**
 * Whether an event is important enough to climb from its exact resource to a
 * broader subscriber when no live exact subscriber exists .
 *
 * Exact subscriptions do not consult this policy. Keep the list closed: an
 * unknown event remains deliverable to an exact subscriber but is not allowed
 * to wake a repo/org (or chat-root) owner as a fallback.
 */
function mayBubbleToParent(
  eventType: string | undefined,
  eventMerged: boolean | undefined
): boolean {
  switch (eventType) {
    case "issues.opened":
    case "issue_comment.created":
    case "pull_request.opened":
    case "pull_request_review.submitted":
    case "pull_request_review_comment.created":
    case "check_suite.completed":
    case "gchat.message":
      return true;
    case "pull_request.closed":
      return eventMerged === true;
    default:
      return false;
  }
}

export interface RetireCleanup {
  name: string;
  /**
   * Physical teardown that would destroy in-flight work must wait for the
   * actor's active run to emit its matching run_end.
   */
  deferUntilRunEnd?: boolean;
  run: (record: ThreadRecord) => void | Promise<void>;
}

export interface ActorMeshOptions {
  registry: ThreadRegistry;
  /** This account/subtree's root id. Also backs the grandfathered `"root"` address alias. */
  rootId?: string;
  /** Builds a live Actor for a thread record (resolves provider/cwd/mcp/session). */
  createActor: ActorFactory;
  /** Synchronous gate run before a spawn id or durable record is created. */
  validateSpawn?: (req: SpawnRequest) => void;
  /** Synchronous validator before setting an actor's model in-place . */
  validateModel?: (record: ThreadRecord, newModel: string, newProvider?: string) => void;
  /** Cross-actor concurrency cap for non-responsive runs (default 4). */
  maxConcurrent?: number;
  /**
   * Legacy promise-only rate gate. New runtime wiring should use
   * {@link providerGate}; retained for embedders that do not need promotion.
   */
  rateLimit?: <T>(fn: () => Promise<T>, provider: string) => Promise<T>;
  /** Provider pacing composed with the mesh's normal-run concurrency queue. */
  providerGate?: <T>(
    fn: () => Promise<T>,
    provider: string,
    opts: {
      responsive: boolean;
      /** Owning actor, retained only for scheduler observability. */
      threadId?: string;
      enqueueNormal: <R>(run: () => Promise<R>) => RunStartHandle<R>;
    }
  ) => RunStartHandle<T>;
  /**
   * Mesh-wide emergency brake consulted in every worker's `beforeRun`: when it
   * returns true the run is skipped (and, being a skip, won't self-continue), so
   * the mesh quiesces within one run-cycle. Defaults to never-halted.
   */
  isHalted?: (provider?: string) => boolean;
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
  onRetire?: (record: ThreadRecord) => void;
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
  onSpawn?: (record: ThreadRecord) => void;
  /**
   * Called once per actor as it's revived (after its record is marked active,
   * before the live actor is re-instantiated), for out-of-band side effects the
   * mesh doesn't own — e.g. recreating the actor's working directory.
   */
  onRevive?: (record: ThreadRecord) => void;
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
   * Called after a thread's model is durably updated in the registry ,
   * for live resource / provider updating on the active actor.
   */
  onModelSet?: (actorId: string, newModel: string, record: ThreadRecord) => void;
  /**
   * Per-actor durable-registration cleanup hooks run during retire. Each hook is
   * failure-isolated so one broken teardown cannot stop the rest of the cascade.
   */
  retireCleanups?: RetireCleanup[];
  events?: MeshEventSink;
  /** Durable record store for message content. */
  recordChat?: (opts: {
    senderId: string;
    recipientId: string;
    body: string;
    sessionId?: string;
  }) => string;
  /**
   * Durable store of per-actor capability grants (ISSUE_NUM, phase 1a). Defaults to an
   * in-memory store; the wiring supplies a file-backed one. Only the root grants
   * (enforced at the tool layer), and only allow-listed capabilities can be
   * granted (see {@link grantableCapabilities}).
   */
  capabilityGrants?: CapabilityGrantStore;
  eventSubscriptions?: EventSubscriptionStore;
  /** Durable actor inbox used for singleton wake recovery. Optional for isolated tests. */
  inboxStore?: InboxStore;
  /** General lifecycle hook matching onYield. */
  onQueued?: (actorId: string, context: { responsive: boolean; mode: ActorRunMode }) => void;
  /** Best-effort receipts for entries first accepted into an execution opportunity. */
  onInboxEntriesSeen?: (actorId: string, entries: readonly InboxEntry[]) => void;
  /**
   * The allow-list of grantable capability names — typically the keys of the
   * wiring's grantable-MCP registry. A grant of any name outside this set is
   * rejected, bounding what the primitive can ever hand out. Defaults to empty.
   */
  grantableCapabilities?: ReadonlySet<string>;
  log?: (msg: string) => void;
}

/**
 * The actor scheduler (design Part D — the v2 pump repurposed). It owns the
 * thread {@link ThreadRegistry} (durable records) and the set of *live* actors,
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
 * Per-actor serialization comes from each actor's TriggerRunner; cross-actor
 * concurrency is bounded by a shared {@link ConcurrencyLimiter}.
 */
export class ActorMesh {
  readonly registry: ThreadRegistry;
  private readonly createActor: ActorFactory;
  private readonly validateSpawn?: (req: SpawnRequest) => void;
  private readonly validateModel?: (
    record: ThreadRecord,
    newModel: string,
    newProvider?: string
  ) => void;
  private readonly limiter: ConcurrencyLimiter;
  private readonly providerGate: NonNullable<ActorMeshOptions["providerGate"]>;
  private readonly isHalted: (provider?: string) => boolean;
  private readonly isShuttingDown: () => boolean;
  private readonly idgen: () => string;
  private readonly now: () => string;
  private readonly handleForId: (id: string) => string;
  private readonly rootId?: string;
  private readonly onRetire?: (record: ThreadRecord) => void;
  private readonly onYield?: (
    actorId: string,
    ctx: { notifyingParent: boolean }
  ) => string | null | undefined;
  private readonly onSpawn?: (record: ThreadRecord) => void;
  private readonly onRevive?: (record: ThreadRecord) => void;
  private readonly onCapabilityGranted?: (actorId: string, capability: string) => void;
  private readonly onCapabilityRevoked?: (
    actorId: string,
    capability: string
  ) => Promise<void> | void;
  private readonly onModelSet?: (actorId: string, newModel: string, record: ThreadRecord) => void;
  private readonly retireCleanups: RetireCleanup[];
  private readonly events: MeshEventSink;
  private readonly recordChat?: (opts: {
    senderId: string;
    recipientId: string;
    body: string;
    sessionId?: string;
  }) => string;
  private readonly grants: CapabilityGrantStore;
  private readonly eventSubscriptions: EventSubscriptionStore;
  private readonly inboxStore?: InboxStore;
  private readonly onQueued?: ActorMeshOptions["onQueued"];
  private readonly onInboxEntriesSeen?: ActorMeshOptions["onInboxEntriesSeen"];
  private readonly grantable: ReadonlySet<string>;
  private readonly log: (msg: string) => void;
  private readonly live = new Map<string, MeshActor>();
  private readonly activeRunCounts = new Map<string, number>();
  private readonly deferredRetireCleanups = new Map<
    string,
    { record: ThreadRecord; cleanups: RetireCleanup[] }
  >();
  private readonly pendingDeliveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly selectedInboxEntryIds = new Map<string, string[]>();
  /**
   * Ids whose {@link retire} is currently unwinding. A subtree retire recurses
   * into children *before* marking itself retired, so an ancestor mid-retire
   * still reads `status: "active"` in the registry — see
   * {@link resolveDropNotifyTarget}, which must not hand a notification to one.
   */
  private readonly retiring = new Set<string>();

  constructor(opts: ActorMeshOptions) {
    this.registry = opts.registry;
    this.rootId = opts.rootId;
    this.createActor = opts.createActor;
    this.validateSpawn = opts.validateSpawn;
    this.validateModel = opts.validateModel;
    this.grants = opts.capabilityGrants ?? new InMemoryCapabilityGrantStore();
    this.eventSubscriptions = opts.eventSubscriptions ?? new InMemoryEventSubscriptionStore();
    this.inboxStore = opts.inboxStore;
    this.onQueued = opts.onQueued;
    this.onInboxEntriesSeen = opts.onInboxEntriesSeen;
    this.grantable = opts.grantableCapabilities ?? new Set();
    this.limiter = new ConcurrencyLimiter(opts.maxConcurrent ?? 4);
    this.providerGate =
      opts.providerGate ??
      ((fn, provider, admissionOpts) => {
        if (opts.rateLimit) {
          const result = opts.rateLimit(
            () => (admissionOpts.responsive ? fn() : admissionOpts.enqueueNormal(fn).result),
            provider
          );
          return { result, started: false, promote: () => {}, cancel: () => false };
        }
        return admissionOpts.responsive ? immediateStart(fn) : admissionOpts.enqueueNormal(fn);
      });
    this.isHalted = opts.isHalted ?? (() => false);
    this.isShuttingDown = opts.isShuttingDown ?? (() => false);
    this.idgen = opts.idgen ?? (() => randomUUID());
    this.now = opts.now ?? (() => new Date().toISOString());
    this.handleForId = opts.handleForId ?? generateHandle;
    this.onRetire = opts.onRetire;
    this.onYield = opts.onYield;
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
    this.log = opts.log ?? (() => {});
  }

  /** Standardized message emission for the ISSUE_NUM spine. */
  recordMessageEmitted(opts: {
    fromId: string;
    toId: string;
    body: string;
    sessionId?: string;
    isDrop: boolean;
  }): string | undefined {
    const fromId = this.resolveThreadId(opts.fromId);
    const toId = this.resolveThreadId(opts.toId);
    let msgId: string | undefined;
    if (this.recordChat) {
      try {
        msgId = this.recordChat({
          senderId: fromId,
          recipientId: toId,
          body: opts.body,
          sessionId: opts.sessionId,
        });
      } catch (err) {
        this.log(`recordChat failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.recordEvent({
      kind: "message_sent",
      actorId: fromId,
      detail: opts.sessionId ?? (opts.isDrop ? DROPPED_MESSAGE_DETAIL : undefined),
      payload: msgId ? JSON.stringify({ messageId: msgId, to: toId }) : undefined,
    });

    if (!opts.isDrop) {
      this.recordEvent({
        kind: "message_received",
        actorId: toId,
        detail: opts.sessionId,
        payload: msgId ? JSON.stringify({ messageId: msgId, from: fromId }) : undefined,
      });
    }
    return msgId;
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
   * Register an externally-created actor (the root) so the mesh can route
   * messages to it and the registry knows it exists. Idempotent on the record.
   *
   * The wiring rebuilds `record` fresh on every boot : it carries the
   * current config/session but not the durable fields the mesh itself owns —
   * `pendingDeliveries`, etc. A blind
   * `upsert` would silently wipe those out from underneath boot reconciliation
   * on every restart. Merge onto any existing persisted record instead,
   * so `record`'s fields win but everything else survives.
   */
  adopt(record: ThreadRecord, actor: MeshActor): void {
    const existing = this.registry.get(record.id);
    this.registry.upsert(existing ? { ...existing, ...record } : record);
    this.live.set(record.id, actor);
  }

  /**
   * Recreate the live {@link Actor} for an existing record — boot restore for
   * threads the registry persisted across a restart. Unlike {@link spawn} it
   * mints no record, grants no handle, and does **not** wake the actor: waking it
   * with no reason would be a phantom run. No-op if it's already live or not
   * active (retired threads stay dead).
   *
   * Rehydration alone does not wake: after all active actors are live, boot-time
   * inbox reconciliation nudges actors with durable work.
   */
  rehydrate(record: ThreadRecord): void {
    if (this.live.has(record.id)) return; // already live (e.g. the adopted root)
    if (record.status !== "active") return; // don't revive retired threads
    try {
      const actor = this.createActor(this.factoryContext(record));
      this.live.set(record.id, actor);
      this.log(`rehydrated ${record.id} (parent ${record.parentId})`);
    } catch (err) {
      this.log(
        `rehydrate(${record.id}) failed, skipping: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Rehydrate every active thread the registry knows about. Call once on boot
   * *after* the root is adopted, so a worker's parent is live before the worker
   * is. Already-live (root) and retired records are skipped.
   */
  rehydrateAll(): void {
    for (const record of this.registry.list()) this.rehydrate(record);
  }

  /** Boot recovery: re-arm timers for scheduled messages, and fire overdue ones immediately. */
  reconcilePendingDeliveries(): void {
    for (const record of this.registry.list()) {
      if (record.status !== "active") continue;
      if (!record.pendingDeliveries?.length) continue;
      for (const msg of record.pendingDeliveries) {
        this.armPendingDelivery(record.id, msg);
        this.log(`re-armed scheduled message ${msg.id} for ${record.id} at ${msg.deliverAt}`);
      }
    }
  }

  /** Boot recovery: nudge each live actor with durable unhandled work at most once. */
  reconcileInbox(): void {
    if (!this.inboxStore) return;
    try {
      for (const work of this.inboxStore.actorsWithUnhandled()) {
        const record = this.registry.get(work.actorId);
        if (record && record.status !== "active") continue;
        this.notifyInboxChanged(work.actorId, { priority: work.priority });
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
        const record = this.registry.get(work.actorId);
        if (record && record.status !== "active") continue;
        this.notifyInboxChanged(work.actorId, { priority: work.priority });
      }
    } catch (err) {
      this.log(
        `unseen inbox reconciliation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Returns the obligationId of the most recent ready-head attention entry delivered to this actor, or null if none.
   */
  private getLatestDeliveredHeadId(actorId: string): string | null {
    if (!this.inboxStore) return null;
    let cursor: string | undefined;
    while (true) {
      const page = this.inboxStore.list(actorId, { status: "all", limit: 100, cursor });
      for (const entry of page.entries) {
        if (entry.payload?.type === "obligation.ready_head") {
          return (entry.payload.obligationId as string) ?? null;
        }
        if (entry.source.startsWith("obligation:")) {
          return entry.source.slice("obligation:".length);
        }
      }
      if (!page.nextCursor || page.entries.length === 0) break;
      cursor = page.nextCursor;
    }
    return null;
  }

  /**
   * Boot recovery for ready-head inbox attention (#1645).
   *
   * Verifies that every active actor with a ready head has durable attention in
   * its inbox. If attention for the current ready head is absent (e.g. due to
   * process crash or listener failure during obligation commit), delivers it.
   * If attention for the head was already delivered, no duplicate entry is created.
   */
  reconcileReadyHeads(obligations: {
    readyHeads(): Iterable<[string, string]>;
    get(id: string): { id: string; intent: string | null } | null;
  }): void {
    if (!this.inboxStore) return;
    try {
      for (const [ownerId, headId] of obligations.readyHeads()) {
        if (ownerId.startsWith("human:") || ownerId.startsWith("system:")) continue;
        const actorId = this.resolveThreadId(ownerId);
        const record = this.registry.get(actorId);
        if (!record || record.status !== "active") continue;

        const unhandled = this.inboxStore.list(actorId, {
          source: `obligation:${headId}`,
          status: "unhandled",
        });
        if (unhandled.entries.length > 0) continue;

        const latestDeliveredHeadId = this.getLatestDeliveredHeadId(actorId);
        if (latestDeliveredHeadId === headId) continue;

        const head = obligations.get(headId);
        if (!head) continue;
        this.deliverReadyHeadAttention(
          actorId,
          { id: head.id, intent: head.intent },
          latestDeliveredHeadId
        );
      }
    } catch (err) {
      this.log(
        `ready-head reconciliation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Notify an actor that its durable worklist changed. If an execution
   * opportunity is already queued, the new entry joins it and becomes seen
   * immediately; only deliveries during an active run set the dirty follow-up.
   */
  notifyInboxChanged(actorId: string, nudge: RunNudge = {}): boolean {
    actorId = this.resolveThreadId(actorId);
    const rec = this.registry.get(actorId);
    if (rec && rec.status !== "active") {
      this.log(`inbox_changed for ${actorId} not nudged — actor is retired`);
      return false;
    }
    const target = this.live.get(actorId);
    if (!target) {
      this.log(`inbox_changed for ${actorId} not nudged — no live actor`);
      return false;
    }
    if (target.isQueued) {
      this.markInboxSeen(actorId);
      target.requestRun(nudge);
      return true;
    }
    target.requestRun(nudge);
    return true;
  }

  /** Lifecycle boundary after the halt gate and before scheduler admission. */
  actorQueued(actorId: string, context: { responsive: boolean; mode: ActorRunMode }): InboxEntry[] {
    actorId = this.resolveThreadId(actorId);
    this.selectedInboxEntryIds.delete(actorId);
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

  /** Establish the run-scoped subset that may be marked handled. */
  selectInboxEntries(actorId: string, entryIds: string[]): InboxEntry[] {
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
      return entry;
    });
    this.selectedInboxEntryIds.set(actorId, unique);
    return entries;
  }

  selectedInboxEntries(actorId: string): readonly string[] {
    actorId = this.resolveThreadId(actorId);
    return this.selectedInboxEntryIds.get(actorId) ?? [];
  }

  finishInboxRun(actorId: string): void {
    actorId = this.resolveThreadId(actorId);
    this.selectedInboxEntryIds.delete(actorId);
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
   * A restart or a replay of the same committed transition is still silent.
   * The residual case — the identical transition recurring after the actor
   * handled it — cannot be expressed in the id, and falls back to a live nudge:
   * it wakes a running mesh but is not durable across a restart.
   */
  deliverReadyHeadAttention(
    actorId: string,
    head: { id: string; intent: string | null },
    previousHeadId: string | null = null
  ): boolean {
    actorId = this.resolveThreadId(actorId);
    if (!this.inboxStore) return false;
    const record = this.registry.get(actorId);
    if (!record || record.status !== "active") return false;
    const entryId = deduplicatedInboxEntryId(
      `obligation-head:${actorId}:${previousHeadId ?? "none"}->${head.id}`,
      actorId
    );
    const entries = this.inboxStore.append([
      {
        id: entryId,
        actorId,
        source: `obligation:${head.id}`,
        payload: {
          type: "obligation.ready_head",
          obligationId: head.id,
          intent: head.intent ?? undefined,
        } as unknown as InboxPayload,
      },
    ]);
    if (entries.length === 0) {
      // Already delivered for this exact transition. While it is still
      // unhandled the wake is outstanding and a second entry is only noise;
      // once handled, the head has come back the same way it came the first
      // time, so nudge rather than going silent.
      if (this.inboxStore.read(actorId, entryId)?.handledAt) this.notifyInboxChanged(actorId);
      return false;
    }
    this.notifyInboxChanged(actorId);
    return true;
  }

  inboxHandled(actorId: string): void {
    actorId = this.resolveThreadId(actorId);
    if (this.inboxStore && this.inboxStore.countUnhandled(actorId) > 0) {
      this.notifyInboxChanged(actorId);
    }
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
    const provider = req.provider?.trim();
    if (!provider) throw new Error("provider is required");
    const model = req.model?.trim();
    if (!model) throw new Error("model is required");
    this.validateSpawn?.(req);
    const id = this.idgen();
    const parentId = this.resolveThreadId(req.parentId);
    const record: ThreadRecord = {
      id,
      charter,
      parentId,
      provider,
      model,
      context: req.context,
      handles: req.handles ? [...req.handles] : undefined,
      // Seed the session so the actor's first run resumes this conversation
      // instead of creating a fresh one (loadSessionId reads record.sessionId).
      sessionId: req.conversationId,
      title: req.title,
      status: "active",
      budget: req.budget ? { ...req.budget, runsUsed: req.budget.runsUsed ?? 0 } : undefined,
      createdAt: this.now(),
    };
    this.registry.upsert(record);
    // Spawning grants the parent a handle to the child, so it can message it.
    // No role — the parent authored the charter, so the child's charter is the
    // truthful label (resolved at prompt time).
    this.grantHandle(parentId, { id });
    let actor: MeshActor;
    try {
      actor = this.createActor(this.factoryContext(record));
    } catch (err) {
      this.revokeHandle(parentId, id);
      this.registry.patch(id, { status: "retired" });
      throw err;
    }
    this.live.set(id, actor);
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
      body: `provider=${provider} model=${model}`,
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
    const rec = this.registry.get(toId);
    if (!rec) return;
    if (handle.id === toId) return; // don't hand an actor its own handle
    const entry: ActorHandle = handle.role
      ? { id: handle.id, role: handle.role }
      : { id: handle.id };
    const handles = (rec.handles ?? []).filter((h) => h.id !== handle.id);
    handles.push(entry);
    this.registry.patch(toId, { handles });
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
    const rec = this.registry.get(toId);
    if (!rec) return;
    const current = rec.handles ?? [];
    const handles = current.filter((h) => h.id !== targetId);
    if (handles.length === current.length) return;
    this.registry.patch(toId, { handles });
  }

  /**
   * Whether `actorId` is the mesh's root — explicit `isRoot` flag .
   * Decoupled from `parentId == null` (which represents top-level topology).
   */
  private isRootActor(actorId: string): boolean {
    const record = this.registry.get(actorId);
    return record?.isRoot === true;
  }

  /** Resolve the legacy root address without making the literal id an authority signal. */
  private resolveThreadId(actorId: string): string {
    return actorId === "root" && this.rootId ? this.rootId : actorId;
  }

  /**
   * Grantor authorization for {@link grantCapability}/{@link revokeCapability}
   * . Root may grant/revoke anything grantable, as before. A non-root
   * grantor may only touch capabilities in {@link PARENT_GRANTABLE_CAPABILITIES}
   * and only where the grantee is its DIRECT child (the registry's `parentId`
   * edge). Enforced HERE — the mesh layer — not just at the tool layer, so the
   * invariant holds for any future caller. Fail-closed: an unknown grantor is
   * never root.
   */
  private assertGrantAuthority(
    grantorId: string,
    granteeId: string,
    capability: string,
    verb: "grant" | "revoke"
  ): void {
    const grantee = this.registry.get(granteeId);
    if (!grantee) {
      throw new Error(`unknown thread id: ${granteeId}`);
    }
    if (this.isRootActor(grantorId)) {
      if (grantorId === granteeId || this.isAncestorOf(grantorId, granteeId)) return;
      throw new Error(
        `root ${grantorId} may only ${verb} capabilities in its own subtree (cannot ${verb} ${granteeId})`
      );
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
    if (!PARENT_GRANTABLE_CAPABILITIES.has(baseCapability)) {
      throw new Error(
        `only the root may ${verb} ${capability}; a non-root parent may only ${verb}: ${
          [...PARENT_GRANTABLE_CAPABILITIES].join(", ") || "none"
        }`
      );
    }
    if (grantee.parentId !== grantorId) {
      throw new Error(
        `a non-root actor may only ${verb} ${capability} to/from its direct children; ${granteeId} is not a child of ${grantorId}`
      );
    }
  }

  /**
   * Grant an extra `capability` to a specific actor by id (ISSUE_NUM, phase 1a).
   * We enforce the allow-list so the primitive can never hand out a capability
   * the wiring didn't mark grantable, plus grantor authorization : root
   * may grant anything grantable; a non-root grantor only a
   * {@link PARENT_GRANTABLE_CAPABILITIES} capability, and only to its direct
   * children. Idempotent per (actorId, capability). MCP-server grants take effect
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
    if (!this.grantable.has(baseCapability)) {
      throw new Error(
        `not a grantable capability: ${capability} (grantable: ${[...this.grantable].join(", ") || "none"})`
      );
    }
    this.assertGrantAuthority(grantedBy, actorId, capability, "grant");
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
   * grantor authorization as {@link grantCapability} : root revokes
   * anything; a non-root `revokedBy` only a parent-grantable capability from a
   * direct child. No-op on the store if not active, but the unmount hook still
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

  /** Every grant, active and revoked — for the root's `list_grants` tool + audit. */
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
    return this.eventSubscriptions
      .activeForResource(resource)
      .some((subscription) => subscription.actorId === actorId);
  }

  private resolveLiveEventDestinations(
    resource: EventResource,
    opts: {
      ignoreExactResource?: EventResource;
      eventPayload?: InboxPayload;
      enforceBubblingPolicy?: boolean;
    } = {}
  ): string[] {
    const destinations: string[] = [];
    let current: EventResource | undefined = resource;

    // Atomicity Invariant: The check `this.live.has(sub.actorId)` and the delivery
    // via `requestRun` happen in the same synchronous section with no await.
    while (current) {
      const activeSubs = this.eventSubscriptions.activeForResource(current);
      for (const sub of activeSubs) {
        if (
          opts.ignoreExactResource &&
          sameResource(sub.resource, opts.ignoreExactResource) &&
          sameResource(current, opts.ignoreExactResource)
        ) {
          continue;
        }
        if (this.live.has(sub.actorId) && !destinations.includes(sub.actorId)) {
          destinations.push(sub.actorId);
        }
      }
      if (destinations.length > 0) {
        break;
      }
      // Event-class policy gates only the first parent climb. Once an
      // allowlisted event may bubble, the existing walk may continue past dead
      // intermediate subscribers to the first live ancestor owner.
      if (sameResource(current, resource) && opts.enforceBubblingPolicy) {
        const allowParent = mayBubbleToParent(
          opts.eventPayload?.type,
          opts.eventPayload?.merged === true
        );
        if (!allowParent) {
          break;
        }
      }
      current = parentOf(current);
    }

    return destinations;
  }

  private effectiveOwnerOf(
    resource: EventResource,
    opts: { ignoreExactResource?: EventResource } = {}
  ): string | undefined {
    return this.resolveLiveEventDestinations(resource, opts)[0];
  }

  /**
   * Subscribe an actor to an event source. Records an audit event.
   * Throws if another actor is already actively subscribed to the event source.
   */
  subscribeEventSource(
    resource: EventSubscription["resource"],
    actorId: string,
    subscribedBy: string
  ): void {
    actorId = this.resolveThreadId(actorId);
    subscribedBy = this.resolveThreadId(subscribedBy);
    const subscription: EventSubscription = {
      resource,
      actorId,
      subscribedBy,
      subscribedAt: this.now(),
    };
    this.eventSubscriptions.subscribe(subscription);
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
    const child = this.registry.get(childThreadId);
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

    // Mechanical creator subscriptions  make it common for the delegator
    // to hold the exact active subscription it is handing off; release it first
    // (mirroring reclaimEventSource) so the store's one-active-subscriber
    // invariant admits the child.
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

    const current = this.eventSubscriptions.activeForResource(resource)[0];
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
  unsubscribeEventSource(
    resource: EventSubscription["resource"],
    actorId: string,
    at: string
  ): void {
    actorId = this.resolveThreadId(actorId);
    this.eventSubscriptions.unsubscribe(resource, actorId, at);
    this.recordEvent({
      kind: "event_source_unsubscribed",
      actorId,
      detail: resourceKey(resource),
      body: `at=${at}`,
    });
  }

  /**
   * List all subscriptions (both active and inactive) for audit.
   */
  listSubscriptions(): EventSubscription[] {
    return this.eventSubscriptions.list();
  }

  /**
   * Resolve the active subscriber for a hierarchy-aware EventResource, checking liveness,
   * and delivering to the most-specific live subscriber. An allowlisted event may bubble
   * up the ancestor chain past dead/absent exact subscribers; every other class is exact-only.
   * An event no subscription covers is DROPPED (journal-visible):
   * sources are config-declared , so an uncovered event is out-of-scope for this
   * instance by definition — unconditional bubbling to root turned the repo-scoped staging
   * instance back into an org-wide firehose . A covering org source is considered only
   * for the event classes explicitly allowed by {@link mayBubbleToParent} .
   * Follows the CRITICAL invariant of checking liveness and delivering synchronously.
   */
  async deliverEvent(
    resource: EventResource,
    eventSummary: string,
    opts: EventDeliveryOptions = {}
  ): Promise<void> {
    let destinations: string[];
    let directed = false;
    if (opts.directedTarget) {
      const directedTarget = this.resolveLiveActor(opts.directedTarget);
      if (directedTarget) {
        this.log(`mesh:deliver directed-delivered to ${opts.directedTarget} (${eventSummary})`);
        destinations = [directedTarget.id];
        directed = true;
      } else {
        this.log(`mesh:deliver target not live: ${opts.directedTarget} — directive ignored`);
        destinations = this.resolveLiveEventDestinations(resource, {
          enforceBubblingPolicy: true,
          eventPayload: opts.inboxPayload,
        });
      }
    } else {
      destinations = this.resolveLiveEventDestinations(resource, {
        enforceBubblingPolicy: true,
        eventPayload: opts.inboxPayload,
      });
    }

    if (destinations.length === 0) {
      // Invariant this drop relies on (ISSUE_NUM review): root retains a covering
      // source for anything it delegates from (config-declared sources persist;
      // delegation only adds child sub-slices). So a live event that's in-scope
      // always matches an ancestor source before reaching here — an uncovered
      // event is genuinely out-of-scope for this instance, and dropping it
      // (journal-visible) is correct rather than a silent loss. If a future
      // change ever lets root delegate away its only covering source for a
      // slice, events under it would hit this drop when the delegate dies —
      // still visible here, but the invariant is what keeps that from happening.
      this.log(`event not covered by any subscription — dropped (${eventSummary})`);
      return;
    }

    // A verified `system:*` stamp marks a persistence-only write performed by
    // mesh infrastructure (e.g. tracker-hygiene) rather than a peer actor — it
    // withholds delivery to EVERY destination, not just an author-match. Only a
    // verified stamp may trigger this (opts.stampedAuthor only exists when
    // resolveStampedAuthor's HMAC + freshness checks passed in start.ts); an
    // unverified or stale system-looking stamp resolves to null upstream and
    // falls through to the ordinary per-destination checks below, so it still
    // fails open and delivers .
    const systemSuppressed =
      !directed &&
      opts.stampedAuthor != null &&
      opts.instanceId !== undefined &&
      isSystemActor(opts.stampedAuthor.actorId) &&
      opts.stampedAuthor.instanceId === opts.instanceId;
    if (systemSuppressed && opts.stampedAuthor) {
      this.log(
        `system-event suppressed by author stamp: actor=${opts.stampedAuthor.actorId} instance=${opts.stampedAuthor.instanceId} (${eventSummary})`
      );
    }

    const deliverable: string[] = [];
    for (const dest of destinations) {
      let suppressed = false;
      if (directed) {
        // A valid bot-authored mesh:deliver directive intentionally targets the
        // actor even though the underlying bot event would otherwise self-suppress.
      } else if (systemSuppressed) {
        suppressed = true;
      } else if (
        opts.stampedAuthor != null &&
        opts.instanceId !== undefined &&
        opts.stampedAuthor.actorId === dest &&
        opts.stampedAuthor.instanceId === opts.instanceId
      ) {
        this.log(
          `self-event suppressed by author stamp: actor=${opts.stampedAuthor.actorId} instance=${opts.stampedAuthor.instanceId} (${eventSummary})`
        );
        suppressed = true;
      }

      if (!suppressed) deliverable.push(dest);
    }

    if (deliverable.length === 0) return;

    if (opts.inboxPayload) {
      if (!this.inboxStore) throw new Error("GitHub inbox delivery requires an inbox store");
      const source = resourceKey(resource);
      const inboxPayload = opts.inboxPayload;
      const entries = this.inboxStore.append(
        deliverable.map((actorId) => ({
          id: opts.inboxDedupeKey
            ? deduplicatedInboxEntryId(opts.inboxDedupeKey, actorId)
            : undefined,
          actorId,
          source,
          deliveredAt: opts.inboxDeliveredAt,
          payload: inboxPayload,
        }))
      );
      for (const entry of entries) {
        const dest = entry.actorId;
        if (!deliverable.includes(dest)) {
          throw new Error(`Inbox append returned an unexpected actor: ${dest}`);
        }
        if (!this.notifyInboxChanged(dest, { priority: opts.inboxPriority })) {
          throw new Error(`Delivery target ${dest} is not live after inbox persistence`);
        }
      }
      return;
    }

    for (const dest of deliverable) {
      if (!this.notifyInboxChanged(dest, { priority: opts.inboxPriority })) {
        this.log(`Delivery target ${dest} is not live; cannot deliver event`);
      }
    }
  }

  private resolveLiveActor(handleOrId: string): MeshActor | undefined {
    handleOrId = this.resolveThreadId(handleOrId);
    const actor = this.live.get(handleOrId);
    if (actor) return actor;

    for (const [id, candidate] of this.live) {
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
    if (isHumanOperator(fromId)) {
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
      if (fromId === toId && delay < 60000) {
        throw new Error(
          `Self-send requires a strictly-future deliver_at (minimum 60s delay), got delay=${delay}ms`
        );
      }
      if (delay > 2073600000) {
        // 24 days
        throw new Error(`deliver_at beyond max horizon (24 days), got delay=${delay}ms`);
      }
      const rec = this.registry.get(toId);
      if (!rec || rec.status !== "active") {
        return { delivered: false, status: rec?.status };
      }
      if ((rec.pendingDeliveries?.length ?? 0) >= 10) {
        throw new Error(
          `Cannot schedule message: recipient ${toId} has reached the cap of 10 pending deliveries.`
        );
      }

      const pending: PendingMessageDelivery = {
        id: randomUUID(),
        fromId,
        body,
        deliverAt,
        sessionId,
      };
      this.registry.patch(toId, {
        pendingDeliveries: [...(rec.pendingDeliveries ?? []), pending],
      });
      this.armPendingDelivery(toId, pending);
      // Record event at fire time, not here, per #4.
      return { delivered: true };
    }

    const rec = this.registry.get(toId);
    if (!rec || rec.status !== "active") {
      this.log(`message to ${toId} from ${fromId} dropped — recipient not active`);
      return { delivered: false, status: rec?.status };
    }

    const target = this.live.get(toId);
    const messageId = this.recordMessageEmitted({
      fromId,
      toId,
      body,
      sessionId,
      isDrop: !target,
    });
    if (!target) {
      this.log(`message to ${toId} from ${fromId} dropped — no live actor`);
      return { delivered: false, status: this.registry.get(toId)?.status };
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
    this.notifyInboxChanged(toId);
    return { delivered: true };
  }

  deliverMechanicalInboxNotice(
    toId: string,
    note: string,
    fromId: string,
    forensics: MechanicalInboxForensics = {}
  ): MessageDeliveryResult {
    if (!this.inboxStore) throw new Error("Mechanical inbox delivery requires an inbox store");
    toId = this.resolveThreadId(toId);
    fromId = this.resolveThreadId(fromId);
    const rec = this.registry.get(toId);
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
    this.inboxStore.append([
      {
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
    this.notifyInboxChanged(toId);
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
    opts?: { voice?: boolean }
  ): MessageDeliveryResult {
    toId = this.resolveThreadId(toId);
    const fromId = HUMAN_OPERATOR;
    const rec = this.registry.get(toId);
    if (!rec || rec.status !== "active") {
      this.log(`message to ${toId} from ${fromId} dropped — recipient not active`);
      return { delivered: false, status: rec?.status };
    }
    this.registry.patch(toId, {
      humanUnlocked: true,
      lastChatSessionId: sessionId,
    });
    const target = this.live.get(toId);
    const messageId = this.recordMessageEmitted({
      fromId,
      toId,
      body,
      sessionId,
      isDrop: !target,
    });
    if (!target) {
      this.log(`message to ${toId} from ${fromId} dropped — no live actor`);
      return { delivered: false, status: this.registry.get(toId)?.status };
    }
    const isVoice = opts?.voice || body.startsWith("🎙️ [voice memo");
    if (this.inboxStore) {
      if (!messageId) throw new Error("Human message delivery requires durable chat storage");
      this.inboxStore.append([
        {
          actorId: toId,
          source: `mesh:${fromId}`,
          payload: {
            type: isVoice ? "human.voice" : "human.message",
            priority: "responsive",
            messageId,
            fromId,
            sessionId,
          },
        },
      ]);
    }
    this.notifyInboxChanged(toId, {
      priority: "responsive",
      voiceTimestamp: isVoice ? Date.now() : undefined,
    });
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
    const rec = this.registry.get(resolvedId);
    const isLive = Boolean(rec && rec.status === "active" && this.live.has(resolvedId));
    const target = isLive ? this.live.get(resolvedId) : undefined;
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
    this.notifyInboxChanged(resolvedId, isResponsive ? { priority: "responsive" } : {});
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
    const actor = this.live.get(id);
    this.recordEvent({
      kind: "run_yielded",
      actorId: id,
      detail: actor ? status : "dropped — no live actor",
      body: note,
    });
    if (!actor) {
      this.log(`yield from ${id} dropped — no live actor`);
      return;
    }
    actor.declareYield(status);
    const parentId = this.registry.get(id)?.parentId;
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
        runId: id,
        actorId: id,
        status,
      });
    }
  }

  markUnkillable(actorId: string): void {
    actorId = this.resolveThreadId(actorId);
    const target = this.live.get(actorId);
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
   * `force` exists for the operator's lever and for the mesh's own internal teardown —
   * a wedged actor must stay retirable, and the subtree cascade must not re-check a
   * subtree the entry call already cleared.
   *
   * `forceQueued` cancels queued runs in the subtree before retirement, but still refuses
   * if any thread in the subtree is actively running (inside the provider call). This is
   * exposed to actors via the `retire_thread` MCP tool with `force: true` (an issue).
   *
   * @throws when the subtree has running runs (or queued runs without `force`/`forceQueued`).
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
    // Marked before the child recursion: children retiring below us must be able
    // to see that we are on our way out, since the registry won't say so until
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
    const target = this.live.get(targetId);
    if (!target) {
      return { interrupted: false, status: "not_live" };
    }
    // `root-llm` is a RootControlPrincipal, not a thread id. RootControlService
    // scopes its target to the injected rootId's subtree before calling here;
    // human/e2e principals are operator-level bypasses by design.
    const isTrustedPrincipal =
      by === "root-llm" ||
      by === "human:operator" ||
      by.startsWith("human:") ||
      by === "e2e-controller";
    if (!isTrustedPrincipal && !this.isAncestorOf(by, targetId)) {
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
          this.notifyInboxChanged(targetId);
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
    const record = this.registry.get(targetId);
    if (!record) {
      throw new Error(`cannot run unknown actor ${targetId}`);
    }
    if (record.status === "retired") {
      throw new Error(`cannot run actor ${targetId}: actor is not active`);
    }
    const target = this.live.get(targetId);
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
    this.notifyInboxChanged(targetId, { priority: "responsive" });
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
   *    `this.live` before it runs the cleanups, so by then every thread reads idle.
   */
  activeRunState(actorId: string): ActiveRunState | null {
    actorId = this.resolveThreadId(actorId);
    const actor = this.live.get(actorId);
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

  /** True only if the actor is live and declared yield during its active run. */
  isYielded(actorId: string): boolean {
    actorId = this.resolveThreadId(actorId);
    const actor = this.live.get(actorId);
    return Boolean(actor?.isYielded);
  }

  /**
   * Every thread at or below `id` with a run in flight — the retire guard's input, and
   * what {@link listChildRunStates} reports.
   *
   * Whole-subtree because retire is whole-subtree: refusing only on the named thread
   * would still let a retire two levels up tear down a busy grandchild. The visited set
   * is defensive insurance against a pre-corrupted cyclic tree, matching
   * {@link reparentThread}'s cycle guard.
   */
  activeRunsInSubtree(id: string): ActiveRunState[] {
    id = this.resolveThreadId(id);
    const busy: ActiveRunState[] = [];
    const seen = new Set<string>();
    const walk = (cursor: string): void => {
      if (seen.has(cursor)) return;
      seen.add(cursor);
      const state = this.activeRunState(cursor);
      if (state) busy.push(state);
      for (const child of this.registry.children(cursor)) {
        if (child.status === "active") walk(child.id);
      }
    };
    walk(id);
    return busy;
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
    for (const child of this.registry.children(parentId)) {
      states.set(child.id, this.activeRunState(child.id)?.phase ?? "idle");
    }
    return states;
  }

  private retireInner(id: string): void {
    for (const child of this.registry.children(id)) {
      // `force`: the entry call already cleared this whole subtree, and re-checking
      // here would only re-answer the same question against a tree we're mid-teardown of.
      if (child.status === "active") this.retire(child.id, { force: true });
    }
    const actor = this.live.get(id);
    actor?.close();
    this.live.delete(id);
    const record = this.registry.get(id);
    if (record?.pendingDeliveries) {
      for (const msg of record.pendingDeliveries) {
        this.notifyScheduledDeliveryDropped(id, msg);
        const timer = this.pendingDeliveryTimers.get(msg.id);
        if (timer) clearTimeout(timer);
        this.pendingDeliveryTimers.delete(msg.id);
      }
      this.registry.patch(id, { pendingDeliveries: [] });
    }
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
    this.registry.patch(id, { status: "retired" });
    this.recordEvent({
      kind: "actor_retired",
      actorId: id,
    });
    if (record) this.runRetireCleanups(record);
    this.log(`retired ${id}`);
  }

  private runRetireCleanups(record: ThreadRecord): void {
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

  private runRetireCleanup(cleanup: RetireCleanup, record: ThreadRecord): void {
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

  private retireEventSubscriptions(record: ThreadRecord): void {
    const at = this.now();
    for (const subscription of this.eventSubscriptions.list()) {
      if (subscription.actorId !== record.id || subscription.unsubscribedAt) continue;
      this.unsubscribeEventSource(subscription.resource, record.id, at);
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
    const record = this.registry.get(id);
    if (!record) {
      throw new Error(`Cannot set title on unknown thread: ${id}`);
    }
    this.registry.patch(id, { title });
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
    const record = this.registry.get(id);
    if (!record) {
      throw new Error(`Cannot set charter on unknown thread: ${id}`);
    }
    // A charter is an actor's whole mandate; an empty one would silently wipe it
    // on the next wake (higher stakes than an empty title). Refuse it.
    if (!charter.trim()) {
      throw new Error(`Cannot set an empty charter on thread: ${id}`);
    }
    this.registry.patch(id, { charter });
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
   * Update an existing actor's model in-place in the thread registry .
   * Root or parent-gated: root may set the model for any thread in its subtree;
   * a non-root parent may only set the model for its own descendants (and never
   * raise its own tier).
   * Optionally moves portable (ledger/tail) actors across providers.
   * Takes effect on the actor's NEXT run.
   */
  setActorModel(id: string, model: string, requestedBy: string, provider?: string): void {
    id = this.resolveThreadId(id);
    requestedBy = this.resolveThreadId(requestedBy);
    const record = this.registry.get(id);
    if (!record) {
      throw new Error(`Cannot set model on unknown thread: ${id}`);
    }
    const isRoot = this.isRootActor(requestedBy);
    if (!isRoot) {
      if (requestedBy === id) {
        throw new Error(`Cannot set model: an actor cannot set its own model (${id})`);
      }
      if (!this.isAncestorOf(requestedBy, id)) {
        throw new Error(
          `Cannot set model on thread ${id}: caller ${requestedBy} is not an ancestor of ${id}`
        );
      }
    }
    const liveActor = this.live.get(id);
    if (liveActor && (liveActor.isRunning || liveActor.isQueued)) {
      throw new Error(`Cannot change model or provider while actor ${id} is running or queued`);
    }
    const trimmedModel = model.trim();
    if (!trimmedModel) {
      throw new Error(`Cannot set an empty model on thread: ${id}`);
    }
    const trimmedProvider = provider?.trim() || undefined;
    if (trimmedProvider !== undefined && trimmedProvider !== record.provider) {
      if (record.context?.type !== "portable") {
        throw new Error(
          `Cannot change provider on non-portable actor ${id} (context mode: ${record.context?.type ?? "native"}). Only portable (ledger/tail) actors can be moved across providers.`
        );
      }
    }
    if (this.validateModel) {
      this.validateModel(record, trimmedModel, trimmedProvider);
    }
    const oldModel = record.model;
    const oldProvider = record.provider;
    const patch: Partial<ThreadRecord> = { model: trimmedModel };
    if (trimmedProvider !== undefined) {
      patch.provider = trimmedProvider;
    }
    this.registry.patch(id, patch);
    const verified = this.registry.get(id);
    if (
      verified?.model !== trimmedModel ||
      (trimmedProvider !== undefined && verified?.provider !== trimmedProvider)
    ) {
      throw new Error(`Failed to verify model update for thread: ${id}`);
    }
    this.onModelSet?.(id, trimmedModel, verified);
    const detail =
      trimmedProvider && trimmedProvider !== oldProvider
        ? `${oldProvider ?? "default"}:${oldModel ?? "default"} -> ${trimmedProvider}:${trimmedModel}`
        : `${oldModel ?? "default"} -> ${trimmedModel}`;
    this.recordEvent({
      kind: "actor_model_set",
      actorId: id,

      detail,
    });
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
    const record = this.registry.get(id);
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
    const newParent = this.registry.get(newParentId);
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
      cursor = this.registry.get(cursor)?.parentId
    ) {
      if (cursor === id) {
        throw new Error(`Cannot reparent ${id} under its own descendant ${newParentId} (cycle)`);
      }
      seen.add(cursor);
    }
    this.registry.patch(id, { parentId: newParentId });
    this.grantHandle(newParentId, { id }); // the new parent can now message the actor
    this.recordEvent({
      kind: "actor_reparented",
      actorId: id,
      payload: JSON.stringify({ fromParentId: record.parentId, toParentId: newParentId }),
    });
  }

  reviveThread(id: string): void {
    id = this.resolveThreadId(id);
    const record = this.registry.get(id);
    if (!record) {
      throw new Error(`Cannot revive unknown thread: ${id}`);
    }
    if (record.status !== "retired") {
      throw new Error(`Cannot revive thread ${id}: status is ${record.status} (expected retired)`);
    }

    this.registry.patch(id, { status: "active" });
    const updatedRecord = this.registry.get(id);
    if (!updatedRecord) {
      throw new Error(`Failed to retrieve record for revived thread: ${id}`);
    }

    // Atomic revive: if workdir-recreate, re-instantiate, or endpoint mount throws,
    // roll the record back to retired so a failed revive is immediately re-tryable
    // rather than stranded active-but-not-live (elder review of ISSUE_NUM).
    try {
      this.onRevive?.(updatedRecord);
      const actor = this.createActor(this.factoryContext(updatedRecord));
      this.live.set(id, actor);
    } catch (err) {
      this.live.delete(id);
      this.registry.patch(id, { status: "retired" });
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
    return this.live.get(this.resolveThreadId(id));
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
      cursor = this.registry.get(cursor)?.parentId ?? null;
    }
    return false;
  }

  /**
   * Stop all live actors' timers without retiring them (graceful shutdown). The
   * registry is untouched, so active threads can be rehydrated on the next boot.
   */
  shutdownAll(): void {
    for (const actor of this.live.values()) actor.close();
    this.live.clear();
    for (const timer of this.pendingDeliveryTimers.values()) clearTimeout(timer);
    this.pendingDeliveryTimers.clear();
  }

  /** All thread records (active and retired). */
  list(): ThreadRecord[] {
    return this.registry.list();
  }

  /** Slots currently running (for diagnostics/tests). */
  get inFlight(): number {
    return this.limiter.inFlight;
  }

  /** Schedule a run through provider pacing and the normal-only mesh queue. */
  gateRun<T>(
    fn: () => Promise<T>,
    provider: string,
    responsive = false,
    threadId?: string
  ): RunStartHandle<T> {
    return this.providerGate(fn, provider, {
      responsive,
      threadId,
      enqueueNormal: (run) => this.limiter.enqueue(run),
    });
  }

  /**
   * A synchronous, read-only snapshot of the ids of every live actor that is
   * running at the provider right now. Runs waiting in either scheduler queue
   * are deliberately excluded. Built in one synchronous
   * pass over the live map (no awaits), so the dashboard can classify every
   * thread against a single non-torn view. Live actors only (the root included,
   * since it's adopted into `live`); the threads handler joins the registry, so
   * an active-but-not-running thread reads idle and a retired one reads retired.
   * Read-only: observes existing state, never schedules, wakes, or mutates.
   */
  runningThreadIds(): Set<string> {
    const ids = new Set<string>();
    for (const [id, actor] of this.live) {
      if (actor.isRunning) ids.add(id);
    }
    return ids;
  }

  /** Actors that passed their pre-run gate but are waiting for their run to start. */
  queuedThreadIds(): Set<string> {
    const ids = new Set<string>();
    for (const [id, actor] of this.live) {
      if (actor.isQueued) ids.add(id);
    }
    return ids;
  }

  /** All post-preflight runs, including queued ones; used by shutdown barriers. */
  activeRunThreadIds(): Set<string> {
    return new Set([...this.runningThreadIds(), ...this.queuedThreadIds()]);
  }

  /** Cancel queued starts selected by provider-aware halt state. */
  cancelHaltedQueuedRuns(): string[] {
    const cancelled: string[] = [];
    for (const [id, actor] of this.live) {
      const provider = this.registry.get(id)?.provider;
      if (this.isHalted(provider) && actor.cancelQueuedRun?.()) cancelled.push(id);
    }
    return cancelled;
  }

  /** Replay starts canceled by a halt once their provider is no longer blocked. */
  resumeCancelledRuns(): string[] {
    const resumed: string[] = [];
    for (const [id, actor] of this.live) {
      const provider = this.registry.get(id)?.provider;
      if (!this.isHalted(provider) && actor.resumeCancelledRun?.()) resumed.push(id);
    }
    return resumed;
  }

  private factoryContext(record: ThreadRecord): ActorFactoryContext {
    return {
      record,
      getRecord: () => this.registry.get(record.id),
      mesh: this,
      gate: (fn, provider, responsive) => this.gateRun(fn, provider, responsive, record.id),
      beforeRun: ({ mode }) => {
        const rec = this.registry.get(record.id);
        if (!rec || rec.status !== "active") {
          return false;
        }
        if (this.isHalted(rec.provider) || this.isShuttingDown() || !this.checkLease(record.id)) {
          return false;
        }
        if (mode === "yield-elicitation") return true;
        if (!this.inboxStore) return true;
        const actor = this.live.get(record.id);
        const watermark = actor?.getInterruptedWatermark?.();
        if (watermark) {
          const entries = this.inboxStore.list(record.id, { status: "unhandled" }).entries;
          return entries.some((e) => e.deliveredAt > watermark);
        }
        return this.inboxStore.countUnhandled(record.id) > 0;
      },
      onQueued: (context) => {
        this.actorQueued(record.id, context);
      },
      onRunEnd: (result) => {
        this.finishInboxRun(record.id);
        this.accountRun(record.id, result);
      },
    };
  }

  /** Enforce the lease: retire and skip the run when the budget is exhausted. */
  private checkLease(id: string): boolean {
    const rec = this.registry.get(id);
    const budget = rec?.budget;
    if (budget?.maxRuns != null && (budget.runsUsed ?? 0) >= budget.maxRuns) {
      this.log(`lease exhausted for ${id} (${budget.runsUsed}/${budget.maxRuns}) — retiring`);
      // `force`: this fires from inside the actor's own pre-run gate, so the thread is
      // by definition mid-wake. The lease is the mesh's own bound on the subtree and
      // must not be defeatable by the actor being busy — that is what a lease is for.
      this.retire(id, { force: true });
      return false;
    }
    return true;
  }

  /** Account one completed run against the lease. */
  private accountRun(id: string, result: RunResult): void {
    if (result.tokenUsage) {
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
            id,
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
          `token accounting write failed for ${id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const rec = this.registry.get(id);
    if (!rec?.budget) return;
    const runsUsed = (rec.budget.runsUsed ?? 0) + 1;
    this.registry.patch(id, { budget: { ...rec.budget, runsUsed } });
  }

  private armPendingDelivery(toId: string, msg: PendingMessageDelivery): void {
    const delay = Math.max(0, new Date(msg.deliverAt).getTime() - Date.now());
    const timer = setTimeout(() => this.firePendingDelivery(toId, msg.id), delay);
    this.pendingDeliveryTimers.set(msg.id, timer);
  }

  /**
   * Who should hear that a scheduled message will never arrive: the sender if
   * it's genuinely live, else its nearest live ancestor.
   *
   * "Live" is narrower than `status === "active"`. Retiring a subtree recurses
   * into children first and only marks each actor retired on the way back out,
   * so an ancestor unwinding its own retire still reads as active right up until
   * it's torn down. Notifying it would post into an actor that is about to be
   * closed — the notification is accepted
   * and then destroyed, which looks identical to delivering it.
   *
   * The walk can't stop at the first parent for the same reason: when a whole
   * subtree goes down, that parent is usually mid-retire too.
   */
  private resolveDropNotifyTarget(fromId: string): string | null {
    const isLive = (id: string): boolean =>
      this.registry.get(id)?.status === "active" && !this.retiring.has(id);
    if (isLive(fromId)) return fromId;

    const seen = new Set<string>([fromId]);
    let next = this.registry.get(fromId)?.parentId;
    while (next && !seen.has(next)) {
      if (isLive(next)) return next;
      seen.add(next);
      next = this.registry.get(next)?.parentId;
    }
    return null;
  }

  private notifyScheduledDeliveryDropped(toId: string, scheduled: PendingMessageDelivery): void {
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
        }
      );
    }
  }

  private firePendingDelivery(toId: string, messageId: string): void {
    const rec = this.registry.get(toId);
    if (!rec) return;
    const scheduled = rec.pendingDeliveries?.find((m) => m.id === messageId);
    if (!scheduled) return;

    this.pendingDeliveryTimers.delete(messageId);

    try {
      if (rec.status !== "active") {
        this.log(`pending delivery ${messageId} for ${toId} dropped — recipient retired`);
        this.notifyScheduledDeliveryDropped(toId, scheduled);
        this.registry.patch(toId, {
          pendingDeliveries: rec.pendingDeliveries?.filter((m) => m.id !== messageId),
        });
        return;
      }

      const target = this.live.get(toId);

      const durableMessageId = this.recordMessageEmitted({
        fromId: scheduled.fromId,
        toId,
        body: scheduled.body,
        sessionId: scheduled.sessionId,
        isDrop: false,
      });

      if (target && this.inboxStore) {
        if (!durableMessageId) {
          throw new Error("Scheduled message delivery requires durable chat storage");
        }
        this.inboxStore.append([
          {
            actorId: toId,
            source: `mesh:${scheduled.fromId}`,
            payload: {
              type: "mesh.scheduled_message",
              messageId: durableMessageId,
              fromId: scheduled.fromId,
              sessionId: scheduled.sessionId,
            },
          },
        ]);
        this.registry.patch(toId, {
          pendingDeliveries: rec.pendingDeliveries?.filter((m) => m.id !== messageId) ?? [],
        });
        this.notifyInboxChanged(toId);
      } else if (target && !this.inboxStore) {
        this.registry.patch(toId, {
          pendingDeliveries: rec.pendingDeliveries?.filter((m) => m.id !== messageId) ?? [],
        });
        target.requestRun();
      } else {
        this.registry.patch(toId, {
          pendingDeliveries: rec.pendingDeliveries?.filter((m) => m.id !== messageId) ?? [],
        });
        this.log(`message to ${toId} from ${scheduled.fromId} dropped — no durable inbox target`);
      }
    } catch (err) {
      this.log(
        `firePendingDelivery failed for ${messageId} to ${toId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

function immediateStart<T>(fn: () => Promise<T>): RunStartHandle<T> {
  let started = false;
  let cancelled = false;
  const result = Promise.resolve().then(() => {
    if (cancelled) throw new RunStartCancelledError();
    started = true;
    return fn();
  });
  return {
    result,
    get started() {
      return started;
    },
    promote: () => {},
    cancel: () => {
      if (started || cancelled) return false;
      cancelled = true;
      return true;
    },
  };
}

function deduplicatedInboxEntryId(dedupeKey: string, actorId: string): string {
  const digest = createHash("sha256")
    .update(dedupeKey)
    .update("\0")
    .update(actorId)
    .digest("hex")
    .slice(0, 32);
  return `dedupe:${digest}`;
}
