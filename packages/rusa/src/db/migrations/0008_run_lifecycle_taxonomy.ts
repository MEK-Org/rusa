import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Rename the two pre-ISSUE_NUM run lifecycle values atomically:
 *
 * - old run_start (the run entered start queues) -> run_queued
 * - old run_admitted (the provider actually started) -> run_start
 *
 * This updates only `kind`. In particular, run_end transcript bodies and the
 * portable-context inject records carried by the old run_start rows are
 * forensic assets and must remain byte-for-byte unchanged.
 *
 * The `_migrations.applied_at` row for this id is the queryable rename epoch.
 */
export const runLifecycleTaxonomy: Migration = {
  id: "0008_run_lifecycle_taxonomy",
  up: (db: Database) => {
    db.prepare(
      `UPDATE mesh_events
       SET kind = CASE kind
         WHEN 'run_start' THEN 'run_queued'
         WHEN 'run_admitted' THEN 'run_start'
       END
       WHERE kind IN ('run_start', 'run_admitted')`
    ).run();
  },
};
