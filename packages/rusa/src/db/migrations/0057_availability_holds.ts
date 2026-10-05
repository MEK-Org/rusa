import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Durable availability holds (#539).
 *
 * A hold takes a provider lane, or some of its models, out of selection
 * without editing any configured model pool. One row covers one scope: a NULL
 * `model` holds the whole provider, otherwise the row holds that one model on
 * that provider. Several rows may coexist, and setting the same scope again
 * replaces its row, so the unique index treats NULL as its own scope.
 *
 * `expiry` is an ISO-8601 UTC timestamp, or NULL for a hold that lasts until it
 * is cleared. Expired rows are ignored at selection time and are not deleted
 * automatically. Provider and model are stored normalized (trimmed, lowercase)
 * so lookups compare exact strings.
 */
export const availabilityHolds: Migration = {
  id: "0057_availability_holds",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE availability_holds (
        provider   TEXT NOT NULL CHECK (provider <> '' AND provider = lower(trim(provider))),
        model      TEXT CHECK (model IS NULL OR (model <> '' AND model = lower(trim(model)))),
        expiry     TEXT,
        reason     TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX availability_holds_scope
        ON availability_holds (provider, COALESCE(model, ''));
    `);
  },
};
