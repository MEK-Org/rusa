import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../observability/logger.js";
import type {
  DbReads,
  ReadInput,
  ReadOperationName,
  ReadOutput,
  ReadTiming,
} from "./read-operations.js";
import { DbWorkerPool, type WorkerPoolErrors } from "./worker-pool.js";

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
 * A worker loaded a build other than this process's, so reads stop until a
 * restart or until {@link DbReadPool.restore} finds this build in place again.
 */
export class DbReadBuildMismatchError extends DbReadUnavailableError {
  override readonly name = "DbReadBuildMismatchError";
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

const DEFAULT_SIZE = 2;
const DEFAULT_MAX_QUEUED = 256;

const READ_POOL_ERRORS: WorkerPoolErrors = {
  label: "read",
  queueFull: (message) => new DbReadQueueFullError(message),
  closed: (message) => new DbReadPoolClosedError(message),
  buildMismatch: (message) => new DbReadBuildMismatchError(message),
  unavailable: (message) => new DbReadUnavailableError(message),
  exited: (message) => new DbReadWorkerExitedError(message),
  abandoned: (message) => new DbReadWorkerExitedError(message),
  isBuildMismatch: (error) => error instanceof DbReadBuildMismatchError,
};

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
  /**
   * Start every worker and resolve once each has opened its connection, so a
   * database the readers cannot open fails startup rather than the first read.
   */
  static async open(options: DbReadPoolOptions): Promise<DbReadPool> {
    const size = options.size ?? DEFAULT_SIZE;
    const maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
    const pool = await DbWorkerPool.open({
      dbPath: options.dbPath,
      size,
      maxQueued,
      worker: options.worker,
      errors: READ_POOL_ERRORS,
      logger: options.logger,
    });
    // The counterpart of `db_read_pool_unavailable` (#1323): a run that logs
    // neither line did not try to serve reads off the main thread.
    options.logger?.info("db_read_pool_ready", { size, maxQueued });
    return new DbReadPool(pool);
  }

  private constructor(private readonly pool: DbWorkerPool) {}

  read<K extends ReadOperationName>(
    op: K,
    input: ReadInput<K>,
    onTiming?: (timing: ReadTiming) => void
  ): Promise<ReadOutput<K>> {
    return this.pool.request(op, input, onTiming) as Promise<ReadOutput<K>>;
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
    this.pool.restore();
  }

  /**
   * Refuse new reads, let every accepted read finish, then stop the workers.
   * Idempotent.
   */
  close(): Promise<void> {
    return this.pool.close();
  }
}
