import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Normalized store for {@link CapabilityGrant} records (currently JSON-file
 * backed via `FileCapabilityGrantStore`), mirroring the `actors`/`actor_handles`
 * shape from 0034: one row per (actor_id, capability) — the same key the
 * in-memory/file stores already enforce — with `actor_id` owned by the
 * `actors` row it grants to, and revocation kept as a nullable `revoked_at`
 * timestamp rather than a duplicate status enum so the audit trail (active +
 * revoked) survives in one table, matching the existing store's `list()`.
 * `ON DELETE RESTRICT` (matching `obligations.parent_id` and peers) keeps an
 * actor's grant history from disappearing out from under it if the actor row
 * is ever deleted — deletion must revoke/clear grants first, same as it must
 * for any other owned history.
 */
export const capabilityGrants: Migration = {
  id: "0036_capability_grants",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE capability_grants (
        actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
        capability  TEXT NOT NULL,
        granted_by  TEXT NOT NULL,
        granted_at  TEXT NOT NULL,
        revoked_at  TEXT,
        PRIMARY KEY (actor_id, capability)
      );
    `);
  },
};
