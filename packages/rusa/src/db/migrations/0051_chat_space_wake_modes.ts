import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Per-space Google Chat wake mode (#692): the event-source owner of a space may
 * choose whether it wakes on `mentions` only or on `all` messages.
 *
 * One row per canonical `gchat:spaces/<id>` resource. No row means the built-in
 * default (DMs and two-person spaces wake on every message, larger spaces on
 * mentions), so existing spaces need no backfill and clearing a mode is a
 * `DELETE`.
 *
 * Keyed by resource rather than hung off `event_source_owners`, because a space
 * need not have an exact ownership row to have an owner — it may bubble to the
 * owner of `gchat:spaces` — and a delegation should not silently reset how the
 * space behaves. Authority to write a row is checked by the mesh against the
 * space's current effective owner, not stored here. The mesh event ledger
 * records who made each change and when; this table keeps only the current
 * behavior.
 */
export const chatSpaceWakeModes: Migration = {
  id: "0051_chat_space_wake_modes",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE chat_space_wake_modes (
        resource TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('mentions', 'all'))
      );
    `);
  },
};
