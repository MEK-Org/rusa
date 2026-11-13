import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Fixed server phases of one dashboard API request (#935). Each value is the
 * wall-clock union of that phase's own intervals inside the request, so
 * concurrent work in one phase is never counted twice.
 *
 * - `auth`: `DashboardAuth.authorize` (session, admission and revocation).
 * - `route`: from post-auth dispatch until the response body is handed to
 *   serialization or headers are written. It contains store reads and any
 *   reference enrichment the handler awaits.
 * - `enrichment`: awaited reference-cache resolution. It is nested inside
 *   `route` and overlaps it; never add the two.
 * - `serialization`: JSON encoding of the response body.
 * - `compression`: asynchronous response compression, when negotiated.
 *
 * Phases are not additive and do not partition the request-wide duration:
 * URL parsing before auth, event-loop queueing before a phase opens, gaps
 * between phases and socket finish after the last write are outside every
 * phase. Elapsed time while an interval is open — including a stalled await —
 * remains part of that phase. A phase a request never reached is absent, not
 * zero.
 */
export const DASHBOARD_SERVER_PHASES = [
  "auth",
  "route",
  "enrichment",
  "serialization",
  "compression",
] as const;

export type DashboardServerPhase = (typeof DASHBOARD_SERVER_PHASES)[number];
export type DashboardServerPhaseDurations = Partial<Record<DashboardServerPhase, number>>;

/**
 * Fixed substages of one server request (#990), stored apart from `phases` so
 * a reader that predates them keeps the row. Each interval is milliseconds:
 *
 * - `authAdapterMs`: the first session-cookie verification attempt, from call
 *   until it settles, resolved or rejected.
 * - `authFallbackMs`: the non-revocation retry after a transient failure of a
 *   revocation attempt; present only when that retry ran.
 * - `identityMs`: synchronous admission and durable identity resolution.
 * - `codecMs`: compression dispatch until the codec callback arrives. The rest
 *   of `compression` on the same row is continuation delivery.
 * - `finishMs`: local handoff of the last body chunk until `finish`. It is not
 *   client receipt or network transit.
 *
 * - `actorRuntimeMs`: actor-list runtime, running/queued and provider queue
 *   snapshots plus viewer scope setup.
 * - `actorReadMs`: reading the actor records.
 * - `actorActivityMs`: the batched last-activity lookup for those actors.
 * - `actorSummariesMs`: building all actor DTOs, including selected-work reads
 *   and awaited inbox enrichment. This is one wall interval around Promise.all,
 *   not a sum of per-actor times; it overlaps the enrichment phase.
 * - `actorMetadataMs`: scheduler health, viewer identity and response metadata.
 *
 * - `actorChatBodyMs`: actor chat POST, from starting to read the request body
 *   until the read settles, whether the body arrived or the stream failed,
 *   including any wait for the client's bytes.
 * - `actorChatSendMs`: the actor chat POST's synchronous mesh delivery call,
 *   from call until it returns or throws. Present only for a request that
 *   passed body validation and operator resolution.
 *
 * - `readQueueMs`: the request's first standalone read (#1323), from admission
 *   to the read pool until a worker was handed it: time waiting behind other
 *   reads, or for a worker to start. Absent when the read ran in-process.
 * - `readExecMs`: that read's own run inside its read transaction, timed on
 *   the thread that ran it.
 * - `readTransferMs`: the rest of that read's round trip to the worker: both
 *   message crossings, including the result's structured clone, and either
 *   thread's event-loop delay. Absent when the read ran in-process.
 *
 * The three read substages split one read, so unlike the others they add up:
 * their sum is that read's time from admission to answer, all inside `route`.
 * A read refused before it ran (queue full, pool closed) reports none.
 *
 * Actor-list substages occur only on the actor-list route and actor chat
 * substages only on the actor chat POST; both sit inside `route`.
 * Like phases they measure elapsed time, including scheduling delays, not CPU
 * cost; do not add them to their enclosing phases. Existing loopBusyPct is
 * request-wide context, not attribution to a particular actor operation.
 *
 * Only the request's own authorization reports auth substages; stream
 * rechecks and session refresh never do. A substage a request never reached
 * is absent, not zero; one still open at the terminal is clipped there.
 */
export const DASHBOARD_SERVER_SUBSTAGE_INTERVALS = [
  "authAdapterMs",
  "authFallbackMs",
  "identityMs",
  "codecMs",
  "finishMs",
  "actorRuntimeMs",
  "actorReadMs",
  "actorActivityMs",
  "actorSummariesMs",
  "actorMetadataMs",
  "actorChatBodyMs",
  "actorChatSendMs",
  "readQueueMs",
  "readExecMs",
  "readTransferMs",
] as const;

export type DashboardServerSubstageInterval = (typeof DASHBOARD_SERVER_SUBSTAGE_INTERVALS)[number];

export interface DashboardServerSubstages
  extends Partial<Record<DashboardServerSubstageInterval, number>> {
  /** Whether the first adapter attempt requested the revocation check. */
  authRevocation?: boolean;
  /**
   * Integer percent (0–100) of the request's start-to-terminal wall time in
   * which the event loop was running any JavaScript, not only this request's.
   * Context only: neither a high nor a low value names the cause of a wait.
   */
  loopBusyPct?: number;
}

/** What a request's own authorization reports into its timing row. */
export interface DashboardSubstageObserver {
  /** Open the substage once; a later open of the same substage is ignored. */
  startSubstage(substage: DashboardServerSubstageInterval): () => void;
  authRevocation(requested: boolean): void;
}

type Interval = [start: number, end: number | undefined];

const noop = () => {};

/** Per-request phase intervals; reported once, after the response finishes. */
export class DashboardPhaseClock implements DashboardSubstageObserver {
  private readonly intervals = new Map<DashboardServerPhase, Interval[]>();
  private readonly substageIntervals = new Map<DashboardServerSubstageInterval, Interval>();
  private readonly recordedSubstages = new Map<DashboardServerSubstageInterval, number>();
  private revocation: boolean | undefined;
  private endRoute: (() => void) | undefined;
  private routeStarted = false;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  /** Open one interval of `phase`; the returned function closes it once. */
  start(phase: DashboardServerPhase): () => void {
    // Serialization begins where the handler's route work ends.
    if (phase === "serialization") this.finishRoute();
    const interval: Interval = [this.clock(), undefined];
    const intervals = this.intervals.get(phase) ?? [];
    intervals.push(interval);
    this.intervals.set(phase, intervals);
    return () => {
      if (interval[1] === undefined) interval[1] = this.clock();
    };
  }

  startSubstage(substage: DashboardServerSubstageInterval): () => void {
    if (this.substageIntervals.has(substage)) return noop;
    const interval: Interval = [this.clock(), undefined];
    this.substageIntervals.set(substage, interval);
    return () => {
      if (interval[1] === undefined) interval[1] = this.clock();
    };
  }

  authRevocation(requested: boolean): void {
    this.revocation ??= requested;
  }

  /**
   * Record a substage measured elsewhere, such as on a read worker, as a
   * duration. Like an interval, only the first record of a substage counts.
   */
  recordSubstage(substage: DashboardServerSubstageInterval, ms: number): void {
    if (this.substageIntervals.has(substage) || this.recordedSubstages.has(substage)) return;
    if (!Number.isFinite(ms)) return;
    this.recordedSubstages.set(substage, ms);
  }

  /**
   * Interval substages reached so far, clipped at the terminal like phases.
   * The caller snapshots the result; a callback arriving after the row was
   * recorded cannot change it.
   */
  substages(endedAt: number = this.clock()): DashboardServerSubstages {
    const result: DashboardServerSubstages = {};
    for (const substage of DASHBOARD_SERVER_SUBSTAGE_INTERVALS) {
      const recorded = this.recordedSubstages.get(substage);
      if (recorded !== undefined) {
        result[substage] = Math.round(Math.max(0, recorded));
        continue;
      }
      const interval = this.substageIntervals.get(substage);
      if (!interval || interval[0] > endedAt) continue;
      const end = Math.min(interval[1] ?? endedAt, endedAt);
      result[substage] = Math.round(Math.max(0, end - interval[0]));
    }
    if (this.revocation !== undefined) result.authRevocation = this.revocation;
    return result;
  }

  /** The route phase has one interval, opened at post-auth dispatch. */
  beginRoute(): void {
    if (this.routeStarted) return;
    this.routeStarted = true;
    this.endRoute = this.start("route");
  }

  finishRoute(): void {
    this.endRoute?.();
    this.endRoute = undefined;
  }

  /**
   * Union each phase's intervals, clipping any still open at response finish:
   * work that outlives the response is reported only up to the finish.
   */
  durations(finishedAt: number = this.clock()): DashboardServerPhaseDurations {
    const result: DashboardServerPhaseDurations = {};
    for (const phase of DASHBOARD_SERVER_PHASES) {
      const intervals = this.intervals.get(phase);
      if (!intervals?.length) continue;
      const closed = intervals
        .map(([start, end]): [number, number] => [start, Math.min(end ?? finishedAt, finishedAt)])
        .sort((left, right) => left[0] - right[0]);
      let total = 0;
      let [currentStart, currentEnd] = closed[0];
      for (const [start, end] of closed.slice(1)) {
        if (start <= currentEnd) {
          currentEnd = Math.max(currentEnd, end);
          continue;
        }
        total += currentEnd - currentStart;
        [currentStart, currentEnd] = [start, end];
      }
      total += currentEnd - currentStart;
      result[phase] = Math.round(Math.max(0, total));
    }
    return result;
  }
}

/** The request scope is entered before the clock exists, then the clock is attached. */
interface DashboardRequestScope {
  clock?: DashboardPhaseClock;
}

const requestScope = new AsyncLocalStorage<DashboardRequestScope>();

/** Run one dashboard request so its awaited work can find its phase clock. */
export function runDashboardRequestScope<T>(fn: () => T): T {
  return requestScope.run({}, fn);
}

export function attachDashboardPhaseClock(clock: DashboardPhaseClock): void {
  const scope = requestScope.getStore();
  if (scope) scope.clock = clock;
}

/** Open a phase interval for the current request; a no-op outside a timed request. */
export function startDashboardPhase(phase: DashboardServerPhase): () => void {
  return requestScope.getStore()?.clock?.start(phase) ?? noop;
}

/** Open a substage interval for the current request; a no-op outside a timed request. */
export function startDashboardSubstage(substage: DashboardServerSubstageInterval): () => void {
  return requestScope.getStore()?.clock?.startSubstage(substage) ?? noop;
}

/**
 * The current request's substage observer, captured once by the caller and
 * passed explicitly. Work that merely inherits the request's async context,
 * such as a stream's periodic recheck, must not find it on its own.
 */
export function dashboardSubstageObserver(): DashboardSubstageObserver | undefined {
  return requestScope.getStore()?.clock;
}

/**
 * Where the current request's standalone read reports its timing, captured now
 * so the answer lands on this request's row however it is delivered; undefined
 * outside a timed request. Each substage keeps its first record
 * ({@link DashboardPhaseClock.recordSubstage}), so a later read in the same
 * request cannot overwrite the first read's figures.
 */
export function dashboardReadTimingObserver():
  | ((timing: {
      readonly queuedMs?: number;
      readonly executionMs?: number;
      readonly transferMs?: number;
    }) => void)
  | undefined {
  const clock = requestScope.getStore()?.clock;
  if (!clock) return undefined;
  return (timing) => {
    if (timing.queuedMs !== undefined) clock.recordSubstage("readQueueMs", timing.queuedMs);
    if (timing.executionMs !== undefined) clock.recordSubstage("readExecMs", timing.executionMs);
    if (timing.transferMs !== undefined) clock.recordSubstage("readTransferMs", timing.transferMs);
  };
}

export async function measureDashboardPhase<T>(
  phase: DashboardServerPhase,
  fn: () => Promise<T>
): Promise<T> {
  const end = startDashboardPhase(phase);
  try {
    return await fn();
  } finally {
    end();
  }
}

/** Mark post-auth dispatch; the route phase ends at serialization or header write. */
export function beginDashboardRoutePhase(): void {
  requestScope.getStore()?.clock?.beginRoute();
}
