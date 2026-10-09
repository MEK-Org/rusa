import type { Database } from "better-sqlite3";
import type { Migration } from "../../db/migrations/types.js";
import { columnNames } from "./0001_coordinator_schema_v3.js";

/**
 * Attribute each parse to the parser wording revision that produced it (#536):
 * an immutable, content-addressed revision table and a nullable reference on
 * each scrape. Existing scrapes keep a null revision.
 *
 * Purely additive, so `user_version` stays 3. A pre-change binary refuses any
 * newer version outright and ignores a table and column it does not know, so
 * leaving the version alone is what lets that binary keep reading and writing
 * the upgraded database. The column has no foreign key, so a parse write never
 * depends on a later activation table.
 */
export const parserWordingRevisions: Migration = {
  id: "0002_parser_wording_revisions",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quota_parser_wording_revisions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        wording TEXT NOT NULL
      );
    `);
    if (!columnNames(db, "quota_scrapes").has("parser_wording_revision_id")) {
      db.exec("ALTER TABLE quota_scrapes ADD COLUMN parser_wording_revision_id TEXT");
    }
  },
};
