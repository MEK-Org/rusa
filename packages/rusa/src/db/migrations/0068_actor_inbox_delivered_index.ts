import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Index actor inbox entries by actor and delivery timestamp (#1273).
 *
 * SqliteInboxRepository.list() serves handled and all inbox queries ordered by
 * `delivered_at DESC, id DESC`. The pre-existing index leads with `handled_at`,
 * which for handled entries (`handled_at IS NOT NULL`) is a range condition that
 * forces SQLite to read all handled entries for the actor and sort them using a
 * temporary B-tree on the main thread (causing multi-second event loop stalls).
 *
 * This index serves both handled and all listings directly in sort order,
 * eliminating the temporary B-tree sort (`TEMP B-TREE FOR ORDER BY`).
 *
 * Operational and query boundaries:
 * - For status: "all", work is directly bounded by `limit + 1`.
 * - For status: "handled", SQLite walks in `delivered_at DESC` order and evaluates
 *   `handled_at IS NOT NULL`; it scans any newer/interleaved unhandled rows before
 *   accumulating `limit + 1` handled rows. Because active unhandled backlogs are small,
 *   this avoids sorting the actor's full history.
 * - Sparse property filters (such as `source` or `responsiveOnly`) and deep cursor
 *   traversals inspect candidate rows until `limit + 1` matches are found; listing
 *   work is thus bounded by match density and cursor position rather than strictly
 *   proportional to `limit`.
 * - Index creation build time is estimated at ~15–25 ms at production scale (~22k rows)
 *   as an extrapolation from 100k synthetic measurements (~79 ms), not observed
 *   production timing.
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
