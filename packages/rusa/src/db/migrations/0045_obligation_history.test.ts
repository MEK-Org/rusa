import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { obligationHistory } from "./0045_obligation_history.js";

function columnNames(db: Database.Database, table = "obligation_history"): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name
  );
}

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE obligations (
      id             TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
      parent_id      TEXT REFERENCES obligations(id) ON DELETE RESTRICT,
      owner_id       TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
      intent         TEXT,
      title          TEXT,
      external_ref   TEXT,
      status         TEXT NOT NULL CHECK (status IN ('ready', 'waiting', 'done', 'cancelled', 'scheduled')),
      priority       REAL,
      created_at     TEXT,
      updated_at     TEXT,
      creator_id     TEXT,
      terminal_note  TEXT,
      resolution_ref TEXT,
      recurrence_policy TEXT,
      recurrence_cron TEXT,
      recurrence_interval_seconds INTEGER,
      next_ready_at  TEXT,
      checkpoint     TEXT,
      checkpoint_at  TEXT,
      checkpoint_by  TEXT
    );
  `);
  return db;
}

describe("0045_obligation_history", () => {
  it("creates the obligation_history table and index", () => {
    const db = seedDb();
    const tablesBefore = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='obligation_history'")
      .all();
    expect(tablesBefore).toHaveLength(0);

    obligationHistory.up(db);

    const cols = columnNames(db, "obligation_history");
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "obligation_id",
        "mutation_kind",
        "acting_principal",
        "timestamp",
        "payload",
      ])
    );

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='obligation_history'"
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((idx) => idx.name)).toContain("idx_obligation_history_obligation");
  });

  it("is idempotent when run multiple times", () => {
    const db = seedDb();
    obligationHistory.up(db);
    expect(() => obligationHistory.up(db)).not.toThrow();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='obligation_history'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it("contains no SQLite json_* validators or JSON-shape CHECK constraints in schema", () => {
    const db = seedDb();
    obligationHistory.up(db);
    const tableSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='obligation_history'")
        .get() as { sql: string }
    ).sql;

    expect(tableSql.toLowerCase()).not.toContain("json_valid");
    expect(tableSql.toLowerCase()).not.toContain("json_extract");
    expect(tableSql.toLowerCase()).not.toContain("json_");
  });

  it("blocks deleting an obligation that carries history, so the audit stream cannot be erased", () => {
    const db = seedDb();
    obligationHistory.up(db);

    db.prepare(
      "INSERT INTO obligations (id, owner_id, status, title) VALUES ('ob-1', 'actor-a', 'ready', 'Title 1')"
    ).run();

    db.prepare(
      `INSERT INTO obligation_history (obligation_id, mutation_kind, acting_principal, timestamp, payload)
       VALUES ('ob-1', 'reassign', 'actor-a', '2026-09-09T12:00:00.000Z', '{"schemaVersion":1,"before":{"ownerId":"actor-a"},"after":{"ownerId":"actor-b"}}')`
    ).run();

    expect(() => db.prepare("DELETE FROM obligations WHERE id = 'ob-1'").run()).toThrow(
      /FOREIGN KEY constraint failed/
    );

    expect(
      db
        .prepare("SELECT COUNT(*) as count FROM obligation_history WHERE obligation_id = 'ob-1'")
        .get()
    ).toEqual({ count: 1 });
  });

  it("declares ON DELETE RESTRICT rather than CASCADE on the obligation reference", () => {
    const db = seedDb();
    obligationHistory.up(db);
    const tableSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='obligation_history'")
        .get() as { sql: string }
    ).sql;

    expect(tableSql.toUpperCase()).toContain("ON DELETE RESTRICT");
    expect(tableSql.toUpperCase()).not.toContain("ON DELETE CASCADE");
  });

  it("generates strictly monotonic integer primary keys", () => {
    const db = seedDb();
    obligationHistory.up(db);

    db.prepare(
      "INSERT INTO obligations (id, owner_id, status, title) VALUES ('ob-1', 'actor-a', 'ready', 'Title 1')"
    ).run();

    const insert = db.prepare(
      `INSERT INTO obligation_history (obligation_id, mutation_kind, acting_principal, timestamp, payload)
       VALUES ('ob-1', 'priority', 'actor-a', '2026-09-09T12:00:00.000Z', '{"schemaVersion":1,"before":{},"after":{}}')`
    );
    const r1 = insert.run();
    const r2 = insert.run();
    expect(r2.lastInsertRowid).toBeGreaterThan(r1.lastInsertRowid);
  });

  it("satisfies newest-first queries via index without temporary B-tree", () => {
    const db = seedDb();
    obligationHistory.up(db);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id, obligation_id, mutation_kind, acting_principal, timestamp, payload FROM obligation_history WHERE obligation_id = ? ORDER BY id DESC"
      )
      .all("test") as Array<{ detail: string }>;
    expect(
      plan.some((p) => p.detail.includes("USING INDEX idx_obligation_history_obligation"))
    ).toBe(true);
    expect(plan.some((p) => p.detail.toLowerCase().includes("temp b-tree"))).toBe(false);
  });
});
