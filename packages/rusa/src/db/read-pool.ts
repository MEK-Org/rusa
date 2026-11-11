import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { type Logger, nullLogger } from "../observability/logger.js";
import { BUILD_ID } from "./build-id.js";
import type { DbReads, ReadInput, ReadOperationName, ReadOutput } from "./read-operations.js";
import type { ReadRequest, ReadWorkerMessage } from "./read-worker-runtime.js";

/**
 * The pool could not serve a read, though nothing was wrong with the read
 * itself. The dashboard answers 503 for every subclass.
 */
export class DbReadUnavailableError extends Error {
  override readonly name: string = "DbReadUnavailableError";
}

/** Too many reads are already waiting. */
export class DbReadQueueFullError extends DbReadUnavailableError {
  override readonly name = "DbReadQueueFullError";
}

/** The pool is shutting down or has stopped; it accepts no new reads. */
export class DbReadPoolClosedError extends DbReadUnavailableError {
  override readonly name = "DbReadPoolClosedError";
}

/**
 * The worker running this read stopped before answering. The pool has already
 * replaced it, so a later request can succeed.
 */
export class DbReadWorkerExitedError extends DbReadUnavailableError {
  override readonly name = "DbReadWorkerExitedError";
}

export interface DbReadPoolOptions {
  /** The database file the main thread has already opened and migrated. */
  readonly dbPath: string;
  /** Read workers, each with its own connection. */
  readonly size?: number;
  /** Reads allowed to wait for a worker before new ones are refused. */
  readonly maxQueued?: number;
  /** Worker entry point: a file URL or absolute path. */
  readonly worker: URL | string;
  readonly logger?: Logger;
}

interface PendingRead {
  readonly request: ReadRequest;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  current: PendingRead | null;
  /** Set when the pool itself stops this worker, so its exit is expected. */
  stopping: boolean;
}

const DEFAULT_SIZE = 2;
const DEFAULT_MAX_QUEUED = 256;
/** Consecutive workers that may fail before opening their connection. */
const MAX_START_FAILURES = 3;

/**
 * The read worker tsup builds beside the shared chunk that carries this pool,
 * or null when this module runs from source (tests, `tsx`), where nothing was
 * built. A built run always gets the path, even when the file is missing, so a
 * packaging regression fails `DbReadPool.open` at startup instead of quietly
 * keeping reads on the main thread. Returned as a path: Node's `Worker`
 * rejects a `URL` from any other realm.
 */
export function bundledReadWorker(moduleUrl: string = import.meta.url): string | null {
  if (moduleUrl.endsWith(".ts")) return null;
  return join(dirname(fileURLToPath(moduleUrl)), "db-read-worker.js");
}

/**
 * A small pool of read workers, each owning one read-only SQLite connection
 * (#1289). A standalone read runs there instead of on the main thread, so a
 * long query leaves the event loop serving unrelated requests, and while one
 * worker is busy another serves short reads.
 *
 * Writes are not routed here: they stay on the main connection, which commits
 * synchronously before any later read is dispatched, so a read always sees
 * every write its caller already awaited.
 */
export class DbReadPool implements DbReads {
  private readonly slots: Slot[] = [];
  private readonly queue: PendingRead[] = [];
  private readonly maxQueued: number;
  private readonly logger: Logger;
  private nextId = 1;
  private startFailures = 0;
  private failure: Error | null = null;
  private closed: Promise<void> | null = null;
  private drained: (() => void) | null = null;

  /**
   * Start every worker and resolve once each has opened its connection, so a
   * database the readers cannot open fails startup rather than the first read.
   */
  static async open(options: DbReadPoolOptions): Promise<DbReadPool> {
    const pool = new DbReadPool(options);
    try {
      await Promise.all(pool.slots.map((slot) => pool.whenReady(slot)));
    } catch (err) {
      await pool.close();
      throw err;
    }
    return pool;
  }

  private constructor(private readonly options: DbReadPoolOptions) {
    const size = options.size ?? DEFAULT_SIZE;
    if (!Number.isInteger(size) || size < 1) throw new Error("read pool size must be >= 1");
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.logger = options.logger ?? nullLogger;
    for (let index = 0; index < size; index++) this.slots.push(this.spawn());
  }

  read<K extends ReadOperationName>(op: K, input: ReadInput<K>): Promise<ReadOutput<K>> {
    if (this.closed) return Promise.reject(new DbReadPoolClosedError("read pool is closed"));
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const pending: PendingRead = {
        request: { id: this.nextId++, op, input },
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      const idle = this.slots.find((slot) => slot.ready && slot.current === null);
      if (idle) this.dispatch(idle, pending);
      else if (this.queue.length >= this.maxQueued) {
        reject(new DbReadQueueFullError(`read queue is full (${this.maxQueued} waiting)`));
      } else this.queue.push(pending);
    });
  }

  /**
   * Refuse new reads, let every accepted read finish, then stop the workers.
   * Idempotent.
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
    worker.on("message", (message: ReadWorkerMessage) => this.onMessage(slot, message));
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
      const onMessage = (message: ReadWorkerMessage) => {
        if (message.type !== "ready") return;
        cleanup();
        // The pool's own handler ran first and has refused a mismatched build.
        if (this.failure) reject(this.failure);
        else resolve();
      };
      const onExit = (code: number) => {
        cleanup();
        reject(lastError ?? new Error(`read worker exited during startup (code ${code})`));
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

  private dispatch(slot: Slot, pending: PendingRead): void {
    slot.current = pending;
    slot.worker.postMessage(pending.request);
  }

  private onMessage(slot: Slot, message: ReadWorkerMessage): void {
    if (message.type === "ready") {
      if (message.build !== BUILD_ID) {
        // An update swapped `dist` (or a rollback restored it) after this
        // process started, and the replacement loaded that build, wholly or in
        // part. Its reads and result shapes need not match this process or its
        // migrations, so reads stay unavailable until the process restarts.
        slot.stopping = true;
        void slot.worker.terminate();
        this.fail(
          new DbReadUnavailableError(
            `read worker runs build ${message.build ?? "(none)"}, ` +
              `but this process runs ${BUILD_ID ?? "(none)"}; reads resume after restart`
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
    const reason = error?.message ?? `exit code ${code}`;
    const pending = slot.current;
    slot.current = null;
    pending?.reject(new DbReadWorkerExitedError(`read worker stopped before answering: ${reason}`));
    if (!slot.ready) this.startFailures++;
    this.logger.warn("db_read_worker_exited", {
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
          waiting.reject(
            new DbReadWorkerExitedError("read pool lost its last worker while closing")
          );
        }
      }
      this.settleIfDrained();
      return;
    }
    if (this.startFailures >= MAX_START_FAILURES) {
      this.slots.splice(index, 1);
      this.fail(
        new DbReadUnavailableError(
          `read workers failed to start ${this.startFailures} times: ${reason}`
        )
      );
      return;
    }
    // The replacement takes queued reads once it reports ready; until then
    // they wait for whichever worker is ready first.
    this.slots[index] = this.spawn();
  }

  /** Stop replacing workers; refuse waiting and future reads with `error`. */
  private fail(error: Error): void {
    this.failure = error;
    this.logger.error("db_read_pool_failed", { reason: error.message });
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
