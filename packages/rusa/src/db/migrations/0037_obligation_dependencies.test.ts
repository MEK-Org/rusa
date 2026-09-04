import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { obligationDependencies } from "./0037_obligation_dependencies.js";

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE obligations (
      id        TEXT PRIMARY KEY,
      owner_id  TEXT NOT NULL,
      status    TEXT NOT NULL
    );
    INSERT INTO obligations (id, owner_id, status) VALUES ('dependent-1', 'actor-a', 'waiting');
    INSERT INTO obligations (id, owner_id, status) VALUES ('prereq-1', 'actor-a', 'ready');
  `);
  return db;
}

function link(
  db: Database.Database,
  dependentId = "dependent-1",
  prerequisiteId = "prereq-1",
  createdAt = "2026-09-04T00:00:00.000Z"
): void {
  db.prepare(
    `INSERT INTO obligation_prerequisites (dependent_id, prerequisite_id, created_at) VALUES (?, ?, ?)`
  ).run(dependentId, prerequisiteId, createdAt);
}

describe("0037_obligation_dependencies", () => {
  it("creates the edge table idempotently", () => {
    const db = seedDb();
    obligationDependencies.up(db);
    expect(() => obligationDependencies.up(db)).not.toThrow();

    const table = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='obligation_prerequisites'`
      )
      .get();
    expect(table).toBeDefined();
  });

  it("allows many prerequisites per dependent but not the same one twice", () => {
    const db = seedDb();
    obligationDependencies.up(db);
    db.exec(
      `INSERT INTO obligations (id, owner_id, status) VALUES ('prereq-2', 'actor-a', 'ready')`
    );

    link(db, "dependent-1", "prereq-1");
    link(db, "dependent-1", "prereq-2");
    expect(() => link(db, "dependent-1", "prereq-1")).toThrow();

    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM obligation_prerequisites WHERE dependent_id = 'dependent-1'"
      )
      .get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("rejects an obligation naming itself as its own prerequisite", () => {
    const db = seedDb();
    obligationDependencies.up(db);
    expect(() => link(db, "dependent-1", "dependent-1")).toThrow();
  });

  it("refuses an edge to or from an obligation that does not exist", () => {
    const db = seedDb();
    obligationDependencies.up(db);
    expect(() => link(db, "nope", "prereq-1")).toThrow();
    expect(() => link(db, "dependent-1", "nope")).toThrow();
  });

  it("drops an obligation's edges with it in either direction", () => {
    const db = seedDb();
    obligationDependencies.up(db);
    link(db);

    db.prepare("DELETE FROM obligations WHERE id = 'prereq-1'").run();
    const count = db.prepare("SELECT COUNT(*) AS n FROM obligation_prerequisites").get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });
});
