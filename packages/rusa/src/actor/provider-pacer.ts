import {
  RunStartCancelledError,
  type RunStartHandle,
  RunStartStaleProviderError,
} from "./concurrency-limiter.js";

export interface ProviderPacerSubmitOptions {
  responsive?: boolean;
  /** Actor that owns this request, for read-only scheduler observability. */
  threadId?: string;
  /** Submit an eligible normal run to the mesh-wide concurrency queue. */
  enqueueNormal: <T>(fn: () => Promise<T>) => RunStartHandle<T>;
  /** Fires at the actual provider start, never when either queue is entered. */
  onStarted?: () => void;
  /**
   * Consulted at the same selection-time point as the adaptive interval
   * revalidation, right before this request would actually start: applies any
   * pending model/provider change and reports whether the actor's live
   * provider still matches the lane this request was submitted under. A
   * `false` return rejects the request with {@link RunStartStaleProviderError}
   * instead of starting it, so the caller can re-gate under the new provider
   * — a request that waited in this lane must not start (and charge this
   * lane's interval clock) under a provider it no longer belongs to.
   */
  revalidateProvider?: () => boolean;
}

interface PacerRequest<T> {
  fn: () => Promise<T>;
  opts: ProviderPacerSubmitOptions;
  responsive: boolean;
  state: "provider-queued" | "mesh-queued" | "started" | "settled";
  meshRun?: RunStartHandle<void>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/**
 * A FIFO, start-to-start provider governor. Normal runs wait for the adaptive
 * interval and then for mesh concurrency; responsive runs bypass both queues.
 * Only ordinary runs charge or reset the pacing clock; responsive starts leave
 * the ordinary pacing clock unchanged so recurring responsive traffic cannot
 * starve queued ordinary work (#962). The next interval starts only when an
 * ordinary provider invocation actually starts.
 *
 * A pacer may be linked to a provider-wide pacer (#588): it then paces one
 * model's own quota windows on top of the provider's. It is available only
 * when both clocks allow a start, each of its normal starts is charged to the
 * provider clock as well, and the two lanes hold at most one pending request
 * between them, so a model start can neither skip the provider-wide interval
 * nor stage beside a provider-lane start.
 */
export class ProviderPacer {
  private intervalMs: number;
  private lastStartedAt: number | null = null;
  private nextAvailableAt = 0;
  /**
   * The latest exhaustion deadline handed to {@link deferUntil}, kept
   * separately from `nextAvailableAt` (which interval bookkeeping can lower)
   * so lane classification can tell an active deferral apart from an ordinary
   * cooldown (#1351).
   */
  private deferredUntilMs = 0;
  private readonly queue: Array<PacerRequest<unknown>> = [];
  private staged: PacerRequest<unknown> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly dependents = new Set<ProviderPacer>();

  constructor(
    intervalMs = 0,
    private readonly now: () => number = () => Date.now(),
    /** The provider-wide pacer this model pacer also answers to, if any. */
    readonly linked?: ProviderPacer
  ) {
    this.assertInterval(intervalMs);
    this.intervalMs = intervalMs;
    linked?.dependents.add(this);
  }

  get interval(): number {
    return this.intervalMs;
  }

  /**
   * The start spacing that governs this lane: the stricter of its own interval
   * and its linked provider lane's (#588), so a model lane is ranked by the
   * throttle that actually paces it.
   */
  get governingInterval(): number {
    return Math.max(this.intervalMs, this.linked?.intervalMs ?? 0);
  }

  get waiting(): number {
    return this.queue.length + (this.staged ? 1 : 0);
  }

  /**
   * Whether this lane, its linked provider lane, or another model lane linked
   * to the same provider holds a queued or staged request. Such a lane shares
   * the one provider start clock, so it cannot accept new work until that
   * request starts or settles.
   */
  get busy(): boolean {
    const root = this.linked ?? this;
    if (root.waiting > 0) return true;
    for (const dependent of root.dependents) if (dependent.waiting > 0) return true;
    return false;
  }

  /** The earliest start this lane's own clock and its linked provider clock both allow. */
  private get availableAt(): number {
    return Math.max(this.nextAvailableAt, this.linked?.nextAvailableAt ?? 0);
  }

  /**
   * A read-only, side-effect-free snapshot of this lane's FIFO order, for
   * dashboard display only — never persisted, and recomputed fresh on every
   * call from current pacer state.
   *
   * Public contract:
   * - `position` is 0-based within this lane, in FIFO start order. The
   *   staged request (if any) occupies position 0; queued requests follow
   *   in submission order.
   * - `estimatedStartAt` is an epoch-ms projection: the head of the queue
   *   (once the staged request, if any, is out of the way) is estimated at
   *   `nextAvailableAt`, and each subsequent entry adds one `intervalMs`.
   * - `estimatedStartAt` is `null` whenever the time can't be honestly
   *   quoted: for the staged request itself (it has already cleared the
   *   pacing gate and is only waiting on mesh concurrency, not on
   *   `nextAvailableAt`) and for every entry behind it, since the lane
   *   can't advance until the staged request actually starts and
   *   recomputes `nextAvailableAt` — the current value could already be
   *   stale. Callers must render `null` as "unknown", never fabricate a
   *   time.
   * - `pacingIntervalMs` is the lane's current normal-start spacing, rounded
   *   to a whole millisecond here so the wire value is always an integer
   *   (the adaptive controller stores a REAL). `0` means no pacing gap: a
   *   future `estimatedStartAt` on such a lane comes from `deferUntil`.
   * - The gate is derivable, not a separate field: `estimatedStartAt` is
   *   `null` only while a staged head (position 0) holds for mesh
   *   concurrency, and every later entry is then behind that head.
   * - Requests submitted without a `threadId` are omitted from the
   *   returned entries (nothing to key them by) but still consume a
   *   `position`, so surviving entries keep their true FIFO position.
   */
  getQueueSnapshot(): Array<{
    threadId: string;
    position: number;
    estimatedStartAt: number | null;
    /** Current normal-start spacing for this lane, in whole milliseconds. */
    pacingIntervalMs: number;
  }> {
    const snapshot: Array<{
      threadId: string;
      position: number;
      estimatedStartAt: number | null;
      pacingIntervalMs: number;
    }> = [];
    const pacingIntervalMs = Math.round(this.intervalMs);
    let position = 0;
    let eta: number | null = this.staged ? null : this.availableAt;

    if (this.staged) {
      if (this.staged.opts.threadId) {
        snapshot.push({
          threadId: this.staged.opts.threadId,
          position,
          estimatedStartAt: null,
          pacingIntervalMs,
        });
      }
      position++;
    }

    for (const request of this.queue) {
      if (request.opts.threadId) {
        snapshot.push({
          threadId: request.opts.threadId,
          position,
          estimatedStartAt: eta,
          pacingIntervalMs,
        });
      }
      position++;
      if (eta !== null) eta += this.intervalMs;
    }

    return snapshot;
  }

  /**
   * A side-effect-free ETA for the next reservation on this lane: the later of
   * `now` and the known next-available timestamp, plus one interval per
   * request already queued or staged ahead of it. Lets a multi-lane pool
   * compare candidates before committing to one via {@link submit}.
   */
  quote(now: number = this.now()): number {
    return Math.max(now, this.availableAt) + this.waiting * this.intervalMs;
  }

  get queueHead(): { threadId: string; availableAt: number } | null {
    if (this.staged) return null;
    const request = this.queue[0];
    if (!request?.opts.threadId) return null;
    return { threadId: request.opts.threadId, availableAt: this.availableAt };
  }

  setInterval(intervalMs: number): void {
    this.assertInterval(intervalMs);
    this.intervalMs = intervalMs;
    if (this.lastStartedAt !== null) {
      this.nextAvailableAt = this.lastStartedAt + intervalMs;
    }
    this.schedule();
    for (const dependent of this.dependents) dependent.schedule();
  }

  /**
   * Defer the next start to at least `availableAtMs` (e.g. when quota is exhausted
   * until a specific window rollover timestamp).
   */
  deferUntil(availableAtMs: number): void {
    if (!Number.isFinite(availableAtMs) || availableAtMs < 0) {
      throw new Error(`availableAtMs must be a non-negative finite number, got ${availableAtMs}`);
    }
    this.nextAvailableAt = Math.max(this.nextAvailableAt, availableAtMs);
    this.deferredUntilMs = Math.max(this.deferredUntilMs, availableAtMs);
    this.schedule();
    for (const dependent of this.dependents) dependent.schedule();
  }

  /**
   * Whether an exhaustion deferral this pacer or its linked provider pacer
   * holds is still in the future at `atMs`. Scheduling still reads
   * `nextAvailableAt`; this is the classification signal for "the lane is
   * waiting out an exhaustion deadline" (#1351), which is never true of a
   * mere post-start cooldown.
   */
  isDeferredAt(atMs: number): boolean {
    return this.deferredUntilMs > atMs || (this.linked?.isDeferredAt(atMs) ?? false);
  }

  submit<T>(fn: () => Promise<T>, opts: ProviderPacerSubmitOptions): RunStartHandle<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const request: PacerRequest<T> = {
      fn,
      opts,
      responsive: opts.responsive === true,
      state: opts.responsive ? "mesh-queued" : "provider-queued",
      resolve,
      reject,
    };

    if (request.responsive) {
      queueMicrotask(() => this.start(request));
    } else {
      this.queue.push(request as PacerRequest<unknown>);
      this.schedule();
    }

    return {
      result,
      get started() {
        return request.state === "started" || request.state === "settled";
      },
      promote: () => this.promote(request),
      cancel: () => this.cancel(request),
    };
  }

  private cancel<T>(request: PacerRequest<T>): boolean {
    if (request.state === "started" || request.state === "settled") return false;
    if (request.state === "provider-queued") {
      const index = this.queue.indexOf(request as PacerRequest<unknown>);
      if (index >= 0) this.queue.splice(index, 1);
    } else if (request.meshRun && (!request.meshRun.cancel || !request.meshRun.cancel())) {
      return false;
    }
    if (this.staged === request) this.staged = null;
    request.meshRun = undefined;
    request.state = "settled";
    request.reject(new RunStartCancelledError());
    this.schedule();
    return true;
  }

  private promote<T>(request: PacerRequest<T>): void {
    if (request.state === "started" || request.state === "settled" || request.responsive) return;
    request.responsive = true;
    if (request.state === "provider-queued") {
      const index = this.queue.indexOf(request as PacerRequest<unknown>);
      if (index >= 0) this.queue.splice(index, 1);
      request.state = "mesh-queued";
      queueMicrotask(() => this.start(request));
      this.schedule();
      return;
    }
    request.meshRun?.promote();
  }

  private schedule(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.staged || this.queue.length === 0) return;
    const waitMs = Math.max(0, this.availableAt - this.now());
    if (waitMs === 0) {
      this.stageNext();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.stageNext();
    }, waitMs);
    this.timer.unref?.();
  }

  private stageNext(): void {
    if (this.staged || this.queue.length === 0) return;
    const request = this.queue.shift();
    if (!request) return;
    request.state = "mesh-queued";
    this.staged = request;
    request.meshRun = request.opts.enqueueNormal(async () => {
      if (this.staged === request) this.staged = null;
      request.meshRun = undefined;

      // The actor's provider may have changed while this ticket waited in the
      // mesh queue. Starting it here would charge this lane's interval clock
      // for a run that is about to launch under a different provider. Reject
      // so the caller re-gates under the now-live provider and picks the
      // correct lane instead.
      if (!request.responsive && request.opts.revalidateProvider?.() === false) {
        request.state = "settled";
        request.reject(new RunStartStaleProviderError());
        this.schedule();
        return;
      }

      // The adaptive interval may have increased while this ticket waited in
      // the mesh queue. Revalidate at selection time rather than starting early.
      if (!request.responsive && this.now() < this.availableAt) {
        request.state = "provider-queued";
        this.queue.unshift(request);
        this.schedule();
        return;
      }
      await this.start(request);
    });
    void request.meshRun.result.catch((error) => {
      if (request.state !== "settled") {
        request.state = "settled";
        request.reject(error);
      }
      // `staged` was already cleared at the top of this closure, before
      // `revalidateProvider()` (a production callback that applies registry
      // state and can throw) had a chance to run. A throw here skips every
      // `schedule()` call this closure would otherwise reach, so without this
      // call nothing re-triggers `stageNext()` and every request still
      // waiting behind this one strands in the lane forever.
      this.schedule();
    });
  }

  private async start<T>(request: PacerRequest<T>): Promise<void> {
    if (request.state === "started" || request.state === "settled") return;
    request.state = "started";
    const startedAt = this.now();
    if (!request.responsive) {
      this.lastStartedAt = startedAt;
      this.nextAvailableAt = startedAt + this.intervalMs;
      this.linked?.charge(startedAt);
    }
    request.opts.onStarted?.();
    this.schedule();
    try {
      request.resolve(await request.fn());
    } catch (error) {
      request.reject(error);
    } finally {
      request.state = "settled";
    }
  }

  /**
   * Record a linked model lane's start on this provider clock. An earlier
   * deferral (e.g. an exhaustion deadline) is kept rather than shortened.
   */
  private charge(startedAt: number): void {
    this.lastStartedAt = startedAt;
    this.nextAvailableAt = Math.max(this.nextAvailableAt, startedAt + this.intervalMs);
    this.schedule();
    for (const dependent of this.dependents) dependent.schedule();
  }

  private assertInterval(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new Error(`intervalMs must be >= 0, got ${intervalMs}`);
    }
  }
}

export interface PoolLaneCandidate<C> {
  config: C;
  lane: string;
  pacer: ProviderPacer;
  /**
   * The latest provider-wide weekly quota observation, when one is available
   * from the shared quota state. It is optional because model pools also run
   * without quota probing configured.
   */
  weeklyQuota?: WeeklyQuotaObservation;
  /**
   * Whether the quota controller is asking for no throttle on this candidate
   * lane (#1351): every current bucket on the provider lane and any
   * applicable model lanes has a fresh reading with `error <= 0`. Optional.
   * {@link selectPoolLane} counts a lane unthrottled when this is `true`,
   * when `Math.round(pacer.governingInterval) === 0`, **and** the pacer holds
   * no active exhaustion deferral (`ProviderPacer.isDeferredAt`) — so an
   * omitted, missing or stale (`false`) reading leaves a lane whose pacer has
   * reached 0 ms unthrottled and ranks every other lane by its governing
   * throttle, while a lane waiting out a `deferUntil` deadline never counts
   * as unthrottled.
   */
  controllerUnthrottled?: boolean;
}

/** The provider-wide weekly reading used only to break an equally-throttled tie. */
interface WeeklyQuotaObservation {
  /** Percentage of the weekly quota still available, from 0 through 100. */
  percentLeft: number;
  /** When this reading was scraped, as an ISO-8601 instant. */
  observedAt: string;
  /** The weekly window's next reset, as an ISO-8601 instant. */
  resetAtIso: string;
}

const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Return a candidate's weekly headroom relative to the remaining weekly
 * window, or `undefined` unless the quota evidence is safe to compare.
 * There is deliberately no age cut-off (#1351): weekly quota moves slowly
 * against a seven-day window, a rolled-over window fails the reset checks
 * below, and headroom only breaks ties between equally throttled lanes, so
 * an older valid reading cannot move work off a preferred lane.
 */
function weeklyQuotaHeadroom(
  observation: WeeklyQuotaObservation | undefined,
  now: number
): number | undefined {
  if (!observation || !Number.isFinite(observation.percentLeft)) return undefined;
  if (observation.percentLeft < 0 || observation.percentLeft > 100) return undefined;

  const observedAt = Date.parse(observation.observedAt);
  const resetAt = Date.parse(observation.resetAtIso);
  if (!Number.isFinite(observedAt) || !Number.isFinite(resetAt)) return undefined;
  if (observedAt > now) return undefined;
  if (resetAt <= now || resetAt > now + WEEKLY_WINDOW_MS) return undefined;

  const windowRemainingPct = ((resetAt - now) / WEEKLY_WINDOW_MS) * 100;
  return windowRemainingPct > 0 ? observation.percentLeft / windowRemainingPct : undefined;
}

/**
 * Pick the winning declared candidate across canonical provider lanes (#1351):
 *
 * 1. Lanes the controller is not throttling (`controllerUnthrottled === true`,
 *    or `Math.round(pacer.governingInterval) === 0`) are equal on pacing.
 *    Among them, **the first declared wins**. A lane waiting out an
 *    exhaustion deferral (`ProviderPacer.isDeferredAt`) is not unthrottled,
 *    whatever its interval rounds to: every deferral is exhaustion evidence,
 *    even when the coordinator reading that set it has gone stale.
 * 2. A preferred lane is skipped only when it is throttled or exhausted.
 *    Among throttled lanes, the shortest governing throttle
 *    ({@link ProviderPacer.governingInterval} at whole-millisecond resolution:
 *    a model lane's own interval or its provider's, whichever is stricter)
 *    wins (#895).
 * 3. Trustworthy weekly quota headroom only breaks ties between **equally
 *    throttled** lanes, and only when **every** lane in the tie has a
 *    trustworthy reading; one lane's reading never outranks declared order
 *    over lanes with missing or untrustworthy evidence. It never outranks
 *    declared order among unthrottled lanes. Tied headroom falls back to
 *    declared order.
 *
 * For normal requests, {@link ProviderPacer.quote} still gates availability:
 * when only one lane is available now (or all lanes must wait), the earliest
 * quote wins; when multiple lanes are available now, the rule above decides.
 * The quote rule means a preferred lane that is still waiting out its last
 * start's interval does not hold normal work: a lane available now wins over
 * one that is not, whatever their declared order.
 *
 * For responsive requests (`opts.responsive`), pacing never disqualifies a
 * lane and the reservation bypasses the wait, so unthrottled lanes win in
 * declared order ahead of lanes that count as throttled — including lanes
 * under an active exhaustion deferral, which rank by the pre-existing
 * throttled-lane rules below — and among throttled lanes the shortest
 * governing throttle ranks first, with weekly headroom breaking ties
 * between equally throttled lanes. Without unanimous headroom evidence, an
 * equally-throttled responsive tie goes to the earliest quote, as normal
 * admission would pick (#655). Lanes at absolute zero are expected to have
 * been excluded by the caller.
 *
 * Callers must reserve the winning lane (via `submit`) synchronously, with no
 * `await` between calling this and reserving — JS's single-threaded execution
 * is what keeps concurrent wakes from double-booking the same slot.
 */
export function selectPoolLane<C>(
  candidates: readonly PoolLaneCandidate<C>[],
  now: number,
  opts: { responsive?: boolean } = {}
): PoolLaneCandidate<C> | undefined {
  if (candidates.length === 0) return undefined;
  if (opts.responsive === true) {
    const unthrottled = candidates.filter((candidate) => isCandidateUnthrottled(candidate, now));
    if (unthrottled.length > 0) return unthrottled[0];

    // All candidates are throttled: shortest governing throttle wins (#895),
    // and weekly headroom breaks the tie only when every tied lane has a
    // trustworthy reading. Otherwise the tie goes to the lane normal admission
    // would pick among those tied lanes, the earliest quote with declared
    // order breaking equal quotes (unchanged from #655), so responsive and
    // normal priority differ only in bypassing the wait.
    const shortest = withShortestGoverningInterval(candidates);
    return headroomTieWinner(shortest, now) ?? earliestQuote(shortest, now).best;
  }
  return selectByQuote(candidates, now);
}

/**
 * The candidate with the earliest quote (declared order breaks equal quotes),
 * and every candidate available now. A quote is never earlier than `now`, so
 * the first available candidate is also the earliest.
 */
function earliestQuote<C>(
  candidates: readonly PoolLaneCandidate<C>[],
  now: number
): { best: PoolLaneCandidate<C> | undefined; immediatelyAvailable: PoolLaneCandidate<C>[] } {
  let best: PoolLaneCandidate<C> | undefined;
  let bestQuote = Number.POSITIVE_INFINITY;
  const immediatelyAvailable: PoolLaneCandidate<C>[] = [];
  for (const candidate of candidates) {
    const quote = candidate.pacer.quote(now);
    if (quote < bestQuote) {
      bestQuote = quote;
      best = candidate;
    }
    if (quote <= now) immediatelyAvailable.push(candidate);
  }
  return { best, immediatelyAvailable };
}

/**
 * Earliest quote first; among lanes available now, unthrottled lanes win in
 * declared order, otherwise the shortest governing throttle ranks the tie and
 * weekly headroom decides only when every tied lane has a trustworthy reading.
 */
function selectByQuote<C>(
  candidates: readonly PoolLaneCandidate<C>[],
  now: number
): PoolLaneCandidate<C> | undefined {
  const { best, immediatelyAvailable } = earliestQuote(candidates, now);
  if (!best || immediatelyAvailable.length < 2) return best;

  const unthrottled = immediatelyAvailable.filter((candidate) =>
    isCandidateUnthrottled(candidate, now)
  );
  if (unthrottled.length > 0) return unthrottled[0];

  const shortest = withShortestGoverningInterval(immediatelyAvailable);
  return headroomTieWinner(shortest, now) ?? shortest[0];
}

/**
 * The headroom winner across an equally-throttled tie, or `undefined` when
 * headroom must not be consulted at all (#1351): weekly headroom decides a
 * tie only when **every** lane in the tie has a trustworthy reading, so one
 * lane's observation never outranks declared order over lanes whose
 * evidence is missing or untrustworthy. Tied headroom keeps the first declared.
 */
function headroomTieWinner<C>(
  tie: readonly PoolLaneCandidate<C>[],
  now: number
): PoolLaneCandidate<C> | undefined {
  let winner: PoolLaneCandidate<C> | undefined;
  let bestHeadroom: number | undefined;
  for (const candidate of tie) {
    const headroom = weeklyQuotaHeadroom(candidate.weeklyQuota, now);
    if (headroom === undefined) return undefined;
    if (bestHeadroom === undefined || headroom > bestHeadroom) {
      bestHeadroom = headroom;
      winner = candidate;
    }
  }
  return winner;
}

/**
 * Whether a lane counts as unthrottled for rule 1 (#1351). One-directional
 * and deferral-aware: an active exhaustion deferral disqualifies the lane
 * whatever its governing interval rounds to (the deferral is exhaustion
 * evidence, even when the reading that set it has gone stale), while a
 * `false` or missing `controllerUnthrottled` reading never demotes a lane
 * the pacer itself has released to 0 ms — only a non-zero governing interval
 * ranks a lane as throttled.
 */
function isCandidateUnthrottled<C>(candidate: PoolLaneCandidate<C>, now: number): boolean {
  if (candidate.pacer.isDeferredAt(now)) return false;
  return (
    candidate.controllerUnthrottled === true || Math.round(candidate.pacer.governingInterval) === 0
  );
}

/**
 * The candidates, in declared order, whose governing pacer interval is shortest
 * at whole-millisecond pacing resolution.
 */
function withShortestGoverningInterval<C>(
  candidates: readonly PoolLaneCandidate<C>[]
): PoolLaneCandidate<C>[] {
  const shortest = Math.min(
    ...candidates.map((candidate) => Math.round(candidate.pacer.governingInterval))
  );
  return candidates.filter(
    (candidate) => Math.round(candidate.pacer.governingInterval) === shortest
  );
}

export interface PoolGateSelection<C> {
  candidate: C;
  lane: string;
  declaredIndex: number;
  eligibleAt: number;
  responsive: boolean;
}

export interface SubmitPoolGateOptions<C>
  extends Omit<ProviderPacerSubmitOptions, "revalidateProvider"> {
  /** Excludes a declared candidate from selection (e.g. an emergency-halted provider). */
  isHalted?: (config: C) => boolean;
  /**
   * Excludes a lane from responsive selection when an authoritative admission
   * source says it has no quota. Normal admission retains its existing pacing
   * behavior; a later promotion applies this same predicate before reselecting.
   */
  isExhausted?: (config: C) => boolean;
  /** Builds the terminal error when every non-halted candidate is exhausted. */
  onResponsivePoolExhausted?: (candidates: readonly C[]) => Error;
  /**
   * Fires synchronously when the queued selection is first reserved, reselected,
   * or promoted in place, so callers can track its declared tuple and current
   * priority for cancellation and telemetry.
   */
  onSelected?: (selection: PoolGateSelection<C>) => void;
  /** Same contract as {@link ProviderPacerSubmitOptions.revalidateProvider}, scoped to the currently reserved candidate. */
  revalidateProvider?: (config: C) => boolean;
}

/**
 * Reserve the earliest-available declared candidate across multiple provider
 * lanes as a single composed {@link RunStartHandle}. A normal request paces
 * through the winning lane's `ProviderPacer`, chosen by {@link selectPoolLane}
 * among non-halted candidates. Responsive priority excludes coordinator-known
 * exhausted lanes through this same selection path, ranks survivors by the
 * responsive rule of {@link selectPoolLane} (first-declared unthrottled lane,
 * else shortest governing throttle with unanimous weekly headroom breaking
 * ties, #1351), and then skips pacing once its selected lane has been
 * reserved (#655).
 *
 * `promote()` re-runs that responsive selection before bypassing pacing. When
 * the newly selected lane differs, the stale reservation is cancelled; a
 * `generation` counter on the outer handle ignores the stale lane's
 * now-asynchronous cancellation rejection so it can never clobber the freshly
 * reserved lane's later result.
 */
export function submitPoolGate<C, T>(
  fn: (config: C) => Promise<T>,
  candidates: readonly PoolLaneCandidate<C>[],
  opts: SubmitPoolGateOptions<C>,
  now: () => number = () => Date.now()
): RunStartHandle<T> {
  if (candidates.length === 0) {
    throw new Error("submitPoolGate requires at least one candidate");
  }

  let resolveResult!: (value: T | PromiseLike<T>) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<T>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  let generation = 0;
  let inner: RunStartHandle<T> | undefined;
  let currentCandidate: PoolLaneCandidate<C> | undefined;
  let settled = false;

  const healthy = (responsive: boolean): readonly PoolLaneCandidate<C>[] => {
    const alive = opts.isHalted ? candidates.filter((c) => !opts.isHalted?.(c.config)) : candidates;
    // Never produce an unreservable pool: if every declared candidate reads
    // as halted (e.g. a race with the halt map), fall back to the full pool
    // and let the caller's own beforeRun/halt gate remain the real authority.
    if (alive.length === 0) return candidates;
    if (!responsive || !opts.isExhausted) return alive;
    return alive.filter((c) => !opts.isExhausted?.(c.config));
  };

  const exhaustedError = (): Error =>
    opts.onResponsivePoolExhausted?.(candidates.map((candidate) => candidate.config)) ??
    new Error("model pool exhausted");

  const rejectedHandle = (error: Error): RunStartHandle<T> => {
    const result = Promise.reject<T>(error);
    result.catch(() => {});
    return {
      result,
      started: false,
      promote: () => {},
      cancel: () => false,
    };
  };

  const reportSelection = (
    candidate: PoolLaneCandidate<C>,
    responsive: boolean,
    eligibleAt: number
  ): void => {
    opts.onSelected?.({
      candidate: candidate.config,
      lane: candidate.lane,
      declaredIndex: candidates.indexOf(candidate),
      eligibleAt,
      responsive,
    });
  };

  const reserve = (candidate: PoolLaneCandidate<C>, responsive: boolean): void => {
    generation++;
    const myGeneration = generation;
    currentCandidate = candidate;
    const eligibleAt = responsive ? now() : candidate.pacer.quote(now());
    const handle = candidate.pacer.submit(() => fn(candidate.config), {
      responsive,
      threadId: opts.threadId,
      enqueueNormal: opts.enqueueNormal,
      onStarted: opts.onStarted,
      revalidateProvider: opts.revalidateProvider
        ? () => opts.revalidateProvider?.(candidate.config) ?? true
        : undefined,
    });
    inner = handle;
    handle.result.then(
      (value) => {
        if (myGeneration !== generation || settled) return;
        settled = true;
        resolveResult(value);
      },
      (error: unknown) => {
        if (myGeneration !== generation || settled) return;
        settled = true;
        rejectResult(error);
      }
    );
    reportSelection(candidate, responsive, eligibleAt);
  };

  const responsive = opts.responsive === true;
  const initial = selectPoolLane(healthy(responsive), now(), { responsive });
  if (!initial) return rejectedHandle(exhaustedError());
  reserve(initial, responsive);

  return {
    result,
    get started() {
      return inner?.started ?? false;
    },
    promote: () => {
      if (settled || inner?.started) return;
      const target = selectPoolLane(healthy(true), now(), { responsive: true });
      if (!target) {
        generation++;
        settled = true;
        const stale = inner;
        inner = undefined;
        stale?.cancel?.();
        rejectResult(exhaustedError());
        return;
      }
      if (currentCandidate === target) {
        // The reservation stays put, but its queued priority has changed.
        // Publish that transition so dashboard/HALT state cannot report a
        // normal request after it has bypassed the queues.
        reportSelection(target, true, now());
        inner?.promote();
        return;
      }
      // Reselecting onto a different, earlier-declared healthy lane: reserve
      // it first (bumping `generation`) so the stale lane's async
      // cancellation rejection is guaranteed to be ignored by `reserve`'s
      // generation guard above, then cancel the stale reservation.
      const stale = inner;
      reserve(target, true);
      stale?.cancel?.();
    },
    cancel: () => {
      if (settled) return false;
      return inner?.cancel?.() ?? false;
    },
  };
}

/** Distinct lanes among an admission's declared candidates, in declared order. */
function lanesOf<C>(item: { candidates: readonly PoolLaneCandidate<C>[] }): string[] {
  return [...new Set(item.candidates.map((candidate) => candidate.lane))];
}

/**
 * A lane can claim new work only with nothing queued or staged on it or on a
 * lane sharing its provider clock, and no pacing delay left.
 */
function isIdleLane(pacer: ProviderPacer, now: number): boolean {
  return !pacer.busy && pacer.quote(now) <= now;
}

/** A read-only entry in the leader-local, cross-lane admission queue. */
export interface UnifiedAdmissionQueueSnapshot {
  /** Owning actor; entries without an actor identity are intentionally omitted. */
  threadId: string;
  /** Zero-based position in the one global list, before lane compatibility filtering. */
  position: number;
  /**
   * Projected start on this entry's earliest compatible lane, stacking one
   * interval per earlier entry projected onto the same lane, as the old
   * per-lane FIFO did. A projection, never a reservation. `null` when it
   * cannot be honestly quoted: the entry is claimed and waiting on mesh
   * concurrency, or every lane it could use holds such a claim.
   */
  estimatedStartAt: number | null;
  /** Interval of the lane supplying `estimatedStartAt`, rounded for the wire. */
  pacingIntervalMs: number;
  /** Holds a lane and waits on mesh concurrency; shown but never reorderable. */
  claimed: boolean;
  /** Distinct lanes among the entry's declared candidates, in declared order. */
  compatibleLanes: string[];
  /** The lane a claimed entry holds; `null` while unclaimed. */
  claimedLane: string | null;
}

/** Outcome of an operator reorder checked against the order the UI observed. */
export type AdmissionReorderResult =
  | { status: "ok"; order: string[] }
  | { status: "stale"; order: string[] }
  | { status: "invalid"; order: string[] };

interface WaitingAdmission<C, T> {
  fn: (config: C) => Promise<T>;
  candidates: readonly PoolLaneCandidate<C>[];
  opts: SubmitPoolGateOptions<C>;
  responsive: boolean;
  state: "waiting" | "claimed" | "settled";
  inner?: RunStartHandle<T>;
  claimedLane?: PoolLaneCandidate<C>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  result: Promise<T>;
}

/**
 * One leader-local waiting list shared by every provider lane.
 *
 * A lane is a processor rather than an owner of a private queue: whenever a
 * lane can accept a normal start it synchronously scans this list and claims
 * its first compatible actor. Claiming removes the item permanently and hands
 * its exact declared candidate to the existing ProviderPacer/mesh-concurrency
 * path. Therefore a restart needs no queue recovery — the durable inbox and
 * RunManager dispatch reconciliation remain the source of truth — and the
 * small after-claim-before-completion ambiguity is the same as any accepted
 * in-memory run start.
 */
export class UnifiedAdmissionQueue<C> {
  private readonly waiting: Array<WaitingAdmission<C, unknown>> = [];
  /** Claimed items until they settle; read only by `snapshot`. */
  private readonly claimed = new Set<WaitingAdmission<C, unknown>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Append one actor's pending start, or claim responsive work at once: it
   * never waits in the list. The returned handle can promote/cancel while the
   * actor is still unclaimed; after a lane claim it delegates to the normal
   * pacer handle.
   */
  enqueue<T>(
    fn: (config: C) => Promise<T>,
    candidates: readonly PoolLaneCandidate<C>[],
    opts: SubmitPoolGateOptions<C>
  ): RunStartHandle<T> {
    if (candidates.length === 0) {
      throw new Error("UnifiedAdmissionQueue requires at least one candidate");
    }
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const item: WaitingAdmission<C, T> = {
      fn,
      candidates,
      opts,
      responsive: opts.responsive === true,
      state: "waiting",
      resolve,
      reject,
      result,
    };
    if (item.responsive) {
      this.claimResponsive(item as WaitingAdmission<C, unknown>);
    } else {
      this.waiting.push(item as WaitingAdmission<C, unknown>);
      this.drain();
    }

    return {
      result,
      get started() {
        return item.inner?.started ?? false;
      },
      promote: () => this.promote(item),
      cancel: () => this.cancel(item),
    };
  }

  /**
   * Side-effect-free global ordering for dashboard display and #570 controls.
   * Claimed actors that have not started yet (at most one per lane, waiting on
   * mesh concurrency) come first with a `null` ETA, as the old per-lane staged
   * head did; unclaimed actors follow in list order with a projected ETA.
   */
  snapshot(): UnifiedAdmissionQueueSnapshot[] {
    const now = this.now();
    const snapshot: UnifiedAdmissionQueueSnapshot[] = [];
    let position = 0;
    for (const item of this.claimed) {
      if (item.inner?.started) continue;
      if (item.opts.threadId) {
        snapshot.push({
          threadId: item.opts.threadId,
          position,
          estimatedStartAt: null,
          pacingIntervalMs: Math.round(item.claimedLane?.pacer.interval ?? 0),
          claimed: true,
          compatibleLanes: lanesOf(item),
          claimedLane: item.claimedLane?.lane ?? null,
        });
      }
      position++;
    }
    // Each lane's next projected start. A lane already holding a claim has no
    // honest time until that claim starts, so it offers none.
    const next = new Map<ProviderPacer, number | null>();
    const projected = (pacer: ProviderPacer): number | null => {
      if (!next.has(pacer)) next.set(pacer, pacer.busy ? null : pacer.quote(now));
      return next.get(pacer) ?? null;
    };
    for (const item of this.waiting) {
      let lane: ProviderPacer | undefined;
      let eta: number | null = null;
      for (const candidate of this.healthy(item, false)) {
        const at = projected(candidate.pacer);
        if (at !== null && (eta === null || at < eta)) {
          lane = candidate.pacer;
          eta = at;
        }
      }
      if (lane && eta !== null) next.set(lane, eta + lane.interval);
      if (item.opts.threadId) {
        snapshot.push({
          threadId: item.opts.threadId,
          position,
          estimatedStartAt: eta,
          pacingIntervalMs: lane ? Math.round(lane.interval) : 0,
          claimed: false,
          compatibleLanes: lanesOf(item),
          claimedLane: null,
        });
      }
      position++;
    }
    return snapshot;
  }

  /**
   * Move an unclaimed actor before another unclaimed actor, or to the end
   * when `beforeThreadId` is omitted. Claims are never rewritten. No re-scan
   * follows: after a drain no unclaimed actor has an idle lane, so order only
   * matters at the next lane event.
   */
  reorder(threadId: string, beforeThreadId?: string): boolean {
    const indexOf = (id: string) => this.waiting.findIndex((item) => item.opts.threadId === id);
    const from = indexOf(threadId);
    if (from < 0 || threadId === beforeThreadId) return false;
    if (beforeThreadId !== undefined && indexOf(beforeThreadId) < 0) return false;
    const [item] = this.waiting.splice(from, 1);
    if (!item) return false;
    const to = beforeThreadId === undefined ? this.waiting.length : indexOf(beforeThreadId);
    this.waiting.splice(to, 0, item);
    return true;
  }

  /** Unclaimed actors' thread ids in list order: the only part `reorder` moves. */
  unclaimedOrder(): string[] {
    const order: string[] = [];
    for (const item of this.waiting) if (item.opts.threadId) order.push(item.opts.threadId);
    return order;
  }

  /**
   * An operator reorder (#570) applied only if the list is still the one the
   * operator saw: `observed` must equal `unclaimedOrder()` exactly, so a
   * claim, arrival, cancellation or another reorder in between makes the
   * request `stale` instead of moving an actor relative to a list nobody saw.
   * The check is deliberately whole-list rather than target-and-anchor: a
   * move means "this position in the list I saw", and the dashboard resyncs
   * after a 409, so a busy queue costs a retry, never a misplaced actor.
   * A claimed actor is never in that order, so it can be neither moved nor
   * used as an anchor.
   */
  reorderObserved(
    observed: readonly string[],
    threadId: string,
    beforeThreadId?: string
  ): AdmissionReorderResult {
    const current = this.unclaimedOrder();
    if (observed.length !== current.length || observed.some((id, i) => id !== current[i])) {
      return { status: "stale", order: current };
    }
    if (!this.reorder(threadId, beforeThreadId)) return { status: "invalid", order: current };
    return { status: "ok", order: this.unclaimedOrder() };
  }

  /** Re-quote live lane state after a quota/controller update. */
  refresh(): void {
    this.drain();
  }

  private promote<T>(item: WaitingAdmission<C, T>): void {
    if (item.state === "claimed") {
      item.inner?.promote();
      return;
    }
    if (item.state !== "waiting") return;
    item.responsive = true;
    this.claimResponsive(item as WaitingAdmission<C, unknown>);
  }

  private cancel<T>(item: WaitingAdmission<C, T>): boolean {
    if (item.state === "claimed") return item.inner?.cancel?.() ?? false;
    if (item.state !== "waiting") return false;
    this.settleWaiting(item, new RunStartCancelledError());
    this.drain();
    return true;
  }

  private drain(): void {
    this.claimNormal();
    this.schedule();
  }

  /** Responsive work bypasses pacing, so it claims any healthy lane now or fails. */
  private claimResponsive(item: WaitingAdmission<C, unknown>): void {
    const selected = selectPoolLane(this.healthy(item, true), this.now(), { responsive: true });
    if (selected) this.claim(item, selected);
    else this.settleWaiting(item, this.exhaustedError(item));
  }

  /**
   * Walk the list in order and give each normal item the best of its lanes
   * that is idle now: nothing queued or staged in its pacer and no pacing
   * delay left. Requiring an idle lane keeps at most one claimed-but-unstarted
   * actor per lane, so work waiting on mesh concurrency stays in this list
   * (reorderable, cancellable) rather than draining into per-lane FIFOs.
   * `selectPoolLane` ranks idle lanes: the first-declared unthrottled lane,
   * else the shortest governing throttle with unanimous weekly headroom
   * breaking ties (#1351).
   *
   * This is greedy, as requested in #633: when several lanes are idle in one
   * pass, an earlier actor may take the lane a later, narrower actor needed
   * while another idle lane goes unused until its next event. With one idle
   * lane per pass it is the same as each lane claiming its first compatible
   * actor.
   *
   * An item only ever claims one of its own declared candidates, so a lane
   * never admits a model it does not gate: a model-scoped pacer (e.g. Fable
   * under #588) paces only candidates that declare that model, and shares its
   * provider's clock through the link rather than standing in for it.
   */
  private claimNormal(): void {
    const now = this.now();
    // Keyed by provider clock: a model lane and its provider lane share one,
    // so a pass claims at most one of them.
    const busy = new Set<ProviderPacer>();
    const clockOf = (pacer: ProviderPacer) => pacer.linked ?? pacer;
    for (const item of [...this.waiting]) {
      const idle = this.healthy(item, false).filter(
        (candidate) => !busy.has(clockOf(candidate.pacer)) && isIdleLane(candidate.pacer, now)
      );
      const selected = selectPoolLane(idle, now);
      if (!selected) continue;
      busy.add(clockOf(selected.pacer));
      this.claim(item, selected);
    }
  }

  private claim(item: WaitingAdmission<C, unknown>, selected: PoolLaneCandidate<C>): void {
    if (item.state !== "waiting") return;
    const index = this.waiting.indexOf(item);
    if (index >= 0) this.waiting.splice(index, 1);
    item.state = "claimed";
    item.claimedLane = selected;
    this.claimed.add(item);
    const selectedIndex = item.candidates.indexOf(selected);
    const originalOnSelected = item.opts.onSelected;
    const originalOnStarted = item.opts.onStarted;
    let started = false;
    // A one-candidate pool: a later promote() bypasses pacing on this same
    // lane or fails as exhausted, and never transfers the claim.
    const inner = submitPoolGate(item.fn, [selected], {
      ...item.opts,
      responsive: item.responsive,
      onSelected: (selection) =>
        originalOnSelected?.({
          ...selection,
          declaredIndex: selectedIndex,
        }),
      // A start frees the lane. The re-scan runs as a microtask because this
      // callback fires inside the pacer's own start bookkeeping.
      onStarted: () => {
        started = true;
        originalOnStarted?.();
        queueMicrotask(() => this.refresh());
      },
    });
    item.inner = inner;
    // A claim that settles without starting (cancel, stale provider, mesh
    // rejection) frees its lane just as a start does. One that started has
    // already re-scanned, and its freed mesh slot starts the next staged claim
    // through the limiter, which re-scans from that start.
    const release = () => {
      item.state = "settled";
      this.claimed.delete(item);
      if (!started) queueMicrotask(() => this.refresh());
    };
    inner.result.then(
      (value) => {
        release();
        item.resolve(value);
      },
      (error: unknown) => {
        release();
        item.reject(error);
      }
    );
  }

  private healthy(
    item: WaitingAdmission<C, unknown>,
    responsive: boolean
  ): readonly PoolLaneCandidate<C>[] {
    const live = item.opts.isHalted
      ? item.candidates.filter((candidate) => !item.opts.isHalted?.(candidate.config))
      : item.candidates;
    // Match submitPoolGate's normal admission rule: a racing halt observation
    // cannot manufacture a permanently unreservable pool.
    const eligible = live.length > 0 ? live : item.candidates;
    if (!responsive || !item.opts.isExhausted) return eligible;
    return eligible.filter((candidate) => !item.opts.isExhausted?.(candidate.config));
  }

  private exhaustedError(item: WaitingAdmission<C, unknown>): Error {
    return (
      item.opts.onResponsivePoolExhausted?.(item.candidates.map((candidate) => candidate.config)) ??
      new Error("model pool exhausted")
    );
  }

  private settleWaiting<T>(item: WaitingAdmission<C, T>, error: Error): void {
    const index = this.waiting.indexOf(item as WaitingAdmission<C, unknown>);
    if (index >= 0) this.waiting.splice(index, 1);
    item.state = "settled";
    item.reject(error);
  }

  private schedule(): void {
    this.clearTimer();
    if (this.waiting.length === 0) return;
    const now = this.now();
    let next: number | undefined;
    for (const item of this.waiting) {
      for (const candidate of this.healthy(item, false)) {
        // A busy lane frees up through its claimed item's start or
        // settlement, which refreshes; only a pacing delay needs a timer.
        if (candidate.pacer.busy) continue;
        const quote = candidate.pacer.quote(now);
        if (quote > now && (next === undefined || quote < next)) next = quote;
      }
    }
    if (next === undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.drain();
      },
      Math.max(0, next - now)
    );
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
