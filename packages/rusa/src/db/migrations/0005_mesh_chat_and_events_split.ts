import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

export const meshChatAndEventsSplit: Migration = {
  id: "0005_mesh_chat_and_events_split",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE mesh_chat (
        id           TEXT PRIMARY KEY,
        ts           TEXT NOT NULL,
        sender_id    TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        body         TEXT NOT NULL,
        session_id   TEXT
      );
      
      ALTER TABLE mesh_events ADD COLUMN payload TEXT;
    `);
  },
};
