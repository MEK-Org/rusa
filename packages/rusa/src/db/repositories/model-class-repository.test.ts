import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import {
  MODEL_CLASS_DEFINITION_VERSION,
  ModelClassInUseError,
  ModelClassRepository,
} from "./model-class-repository.js";

describe("ModelClassRepository", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("persists a versioned ordered definition across a database reopen", () => {
    const home = mkdtempSync(join(tmpdir(), "rusa-model-class-"));
    paths.push(home);
    const path = join(home, "mesh.db");
    const first = new Database(path);
    runMigrations(first);
    const store = new ModelClassRepository(first);
    store.upsert(
      "review",
      [
        { provider: "claude", model: "claude-opus-4-8", effort: "max" },
        { provider: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
      ],
      "2026-09-07T10:00:00.000Z"
    );
    const raw = first
      .prepare("SELECT definition_json FROM model_classes WHERE name = ?")
      .get("review") as { definition_json: string };
    expect(JSON.parse(raw.definition_json)).toEqual({
      version: MODEL_CLASS_DEFINITION_VERSION,
      modelConfig: [
        { provider: "claude", model: "claude-opus-4-8", effort: "max" },
        { provider: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
      ],
    });
    first.close();

    const reopened = new Database(path);
    const persisted = new ModelClassRepository(reopened).get("review");
    expect(persisted?.modelConfig).toEqual([
      { provider: "claude", model: "claude-opus-4-8", effort: "max" },
      { provider: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
    ]);
    reopened.close();
  });

  it("fails closed when a manually-corrupt blob has no supported version", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.prepare(
      "INSERT INTO model_classes (name, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(
      "bad",
      JSON.stringify({ version: 999, modelConfig: [{ provider: "claude", model: "x" }] }),
      "2026-09-07T10:00:00.000Z",
      "2026-09-07T10:00:00.000Z"
    );
    expect(() => new ModelClassRepository(db).get("bad")).toThrow(/unsupported version/);
    db.close();
  });

  it("creates an opaque SQL table with no json functions or CHECK validator", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_classes'")
      .get() as { sql: string };
    expect(row.sql).not.toMatch(/json_/i);
    expect(row.sql).not.toMatch(/\bcheck\b/i);
    db.close();
  });

  function seedRoot(db: Database.Database) {
    db.prepare(
      "INSERT INTO actors (id, charter, parent_id, created_at) VALUES ('root', 'root', NULL, '2026-09-07T10:00:00.000Z')"
    ).run();
  }

  it("refuses deletion when a live actor is bound by class reference (v4 and v3)", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    seedRoot(db);
    const store = new ModelClassRepository(db);
    store.upsert(
      "review",
      [{ provider: "claude", model: "claude-opus-4-8" }],
      "2026-09-07T10:00:00.000Z"
    );

    // Live actor referencing via v4 document
    db.prepare(
      `INSERT INTO actors (id, charter, parent_id, model_config, retired_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      "worker-v4",
      "test",
      "root",
      JSON.stringify({ schemaVersion: 4, modelClass: "review" }),
      null,
      "2026-09-07T10:00:00.000Z"
    );

    try {
      store.delete("review");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelClassInUseError);
      const inUseErr = err as ModelClassInUseError;
      expect(inUseErr.className).toBe("review");
      expect(inUseErr.referencingActors).toEqual(["worker-v4"]);
      expect(inUseErr.message).toContain("referenced by live actor(s): worker-v4");
    }

    // Also verify v3 document binding
    db.prepare(
      `INSERT INTO actors (id, charter, parent_id, model_config, retired_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      "worker-v3",
      "test",
      "root",
      JSON.stringify({
        schemaVersion: 3,
        entries: [{ provider: "claude", model: "claude-opus-4-8" }],
        modelClass: "review",
      }),
      null,
      "2026-09-07T10:00:00.000Z"
    );

    try {
      store.delete("review");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelClassInUseError);
      const inUseErr = err as ModelClassInUseError;
      expect(inUseErr.referencingActors).toEqual(["worker-v3", "worker-v4"]);
    }

    // Class still exists
    expect(store.get("review")).toBeDefined();
    db.close();
  });

  it("allows deletion when referencing actors are retired", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    seedRoot(db);
    const store = new ModelClassRepository(db);
    store.upsert(
      "review",
      [{ provider: "claude", model: "claude-opus-4-8" }],
      "2026-09-07T10:00:00.000Z"
    );

    // Actor is retired (retired_at is non-null)
    db.prepare(
      `INSERT INTO actors (id, charter, parent_id, model_config, retired_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      "worker-retired",
      "test",
      "root",
      JSON.stringify({ schemaVersion: 4, modelClass: "review" }),
      "2026-09-07T11:00:00.000Z",
      "2026-09-07T10:00:00.000Z"
    );

    expect(store.delete("review")).toBe(true);
    expect(store.get("review")).toBeUndefined();
    db.close();
  });

  it("allows deletion when actors have explicit pools or no class reference", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    seedRoot(db);
    const store = new ModelClassRepository(db);
    store.upsert(
      "review",
      [{ provider: "claude", model: "claude-opus-4-8" }],
      "2026-09-07T10:00:00.000Z"
    );

    // Actor with explicit v2 pool
    db.prepare(
      `INSERT INTO actors (id, charter, parent_id, model_config, retired_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      "worker-explicit",
      "test",
      "root",
      JSON.stringify({
        schemaVersion: 2,
        entries: [{ provider: "claude", model: "claude-opus-4-8" }],
      }),
      null,
      "2026-09-07T10:00:00.000Z"
    );

    expect(store.delete("review")).toBe(true);
    expect(store.get("review")).toBeUndefined();
    db.close();
  });

  it("returns false when deleting a nonexistent class without querying actors", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const store = new ModelClassRepository(db);
    expect(store.delete("nonexistent")).toBe(false);
    db.close();
  });

  it("referencingActors returns sorted IDs of live actors bound to the class", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    seedRoot(db);
    const store = new ModelClassRepository(db);

    const insert = db.prepare(
      `INSERT INTO actors (id, charter, parent_id, model_config, retired_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      "worker-z",
      "test",
      "root",
      JSON.stringify({ schemaVersion: 4, modelClass: "fast" }),
      null,
      "2026-09-07T10:00:00.000Z"
    );
    insert.run(
      "worker-a",
      "test",
      "root",
      JSON.stringify({ schemaVersion: 4, modelClass: "fast" }),
      null,
      "2026-09-07T10:00:00.000Z"
    );
    insert.run(
      "worker-other",
      "test",
      "root",
      JSON.stringify({ schemaVersion: 4, modelClass: "slow" }),
      null,
      "2026-09-07T10:00:00.000Z"
    );
    insert.run(
      "worker-retired",
      "test",
      "root",
      JSON.stringify({ schemaVersion: 4, modelClass: "fast" }),
      "2026-09-07T11:00:00.000Z",
      "2026-09-07T10:00:00.000Z"
    );

    expect(store.referencingActors("fast")).toEqual(["worker-a", "worker-z"]);
    expect(store.referencingActors("slow")).toEqual(["worker-other"]);
    expect(store.referencingActors("none")).toEqual([]);
    db.close();
  });
});
