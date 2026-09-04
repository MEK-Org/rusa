import { describe, expect, it } from "vitest";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import type { ActorRecord } from "./actor-record.js";
import { resolveRootActorId } from "./root-actor-id.js";

function record(id: string, overrides: Partial<ActorRecord> = {}): ActorRecord {
  return {
    id,
    charter: `charter ${id}`,
    parentId: "root",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveRootActorId", () => {
  it("returns the single parentless actor", () => {
    const actors = new InMemoryActorRepository();
    actors.upsert(record("generated-root", { parentId: null, isRoot: true }));
    actors.upsert(record("worker", { parentId: "generated-root" }));

    expect(resolveRootActorId(actors, () => "new-id")).toBe("generated-root");
  });

  it("mints an id only for an empty repository", () => {
    expect(resolveRootActorId(new InMemoryActorRepository(), () => "generated-id")).toBe(
      "generated-id"
    );
  });

  it("rejects ambiguous root topology", () => {
    const actors = new InMemoryActorRepository();
    actors.upsert(record("root-a", { parentId: null, isRoot: true }));
    actors.upsert(record("root-b", { parentId: null, isRoot: true }));

    expect(() => resolveRootActorId(actors)).toThrow(/multiple root records found: root-a, root-b/);
  });
});
