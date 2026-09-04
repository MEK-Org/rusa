import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Durable store for scheduled (future-dated) actor-to-actor messages (#209).
 * Replaces the legacy file-backed `ThreadRecord.pendingDeliveries` array as the
 * live store; the legacy field is imported from once at boot (idempotently, by
 * `id`) and then only ever cleared, never written again.
 *
 * Deliberately has NO foreign key onto `actors`: #175 has not imported/switched
 * actor authority yet, so `to_id`/`from_id` are plain text ids, exactly like the
 * legacy JSON shape's `id: string` fields were.
 */
export const scheduledMessages: Migration = {
  id: "0038_scheduled_messages",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE scheduled_messages (
        id TEXT PRIMARY KEY,
        to_id TEXT NOT NULL,
        from_id TEXT NOT NULL,
        body TEXT NOT NULL,
        deliver_at TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX scheduled_messages_to_id_idx ON scheduled_messages (to_id);
      CREATE INDEX scheduled_messages_deliver_at_idx ON scheduled_messages (deliver_at);
    `);
  },
};
