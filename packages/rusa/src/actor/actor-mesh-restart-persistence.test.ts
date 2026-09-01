import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorFactoryContext, MeshActor } from "./actor-mesh.js";
import { ActorMesh } from "./actor-mesh.js";
import { FileThreadRegistry } from "./thread-registry.js";

const inertActor = (id: string): MeshActor => ({
  id,
  requestRun: () => {},
  declareYield: () => {},
  markUnkillable: () => {},
  close: () => {},
  isRunning: false,
});

describe("mesh restart persistence ", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("re-adopts root without clobbering durable pending schedules", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-restart-"));
    dirs.push(dir);
    const file = join(dir, "threads.json");
    const registry1 = new FileThreadRegistry(file);
    registry1.upsert({
      id: "root",
      charter: "old",
      parentId: null,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      pendingDeliveries: [
        {
          id: "scheduled",
          fromId: "worker",
          body: "later",
          deliverAt: "2099-01-01T00:00:00Z",
        },
      ],
    });

    const registry2 = new FileThreadRegistry(file);
    const mesh = new ActorMesh({
      registry: registry2,
      createActor: ({ record }) => inertActor(record.id),
    });
    mesh.adopt(
      {
        id: "root",
        charter: "fresh",
        parentId: null,
        status: "active",
        createdAt: "2026-01-02T00:00:00Z",
      },
      inertActor("root")
    );

    expect(registry2.get("root")).toMatchObject({
      charter: "fresh",
      pendingDeliveries: [{ id: "scheduled", body: "later" }],
    });
  });

  it("persists pending desiredModel across restarts and applies it at next run boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-restart-model-"));
    dirs.push(dir);
    const file = join(dir, "threads.json");
    const registry1 = new FileThreadRegistry(file);
    registry1.upsert({
      id: "worker-1",
      charter: "worker",
      parentId: "root",
      provider: "claude",
      model: "claude-sonnet-5",
      desiredModel: "claude-opus-4-8",
      desiredProvider: "claude",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });

    const registry2 = new FileThreadRegistry(file);
    expect(registry2.get("worker-1")).toMatchObject({
      model: "claude-sonnet-5",
      desiredModel: "claude-opus-4-8",
      desiredProvider: "claude",
    });

    let runEndCallback: ActorFactoryContext["onRunEnd"] | undefined;
    const mesh = new ActorMesh({
      registry: registry2,
      createActor: (ctx) => {
        runEndCallback = ctx.onRunEnd;
        return inertActor(ctx.record.id);
      },
    });

    const rec1 = registry2.get("worker-1");
    if (!rec1) throw new Error("worker-1 missing");
    mesh.rehydrate(rec1);
    expect(registry2.get("worker-1")?.model).toBe("claude-sonnet-5");
    expect(registry2.get("worker-1")?.desiredModel).toBe("claude-opus-4-8");

    // Simulate run completing after restart
    runEndCallback?.({ success: true, exitCode: 0, output: "done" });
    expect(registry2.get("worker-1")?.model).toBe("claude-opus-4-8");
    expect(registry2.get("worker-1")?.desiredModel).toBeUndefined();
    expect(registry2.get("worker-1")?.desiredProvider).toBeUndefined();
  });
});
