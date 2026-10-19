import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * One cross-actor inbox summary per sampled UTC minute, retained for 72 hours.
 * Every inbox lives in this database and is read in one statement, so a
 * sample either covers the whole live population or does not exist; per-actor
 * rows would add nothing the dashboard draws. A missing minute is a gap, and
 * NULL statistics mark a minute with no live actor to summarize.
 */
export const inboxMetricSnapshots: Migration = {
  id: "0064_inbox_metric_snapshots",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE inbox_metric_snapshots (
        minute                    TEXT PRIMARY KEY,
        observed_at               TEXT NOT NULL,
        actor_count               INTEGER NOT NULL,
        inbox_size_median         REAL,
        inbox_size_max            INTEGER,
        oldest_age_seconds_median REAL,
        oldest_age_seconds_max    REAL
      );
    `);
  },
};
