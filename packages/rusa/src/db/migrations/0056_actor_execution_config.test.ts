import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteActorRepository } from "../repositories/sqlite-actor-repository.js";
import { actorExecutionConfig } from "./0056_actor_execution_config.js";
import { migrations } from "./index.js";
import { runMigrations } from "./runner.js";

/** The last migration a pre-#550 binary applies. */
const PRIOR = migrations[migrations.findIndex((m) => m.id === actorExecutionConfig.id) - 1].id;

const LEGACY_COLUMNS =
  "id, charter, parent_id, model_config, context_config, title, retired_at, created_at, voice_config";

/**
 * Synthetic actors in the shape a pre-change binary leaves: one root, a lead,
 * two remotely placed workers (one portable, one native with a session) whose
 * placement lives in a v2 `context_config`, a retired worker and a worker with
 * an unreadable context document, plus a row in each table that references
 * actors.
 */
function seedLegacy(db: Database.Database): void {
  const actor = db.prepare(
    `INSERT INTO actors (${LEGACY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  actor.run(
    "root",
    "Own the mesh",
    null,
    JSON.stringify({ schemaVersion: 2, entries: [{ provider: "codex", model: "gpt-test" }] }),
    JSON.stringify({ schemaVersion: 1, type: "native", sessionId: "session-root" }),
    "Root",
    null,
    "2026-09-01T00:00:00.000Z",
    JSON.stringify({ schemaVersion: 1, provider: "google", config: { voiceName: "Kore" } })
  );
  actor.run("lead", "Lead", "root", null, null, null, null, "2026-09-01T00:01:00.000Z", null);
  actor.run(
    "placed-portable",
    "Implement remotely",
    "lead",
    null,
    JSON.stringify({
      schemaVersion: 2,
      type: "portable",
      mode: "ledger",
      compactionModel: "gemini-test",
      executionTarget: "follower-a",
    }),
    null,
    null,
    "2026-09-01T00:02:00.000Z",
    null
  );
  actor.run(
    "placed-native",
    "Review remotely",
    "lead",
    null,
    JSON.stringify({
      schemaVersion: 2,
      type: "native",
      sessionId: "session-placed",
      executionTarget: "follower-b",
    }),
    null,
    null,
    "2026-09-01T00:03:00.000Z",
    null
  );
  actor.run(
    "retired-worker",
    "Done",
    "root",
    null,
    JSON.stringify({ schemaVersion: 1, type: "portable", mode: "tail" }),
    "Finished",
    "2026-09-02T00:00:00.000Z",
    "2026-09-01T00:04:00.000Z",
    null
  );
  actor.run(
    "corrupt-context",
    "Unreadable",
    "root",
    null,
    "{not json",
    null,
    null,
    "2026-09-01T00:05:00.000Z",
    null
  );
  actor.run(
    "invalid-v2-target",
    "Still invalid",
    "root",
    null,
    JSON.stringify({ schemaVersion: 2, type: "native", executionTarget: null }),
    null,
    null,
    "2026-09-01T00:06:00.000Z",
    null
  );

  db.exec(`
    INSERT INTO actor_handles (actor_id, target_id, role) VALUES
      ('root', 'lead', NULL), ('lead', 'root', 'parent'),
      ('lead', 'placed-portable', '__origin:message');
    INSERT INTO principals (id, kind, created_at) VALUES
      ('root', 'actor', '2026-09-01T00:00:00.000Z'),
      ('lead', 'actor', '2026-09-01T00:01:00.000Z'),
      ('placed-portable', 'actor', '2026-09-01T00:02:00.000Z'),
      ('placed-native', 'actor', '2026-09-01T00:03:00.000Z'),
      ('retired-worker', 'actor', '2026-09-01T00:04:00.000Z'),
      ('corrupt-context', 'actor', '2026-09-01T00:05:00.000Z'),
      ('invalid-v2-target', 'actor', '2026-09-01T00:06:00.000Z'),
      ('user-1', 'user', '2026-09-01T00:00:00.000Z');
    INSERT INTO users (principal_id, email, root_actor_id)
      VALUES ('user-1', 'operator@example.invalid', 'root');
    INSERT INTO capability_grants (actor_id, capability, granted_by, granted_at)
      VALUES ('lead', 'capability-admin', 'root', '2026-09-01T00:05:00.000Z');
    INSERT INTO chat_room_participants (actor_id, added_by, added_at)
      VALUES ('placed-native', 'human:operator', '2026-09-01T00:06:00.000Z');
  `);
}

/** Every table but actors, row for row, so preservation is checked without naming them. */
function otherTables(db: Database.Database): Record<string, unknown[]> {
  const names = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('actors', '_migrations')
         ORDER BY name`
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  return Object.fromEntries(
    names.map((name) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
  );
}

/** Every pre-change column but `context_config`, which the backfill may rewrite. */
function untouchedActorColumns(db: Database.Database): unknown[] {
  return db
    .prepare(
      "SELECT id, charter, parent_id, model_config, title, retired_at, created_at, voice_config FROM actors ORDER BY id"
    )
    .all();
}

function documents(
  db: Database.Database
): Record<string, { context: unknown; execution: unknown }> {
  const rows = db
    .prepare("SELECT id, context_config, execution_config FROM actors ORDER BY id")
    .all() as Array<{ id: string; context_config: string | null; execution_config: string }>;
  const parse = (json: string | null) => {
    if (json === null) return null;
    try {
      return JSON.parse(json);
    } catch {
      return json;
    }
  };
  return Object.fromEntries(
    rows.map((row) => [
      row.id,
      { context: parse(row.context_config), execution: parse(row.execution_config) },
    ])
  );
}

function actorIndexes(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'actors' AND sql IS NOT NULL ORDER BY name"
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

const EXPECTED_DOCUMENTS = {
  "corrupt-context": { context: "{not json", execution: { schemaVersion: 1, unsandboxed: false } },
  "invalid-v2-target": {
    context: { schemaVersion: 2, type: "native", executionTarget: null },
    execution: { schemaVersion: 1, unsandboxed: false },
  },
  lead: { context: null, execution: { schemaVersion: 1, unsandboxed: false } },
  "placed-native": {
    context: { schemaVersion: 1, type: "native", sessionId: "session-placed" },
    execution: { schemaVersion: 1, unsandboxed: false, executionTarget: "follower-b" },
  },
  "placed-portable": {
    context: { schemaVersion: 1, type: "portable", mode: "ledger", compactionModel: "gemini-test" },
    execution: { schemaVersion: 1, unsandboxed: false, executionTarget: "follower-a" },
  },
  "retired-worker": {
    context: { schemaVersion: 1, type: "portable", mode: "tail" },
    execution: { schemaVersion: 1, unsandboxed: false },
  },
  root: {
    context: { schemaVersion: 1, type: "native", sessionId: "session-root" },
    execution: { schemaVersion: 1, unsandboxed: true },
  },
};

describe("0056_actor_execution_config", () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rusa-0056-"));
    file = join(directory, "mesh.db");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("adds a plain execution_config column, without a rebuild or validator", () => {
    const db = new Database(":memory:");
    runMigrations(db, { throughId: PRIOR });
    const tableSqlBefore = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'actors'").get() as { sql: string }
    ).sql;
    runMigrations(db, { throughId: actorExecutionConfig.id });

    const column = (
      db.prepare("PRAGMA table_info(actors)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
      }>
    ).find((info) => info.name === "execution_config");
    expect(column).toEqual(expect.objectContaining({ type: "TEXT", notnull: 0, dflt_value: null }));
    // ALTER TABLE appends the column to the original definition; nothing else changes.
    const tableSqlAfter = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'actors'").get() as { sql: string }
    ).sql;
    expect(tableSqlAfter.replace(/,\s*execution_config TEXT\s*\)$/, ")")).toBe(tableSqlBefore);
    expect(tableSqlAfter).not.toMatch(/CHECK|json_/i);
    expect(actorIndexes(db)).toEqual(["actors_parent_id_idx", "actors_retired_at_idx"]);
    db.close();
  });

  it("copies placement out of context_config and backfills unsandboxed once, preserving the rest", () => {
    const db = new Database(file);
    db.pragma("foreign_keys = ON");
    runMigrations(db, { throughId: PRIOR });
    seedLegacy(db);
    expect(actorIndexes(db)).toContain("actors_single_root_idx");
    const actorsBefore = untouchedActorColumns(db);
    const othersBefore = otherTables(db);

    runMigrations(db, { throughId: actorExecutionConfig.id });

    expect(documents(db)).toEqual(EXPECTED_DOCUMENTS);
    expect(untouchedActorColumns(db)).toEqual(actorsBefore);
    expect(otherTables(db)).toEqual(othersBefore);
    expect(actorIndexes(db)).toEqual(["actors_parent_id_idx", "actors_retired_at_idx"]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);

    db.close();
  });

  it("rehearses on a copy of a pre-change database, leaving the original as it was", () => {
    const original = new Database(file);
    runMigrations(original, { throughId: PRIOR });
    seedLegacy(original);
    original.close();
    const copy = join(directory, "mesh-copy.db");
    copyFileSync(file, copy);

    const rehearsal = new Database(copy);
    rehearsal.pragma("foreign_keys = ON");
    runMigrations(rehearsal);
    rehearsal.close();

    // Reopen as a fresh process would and read through the repository.
    const reopened = new Database(copy);
    reopened.pragma("foreign_keys = ON");
    runMigrations(reopened);
    const actors = new SqliteActorRepository(reopened);
    // An unreadable context document still fails closed, as it did before.
    expect(() => actors.get("corrupt-context")).toThrow(
      "invalid context_config for actor 'corrupt-context'"
    );
    // A present but invalid v2 target stays invalid rather than becoming a
    // leader-local actor during the version transition.
    expect(() => actors.get("invalid-v2-target")).toThrow(
      "invalid context_config for actor 'invalid-v2-target'"
    );
    expect(
      ["root", "lead", "placed-portable", "placed-native", "retired-worker"].map((id) => {
        const { parentId, executionConfig, status } = actors.get(id) ?? {};
        return { id, parentId, executionConfig, status };
      })
    ).toEqual([
      { id: "root", parentId: null, executionConfig: { unsandboxed: true }, status: "active" },
      { id: "lead", parentId: "root", executionConfig: undefined, status: "active" },
      {
        id: "placed-portable",
        parentId: "lead",
        executionConfig: { executionTarget: "follower-a" },
        status: "active",
      },
      {
        id: "placed-native",
        parentId: "lead",
        executionConfig: { executionTarget: "follower-b" },
        status: "active",
      },
      { id: "retired-worker", parentId: "root", executionConfig: undefined, status: "retired" },
    ]);
    expect(actors.get("placed-portable")?.context).toEqual({
      type: "portable",
      mode: "ledger",
      compactionModel: "gemini-test",
    });
    expect(actors.get("placed-native")).toMatchObject({
      context: { type: "native" },
      sessionId: "session-placed",
    });
    expect(actors.get("root")).toMatchObject({
      modelConfig: [{ provider: "codex", model: "gpt-test" }],
      sessionId: "session-root",
      title: "Root",
      handles: [{ id: "lead" }],
    });
    expect(actors.get("lead")?.handles).toEqual([
      { id: "placed-portable", origin: "message" },
      { id: "root", role: "parent" },
    ]);
    reopened.close();
  });

  it("fails the read of rows a pre-change binary writes afterwards (the rollback limit)", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const actors = new SqliteActorRepository(db);

    // The INSERT a binary from before 0056 issues names no execution_config.
    db.prepare(
      `INSERT INTO actors (id, charter, parent_id, model_config, context_config, voice_config, title, retired_at, created_at)
       VALUES ('inserted-by-old', 'c', NULL, NULL, NULL, NULL, NULL, NULL, '2026-09-03T00:00:00.000Z')`
    ).run();
    expect(() => actors.get("inserted-by-old")).toThrow(
      "missing execution_config for actor 'inserted-by-old'"
    );

    // A placement the old binary records is a v2 context_config, which is no longer read.
    db.prepare(
      `UPDATE actors SET execution_config = '{"schemaVersion":1,"unsandboxed":true}',
         context_config = '{"schemaVersion":2,"type":"native","executionTarget":"follower-a"}'
       WHERE id = 'inserted-by-old'`
    ).run();
    expect(() => actors.get("inserted-by-old")).toThrow(
      "invalid context_config for actor 'inserted-by-old'"
    );
    db.close();
  });
});
