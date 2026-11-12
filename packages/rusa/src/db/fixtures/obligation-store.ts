import type Database from "better-sqlite3";
import type { ObligationStore } from "../../mcp/obligations-mcp.js";
import { createInProcessMeshWriter, type MeshObligationWriter } from "../mesh-write-operations.js";
import type { ObligationRepository } from "../repositories/obligation-repository.js";

const writers = new WeakMap<ObligationRepository, MeshObligationWriter>();

/**
 * The writer production gives a repository's callers (#1289), for tests: one
 * per repository, as production keeps one per connection, so every caller a
 * test builds over the same repository shares its delivery order.
 */
export function meshWriterFor(
  db: Database.Database,
  repository: ObligationRepository
): MeshObligationWriter {
  let writer = writers.get(repository);
  if (!writer) {
    writer = createInProcessMeshWriter(db, { obligations: repository });
    writers.set(repository, writer);
  }
  return writer;
}

/** An obligations MCP server's store over `repository` and its shared writer. */
export function obligationStore(
  db: Database.Database,
  repository: ObligationRepository
): ObligationStore {
  return { obligations: repository, writer: meshWriterFor(db, repository) };
}
