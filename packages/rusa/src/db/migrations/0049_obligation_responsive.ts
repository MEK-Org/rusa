import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Responsive obligations (#531): an explicit per-row marker that descendants
 * inherit dynamically. NULL means "not marked here"; once an obligation or an
 * ancestor is marked, the recursive projection keeps every descendant
 * responsive. Reparenting into or out of a responsive subtree needs no row
 * rewrite. Roots with no marker resolve to not-responsive.
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
        CHECK (responsive IS NULL OR responsive = 1);
      ALTER TABLE obligations ADD COLUMN ready_episode INTEGER NOT NULL DEFAULT 0
        CHECK (ready_episode >= 0);
    `);
  },
};
