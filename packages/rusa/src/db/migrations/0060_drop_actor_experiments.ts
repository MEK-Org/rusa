import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

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
    const revokedAt = new Date().toISOString();
    db.prepare(
      `UPDATE capability_grants
       SET revoked_at = ?
       WHERE capability = 'experiment-admin' AND revoked_at IS NULL`
    ).run(revokedAt);
  },
};
