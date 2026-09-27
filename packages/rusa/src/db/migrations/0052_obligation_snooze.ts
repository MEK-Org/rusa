import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Owner-set obligation snooze (#722).
 *
 * `snoozed_until` is a nullable ISO-8601 UTC deadline. While it is set, the
 * obligation keeps its underlying status and keeps blocking its dependents and
 * parents. Only automatic ready attention is deferred: ready heads, responsive
 * ready delivery and strict-yield closure honor it; dependency satisfaction
 * never does. `NULL` means not snoozed, so existing rows need no backfill.
 *
 * The column is not validated in SQLite. Application code normalizes every
 * write to a UTC ISO string, matching how `next_ready_at` is already stored.
 */
export const obligationSnooze: Migration = {
  id: "0052_obligation_snooze",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE obligations ADD COLUMN snoozed_until TEXT;
    `);
  },
};
