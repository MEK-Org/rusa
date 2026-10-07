import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/** Capabilities removed by this migration and ignored by legacy-file import. */
export const RETIRED_CAPABILITIES = new Set(["experiment-admin"]);

/**
 * Remove the actor experiment seam entirely (#939).
 *
 * Drops the `actor_experiments` table and revokes active grants for its retired
 * capability while retaining the capability-grant audit history.
 */
export const dropActorExperiments: Migration = {
  id: "0060_drop_actor_experiments",
  up: (db: Database) => {
    db.exec(`DROP TABLE IF EXISTS actor_experiments;`);
    const hasCapabilityGrants = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'capability_grants'")
      .get();
    if (hasCapabilityGrants) {
      const revokedAt = new Date().toISOString();
      const revoke = db.prepare(
        `UPDATE capability_grants
         SET revoked_at = ?
         WHERE capability = ? AND revoked_at IS NULL`
      );
      for (const capability of RETIRED_CAPABILITIES) revoke.run(revokedAt, capability);
    }
  },
};
