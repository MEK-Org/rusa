import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { actorRuntimeState } from "./0034_actor_runtime_state.js";

describe("0034_actor_runtime_state", () => {
  it("creates the final actor schema directly", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    actorRuntimeState.up(db);

    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toEqual(["actor_handles", "actors"]);

    const columns = db.prepare("PRAGMA table_info(actors)").all() as Array<{
      name: string;
      type: string;
    }>;
    expect(columns.map((column) => [column.name, column.type])).toEqual([
      ["id", "TEXT"],
      ["charter", "TEXT"],
      ["parent_id", "TEXT"],
      ["model_config", "TEXT"],
      ["context_config", "TEXT"],
      ["title", "TEXT"],
      ["retired_at", "TEXT"],
      ["created_at", "TEXT"],
    ]);

    const sql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'actors'")
        .get() as {
        sql: string;
      }
    ).sql;
    expect(sql).not.toContain("json_valid");
    expect(sql).not.toContain("json_extract");

    db.close();
  });

  it("enforces actor relationships and permits only one parentless root", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    actorRuntimeState.up(db);

    db.prepare(
      `INSERT INTO actors (id, charter, parent_id, created_at)
       VALUES ('root', 'Own the mesh', NULL, '2026-09-03T13:00:00.000Z')`
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO actors (id, charter, parent_id, created_at)
           VALUES ('second-root', 'Duplicate', NULL, '2026-09-03T13:01:00.000Z')`
        )
        .run()
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO actors (id, charter, parent_id, created_at)
           VALUES ('orphan', 'Missing parent', 'missing', '2026-09-03T13:01:00.000Z')`
        )
        .run()
    ).toThrow();

    db.prepare(
      `INSERT INTO actors (id, charter, parent_id, created_at)
       VALUES ('worker', 'Implement', 'root', '2026-09-03T13:01:00.000Z')`
    ).run();
    expect(() =>
      db.prepare("INSERT INTO actor_handles (actor_id, target_id) VALUES ('missing', 'root')").run()
    ).toThrow();

    db.close();
  });

  it("leaves versioned JSON document validation to the consuming repository", () => {
    const db = new Database(":memory:");
    actorRuntimeState.up(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO actors (
             id, charter, parent_id, model_config, context_config, created_at
           ) VALUES (
             'root', 'Own the mesh', NULL, 'future-model-format', '["future-context-format"]',
             '2026-09-03T13:00:00.000Z'
           )`
        )
        .run()
    ).not.toThrow();

    db.close();
  });
});
