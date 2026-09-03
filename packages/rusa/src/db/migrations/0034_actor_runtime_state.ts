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
        budget_max_runs INTEGER,
        budget_runs_used INTEGER,
        human_unlocked INTEGER NOT NULL DEFAULT 0 CHECK (human_unlocked IN (0, 1)),
        last_chat_session_id TEXT,
        created_at TEXT NOT NULL
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
      CREATE TABLE capability_grants (
        actor_id TEXT NOT NULL REFERENCES actor_threads(id),
        capability TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (actor_id, capability)
      );
      CREATE TABLE event_subscriptions (
        resource TEXT NOT NULL,
        actor_id TEXT NOT NULL REFERENCES actor_threads(id),
        subscribed_by TEXT NOT NULL,
        subscribed_at TEXT NOT NULL,
        unsubscribed_at TEXT,
        PRIMARY KEY (resource, actor_id)
      );
      CREATE UNIQUE INDEX event_subscriptions_one_active_owner_idx
        ON event_subscriptions (resource) WHERE unsubscribed_at IS NULL;
      CREATE TABLE host_jobs (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL REFERENCES actor_threads(id),
        unit_name TEXT NOT NULL UNIQUE,
        script_label TEXT NOT NULL,
        manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
        audit_artifact_path TEXT NOT NULL,
        audit_artifact_sha256 TEXT NOT NULL,
        runtime_max_sec INTEGER NOT NULL,
        submitted_at TEXT NOT NULL,
        stop_requested_at TEXT,
        completed_at TEXT,
        exit_status TEXT,
        exit_code TEXT
      );
      CREATE INDEX host_jobs_actor_id_idx ON host_jobs (actor_id);
      CREATE TABLE portable_contexts (
        actor_id TEXT PRIMARY KEY REFERENCES actor_threads(id),
        schema_version INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        compactor_json TEXT,
        items_json TEXT NOT NULL CHECK (json_valid(items_json)),
        last_folded_source_id TEXT
      );
    `);
  },
};
