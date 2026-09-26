import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Event-source-specific configuration (#692). Its first consumer is the
 * per-space Google Chat wake mode, whose owner may choose `mentions` or `all`.
 *
 * The nullable `config` blob belongs to the active `event_source_owners` row
 * for the exact canonical `gchat:spaces/<id>` resource. `NULL` means the
 * built-in default (DMs and two-person spaces wake on every message, larger
 * spaces on mentions), so existing spaces need no backfill and clearing a mode
 * writes `NULL`.
 *
 * Configuration is a property of the event source, not of the actor who
 * happened to configure it. `DbEventSourceOwnerStore` carries the blob from
 * the prior holder to the next during delegation and reclaim, and retains it
 * on an unsubscribed row for a later re-subscribe of that exact source. An
 * operator who clears the wake mode removes that key; a source that is merely
 * disabled and later re-enabled resumes its prior non-default setting. The
 * mesh checks authority and records who changed the mode in the event ledger.
 *
 * `config` is a versioned JSON document consumed by code. SQLite deliberately
 * does not validate its JSON or shape: the repository rejects unknown/malformed
 * versions as no configured wake mode, and future versions remain a code-level
 * compatibility decision.
 */
export const eventSourceConfig: Migration = {
  id: "0051_event_source_config",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE event_source_owners ADD COLUMN config TEXT;
    `);
  },
};
