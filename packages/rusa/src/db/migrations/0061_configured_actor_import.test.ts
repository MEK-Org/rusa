import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LegacyImportReceiptRepository } from "../repositories/legacy-import-receipt-repository.js";
import { SqliteActorRepository } from "../repositories/sqlite-actor-repository.js";
import { runMigrations } from "./runner.js";

const EXECUTION = '{"schemaVersion":1,"unsandboxed":true}';

function columns(db: Database.Database, table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: unknown;
  }>;
}

describe("0061_configured_actor_import", () => {
  it("adds nullable provenance and handle columns without touching existing rows", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, { throughId: "0059_obligation_completion_matchers" });
    db.prepare(
      `INSERT INTO actors (id, charter, parent_id, created_at, execution_config)
       VALUES ('root', 'charter', NULL, '2026-01-01T00:00:00.000Z', ?)`
    ).run(EXECUTION);
    db.prepare(
      `INSERT INTO legacy_import_receipts (source, imported_at, row_count)
       VALUES ('host-jobs.json', '2026-01-02T00:00:00.000Z', 3)`
    ).run();

    runMigrations(db);

    expect(columns(db, "legacy_import_receipts").find((c) => c.name === "actor_id")).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
    expect(columns(db, "actors").find((c) => c.name === "display_handle")).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
    expect(
      db.prepare("SELECT source, row_count, actor_id FROM legacy_import_receipts").all()
    ).toEqual([{ source: "host-jobs.json", row_count: 3, actor_id: null }]);
    expect(db.prepare("SELECT id, charter, display_handle FROM actors").all()).toEqual([
      { id: "root", charter: "charter", display_handle: null },
    ]);
  });

  it("rejects empty strings in both columns", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO legacy_import_receipts (source, imported_at, row_count, actor_id)
           VALUES ('config.yaml:rootActor', '2026-01-01T00:00:00.000Z', 1, '')`
        )
        .run()
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO actors (id, charter, parent_id, created_at, execution_config, display_handle)
           VALUES ('a', 'c', NULL, '2026-01-01T00:00:00.000Z', ?, '')`
        )
        .run(EXECUTION)
    ).toThrow(/CHECK constraint failed/);
  });

  it("round-trips the stored handle and the receipt's actor through the repositories", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const actors = new SqliteActorRepository(db);
    const receipts = new LegacyImportReceiptRepository(db);

    actors.upsert({
      id: "configured",
      charter: "c",
      parentId: null,
      displayHandle: "ember-familiar",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    actors.upsert({
      id: "worker",
      charter: "w",
      parentId: "configured",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    receipts.record("config.yaml:rootActor", "2026-01-02T00:00:00.000Z", 1, "configured");
    receipts.record("config.yaml:rootActor", "2026-01-03T00:00:00.000Z", 1, "other");
    receipts.record("host-jobs.json", "2026-01-02T00:00:00.000Z", 0);

    expect(actors.get("configured")?.displayHandle).toBe("ember-familiar");
    expect(actors.get("worker")).not.toHaveProperty("displayHandle");
    // An incidental write keeps the stored handle.
    actors.patch("configured", { title: "renamed" });
    expect(actors.get("configured")?.displayHandle).toBe("ember-familiar");
    // The first receipt stands; a receipt without an actor names none.
    expect(receipts.actorFor("config.yaml:rootActor")).toBe("configured");
    expect(receipts.actorFor("host-jobs.json")).toBeUndefined();
    expect(receipts.actorFor("never-imported")).toBeUndefined();
  });
});
