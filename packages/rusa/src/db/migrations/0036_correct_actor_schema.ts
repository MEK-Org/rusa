import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Forward-corrects the 0034 actor schema per the operator's post-merge review
 * on PR #180. 0034 is already applied on staging and is never rewritten, so
 * this migration transforms its rows onto the approved shape:
 *
 * - `actor_threads` is renamed to `actors`.
 * - `provider`/`model`/`effort` collapse into one validated `model_config`
 *   JSON object; the `desired_*` staging columns are dropped entirely — an
 *   unapplied model change is process memory only, never a durable row.
 * - `session_id` (the native provider session) and the portable-context
 *   columns collapse into one `context_config` JSON object.
 * - `is_root` is dropped. Root topology is derived from `parent_id IS NULL`,
 *   enforced by a partial unique index capping the table to one parentless
 *   row. A database that already holds a parentless, non-root actor (the
 *   `e2e ab-context` rig holder shape) cannot be migrated silently — doing so
 *   would hand that actor apparent root authority — so this migration refuses
 *   to run against one; see the guard below.
 * - `status` is dropped in favor of nullable `retired_at`. The exact historical
 *   retirement instant for already-retired rows is not recoverable from the
 *   0034 shape, so it is backfilled to this migration's run time.
 * - `budget_max_runs`/`budget_runs_used` are dropped; the run-count lease they
 *   backed is being removed end to end separately.
 * - `human_unlocked`/`last_chat_session_id` are dropped without replacement:
 *   both are reliably reconstructable from the durable `mesh_chat` table (an
 *   operator-authored row addressed to the actor unlocks the reply channel,
 *   and its `session_id` is the last chat session), so the repository derives
 *   them at read time instead of duplicating that state in a column.
 * - `actor_pending_deliveries` is dropped. Pending scheduled deliveries stay
 *   in the legacy file-backed store until a dedicated scheduler migration
 *   owns their cutover; this table would otherwise be a second, unused
 *   authority for the same data.
 */
export const correctActorSchema: Migration = {
  id: "0036_correct_actor_schema",
  up: (db: Database) => {
    const rootlessNonRoot = db
      .prepare("SELECT id FROM actor_threads WHERE parent_id IS NULL AND is_root = 0")
      .all() as Array<{ id: string }>;
    if (rootlessNonRoot.length > 0) {
      throw new Error(
        "0036_correct_actor_schema: refusing to migrate parentless, non-root actor(s) " +
          `(${rootlessNonRoot.map((r) => r.id).join(", ")}) — the corrected schema derives ` +
          "root authority from parent_id IS NULL, so carrying these rows forward as-is would " +
          "grant them apparent root authority. Give them an explicit parent or remove them " +
          "from this database before applying this migration."
      );
    }

    // No PRAGMA foreign_keys toggle: SQLite checks a FK constraint at the end
    // of the statement that touches it (immediate) or at COMMIT (deferred),
    // never mid-statement per row, so the self-referential rebuild below is
    // safe under `foreign_keys = ON` as-is. That also lets the runner wrap
    // this migration and its `_migrations` marker insert in one ordinary
    // transaction — PRAGMA foreign_keys is a no-op inside a transaction, so
    // the old noTransaction escape hatch would have made that impossible.
    db.exec(`
      CREATE TABLE actors (
        id TEXT PRIMARY KEY,
        charter TEXT NOT NULL,
        parent_id TEXT REFERENCES actors(id),
        model_config TEXT CHECK (
          model_config IS NULL OR (json_valid(model_config) AND json_type(model_config) = 'object')
        ),
        context_config TEXT CHECK (
          context_config IS NULL OR (json_valid(context_config) AND json_type(context_config) = 'object')
        ),
        title TEXT,
        retired_at TEXT,
        created_at TEXT NOT NULL
      );
    `);

    db.exec(`
      INSERT INTO actors (id, charter, parent_id, model_config, context_config, title, retired_at, created_at)
      SELECT
        id,
        charter,
        parent_id,
        CASE
          WHEN provider IS NULL AND model IS NULL AND effort IS NULL THEN NULL
          ELSE json_object('provider', provider, 'model', model, 'effort', effort)
        END,
        CASE
          WHEN context_type IS NULL AND session_id IS NULL THEN NULL
          ELSE json_object(
            'type', context_type,
            'sessionId', session_id,
            'mode', context_mode,
            'compactionModel', context_compaction_model
          )
        END,
        title,
        CASE WHEN status = 'retired' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,
        created_at
      FROM actor_threads;
    `);

    db.exec(`
      CREATE INDEX actors_parent_id_idx ON actors (parent_id);
      CREATE INDEX actors_retired_at_idx ON actors (retired_at);
      CREATE UNIQUE INDEX actors_single_root_idx ON actors ((parent_id IS NULL)) WHERE parent_id IS NULL;
    `);

    db.exec(`
      CREATE TABLE new_actor_handles (
        actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
        role TEXT,
        PRIMARY KEY (actor_id, target_id)
      );
    `);
    db.exec(`
      INSERT INTO new_actor_handles (actor_id, target_id, role)
      SELECT actor_id, target_id, role FROM actor_handles;
    `);
    db.exec("DROP TABLE actor_handles;");
    db.exec("ALTER TABLE new_actor_handles RENAME TO actor_handles;");

    db.exec("DROP TABLE actor_pending_deliveries;");
    db.exec("DROP TABLE actor_threads;");
  },
};
