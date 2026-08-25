import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/** Immutable evidence from real model TUI/CLI enumeration probes; stores raw screen and parsed model entries. */
export const modelScrapes: Migration = {
  id: "0019_model_scrapes",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE model_scrapes (
        id            TEXT PRIMARY KEY,
        provider      TEXT NOT NULL,
        scraped_at    TEXT NOT NULL,
        raw_output    TEXT NOT NULL,
        parsed_models TEXT,
        parse_error   TEXT
      );
      CREATE INDEX idx_model_scrapes_provider_scraped
        ON model_scrapes(provider, scraped_at);
    `);
  },
};
