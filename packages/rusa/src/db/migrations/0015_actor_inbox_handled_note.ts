import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/** Preserve the actor's explanation when explicitly marking inbox work handled. */
export const actorInboxHandledNote: Migration = {
  id: "0015_actor_inbox_handled_note",
  up: (db: Database) => {
    db.exec("ALTER TABLE actor_inbox_entries ADD COLUMN handled_note TEXT;");
  },
};
