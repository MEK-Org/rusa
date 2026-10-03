import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Human entry episodes for the mesh-wide Chat Room (#829).
 *
 * One row per authenticated human principal's continuous presence in the
 * Room, shared across that principal's tabs. The scalar columns are what
 * queries need: the episode identity, its principal, when it began and when it
 * ended. At most one episode per principal is current (`ended_at IS NULL`).
 *
 * `document_json` holds the bounded, versioned state that only consuming code
 * reads: per-tab client leases, the frozen recipient snapshot and per-recipient
 * notice delivery progress. Its shape is enforced by the consumer
 * (`voice/room-entry-document.ts`), not by SQLite JSON validators.
 *
 * `principal_id` deliberately has no foreign key: principals live in their own
 * store, and an episode outliving a principal row only ever projects as
 * departed.
 */
export const roomEntryEpisodes: Migration = {
  id: "0054_room_entry_episodes",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE room_entry_episodes (
        id TEXT NOT NULL PRIMARY KEY,
        principal_id TEXT NOT NULL,
        entered_at TEXT NOT NULL,
        ended_at TEXT,
        document_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX room_entry_episodes_current
        ON room_entry_episodes (principal_id) WHERE ended_at IS NULL;
    `);
  },
};
