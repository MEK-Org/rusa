import type { MeshActor } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import {
  ConcurrencyLimiter,
  RunStartCancelledError,
  type RunStartHandle,
} from "../actor/concurrency-limiter.js";
import { isResponsiveNudge, type RunNudge } from "../actor/trigger-runner.js";
import type { RawProviderModelConfig } from "../providers/model-config.js";
import type { InboxRepository } from "../repositories/inbox-repository.js";

/**
 * The durable payload type a voice memo is delivered under, written by the
 * human-message producer and read back here. Voice keeps its quick-start and
 * coalesce-kill timing, and the fact that the pending work is voice is itself
 * durable, so dispatch reads it from the entry rather than receiving it as an
 * argument.
 */
export const VOICE_INBOX_PAYLOAD_TYPE = "human.voice";

/**
 * The declared tuple a queued run has actually reserved — populated the
 * moment a `providerGate` implementation reports it via `onSelected`, kept
 * only while the run is queued, and read by both HALT safety
 * (`ActorMesh.cancelHaltedQueuedRuns`, which must cancel on the
 * reserved lane, not the whole declared pool) and selection telemetry/queued
 * dashboard state. `provider` is the declared alias as configured;
 * `lane` is the canonical pacing/account key (`providerThrottleKey`) it
 * resolves to — deliberately kept distinct so a configured alias is never
 * silently erased.
 */
export interface QueuedSelection {
  provider: string;
  lane: string;
  model: string;
  effort?: string;
  /** Index of this candidate within the actor's declared pool, in declaration order. */
  declaredIndex: number;
  /** Epoch-ms quote for when this reservation becomes eligible to start. */
  eligibleAt: number;
  responsive: boolean;
}

/**
 * Provider pacing composed with the normal-run concurrency queue. Given the
 * actor's declared candidate pool, it atomically selects (quotes and reserves)
 * the earliest-eligible canonical provider lane — declaration order breaking
 * unresolvable ties — and invokes `fn` with the winning tuple.
 */
export type MeshProviderGate = <T>(
  fn: (selected: RawProviderModelConfig) => Promise<T>,
  candidates: readonly RawProviderModelConfig[],
  opts: {
    responsive: boolean;
    /** Owning actor, retained only for scheduler observability. */
    threadId?: string;
    enqueueNormal: <R>(run: () => Promise<R>) => RunStartHandle<R>;
    /**
     * Report the reserved candidate — at initial reservation and again on a
     * later reselection or in-place responsive promotion — so the reservation
     * can be tracked for HALT safety and selection telemetry.
     */
    onSelected?: (selection: QueuedSelection) => void;
  }
) => RunStartHandle<T>;

/**
 * What the durable worklist says about one actor right now. `null` — rather
 * than an instance of this — is how "nothing to do" is expressed, so a caller
 * cannot accidentally dispatch an actor with no work.
 */
export interface DurableDispatchWork {
  /** Promoted to responsive when any unhandled entry is responsive. */
  priority: "normal" | "responsive";
  /**
   * Whether responsive work is pending that no accepted execution opportunity
   * has absorbed yet — `seen` is stamped as a run is admitted, so this is the
   * durable reading of "responsive work has just arrived", as opposed to
   * "responsive work is still open in the run already doing it".
   *
   * Priority does not depend on it: an actor holding a pending responsive
   * entry is responsive, exactly as `actorsWithUnhandled()` reports it. The
   * two things that must not fire for work a run already holds do: replacing
   * that run, and passing the voice hold.
   */
  unseenResponsive?: boolean;
  /** Delivery time of the newest pending voice memo no run has absorbed. */
  voiceAt?: number;
}

/**
 * Internal construction-only port for non-preempting joins (event copies to
 * non-owners and self-caused ready attention mid-run). Exposes the internal
 * joining dispatch capability without adding a second public dispatch method to
 * RunManager's public class interface.
 */
export interface RunManagerInternalPort {
  dispatchJoiningActiveRun(actorId: string): boolean;
}

/**
 * Maximum page limit supported by {@link InboxRepository.list}.
 */
const RESPONSIVE_PAGE_LIMIT = 100;

export interface RunManagerOptions {
  /**
   * The durable worklist. It is the only source of whether an actor has work
   * and what that work's priority is.
   */
  inbox: InboxRepository;
  /** Cross-actor concurrency cap for non-responsive runs (default 4). */
  maxConcurrent?: number;
  /** Provider pacing; omitted leaves declaration order as the whole policy. */
  providerGate?: MeshProviderGate;
  /**
   * Legacy promise-only rate gate, consulted only when no {@link providerGate}
   * is wired. Retained for embedders that do not need start promotion.
   */
  rateLimit?: <T>(fn: () => Promise<T>, provider: string) => Promise<T>;
  /**
   * Build — never register — the live actor for a durable record. Production
   * composition funnels this through the shared actor-construction seam, so
   * configured roots and workers reach the same constructor.
   */
  constructActor: (record: ActorRecord) => MeshActor;
  /** Durable record status, so a dispatch to a retired actor is refused. */
  recordStatus: (actorId: string) => string | undefined;
  /** Leased walkie authority: ordinary work waits for the session to end. */
  isVoiceSessionActive?: (actorId: string) => boolean;
  /** Stamp `seen` on the entries an already-queued opportunity absorbs. */
  markInboxSeen?: (actorId: string) => void;
  /** Report that responsive work replaced an in-flight or queued run. */
  onPreempted?: (actorId: string, phase: string) => void;
  /**
   * Observe each newly arrived responsive inbox row before normal preemption.
   * This is a narrow policy hook, not a second dispatch path: the durable
   * inbox still decides priority and this callback cannot delay its dispatch.
   */
  onResponsiveArrived?: (
    actorId: string,
    entryIds: readonly string[],
    baseline: "interrupt" | "queue"
  ) => void;
  /** Internal construction-only port receiver. */
  onInternalPort?: (port: RunManagerInternalPort) => void;
  log?: (msg: string) => void;
}

/**
 * The execution coordinator.
 *
 * It owns the live actors, their construction, the admission gates every run
 * passes, and the one dispatch input: {@link dispatch}, which names an actor
 * and nothing else. Whether that actor has work, and whether the work is
 * ordinary or responsive, is read from the durable inbox — never carried in
 * by the caller — so a dispatch is advisory in exactly the way the inbox
 * repository's contract says its append notifications are. Dropping one costs
 * latency, not correctness: boot and resume reconciliation re-derive the same
 * answer from the same rows.
 *
 * Per-actor debounce, coalescing, single-flight and the one queued follow-up
 * run belong to each live actor's trigger runner; this class is their sole
 * caller, which is what makes "one run per actor at a time" a property of the
 * coordinator rather than a convention its callers observe.
 *
 * Parallelism limiting and quota/pacing admission are contained here together
 * as one concrete v1 owner. There is deliberately no composable
 * admission-policy interface: the real admission contracts are not known yet,
 * and a speculative seam would have to be unwound to discover them.
 *
 * Hierarchy, durable records, capabilities and message routing are not here.
 * The coordinator needs to know which actor to run, not who its parent is.
 */
export class RunManager {
  private readonly live = new Map<string, MeshActor>();
  private readonly selections = new Map<string, QueuedSelection>();
  private readonly limiter: ConcurrencyLimiter;
  private readonly inbox: InboxRepository;
  private readonly providerGate: MeshProviderGate;
  private readonly constructActor: (record: ActorRecord) => MeshActor;
  private readonly recordStatus: (actorId: string) => string | undefined;
  private readonly isVoiceSessionActive: (actorId: string) => boolean;
  private readonly markInboxSeen: (actorId: string) => void;
  private readonly onPreempted: (actorId: string, phase: string) => void;
  private readonly onResponsiveArrived?: RunManagerOptions["onResponsiveArrived"];
  private readonly log: (msg: string) => void;

  constructor(opts: RunManagerOptions) {
    this.inbox = opts.inbox;
    opts.onInternalPort?.({
      dispatchJoiningActiveRun: (actorId: string) =>
        this.dispatchInternal(actorId, { preempt: false }),
    });
    this.limiter = new ConcurrencyLimiter(opts.maxConcurrent ?? 4);
    this.providerGate =
      opts.providerGate ??
      ((fn, candidates, admissionOpts) => {
        // No real pacing wired (e.g. an isolated test mesh): declaration order
        // is the whole policy, matching a fixed single-choice actor's behavior.
        const selected = candidates[0];
        const run = () => fn(selected);
        if (opts.rateLimit) {
          const result = opts.rateLimit(
            () => (admissionOpts.responsive ? run() : admissionOpts.enqueueNormal(run).result),
            selected.provider
          );
          return { result, started: false, promote: () => {}, cancel: () => false };
        }
        return admissionOpts.responsive ? immediateStart(run) : admissionOpts.enqueueNormal(run);
      });
    this.constructActor = opts.constructActor;
    this.recordStatus = opts.recordStatus;
    this.isVoiceSessionActive = opts.isVoiceSessionActive ?? (() => false);
    this.markInboxSeen = opts.markInboxSeen ?? (() => {});
    this.onPreempted = opts.onPreempted ?? (() => {});
    this.onResponsiveArrived = opts.onResponsiveArrived;
    this.log = opts.log ?? (() => {});
  }

  // ---------------------------------------------------------------- dispatch

  /**
   * The one dispatch input: an advisory, content-free poke naming an actor.
   *
   * Returns whether this call requested an execution opportunity. An actor
   * with no durable work is a no-op; a retired or non-live actor is refused;
   * a poke carrying nothing but ordinary work is held for the duration of a
   * voice session. Responsive work that has not yet reached a run replaces the
   * one in flight — operator control, human messages and `runNow` all mean
   * "now" — while responsive work that run already absorbed leaves it alone,
   * so ordinary traffic arriving behind it cannot restart it indefinitely.
   */
  dispatch(actorId: string): boolean {
    return this.dispatchInternal(actorId, { preempt: true });
  }

  /**
   * What the durable worklist says about this actor, or null when it has no
   * pending work.
   *
   * This answers, for one actor, exactly what `actorsWithUnhandled()` answers
   * for every actor: pending work exists, promoted to responsive when any
   * pending entry is responsive. It is derived through the per-actor indexed
   * reads because a dispatch is per-actor and arrives on every delivery, while
   * the whole-mesh scan belongs to the boot and resume reconciliation sweeps
   * that genuinely need every actor at once.
   */
  durableWork(actorId: string): DurableDispatchWork | null {
    const inbox = this.inbox;
    if (inbox.countUnhandled(actorId, { responsiveOnly: true }) > 0) {
      return { priority: "responsive", ...dispatchWork(this.pendingResponsive(actorId)) };
    }
    return inbox.countUnhandled(actorId) > 0 ? { priority: "normal" } : null;
  }

  /**
   * The two things a dispatch needs about pending responsive work beyond the
   * fact that it exists — whether any of it is unabsorbed, and when the newest
   * unabsorbed voice memo was delivered — read by paging the repository's
   * unhandled responsive entries. This is exact rather than a fixed-window
   * approximation: a backdated unseen row can fall after newer seen rows.
   * The current repository contract computes a count with each page, so a
   * large responsive backlog costs multiple queries. That is an accepted
   * consequence of keeping #387 within the existing repository interface; an
   * indexed unseen count plus newest-unseen-voice query belongs in a dedicated
   * repository extension, not a scheduler-side approximation.
   */
  private pendingResponsive(actorId: string): {
    unseenResponsive: boolean;
    unseenResponsiveEntryIds?: readonly string[];
    voiceAt?: number;
  } {
    let cursor: string | undefined;
    let unseenResponsive = false;
    const unseenResponsiveEntryIds: string[] = [];
    let voiceAt: number | undefined;

    do {
      const page = this.inbox.list(actorId, {
        status: "unhandled",
        responsiveOnly: true,
        limit: RESPONSIVE_PAGE_LIMIT,
        cursor,
      });
      for (const entry of page.entries) {
        if (entry.seenAt === null) {
          unseenResponsive = true;
          unseenResponsiveEntryIds.push(entry.id);
          if (voiceAt === undefined && entry.payload.type === VOICE_INBOX_PAYLOAD_TYPE) {
            const at = entry.deliveredAt.getTime();
            if (Number.isFinite(at)) {
              voiceAt = at;
            }
          }
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    return {
      unseenResponsive,
      ...(unseenResponsiveEntryIds.length > 0 ? { unseenResponsiveEntryIds } : {}),
      ...(voiceAt !== undefined ? { voiceAt } : {}),
    };
  }

  private dispatchInternal(actorId: string, opts: { preempt: boolean }): boolean {
    const status = this.recordStatus(actorId);
    if (status !== undefined && status !== "active") {
      this.log(`dispatch(${actorId}) refused — actor is retired`);
      return false;
    }
    const target = this.live.get(actorId);
    if (!target) {
      this.log(`dispatch(${actorId}) refused — no live actor`);
      return false;
    }
    const work = this.durableWork(actorId);
    if (!work) {
      // Advisory by contract: a poke that races ahead of its row, or arrives
      // after the work was handled, is simply nothing to do.
      this.log(`dispatch(${actorId}) is a no-op — no durable work`);
      return false;
    }
    const nudge = dispatchNudge(work);
    // Responsive work an accepted opportunity already absorbed is not work
    // arriving: the run that holds it is the one in flight. Only work that has
    // yet to reach a run earns the two things responsive delivery does beyond
    // scheduling — passing the voice hold, and replacing the active run.
    const responsiveArrived = isResponsiveNudge(nudge) && work.unseenResponsive !== false;
    if (!responsiveArrived && this.isVoiceSessionActive(actorId)) {
      // The entry is already durable. It must wait for the session-end
      // dispatch rather than adding an ordinary execution opportunity behind
      // the voice conversation. Arriving responsive work passes the hold
      // whether or not it may preempt, so a non-owner's event copy is admitted
      // behind the voice session's own run rather than held with ordinary work.
      this.log(`dispatch(${actorId}) held — active voice session`);
      return false;
    }
    if (responsiveArrived && opts.preempt) {
      this.onResponsiveArrived?.(
        actorId,
        this.pendingResponsive(actorId).unseenResponsiveEntryIds ?? [],
        "interrupt"
      );
      const preemption = target.preemptForResponsive();
      if (preemption.preempted) this.onPreempted(actorId, preemption.phase);
    } else if (responsiveArrived) {
      this.onResponsiveArrived?.(
        actorId,
        this.pendingResponsive(actorId).unseenResponsiveEntryIds ?? [],
        "queue"
      );
    }
    if (target.isQueued) {
      // The new entry joins the already-accepted opportunity, which will list
      // the live worklist after admission, so it becomes seen immediately.
      this.markInboxSeen(actorId);
    }
    target.requestRun(nudge);
    return true;
  }

  // ------------------------------------------------------------ construction

  /**
   * Build and register the live actor for a record. Construction and the live
   * registry are one owner so no caller can register an actor built behind the
   * coordinator's back.
   */
  instantiate(record: ActorRecord): MeshActor {
    const actor = this.constructActor(record);
    this.live.set(record.id, actor);
    return actor;
  }

  /** Register an externally-constructed actor (the configured root). */
  register(actorId: string, actor: MeshActor): void {
    this.live.set(actorId, actor);
  }

  liveActor(actorId: string): MeshActor | undefined {
    return this.live.get(actorId);
  }

  isLive(actorId: string): boolean {
    return this.live.has(actorId);
  }

  liveIds(): string[] {
    return [...this.live.keys()];
  }

  /** Every live actor with its id, for mesh-wide sweeps. */
  liveEntries(): IterableIterator<[string, MeshActor]> {
    return this.live.entries();
  }

  // -------------------------------------------------------- terminal cleanup

  /** Close and forget one actor. Idempotent. */
  release(actorId: string): void {
    this.live.get(actorId)?.close();
    this.live.delete(actorId);
    this.selections.delete(actorId);
  }

  /** Forget one actor without closing it — a construction that failed to land. */
  forget(actorId: string): void {
    this.live.delete(actorId);
    this.selections.delete(actorId);
  }

  /**
   * Stop every live actor's timers without retiring it (graceful shutdown).
   * Durable records are untouched, so active actors rehydrate on the next boot.
   */
  closeAll(): void {
    for (const actor of this.live.values()) actor.close();
    this.live.clear();
    this.selections.clear();
  }

  // --------------------------------------------------------------- admission

  /**
   * Schedule a run through provider pacing and the normal-only concurrency
   * queue. Parallelism and pacing/quota throttling are admitted together here;
   * a responsive run uses the same selection and then bypasses both.
   */
  gateRun<T>(
    fn: (selected: RawProviderModelConfig) => Promise<T>,
    candidates: readonly RawProviderModelConfig[],
    responsive = false,
    threadId?: string
  ): RunStartHandle<T> {
    return this.providerGate(fn, candidates, {
      responsive,
      threadId,
      enqueueNormal: (run) => this.limiter.enqueue(run),
      onSelected: threadId ? (selection) => this.selections.set(threadId, selection) : undefined,
    });
  }

  /** Slots currently running (for diagnostics/tests). */
  get inFlight(): number {
    return this.limiter.inFlight;
  }

  /**
   * Read-only snapshot of the declared tuple a queued run has reserved.
   * `undefined` once the run starts, is cancelled, or ends — never stale.
   */
  selectionFor(actorId: string): QueuedSelection | undefined {
    return this.selections.get(actorId);
  }

  /** Clear a reservation at start/cancel/end so it never outlives itself. */
  clearSelection(actorId: string): void {
    this.selections.delete(actorId);
  }
}

/** The scheduling metadata a dispatch derives from durable state. */
function dispatchWork(work: {
  unseenResponsive: boolean;
  voiceAt?: number;
}): Pick<DurableDispatchWork, "unseenResponsive" | "voiceAt"> {
  return {
    unseenResponsive: work.unseenResponsive,
    ...(work.voiceAt !== undefined ? { voiceAt: work.voiceAt } : {}),
  };
}

function dispatchNudge(work: DurableDispatchWork): RunNudge {
  if (work.priority !== "responsive") return {};
  return work.voiceAt === undefined
    ? { priority: "responsive" }
    : { priority: "responsive", voiceTimestamp: work.voiceAt };
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
