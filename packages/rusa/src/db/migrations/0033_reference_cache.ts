import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

export const referenceCache: Migration = {
  id: "0033_reference_cache",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE reference_cache (
        ref              TEXT PRIMARY KEY,
        document_version INTEGER NOT NULL,
        entity_json      TEXT NOT NULL CHECK (json_valid(entity_json)),
        fetched_at       TEXT NOT NULL,
        refresh_after    TEXT NOT NULL
      );
      CREATE INDEX idx_reference_cache_refresh
        ON reference_cache(refresh_after);
    `);
  },
};
