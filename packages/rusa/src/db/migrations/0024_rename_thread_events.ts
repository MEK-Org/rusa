import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

export const renameThreadEvents: Migration = {
  id: "0024_rename_thread_events",
  up: (db: Database) => {
    db.exec(`
      UPDATE mesh_events
      SET kind = 'actor_' || SUBSTR(kind, 8)
      WHERE kind LIKE 'thread_%';
    `);
  },
};
