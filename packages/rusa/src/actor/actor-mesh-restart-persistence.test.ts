import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MeshActor } from "./actor-mesh.js";
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
});
