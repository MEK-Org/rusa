import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { availabilityHolds } from "./0057_availability_holds.js";

const CREATED = "2026-10-05T00:00:00.000Z";

/**
 * What the database itself guarantees for availability holds when application
 * code is bypassed. Behavior through the repository is covered in
 * `availability-hold-repository.test.ts`.
 */
describe("0057_availability_holds", () => {
  it("creates an empty hold table with one JSON scope column", () => {
    const db = new Database(":memory:");
    availabilityHolds.up(db);

    const columns = db.prepare("PRAGMA table_info(availability_holds)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    expect(columns.map(({ name, type, notnull }) => ({ name, type, notnull }))).toEqual([
      { name: "scope", type: "TEXT", notnull: 1 },
      { name: "expiry", type: "TEXT", notnull: 0 },
      { name: "reason", type: "TEXT", notnull: 1 },
      { name: "created_by", type: "TEXT", notnull: 1 },
      { name: "created_at", type: "TEXT", notnull: 1 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM availability_holds").get()).toEqual({ n: 0 });
  });

  it("leaves scope shape to the repository and only keeps scope text unique", () => {
    const db = new Database(":memory:");
    availabilityHolds.up(db);
    const insert = db.prepare(
      `INSERT INTO availability_holds (scope, created_by, created_at) VALUES (?, 'root', '${CREATED}')`
    );

    // No CHECK or json_* validator: the versioned scope document is validated
    // by AvailabilityHoldRepository, the code that consumes it.
    for (const scope of ["kimi", "{}", '{"provider":"Kimi"}', '{"schemaVersion":2}']) {
      expect(() => insert.run(scope), scope).not.toThrow();
    }
    expect(() => insert.run("kimi")).toThrow(/UNIQUE/);
    expect(() => insert.run(null)).toThrow(/NOT NULL/);
  });
});
