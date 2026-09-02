import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrations } from "../migrations/index.js";
import { ReferenceCacheRepository } from "./reference-cache-repository.js";

describe("ReferenceCacheRepository", () => {
  function setupDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(
      "CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
    for (const migration of migrations) {
      if (migration.noTransaction) {
        migration.up(db);
      } else {
        db.transaction(() => {
          migration.up(db);
        })();
      }
      db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);
    }
    return db;
  }

  it("can set and get a row", () => {
    const db = setupDb();
    const repo = new ReferenceCacheRepository(db);

    const row = {
      ref: "github:MEK-Org/rusa/issues/155",
      document_version: 1,
      entity_json: JSON.stringify({ type: "github_issue", title: "T", description: "D" }),
      fetched_at: "2026-09-02T14:00:00Z",
      refresh_after: "2026-09-02T15:00:00Z",
    };

    repo.set(row);
    const found = repo.get(row.ref);
    expect(found).toEqual(row);
  });

  it("updates on conflict", () => {
    const db = setupDb();
    const repo = new ReferenceCacheRepository(db);

    const row = {
      ref: "github:MEK-Org/rusa/issues/155",
      document_version: 1,
      entity_json: JSON.stringify({ type: "github_issue", title: "T", description: "D" }),
      fetched_at: "2026-09-02T14:00:00Z",
      refresh_after: "2026-09-02T15:00:00Z",
    };

    repo.set(row);

    const row2 = {
      ...row,
      document_version: 2,
      entity_json: JSON.stringify({ type: "github_issue", title: "T2", description: "D2" }),
    };

    repo.set(row2);
    const found = repo.get(row.ref);
    expect(found).toEqual(row2);
  });

  it("enforces canonical refs", () => {
    const db = setupDb();
    const repo = new ReferenceCacheRepository(db);

    const nonCanonicalRef = "  github:MEK-Org/rusa/issues/155  ";
    const row = {
      ref: nonCanonicalRef,
      document_version: 1,
      entity_json: "{}",
      fetched_at: "2026-09-02T14:00:00Z",
      refresh_after: "2026-09-02T15:00:00Z",
    };

    expect(() => repo.set(row)).toThrowError("ReferenceCacheRepository requires canonical refs");
    expect(() => repo.get(nonCanonicalRef)).toThrowError(
      "ReferenceCacheRepository requires canonical refs"
    );
    expect(() => repo.delete(nonCanonicalRef)).toThrowError(
      "ReferenceCacheRepository requires canonical refs"
    );
  });
});
