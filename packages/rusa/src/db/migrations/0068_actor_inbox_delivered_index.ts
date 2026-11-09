import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Index actor inbox entries by actor and delivery timestamp (#1273).
 *
 * SqliteInboxRepository.list() serves handled and all inbox queries ordered by
 * `delivered_at DESC, id DESC`. The existing index leads with `handled_at`,
 * which for handled entries (`handled_at IS NOT NULL`) is a range condition that
 * forces SQLite to read all handled entries for the actor and sort them using a
 * temporary B-tree on the main thread.
 *
 * This index serves both handled and all listings directly in sort order,
 * eliminating the temporary B-tree and bounding query work to the requested page limit.
 */
export const actorInboxDeliveredIndex: Migration = {
  id: "0068_actor_inbox_delivered_index",
  up: (db: Database) => {
    db.exec(`
      CREATE INDEX idx_actor_inbox_delivered
        ON actor_inbox_entries(actor_id, delivered_at DESC, id DESC);
    `);
  },
};
