import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { portableBriefRevisions } from "./0060_portable_brief_revisions.js";

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE actors (
      id        TEXT PRIMARY KEY,
      charter   TEXT NOT NULL
    );
    INSERT INTO actors (id, charter) VALUES ('actor-a', 'a');
  `);
  portableBriefRevisions.up(db);
  return db;
}

const insert = (
  db: Database.Database,
  over: Partial<Record<"actorId" | "principal" | "timestamp" | "payload", string>> & {
    generation?: number;
  } = {}
): void => {
  db.prepare(
    `INSERT INTO portable_brief_revisions
       (actor_id, generation, acting_principal, timestamp, payload)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    over.actorId ?? "actor-a",
    over.generation ?? 1,
    over.principal ?? "actor-a",
    over.timestamp ?? "2026-10-10T00:00:00.000Z",
    over.payload ?? '{"schemaVersion":1,"before":"a","after":"b"}'
  );
};

/**
 * What the database itself guarantees when application code is bypassed.
 * Behavior through the repository is in `portable-context-repository.test.ts`.
 */
describe("0060_portable_brief_revisions", () => {
  it("creates the table with the 0045-shaped columns", () => {
    const db = seedDb();
    const columns = (
      db.prepare("PRAGMA table_info(portable_brief_revisions)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toEqual([
      "id",
      "actor_id",
      "generation",
      "acting_principal",
      "timestamp",
      "payload",
    ]);
  });

  it("refuses a second row for the same actor generation", () => {
    const db = seedDb();
    insert(db, { generation: 1 });
    expect(() => insert(db, { generation: 1 })).toThrow(/UNIQUE/);
    insert(db, { generation: 2 });
  });

  it("refuses rows for unknown actors and blocks deleting an actor with history", () => {
    const db = seedDb();
    expect(() => insert(db, { actorId: "missing" })).toThrow(/FOREIGN KEY/);
    insert(db);
    expect(() => db.prepare("DELETE FROM actors WHERE id = 'actor-a'").run()).toThrow(
      /FOREIGN KEY/
    );
  });

  it("refuses a zero generation and blank principal, timestamp or payload", () => {
    const db = seedDb();
    expect(() => insert(db, { generation: 0 })).toThrow(/CHECK/);
    expect(() => insert(db, { principal: " " })).toThrow(/CHECK/);
    expect(() => insert(db, { timestamp: "" })).toThrow(/CHECK/);
    expect(() => insert(db, { payload: " " })).toThrow(/CHECK/);
  });
});
