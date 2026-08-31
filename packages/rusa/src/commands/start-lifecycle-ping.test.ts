import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActorMesh } from "../actor/actor-mesh.js";
import type { ThreadRecord } from "../actor/thread-registry.js";
import { InMemoryThreadRegistry } from "../actor/thread-registry.js";
import { createStartRetireCleanups, postBackOnlinePing } from "./start.js";

describe("postBackOnlinePing", () => {
  let repoRoot = "";

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "rusa-start-ping-repo-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("posts the built sha from the build sentinel to the configured error-chat path", () => {
    const distDir = join(repoRoot, "packages", "rusa", "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, ".build-ok"), "abcdef1234567890\n", "utf8");
    const messages: string[] = [];

    postBackOnlinePing({
      repoRoot,
      sendToErrorChat: (text) => messages.push(text),
    });

    expect(messages).toEqual(["✅ Back online on abcdef1"]);
  });

  it("skips the ping when the build sentinel is missing", () => {
    const messages: string[] = [];
    const logs: string[] = [];

    postBackOnlinePing({
      repoRoot,
      sendToErrorChat: (text) => messages.push(text),
      log: (text) => logs.push(text),
    });

    expect(messages).toEqual([]);
    expect(logs).toEqual(["[start] back online ping skipped: no build sentinel found"]);
  });
});

describe("createStartRetireCleanups", () => {
  let workersDir = "";

  beforeEach(() => {
    workersDir = mkdtempSync(join(tmpdir(), "rusa-workers-"));
  });

  afterEach(() => {
    rmSync(workersDir, { recursive: true, force: true });
  });

  it("removes the retired worker workdir and cancels its cron wake", async () => {
    const actorId = "actor-1";
    mkdirSync(join(workersDir, actorId), { recursive: true });
    const cancelled: string[] = [];
    const stopped: string[] = [];
    const cleanups = createStartRetireCleanups(
      workersDir,
      {
        async cancel(id: string) {
          cancelled.push(id);
        },
      },
      {
        stopForActorRetirement: (id) => {
          expect(existsSync(join(workersDir, id))).toBe(true);
          stopped.push(id);
        },
      }
    );
    const record: ThreadRecord = {
      id: actorId,
      charter: "worker",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    };

    for (const cleanup of cleanups) {
      await cleanup.run(record);
    }

    expect(existsSync(join(workersDir, actorId))).toBe(false);
    expect(cancelled).toEqual([actorId]);
    expect(stopped).toEqual([actorId, actorId]);
  });

  it("removes the provider CLI's copy of the workspace too, when told where it is", async () => {
    const actorId = "a1b2c3d4-1111-4222-8333-555566667777";
    const scratchDir = mkdtempSync(join(tmpdir(), "rusa-scratch-"));
    // All three spellings the provider has used for this one workspace.
    const workspaces = ["worker-a1b2c3d4", "a1b2c3d4", actorId].map((n) => join(scratchDir, n));
    mkdirSync(join(workersDir, actorId), { recursive: true });
    for (const workspace of workspaces) mkdirSync(workspace, { recursive: true });
    // A neighbour that is not this actor's, to pin that retirement removes one
    // workspace rather than clearing the shared area.
    mkdirSync(join(scratchDir, "worker-9f8e7d6c"), { recursive: true });

    // The registry still reads this actor as active while its own cleanup runs,
    // which must not count as the live claim on its own workspace.
    const cleanups = createStartRetireCleanups(workersDir, { async cancel() {} }, undefined, {
      dir: scratchDir,
      listActors: () => [{ id: actorId, retired: false }],
    });
    const record: ThreadRecord = {
      id: actorId,
      charter: "worker",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    };

    for (const cleanup of cleanups) await cleanup.run(record);

    for (const workspace of workspaces) expect(existsSync(workspace)).toBe(false);
    expect(existsSync(join(workersDir, actorId))).toBe(false);
    expect(existsSync(join(scratchDir, "worker-9f8e7d6c"))).toBe(true);
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("keeps the short workspace spellings a live actor also answers to", async () => {
    const actorId = "a1b2c3d4-1111-4222-8333-555566667777";
    // Eight hex characters is short enough to collide, and the two shorter
    // spellings carry nothing else. This actor is retiring; the other is mid-run.
    const liveNeighbour = "a1b2c3d4-9999-4222-8333-555566667777";
    const scratchDir = mkdtempSync(join(tmpdir(), "rusa-scratch-"));
    const contested = ["worker-a1b2c3d4", "a1b2c3d4"].map((n) => join(scratchDir, n));
    const own = join(scratchDir, actorId);
    mkdirSync(join(workersDir, actorId), { recursive: true });
    for (const workspace of [...contested, own]) mkdirSync(workspace, { recursive: true });

    const cleanups = createStartRetireCleanups(workersDir, { async cancel() {} }, undefined, {
      dir: scratchDir,
      listActors: () => [
        { id: actorId, retired: true },
        { id: liveNeighbour, retired: false },
      ],
    });
    const record: ThreadRecord = {
      id: actorId,
      charter: "worker",
      parentId: "root",
      status: "retired",
      createdAt: "2026-01-01T00:00:00Z",
    };

    for (const cleanup of cleanups) await cleanup.run(record);

    // The whole-id spelling names one actor, so it goes regardless.
    expect(existsSync(own)).toBe(false);
    // The ambiguous ones stay: a delayed cleanup costs disk, deleting them
    // costs the neighbour the run it is in the middle of.
    for (const workspace of contested) expect(existsSync(workspace)).toBe(true);
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("keeps an active-run worker workdir until run_end", () => {
    const actorId = "actor-active-run";
    const workdir = join(workersDir, actorId);
    mkdirSync(workdir, { recursive: true });
    const cancelled: string[] = [];
    const registry = new InMemoryThreadRegistry();
    registry.upsert({
      id: actorId,
      charter: "worker",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const mesh = new ActorMesh({
      registry,
      createActor: () => {
        throw new Error("not used");
      },
      retireCleanups: createStartRetireCleanups(workersDir, {
        async cancel(id: string) {
          cancelled.push(id);
        },
      }),
    });

    mesh.recordEvent({ kind: "run_queued", actorId });
    mesh.retire(actorId);

    expect(registry.get(actorId)?.status).toBe("retired");
    expect(existsSync(workdir)).toBe(true);
    expect(cancelled).toEqual([actorId]);

    mesh.recordEvent({ kind: "run_end", actorId, success: true });

    expect(existsSync(workdir)).toBe(false);
  });
});
