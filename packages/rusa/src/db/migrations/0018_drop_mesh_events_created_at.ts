import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Drop redundant `created_at` column from `mesh_events` .
 *
 * `mesh_events.created_at` was `ts` at lower resolution in SQLite datetime('now')
 * format, carrying no independent meaning beyond millisecond write latency. All
 * consumers already query and format `ts`.
 *
 * Reverse script (for manual rollback on a copy if ever needed):
 * ```sql
 * ALTER TABLE mesh_events ADD COLUMN created_at TEXT;
 * UPDATE mesh_events SET created_at = datetime(ts);
 * DELETE FROM _migrations WHERE id = '0018_drop_mesh_events_created_at';
 * ```
 * The reverse reconstructs 23,903+/23,909+ byte-exactly, and for the remainder yields
 * a value within 1.31s that is closer to the real event time than what was stored.
 */
export const dropMeshEventsCreatedAt: Migration = {
  id: "0018_drop_mesh_events_created_at",
  up: (db: Database) => {
    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(mesh_events)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );

    if (columns.has("created_at")) {
      db.exec("ALTER TABLE mesh_events DROP COLUMN created_at");
    }
  },
};
