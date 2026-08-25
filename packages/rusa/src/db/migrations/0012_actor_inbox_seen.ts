import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/** Record when durable inbox work first causes an actor run to be queued. */
export const actorInboxSeen: Migration = {
  id: "0012_actor_inbox_seen",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE actor_inbox_entries ADD COLUMN seen_at TEXT;

      CREATE INDEX actor_inbox_unseen
        ON actor_inbox_entries(actor_id, seen_at, handled_at, delivered_at, id);
    `);
  },
};
