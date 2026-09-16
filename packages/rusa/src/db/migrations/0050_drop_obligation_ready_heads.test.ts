import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { dropObligationReadyHeads } from "./0050_drop_obligation_ready_heads.js";

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row !== undefined;
}

describe("0050_drop_obligation_ready_heads", () => {
  it("drops obligation_ready_heads table when present", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE obligations (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL
      );
      CREATE TABLE obligation_ready_heads (
        owner_id TEXT PRIMARY KEY,
        head_id TEXT,
        previous_head_id TEXT,
        sequence INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (head_id) REFERENCES obligations(id) ON DELETE CASCADE
      );
      INSERT INTO obligations (id, owner_id) VALUES ('ob-1', 'actor-1');
      INSERT INTO obligation_ready_heads (owner_id, head_id, previous_head_id, sequence, updated_at)
      VALUES ('actor-1', 'ob-1', NULL, 1, '2026-09-16T00:00:00.000Z');
    `);

    expect(tableExists(db, "obligation_ready_heads")).toBe(true);

    dropObligationReadyHeads.up(db);

    expect(tableExists(db, "obligation_ready_heads")).toBe(false);
    expect(db.prepare("SELECT * FROM obligations").all()).toEqual([
      { id: "ob-1", owner_id: "actor-1" },
    ]);
  });

  it("is safe when obligation_ready_heads does not exist", () => {
    const db = new Database(":memory:");
    expect(tableExists(db, "obligation_ready_heads")).toBe(false);
    expect(() => dropObligationReadyHeads.up(db)).not.toThrow();
    expect(tableExists(db, "obligation_ready_heads")).toBe(false);
  });
});
