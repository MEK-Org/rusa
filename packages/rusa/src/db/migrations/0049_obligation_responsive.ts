import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Responsive obligations (#531): an explicit per-row override that descendants
 * inherit dynamically, the same shape as 0017's priority column. NULL means
 * "inherit from the nearest explicit ancestor", resolved at read time by the
 * repository's recursive CTE alongside effective priority, so reparenting into
 * or out of a responsive subtree needs no write. Roots with no explicit value
 * resolve to not-responsive.
 */
export const obligationResponsive: Migration = {
  id: "0049_obligation_responsive",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE obligations ADD COLUMN responsive INTEGER
        CHECK (responsive IS NULL OR responsive IN (0, 1));
    `);
  },
};
