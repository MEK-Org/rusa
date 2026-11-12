import type Database from "better-sqlite3";
import type { Logger } from "../observability/logger.js";
import { DbWorkerPool, type WorkerPoolErrors } from "./worker-pool.js";
import {
  COMMITTED_ERROR_NAME,
  runWriteOperation,
  type WriteOperationTable,
  type WriteOutcome,
} from "./write-worker-runtime.js";

/**
 * The writer could not take the write, so nothing was attempted: the queue is
 * full, the writer is closed, or its worker cannot run this process's build.
 */
export class DbWriteUnavailableError extends Error {
  override readonly name: string = "DbWriteUnavailableError";
}

export class DbWriteQueueFullError extends DbWriteUnavailableError {
  override readonly name = "DbWriteQueueFullError";
}

export class DbWriterClosedError extends DbWriteUnavailableError {
  override readonly name = "DbWriterClosedError";
}

export class DbWriteBuildMismatchError extends DbWriteUnavailableError {
  override readonly name = "DbWriteBuildMismatchError";
}

/**
 * The write worker stopped while it held this write, so the write may or may
 * not have committed. It is never replayed: replaying a committed write would
 * apply it twice. The caller learns the outcome only by reading.
 */
export class MeshWriteOutcomeUnknownError extends Error {
  override readonly name = "MeshWriteOutcomeUnknownError";
}

/**
 * The write committed, but its result could not be returned or one of its
 * effects failed when delivered. Every other effect was still delivered, in
 * order. An error an operation throws itself means the write rolled back.
 */
export class MeshWriteCommittedError extends Error {
  override readonly name = COMMITTED_ERROR_NAME;
  readonly committed = true;
  /** The committed result, when it reached the main thread. */
  readonly result: unknown;
  /** What each failed effect delivery threw, in delivery order. */
  readonly failures: readonly unknown[];

  constructor(
    message: string,
    details: { readonly result?: unknown; readonly failures?: readonly unknown[] } = {}
  ) {
    super(message, details.failures?.length ? { cause: details.failures[0] } : undefined);
    this.result = details.result;
    this.failures = details.failures ?? [];
  }
}

type Operations = Readonly<Record<string, (context: never, input: never) => unknown>>;
export type WriteInput<Ops extends Operations, K extends keyof Ops> = Parameters<Ops[K]>[1];
export type WriteOutput<Ops extends Operations, K extends keyof Ops> = ReturnType<Ops[K]>;

/**
 * Asynchronous access to whole write operations (#1289). The promise settles
 * only after the write has committed and every effect it emitted has been
 * delivered, in order, so the caller's continuation sees committed state and
 * the notifications that follow from it.
 */
export interface MeshWriter<Ops extends Operations> {
  write<K extends keyof Ops & string>(
    op: K,
    input: WriteInput<Ops, K>
  ): Promise<WriteOutput<Ops, K>>;
}

/** Hands one committed effect to the runtime. Synchronous by contract. */
export type DeliverEffect<E> = (effect: E) => void;

/**
 * Deliver every effect, in order, then answer the result. A failing delivery
 * does not stop the ones after it, because each describes something that has
 * already committed.
 */
function settle<E>(op: string, outcome: WriteOutcome<E>, deliver: DeliverEffect<E>): unknown {
  const failures: unknown[] = [];
  for (const effect of outcome.effects) {
    try {
      deliver(effect);
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    throw new MeshWriteCommittedError(
      `write ${op} committed, but ${failures.length} of its ${outcome.effects.length} ` +
        "effects failed to deliver",
      { result: outcome.result, failures }
    );
  }
  return outcome.result;
}

/**
 * Runs each write on the main connection when it is called, so a converted
 * caller's write lands in the same order as any synchronous write beside it.
 * This keeps the main connection the one writer until the worker takes over
 * (#1289). The outcome is structured-cloned as the worker's would be, so a
 * result the worker could not return fails here first, after its commit.
 */
export class InProcessMeshWriter<R, E, Ops extends WriteOperationTable<R, E>>
  implements MeshWriter<Ops>
{
  constructor(
    private readonly db: Database.Database,
    private readonly repos: R,
    private readonly operations: Ops,
    private readonly deliver: DeliverEffect<E>
  ) {}

  /** Committed writes waiting for their effects to be delivered, in commit order. */
  private readonly backlog: (() => void)[] = [];
  private delivering = false;

  write<K extends keyof Ops & string>(
    op: K,
    input: WriteInput<Ops, K>
  ): Promise<WriteOutput<Ops, K>> {
    let outcome: WriteOutcome<E>;
    try {
      // Inside a caller's transaction this would only be a savepoint, and its
      // effects would be delivered before anything committed. The worker could
      // not join that transaction either.
      if (this.db.inTransaction) {
        throw new Error(`write ${op} was called inside an open transaction`);
      }
      outcome = runWriteOperation(this.db, this.repos, this.operations, op, input);
    } catch (err) {
      return Promise.reject(err);
    }
    try {
      outcome = structuredClone(outcome);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return Promise.reject(
        new MeshWriteCommittedError(
          `write ${op} committed, but its outcome could not be returned: ${reason}`
        )
      );
    }
    return new Promise((resolve, reject) => {
      this.backlog.push(() => {
        try {
          resolve(settle(op, outcome, this.deliver) as WriteOutput<Ops, K>);
        } catch (err) {
          reject(err);
        }
      });
      // A write made while an earlier one's effects are being delivered has
      // committed after it, so its effects wait for the earlier write's rest.
      if (!this.delivering) this.drain();
    });
  }

  private drain(): void {
    this.delivering = true;
    try {
      for (let job = this.backlog.shift(); job; job = this.backlog.shift()) job();
    } finally {
      this.delivering = false;
    }
  }
}

const WRITE_POOL_ERRORS: WorkerPoolErrors = {
  label: "write",
  queueFull: (message) => new DbWriteQueueFullError(message),
  closed: (message) => new DbWriterClosedError(message),
  buildMismatch: (message) => new DbWriteBuildMismatchError(message),
  unavailable: (message) => new DbWriteUnavailableError(message),
  exited: (message) =>
    new MeshWriteOutcomeUnknownError(`${message}; the write may have committed and is not retried`),
  abandoned: (message) => new DbWriterClosedError(message),
  isBuildMismatch: (error) => error instanceof DbWriteBuildMismatchError,
};

const DEFAULT_MAX_QUEUED = 256;

export interface DbWriterOptions<E> {
  /** The database file the main thread has already opened and migrated. */
  readonly dbPath: string;
  /** Worker entry point: a file URL or absolute path. */
  readonly worker: URL | string;
  readonly deliver: DeliverEffect<E>;
  /** Writes allowed to wait before new ones are refused. */
  readonly maxQueued?: number;
  readonly logger?: Logger;
}

/**
 * One write worker owning one writing connection (#1289), on the lifecycle the
 * read pool uses. Writes run in the order they were called. Each worker
 * message is its own turn of the event loop, so one write's effects and its
 * caller's continuation run before the next write's outcome is handled.
 */
export class DbWriter<E, Ops extends Operations> implements MeshWriter<Ops> {
  static async open<E, Ops extends Operations>(
    options: DbWriterOptions<E>
  ): Promise<DbWriter<E, Ops>> {
    const pool = await DbWorkerPool.open({
      dbPath: options.dbPath,
      size: 1,
      maxQueued: options.maxQueued ?? DEFAULT_MAX_QUEUED,
      worker: options.worker,
      errors: WRITE_POOL_ERRORS,
      logger: options.logger,
    });
    return new DbWriter(pool, options.deliver);
  }

  private constructor(
    private readonly pool: DbWorkerPool,
    private readonly deliver: DeliverEffect<E>
  ) {}

  write<K extends keyof Ops & string>(
    op: K,
    input: WriteInput<Ops, K>
  ): Promise<WriteOutput<Ops, K>> {
    return this.pool.request(op, input).then(
      (outcome) => settle(op, outcome as WriteOutcome<E>, this.deliver) as WriteOutput<Ops, K>,
      (err: Error) => {
        throw err.name === COMMITTED_ERROR_NAME ? new MeshWriteCommittedError(err.message) : err;
      }
    );
  }

  /** See {@link DbWorkerPool.restore}. */
  restore(): void {
    this.pool.restore();
  }

  /** Refuse new writes, finish every accepted one, then stop the worker. Idempotent. */
  close(): Promise<void> {
    return this.pool.close();
  }
}
