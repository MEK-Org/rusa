import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { obligationTerminalNote } from "./0026_obligation_terminal_note.js";

function columnNames(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(obligations)").all() as Array<{ name: string }>).map(
    (column) => column.name
  );
}

/** The obligations table as of 0025, before the terminal note exists. */
function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE obligations (
      id             TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
      parent_id      TEXT REFERENCES obligations(id) ON DELETE RESTRICT,
      owner_id       TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
      intent         TEXT,
      external_ref   TEXT,
      status         TEXT NOT NULL CHECK (status IN ('ready', 'waiting', 'done', 'cancelled')),
      priority       REAL,
      created_at     TEXT,
      updated_at     TEXT,
      creator_id     TEXT,
      CHECK (parent_id IS NULL OR parent_id <> id)
    );
  `);
  return db;
}

function insert(db: Database.Database, id: string, status = "done"): void {
  db.prepare(
    "INSERT INTO obligations (id, owner_id, status, intent) VALUES (?, 'actor-a', ?, 'legacy work')"
  ).run(id, status);
}

describe("0026_obligation_terminal_note", () => {
  it("adds terminal_note", () => {
    const db = seedDb();
    expect(columnNames(db)).not.toContain("terminal_note");

    obligationTerminalNote.up(db);

    expect(columnNames(db)).toContain("terminal_note");
  });

  it("is idempotent", () => {
    const db = seedDb();
    obligationTerminalNote.up(db);
    expect(() => obligationTerminalNote.up(db)).not.toThrow();
    expect(columnNames(db).filter((name) => name === "terminal_note")).toHaveLength(1);
  });

  it("leaves already-terminal rows with no invented reason", () => {
    // The same rule 0025 applied to timestamps: a row that terminated before
    // this column existed has no recorded reason, and manufacturing one would
    // assert a provenance nobody wrote.
    const db = seedDb();
    insert(db, "closed-long-ago", "cancelled");

    obligationTerminalNote.up(db);

    const row = db
      .prepare("SELECT terminal_note FROM obligations WHERE id = ?")
      .get("closed-long-ago") as { terminal_note: string | null };
    expect(row.terminal_note).toBeNull();
  });

  it("keeps 'no reason given' to a single representation", () => {
    const db = seedDb();
    obligationTerminalNote.up(db);
    insert(db, "subject");

    // NULL is the one way to say nothing; a blank or whitespace-only note
    // cannot masquerade as a stated reason.
    expect(() =>
      db.prepare("UPDATE obligations SET terminal_note = NULL WHERE id = ?").run("subject")
    ).not.toThrow();
    for (const blank of ["", "   ", "\n\t "]) {
      expect(() =>
        db.prepare("UPDATE obligations SET terminal_note = ? WHERE id = ?").run(blank, "subject")
      ).toThrow();
    }
    expect(() =>
      db
        .prepare("UPDATE obligations SET terminal_note = ? WHERE id = ?")
        .run("superseded by #61", "subject")
    ).not.toThrow();
  });
});
