import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { eventSources } from "./0038_event_sources.js";
import { chatSpaceWakeModes } from "./0051_chat_space_wake_modes.js";

describe("0051_chat_space_wake_modes", () => {
  it("adds a nullable config blob to event-source owners without a separate wake-mode table", () => {
    const db = new Database(":memory:");
    eventSources.up(db);
    chatSpaceWakeModes.up(db);

    const columns = db.prepare("PRAGMA table_info(event_source_owners)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(columns.find((column) => column.name === "config")?.notnull).toBe(0);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_space_wake_modes'"
        )
        .get()
    ).toBeUndefined();

    // Shape validation is a consuming-code concern; the migration's table DDL
    // contains no SQLite JSON function or CHECK constraint.
    const table = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'event_source_owners'"
      )
      .get() as { sql: string };
    expect(table.sql).toContain("config TEXT");
    expect(table.sql).not.toMatch(/json_|check/i);
  });
});
