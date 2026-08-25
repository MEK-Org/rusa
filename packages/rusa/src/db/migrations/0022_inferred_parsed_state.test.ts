import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { quotaScrapeHistory } from "./0009_quota_scrape_history.js";
import { inferredParsedState } from "./0022_inferred_parsed_state.js";

describe("0022_inferred_parsed_state", () => {
  it("adds inferred_parsed_state column, copies parsed_state to inferred_parsed_state, and sets parsed_state to null", () => {
    const db = new Database(":memory:");
    quotaScrapeHistory.up(db);

    const insert = db.prepare(
      `INSERT INTO quota_scrapes
         (id, provider, scraped_at, raw_output, parsed_state, parse_error)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    insert.run(
      "scrape-1",
      "codex",
      "2026-08-22T10:00:00.000Z",
      "raw 1",
      JSON.stringify({ provider: "codex", status: "available" }),
      null
    );

    insert.run("scrape-2", "claude", "2026-08-22T10:05:00.000Z", "raw 2", null, "failed parse");

    inferredParsedState.up(db);

    const columns = db.prepare("PRAGMA table_info(quota_scrapes)").all() as Array<{
      name: string;
    }>;
    expect(columns.map(({ name }) => name)).toContain("inferred_parsed_state");

    const rows = db
      .prepare(
        "SELECT id, provider, parsed_state, inferred_parsed_state, parse_error FROM quota_scrapes ORDER BY id"
      )
      .all() as Array<{
      id: string;
      provider: string;
      parsed_state: string | null;
      inferred_parsed_state: string | null;
      parse_error: string | null;
    }>;

    expect(rows).toEqual([
      {
        id: "scrape-1",
        provider: "codex",
        parsed_state: null,
        inferred_parsed_state: JSON.stringify({ provider: "codex", status: "available" }),
        parse_error: null,
      },
      {
        id: "scrape-2",
        provider: "claude",
        parsed_state: null,
        inferred_parsed_state: null,
        parse_error: "failed parse",
      },
    ]);
  });
});
