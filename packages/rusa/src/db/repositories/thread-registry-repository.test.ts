import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { ThreadRecord } from "../../actor/thread-registry.js";
import { actorRuntimeState } from "../migrations/0034_actor_runtime_state.js";
import { DbThreadRegistry } from "./thread-registry-repository.js";

const root: ThreadRecord = {
  id: "root",
  charter: "Own the mesh",
  parentId: null,
  provider: "codex",
  model: "gpt-test",
  effort: "high",
  desiredProvider: "next-provider",
  desiredModel: "next-model",
  desiredEffort: null,
  sessionId: "session-1",
  context: { type: "native" },
  title: "Root",
  isRoot: true,
  status: "active",
  budget: { maxRuns: 10, runsUsed: 2 },
  humanUnlocked: true,
  lastChatSessionId: "chat-1",
  createdAt: "2026-09-03T13:00:00.000Z",
};

describe("DbThreadRegistry", () => {
  let db: Database.Database;
  let registry: DbThreadRegistry;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    actorRuntimeState.up(db);
    registry = new DbThreadRegistry(db);
  });

  it("round-trips every ThreadRegistry field through normalized child tables", () => {
    registry.upsert(root);
    const worker: ThreadRecord = {
      id: "worker",
      charter: "Implement a slice",
      parentId: "root",
      status: "active",
      context: { type: "portable", mode: "ledger", compactionModel: "gemini-test" },
      handles: [{ id: "root", role: "parent" }],
      pendingDeliveries: [
        {
          id: "delivery-1",
          fromId: "root",
          body: "Continue",
          deliverAt: "2026-09-03T14:00:00.000Z",
          sessionId: "chat-1",
        },
      ],
      createdAt: "2026-09-03T13:01:00.000Z",
    };
    registry.upsert(worker);

    expect(registry.get("root")).toEqual(root);
    expect(registry.get("worker")).toEqual(worker);
    expect(registry.children("root")).toEqual([worker]);
  });

  it("replaces handles and deliveries atomically on upsert and keeps direct ids routable after retirement", () => {
    registry.upsert(root);
    registry.upsert({
      id: "worker",
      charter: "Work",
      parentId: "root",
      status: "active",
      createdAt: "2026-09-03T13:01:00.000Z",
    });
    registry.patch("worker", {
      handles: [{ id: "root", role: "owner" }],
      pendingDeliveries: [
        { id: "old", fromId: "root", body: "old", deliverAt: "2026-09-03T14:00:00.000Z" },
      ],
    });
    registry.patch("worker", { handles: [], pendingDeliveries: [], status: "retired" });

    expect(registry.get("worker")).toMatchObject({ status: "retired" });
    expect(registry.get("worker")).not.toHaveProperty("handles");
    expect(registry.get("worker")).not.toHaveProperty("pendingDeliveries");
    const distinguish = (id: string) => (id === "worker" ? "same-name" : "root-handle");
    expect(registry.resolveHandle("worker", distinguish)).toBe("worker");
    expect(registry.resolveHandle("same-name", distinguish)).toBeNull();
  });

  it("persists normalized records across a file-backed database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "rusa-thread-registry-"));
    const file = join(directory, "mesh.db");
    try {
      const first = new Database(file);
      first.pragma("foreign_keys = ON");
      actorRuntimeState.up(first);
      const firstRegistry = new DbThreadRegistry(first);
      firstRegistry.upsert(root);
      firstRegistry.upsert({
        id: "worker",
        charter: "Persist",
        parentId: "root",
        status: "active",
        handles: [{ id: "root", role: "parent" }],
        pendingDeliveries: [
          { id: "d1", fromId: "root", body: "wake", deliverAt: "2026-09-03T14:00:00.000Z" },
        ],
        createdAt: "2026-09-03T13:01:00.000Z",
      });
      first.close();

      const reopened = new Database(file);
      reopened.pragma("foreign_keys = ON");
      expect(new DbThreadRegistry(reopened).get("worker")).toMatchObject({
        id: "worker",
        handles: [{ id: "root", role: "parent" }],
        pendingDeliveries: [{ id: "d1", fromId: "root", body: "wake" }],
      });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces the relational ownership invariants while preserving parentless drivers", () => {
    expect(() => registry.upsert({ ...root, parentId: "missing" })).toThrow();
    registry.upsert(root);
    expect(() => registry.upsert({ ...root, id: "second-root" })).toThrow();
    expect(() => registry.upsert({ ...root, id: "root-with-parent", parentId: "root" })).toThrow();
    expect(() =>
      registry.upsert({
        ...root,
        id: "driver",
        parentId: null,
        isRoot: false,
      })
    ).not.toThrow();
    expect(() =>
      db.prepare("INSERT INTO actor_handles (actor_id, target_id) VALUES ('missing', 'root')").run()
    ).toThrow();
  });
});
