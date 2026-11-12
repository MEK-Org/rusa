import type Database from "better-sqlite3";
import type { InboxMcpStore } from "../../mcp/inbox-mcp.js";
import type { ObligationStore } from "../../mcp/obligations-mcp.js";
import {
  createInProcessMeshWriter,
  type MeshObligationWriter,
  type MeshWriteRepos,
} from "../mesh-write-operations.js";
import { ActorRunRepository } from "../repositories/actor-run-repository.js";
import { ObligationRepository } from "../repositories/obligation-repository.js";
import { SqliteInboxRepository } from "../repositories/sqlite-inbox-repository.js";

const writers = new WeakMap<ObligationRepository, MeshObligationWriter>();

/**
 * The writer production gives a repository's callers (#1289), for tests: one
 * per repository, as production keeps one per connection, so every caller a
 * test builds over the same repository shares its delivery order. A test that
 * listens to an inbox, or reads actors or runs through its own repositories,
 * passes those so the writer's effects reach the same listeners; the first
 * call for a repository decides them.
 */
export function meshWriterFor(
  db: Database.Database,
  repository: ObligationRepository,
  repos: Partial<Omit<MeshWriteRepos, "obligations">> = {}
): MeshObligationWriter {
  let writer = writers.get(repository);
  if (!writer) {
    writer = createInProcessMeshWriter(db, {
      obligations: repository,
      inbox: repos.inbox ?? new SqliteInboxRepository(db),
      actors: repos.actors ?? { get: () => undefined },
      actorRuns: repos.actorRuns ?? new ActorRunRepository(db),
    });
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

/**
 * An inbox MCP server's store over `inbox` and the writer shared by
 * `obligations`, which delivers the writer's inbox effects to `inbox`'s
 * listeners. The first writer built for `obligations` decides its inbox.
 */
export function inboxMcpStore(
  db: Database.Database,
  inbox: SqliteInboxRepository,
  obligations: ObligationRepository = new ObligationRepository(db)
): InboxMcpStore {
  return { inbox, writer: meshWriterFor(db, obligations, { inbox }) };
}
