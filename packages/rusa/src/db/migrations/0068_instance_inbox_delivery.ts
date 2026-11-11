import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Draft #1199: retain sender-side remote delivery intent beside the existing
 * inbox row. `handled_at` remains exclusively the recipient actor's decision.
 * This concrete shape is intentionally pending operator approval before staging.
 */
export const instanceInboxDelivery: Migration = {
  id: "0068_instance_inbox_delivery",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE actor_inbox_entries
        ADD COLUMN delivery_direction TEXT NOT NULL DEFAULT 'incoming';
      ALTER TABLE actor_inbox_entries
        ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'delivered';
      CREATE INDEX actor_inbox_outgoing_pending
        ON actor_inbox_entries(delivery_direction, delivery_state, delivered_at, id);
    `);
  },
};
