import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Membership of the one mesh-wide voice Chat Room (#663).
 *
 * One row per actor added to the room. The configured root actor is always a
 * participant and is never stored, so an empty table means "root alone" and
 * existing installations need no backfill. Removal deletes the row; there is no
 * history to keep, because membership only decides whose tiles every dashboard
 * shows. `ON DELETE RESTRICT` matches the other actor-owned tables: deleting an
 * actor row must remove its membership first.
 */
export const chatRoomParticipants: Migration = {
  id: "0053_chat_room_participants",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE chat_room_participants (
        actor_id TEXT NOT NULL PRIMARY KEY REFERENCES actors(id) ON DELETE RESTRICT,
        added_by TEXT NOT NULL,
        added_at TEXT NOT NULL
      );
    `);
  },
};
