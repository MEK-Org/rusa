import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Responsive obligations (#531): an explicit per-row marker that descendants
 * inherit dynamically. NULL means "not marked here"; once an obligation or an
 * ancestor is marked, the recursive projection keeps every descendant
 * responsive. Reparenting into or out of a responsive subtree needs no row
 * rewrite. Roots with no marker resolve to not-responsive.
 *
 * `ready_count` counts transitions into `ready` (0 = never ready). Each
 * episode is a distinct unit of responsive attention: the behind-head
 * announcement is deduped per (obligation, episode), so a recurring responsive
 * obligation that re-arms behind a persistent head announces again instead of
 * being swallowed by the already-handled episode's dedupe key.
 *
 * For rows existing at migration time, obligations already in `ready` are
 * initialized to 1 to reflect that they have entered ready at least once;
 * unready or terminal rows start at 0.
 */
export const obligationResponsive: Migration = {
  id: "0049_obligation_responsive",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE obligations ADD COLUMN responsive INTEGER
        CHECK (responsive IS NULL OR responsive = 1);
      ALTER TABLE obligations ADD COLUMN ready_count INTEGER NOT NULL DEFAULT 0
        CHECK (ready_count >= 0);
      UPDATE obligations SET ready_count = 1 WHERE status = 'ready';
    `);
  },
};
