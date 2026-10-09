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

type Interval = [start: number, end: number | undefined];

/** Per-request phase intervals; reported once, after the response finishes. */
export class DashboardPhaseClock {
  private readonly intervals = new Map<DashboardServerPhase, Interval[]>();
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

const noop = () => {};

/** Open a phase interval for the current request; a no-op outside a timed request. */
export function startDashboardPhase(phase: DashboardServerPhase): () => void {
  return requestScope.getStore()?.clock?.start(phase) ?? noop;
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
