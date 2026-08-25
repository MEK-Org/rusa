import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Migration to add a covering index on mesh_events(actor_id, ts) to support
 * efficient per-actor MAX(ts) lookups for the dashboard's retired-actor
 * activity filter .
 */
export const meshEventsActorTsIndex: Migration = {
  id: "0004_mesh_events_actor_ts_index",
  up: (db: Database) => {
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mesh_events'")
      .get();
    if (hasTable) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_mesh_events_actor_ts ON mesh_events(actor_id, ts);
      `);
    }
  },
};
