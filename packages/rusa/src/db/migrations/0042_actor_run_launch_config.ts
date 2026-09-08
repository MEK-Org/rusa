import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Store the immutable launch selection in one versioned JSON document. It is
 * nullable only for rows written before this migration; consuming code parses
 * and validates non-null documents, rather than coupling SQLite to a JSON
 * shape with json_* checks.
 */
export const actorRunLaunchConfig: Migration = {
  id: "0042_actor_run_launch_config",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE actor_runs ADD COLUMN model_config TEXT;
    `);
  },
};
