import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Migration to add index on mesh_events(actor_id, kind) to support
 * efficient queries of pending/unacknowledged events for a given actor.
 */
export const meshEventsActorKindIndex: Migration = {
  id: "0002_mesh_events_actor_kind_index",
  up: (db: Database) => {
    // Robust check: Only run index creation if mesh_events table exists
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mesh_events'")
      .get();
    if (hasTable) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_mesh_events_actor_kind ON mesh_events(actor_id, kind);
        CREATE INDEX IF NOT EXISTS idx_mesh_events_kind_detail ON mesh_events(kind, detail);
      `);
    }
  },
};
