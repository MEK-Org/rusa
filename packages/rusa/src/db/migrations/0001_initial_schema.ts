import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Initial (mesh-era) schema.
 *
 * Squashed baseline from the v1/v2 legacy cleanup (an issue): the old
 * migrations 0001–0019 were collapsed into this single file, creating only the
 * tables the actor mesh and the retained `understanding/` subsystem use. All v2
 * orchestrator/dashboard tables were dropped (conversations, messages, signals,
 * signal_deliveries, invocations, evaluations, models, provider_models,
 * provider_quota_state, orchestrator_events, the DB `threads` table, the task
 * support tables task_dependencies/task_git_state, worktree_*, repo_sync_*,
 * repository_runtime_config, and the v1 domain/principle tables).
 *
 * Retained:
 *  - mesh_events            — actor-mesh observability (`rusa report`)
 *  - raw_inputs             — understanding ingest
 *  - tasks                  — the distillation work queue (persona = 'distiller')
 *  - understanding_sync_*   — the Glass Goals local store
 *
 * Column shapes are the post-migration head shapes (no stale CHECK constraints).
 * The `tasks` table drops the v2 orchestrator-model columns `title` and
 * `orchestrator_notes`; the distillation path never reads or writes them.
 *
 * Existing databases that already ran the old 0001–0019 chain keep their (super-
 * set) schema untouched — the runner sees `0001_initial_schema` already recorded
 * and no-ops. To fully drop the orphaned v2 tables on a live instance, delete the
 * db file so it rebuilds from this schema (sanctioned data loss; the only state
 * the mesh owns is its SQLite event history and actor repository).
 */
export const initialSchema: Migration = {
  id: "0001_initial_schema",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE mesh_events (
        id         TEXT PRIMARY KEY,
        ts         TEXT NOT NULL,
        kind       TEXT NOT NULL,
        actor_id   TEXT,
        peer_id    TEXT,
        detail     TEXT,
        body       TEXT,
        success    INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_mesh_events_actor ON mesh_events(actor_id);
      CREATE INDEX idx_mesh_events_ts ON mesh_events(ts);

      CREATE TABLE raw_inputs (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        repo TEXT,
        issue_number INTEGER,
        pr_number INTEGER,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        processed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_raw_inputs_provider_event
        ON raw_inputs(platform, provider_event_id);

      CREATE TABLE tasks (
        id                  TEXT PRIMARY KEY,
        repo                TEXT NOT NULL,
        source              TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'queued',
        outcome             TEXT,
        assigned_agent_id   TEXT,
        parent_task_id      TEXT REFERENCES tasks(id),
        persona             TEXT,
        provider_preference TEXT,
        context             TEXT,
        not_before          TEXT,
        result              TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_tasks_repo ON tasks(repo);
      CREATE INDEX idx_tasks_source ON tasks(source);
      CREATE INDEX idx_tasks_status ON tasks(status);

      CREATE TABLE understanding_sync_metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE understanding_sync_ops (
        id TEXT PRIMARY KEY,
        hlc TEXT NOT NULL,
        version INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_understanding_sync_ops_hlc ON understanding_sync_ops(hlc);
    `);
  },
};
