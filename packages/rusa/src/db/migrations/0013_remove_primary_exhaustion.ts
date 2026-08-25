import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

const RETIRED_COLUMNS = [
  "primary_exhaustion",
  "primary_exhaustion_provider",
  "primary_exhaustion_model",
] as const;

/**
 * Remove the event-specific columns briefly introduced on staging by ISSUE_NUM.
 *
 * The guards let this migration serve both upgraded staging databases, where
 * 0011 already added the columns, and fresh databases, whose active migration
 * chain no longer includes 0011.
 */
export const removePrimaryExhaustion: Migration = {
  id: "0013_remove_primary_exhaustion",
  up: (db: Database) => {
    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(mesh_events)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );

    for (const column of RETIRED_COLUMNS) {
      if (columns.has(column)) {
        db.exec(`ALTER TABLE mesh_events DROP COLUMN ${column}`);
      }
    }
  },
};
