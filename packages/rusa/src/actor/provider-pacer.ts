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
   * - `pacingIntervalMs` is the lane's current normal-start spacing.
   *   `blocker` distinguishes a request still waiting for that pacing gate
   *   from the staged head that has passed pacing and is waiting for mesh
   *   concurrency. A request behind a staged head remains `provider-pacing`:
   *   it cannot receive a reliable ETA until that start sets the next clock.
   * - Requests submitted without a `threadId` are omitted from the
   *   returned entries (nothing to key them by) but still consume a
   *   `position`, so surviving entries keep their true FIFO position.
   */
  getQueueSnapshot(): Array<{
    threadId: string;
    position: number;
    estimatedStartAt: number | null;
    /** Current normal-start spacing for this lane. */
    pacingIntervalMs: number;
    /** The gate this request is currently waiting behind. */
    blocker: "provider-pacing" | "mesh-concurrency";
  }> {
    const snapshot: Array<{
      threadId: string;
      position: number;
      estimatedStartAt: number | null;
      pacingIntervalMs: number;
      blocker: "provider-pacing" | "mesh-concurrency";
    }> = [];
    let position = 0;
    let eta: number | null = this.staged ? null : this.nextAvailableAt;

    if (this.staged) {
      if (this.staged.opts.threadId) {
        snapshot.push({
          threadId: this.staged.opts.threadId,
          position,
          estimatedStartAt: null,
          pacingIntervalMs: this.intervalMs,
          blocker: "mesh-concurrency",
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
          pacingIntervalMs: this.intervalMs,
          blocker: "provider-pacing",
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
}

/**
 * Pick the earliest-available declared candidate across canonical provider
 * lanes, by comparing each lane's side-effect-free {@link ProviderPacer.quote}.
 * Ties go to the earlier-declared candidate (strict `<` keeps the first seen).
 * Callers must reserve the winning lane (via `submit`) synchronously, with no
 * `await` between calling this and reserving — JS's single-threaded execution
 * is what keeps concurrent wakes from double-booking the same slot.
 */
export function selectPoolLane<C>(
  candidates: readonly PoolLaneCandidate<C>[],
  now: number
): PoolLaneCandidate<C> | undefined {
  let best: PoolLaneCandidate<C> | undefined;
  let bestQuote = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const quote = candidate.pacer.quote(now);
    if (quote < bestQuote) {
      bestQuote = quote;
      best = candidate;
    }
  }
  return best;
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
   * Fires synchronously every time a candidate is reserved — the initial
   * reservation and any later `promote()`-driven reselection — so callers can
   * track which declared tuple a queued run actually holds, for cancellation
   * and telemetry.
   */
  onSelected?: (selection: PoolGateSelection<C>) => void;
  /** Same contract as {@link ProviderPacerSubmitOptions.revalidateProvider}, scoped to the currently reserved candidate. */
  revalidateProvider?: (config: C) => boolean;
}

/**
 * Reserve the earliest-available declared candidate across multiple provider
 * lanes as a single composed {@link RunStartHandle}. A normal request paces
 * through the winning lane's `ProviderPacer`, chosen by {@link selectPoolLane}
 * (earliest quote, ties to declaration order) among non-halted candidates. A
 * responsive request skips pacing entirely and reserves the first healthy
 * declared candidate, ignoring quotes.
 *
 * `promote()` does not merely promote whichever lane happened to be reserved
 * first — it re-runs that same first-healthy-declared selection, so a
 * responsive wake always lands on the earliest declared candidate even when
 * the original normal reservation is on a later one. When that reselects a
 * different lane, the stale reservation is cancelled; a `generation` counter
 * on the outer handle ignores the stale lane's now-asynchronous cancellation
 * rejection so it can never clobber the freshly reserved lane's later result.
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

  const healthy = (): readonly PoolLaneCandidate<C>[] => {
    if (!opts.isHalted) return candidates;
    const alive = candidates.filter((c) => !opts.isHalted?.(c.config));
    // Never produce an unreservable pool: if every declared candidate reads
    // as halted (e.g. a race with the halt map), fall back to the full pool
    // and let the caller's own beforeRun/halt gate remain the real authority.
    return alive.length > 0 ? alive : candidates;
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
    opts.onSelected?.({
      candidate: candidate.config,
      lane: candidate.lane,
      declaredIndex: candidates.indexOf(candidate),
      eligibleAt,
      responsive,
    });
  };

  const responsive = opts.responsive === true;
  const initial = responsive ? healthy()[0] : selectPoolLane(healthy(), now());
  reserve(initial ?? candidates[0], responsive);

  return {
    result,
    get started() {
      return inner?.started ?? false;
    },
    promote: () => {
      if (settled || inner?.started) return;
      const target = healthy()[0] ?? candidates[0];
      if (currentCandidate === target) {
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
