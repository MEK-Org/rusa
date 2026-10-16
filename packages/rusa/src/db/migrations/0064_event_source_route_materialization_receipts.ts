import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Completion record for the one-time conversion of configuration-implied
 * event-source ownership into explicit durable ownership (#1003).
 *
 * The configured-actor receipt says only whether the retired `rootActor`
 * import ran. It cannot also say whether every configured source was examined,
 * because an empty import and a zero-route conversion are independently useful
 * facts. One versioned row is written in the same immediate transaction as the
 * ownership writes. `input_snapshot_json` is intentionally validated by its
 * repository consumer instead of SQLite JSON functions so every supported
 * SQLite build accepts the same migration.
 */
export const eventSourceRouteMaterializationReceipts: Migration = {
  id: "0064_event_source_route_materialization_receipts",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE event_source_route_materialization_receipts (
        version             INTEGER PRIMARY KEY,
        completed_at        TEXT NOT NULL CHECK (length(trim(completed_at)) > 0),
        input_snapshot_json TEXT NOT NULL CHECK (length(trim(input_snapshot_json)) > 0)
      );
    `);
  },
};
