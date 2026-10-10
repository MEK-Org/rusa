import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Migration } from "../../db/migrations/types.js";
import { QUOTA_SCHEMA_VERSION } from "../schema-guard.js";
import { coordinatorSchemaV3 } from "./0001_coordinator_schema_v3.js";
import { quotaMigrations } from "./index.js";
import { runQuotaMigrations } from "./runner.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openDb(): { db: Database.Database; path: string } {
  const root = mkdtempSync(join(tmpdir(), "rusa-quota-migrations-"));
  roots.push(root);
  const path = join(root, "quota.db");
  return { db: new Database(path), path };
}

function appliedIds(db: Database.Database): string[] {
  return (db.prepare("SELECT id FROM _migrations ORDER BY id").all() as Array<{ id: string }>).map(
    (row) => row.id
  );
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

describe("runQuotaMigrations", () => {
  it("builds a fresh database and records every migration", () => {
    const { db } = openDb();
    try {
      runQuotaMigrations(db);
      expect(appliedIds(db)).toEqual(quotaMigrations.map((m) => m.id));
      expect(db.pragma("user_version", { simple: true })).toBe(QUOTA_SCHEMA_VERSION);
      expect(
        (db.prepare("PRAGMA table_info(quota_scrapes)").all() as Array<{ name: string }>).map(
          (c) => c.name
        )
      ).toEqual([
        "id",
        "provider",
        "scraped_at",
        "raw_output",
        "parsed_state",
        "parse_error",
        "parser_wording_revision_id",
      ]);
    } finally {
      db.close();
    }
  });

  it("brings a version-3 database from before the runner forward without touching its rows", () => {
    const { db } = openDb();
    try {
      // The baseline is the store's former inline schema code, so running it
      // alone reproduces a database written before `_migrations` existed.
      coordinatorSchemaV3.up(db);
      db.pragma("user_version = 3");
      db.prepare(
        `INSERT INTO quota_scrapes (id, provider, scraped_at, raw_output, parse_error)
         VALUES ('existing', 'codex', '2030-01-01T00:00:00.000Z', 'synthetic', 'synthetic failure')`
      ).run();
      expect(tableExists(db, "_migrations")).toBe(false);

      runQuotaMigrations(db);

      expect(appliedIds(db)).toEqual(quotaMigrations.map((m) => m.id));
      expect(db.pragma("user_version", { simple: true })).toBe(QUOTA_SCHEMA_VERSION);
      expect(
        db
          .prepare(
            "SELECT id, parse_error, parser_wording_revision_id AS revision FROM quota_scrapes"
          )
          .all()
      ).toEqual([{ id: "existing", parse_error: "synthetic failure", revision: null }]);
    } finally {
      db.close();
    }
  });

  it("applies nothing again once a migration is recorded", () => {
    const { db } = openDb();
    try {
      const up = vi.fn((target: Database.Database) => target.exec("CREATE TABLE once (x)"));
      const list: Migration[] = [{ id: "0001_once", up }];
      runQuotaMigrations(db, list);
      runQuotaMigrations(db, list);
      expect(up).toHaveBeenCalledTimes(1);
      expect(appliedIds(db)).toEqual(["0001_once"]);
    } finally {
      db.close();
    }
  });

  it("restamps a header below the schema version even when nothing is pending", () => {
    const { db } = openDb();
    try {
      runQuotaMigrations(db);
      db.pragma("user_version = 0");
      runQuotaMigrations(db);
      expect(db.pragma("user_version", { simple: true })).toBe(QUOTA_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("ignores an applied id recorded by a newer binary", () => {
    const { db } = openDb();
    try {
      runQuotaMigrations(db);
      db.prepare("INSERT INTO _migrations (id) VALUES ('0099_from_a_newer_binary')").run();
      expect(() => runQuotaMigrations(db)).not.toThrow();
      expect(appliedIds(db)).toEqual([
        ...quotaMigrations.map((m) => m.id),
        "0099_from_a_newer_binary",
      ]);
    } finally {
      db.close();
    }
  });

  it("rolls back the whole pass when a migration fails", () => {
    const { db } = openDb();
    try {
      const list: Migration[] = [
        { id: "0001_ok", up: (target) => target.exec("CREATE TABLE created_first (x)") },
        {
          id: "0002_fails",
          up: () => {
            throw new Error("synthetic migration failure");
          },
        },
      ];
      expect(() => runQuotaMigrations(db, list)).toThrow("synthetic migration failure");
      expect(tableExists(db, "created_first")).toBe(false);
      expect(tableExists(db, "_migrations")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("takes the write lock before reading what is applied", () => {
    const { db, path } = openDb();
    const writer = new Database(path);
    try {
      runQuotaMigrations(db);
      db.pragma("busy_timeout = 0");
      // Everything is applied, so a deferred pass would only read and succeed.
      // An immediate one has to wait for this writer, which is what keeps two
      // processes opening the same file from both applying a pending migration.
      writer.exec("BEGIN IMMEDIATE");
      expect(() => runQuotaMigrations(db)).toThrow(/locked|busy/i);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
      db.close();
    }
  });
});
