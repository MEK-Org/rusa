import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { obligationTitle } from "./0027_obligation_title.js";

function columnNames(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(obligations)").all() as Array<{ name: string }>).map(
    (column) => column.name
  );
}

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE obligations (
      id           TEXT PRIMARY KEY,
      parent_id    TEXT REFERENCES obligations(id) ON DELETE RESTRICT,
      owner_id     TEXT NOT NULL,
      intent       TEXT,
      status       TEXT NOT NULL
    );
  `);
  return db;
}

function insert(db: Database.Database, id: string, intent: string | null): void {
  db.prepare(
    "INSERT INTO obligations (id, owner_id, status, intent) VALUES (?, 'actor-a', 'ready', ?)"
  ).run(id, intent);
}

function titleOf(db: Database.Database, id: string): string | null {
  return (
    db.prepare("SELECT title FROM obligations WHERE id = ?").get(id) as { title: string | null }
  ).title;
}

describe("0027_obligation_title", () => {
  it("adds title and is idempotent", () => {
    const db = seedDb();
    expect(columnNames(db)).not.toContain("title");
    obligationTitle.up(db);
    expect(columnNames(db)).toContain("title");
    expect(() => obligationTitle.up(db)).not.toThrow();
  });

  it("derives the heading from the first line of intent, leaving intent intact", () => {
    const db = seedDb();
    insert(db, "multi", "Understand the Space.\n\nWe know what makes games fun.");
    insert(db, "single", "Ship the vertical slice");

    obligationTitle.up(db);

    expect(titleOf(db, "multi")).toBe("Understand the Space.");
    expect(titleOf(db, "single")).toBe("Ship the vertical slice");
    // Derivation, not migration: the body is untouched, so it is reversible.
    expect(
      (db.prepare("SELECT intent FROM obligations WHERE id = 'multi'").get() as { intent: string })
        .intent
    ).toBe("Understand the Space.\n\nWe know what makes games fun.");
  });

  it("gives no heading to a row that never had an intent", () => {
    const db = seedDb();
    insert(db, "empty", null);
    insert(db, "blank", "   \n  ");

    obligationTitle.up(db);

    // "Never had a heading" is the honest answer; inventing one would be the
    // fabricated provenance 0025 refused.
    expect(titleOf(db, "empty")).toBeNull();
    expect(titleOf(db, "blank")).toBeNull();
  });

  it("caps a derived heading and rejects an over-long or blank one", () => {
    const db = seedDb();
    insert(db, "long", "x".repeat(500));
    obligationTitle.up(db);

    expect(titleOf(db, "long")).toHaveLength(200);
    expect(() =>
      db.prepare("UPDATE obligations SET title = ? WHERE id = 'long'").run("y".repeat(201))
    ).toThrow();
    for (const blank of ["", "  ", "\n\t"]) {
      expect(() =>
        db.prepare("UPDATE obligations SET title = ? WHERE id = 'long'").run(blank)
      ).toThrow();
    }
  });
});
