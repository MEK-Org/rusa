import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Add \`inferred_parsed_state\` column to quota_scrapes and backfill historical
 * parsed_state (which were post-carry-forward snapshots) into inferred_parsed_state,
 * setting parsed_state to NULL for those rows .
 */
export const inferredParsedState: Migration = {
  id: "0022_inferred_parsed_state",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE quota_scrapes ADD COLUMN inferred_parsed_state TEXT;
      UPDATE quota_scrapes
        SET inferred_parsed_state = parsed_state,
            parsed_state = NULL
        WHERE parsed_state IS NOT NULL;
    `);
  },
};
