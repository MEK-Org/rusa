import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Let one obligation declare that it waits on others (#212).
 *
 * `blocked_by` edges are a second "waits for" relation alongside the existing
 * parent-waits-for-live-child one: a dependent stays `waiting` until every
 * prerequisite it names reaches `done`, on top of whatever the parent/child
 * rule already requires. The edge is a plain fact table rather than a status
 * flag on the dependent — cancelling a prerequisite must not erase the record
 * of what it was blocking, since that record is exactly what tells a
 * dependent's owner which edge to remove or replace.
 *
 * No status or "satisfied" column is stored on the edge itself: whether a
 * prerequisite currently blocks its dependent is always read off the
 * prerequisite's own `obligations.status`, so there is exactly one place that
 * can go stale.
 */
export const obligationDependencies: Migration = {
  id: "0037_obligation_dependencies",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS obligation_prerequisites (
        dependent_id    TEXT NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
        prerequisite_id TEXT NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
        PRIMARY KEY (dependent_id, prerequisite_id),
        CHECK (dependent_id <> prerequisite_id)
      );
    `);

    // The forward direction (a dependent's own prerequisites) is served by the
    // primary key. The reverse direction — everything one obligation unblocks,
    // and the cancellation-repair sweep, which starts from a prerequisite and
    // asks who names it — needs its own index.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_obligation_prerequisites_prerequisite
        ON obligation_prerequisites(prerequisite_id, dependent_id);
    `);
  },
};
