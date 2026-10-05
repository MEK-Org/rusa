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
  it("creates an empty hold table", () => {
    const db = new Database(":memory:");
    availabilityHolds.up(db);

    const columns = db.prepare("PRAGMA table_info(availability_holds)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(columns.map(({ name, notnull }) => ({ name, notnull }))).toEqual([
      { name: "provider", notnull: 1 },
      { name: "model", notnull: 0 },
      { name: "expiry", notnull: 0 },
      { name: "reason", notnull: 1 },
      { name: "created_by", notnull: 1 },
      { name: "created_at", notnull: 1 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM availability_holds").get()).toEqual({ n: 0 });
  });

  it("allows one provider-wide row and one row per model for each provider", () => {
    const db = new Database(":memory:");
    availabilityHolds.up(db);
    const insert = db.prepare(
      `INSERT INTO availability_holds (provider, model, created_by, created_at) VALUES (?, ?, 'root', '${CREATED}')`
    );

    insert.run("kimi", null);
    insert.run("kimi", "kimi-k2");
    insert.run("codex", null);
    expect(() => insert.run("kimi", null)).toThrow(/UNIQUE/);
    expect(() => insert.run("kimi", "kimi-k2")).toThrow(/UNIQUE/);
  });

  it("refuses blank or unnormalized scopes", () => {
    const db = new Database(":memory:");
    availabilityHolds.up(db);
    const insert = db.prepare(
      `INSERT INTO availability_holds (provider, model, created_by, created_at) VALUES (?, ?, 'root', '${CREATED}')`
    );

    expect(() => insert.run("", null)).toThrow(/CHECK/);
    expect(() => insert.run("Kimi", null)).toThrow(/CHECK/);
    expect(() => insert.run(" kimi", null)).toThrow(/CHECK/);
    expect(() => insert.run("kimi", "")).toThrow(/CHECK/);
    expect(() => insert.run("kimi", "Kimi-K2")).toThrow(/CHECK/);
    expect(() => insert.run(null, null)).toThrow(/NOT NULL/);
  });
});
