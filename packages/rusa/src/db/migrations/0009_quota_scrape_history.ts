import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/** Immutable evidence from real quota PTY probes; cache reads never land here. */
export const quotaScrapeHistory: Migration = {
  id: "0009_quota_scrape_history",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE quota_scrapes (
        id           TEXT PRIMARY KEY,
        provider     TEXT NOT NULL,
        scraped_at   TEXT NOT NULL,
        raw_output   TEXT NOT NULL,
        parsed_state TEXT,
        parse_error  TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_quota_scrapes_provider_scraped
        ON quota_scrapes(provider, scraped_at);
    `);
  },
};
