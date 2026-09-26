import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { eventSources } from "./0038_event_sources.js";
import { eventSourceConfig } from "./0051_event_source_config.js";

describe("0051_event_source_config", () => {
  it("adds a nullable config blob to event-source owners", () => {
    const db = new Database(":memory:");
    eventSources.up(db);
    eventSourceConfig.up(db);

    const columns = db.prepare("PRAGMA table_info(event_source_owners)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(columns.find((column) => column.name === "config")?.notnull).toBe(0);
  });
});
