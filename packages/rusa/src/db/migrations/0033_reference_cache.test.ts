import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrations } from "./index.js";

describe("0033_reference_cache", () => {
  it("creates reference_cache table", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");

    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    for (const migration of migrations) {
      if (migration.noTransaction) {
        migration.up(db);
      } else {
        db.transaction(() => {
          migration.up(db);
        })();
      }
      db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);
      if (migration.id === "0033_reference_cache") {
        break;
      }
    }

    const tables = new Set(
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name = 'reference_cache'`
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    );
    expect(tables).toEqual(new Set(["reference_cache"]));

    const columns = db.prepare("PRAGMA table_info(reference_cache)").all() as Array<{
      name: string;
      type: string;
    }>;
    expect(columns.map((c) => c.name)).toEqual([
      "ref",
      "document_version",
      "entity_json",
      "fetched_at",
      "refresh_after",
    ]);
  });
});
