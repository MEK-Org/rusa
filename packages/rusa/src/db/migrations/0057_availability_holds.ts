import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Durable availability holds (#539).
 *
 * A hold takes a provider lane, or one of its models, out of selection without
 * editing any configured model pool. `scope` is a versioned JSON document
 * naming what the row holds: `{"schemaVersion":1,"provider":"kimi"}` holds the
 * whole provider, and `{"schemaVersion":1,"provider":"kimi","model":"kimi-k2"}`
 * holds that one model on it. Several rows may coexist, and setting the same
 * scope again replaces its row.
 *
 * The column has no database-level shape constraint (no CHECK, no `json_valid`,
 * no `json_extract`), matching `host_jobs.manifest` (0040) and
 * `portable_context_snapshots.snapshot` (0048). `AvailabilityHoldRepository`
 * owns the shape: it validates the document on read and writes one canonical,
 * normalized serialization, so equal scopes are equal strings and the unique
 * index on `scope` sees duplicates.
 *
 * `expiry` is an ISO-8601 UTC timestamp, or NULL for a hold that lasts until it
 * is cleared. Expired rows are ignored at selection time and are not deleted
 * automatically.
 */
export const availabilityHolds: Migration = {
  id: "0057_availability_holds",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE availability_holds (
        scope      TEXT NOT NULL,
        expiry     TEXT,
        reason     TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX availability_holds_scope ON availability_holds (scope);
    `);
  },
};
