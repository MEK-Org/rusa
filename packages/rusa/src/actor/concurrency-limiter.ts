/**
 * A FIFO concurrency gate: at most `max` tasks run at once; the rest queue and
 * start as slots free.
 *
 * This is the cross-actor capacity bound the actor mesh needs. v2's pump
 * (`v2/runtime.ts`) provided "per-thread serial, cross-thread concurrent up to a
 * cap"; in the mesh, *per-actor* serialization is already handled by each
 * actor's {@link TriggerRunner} (single-flight), so the only piece left to share
 * across actors is this capacity bound — extracted from the pump's data-model
 * coupling into a standalone primitive.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<QueuedEntry<unknown>> = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error(`ConcurrencyLimiter max must be >= 1, got ${max}`);
  }

  /** Run `fn` once a slot is free; resolves/rejects with its result. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    return this.enqueue(fn).result;
  }

  /**
   * Queue a normal run and return a handle that can promote it out of the
   * capacity-limited queue before it starts. Promotion is intentionally a
   * no-op once execution has begun: responsive wakes do not cancel providers.
   */
  enqueue<T>(fn: () => Promise<T>): RunStartHandle<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: QueuedEntry<T> = {
      fn,
      resolve,
      reject,
      state: "queued",
      counted: true,
    };
    this.queue.push(entry as QueuedEntry<unknown>);
    this.pump();

    return {
      result,
      get started() {
        return entry.state === "started" || entry.state === "settled";
      },
      promote: () => {
        if (entry.state !== "queued") return;
        const index = this.queue.indexOf(entry as QueuedEntry<unknown>);
        if (index >= 0) this.queue.splice(index, 1);
        entry.counted = false;
        // Preserve the async boundary of a queued start even when it jumps
        // the queue; callers must receive the handle before `fn` can start.
        queueMicrotask(() => this.start(entry));
      },
      cancel: () => {
        if (entry.state !== "queued") return false;
        const index = this.queue.indexOf(entry as QueuedEntry<unknown>);
        if (index >= 0) this.queue.splice(index, 1);
        entry.state = "settled";
        entry.reject(new RunStartCancelledError());
        return true;
      },
    };
  }

  /** Slots currently in use. */
  get inFlight(): number {
    return this.active;
  }

  /** Tasks waiting for a slot. */
  get waiting(): number {
    return this.queue.length;
  }

  private pump(): void {
    while (this.active < this.max && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next || next.state !== "queued") continue;
      this.start(next);
    }
  }

  private start<T>(entry: QueuedEntry<T>): void {
    if (entry.state !== "queued") return;
    entry.state = "started";
    if (entry.counted) this.active++;
    void Promise.resolve()
      .then(entry.fn)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        entry.state = "settled";
        if (entry.counted) {
          this.active--;
          this.pump();
        }
      });
  }
}

/** Handle for a run that may still be waiting to start. */
export interface RunStartHandle<T> {
  readonly result: Promise<T>;
  readonly started: boolean;
  /** Bypass the normal concurrency queue if the run has not started yet. */
  promote(): void;
  /** Cancel before execution begins. Returns false once already started/settled. */
  cancel?(): boolean;
}

interface QueuedEntry<T> {
  fn: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  state: "queued" | "started" | "settled";
  counted: boolean;
}

/** Expected control-flow signal when an operator flushes a queued start. */
export class RunStartCancelledError extends Error {
  constructor() {
    super("queued run cancelled before start");
    this.name = "RunStartCancelledError";
  }
}

/**
 * Expected control-flow signal when a request's provider changed while it sat
 * in a pacer/concurrency queue. The caller must re-gate under the now-live
 * provider rather than start against the pacer lane it was originally
 * submitted to.
 */
export class RunStartStaleProviderError extends Error {
  constructor() {
    super("queued run's provider changed before start");
    this.name = "RunStartStaleProviderError";
  }
}
