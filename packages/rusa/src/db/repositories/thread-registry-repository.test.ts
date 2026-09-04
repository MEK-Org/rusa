import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { ThreadRecord } from "../../actor/thread-registry.js";
import { HUMAN_OPERATOR } from "../../mcp/stamp.js";
import { runMigrations } from "../migrations/runner.js";
import { DbThreadRegistry } from "./thread-registry-repository.js";

const root: ThreadRecord = {
  id: "root",
  charter: "Own the mesh",
  parentId: null,
  provider: "codex",
  model: "gpt-test",
  effort: "high",
  sessionId: "session-1",
  context: { type: "native" },
  title: "Root",
  isRoot: true,
  status: "active",
  createdAt: "2026-09-03T13:00:00.000Z",
};

describe("DbThreadRegistry", () => {
  let db: Database.Database;
  let registry: DbThreadRegistry;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    db.pragma("foreign_keys = ON");
    registry = new DbThreadRegistry(db);
  });

  it("round-trips fields through the model_config/context_config JSON columns and normalized handles", () => {
    registry.upsert(root);
    const worker: ThreadRecord = {
      id: "worker",
      charter: "Implement a slice",
      parentId: "root",
      status: "active",
      context: { type: "portable", mode: "ledger", compactionModel: "gemini-test" },
      handles: [{ id: "root", role: "parent" }],
      createdAt: "2026-09-03T13:01:00.000Z",
    };
    registry.upsert(worker);

    expect(registry.get("root")).toEqual(root);
    expect(registry.get("worker")).toEqual(worker);
    expect(registry.children("root")).toEqual([worker]);
  });

  it("replaces handles atomically on upsert and keeps direct ids routable after retirement", () => {
    registry.upsert(root);
    registry.upsert({
      id: "worker",
      charter: "Work",
      parentId: "root",
      status: "active",
      createdAt: "2026-09-03T13:01:00.000Z",
    });
    registry.patch("worker", { handles: [{ id: "root", role: "owner" }] });
    registry.patch("worker", { handles: [], status: "retired" });

    expect(registry.get("worker")).toMatchObject({ status: "retired" });
    expect(registry.get("worker")).not.toHaveProperty("handles");
    const distinguish = (id: string) => (id === "worker" ? "same-name" : "root-handle");
    expect(registry.resolveHandle("worker", distinguish)).toBe("worker");
    expect(registry.resolveHandle("same-name", distinguish)).toBeNull();
  });

  it("preserves the original retired_at across repeated upserts of an already-retired record", () => {
    registry.upsert(root);
    registry.upsert({
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

    registry.patch("worker", { title: "Retired worker" });
    const secondRetiredAt = (
      db.prepare("SELECT retired_at FROM actors WHERE id = 'worker'").get() as {
        retired_at: string;
      }
    ).retired_at;
    expect(secondRetiredAt).toBe(firstRetiredAt);
  });

  it("derives humanUnlocked and lastChatSessionId from durable mesh_chat rows instead of stored columns", () => {
    registry.upsert(root);
    expect(registry.get("root")).not.toHaveProperty("humanUnlocked");
    expect(registry.get("root")).not.toHaveProperty("lastChatSessionId");

    db.prepare(
      "INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("msg-1", "2026-09-03T13:05:00.000Z", HUMAN_OPERATOR, "root", "hello", "chat-1");
    expect(registry.get("root")).toMatchObject({
      humanUnlocked: true,
      lastChatSessionId: "chat-1",
    });

    db.prepare(
      "INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("msg-2", "2026-09-03T13:10:00.000Z", HUMAN_OPERATOR, "root", "again", "chat-2");
    expect(registry.get("root")).toMatchObject({
      humanUnlocked: true,
      lastChatSessionId: "chat-2",
    });

    db.prepare(
      "INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("msg-3", "2026-09-03T13:15:00.000Z", "root", "some-peer", "not from the operator", null);
    expect(registry.get("root")).toMatchObject({
      humanUnlocked: true,
      lastChatSessionId: "chat-2",
    });
  });

  it("persists normalized records across a file-backed database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "rusa-thread-registry-"));
    const file = join(directory, "mesh.db");
    try {
      const first = new Database(file);
      runMigrations(first);
      first.pragma("foreign_keys = ON");
      const firstRegistry = new DbThreadRegistry(first);
      firstRegistry.upsert(root);
      firstRegistry.upsert({
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
      expect(new DbThreadRegistry(reopened).get("worker")).toMatchObject({
        id: "worker",
        handles: [{ id: "root", role: "parent" }],
      });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces the relational ownership invariants, including that root authority requires a null parentId", () => {
    expect(() => registry.upsert({ ...root, parentId: "missing" })).toThrow();
    registry.upsert(root);
    expect(() => registry.upsert({ ...root, id: "second-root" })).toThrow();
    expect(() => registry.upsert({ ...root, id: "root-with-parent", parentId: "root" })).toThrow();
    expect(() =>
      db.prepare("INSERT INTO actor_handles (actor_id, target_id) VALUES ('missing', 'root')").run()
    ).toThrow();
  });

  it("refuses to store a parentless, non-root record so it cannot be read back with apparent root authority", () => {
    expect(() =>
      registry.upsert({
        id: "driver",
        charter: "A/B driver stub",
        parentId: null,
        isRoot: false,
        status: "active",
        createdAt: "2026-09-03T13:00:00.000Z",
      })
    ).toThrow();
  });

  it("keeps a staged desiredModel/desiredProvider/desiredEffort change in the process-local overlay, not a durable column", () => {
    registry.upsert(root);
    registry.patch("root", {
      desiredProvider: "claude",
      desiredModel: "claude-opus",
      desiredEffort: null,
    });

    expect(registry.get("root")).toMatchObject({
      desiredProvider: "claude",
      desiredModel: "claude-opus",
      desiredEffort: null,
    });
    // Never a durable column: model_config only carries the applied tuple.
    const row = db.prepare("SELECT model_config FROM actors WHERE id = 'root'").get() as {
      model_config: string;
    };
    expect(JSON.parse(row.model_config)).toEqual({
      provider: "codex",
      model: "gpt-test",
      effort: "high",
    });
  });

  it("leaves a staged model change alone across an unrelated patch, and drops it on an explicit clear", () => {
    registry.upsert(root);
    registry.patch("root", { desiredModel: "claude-opus" });

    registry.patch("root", { title: "Renamed" });
    expect(registry.get("root")).toMatchObject({ desiredModel: "claude-opus", title: "Renamed" });

    // The apply-boundary clear: present keys set to undefined, exactly as
    // ActorMesh.applyPendingModel does once it has consumed the staged tuple.
    registry.patch("root", {
      desiredModel: undefined,
      desiredProvider: undefined,
      desiredEffort: undefined,
    });
    expect(registry.get("root")?.desiredModel).toBeUndefined();
    expect(registry.get("root")?.desiredProvider).toBeUndefined();
    expect(registry.get("root")?.desiredEffort).toBeUndefined();
  });

  it("loses staged model changes across a registry reopen, matching process-memory-only semantics", () => {
    registry.upsert(root);
    registry.patch("root", { desiredModel: "claude-opus" });
    expect(registry.get("root")?.desiredModel).toBe("claude-opus");

    const reopened = new DbThreadRegistry(db);
    expect(reopened.get("root")?.desiredModel).toBeUndefined();
  });

  it("leaves the prior overlay entry unchanged when the underlying SQLite write fails, instead of staging ahead of durable state", () => {
    registry.upsert(root);
    registry.patch("root", { desiredModel: "claude-opus" });

    const worker: ThreadRecord = {
      id: "worker",
      charter: "Implement a slice",
      parentId: "root",
      status: "active",
      createdAt: "2026-09-03T13:01:00.000Z",
    };
    registry.upsert(worker);
    registry.patch("worker", { desiredModel: "claude-sonnet" });

    // parent_id REFERENCES actors(id) with no such row: the transaction must
    // roll back on the FK violation, so the new desired* tuple must never
    // reach the overlay and the previously staged one must survive intact.
    expect(() =>
      registry.upsert({ ...worker, parentId: "missing", desiredModel: "claude-haiku" })
    ).toThrow();

    expect(registry.get("worker")?.desiredModel).toBe("claude-sonnet");
    expect(registry.get("root")?.desiredModel).toBe("claude-opus");
  });
});
