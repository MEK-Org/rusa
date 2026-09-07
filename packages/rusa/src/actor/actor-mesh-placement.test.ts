import { describe, expect, it } from "vitest";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import type { Actor } from "./actor.js";
import { ActorMesh, type ActorMeshOptions } from "./actor-mesh.js";

/**
 * Explicit placement must fail closed.
 *
 * An `executionTarget` a runtime cannot honour used to fall through to a local
 * Actor in the leader's own process — the actor ran, on the wrong machine,
 * silently. These tests pin the opposite: no record, no handle, no Actor.
 */
function setup(options?: Partial<ActorMeshOptions>) {
  const registry = new InMemoryActorRepository();
  registry.upsert({
    id: "root",
    charter: "root",
    parentId: null,
    isRoot: true,
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
  });
  const built: Array<string | undefined> = [];
  const mesh = new ActorMesh({
    actors: registry,
    idgen: () => "child-1",
    createActor: (ctx) => {
      built.push(ctx.executionTarget);
      return {} as unknown as Actor;
    },
    ...options,
  });
  return { mesh, registry, built };
}

const REQUEST = {
  charter: "do the remote thing",
  parentId: "root",
  modelConfig: { provider: "claude", model: "claude-opus-5" },
};

describe("execution placement", () => {
  it("refuses an explicit target when the runtime has no placement support", () => {
    const { mesh, registry, built } = setup();

    expect(() => mesh.spawn({ ...REQUEST, executionTarget: "mac-follower" })).toThrow(
      /no remote placement support/
    );

    // Nothing ran locally in the leader's stead, and the refusal left no trace:
    // no live Actor, no durable record, no handle on the parent.
    expect(built).toEqual([]);
    expect(registry.get("child-1")).toBeUndefined();
    expect(registry.get("root")?.handles ?? []).toEqual([]);
  });

  it("refuses a blank target rather than treating it as 'run here'", () => {
    const { mesh, built } = setup({ supportsExecutionTarget: () => true });

    expect(() => mesh.spawn({ ...REQUEST, executionTarget: "   " })).toThrow(
      /no remote placement support/
    );
    expect(built).toEqual([]);
  });

  it("refuses a target the runtime does not recognise", () => {
    const { mesh, built } = setup({
      supportsExecutionTarget: (target) => target === "mac-follower",
    });

    expect(() => mesh.spawn({ ...REQUEST, executionTarget: "linux-follower" })).toThrow(
      /no remote placement support/
    );
    expect(built).toEqual([]);
  });

  it("passes a supported target through to the factory", () => {
    const { mesh, built } = setup({
      supportsExecutionTarget: (target) => target === "mac-follower",
    });

    expect(mesh.spawn({ ...REQUEST, executionTarget: "mac-follower" })).toBe("child-1");
    expect(built).toEqual(["mac-follower"]);
  });

  it("still spawns locally when no target is named", () => {
    const { mesh, built } = setup();

    expect(mesh.spawn(REQUEST)).toBe("child-1");
    expect(built).toEqual([undefined]);
  });
});
