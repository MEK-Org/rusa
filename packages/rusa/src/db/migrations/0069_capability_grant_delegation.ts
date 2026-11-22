import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Adds a nullable `delegable` column to `capability_grants` (#1346):
 * - `NULL` (default): not delegable
 * - `'descendants'`: grantee may delegate within its own subtree
 * - `'anyone'`: grantee may delegate to any existing actor
 *
 * No CHECK constraint per schema policy; consumer code enforces valid values.
 * Existing rows remain `NULL` here; one-off flagging of active LLM secret rows
 * is performed separately by `packages/rusa/scripts/backfill-secret-delegation.mjs`.
 */
export const capabilityGrantDelegation: Migration = {
  id: "0069_capability_grant_delegation",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE capability_grants ADD COLUMN delegable TEXT;
    `);
  },
};
