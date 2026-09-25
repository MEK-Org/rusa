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

/** A read-only entry in the leader-local, cross-lane admission queue. */
export interface UnifiedAdmissionQueueSnapshot {
  /** Owning actor; entries without an actor identity are intentionally omitted. */
  threadId: string;
  /** Zero-based position in the one global list, before lane compatibility filtering. */
  position: number;
  /**
   * The current quote from this entry's best compatible lane, if one is
   * available. This is a projection, never a reservation: an earlier item
   * may claim that lane before this entry does.
   */
  estimatedStartAt: number | null;
  /** Interval of the lane supplying `estimatedStartAt`, rounded for the wire. */
  pacingIntervalMs: number;
  responsive: boolean;
}

interface WaitingAdmission<C, T> {
  fn: (config: C) => Promise<T>;
  candidates: readonly PoolLaneCandidate<C>[];
  opts: SubmitPoolGateOptions<C>;
  responsive: boolean;
  state: "waiting" | "claimed" | "settled";
  inner?: RunStartHandle<T>;
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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private drainAgain = false;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Append one actor's pending start, or place responsive work at the front.
   * The returned handle can promote/cancel while the actor is still unclaimed;
   * after a synchronous lane claim it delegates to the normal pacer handle.
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
    this.insert(item as WaitingAdmission<C, unknown>);
    this.drain();

    return {
      result,
      get started() {
        return item.inner?.started ?? false;
      },
      promote: () => this.promote(item),
      cancel: () => this.cancel(item),
    };
  }

  /** Side-effect-free global ordering for dashboard display and #570 controls. */
  snapshot(): UnifiedAdmissionQueueSnapshot[] {
    const now = this.now();
    const snapshot: UnifiedAdmissionQueueSnapshot[] = [];
    let position = 0;
    for (const item of this.waiting) {
      const candidate = selectPoolLane(this.healthy(item, item.responsive), now, {
        responsive: item.responsive,
      });
      if (item.opts.threadId) {
        snapshot.push({
          threadId: item.opts.threadId,
          position,
          estimatedStartAt: candidate ? candidate.pacer.quote(now) : null,
          pacingIntervalMs: candidate ? Math.round(candidate.pacer.interval) : 0,
          responsive: item.responsive,
        });
      }
      position++;
    }
    return snapshot;
  }

  /**
   * Move an unclaimed actor before another unclaimed actor of the same
   * priority. `beforeThreadId` omitted moves it to the end of its own priority
   * partition. Claims and responsive priority are never rewritten.
   */
  reorder(threadId: string, beforeThreadId?: string): boolean {
    const from = this.waiting.findIndex((item) => item.opts.threadId === threadId);
    if (from < 0) return false;
    const item = this.waiting[from];
    if (!item || item.state !== "waiting") return false;
    const priority = item.responsive;
    this.waiting.splice(from, 1);

    let target = -1;
    if (beforeThreadId !== undefined) {
      target = this.waiting.findIndex(
        (candidate) =>
          candidate.opts.threadId === beforeThreadId && candidate.responsive === priority
      );
      if (target < 0) {
        this.waiting.splice(from, 0, item);
        return false;
      }
    } else {
      target = this.waiting.reduce(
        (end, candidate, index) => (candidate.responsive === priority ? index + 1 : end),
        0
      );
    }
    this.waiting.splice(target, 0, item);
    this.drain();
    return true;
  }

  /** Re-quote live lane state after a quota/controller update. */
  refresh(): void {
    this.drain();
  }

  private insert(item: WaitingAdmission<C, unknown>): void {
    if (!item.responsive) {
      this.waiting.push(item);
      return;
    }
    // Responsive arrivals keep their arrival order while remaining ahead of
    // every normal entry. `promote` moves an existing actor to this same front.
    const firstNormal = this.waiting.findIndex((candidate) => !candidate.responsive);
    this.waiting.splice(firstNormal < 0 ? this.waiting.length : firstNormal, 0, item);
  }

  private promote<T>(item: WaitingAdmission<C, T>): void {
    if (item.state === "claimed") {
      item.inner?.promote();
      return;
    }
    if (item.state !== "waiting" || item.responsive) return;
    item.responsive = true;
    const index = this.waiting.indexOf(item as WaitingAdmission<C, unknown>);
    if (index >= 0) this.waiting.splice(index, 1);
    this.waiting.unshift(item as WaitingAdmission<C, unknown>);
    this.drain();
  }

  private cancel<T>(item: WaitingAdmission<C, T>): boolean {
    if (item.state === "claimed") return item.inner?.cancel?.() ?? false;
    if (item.state !== "waiting") return false;
    this.settleWaiting(item, new RunStartCancelledError());
    this.drain();
    return true;
  }

  private drain(): void {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        this.clearTimer();
        this.claimResponsive();
        this.claimNormal();
        this.schedule();
      } while (this.drainAgain);
    } finally {
      this.draining = false;
    }
  }

  private claimResponsive(): void {
    for (;;) {
      const item = this.waiting.find((candidate) => candidate.responsive);
      if (!item) return;
      const selected = selectPoolLane(this.healthy(item, true), this.now(), { responsive: true });
      if (!selected) {
        this.settleWaiting(item, this.exhaustedError(item));
        continue;
      }
      this.claim(item, selected);
    }
  }

  private claimNormal(): void {
    const processors = new Map<ProviderPacer, string>();
    for (const item of this.waiting) {
      if (item.responsive) continue;
      for (const candidate of this.healthy(item, false)) {
        processors.set(candidate.pacer, candidate.lane);
      }
    }
    const now = this.now();
    const available = [...processors.entries()]
      .filter(([pacer]) => pacer.quote(now) <= now)
      .sort(([a], [b]) => a.quote(now) - b.quote(now));
    for (const [pacer, lane] of available) {
      const item = this.waiting.find((candidate) => {
        if (candidate.responsive) return false;
        return this.healthy(candidate, false).some(
          (entry) => entry.pacer === pacer && entry.lane === lane
        );
      });
      if (!item) continue;
      const selected = this.healthy(item, false).find(
        (candidate) => candidate.pacer === pacer && candidate.lane === lane
      );
      if (selected) this.claim(item, selected);
    }
  }

  private claim(item: WaitingAdmission<C, unknown>, selected: PoolLaneCandidate<C>): void {
    const index = this.waiting.indexOf(item);
    if (index < 0 || item.state !== "waiting") return;
    this.waiting.splice(index, 1);
    item.state = "claimed";
    const selectedIndex = item.candidates.indexOf(selected);
    const originalOnSelected = item.opts.onSelected;
    const originalOnStarted = item.opts.onStarted;
    const inner = submitPoolGate(item.fn, [selected], {
      ...item.opts,
      responsive: item.responsive,
      onSelected: (selection) =>
        originalOnSelected?.({
          ...selection,
          declaredIndex: selectedIndex,
        }),
      onStarted: () => {
        originalOnStarted?.();
        queueMicrotask(() => this.refresh());
      },
    });
    item.inner = inner;
    inner.result.then(
      (value) => {
        item.state = "settled";
        item.resolve(value);
      },
      (error: unknown) => {
        item.state = "settled";
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
    if (this.waiting.length === 0) return;
    const now = this.now();
    let next: number | undefined;
    for (const item of this.waiting) {
      if (item.responsive) continue;
      for (const candidate of this.healthy(item, false)) {
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
