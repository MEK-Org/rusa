import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Generic time-series metric samples table, keyed by (metric, minute).
 * Each row records one numeric observation for a UTC minute. Value is
 * nullable so a sampled minute with no live population to summarize is
 * recorded as NULL, distinguishing it from an observed zero (value = 0) and
 * a missing minute (no row).
 */
export const metricSamples: Migration = {
  id: "0064_metric_samples",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE metric_samples (
        metric      TEXT NOT NULL,
        minute      TEXT NOT NULL,
        value       REAL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (metric, minute)
      );
      CREATE INDEX idx_metric_samples_minute ON metric_samples (minute);
    `);
  },
};
