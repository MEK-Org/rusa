import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { MODEL_CLASS_DEFINITION_VERSION, ModelClassRepository } from "./model-class-repository.js";

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
});
