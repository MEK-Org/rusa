import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Remove the actor experiment seam entirely (#939).
 *
 * Drops the `actor_experiments` table and revokes any live `experiment-admin`
 * capability grants from `capability_grants`.
 */
export const dropActorExperiments: Migration = {
  id: "0060_drop_actor_experiments",
  up: (db: Database) => {
    db.exec(`DROP TABLE IF EXISTS actor_experiments;`);
    const hasCapabilityGrants = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'capability_grants'")
      .get();
    if (hasCapabilityGrants) {
      db.exec(`DELETE FROM capability_grants WHERE capability = 'experiment-admin';`);
    }
  },
};
