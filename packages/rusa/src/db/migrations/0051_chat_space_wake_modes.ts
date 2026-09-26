import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Per-space Google Chat wake mode (#692): the event-source owner of a space may
 * choose whether it wakes on `mentions` only or on `all` messages.
 *
 * The nullable `config` blob belongs to the active `event_source_owners` row
 * for the exact canonical `gchat:spaces/<id>` resource. `NULL` means the
 * built-in default (DMs and two-person spaces wake on every message, larger
 * spaces on mentions), so existing spaces need no backfill and clearing a mode
 * writes `NULL`.
 *
 * A mode is a property of the event source, not of the actor who happened to
 * configure it. `DbEventSourceOwnerStore` carries the blob from the prior
 * holder to the next during delegation and reclaim. The mesh checks authority
 * and records who changed the mode in the existing event ledger.
 *
 * `config` is a versioned JSON document consumed by code. SQLite deliberately
 * does not validate its JSON or shape: the repository rejects unknown/malformed
 * versions as no configured wake mode, and future versions remain a code-level
 * compatibility decision.
 */
export const chatSpaceWakeModes: Migration = {
  id: "0051_chat_space_wake_modes",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE event_source_owners ADD COLUMN config TEXT;
    `);
  },
};
