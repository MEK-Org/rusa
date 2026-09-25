import { describe, expect, it } from "vitest";
import type { ActorRecord } from "../actor/actor-record.js";
import { InMemoryActorRepository } from "./in-memory-actor-repository.js";

describe("InMemoryActorRepository", () => {
  it("resolves parentOf correctly", () => {
    const repo = new InMemoryActorRepository();
    const root: ActorRecord = {
      id: "root",
      charter: "Root",
      parentId: null,
      isRoot: true,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const child: ActorRecord = {
      id: "child",
      charter: "Child",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    };

    repo.upsert(root);
    repo.upsert(child);

    expect(repo.parentOf("root")).toBeNull();
    expect(repo.parentOf("child")).toBe("root");
    expect(repo.parentOf("unknown")).toBeUndefined();

    repo.patch("child", { parentId: "other" });
    expect(repo.parentOf("child")).toBe("other");
  });
});
