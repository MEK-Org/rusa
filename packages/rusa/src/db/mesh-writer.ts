import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";
import type { Logger } from "../observability/logger.js";
import { DbWorkerPool, type WorkerPoolErrors } from "./worker-pool.js";
import {
  type ReturnedOutcome,
  returnOutcome,
  runWriteOperation,
  type WriteOperationTable,
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
 * The write committed, but its result could not be returned, or one of its
 * effects could not be returned or failed when delivered. Every other effect
 * was still delivered, in order. An error an operation throws itself means the
 * write rolled back.
 */
export class MeshWriteCommittedError extends Error {
  override readonly name = "MeshWriteCommittedError";
  readonly committed = true;
  /** The committed result, when it reached the main thread. */
  readonly result: unknown;
  /** Why each effect that could not be returned or delivered failed, in order. */
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

/**
 * One committed effect that was not delivered, described for the write's
 * caller (#1289). `message` names only the kind of consequence that is
 * missing, never the nested error's text: that text can describe another
 * actor's entry or row, and before effects could fail a write it reached only
 * the server log, where it is still written. The underlying error stays in
 * `cause` for in-process diagnostics.
 */
export class EffectDeliveryFailure extends Error {
  override readonly name = "EffectDeliveryFailure";

  constructor(reason: string, cause: unknown) {
    super(reason, { cause });
  }
}

/**
 * What a caller boundary (an MCP tool result, a dashboard response) answers
 * for a {@link MeshWriteCommittedError}: still an error, because a required
 * effect failed, but one that says the write committed and carries its
 * committed result (a created row's server-generated id included), so the
 * caller can read that state instead of sending the mutation again. Wording
 * cannot stop a caller that retries anyway; it only stops the boundary from
 * hiding what committed. `result` is null when the result itself was lost.
 * `failures` names, in order, each consequence that could not be returned or
 * delivered, so the caller can tell which is missing; it carries only an
 * {@link EffectDeliveryFailure}'s caller-safe reason, never a nested error's
 * own text.
 */
export interface CommittedWriteReport {
  readonly error: string;
  readonly committed: true;
  readonly result: unknown;
  readonly failures: readonly string[];
}

export function committedWriteReport(err: MeshWriteCommittedError): CommittedWriteReport {
  return {
    error: `${err.message}. The write committed; do not retry the mutation.`,
    committed: true,
    result: err.result ?? null,
    failures: err.failures.map((failure) =>
      failure instanceof EffectDeliveryFailure ? failure.message : "an effect was not delivered"
    ),
  };
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

/**
 * Hands one committed effect to the runtime (#1289 C2). Delivery may await
 * required work, including a nested write and that write's own effects; the
 * next effect of the same write is not delivered until it settles.
 */
export type DeliverEffect<E> = (effect: E) => void | Promise<void>;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as PromiseLike<unknown> | null)?.then === "function";

/**
 * Deliver every effect, in order, then answer the result. An effect that could
 * not be returned or whose delivery fails does not stop the ones after it, and
 * a result that could not be returned stops none of them, because each effect
 * describes something that has already committed. A delivery that returns a
 * promise is awaited before the next effect; while every delivery returns
 * synchronously, so does this.
 */
function settle<E>(
  op: string,
  outcome: ReturnedOutcome<E>,
  deliver: DeliverEffect<E>
): unknown | Promise<unknown> {
  const { effects } = outcome;
  const failures: unknown[] = [];
  const finish = (): unknown => {
    const problems = [
      ...(outcome.unreturnableResult === undefined
        ? []
        : [`its result could not be returned: ${outcome.unreturnableResult}`]),
      ...(failures.length > 0
        ? [`${failures.length} of its ${effects.length} effects failed to deliver`]
        : []),
    ];
    if (problems.length > 0) {
      throw new MeshWriteCommittedError(`write ${op} committed, but ${problems.join("; and ")}`, {
        result: outcome.result,
        failures,
      });
    }
    return outcome.result;
  };
  const from = (start: number): unknown | Promise<unknown> => {
    for (let index = start; index < effects.length; index++) {
      const item = effects[index] as (typeof effects)[number];
      if ("unreturnable" in item) {
        failures.push(
          new EffectDeliveryFailure(
            `effect ${index + 1} of ${effects.length} could not be returned from the writer`,
            new Error(item.unreturnable)
          )
        );
        continue;
      }
      let pending: void | Promise<void>;
      try {
        pending = deliver(item.effect);
      } catch (err) {
        failures.push(err);
        continue;
      }
      if (isThenable(pending)) {
        return Promise.resolve(pending).then(
          () => from(index + 1),
          (err: unknown) => {
            failures.push(err);
            return from(index + 1);
          }
        );
      }
    }
    return finish();
  };
  return from(0);
}

/**
 * Orders the delivery of committed writes' effects (#1289 C2). Writes made at
 * the top level deliver one at a time, in the order they committed. A write
 * made while an earlier write's effects are being delivered is nested: its
 * effects are delivered at once, inside the parent's delivery, rather than
 * queued behind a parent that may be awaiting them. Committing never waits for
 * any delivery. While deliveries return synchronously, a write made with
 * nothing being delivered is delivered before its call returns.
 *
 * Contracts a change here must keep:
 * - Effects are delivered in completion order, but a write's caller resuming
 *   from its await is not ordered against the next delivery, which may start
 *   first. Total FIFO across caller continuations is not the contract; making
 *   a delivery wait for the previous caller would queue nested work behind it.
 * - Nesting is decided by the async context a write is made in. A listener may
 *   await only writes it makes itself, inside its own delivery; awaiting a
 *   promise for a write made in another context (shared or coalesced) queues
 *   that write behind the delivery awaiting it, which never settles.
 * - Work a listener starts without awaiting, while its delivery is still open,
 *   is nested too: it is delivered at once, interleaved with the parent's
 *   remaining effects, not after them.
 * - A delivery that never settles holds every later top-level delivery. There
 *   is no timeout.
 */
export class EffectDeliverySequencer {
  /** The delivery the current async context runs inside, while it is open. */
  private readonly scope = new AsyncLocalStorage<{ open: boolean }>();
  private readonly queue: (() => unknown)[] = [];
  private busy = false;

  /** Whether the current async context runs inside an open delivery. */
  delivering(): boolean {
    return this.scope.getStore()?.open === true;
  }

  /** Deliver one committed write's effects, in its turn or nested in its parent's. */
  deliver<T>(work: () => T | Promise<T>): Promise<T> {
    // A delivery that has finished no longer holds the ordering, so work its
    // listeners started without awaiting takes its turn like any other write.
    if (this.scope.getStore()?.open) {
      try {
        return Promise.resolve(this.scoped(work));
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        let out: T | Promise<T>;
        try {
          out = this.scoped(work);
        } catch (err) {
          reject(err);
          return;
        }
        if (!isThenable(out)) {
          resolve(out);
          return;
        }
        return Promise.resolve(out).then(resolve, reject);
      });
      if (!this.busy) this.pump();
    });
  }

  private scoped<T>(work: () => T | Promise<T>): T | Promise<T> {
    const scope = { open: true };
    let out: T | Promise<T>;
    try {
      out = this.scope.run(scope, work);
    } catch (err) {
      scope.open = false;
      throw err;
    }
    if (!isThenable(out)) {
      scope.open = false;
      return out;
    }
    return Promise.resolve(out).finally(() => {
      scope.open = false;
    });
  }

  private pump(): void {
    this.busy = true;
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      const out = job();
      if (isThenable(out)) {
        const next = () => this.pump();
        out.then(next, next);
        return;
      }
    }
    this.busy = false;
  }
}

/**
 * Runs each write on the main connection when it is called, so a converted
 * caller's write lands in the same order as any synchronous write beside it.
 * This keeps the main connection the one writer until the worker takes over
 * (#1289). Its input and outcome are structured-cloned as the worker's would
 * be, so an input the worker could not take is refused here too, and a result
 * or effect the worker could not return fails here first, after its commit.
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

  private readonly sequencer = new EffectDeliverySequencer();

  write<K extends keyof Ops & string>(
    op: K,
    input: WriteInput<Ops, K>
  ): Promise<WriteOutput<Ops, K>> {
    let outcome: ReturnedOutcome<E>;
    try {
      // Inside a caller's transaction this would only be a savepoint, and its
      // effects would be delivered before anything committed. The worker could
      // not join that transaction either.
      if (this.db.inTransaction) {
        throw new Error(`write ${op} was called inside an open transaction`);
      }
      const snapshot = structuredClone(input);
      outcome = returnOutcome(
        runWriteOperation(this.db, this.repos, this.operations, op, snapshot)
      );
    } catch (err) {
      return Promise.reject(err);
    }
    // A top-level write made while an earlier one's effects are being
    // delivered has committed after it, so its effects wait for the earlier
    // write's rest. A write that delivery awaits is delivered inside it.
    return this.sequencer.deliver(() => settle(op, outcome, this.deliver) as WriteOutput<Ops, K>);
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
 * read pool uses. Writes commit in the order they were called, and their
 * effects are delivered in that order by the {@link EffectDeliverySequencer}.
 * While a write's delivery answers synchronously, its caller's continuation
 * also runs before the next write's outcome is handled, since each worker
 * message is its own turn of the event loop. Once a delivery awaits, the next
 * write's delivery may start before this write's caller resumes, as in the
 * in-process writer: the sequencer orders deliveries, not continuations.
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

  private readonly sequencer = new EffectDeliverySequencer();
  /** Accepted writes whose callers have not been answered yet. */
  private readonly accepted = new Set<Promise<unknown>>();
  private closing: Promise<void> | null = null;

  write<K extends keyof Ops & string>(
    op: K,
    input: WriteInput<Ops, K>
  ): Promise<WriteOutput<Ops, K>> {
    // Once closing, a write made inside an open delivery is still part of an
    // accepted write that has not been answered, so it is accepted too.
    if (this.closing && !this.sequencer.delivering()) {
      return Promise.reject(new DbWriterClosedError("write pool is closed"));
    }
    const answered = this.pool
      .request(op, input)
      .then((outcome) =>
        this.sequencer.deliver(
          () => settle(op, outcome as ReturnedOutcome<E>, this.deliver) as WriteOutput<Ops, K>
        )
      );
    this.accepted.add(answered);
    const forget = () => this.accepted.delete(answered);
    answered.then(forget, forget);
    return answered;
  }

  /** See {@link DbWorkerPool.restore}. */
  restore(): void {
    this.pool.restore();
  }

  /**
   * Refuse new writes, finish every accepted one, then stop the worker.
   * Idempotent. An accepted write is finished when its caller is answered,
   * after its effects' delivery, including writes that delivery makes. A
   * delivery that never settles therefore holds close too.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      while (this.accepted.size > 0) await Promise.allSettled([...this.accepted]);
      await this.pool.close();
    })();
    return this.closing;
  }
}
