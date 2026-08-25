import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileThreadRegistry,
  InMemoryThreadRegistry,
  resolveRootThreadId,
  type ThreadRecord,
  type ThreadRegistry,
} from "./thread-registry.js";

describe("resolveRootThreadId", () => {
  it("keeps an explicit generated root id", () => {
    const registry = new InMemoryThreadRegistry();
    registry.upsert(rec("generated-root", { parentId: null, isRoot: true }));
    expect(resolveRootThreadId(registry, () => "new-id")).toBe("generated-root");
  });

  it('grandfathers and stamps the legacy "root" record', () => {
    const registry = new InMemoryThreadRegistry();
    registry.upsert(rec("root", { parentId: null }));
    expect(resolveRootThreadId(registry, () => "new-id")).toBe("root");
    expect(registry.get("root")?.isRoot).toBe(true);
  });

  it("mints an opaque id only for a fresh registry", () => {
    const registry = new InMemoryThreadRegistry();
    expect(resolveRootThreadId(registry, () => "generated-id")).toBe("generated-id");
  });
});

function rec(id: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id,
    charter: `charter ${id}`,
    parentId: "root",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function suite(name: string, make: () => ThreadRegistry) {
  describe(name, () => {
    it("upserts, gets, and lists", () => {
      const r = make();
      r.upsert(rec("a"));
      r.upsert(rec("b", { parentId: "a" }));
      expect(r.get("a")?.charter).toBe("charter a");
      expect(
        r
          .list()
          .map((x) => x.id)
          .sort()
      ).toEqual(["a", "b"]);
    });

    it("returns children of a parent", () => {
      const r = make();
      r.upsert(rec("a"));
      r.upsert(rec("b", { parentId: "a" }));
      r.upsert(rec("c", { parentId: "a" }));
      r.upsert(rec("d", { parentId: "b" }));
      expect(
        r
          .children("a")
          .map((x) => x.id)
          .sort()
      ).toEqual(["b", "c"]);
    });

    it("resolves ids and generated handles back to thread ids", () => {
      const r = make();
      r.upsert(rec("root", { parentId: null }));
      r.upsert(rec("b4b43d69-5e63-4db2-b44b-35c031096aad"));

      expect(r.resolveHandle("b4b43d69-5e63-4db2-b44b-35c031096aad")).toBe(
        "b4b43d69-5e63-4db2-b44b-35c031096aad"
      );
      expect(r.resolveHandle("cloudy-porpoise")).toBe("b4b43d69-5e63-4db2-b44b-35c031096aad");
      expect(
        r.resolveHandle("ember-familiar", (id) => (id === "root" ? "ember-familiar" : id))
      ).toBe("root");
      expect(r.resolveHandle("missing-owner")).toBeNull();
    });

    it("never lets a retired record shadow a live actor on a handle collision", () => {
      const r = make();
      // Insert the RETIRED record FIRST so it wins insertion-order iteration —
      // the pre-fix bug returned it because the scan ignored status. Both ids
      // collide to the same generated handle via handleForId.
      r.upsert(rec("dead-thread", { status: "retired" }));
      r.upsert(rec("live-thread", { status: "active" }));
      const collide = (id: string) =>
        id === "dead-thread" || id === "live-thread" ? "shared-handle" : id;

      // The live actor must win, regardless of insertion order.
      expect(r.resolveHandle("shared-handle", collide)).toBe("live-thread");

      // With no live holder of the handle, a retired-only match does not resolve
      // (routing must surface "no live actor", not silently target a dead thread).
      const r2 = make();
      r2.upsert(rec("dead-only", { status: "retired" }));
      expect(
        r2.resolveHandle("shared-handle", (id) => (id === "dead-only" ? "shared-handle" : id))
      ).toBeNull();

      // A direct id still resolves regardless of status (explicit id, not a collision).
      expect(r2.resolveHandle("dead-only")).toBe("dead-only");
    });

    it("patches without clobbering other fields", () => {
      const r = make();
      r.upsert(rec("a", { handles: [{ id: "x", role: "peer" }] }));
      r.patch("a", { sessionId: "sess-1" });
      r.patch("a", { status: "retired" });
      const got = r.get("a");
      expect(got?.sessionId).toBe("sess-1");
      expect(got?.status).toBe("retired");
      expect(got?.handles).toEqual([{ id: "x", role: "peer" }]);
      expect(got?.charter).toBe("charter a");
    });

    it("patch on unknown id is a no-op", () => {
      const r = make();
      r.patch("nope", { status: "retired" });
      expect(r.get("nope")).toBeUndefined();
    });

    it("isolates returned records from internal state", () => {
      const r = make();
      r.upsert(rec("a"));
      const got = r.get("a");
      if (got) got.charter = "mutated";
      expect(r.get("a")?.charter).toBe("charter a");
    });
  });
}

suite("InMemoryThreadRegistry", () => new InMemoryThreadRegistry());

describe("FileThreadRegistry", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const makeFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-registry-"));
    dirs.push(dir);
    return join(dir, "threads.json");
  };

  suite("FileThreadRegistry (behavior)", () => new FileThreadRegistry(makeFile()));

  it("persists across reopen (registry survives a restart)", () => {
    const file = makeFile();
    const r1 = new FileThreadRegistry(file);
    r1.upsert(rec("a", { sessionId: "s1", handles: [{ id: "b", role: "reviewer" }] }));
    r1.upsert(rec("b", { parentId: "a" }));
    r1.patch("a", { status: "retired" });

    const r2 = new FileThreadRegistry(file);
    expect(
      r2
        .list()
        .map((x) => x.id)
        .sort()
    ).toEqual(["a", "b"]);
    expect(r2.get("a")?.status).toBe("retired");
    expect(r2.get("a")?.sessionId).toBe("s1");
    expect(r2.get("a")?.handles).toEqual([{ id: "b", role: "reviewer" }]);
  });
});
