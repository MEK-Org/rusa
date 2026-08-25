import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { removePrimaryExhaustion } from "./0013_remove_primary_exhaustion.js";

function columnNames(db: Database.Database): string[] {
  return (
    db.prepare("PRAGMA table_info(mesh_events)").all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

describe("0013_remove_primary_exhaustion", () => {
  it("drops the retired staging columns without disturbing mesh event data", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE mesh_events (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT,
        primary_exhaustion TEXT,
        primary_exhaustion_provider TEXT,
        primary_exhaustion_model TEXT
      );
      INSERT INTO mesh_events (
        id, kind, payload, primary_exhaustion,
        primary_exhaustion_provider, primary_exhaustion_model
      ) VALUES (
        'end', 'run_end', '{"source":"test"}', 'exhausted', 'claude', 'opus'
      );
    `);

    removePrimaryExhaustion.up(db);

    expect(columnNames(db)).toEqual(["id", "kind", "payload"]);
    expect(db.prepare("SELECT id, kind, payload FROM mesh_events").get()).toEqual({
      id: "end",
      kind: "run_end",
      payload: '{"source":"test"}',
    });
  });

  it("is safe for fresh databases that never created the retired columns", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE mesh_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL)");

    expect(() => removePrimaryExhaustion.up(db)).not.toThrow();
    expect(columnNames(db)).toEqual(["id", "kind"]);
  });
});
