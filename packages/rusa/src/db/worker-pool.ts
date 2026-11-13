import { Worker } from "node:worker_threads";
import { type Logger, nullLogger } from "../observability/logger.js";
import { BUILD_ID } from "./build-id.js";

/** A request the pool hands a worker. */
export interface WorkerRequest {
  readonly id: number;
  readonly op: string;
  readonly input: unknown;
}

/**
 * A worker's answer: `ready` once its connection is open, carrying the build of
 * the code it runs (`BUILD_ID`), then one per request. `executionMs` is the
 * worker's own time running that request, when it measures one.
 */
export type WorkerMessage =
  | { readonly type: "ready"; readonly build: string | null }
  | {
      readonly type: "result";
      readonly id: number;
      readonly value: unknown;
      readonly executionMs?: number;
    }
  | {
      readonly type: "error";
      readonly id: number;
      readonly error: { readonly name: string; readonly message: string };
      readonly executionMs?: number;
    };

/**
 * Where one answered request's time went (#1323), in milliseconds:
 *
 * - `queuedMs`: from admission until a worker was handed the request, waiting
 *   behind other requests or for a worker to start.
 * - `executionMs`: the worker's own time running it, as the worker measured.
 * - `transferMs`: the rest of the round trip from hand-off to answer — both
 *   message crossings, including the result's structured clone, and either
 *   thread's event-loop delay. Present only with `executionMs`.
 */
export interface WorkerRequestTiming {
  readonly queuedMs: number;
  readonly executionMs?: number;
  readonly transferMs?: number;
}

/**
 * The errors a pool raises for its own reasons, as opposed to an error an
 * operation raised, which comes back with its own name and message. Each pool
 * names them for what it serves (#1289): a read worker that dies costs one
 * retryable read, a write worker that dies leaves its write's outcome unknown.
 */
export interface WorkerPoolErrors {
  readonly label: string;
  /** Too many requests are already waiting. */
  queueFull(message: string): Error;
  /** The pool is shutting down or has stopped. */
  closed(message: string): Error;
  /** A worker loaded a build other than this process's. */
  buildMismatch(message: string): Error;
  /** Workers keep failing before they open their connection. */
  unavailable(message: string): Error;
  /** The worker holding this request stopped before answering. */
  exited(message: string): Error;
  /** The pool lost its last worker while closing, before this queued request was sent to one. */
  abandoned(message: string): Error;
  /** `restore()` may act only on a failure this predicate accepts. */
  isBuildMismatch(error: Error): boolean;
}

export interface WorkerPoolOptions {
  /** The database file the main thread has already opened and migrated. */
  readonly dbPath: string;
  /** Workers, each with its own connection. */
  readonly size: number;
  /** Requests allowed to wait for a worker before new ones are refused. */
  readonly maxQueued: number;
  /** Worker entry point: a file URL or absolute path. */
  readonly worker: URL | string;
  readonly errors: WorkerPoolErrors;
  readonly logger?: Logger;
}

interface PendingRequest {
  readonly request: WorkerRequest;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly admittedAt: number;
  dispatchedAt?: number;
  readonly onTiming?: (timing: WorkerRequestTiming) => void;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  current: PendingRequest | null;
  /** Set when the pool itself stops this worker, so its exit is expected. */
  stopping: boolean;
}

/** Consecutive workers that may fail before opening their connection. */
const MAX_START_FAILURES = 3;

/**
 * Worker threads that each own one SQLite connection and answer requests one at
 * a time (#1289). The read pool and the writer share this lifecycle: bounded
 * queue, dispatch only to workers that reported ready, replacement on exit, a
 * terminal failure after repeated start failures or a swapped build,
 * {@link restore} after an update rollback, and drain-then-terminate close.
 */
export class DbWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: PendingRequest[] = [];
  private readonly logger: Logger;
  private readonly errors: WorkerPoolErrors;
  private nextId = 1;
  private startFailures = 0;
  private failure: Error | null = null;
  private closed: Promise<void> | null = null;
  private drained: (() => void) | null = null;

  /**
   * Start every worker and resolve once each has opened its connection, so a
   * database the workers cannot open fails startup rather than the first request.
   */
  static async open(options: WorkerPoolOptions): Promise<DbWorkerPool> {
    const pool = new DbWorkerPool(options);
    try {
      await Promise.all(pool.slots.map((slot) => pool.whenReady(slot)));
    } catch (err) {
      await pool.close();
      throw err;
    }
    return pool;
  }

  private constructor(private readonly options: WorkerPoolOptions) {
    const { size } = options;
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`${options.errors.label} pool size must be >= 1`);
    }
    this.logger = options.logger ?? nullLogger;
    this.errors = options.errors;
    for (let index = 0; index < size; index++) this.slots.push(this.spawn());
  }

  /**
   * Run `op` on the next free worker. `onTiming` hears where the time went once
   * a worker answers, just before the promise settles; a request refused or
   * lost to a stopped worker reports nothing.
   */
  request(
    op: string,
    input: unknown,
    onTiming?: (timing: WorkerRequestTiming) => void
  ): Promise<unknown> {
    const { label } = this.errors;
    if (this.closed) return Promise.reject(this.errors.closed(`${label} pool is closed`));
    if (this.failure) return Promise.reject(this.failure);
    let snapshot: unknown;
    try {
      // Clone at admission, as postMessage would at dispatch: an input that
      // cannot reach a worker is refused before it takes a worker or a queue
      // place, and a queued request runs with its input as it was when called.
      snapshot = structuredClone(input);
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        request: { id: this.nextId++, op, input: snapshot },
        resolve,
        reject,
        admittedAt: performance.now(),
        onTiming,
      };
      const idle = this.slots.find((slot) => slot.ready && slot.current === null);
      if (idle) this.dispatch(idle, pending);
      else if (this.queue.length >= this.options.maxQueued) {
        reject(this.errors.queueFull(`${label} queue is full (${this.options.maxQueued} waiting)`));
      } else this.queue.push(pending);
    });
  }

  /**
   * After an update rollback has put the previous dist back, start workers
   * again in place of the ones a mismatched build cost, and of any still
   * starting, which may have loaded the build the rollback removed. Each is
   * admitted only if it reports this process's build, so if `dist` still holds
   * another build the pool fails again, having started one worker per slot it
   * filled. Any other failure, and a closed pool, stay as they are.
   */
  restore(): void {
    if (this.closed) return;
    if (this.failure && !this.errors.isBuildMismatch(this.failure)) return;
    for (const slot of this.slots.filter((candidate) => !candidate.ready)) this.discard(slot);
    if (this.slots.length === this.options.size) return;
    this.logger.info(`db_${this.errors.label}_pool_restoring`, {
      missing: this.options.size - this.slots.length,
    });
    this.failure = null;
    this.startFailures = 0;
    while (this.slots.length < this.options.size) this.slots.push(this.spawn());
  }

  /**
   * Refuse new requests, let every accepted request finish, then stop the
   * workers. Idempotent.
   */
  close(): Promise<void> {
    this.closed ??= (async () => {
      if (!this.isIdle()) await new Promise<void>((resolve) => (this.drained = resolve));
      await Promise.all(
        this.slots.map((slot) => {
          slot.stopping = true;
          return slot.worker.terminate();
        })
      );
    })();
    return this.closed;
  }

  private spawn(): Slot {
    const worker = new Worker(this.options.worker, { workerData: { dbPath: this.options.dbPath } });
    const slot: Slot = { worker, ready: false, current: null, stopping: false };
    let lastError: Error | null = null;
    worker.on("message", (message: WorkerMessage) => this.onMessage(slot, message));
    worker.on("error", (err: unknown) => {
      lastError = err instanceof Error ? err : new Error(String(err));
    });
    worker.on("exit", (code) => this.onExit(slot, code, lastError));
    return slot;
  }

  private whenReady(slot: Slot): Promise<void> {
    return new Promise((resolve, reject) => {
      if (slot.ready) return resolve();
      let lastError: Error | null = null;
      const onError = (err: Error) => {
        lastError = err;
      };
      const onMessage = (message: WorkerMessage) => {
        if (message.type !== "ready") return;
        cleanup();
        // The pool's own handler ran first and has refused a mismatched build.
        if (this.failure) reject(this.failure);
        else resolve();
      };
      const onExit = (code: number) => {
        cleanup();
        reject(
          lastError ?? new Error(`${this.errors.label} worker exited during startup (code ${code})`)
        );
      };
      const cleanup = () => {
        slot.worker.off("error", onError);
        slot.worker.off("message", onMessage);
        slot.worker.off("exit", onExit);
      };
      slot.worker.on("error", onError);
      slot.worker.on("message", onMessage);
      slot.worker.on("exit", onExit);
    });
  }

  private dispatch(slot: Slot, pending: PendingRequest): void {
    slot.current = pending;
    pending.dispatchedAt = performance.now();
    slot.worker.postMessage(pending.request);
  }

  /** Stop a worker that holds no request and forget it; its exit and messages are ignored. */
  private discard(slot: Slot): void {
    slot.stopping = true;
    void slot.worker.terminate();
    this.slots.splice(this.slots.indexOf(slot), 1);
  }

  private onMessage(slot: Slot, message: WorkerMessage): void {
    // A worker the pool has stopped can still deliver what it sent before.
    if (slot.stopping) return;
    const { label } = this.errors;
    if (message.type === "ready") {
      if (message.build !== BUILD_ID) {
        // An update swapped `dist` (or a rollback restored it) after this
        // process started, and the replacement loaded that build, wholly or in
        // part. Its operations and result shapes need not match this process or
        // its migrations, so the pool stays unavailable until the process
        // restarts or restore() finds this build in `dist` again.
        this.discard(slot);
        this.fail(
          this.errors.buildMismatch(
            `${label} worker runs build ${message.build ?? "(none)"}, ` +
              `but this process runs ${BUILD_ID ?? "(none)"}; ${label}s resume after restart ` +
              "or once an update rollback restores this build"
          )
        );
        return;
      }
      slot.ready = true;
      this.startFailures = 0;
      this.pump(slot);
      return;
    }
    const pending = slot.current;
    if (!pending || pending.request.id !== message.id) return;
    slot.current = null;
    pending.onTiming?.(timingOf(pending, message.executionMs));
    if (message.type === "result") pending.resolve(message.value);
    else {
      const error = new Error(message.error.message);
      error.name = message.error.name;
      pending.reject(error);
    }
    this.pump(slot);
  }

  private onExit(slot: Slot, code: number, error: Error | null): void {
    if (slot.stopping) return;
    const { label } = this.errors;
    const reason = error?.message ?? `exit code ${code}`;
    const pending = slot.current;
    slot.current = null;
    pending?.reject(this.errors.exited(`${label} worker stopped before answering: ${reason}`));
    if (!slot.ready) this.startFailures++;
    this.logger.warn(`db_${label}_worker_exited`, {
      code,
      reason,
      ready: slot.ready,
      startFailures: this.startFailures,
    });
    const index = this.slots.indexOf(slot);
    if (this.closed || this.failure) {
      // Shutting down, or failed for good: finish with the workers that remain
      // rather than start one that close() might never stop or that the
      // failure has already ruled out.
      this.slots.splice(index, 1);
      if (this.slots.length === 0) {
        for (const waiting of this.queue.splice(0)) {
          waiting.reject(this.errors.abandoned(`${label} pool lost its last worker while closing`));
        }
      }
      this.settleIfDrained();
      return;
    }
    if (this.startFailures >= MAX_START_FAILURES) {
      this.slots.splice(index, 1);
      this.fail(
        this.errors.unavailable(
          `${label} workers failed to start ${this.startFailures} times: ${reason}`
        )
      );
      return;
    }
    // The replacement takes queued requests once it reports ready; until then
    // they wait for whichever worker is ready first.
    this.slots[index] = this.spawn();
  }

  /** Stop replacing workers; refuse waiting and future requests with `error`. */
  private fail(error: Error): void {
    this.failure = error;
    this.logger.error(`db_${this.errors.label}_pool_failed`, { reason: error.message });
    for (const pending of this.queue.splice(0)) pending.reject(error);
    this.settleIfDrained();
  }

  private pump(slot: Slot): void {
    const next = this.queue.shift();
    if (next) this.dispatch(slot, next);
    else this.settleIfDrained();
  }

  private isIdle(): boolean {
    return this.queue.length === 0 && this.slots.every((slot) => slot.current === null);
  }

  private settleIfDrained(): void {
    if (this.drained && this.isIdle()) {
      this.drained();
      this.drained = null;
    }
  }
}

function timingOf(pending: PendingRequest, executionMs: number | undefined): WorkerRequestTiming {
  const answeredAt = performance.now();
  const dispatchedAt = pending.dispatchedAt ?? answeredAt;
  const queuedMs = dispatchedAt - pending.admittedAt;
  if (executionMs === undefined) return { queuedMs };
  return {
    queuedMs,
    executionMs,
    transferMs: Math.max(0, answeredAt - dispatchedAt - executionMs),
  };
}
