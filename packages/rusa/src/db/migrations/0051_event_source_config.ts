import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Event-source-specific configuration (#692). Its first consumer is the
 * per-space Google Chat wake mode, whose generic config can choose `mentions`
 * or `all`.
 *
 * The nullable `config` blob belongs to the active `event_source_owners` row
 * for its exact canonical resource. `NULL` means that source has no stored
 * configuration, so existing sources need no backfill.
 *
 * Configuration is a property of an active exact source, not of the actor who
 * happened to configure it. The mesh preserves it across a live exact
 * delegation or reclaim; a later unrelated re-subscribe starts unconfigured.
 * Consumers own their versioned shape, and the mesh records only that a
 * generic configuration was set or cleared.
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
