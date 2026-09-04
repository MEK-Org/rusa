import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Relational foundation for runtime state that is still file-backed at this
 * point. A subsequent cutover imports and switches authority atomically.
 */
export const actorRuntimeState: Migration = {
  id: "0034_actor_runtime_state",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE actor_threads (
        id TEXT PRIMARY KEY,
        charter TEXT NOT NULL,
        parent_id TEXT REFERENCES actor_threads(id),
        provider TEXT,
        model TEXT,
        effort TEXT,
        desired_provider TEXT,
        desired_model TEXT,
        desired_effort TEXT,
        desired_effort_is_set INTEGER NOT NULL DEFAULT 0 CHECK (desired_effort_is_set IN (0, 1)),
        session_id TEXT,
        context_type TEXT CHECK (context_type IN ('native', 'portable')),
        context_mode TEXT CHECK (context_mode IN ('tail', 'ledger')),
        context_compaction_model TEXT,
        title TEXT,
        is_root INTEGER NOT NULL DEFAULT 0 CHECK (is_root IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
        human_unlocked INTEGER NOT NULL DEFAULT 0 CHECK (human_unlocked IN (0, 1)),
        last_chat_session_id TEXT,
        created_at TEXT NOT NULL,
        -- is_root is the unique mesh-authority flag. A parentless non-root
        -- is also a supported driver-owned shape, but an authority root never
        -- has a parent.
        CHECK (is_root = 0 OR parent_id IS NULL)
      );
      CREATE INDEX actor_threads_parent_id_idx ON actor_threads (parent_id);
      CREATE INDEX actor_threads_status_idx ON actor_threads (status);
      CREATE UNIQUE INDEX actor_threads_one_root_idx ON actor_threads (is_root) WHERE is_root = 1;

      CREATE TABLE actor_handles (
        actor_id TEXT NOT NULL REFERENCES actor_threads(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES actor_threads(id) ON DELETE CASCADE,
        role TEXT,
        PRIMARY KEY (actor_id, target_id)
      );
      CREATE TABLE actor_pending_deliveries (
        actor_id TEXT NOT NULL REFERENCES actor_threads(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        from_id TEXT NOT NULL,
        body TEXT NOT NULL,
        deliver_at TEXT NOT NULL,
        session_id TEXT,
        PRIMARY KEY (actor_id, id)
      );
    `);
  },
};
