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
 * The next interval starts only when the provider invocation actually starts.
 */
export class ProviderPacer {
  private intervalMs: number;
  private lastStartedAt: number | null = null;
  private nextAvailableAt = 0;
  private readonly queue: Array<PacerRequest<unknown>> = [];
  private staged: PacerRequest<unknown> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    intervalMs = 0,
    private readonly now: () => number = () => Date.now()
  ) {
    this.assertInterval(intervalMs);
    this.intervalMs = intervalMs;
  }

  get interval(): number {
    return this.intervalMs;
  }

  get waiting(): number {
    return this.queue.length + (this.staged ? 1 : 0);
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
    let eta: number | null = this.staged ? null : this.nextAvailableAt;

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
    return Math.max(now, this.nextAvailableAt) + this.waiting * this.intervalMs;
  }

  get queueHead(): { threadId: string; availableAt: number } | null {
    if (this.staged) return null;
    const request = this.queue[0];
    if (!request?.opts.threadId) return null;
    return { threadId: request.opts.threadId, availableAt: this.nextAvailableAt };
  }

  setInterval(intervalMs: number): void {
    this.assertInterval(intervalMs);
    this.intervalMs = intervalMs;
    if (this.lastStartedAt !== null) {
      this.nextAvailableAt = this.lastStartedAt + intervalMs;
    }
    this.schedule();
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
    this.schedule();
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
    const waitMs = Math.max(0, this.nextAvailableAt - this.now());
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
      if (!request.responsive && this.now() < this.nextAvailableAt) {
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
    this.lastStartedAt = startedAt;
    this.nextAvailableAt = startedAt + this.intervalMs;
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
}

/** The provider-wide weekly reading used only to break an immediate-lane tie. */
interface WeeklyQuotaObservation {
  /** Percentage of the weekly quota still available, from 0 through 100. */
  percentLeft: number;
  /** When this reading was scraped, as an ISO-8601 instant. */
  observedAt: string;
  /** The weekly window's next reset, as an ISO-8601 instant. */
  resetAtIso: string;
}

const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// This matches the longest existing quota-service cache lifetime (Codex).
// Older readings remain useful for dashboard history, but not for admission.
const MAX_WEEKLY_QUOTA_AGE_MS = 30 * 60 * 1000;

/**
 * Return a candidate's weekly headroom relative to the remaining weekly
 * window, or `undefined` unless the quota evidence is safe to compare.
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
  if (observedAt > now || now - observedAt > MAX_WEEKLY_QUOTA_AGE_MS) return undefined;
  if (resetAt <= now || resetAt > now + WEEKLY_WINDOW_MS) return undefined;

  const windowRemainingPct = ((resetAt - now) / WEEKLY_WINDOW_MS) * 100;
  return windowRemainingPct > 0 ? observation.percentLeft / windowRemainingPct : undefined;
}

/**
 * Pick the earliest-available declared candidate across canonical provider
 * lanes, by comparing each lane's side-effect-free {@link ProviderPacer.quote}.
 * When multiple lanes are available now, trustworthy weekly quota headroom
 * breaks that zero-delay tie. Otherwise, declaration order remains the stable
 * fallback (including unknown, stale, invalid, or tied quota evidence).
 * Callers must reserve the winning lane (via `submit`) synchronously, with no
 * `await` between calling this and reserving — JS's single-threaded execution
 * is what keeps concurrent wakes from double-booking the same slot.
 *
 * For a responsive request (`opts.responsive`), pacing never disqualifies a
 * lane: when at least two lanes have trustworthy weekly quota evidence, the
 * one with more headroom against the remaining window always wins, no matter
 * how hot any lane is running against its pace (#655). Lanes at absolute zero
 * are expected to have been excluded by the caller. With fewer than two
 * comparable observations, the responsive rule falls back to the same
 * quote-based selection as normal work.
 */
export function selectPoolLane<C>(
  candidates: readonly PoolLaneCandidate<C>[],
  now: number,
  opts: { responsive?: boolean } = {}
): PoolLaneCandidate<C> | undefined {
  if (opts.responsive === true) {
    // Absolute quota gates, pacing ranks: a lane that still has quota is
    // preferred by headroom regardless of its pacing quote, and a pacing-hot
    // lane is never disqualified — the reservation bypasses the queue anyway.
    const comparable = candidates.flatMap((candidate) => {
      const headroom = weeklyQuotaHeadroom(candidate.weeklyQuota, now);
      return headroom === undefined ? [] : [{ candidate, headroom }];
    });
    if (comparable.length >= 2) {
      return comparable.reduce((best, candidate) =>
        candidate.headroom > best.headroom ? candidate : best
      ).candidate;
    }
  }

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
  if (!best || immediatelyAvailable.length < 2) return best;

  let bestHeadroom: number | undefined;
  let headroomWinner: PoolLaneCandidate<C> | undefined;
  for (const candidate of immediatelyAvailable) {
    const headroom = weeklyQuotaHeadroom(candidate.weeklyQuota, now);
    if (headroom === undefined) continue;
    if (bestHeadroom === undefined || headroom > bestHeadroom) {
      bestHeadroom = headroom;
      headroomWinner = candidate;
    }
  }
  return headroomWinner ?? best;
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
 * exhausted lanes through this same selection path, ranks survivors by quota
 * headroom rather than pacing heat, and then skips pacing once its selected
 * lane has been reserved (#655).
 *
 * `promote()` re-runs the normal selection rule before bypassing pacing. When
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

/** A lane can claim new work only with nothing queued or staged and no pacing delay left. */
function isIdleLane(pacer: ProviderPacer, now: number): boolean {
  return pacer.waiting === 0 && pacer.quote(now) <= now;
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
  /**
   * Set once a later entry has claimed a lane this unclaimed entry cannot use
   * while it kept waiting: the most recent such lane and how many times.
   * Recorded at claim time, so it reports what happened, not a projection.
   */
  skip: { lane: string; count: number } | null;
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
  skip?: { lane: string; count: number };
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
          skip: null,
        });
      }
      position++;
    }
    // Each lane's next projected start. A lane already holding a claim has no
    // honest time until that claim starts, so it offers none.
    const next = new Map<ProviderPacer, number | null>();
    const projected = (pacer: ProviderPacer): number | null => {
      if (!next.has(pacer)) next.set(pacer, pacer.waiting > 0 ? null : pacer.quote(now));
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
          skip: item.skip ? { ...item.skip } : null,
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
   * `selectPoolLane` keeps the weekly-headroom tie-break among idle lanes.
   *
   * This is greedy, as requested in #633: when several lanes are idle in one
   * pass, an earlier actor may take the lane a later, narrower actor needed
   * while another idle lane goes unused until its next event. With one idle
   * lane per pass it is the same as each lane claiming its first compatible
   * actor.
   *
   * An item only ever claims one of its own declared candidates, so a lane
   * never admits a model it does not gate: a model-scoped lane (e.g. Fable
   * under #588) is a distinct candidate lane, not a provider-wide match.
   */
  private claimNormal(): void {
    const now = this.now();
    const busy = new Set<ProviderPacer>();
    const passed: Array<WaitingAdmission<C, unknown>> = [];
    for (const item of [...this.waiting]) {
      const idle = this.healthy(item, false).filter(
        (candidate) => !busy.has(candidate.pacer) && isIdleLane(candidate.pacer, now)
      );
      const selected = selectPoolLane(idle, now);
      if (!selected) {
        passed.push(item);
        continue;
      }
      busy.add(selected.pacer);
      // Every earlier actor still waiting was passed over for this one. Only
      // one whose own lanes exclude the claiming lane counts as a
      // compatibility skip; the rest were held by that lane's halt for them.
      for (const earlier of passed) {
        if (earlier.candidates.some((candidate) => candidate.lane === selected.lane)) continue;
        earlier.skip = { lane: selected.lane, count: (earlier.skip?.count ?? 0) + 1 };
      }
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
        if (candidate.pacer.waiting > 0) continue;
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
