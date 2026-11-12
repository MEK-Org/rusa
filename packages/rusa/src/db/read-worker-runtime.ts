import type { MessagePort } from "node:worker_threads";
import Database from "better-sqlite3";
import type { ReadRepositories } from "./read-operations.js";
import { ObligationRepository } from "./repositories/obligation-repository.js";
import { SqliteInboxRepository } from "./repositories/sqlite-inbox-repository.js";
import type { WorkerMessage, WorkerRequest } from "./worker-pool.js";

export type ReadOperationTable = Readonly<
  Record<string, (repos: ReadRepositories, input: never) => unknown>
>;

/**
 * A read-only connection to the database the main thread has already opened
 * and migrated. Read-only at the SQLite level, so nothing a read worker runs
 * can write; WAL lets it read while the main connection writes.
 */
export function openReadConnection(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/**
 * Answer read requests arriving on `port` with `operations`, one at a time, on
 * `db`. Each request runs inside its own read transaction, begun when the
 * request arrives and ended before the answer is posted, so no snapshot outlives
 * the request that took it and a write the main thread committed before
 * dispatching is visible.
 */
export function serveReads(
  port: MessagePort,
  db: Database.Database,
  operations: ReadOperationTable,
  build: string | null
): void {
  const repos: ReadRepositories = {
    obligations: new ObligationRepository(db),
    inbox: new SqliteInboxRepository(db),
  };
  port.on("message", (request: WorkerRequest) => {
    const operation = Object.hasOwn(operations, request.op) ? operations[request.op] : undefined;
    let message: WorkerMessage;
    try {
      if (!operation) throw new Error(`unknown read operation: ${request.op}`);
      const value = db.transaction(() => operation(repos, request.input as never))();
      message = { type: "result", id: request.id, value };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      message = {
        type: "error",
        id: request.id,
        error: { name: error.name, message: error.message },
      };
    }
    port.postMessage(message);
  });
  port.postMessage({ type: "ready", build } satisfies WorkerMessage);
}
