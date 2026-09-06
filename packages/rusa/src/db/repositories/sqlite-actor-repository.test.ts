import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActorRecord } from "../../actor/actor-record.js";
import { HUMAN_OPERATOR } from "../../mcp/stamp.js";
import { runMigrations } from "../migrations/runner.js";
import { SqliteActorRepository } from "./sqlite-actor-repository.js";

const root: ActorRecord = {
  id: "root",
  charter: "Own the mesh",
  parentId: null,
  modelConfig: [{ provider: "codex", model: "gpt-test", effort: "high" }],
  sessionId: "session-1",
  context: { type: "native" },
  title: "Root",
  isRoot: true,
  status: "active",
  createdAt: "2026-09-03T13:00:00.000Z",
};

describe("SqliteActorRepository", () => {
  let db: Database.Database;
  let repository: SqliteActorRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    db.pragma("foreign_keys = ON");
    repository = new SqliteActorRepository(db);
  });

  it("round-trips fields through versioned config documents and normalized handles", () => {
    repository.upsert(root);
    const worker: ActorRecord = {
      id: "worker",
      charter: "Implement a slice",
      parentId: "root",
      status: "active",
      context: { type: "portable", mode: "ledger", compactionModel: "gemini-test" },
      handles: [{ id: "root", role: "parent" }],
      createdAt: "2026-09-03T13:01:00.000Z",
    };
    repository.upsert(worker);

    expect(repository.get("root")).toEqual(root);
    expect(repository.get("worker")).toEqual(worker);
    expect(repository.children("root")).toEqual([worker]);

    const rows = db
      .prepare("SELECT id, model_config, context_config FROM actors ORDER BY id")
      .all() as Array<{
      id: string;
      model_config: string | null;
      context_config: string;
    }>;
    expect(
      rows.map((row) => ({
        id: row.id,
        modelConfig: row.model_config ? JSON.parse(row.model_config) : null,
        contextConfig: JSON.parse(row.context_config),
      }))
    ).toEqual([
      {
        id: "root",
        modelConfig: {
          schemaVersion: 2,
          entries: [{ provider: "codex", model: "gpt-test", effort: "high" }],
        },
        contextConfig: { schemaVersion: 1, type: "native", sessionId: "session-1" },
      },
      {
        id: "worker",
        modelConfig: null,
        contextConfig: {
          schemaVersion: 1,
          type: "portable",
          mode: "ledger",
          compactionModel: "gemini-test",
        },
      },
    ]);
  });

  it("validates model_config versions and shape when records are consumed", () => {
    repository.upsert(root);

    for (const invalid of [
      "not-json",
      '{"provider":"codex"}',
      '{"schemaVersion":2,"provider":"codex"}',
      '{"schemaVersion":1}',
      '{"schemaVersion":1,"provider":123}',
      '{"schemaVersion":1,"provider":"codex","unknown":true}',
      '{"schemaVersion":2,"entries":[]}',
      '{"schemaVersion":2,"entries":[{"provider":"codex"}]}',
      '{"schemaVersion":2,"entries":[{"model":"gpt-test"}]}',
    ]) {
      db.prepare("UPDATE actors SET model_config = ? WHERE id = 'root'").run(invalid);
      expect(() => repository.get("root")).toThrow(/invalid model_config for actor 'root'/);
    }
  });

  it("validates context_config versions and discriminated shape when records are consumed", () => {
    repository.upsert(root);

    for (const invalid of [
      "not-json",
      '{"type":"native"}',
      '{"schemaVersion":2,"type":"native"}',
      '{"schemaVersion":1,"type":"legacy"}',
      '{"schemaVersion":1,"type":"portable"}',
      '{"schemaVersion":1,"type":"portable","mode":"tail","sessionId":"s1"}',
      '{"schemaVersion":1,"type":"native","mode":"tail"}',
    ]) {
      db.prepare("UPDATE actors SET context_config = ? WHERE id = 'root'").run(invalid);
      expect(() => repository.get("root")).toThrow(/invalid context_config for actor 'root'/);
    }
  });

  it("replaces handles atomically on upsert", () => {
    repository.upsert(root);
    repository.upsert({
      id: "worker",
      charter: "Work",
      parentId: "root",
      status: "active",
      createdAt: "2026-09-03T13:01:00.000Z",
    });
    repository.patch("worker", { handles: [{ id: "root", role: "owner" }] });
    repository.patch("worker", { handles: [], status: "retired" });

    expect(repository.get("worker")).toMatchObject({ status: "retired" });
    expect(repository.get("worker")).not.toHaveProperty("handles");
  });

  it("preserves the original retired_at across repeated upserts of an already-retired record", () => {
    repository.upsert(root);
    repository.upsert({
      id: "worker",
      charter: "Work",
      parentId: "root",
      status: "retired",
      createdAt: "2026-09-03T13:01:00.000Z",
    });
    const firstRetiredAt = (
      db.prepare("SELECT retired_at FROM actors WHERE id = 'worker'").get() as {
        retired_at: string;
      }
    ).retired_at;
    expect(firstRetiredAt).not.toBeNull();

    repository.patch("worker", { title: "Retired worker" });
    const secondRetiredAt = (
      db.prepare("SELECT retired_at FROM actors WHERE id = 'worker'").get() as {
        retired_at: string;
      }
    ).retired_at;
    expect(secondRetiredAt).toBe(firstRetiredAt);
  });

  it("derives humanUnlocked and lastChatSessionId from durable mesh_chat rows", () => {
    repository.upsert(root);
    expect(repository.get("root")).not.toHaveProperty("humanUnlocked");
    expect(repository.get("root")).not.toHaveProperty("lastChatSessionId");

    db.prepare(
      "INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("msg-1", "2026-09-03T13:05:00.000Z", HUMAN_OPERATOR, "root", "hello", "chat-1");
    db.prepare(
      "INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("msg-2", "2026-09-03T13:10:00.000Z", HUMAN_OPERATOR, "root", "again", "chat-2");

    expect(repository.get("root")).toMatchObject({
      humanUnlocked: true,
      lastChatSessionId: "chat-2",
    });
  });

  it("lists each actor with its newest durable human message", () => {
    repository.upsert(root);
    repository.upsert({
      id: "worker",
      charter: "Work",
      parentId: "root",
      status: "active",
      createdAt: "2026-09-03T13:01:00.000Z",
    });
    const insert = db.prepare(
      "INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id) VALUES (?, ?, ?, ?, ?, ?)"
    );
    insert.run("root-old", "2026-09-03T13:05:00.000Z", HUMAN_OPERATOR, "root", "old", "root-1");
    insert.run("root-new", "2026-09-03T13:10:00.000Z", HUMAN_OPERATOR, "root", "new", "root-2");
    insert.run("root-z", "2026-09-03T13:10:00.000Z", HUMAN_OPERATOR, "root", "tie", "root-3");
    insert.run("worker", "2026-09-03T13:15:00.000Z", HUMAN_OPERATOR, "worker", "hello", null);

    const byId = new Map(repository.list().map((record) => [record.id, record]));
    expect(byId.get("root")).toMatchObject({ humanUnlocked: true, lastChatSessionId: "root-3" });
    expect(byId.get("worker")).toMatchObject({ humanUnlocked: true });
    expect(byId.get("worker")).not.toHaveProperty("lastChatSessionId");
  });

  it("persists normalized records across a file-backed database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "rusa-actor-repository-"));
    const file = join(directory, "mesh.db");
    try {
      const first = new Database(file);
      runMigrations(first);
      first.pragma("foreign_keys = ON");
      const firstRepository = new SqliteActorRepository(first);
      firstRepository.upsert(root);
      firstRepository.upsert({
        id: "worker",
        charter: "Persist",
        parentId: "root",
        status: "active",
        handles: [{ id: "root", role: "parent" }],
        createdAt: "2026-09-03T13:01:00.000Z",
      });
      first.close();

      const reopened = new Database(file);
      reopened.pragma("foreign_keys = ON");
      expect(new SqliteActorRepository(reopened).get("worker")).toMatchObject({
        id: "worker",
        handles: [{ id: "root", role: "parent" }],
      });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces relational ownership invariants", () => {
    expect(() => repository.upsert({ ...root, parentId: "missing" })).toThrow();
    repository.upsert(root);
    expect(() => repository.upsert({ ...root, id: "second-root" })).toThrow();
    expect(() =>
      repository.upsert({ ...root, id: "root-with-parent", parentId: "root" })
    ).toThrow();
    expect(() =>
      db.prepare("INSERT INTO actor_handles (actor_id, target_id) VALUES ('missing', 'root')").run()
    ).toThrow();
  });

  it("refuses a parentless, non-root record", () => {
    expect(() =>
      repository.upsert({
        id: "driver",
        charter: "A/B driver stub",
        parentId: null,
        isRoot: false,
        status: "active",
        createdAt: "2026-09-03T13:00:00.000Z",
      })
    ).toThrow();
  });

  it("keeps a staged desired modelConfig pool in process memory, not the durable document", () => {
    repository.upsert(root);
    repository.patch("root", {
      desiredModelConfig: [{ provider: "claude", model: "claude-opus" }],
    });

    expect(repository.get("root")).toMatchObject({
      desiredModelConfig: [{ provider: "claude", model: "claude-opus" }],
    });
    const row = db.prepare("SELECT model_config FROM actors WHERE id = 'root'").get() as {
      model_config: string;
    };
    expect(JSON.parse(row.model_config)).toEqual({
      schemaVersion: 2,
      entries: [{ provider: "codex", model: "gpt-test", effort: "high" }],
    });
  });

  it("preserves a staged desired pool across unrelated patches and drops an explicit clear", () => {
    repository.upsert(root);
    repository.patch("root", {
      desiredModelConfig: [{ provider: "claude", model: "claude-opus" }],
    });
    repository.patch("root", { title: "Renamed" });
    expect(repository.get("root")).toMatchObject({
      desiredModelConfig: [{ provider: "claude", model: "claude-opus" }],
      title: "Renamed",
    });

    repository.patch("root", { desiredModelConfig: undefined });
    expect(repository.get("root")?.desiredModelConfig).toBeUndefined();
  });

  it("loses a staged desired pool across a repository reopen", () => {
    repository.upsert(root);
    repository.patch("root", {
      desiredModelConfig: [{ provider: "claude", model: "claude-opus" }],
    });
    expect(repository.get("root")?.desiredModelConfig).toEqual([
      { provider: "claude", model: "claude-opus" },
    ]);

    const reopened = new SqliteActorRepository(db);
    expect(reopened.get("root")?.desiredModelConfig).toBeUndefined();
  });

  it("does not advance process memory when the SQLite write rolls back", () => {
    repository.upsert(root);
    repository.patch("root", {
      desiredModelConfig: [{ provider: "claude", model: "claude-opus" }],
    });
    const worker: ActorRecord = {
      id: "worker",
      charter: "Implement a slice",
      parentId: "root",
      status: "active",
      createdAt: "2026-09-03T13:01:00.000Z",
    };
    repository.upsert(worker);
    repository.patch("worker", {
      desiredModelConfig: [{ provider: "claude", model: "claude-sonnet" }],
    });

    expect(() =>
      repository.upsert({
        ...worker,
        parentId: "missing",
        desiredModelConfig: [{ provider: "claude", model: "claude-haiku" }],
      })
    ).toThrow();
    expect(repository.get("worker")?.desiredModelConfig).toEqual([
      { provider: "claude", model: "claude-sonnet" },
    ]);
    expect(repository.get("root")?.desiredModelConfig).toEqual([
      { provider: "claude", model: "claude-opus" },
    ]);
  });

  it("migrates a pre-#169 singleton model_config document into a one-entry pool on read", () => {
    repository.upsert(root);
    db.prepare("UPDATE actors SET model_config = ? WHERE id = 'root'").run(
      JSON.stringify({ schemaVersion: 1, provider: "codex", model: "gpt-legacy", effort: "high" })
    );

    expect(repository.get("root")?.modelConfig).toEqual([
      { provider: "codex", model: "gpt-legacy", effort: "high" },
    ]);
  });

  it("round-trips a multi-entry modelConfig pool in declaration order", () => {
    const portableWorker: ActorRecord = {
      id: "worker",
      charter: "Implement a slice",
      parentId: "root",
      status: "active",
      context: { type: "portable", mode: "ledger" },
      modelConfig: [
        { provider: "claude", model: "claude-sonnet-5" },
        { provider: "kimi", model: "kimi-for-coding" },
        { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
      ],
      createdAt: "2026-09-03T13:01:00.000Z",
    };
    repository.upsert(root);
    repository.upsert(portableWorker);

    expect(repository.get("worker")?.modelConfig).toEqual(portableWorker.modelConfig);
  });
});
