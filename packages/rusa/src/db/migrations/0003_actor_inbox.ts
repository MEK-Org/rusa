import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/** Additive durable notification ledger for actor-bound inbox delivery . */
export const actorInbox: Migration = {
  id: "0003_actor_inbox",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE actor_inbox_entries (
        id           TEXT PRIMARY KEY,
        actor_id     TEXT NOT NULL,
        source       TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        handled_at   TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX actor_inbox_unhandled
        ON actor_inbox_entries(actor_id, handled_at, delivered_at, id);
    `);
  },
};
