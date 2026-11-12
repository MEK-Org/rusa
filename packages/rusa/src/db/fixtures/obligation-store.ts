import type Database from "better-sqlite3";
import { InMemoryCapabilityGrantStore } from "../../actor/capability-grants.js";
import { InMemoryExperimentEnrollmentStore } from "../../actor/experiments.js";
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

interface CachedWriter {
  readonly db: Database.Database;
  readonly repos: Omit<MeshWriteRepos, "obligations">;
  readonly writer: MeshObligationWriter;
}

const writers = new WeakMap<ObligationRepository, CachedWriter>();

/**
 * The writer production gives a repository's callers (#1289), for tests: one
 * per repository, as production keeps one per connection, so every caller a
 * test builds over the same repository shares its delivery order. A test that
 * listens to an inbox, or reads actors or runs through its own repositories,
 * passes those so the writer's effects reach the same listeners; the first
 * call for a repository decides them, and a later call that names different
 * ones throws rather than silently getting a writer that ignores them.
 */
export function meshWriterFor(
  db: Database.Database,
  repository: ObligationRepository,
  repos: Partial<Omit<MeshWriteRepos, "obligations">> = {}
): MeshObligationWriter {
  const cached = writers.get(repository);
  if (cached) {
    const differs = (Object.keys(repos) as Array<keyof typeof repos>).filter(
      (key) => repos[key] !== undefined && repos[key] !== cached.repos[key]
    );
    if (cached.db !== db || differs.length > 0) {
      throw new Error(
        `meshWriterFor: this repository's writer was already built over other ${
          cached.db !== db ? "db" : differs.join(", ")
        }`
      );
    }
    return cached.writer;
  }
  const built: Omit<MeshWriteRepos, "obligations"> = {
    inbox: repos.inbox ?? new SqliteInboxRepository(db),
    actors: repos.actors ?? { get: () => undefined },
    actorRuns: repos.actorRuns ?? new ActorRunRepository(db),
    grants: repos.grants ?? new InMemoryCapabilityGrantStore(),
    experiments: repos.experiments ?? new InMemoryExperimentEnrollmentStore(),
  };
  const writer = createInProcessMeshWriter(db, { obligations: repository, ...built });
  writers.set(repository, { db, repos: built, writer });
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
