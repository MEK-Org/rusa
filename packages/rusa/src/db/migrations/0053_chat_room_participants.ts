import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Membership of the one mesh-wide voice Chat Room (#663).
 *
 * One row per explicitly added actor. Before #1003, runtime behavior treated a
 * configured root as an implicit participant, so it had no row to migrate.
 * Current runtime treats this table as the complete roster: existing rows stay
 * intact, and no actor is inferred or backfilled from configuration, import
 * identity, or topology. Removal deletes the binding; there is no history to
 * keep, because membership only decides whose tiles every dashboard shows.
 * `ON DELETE RESTRICT` matches the other actor-owned tables: deleting an actor
 * row must remove its membership first.
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
