import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Delivery priority is an immutable send-time fact. NULL preserves the
 * distinction for existing chat rows: they predate the stamp and are read
 * through the legacy compatibility path rather than rewritten in place.
 */
export const meshChatResponsive: Migration = {
  id: "0063_mesh_chat_responsive",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE mesh_chat ADD COLUMN responsive INTEGER CHECK (responsive IN (0, 1));
    `);
  },
};
