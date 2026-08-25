import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/** Replace owner-local queue positions with inherited, globally comparable priority . */
export const obligationPriority: Migration = {
  id: "0017_obligation_priority",
  up: (db: Database) => {
    db.exec(`
      DROP INDEX idx_obligations_owner_status_order;

      ALTER TABLE obligations ADD COLUMN priority REAL
        CHECK (
          priority IS NULL OR (
            typeof(priority) IN ('real', 'integer') AND
            priority BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308
          )
        );

      -- Existing roots retain their v1 owner-local ordering. Descendants inherit
      -- dynamically from their nearest prioritized ancestor.
      -- Descendants inherit dynamically from their nearest prioritized ancestor.
      UPDATE obligations
      SET priority = CASE
        WHEN parent_id IS NULL THEN CAST(queue_position AS REAL)
        ELSE NULL
      END;

      ALTER TABLE obligations DROP COLUMN queue_position;

      CREATE INDEX idx_obligations_owner_status_priority
        ON obligations(owner_kind, owner_id, status, priority, id);
    `);
  },
};
