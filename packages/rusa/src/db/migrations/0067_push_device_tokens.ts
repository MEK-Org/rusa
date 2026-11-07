import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * FCM registration tokens are opaque device credentials. They are durable so a
 * reply can reach a backgrounded Android client, but the server only ever
 * resolves one through its owning authenticated principal.
 */
export const pushDeviceTokens: Migration = {
  id: "0067_push_device_tokens",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE push_device_tokens (
        token TEXT PRIMARY KEY CHECK (length(trim(token)) > 0),
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE
      );
      CREATE INDEX push_device_tokens_principal_idx
        ON push_device_tokens(principal_id);
    `);
  },
};
