import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Event-source-specific configuration (#692). Its first consumer is the
 * per-space Google Chat wake mode, whose owner may choose `mentions` or `all`.
 *
 * The nullable `config` blob belongs to the active `event_source_owners` row
 * for its exact canonical resource. `NULL` means that source has no stored
 * configuration, so existing sources need no backfill.
 *
 * Configuration is a property of the event source, not of the actor who
 * happened to configure it. `DbEventSourceOwnerStore` carries the blob from
 * the prior holder to the next during delegation and reclaim, and retains it
 * on an unsubscribed row for a later re-subscribe of that exact source. An
 * actor who clears the wake mode removes that key; a source that is merely
 * disabled and later re-enabled resumes its prior non-default setting. The
 * mesh checks authority and records who changed the mode in the event ledger.
 *
 * `config` is a versioned JSON document consumed by code. SQLite deliberately
 * does not validate its JSON or shape: each consumer handles unknown or malformed
 * versions as appropriate, and future versions remain a code-level compatibility
 * decision.
 */
export const eventSourceConfig: Migration = {
  id: "0051_event_source_config",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE event_source_owners ADD COLUMN config TEXT;
    `);
  },
};
