import Database from "better-sqlite3";
import type { WorkerMessage, WorkerRequest } from "./worker-pool.js";

/**
 * What a write operation is given: the repositories over the writing
 * connection, and `emit`, which records an effect for the main thread to
 * deliver once the operation has committed. An operation that throws rolls
 * back, and the effects it emitted are dropped with it.
 */
export interface WriteContext<R, E> {
  readonly repos: R;
  emit(effect: E): void;
}

/**
 * Whole write operations by name (#1289). Each runs synchronously inside one
 * transaction, so a check and the mutation it guards cannot be split by
 * another write. Inputs, results and effects cross a thread boundary by
 * structured clone, so all three stay plain data.
 */
export type WriteOperationTable<R, E> = Readonly<
  Record<string, (context: WriteContext<R, E>, input: never) => unknown>
>;

/** A committed operation's answer: its result and the effects it emitted, in order. */
export interface WriteOutcome<E> {
  readonly result: unknown;
  readonly effects: readonly E[];
}

/**
 * The error name a writer reports when its operation committed but its outcome
 * could not be sent back. It is kept distinct from any operation error, every
 * one of which means the operation rolled back.
 */
export const COMMITTED_ERROR_NAME = "MeshWriteCommittedError";

/**
 * The writing connection to the database the main thread has already opened
 * and migrated, with the main connection's pragmas: WAL is the file's own
 * setting, and foreign keys are enforced per connection.
 */
export function openWriteConnection(dbPath: string): Database.Database {
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Run one named operation in an IMMEDIATE transaction on `db`, which takes the
 * write lock before the operation's first read. It returns only once the
 * transaction has committed; if the operation throws, the transaction rolls
 * back and the error propagates with nothing emitted.
 */
export function runWriteOperation<R, E>(
  db: Database.Database,
  repos: R,
  operations: WriteOperationTable<R, E>,
  op: string,
  input: unknown
): WriteOutcome<E> {
  const operation = Object.hasOwn(operations, op) ? operations[op] : undefined;
  if (!operation) throw new Error(`unknown write operation: ${op}`);
  const effects: E[] = [];
  const context: WriteContext<R, E> = { repos, emit: (effect) => effects.push(effect) };
  const result = db.transaction(() => operation(context, input as never)).immediate();
  return { result, effects };
}

/** The worker's side of the channel to the writer; a `MessagePort` is one. */
export interface WritePort {
  on(event: "message", listener: (request: WorkerRequest) => void): unknown;
  postMessage(message: WorkerMessage): void;
}

/**
 * Answer write requests arriving on `port`, one at a time, each as one whole
 * operation on `db`. The worker does not wait for the main thread to deliver
 * effects before taking the next request, so a listener's own writes queue
 * behind it instead of waiting on it.
 */
export function serveWrites<R, E>(
  port: WritePort,
  db: Database.Database,
  repos: R,
  operations: WriteOperationTable<R, E>,
  build: string | null
): void {
  port.on("message", (request: WorkerRequest) => {
    let outcome: WriteOutcome<E>;
    try {
      outcome = runWriteOperation(db, repos, operations, request.op, request.input);
    } catch (err) {
      port.postMessage(errorMessage(request.id, err));
      return;
    }
    try {
      port.postMessage({ type: "result", id: request.id, value: outcome } satisfies WorkerMessage);
    } catch (err) {
      // Committed, but the outcome cannot be cloned. Say so, rather than let
      // the caller read this as the rollback every other error means.
      port.postMessage({
        type: "error",
        id: request.id,
        error: {
          name: COMMITTED_ERROR_NAME,
          message:
            `write ${request.op} committed, but its outcome could not be returned: ` +
            (err instanceof Error ? err.message : String(err)),
        },
      } satisfies WorkerMessage);
    }
  });
  port.postMessage({ type: "ready", build } satisfies WorkerMessage);
}

function errorMessage(id: number, err: unknown): WorkerMessage {
  const error = err instanceof Error ? err : new Error(String(err));
  return { type: "error", id, error: { name: error.name, message: error.message } };
}
