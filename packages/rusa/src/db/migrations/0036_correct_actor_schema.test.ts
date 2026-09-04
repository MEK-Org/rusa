import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrations } from "./index.js";

function applyThrough(db: Database.Database, lastId: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const idx = migrations.findIndex((m) => m.id === lastId);
  if (idx === -1) throw new Error(`Could not find migration ${lastId}`);
  for (const migration of migrations.slice(0, idx + 1)) {
    if (migration.noTransaction) {
      migration.up(db);
    } else {
      db.transaction(() => migration.up(db))();
    }
    db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);
  }
}

function apply0036(db: Database.Database): void {
  const migration = migrations.find((m) => m.id === "0036_correct_actor_schema");
  if (!migration) throw new Error("Could not find 0036 migration");
  migration.up(db);
  db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);
}

describe("0036_correct_actor_schema", () => {
  it("folds a populated 0034 actor_threads table onto the corrected actors shape", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyThrough(db, "0035_recurring_obligations");

    db.prepare(
      `INSERT INTO actor_threads (
        id, charter, parent_id, provider, model, effort,
        desired_provider, desired_model, desired_effort, desired_effort_is_set,
        session_id, context_type, context_mode, context_compaction_model,
        title, is_root, status, budget_max_runs, budget_runs_used,
        human_unlocked, last_chat_session_id, created_at
      ) VALUES (
        'root', 'Own the mesh', NULL, 'codex', 'gpt-test', 'high',
        'next-provider', 'next-model', NULL, 0,
        'session-1', 'native', NULL, NULL,
        'Root', 1, 'active', 10, 2,
        1, 'chat-1', '2026-09-03T13:00:00.000Z'
      )`
    ).run();
    db.prepare(
      `INSERT INTO actor_threads (
        id, charter, parent_id, provider, model, effort,
        desired_provider, desired_model, desired_effort, desired_effort_is_set,
        session_id, context_type, context_mode, context_compaction_model,
        title, is_root, status, budget_max_runs, budget_runs_used,
        human_unlocked, last_chat_session_id, created_at
      ) VALUES (
        'worker', 'Implement a slice', 'root', NULL, NULL, NULL,
        NULL, NULL, NULL, 0,
        'stale-session', 'portable', 'ledger', 'gemini-test',
        NULL, 0, 'retired', NULL, NULL,
        0, NULL, '2026-09-03T13:01:00.000Z'
      )`
    ).run();
    db.prepare(
      "INSERT INTO actor_handles (actor_id, target_id, role) VALUES ('worker', 'root', 'parent')"
    ).run();

    apply0036(db);

    const tables = new Set(
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    );
    expect(tables.has("actors")).toBe(true);
    expect(tables.has("actor_threads")).toBe(false);
    expect(tables.has("actor_pending_deliveries")).toBe(false);

    const root = db.prepare("SELECT * FROM actors WHERE id = 'root'").get() as {
      model_config: string;
      context_config: string;
      retired_at: string | null;
    };
    expect(JSON.parse(root.model_config)).toEqual({
      provider: "codex",
      model: "gpt-test",
      effort: "high",
    });
    expect(JSON.parse(root.context_config)).toEqual({
      type: "native",
      sessionId: "session-1",
    });
    expect(root.retired_at).toBeNull();

    const worker = db.prepare("SELECT * FROM actors WHERE id = 'worker'").get() as {
      model_config: string | null;
      context_config: string;
      retired_at: string | null;
    };
    expect(worker.model_config).toBeNull();
    // worker's stale native session id (a legacy leftover from before it moved to
    // portable context) must not be carried into the portable context_config.
    expect(JSON.parse(worker.context_config)).toEqual({
      type: "portable",
      mode: "ledger",
      compactionModel: "gemini-test",
    });
    expect(worker.retired_at).not.toBeNull();

    const handle = db
      .prepare("SELECT actor_id, target_id, role FROM actor_handles WHERE actor_id = 'worker'")
      .get();
    expect(handle).toEqual({ actor_id: "worker", target_id: "root", role: "parent" });
  });

  it("refuses to migrate while actor_pending_deliveries holds rows, rather than silently dropping them", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyThrough(db, "0035_recurring_obligations");
    db.prepare(
      `INSERT INTO actor_threads (id, charter, parent_id, is_root, status, created_at)
       VALUES ('root', 'Own the mesh', NULL, 1, 'active', '2026-09-03T13:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO actor_pending_deliveries (id, actor_id, from_id, body, deliver_at, session_id)
       VALUES ('d1', 'root', 'root', 'wake', '2026-09-03T14:00:00.000Z', NULL)`
    ).run();

    expect(() => apply0036(db)).toThrow(/actor_pending_deliveries holds 1 row/);

    // The refusal must not have torn down anything: both source tables survive intact.
    const tables = new Set(
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    );
    expect(tables.has("actor_threads")).toBe(true);
    expect(tables.has("actor_pending_deliveries")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) as n FROM actor_pending_deliveries").get()).toEqual({
      n: 1,
    });
  });

  it("enforces at most one parentless row via the single-root partial index", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyThrough(db, "0035_recurring_obligations");
    db.prepare(
      `INSERT INTO actor_threads (id, charter, parent_id, is_root, status, created_at)
       VALUES ('root', 'Own the mesh', NULL, 1, 'active', '2026-09-03T13:00:00.000Z')`
    ).run();
    apply0036(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO actors (id, charter, parent_id, created_at) VALUES ('second', 'x', NULL, '2026-09-03T13:00:00.000Z')`
        )
        .run()
    ).toThrow();
  });

  it("rejects a JSON column that is not valid JSON", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyThrough(db, "0036_correct_actor_schema");

    expect(() =>
      db
        .prepare(
          `INSERT INTO actors (id, charter, parent_id, model_config, created_at)
           VALUES ('root', 'Own the mesh', NULL, 'not-json', '2026-09-03T13:00:00.000Z')`
        )
        .run()
    ).toThrow();
  });

  it("rejects well-formed JSON that is not an object, for both model_config and context_config", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyThrough(db, "0036_correct_actor_schema");

    const nonObjectJsonValues = ["[1,2,3]", "123", '"a string"', "true", "null"];
    let n = 0;
    for (const value of nonObjectJsonValues) {
      n += 1;
      expect(() =>
        db
          .prepare(
            `INSERT INTO actors (id, charter, parent_id, model_config, created_at)
             VALUES (?, 'Own the mesh', NULL, ?, '2026-09-03T13:00:00.000Z')`
          )
          .run(`model-${n}`, value)
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO actors (id, charter, parent_id, context_config, created_at)
             VALUES (?, 'Own the mesh', NULL, ?, '2026-09-03T13:00:00.000Z')`
          )
          .run(`context-${n}`, value)
      ).toThrow(/CHECK constraint failed/);
    }

    expect(() =>
      db
        .prepare(
          `INSERT INTO actors (id, charter, parent_id, model_config, context_config, created_at)
           VALUES ('valid', 'Own the mesh', NULL, '{"provider":"codex"}', '{"type":"native"}', '2026-09-03T13:00:00.000Z')`
        )
        .run()
    ).not.toThrow();
  });

  it("enforces the context_config discriminated shape: a known type, and no sessionId on a portable one", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyThrough(db, "0036_correct_actor_schema");

    // A real (parented) row, since the single-root partial index caps NULL parent_id to one
    // row and this test only cares about context_config, not root topology.
    db.prepare(
      `INSERT INTO actors (id, charter, parent_id, created_at) VALUES ('root', 'Own the mesh', NULL, '2026-09-03T13:00:00.000Z')`
    ).run();
    const insertContext = (id: string, contextConfig: string) =>
      db
        .prepare(
          `INSERT INTO actors (id, charter, parent_id, context_config, created_at)
           VALUES (?, 'Own the mesh', 'root', ?, '2026-09-03T13:00:00.000Z')`
        )
        .run(id, contextConfig);

    expect(() => insertContext("no-type", '{"sessionId":"s1"}')).toThrow(/CHECK constraint failed/);
    expect(() => insertContext("bad-type", '{"type":"legacy"}')).toThrow(/CHECK constraint failed/);
    expect(() =>
      insertContext("portable-with-session", '{"type":"portable","mode":"tail","sessionId":"s1"}')
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      insertContext("native-with-session", '{"type":"native","sessionId":"s1"}')
    ).not.toThrow();
    expect(() =>
      insertContext("portable-no-session", '{"type":"portable","mode":"tail"}')
    ).not.toThrow();
  });

  it("enforces the model_config discriminated shape: at least one known key, and text-typed when present", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyThrough(db, "0036_correct_actor_schema");

    db.prepare(
      `INSERT INTO actors (id, charter, parent_id, created_at) VALUES ('root', 'Own the mesh', NULL, '2026-09-03T13:00:00.000Z')`
    ).run();
    const insertModel = (id: string, modelConfig: string) =>
      db
        .prepare(
          `INSERT INTO actors (id, charter, parent_id, model_config, created_at)
           VALUES (?, 'Own the mesh', 'root', ?, '2026-09-03T13:00:00.000Z')`
        )
        .run(id, modelConfig);

    // A generic object with none of the known keys must not slip in as a model_config.
    expect(() => insertModel("generic", '{"foo":1}')).toThrow(/CHECK constraint failed/);
    expect(() => insertModel("empty", "{}")).toThrow(/CHECK constraint failed/);
    // Present known keys must be text, not some other JSON type.
    expect(() => insertModel("bad-provider-type", '{"provider":123}')).toThrow(
      /CHECK constraint failed/
    );
    expect(() => insertModel("bad-effort-type", '{"effort":true}')).toThrow(
      /CHECK constraint failed/
    );

    expect(() => insertModel("provider-only", '{"provider":"codex"}')).not.toThrow();
    expect(() =>
      insertModel("full", '{"provider":"codex","model":"gpt-5","effort":"high"}')
    ).not.toThrow();
  });

  it("refuses to migrate a parentless, non-root actor rather than silently granting it root authority", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyThrough(db, "0035_recurring_obligations");
    db.prepare(
      `INSERT INTO actor_threads (id, charter, parent_id, is_root, status, created_at)
       VALUES ('ab-rig-holder', 'A/B driver stub', NULL, 0, 'active', '2026-09-03T13:00:00.000Z')`
    ).run();

    expect(() => apply0036(db)).toThrow(/parentless, non-root/);
  });

  it("produces the same actors schema via a fresh full chain and via an upgraded 0034 database", () => {
    const fresh = new Database(":memory:");
    fresh.pragma("foreign_keys = ON");
    applyThrough(fresh, "0036_correct_actor_schema");
    const freshColumns = ((db) => db.prepare("PRAGMA table_info(actors)").all())(fresh) as Array<{
      name: string;
    }>;

    const upgraded = new Database(":memory:");
    upgraded.pragma("foreign_keys = ON");
    applyThrough(upgraded, "0035_recurring_obligations");
    apply0036(upgraded);
    const upgradedColumns = upgraded.prepare("PRAGMA table_info(actors)").all() as Array<{
      name: string;
    }>;

    expect(upgradedColumns.map((c) => c.name).sort()).toEqual(
      freshColumns.map((c) => c.name).sort()
    );
  });

  it("keeps the schema transform and the migration marker atomic: a crash after the transform but before the marker rolls everything back, and a rerun then succeeds", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyThrough(db, "0035_recurring_obligations");
    db.prepare(
      `INSERT INTO actor_threads (id, charter, parent_id, is_root, status, created_at)
       VALUES ('root', 'Own the mesh', NULL, 1, 'active', '2026-09-03T13:00:00.000Z')`
    ).run();

    const migration = migrations.find((m) => m.id === "0036_correct_actor_schema");
    if (!migration) throw new Error("Could not find 0036 migration");

    // Simulate the runner crashing between the schema transform and the
    // `_migrations` marker insert by pre-occupying that primary key, so the
    // insert the runner performs inside the same transaction fails.
    db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);

    const runAsRunnerWould = () =>
      db.transaction(() => {
        migration.up(db);
        db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);
      })();

    expect(runAsRunnerWould).toThrow();

    const tablesAfterCrash = new Set(
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    );
    expect(tablesAfterCrash.has("actors")).toBe(false);
    expect(tablesAfterCrash.has("actor_threads")).toBe(true);
    expect(db.prepare("SELECT * FROM actor_threads WHERE id = 'root'").get()).toBeTruthy();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

    // Clear the pre-occupied marker (the injected stand-in for the crash) and
    // rerun exactly as the runner would; it should now succeed cleanly.
    db.prepare("DELETE FROM _migrations WHERE id = ?").run(migration.id);
    expect(runAsRunnerWould).not.toThrow();

    const tablesAfterRerun = new Set(
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    );
    expect(tablesAfterRerun.has("actors")).toBe(true);
    expect(tablesAfterRerun.has("actor_threads")).toBe(false);
    expect(db.prepare("SELECT id FROM _migrations WHERE id = ?").get(migration.id)).toBeTruthy();
  });
});
