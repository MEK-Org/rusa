import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrations } from "./index.js";

function runUpTo(db: Database.Database, targetId: string, fromId?: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  let started = fromId === undefined;
  for (const migration of migrations) {
    if (!started) {
      if (migration.id === fromId) started = true;
      continue;
    }
    if (migration.noTransaction) {
      migration.up(db);
    } else {
      db.transaction(() => {
        migration.up(db);
      })();
    }
    db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);
    if (migration.id === targetId) break;
  }
}

describe("0036_actor_model_config", () => {
  it("replaces the scalar provider/model/effort columns with modelConfig/desiredModelConfig JSON", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runUpTo(db, "0034_actor_runtime_state");
    db.prepare(
      `INSERT INTO actor_threads (
        id, charter, parent_id, provider, model, effort,
        desired_provider, desired_model, desired_effort, desired_effort_is_set,
        is_root, status, human_unlocked, created_at
      ) VALUES ('root', 'Own the mesh', NULL, 'codex', 'gpt-test', 'high',
        'next-provider', 'next-model', NULL, 1,
        1, 'active', 0, '2026-09-03T13:00:00.000Z')`
    ).run();

    runUpTo(db, "0036_actor_model_config", "0034_actor_runtime_state");

    const columns = (
      db.prepare("PRAGMA table_info(actor_threads)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).not.toContain("provider");
    expect(columns).not.toContain("desired_effort_is_set");
    expect(columns).toContain("model_config");
    expect(columns).toContain("desired_model_config");

    const row = db
      .prepare("SELECT model_config, desired_model_config FROM actor_threads WHERE id = 'root'")
      .get() as {
      model_config: string;
      desired_model_config: string;
    };
    expect(JSON.parse(row.model_config)).toEqual([
      { provider: "codex", model: "gpt-test", effort: "high" },
    ]);
    expect(JSON.parse(row.desired_model_config)).toEqual([
      { provider: "next-provider", model: "next-model" },
    ]);
  });
});
