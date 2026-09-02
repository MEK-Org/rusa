import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";

describe("0032_actor_runs_focus_fold", () => {
  it("folds run focus into actor_runs and drops actor_run_focus", () => {
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
    expect(tables).toEqual(new Set(["inbox_entry_obligations"]));

    const actorRunsColumns = db.prepare("PRAGMA table_info(actor_runs)").all() as Array<{
      name: string;
    }>;
    const colNames = actorRunsColumns.map((column) => column.name);
    expect(colNames).toContain("focus_primary_obligation_id");
    expect(colNames).toContain("focus_resolution");
    expect(colNames).toContain("focus_selected_at");
    expect(colNames).toContain("focus_entry_ids_json");
    expect(colNames).toContain("focus_diagnostics_json");
  });
});
