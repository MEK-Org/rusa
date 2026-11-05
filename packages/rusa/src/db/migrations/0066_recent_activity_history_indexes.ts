import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Serve the two global Recent Activity feeds (#1239) from their sort order.
 *
 * The existing indexes on these tables lead with actor_id, so each feed scanned
 * its table and sorted it just to read one page. The key is the timestamp alone:
 * SQLite still breaks ties on `id` with a small sort over each tied group, and
 * adding `id` would double the index for a fraction of a millisecond per read.
 * Each predicate repeats its query's filter literally: SQLite only uses a partial
 * index when the query's WHERE clause implies the predicate.
 */
export const recentActivityHistoryIndexes: Migration = {
  id: "0066_recent_activity_history_indexes",
  up: (db: Database) => {
    db.exec(`
      CREATE INDEX idx_actor_inbox_recent_handled
        ON actor_inbox_entries(handled_at DESC)
        WHERE handled_at IS NOT NULL;

      CREATE INDEX idx_actor_runs_recent_completed_focus
        ON actor_runs(ended_at DESC)
        WHERE outcome = 'completed'
          AND ended_at IS NOT NULL
          AND focus_entry_ids_json IS NOT NULL;
    `);
  },
};
