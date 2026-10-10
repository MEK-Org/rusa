import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorRecord } from "../../actor/actor-record.js";
import { resolveHandleLabels } from "../../actor/worker-prompt.js";

import { runMigrations } from "../migrations/runner.js";
import { ModelClassRepository } from "./model-class-repository.js";
import { PrincipalRepository } from "./principal-repository.js";
import { SqliteActorRepository } from "./sqlite-actor-repository.js";

const root: ActorRecord = {
  id: "root",
  charter: "Own the mesh",
  parentId: null,
  modelConfig: [{ provider: "codex", model: "gpt-test", effort: "high" }],
  sessionId: "session-1",
  context: { type: "native" },
  title: "Root",
  executionConfig: { unsandboxed: true },
  status: "active",
  createdAt: "2026-09-03T13:00:00.000Z",
};

const NOW = "2026-09-22T00:00:00.000Z";

describe("SqliteActorRepository", () => {
  let db: Database.Database;
  let repository: SqliteActorRepository;
  let classes: ModelClassRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    db.pragma("foreign_keys = ON");
    classes = new ModelClassRepository(db);
    repository = new SqliteActorRepository(db);
  });

  const storedModelConfig = (id: string): string =>
    (
      db.prepare("SELECT model_config FROM actors WHERE id = ?").get(id) as {
        model_config: string;
      }
    ).model_config;

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

  it("persists a class-bound actor as a v4 reference and resolves its pool on every read", () => {
    classes.upsert("fast", [{ provider: "codex", model: "gpt-fast", effort: "low" }], NOW);
    repository.upsert({ ...root, modelClass: "fast" });

    // The resolved pool is a read-time projection of the class row, not the
    // pool that happened to be on the record at write time.
    expect(repository.get("root")).toEqual({
      ...root,
      modelClass: "fast",
      modelConfig: [{ provider: "codex", model: "gpt-fast", effort: "low" }],
    });
    const row = db.prepare("SELECT model_config FROM actors WHERE id = 'root'").get() as {
      model_config: string;
    };
    expect(JSON.parse(row.model_config)).toEqual({ schemaVersion: 4, modelClass: "fast" });

    // #626: editing the class reaches the actor with no rewrite of the actor row.
    classes.upsert("fast", [{ provider: "claude", model: "claude-swift" }], NOW);
    expect(repository.get("root")?.modelConfig).toEqual([
      { provider: "claude", model: "claude-swift" },
    ]);
    expect(repository.get("root")?.modelClassError).toBeUndefined();
    expect(
      (
        db.prepare("SELECT model_config FROM actors WHERE id = 'root'").get() as
          | { model_config: string }
          | undefined
      )?.model_config
    ).toBe(JSON.stringify({ schemaVersion: 4, modelClass: "fast" }));
  });

  it("resolves the live class through list and children as well as get", () => {
    classes.upsert("fast", [{ provider: "codex", model: "gpt-fast" }], NOW);
    repository.upsert(root);
    repository.upsert({
      id: "worker",
      charter: "Implement a slice",
      parentId: "root",
      modelClass: "fast",
      status: "active",
      createdAt: "2026-09-03T13:01:00.000Z",
    });

    classes.upsert("fast", [{ provider: "codex", model: "gpt-faster" }], NOW);
    const expected = [{ provider: "codex", model: "gpt-faster" }];
    expect(repository.children("root")[0]?.modelConfig).toEqual(expected);
    expect(repository.list().find((a) => a.id === "worker")?.modelConfig).toEqual(expected);
  });

  it("leaves an explicitly declared pool untouched by model class edits", () => {
    classes.upsert("fast", [{ provider: "codex", model: "gpt-fast" }], NOW);
    repository.upsert(root);

    classes.upsert("fast", [{ provider: "claude", model: "claude-swift" }], NOW);
    expect(repository.get("root")).toEqual(root);
  });

  it("surfaces an unresolvable class as a per-actor error rather than a failed read", () => {
    classes.upsert("fast", [{ provider: "codex", model: "gpt-fast" }], NOW);
    repository.upsert(root);
    repository.upsert({
      id: "worker",
      charter: "Implement a slice",
      parentId: "root",
      modelClass: "fast",
      status: "active",
      createdAt: "2026-09-03T13:01:00.000Z",
    });
    classes.delete("fast");

    const broken = repository.get("worker");
    expect(broken?.modelClass).toBe("fast");
    expect(broken?.modelConfig).toBeUndefined();
    expect(broken?.modelClassError).toMatch(/unknown model class "fast"/);
    // One broken binding must not take the whole listing down with it.
    expect(repository.get("root")).toEqual(root);
    expect(
      repository
        .list()
        .map((a) => a.id)
        .sort()
    ).toEqual(["root", "worker"]);
  });

  it("contains corrupt model-class definitions to the bound actor", () => {
    repository.upsert(root);
    repository.upsert({
      id: "broken",
      charter: "Broken class binding",
      parentId: "root",
      modelClass: "broken-class",
      status: "active",
      createdAt: "2026-09-03T13:01:00.000Z",
    });
    repository.upsert({
      id: "missing",
      charter: "Missing class binding",
      parentId: "root",
      modelClass: "missing-class",
      status: "active",
      createdAt: "2026-09-03T13:02:00.000Z",
    });
    classes.upsert("broken-class", [{ provider: "codex", model: "gpt-fast" }], NOW);
    db.prepare("UPDATE model_classes SET definition_json = ? WHERE name = 'broken-class'").run(
      "not-json"
    );

    // A corrupt referenced row and an unrelated corrupt row must both be
    // reported on the individual binding; neither may make the actor list fail.
    expect(repository.get("broken")?.modelClassError).toMatch(/broken-class.*invalid/i);
    expect(repository.get("missing")?.modelClassError).toMatch(
      /unknown model class "missing-class"/
    );
    expect(
      repository
        .list()
        .map((actor) => actor.id)
        .sort()
    ).toEqual(["broken", "missing", "root"]);
  });

  it("ignores the duplicated pool on an existing v3 row without converting it", () => {
    classes.upsert("fast", [{ provider: "claude", model: "claude-swift" }], NOW);
    repository.upsert(root);
    const v3 = JSON.stringify({
      schemaVersion: 3,
      entries: [{ provider: "codex", model: "gpt-stale", effort: "high" }],
      modelClass: "fast",
    });
    db.prepare("UPDATE actors SET model_config = ? WHERE id = 'root'").run(v3);

    // Read-through wins over the stale copy without any boot sweep.
    expect(repository.get("root")?.modelConfig).toEqual([
      { provider: "claude", model: "claude-swift" },
    ]);

    // An incidental write touches unrelated columns and must leave the stored
    // document exactly as it found it, so a row never acquires a v4 encoding
    // an older binary cannot read as a side effect of ordinary traffic (#626).
    repository.patch("root", { title: "Renamed" });
    repository.patch("root", { sessionId: "session-1" });
    repository.patch("root", { charter: "Rewritten charter" });
    expect(storedModelConfig("root")).toBe(v3);
    expect(repository.get("root")?.title).toBe("Renamed");
    expect(repository.get("root")?.modelConfig).toEqual([
      { provider: "claude", model: "claude-swift" },
    ]);
  });

  it("converts a v3 row to a v4 reference only on an explicit model-configuration change", () => {
    classes.upsert("fast", [{ provider: "claude", model: "claude-swift" }], NOW);
    classes.upsert("slow", [{ provider: "codex", model: "gpt-deep", effort: "high" }], NOW);
    repository.upsert(root);
    db.prepare("UPDATE actors SET model_config = ? WHERE id = 'root'").run(
      JSON.stringify({
        schemaVersion: 3,
        entries: [{ provider: "codex", model: "gpt-stale", effort: "high" }],
        modelClass: "fast",
      })
    );

    // Re-selecting the same class is still a deliberate selection, so it
    // restates the document in the current shape.
    repository.setModelSelection("root", { modelClass: "fast" });
    expect(JSON.parse(storedModelConfig("root"))).toEqual({ schemaVersion: 4, modelClass: "fast" });

    // A rebind onto a different class writes the new reference.
    repository.setModelSelection("root", { modelClass: "slow" });
    expect(JSON.parse(storedModelConfig("root"))).toEqual({ schemaVersion: 4, modelClass: "slow" });
    expect(repository.get("root")?.modelConfig).toEqual([
      { provider: "codex", model: "gpt-deep", effort: "high" },
    ]);

    // Replacing the binding with an explicit pool drops the reference entirely.
    repository.setModelSelection("root", {
      modelClass: undefined,
      modelConfig: [{ provider: "claude", model: "claude-pinned" }],
    });
    expect(JSON.parse(storedModelConfig("root"))).toEqual({
      schemaVersion: 2,
      entries: [{ provider: "claude", model: "claude-pinned" }],
    });
    // A later class edit no longer reaches the actor.
    classes.upsert("slow", [{ provider: "codex", model: "gpt-deeper" }], NOW);
    expect(repository.get("root")?.modelConfig).toEqual([
      { provider: "claude", model: "claude-pinned" },
    ]);
  });

  it("refuses to silently drop an explicit model selection for a missing row", () => {
    expect(() => repository.setModelSelection("missing", { modelClass: "fast" })).toThrow(
      /cannot set model selection on unknown actor 'missing'/
    );
  });

  it("rejects a malformed v4 class reference at the consumption boundary", () => {
    repository.upsert(root);

    for (const invalid of [
      '{"schemaVersion":4}',
      '{"schemaVersion":4,"modelClass":""}',
      '{"schemaVersion":4,"modelClass":"fast","entries":[]}',
      '{"schemaVersion":4,"modelClass":123}',
    ]) {
      db.prepare("UPDATE actors SET model_config = ? WHERE id = 'root'").run(invalid);
      expect(() => repository.get("root")).toThrow(/invalid model_config for actor 'root'/);
    }
  });

  it("continues to read strict v2 pools without class provenance", () => {
    repository.upsert(root);
    db.prepare("UPDATE actors SET model_config = ? WHERE id = 'root'").run(
      JSON.stringify({
        schemaVersion: 2,
        entries: [{ provider: "codex", model: "gpt-v2", effort: "medium" }],
      })
    );

    expect(repository.get("root")).toMatchObject({
      modelConfig: [{ provider: "codex", model: "gpt-v2", effort: "medium" }],
    });
    expect(repository.get("root")?.modelClass).toBeUndefined();
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
      '{"schemaVersion":2,"entries":[{"provider":"codex","model":"gpt-test"}],"modelClass":"fast"}',
      '{"schemaVersion":3,"entries":[{"provider":"codex","model":"gpt-test"}]}',
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
      '{"schemaVersion":3,"type":"native"}',
      '{"schemaVersion":1,"type":"legacy"}',
      '{"schemaVersion":1,"type":"portable"}',
      '{"schemaVersion":1,"type":"portable","mode":"tail","sessionId":"s1"}',
      '{"schemaVersion":1,"type":"native","mode":"tail"}',
      '{"schemaVersion":1,"type":"native","executionTarget":"mac-mini"}',
      '{"schemaVersion":2,"type":"native","unknown":true}',
      // v2 carried the placement until 0056 moved it to execution_config.
      '{"schemaVersion":2,"type":"native","executionTarget":"mac-mini"}',
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

  it("round-trips delivery-introduced and explicit handles with and without roles", () => {
    repository.upsert(root);
    for (const peerId of ["peer-1", "peer-2", "peer-3", "peer-4", "peer-5", "peer-6", "peer-7"]) {
      repository.upsert({
        id: peerId,
        charter: `Charter for ${peerId}`,
        parentId: "root",
        status: "active",
        createdAt: "2026-09-03T13:00:00.000Z",
      });
    }
    const worker: ActorRecord = {
      id: "worker-handles",
      charter: "Test handle origins",
      parentId: "root",
      status: "active",
      handles: [
        { id: "peer-1", origin: "message" },
        { id: "peer-2", role: "reviewer" },
        { id: "peer-3" },
        { id: "peer-4", origin: "message", role: "introducer" },
        { id: "peer-5", role: "__origin:message" },
        { id: "peer-6", role: "__origin:message:reviewer" },
      ],
      createdAt: "2026-09-03T13:01:00.000Z",
    };
    repository.upsert(worker);

    // Verify stored representation in SQLite preserves distinction without collision
    expect(repository.get("worker-handles")?.handles).toEqual([
      { id: "peer-1", origin: "message" },
      { id: "peer-2", role: "reviewer" },
      { id: "peer-3" },
      { id: "peer-4", origin: "message", role: "introducer" },
      { id: "peer-5", role: "__origin:message" },
      { id: "peer-6", role: "__origin:message:reviewer" },
    ]);

    // Re-upserting after readback preserves exact labels and provenance
    const loaded = repository.get("worker-handles");
    expect(loaded).toBeDefined();
    if (!loaded) throw new Error("expected worker-handles to exist");
    repository.upsert(loaded);
    expect(repository.get("worker-handles")?.handles).toEqual([
      { id: "peer-1", origin: "message" },
      { id: "peer-2", role: "reviewer" },
      { id: "peer-3" },
      { id: "peer-4", origin: "message", role: "introducer" },
      { id: "peer-5", role: "__origin:message" },
      { id: "peer-6", role: "__origin:message:reviewer" },
    ]);

    // Legacy row written before prefix escaping retains its label as an explicit grant
    db.prepare(
      "INSERT INTO actor_handles (actor_id, target_id, role) VALUES ('worker-handles', 'peer-7', '__origin:legacy_unmatched')"
    ).run();
    expect(repository.get("worker-handles")?.handles).toContainEqual({
      id: "peer-7",
      role: "__origin:legacy_unmatched",
    });
  });

  it("describes existing handle rows by target title or charter while keeping their provenance (#814)", () => {
    repository.upsert(root);
    repository.upsert({
      id: "titled-peer",
      charter: "Review release candidates\nand more",
      parentId: "root",
      status: "active",
      title: "Release reviewer",
      createdAt: "2026-09-03T13:00:00.000Z",
    });
    repository.upsert({
      id: "untitled-peer",
      charter: "Triage incoming issues",
      parentId: "root",
      status: "active",
      createdAt: "2026-09-03T13:00:00.000Z",
    });
    repository.upsert({
      id: "holder",
      charter: "Hold handles",
      parentId: "root",
      status: "active",
      createdAt: "2026-09-03T13:01:00.000Z",
    });
    // Rows as earlier releases wrote them: a pairwise label, and a
    // delivery-introduced handle (#796) that also carries one.
    const insert = db.prepare(
      "INSERT INTO actor_handles (actor_id, target_id, role) VALUES ('holder', ?, ?)"
    );
    insert.run("titled-peer", "__origin:message:the boss");
    insert.run("untitled-peer", "trusted operator");

    const loaded = repository.get("holder");
    expect(loaded?.handles).toEqual([
      { id: "titled-peer", origin: "message", role: "the boss" },
      { id: "untitled-peer", role: "trusted operator" },
    ]);
    expect(
      resolveHandleLabels(
        loaded?.handles,
        (id) => repository.get(id)?.charter,
        (id) => repository.get(id)?.title
      )
    ).toEqual([
      { id: "titled-peer", label: "Release reviewer" },
      { id: "untitled-peer", label: "Triage incoming issues" },
    ]);

    // Re-saving the record keeps the stored provenance that sender display
    // and voice-transfer authority read.
    if (!loaded) throw new Error("expected holder to exist");
    repository.upsert(loaded);
    expect(
      db
        .prepare(
          "SELECT target_id, role FROM actor_handles WHERE actor_id = 'holder' ORDER BY target_id"
        )
        .all()
    ).toEqual([
      { target_id: "titled-peer", role: "__origin:message:the boss" },
      { target_id: "untitled-peer", role: "trusted operator" },
    ]);
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

  it("hydrates actor records without reading mesh_chat (#691)", () => {
    repository.upsert(root);
    for (let i = 0; i < 5; i++) {
      repository.upsert({
        id: `worker-${i}`,
        charter: "Work",
        parentId: "root",
        status: "active",
        createdAt: "2026-09-03T13:01:00.000Z",
      });
    }
    const insert = db.prepare(
      "INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id) VALUES (?, ?, ?, ?, ?, ?)"
    );
    insert.run("m-1", "2026-09-03T13:05:00.000Z", TEST_USER_ID, "worker-1", "hello", "s-1");

    const prepare = vi.spyOn(db, "prepare");
    expect(repository.get("worker-1")).toMatchObject({ id: "worker-1", parentId: "root" });
    expect(repository.children("root")).toHaveLength(5);
    expect(repository.list()).toHaveLength(6);
    repository.patch("worker-1", { title: "Renamed" });
    const renamed = repository.get("worker-1");

    // Before #691 every get()/children() row ran an unindexed mesh_chat scan.
    const chatReads = prepare.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("mesh_chat")
    );
    expect(chatReads).toHaveLength(0);
    expect(renamed).toMatchObject({ title: "Renamed" });
    expect(renamed).not.toHaveProperty("humanUnlocked");
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
      const reread = new SqliteActorRepository(reopened);
      expect(reread.get("worker")).toMatchObject({
        id: "worker",
        handles: [{ id: "root", role: "parent" }],
      });
      expect(reread.get("root")).toEqual(root);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces relational ownership invariants", () => {
    expect(() => repository.upsert({ ...root, parentId: "missing" })).toThrow();
    repository.upsert(root);
    expect(() =>
      db.prepare("INSERT INTO actor_handles (actor_id, target_id) VALUES ('missing', 'root')").run()
    ).toThrow();
  });

  it("stores several parentless actors, each with its own execution config (#550)", () => {
    repository.upsert(root);
    const driver: ActorRecord = {
      id: "driver",
      charter: "A/B driver stub",
      parentId: null,
      status: "active",
      createdAt: "2026-09-03T13:05:00.000Z",
    };
    repository.upsert(driver);

    expect(repository.list().filter((record) => record.parentId === null)).toEqual([root, driver]);
    expect(repository.get("driver")).toEqual(driver);
    expect(repository.get("root")).not.toHaveProperty("isRoot");
  });

  it("keeps executionConfig across a parent change (#550)", () => {
    repository.upsert(root);
    repository.upsert({
      id: "lead",
      charter: "Lead",
      parentId: "root",
      status: "active",
      createdAt: "2026-09-03T13:01:00.000Z",
    });
    repository.upsert({
      id: "worker",
      charter: "Implement",
      parentId: "lead",
      executionConfig: { unsandboxed: true },
      status: "active",
      createdAt: "2026-09-03T13:02:00.000Z",
    });

    repository.patch("worker", { parentId: "root" });
    repository.patch("lead", { parentId: null });

    expect(repository.get("worker")).toMatchObject({
      parentId: "root",
      executionConfig: { unsandboxed: true },
    });
    expect(repository.get("lead")).toMatchObject({
      parentId: null,
    });
  });

  it("sandboxes an actor unless it is affirmatively unsandboxed, and states that in storage (#550)", () => {
    const { executionConfig: _omitted, ...defaulted } = root;
    repository.upsert({ ...defaulted, id: "defaulted" });
    repository.upsert({
      ...defaulted,
      id: "explicit-false",
      executionConfig: { unsandboxed: false },
    });
    repository.upsert({ ...defaulted, id: "empty", executionConfig: {} });
    repository.upsert({ ...defaulted, id: "unsandboxed", executionConfig: { unsandboxed: true } });

    const stored = (id: string) =>
      JSON.parse(
        (
          db.prepare("SELECT execution_config FROM actors WHERE id = ?").get(id) as {
            execution_config: string;
          }
        ).execution_config
      );
    for (const id of ["defaulted", "explicit-false", "empty"]) {
      expect(stored(id), id).toEqual({ schemaVersion: 1, unsandboxed: false });
      expect(repository.get(id), id).not.toHaveProperty("executionConfig");
    }
    expect(stored("unsandboxed")).toEqual({ schemaVersion: 1, unsandboxed: true });
    expect(repository.get("unsandboxed")?.executionConfig).toEqual({ unsandboxed: true });
  });

  it("refuses a write whose unsandboxed is not a boolean (#550)", () => {
    for (const unsandboxed of [null, "true", 1, ""]) {
      expect(() =>
        repository.upsert({ ...root, executionConfig: { unsandboxed } } as unknown as ActorRecord)
      ).toThrow(/invalid execution_config for actor 'root'/);
    }
    expect(repository.get("root")).toBeUndefined();
  });

  it("stores how an actor runs in its own versioned execution_config (#550)", () => {
    repository.upsert({
      ...root,
      context: { type: "native" },
      sessionId: "session-root",
      executionConfig: { unsandboxed: true, executionTarget: "follower-a" },
    });
    const row = db
      .prepare("SELECT context_config, execution_config FROM actors WHERE id = 'root'")
      .get() as { context_config: string; execution_config: string };
    expect(JSON.parse(row.execution_config)).toEqual({
      schemaVersion: 1,
      unsandboxed: true,
      executionTarget: "follower-a",
    });
    expect(repository.get("root")?.executionConfig).toEqual({
      unsandboxed: true,
      executionTarget: "follower-a",
    });
    // context_config keeps only the context selection and the session.
    expect(JSON.parse(row.context_config)).toEqual({
      schemaVersion: 1,
      type: "native",
      sessionId: "session-root",
    });

    // Clearing the placement returns the actor to the leader.
    repository.patch("root", { executionConfig: { unsandboxed: true } });
    expect(repository.get("root")?.executionConfig).toEqual({ unsandboxed: true });
    expect(
      JSON.parse(
        (
          db.prepare("SELECT execution_config FROM actors WHERE id = 'root'").get() as {
            execution_config: string;
          }
        ).execution_config
      )
    ).toEqual({ schemaVersion: 1, unsandboxed: true });
  });

  it.each([
    ["missing", null, /missing execution_config for actor 'root'/],
    ["unversioned", '{"unsandboxed":false}', /invalid execution_config for actor 'root'/],
    [
      "future",
      '{"schemaVersion":2,"unsandboxed":false}',
      /invalid execution_config for actor 'root'/,
    ],
    ["non-boolean", '{"schemaVersion":1,"unsandboxed":"yes"}', /invalid execution_config/],
    ["implicit default", '{"schemaVersion":1}', /invalid execution_config/],
    ["superseded field", '{"schemaVersion":1,"sandboxed":true}', /invalid execution_config/],
    ["unknown field", '{"schemaVersion":1,"unsandboxed":false,"kind":"external"}', /invalid/],
    ["not JSON", "{", /invalid execution_config for actor 'root'/],
  ])("refuses to read a %s execution_config rather than guess how the actor runs (#550)", (_label, stored, error) => {
    repository.upsert(root);
    db.prepare("UPDATE actors SET execution_config = ? WHERE id = 'root'").run(stored);

    expect(() => repository.get("root")).toThrow(error);
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

  it("keeps staged model-class provenance in the same process-local overlay", () => {
    repository.upsert({ ...root, modelClass: "fast" });
    repository.patch("root", {
      desiredModelConfig: [{ provider: "claude", model: "claude-opus" }],
      desiredModelClass: "careful",
    });

    expect(repository.get("root")).toMatchObject({
      modelClass: "fast",
      desiredModelConfig: [{ provider: "claude", model: "claude-opus" }],
      desiredModelClass: "careful",
    });
    repository.patch("root", { title: "Renamed" });
    expect(repository.get("root")?.desiredModelClass).toBe("careful");

    repository.patch("root", {
      desiredModelConfig: undefined,
      desiredModelClass: undefined,
    });
    expect(repository.get("root")?.desiredModelClass).toBeUndefined();
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
  it("persists executionTarget across repository reopen", () => {
    const remoteWorker: ActorRecord = {
      id: "worker-remote",
      charter: "Run remotely on macOS",
      parentId: "root",
      status: "active",
      executionConfig: { executionTarget: "mac-mini-follower" },
      modelConfig: [{ provider: "codex", model: "gpt-5.6-sol" }],
      createdAt: "2026-09-07T12:00:00.000Z",
    };
    repository.upsert(root);
    repository.upsert(remoteWorker);

    const stored = db
      .prepare("SELECT context_config, execution_config FROM actors WHERE id = 'worker-remote'")
      .get() as { context_config: string | null; execution_config: string };
    expect(JSON.parse(stored.execution_config)).toEqual({
      schemaVersion: 1,
      unsandboxed: false,
      executionTarget: "mac-mini-follower",
    });
    // Placement alone no longer writes a context document.
    expect(stored.context_config).toBeNull();

    expect(repository.get("worker-remote")?.executionConfig?.executionTarget).toBe(
      "mac-mini-follower"
    );

    // Verify persistence across repository reopen with same db
    const reopened = new SqliteActorRepository(db);
    expect(reopened.get("worker-remote")?.executionConfig?.executionTarget).toBe(
      "mac-mini-follower"
    );
  });

  it("keeps the v1 context document as it is when an actor is placed", () => {
    repository.upsert(root);
    db.prepare("UPDATE actors SET context_config = ? WHERE id = 'root'").run(
      JSON.stringify({ schemaVersion: 1, type: "native", sessionId: "legacy-session" })
    );

    expect(repository.get("root")).toMatchObject({
      context: { type: "native" },
      sessionId: "legacy-session",
    });

    repository.patch("root", {
      executionConfig: { unsandboxed: true, executionTarget: "mac-mini-follower" },
    });
    const stored = db.prepare("SELECT context_config FROM actors WHERE id = 'root'").get() as {
      context_config: string;
    };
    expect(JSON.parse(stored.context_config)).toEqual({
      schemaVersion: 1,
      type: "native",
      sessionId: "legacy-session",
    });
    expect(repository.get("root")).toMatchObject({
      sessionId: "legacy-session",
      executionConfig: { unsandboxed: true, executionTarget: "mac-mini-follower" },
    });
  });

  it("writes each actor's principal in the same transaction as its row", () => {
    repository.upsert(root);

    expect(
      db.prepare("SELECT id, kind, created_at FROM principals WHERE id = 'root'").get()
    ).toEqual({
      id: "root",
      kind: "actor",
      created_at: root.createdAt,
    });
  });

  it("rolls the principal back with the actor row when the write fails", () => {
    repository.upsert(root);
    expect(() =>
      repository.upsert({
        id: "worker",
        charter: "Implement a slice",
        parentId: "missing",
        status: "active",
        createdAt: "2026-09-03T13:01:00.000Z",
      })
    ).toThrow();

    expect(repository.get("worker")).toBeUndefined();
    expect(db.prepare("SELECT id FROM principals WHERE id = 'worker'").get()).toBeUndefined();
  });

  it("keeps the actor principal timestamp aligned when an actor is re-upserted", () => {
    repository.upsert(root);
    repository.upsert({ ...root, title: "Renamed", createdAt: "2026-09-04T13:00:00.000Z" });
    repository.patch("root", { charter: "Own the mesh, still" });

    expect(db.prepare("SELECT created_at FROM principals WHERE id = 'root'").all()).toEqual([
      { created_at: "2026-09-04T13:00:00.000Z" },
    ]);
  });

  it("keeps a retired actor's identity", () => {
    repository.upsert(root);
    const worker: ActorRecord = {
      id: "worker",
      charter: "Implement a slice",
      parentId: "root",
      status: "active",
      createdAt: "2026-09-03T13:01:00.000Z",
    };
    repository.upsert(worker);

    repository.patch("worker", { status: "retired" });

    expect(repository.get("worker")?.status).toBe("retired");
    expect(new PrincipalRepository(db).get("worker")).toEqual({
      kind: "actor",
      id: "worker",
      actorId: "worker",
      createdAt: worker.createdAt,
    });
  });

  it("round-trips the voice_config document and omits the column when unset", () => {
    repository.upsert(root);
    const spoken: ActorRecord = {
      id: "worker-voice",
      charter: "Speak",
      parentId: "root",
      status: "active",
      voiceConfig: {
        schemaVersion: 1,
        provider: "google",
        config: { voiceName: "Puck" },
      },
      createdAt: "2026-09-09T12:00:00.000Z",
    };
    repository.upsert(spoken);
    const quiet: ActorRecord = {
      id: "worker-quiet",
      charter: "Fallback",
      parentId: "root",
      status: "active",
      createdAt: "2026-09-09T12:01:00.000Z",
    };
    repository.upsert(quiet);

    expect(repository.get("worker-voice")).toEqual(spoken);
    expect(repository.get("worker-quiet")).toEqual(quiet);
    const rows = db
      .prepare(
        "SELECT id, voice_config FROM actors WHERE id IN ('worker-voice','worker-quiet') ORDER BY id"
      )
      .all() as Array<{ id: string; voice_config: string | null }>;
    expect(rows).toEqual([
      { id: "worker-quiet", voice_config: null },
      {
        id: "worker-voice",
        voice_config: JSON.stringify({
          schemaVersion: 1,
          provider: "google",
          config: { voiceName: "Puck" },
        }),
      },
    ]);

    // Clearing the setting (the PATCH route's null path) drops the document.
    repository.patch("worker-voice", { voiceConfig: undefined });
    expect(repository.get("worker-voice")?.voiceConfig).toBeUndefined();
    const cleared = db
      .prepare("SELECT voice_config FROM actors WHERE id = 'worker-voice'")
      .get() as { voice_config: string | null };
    expect(cleared.voice_config).toBeNull();
  });

  it("persists voice_config across a file-backed database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "rusa-actor-voice-"));
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
        voiceConfig: {
          schemaVersion: 1,
          provider: "google",
          config: { voiceName: "Kore" },
        },
        createdAt: "2026-09-09T12:00:00.000Z",
      });
      first.close();

      const reopened = new Database(file);
      expect(new SqliteActorRepository(reopened).get("worker")?.voiceConfig).toEqual({
        schemaVersion: 1,
        provider: "google",
        config: { voiceName: "Kore" },
      });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("round-trips ElevenLabs voice IDs and clears them", () => {
    repository.upsert(root);
    const voiceConfig = {
      schemaVersion: 1 as const,
      provider: "elevenlabs" as const,
      config: { voiceId: "voice-123" },
    };
    repository.upsert({
      ...root,
      id: "eleven-worker",
      parentId: "root",
      voiceConfig,
    });
    expect(repository.get("eleven-worker")?.voiceConfig).toEqual(voiceConfig);
    repository.patch("eleven-worker", { voiceConfig: undefined });
    expect(repository.get("eleven-worker")?.voiceConfig).toBeUndefined();
  });

  it("rejects complete invalid voice documents at upsert and patch boundaries", () => {
    repository.upsert(root);
    const worker: ActorRecord = {
      id: "worker",
      charter: "Speak",
      parentId: "root",
      status: "active",
      voiceConfig: { schemaVersion: 1, provider: "google", config: { voiceName: "Puck" } },
      createdAt: "2026-09-09T12:00:00.000Z",
    };
    repository.upsert(worker);
    const invalidDocuments = [
      { schemaVersion: 2, provider: "google", config: { voiceName: "Puck" } },
      { schemaVersion: 1, provider: "elevenlabs", config: { voiceName: "Puck" } },
      {
        schemaVersion: 1,
        provider: "google",
        config: { voiceName: "Puck" },
        extra: true,
      },
    ];

    for (const invalid of invalidDocuments) {
      expect(() =>
        repository.upsert({ ...worker, voiceConfig: invalid as ActorRecord["voiceConfig"] })
      ).toThrow(/invalid voice_config for actor 'worker'/);
      expect(() =>
        repository.patch("worker", { voiceConfig: invalid as ActorRecord["voiceConfig"] })
      ).toThrow(/invalid voice_config for actor 'worker'/);
      expect(repository.get("worker")?.voiceConfig).toEqual(worker.voiceConfig);
    }
  });

  it("validates voice_config version and shape when records are consumed", () => {
    repository.upsert(root);

    for (const invalid of [
      "not-json",
      '{"provider":"google","config":{"voiceName":"Puck"}}',
      '{"schemaVersion":2,"provider":"google","config":{"voiceName":"Puck"}}',
      '{"schemaVersion":1,"provider":"google"}',
      '{"schemaVersion":1,"provider":"google","config":{"voiceName":""}}',
      '{"schemaVersion":1,"provider":"google","config":{"voiceName":"Puck","unknown":true}}',
      '{"schemaVersion":1,"provider":"unknown","config":{"voiceId":"abc"}}',
    ]) {
      db.prepare("UPDATE actors SET voice_config = ? WHERE id = 'root'").run(invalid);
      expect(() => repository.get("root")).toThrow(/invalid voice_config for actor 'root'/);
    }
  });

  it("falls back to the instance voice when a well-formed document names a retired voice", () => {
    repository.upsert(root);
    const stored = JSON.stringify({
      schemaVersion: 1,
      provider: "google",
      config: { voiceName: "NotAVoice" },
    });
    db.prepare("UPDATE actors SET voice_config = ? WHERE id = 'root'").run(stored);
    expect(repository.get("root")?.voiceConfig).toBeUndefined();
  });

  it("resolves parentOf efficiently without loading full records or chat history (#687)", () => {
    repository.upsert(root);
    const worker: ActorRecord = {
      id: "worker",
      charter: "Worker",
      parentId: "root",
      status: "active",
      createdAt: "2026-09-09T12:00:00.000Z",
    };
    repository.upsert(worker);

    expect(repository.parentOf("root")).toBeNull();
    expect(repository.parentOf("worker")).toBe("root");
    expect(repository.parentOf("non-existent")).toBeUndefined();

    // Verify patch updates parentOf
    const steward: ActorRecord = {
      id: "steward",
      charter: "Steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-09-09T12:00:00.000Z",
    };
    repository.upsert(steward);
    repository.patch("worker", { parentId: "steward" });
    expect(repository.parentOf("worker")).toBe("steward");

    // Verify direct database updates are immediately visible without in-memory stale cache
    db.prepare("UPDATE actors SET parent_id = 'root' WHERE id = 'worker'").run();
    expect(repository.parentOf("worker")).toBe("root");
  });
});

const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";
