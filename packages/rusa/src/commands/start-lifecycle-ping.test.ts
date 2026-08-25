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
