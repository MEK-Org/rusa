import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";

describe("0031_inbox_run_focus", () => {
  it("creates durable run focus and many-to-many association tables", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const tables = new Set(
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND (name LIKE '%focus%' OR name = 'inbox_entry_obligations')`
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    );
    expect(tables).toEqual(new Set(["actor_run_focus", "inbox_entry_obligations"]));

    const focusColumns = db.prepare("PRAGMA table_info(actor_run_focus)").all() as Array<{
      name: string;
    }>;
    expect(focusColumns.map((column) => column.name)).toContain("entry_ids_json");
  });
});
