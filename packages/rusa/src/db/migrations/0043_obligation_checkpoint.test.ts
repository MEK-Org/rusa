import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { obligationCheckpoint } from "./0043_obligation_checkpoint.js";

function columnNames(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(obligations)").all() as Array<{ name: string }>).map(
    (column) => column.name
  );
}

/** The obligations table as it stands before the checkpoint columns exist. */
function seedDb(): Database.Database {
  const db = new Database(":memory:");
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
      CHECK (parent_id IS NULL OR parent_id <> id)
    );
  `);
  return db;
}

function insert(db: Database.Database, id: string, status = "ready"): void {
  db.prepare(
    "INSERT INTO obligations (id, owner_id, status, title) VALUES (?, 'actor-a', ?, 'Persistence Arc')"
  ).run(id, status);
}

function setStamp(
  db: Database.Database,
  id: string,
  checkpoint: string | null,
  at: string | null,
  by: string | null
): void {
  db.prepare(
    "UPDATE obligations SET checkpoint = ?, checkpoint_at = ?, checkpoint_by = ? WHERE id = ?"
  ).run(checkpoint, at, by, id);
}

describe("0043_obligation_checkpoint", () => {
  it("adds the checkpoint field and its stamp", () => {
    const db = seedDb();
    expect(columnNames(db)).not.toContain("checkpoint");

    obligationCheckpoint.up(db);

    expect(columnNames(db)).toEqual(
      expect.arrayContaining(["checkpoint", "checkpoint_at", "checkpoint_by"])
    );
  });

  it("is idempotent", () => {
    const db = seedDb();
    obligationCheckpoint.up(db);
    expect(() => obligationCheckpoint.up(db)).not.toThrow();
    for (const column of ["checkpoint", "checkpoint_at", "checkpoint_by"]) {
      expect(columnNames(db).filter((name) => name === column)).toHaveLength(1);
    }
  });

  it("invents no standing for obligations written before the column existed", () => {
    // The rule 0025 and 0026 both applied: an absent record is absent. A
    // standing derived from artifacts would assert a currency nobody vouched
    // for — which is the failure this field exists to end, not repeat.
    const db = seedDb();
    insert(db, "arc-predating-checkpoints", "waiting");

    obligationCheckpoint.up(db);

    const row = db
      .prepare("SELECT checkpoint, checkpoint_at, checkpoint_by FROM obligations WHERE id = ?")
      .get("arc-predating-checkpoints") as Record<string, string | null>;
    expect(row).toEqual({ checkpoint: null, checkpoint_at: null, checkpoint_by: null });
  });

  it("keeps 'no standing recorded' to a single representation", () => {
    const db = seedDb();
    obligationCheckpoint.up(db);
    insert(db, "subject");

    expect(() => setStamp(db, "subject", null, null, null)).not.toThrow();
    for (const blank of ["", "   ", "\n\t "]) {
      expect(() => setStamp(db, "subject", blank, "2026-09-07T11:00:00.000Z", "actor-a")).toThrow();
    }
  });

  it("refuses a checkpoint without a stamp, and a stamp without a checkpoint", () => {
    const db = seedDb();
    obligationCheckpoint.up(db);
    insert(db, "subject");

    const at = "2026-09-07T11:00:00.000Z";
    expect(() =>
      setStamp(db, "subject", "head abc1234; gates: CI green", at, "actor-a")
    ).not.toThrow();

    expect(() => setStamp(db, "subject", "standing", null, "actor-a")).toThrow();
    expect(() => setStamp(db, "subject", "standing", at, null)).toThrow();
    expect(() => setStamp(db, "subject", "standing", at, "  ")).toThrow();
    expect(() => setStamp(db, "subject", null, at, "actor-a")).toThrow();
    expect(() => setStamp(db, "subject", null, null, "actor-a")).toThrow();
  });

  it("replaces rather than accumulates", () => {
    const db = seedDb();
    obligationCheckpoint.up(db);
    insert(db, "subject");

    setStamp(db, "subject", "first standing", "2026-09-07T11:00:00.000Z", "actor-a");
    setStamp(db, "subject", "second standing", "2026-09-07T12:00:00.000Z", "actor-b");

    const rows = db
      .prepare("SELECT checkpoint, checkpoint_by FROM obligations WHERE id = ?")
      .all("subject");
    expect(rows).toEqual([{ checkpoint: "second standing", checkpoint_by: "actor-b" }]);
  });
});
