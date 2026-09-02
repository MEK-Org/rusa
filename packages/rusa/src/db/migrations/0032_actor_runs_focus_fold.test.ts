import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrations } from "./index.js";

describe("0032_actor_runs_focus_fold", () => {
  it("folds run focus into actor_runs and drops actor_run_focus", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");

    // Run migrations through 0031
    const idx0031 = migrations.findIndex((m) => m.id === "0031_inbox_run_focus");
    if (idx0031 === -1) throw new Error("Could not find 0031 migration");

    // Minimal migration runner for testing
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    for (const migration of migrations.slice(0, idx0031 + 1)) {
      if (migration.noTransaction) {
        migration.up(db);
      } else {
        db.transaction(() => migration.up(db))();
      }
      db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);
    }

    // Insert test data
    db.prepare(`
      INSERT INTO obligations (
        id, owner_id, intent, status, priority
      ) VALUES (
        'obl-789', 'actor-456', 'test intent', 'ready', 0
      )
    `).run();

    db.prepare(`
      INSERT INTO actor_runs (
        id, actor_id, started_at
      ) VALUES (
        'run-123', 'actor-456', '2026-09-02T10:00:00.000Z'
      )
    `).run();

    db.prepare(`
      INSERT INTO actor_run_focus (
        run_id,
        actor_id,
        primary_obligation_id,
        resolution,
        selected_at,
        entry_ids_json,
        diagnostics_json
      ) VALUES (
        'run-123',
        'actor-456',
        'obl-789',
        'explicit',
        '2026-09-02T10:01:00.000Z',
        '["entry-1", "entry-2"]',
        '{"foo": "bar"}'
      )
    `).run();

    // Apply 0032
    const migration0032 = migrations.find((m) => m.id === "0032_actor_runs_focus_fold");
    if (!migration0032) throw new Error("Could not find 0032 migration");

    if (migration0032.noTransaction) {
      migration0032.up(db);
    } else {
      db.transaction(() => migration0032.up(db))();
    }
    db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration0032.id);

    // Verify table dropped
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

    // Verify data copied
    const row = db.prepare("SELECT * FROM actor_runs WHERE id = 'run-123'").get() as {
      focus_primary_obligation_id: string;
      focus_resolution: string;
      focus_selected_at: string;
      focus_entry_ids_json: string;
      focus_diagnostics_json: string;
    };
    expect(row.focus_primary_obligation_id).toBe("obl-789");
    expect(row.focus_resolution).toBe("explicit");
    expect(row.focus_selected_at).toBe("2026-09-02T10:01:00.000Z");
    expect(row.focus_entry_ids_json).toBe('["entry-1", "entry-2"]');
    expect(row.focus_diagnostics_json).toBe('{"foo": "bar"}');
  });
});
