import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Responsive obligations (#531): an explicit per-row override that descendants
 * inherit dynamically, the same shape as 0017's priority column. NULL means
 * "inherit from the nearest explicit ancestor", resolved at read time by the
 * repository's recursive CTE alongside effective priority, so reparenting into
 * or out of a responsive subtree needs no write. Roots with no explicit value
 * resolve to not-responsive.
 *
 * `ready_episode` counts transitions into `ready` (0 = never ready). Each
 * episode is a distinct unit of responsive attention: the behind-head
 * announcement is deduped per (obligation, episode), so a recurring responsive
 * obligation that re-arms behind a persistent head announces again instead of
 * being swallowed by the already-handled episode's dedupe key.
 */
export const obligationResponsive: Migration = {
  id: "0049_obligation_responsive",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE obligations ADD COLUMN responsive INTEGER
        CHECK (responsive IS NULL OR responsive IN (0, 1));
      ALTER TABLE obligations ADD COLUMN ready_episode INTEGER NOT NULL DEFAULT 0
        CHECK (ready_episode >= 0);
    `);
  },
};
