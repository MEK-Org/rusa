import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Authoritative relational storage for actor identity and runtime configuration.
 *
 * The JSON columns deliberately have no database-level shape constraints.
 * Their versioned document shapes are owned and validated by SqliteActorRepository.
 */
export const actorRuntimeState: Migration = {
  id: "0034_actor_runtime_state",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE actors (
        id TEXT PRIMARY KEY,
        charter TEXT NOT NULL,
        parent_id TEXT REFERENCES actors(id),
        model_config TEXT,
        context_config TEXT,
        title TEXT,
        retired_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX actors_parent_id_idx ON actors (parent_id);
      CREATE INDEX actors_retired_at_idx ON actors (retired_at);
      CREATE UNIQUE INDEX actors_single_root_idx ON actors ((parent_id IS NULL)) WHERE parent_id IS NULL;

      CREATE TABLE actor_handles (
        actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
        role TEXT,
        PRIMARY KEY (actor_id, target_id)
      );
    `);
  },
};
