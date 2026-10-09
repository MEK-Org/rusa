import type { Database } from "better-sqlite3";
import type { Migration } from "../../db/migrations/types.js";

/**
 * The quota coordinator schema as it stood at `user_version` 3, before this
 * migration registry existed (#536). Every quota.db in use was created and
 * upgraded by the store's inline schema code, so this baseline is that code
 * moved here unchanged. Unlike the mesh.db baseline it is not assumed to be
 * applied when tables already exist: each step is idempotent, so it brings a
 * database at any earlier version up to 3 and leaves a version-3 database
 * exactly as it was. The runner stamps the version.
 *
 * Version 2 added the durable per-provider reading-mode fence and the manual
 * observation receipts; version 3 moved `model_scope` into the observation key
 * (#588).
 */
export const coordinatorSchemaV3: Migration = {
  id: "0001_coordinator_schema_v3",
  up: (db: Database) => {
    addModelScope(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS quota_scrapes (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        scraped_at TEXT NOT NULL,
        raw_output TEXT NOT NULL,
        parsed_state TEXT,
        parse_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_shared_quota_scrapes_provider_time
        ON quota_scrapes(provider, scraped_at);
      CREATE INDEX IF NOT EXISTS idx_shared_quota_scrapes_time
        ON quota_scrapes(scraped_at);

      CREATE TABLE IF NOT EXISTS quota_observations (
        provider TEXT NOT NULL,
        model_scope TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        observed_slot INTEGER NOT NULL,
        label TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        percent_left REAL NOT NULL,
        reset_at_iso TEXT,
        window_ms INTEGER NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0,
        controller_error REAL,
        controller_derivative REAL,
        controller_integral REAL,
        uncapped_interval_seconds REAL,
        interval_seconds REAL,
        PRIMARY KEY(provider, model_scope, kind, observed_slot)
      );
      CREATE INDEX IF NOT EXISTS idx_quota_observations_provider_time
        ON quota_observations(provider, observed_at);
      CREATE INDEX IF NOT EXISTS idx_quota_observations_observed_at
        ON quota_observations(observed_at);
      CREATE INDEX IF NOT EXISTS idx_quota_observations_scope_kind_time
        ON quota_observations(provider, model_scope, kind, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_quota_observations_scope_reasoned
        ON quota_observations(provider, model_scope, kind, observed_at DESC)
        WHERE interval_seconds IS NOT NULL;
      CREATE TABLE IF NOT EXISTS quota_provider_reading_modes (
        provider TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('manual', 'scrape')),
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_manual_observation_receipts (
        provider TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        generation INTEGER NOT NULL,
        request_fingerprint TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        PRIMARY KEY(provider, idempotency_key)
      );
    `);
    // `CREATE TABLE IF NOT EXISTS` is a no-op against a table created before
    // this column existed, so widen it in place.
    if (!columnNames(db, "quota_observations").has("controller_integral")) {
      db.exec("ALTER TABLE quota_observations ADD COLUMN controller_integral REAL");
    }
  },
};

/**
 * Schema version 3 (#588): move `model_scope` into the observation key. A
 * primary key cannot be altered in place, so a pre-v3 table is rebuilt with
 * every row copied as provider-wide (`''`) — before v3 the store rejected
 * every model-scoped window, so that is exactly what each row was. The old
 * table's `(provider, kind)` indexes go with it and the schema block above
 * recreates the scope-aware ones. A database already carrying the column,
 * or with no observation table yet, is left alone.
 */
function addModelScope(db: Database): void {
  const columns = columnNames(db, "quota_observations");
  if (columns.size === 0 || columns.has("model_scope")) return;
  if (!columns.has("controller_integral")) {
    db.exec("ALTER TABLE quota_observations ADD COLUMN controller_integral REAL");
  }
  db.exec(`
    CREATE TABLE quota_observations_v3 (
      provider TEXT NOT NULL,
      model_scope TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      observed_slot INTEGER NOT NULL,
      label TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      percent_left REAL NOT NULL,
      reset_at_iso TEXT,
      window_ms INTEGER NOT NULL,
      processed INTEGER NOT NULL DEFAULT 0,
      controller_error REAL,
      controller_derivative REAL,
      controller_integral REAL,
      uncapped_interval_seconds REAL,
      interval_seconds REAL,
      PRIMARY KEY(provider, model_scope, kind, observed_slot)
    );
    INSERT INTO quota_observations_v3
      (provider, model_scope, kind, observed_slot, label, observed_at, percent_left,
       reset_at_iso, window_ms, processed, controller_error, controller_derivative,
       controller_integral, uncapped_interval_seconds, interval_seconds)
    SELECT provider, '', kind, observed_slot, label, observed_at, percent_left,
           reset_at_iso, window_ms, processed, controller_error, controller_derivative,
           controller_integral, uncapped_interval_seconds, interval_seconds
    FROM quota_observations ORDER BY rowid;
    DROP TABLE quota_observations;
    ALTER TABLE quota_observations_v3 RENAME TO quota_observations;
  `);
}

export function columnNames(db: Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
}
