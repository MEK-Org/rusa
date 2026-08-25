import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/** Structural, observability-only token accounting; no dispatch code reads this table. */
export const runTokenRecords: Migration = {
  id: "0010_run_token_records",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE run_token_records (
        id               TEXT PRIMARY KEY,
        run_id           TEXT NOT NULL,
        provider         TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'kimi', 'agy')),
        model            TEXT,
        scraped_at       TEXT NOT NULL,
        uncached_input   INTEGER CHECK (uncached_input >= 0),
        cache_read       INTEGER CHECK (cache_read >= 0),
        output           INTEGER CHECK (output >= 0),
        reasoning        INTEGER CHECK (reasoning >= 0),
        response         INTEGER CHECK (response >= 0),
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (
          provider = 'agy'
          OR (reasoning IS NULL AND response IS NULL)
        ),
        CHECK (
          provider != 'agy'
          OR output IS NULL
          OR (reasoning IS NOT NULL AND response IS NOT NULL AND output = reasoning + response)
        )
      );
      CREATE INDEX idx_run_token_records_run ON run_token_records(run_id);
      CREATE INDEX idx_run_token_records_provider_model_scraped
        ON run_token_records(provider, model, scraped_at);
    `);
  },
};
