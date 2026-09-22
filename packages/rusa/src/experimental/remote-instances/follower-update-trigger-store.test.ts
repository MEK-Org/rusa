import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FollowerUpdateTriggerStore } from "./follower-update-trigger-store.js";

describe("FollowerUpdateTriggerStore", () => {
  const testDir = join(__dirname, ".tmp-trigger-store-test");
  const storePath = join(testDir, "follower-update-trigger.json");
  let store: FollowerUpdateTriggerStore;

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    store = new FollowerUpdateTriggerStore(storePath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns null when no trigger file exists", () => {
    expect(store.load()).toBeNull();
    expect(store.getActiveTrigger()).toBeNull();
  });

  it("creates, saves, and loads an active trigger atomically", () => {
    const trigger = store.createTrigger({
      targetSha: "a".repeat(40),
      branch: "staging",
      source: "leader-update",
    });

    expect(trigger.triggerId).toBeDefined();
    expect(trigger.targetSha).toBe("a".repeat(40));
    expect(trigger.branch).toBe("staging");
    expect(trigger.source).toBe("leader-update");
    expect(trigger.autoReconcile).toBe(true);
    expect(trigger.attempts).toEqual({});
    expect(existsSync(storePath)).toBe(true);

    const loaded = store.load();
    expect(loaded).toEqual(trigger);
    expect(store.getActiveTrigger()).toEqual(trigger);
  });

  it("records attempts, successes, and failures correctly", () => {
    const sha = "b".repeat(40);
    store.createTrigger({ targetSha: sha, branch: "staging" });

    store.recordAttempt("follower-1", {
      status: "pending",
      targetSha: sha,
      lastAttemptAt: new Date().toISOString(),
    });

    expect(store.hasFailed("follower-1", sha)).toBe(false);
    expect(store.hasSucceeded("follower-1", sha)).toBe(false);

    store.recordFailure("follower-1", sha, "build timeout");
    expect(store.hasFailed("follower-1", sha)).toBe(true);
    expect(store.hasSucceeded("follower-1", sha)).toBe(false);

    store.recordSuccess("follower-2", sha);
    expect(store.hasSucceeded("follower-2", sha)).toBe(true);
    expect(store.hasFailed("follower-2", sha)).toBe(false);

    const active = store.getActiveTrigger();
    expect(active?.attempts["follower-1"]?.status).toBe("failed");
    expect(active?.attempts["follower-1"]?.error).toBe("build timeout");
    expect(active?.attempts["follower-2"]?.status).toBe("success");
  });

  it("marks trigger complete and hides it from getActiveTrigger", () => {
    const sha = "c".repeat(40);
    store.createTrigger({ targetSha: sha, branch: "staging" });

    store.recordSuccess("f1", sha);
    store.recordSuccess("f2", sha);

    expect(store.checkCompletion(["f1", "f2"])).toBe(true);
    expect(store.getActiveTrigger()).toBeNull();

    const loaded = store.load();
    expect(loaded?.completedAt).toBeDefined();
  });

  it("gracefully handles corrupt trigger files", () => {
    writeFileSync(storePath, "{ this is not valid json }", "utf-8");
    expect(store.load()).toBeNull();
    expect(store.getActiveTrigger()).toBeNull();
  });
});
