import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FOLLOWER_UPDATE_TRIGGER_VERSION,
  FollowerUpdateTriggerStore,
} from "./follower-update-trigger-store.js";

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
    });

    expect(trigger.version).toBe(FOLLOWER_UPDATE_TRIGGER_VERSION);
    expect(trigger.triggerId).toBeDefined();
    expect(trigger.targetSha).toBe("a".repeat(40));
    expect(trigger.branch).toBe("staging");
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

  it("reports all-current as an observation without retiring the trigger", () => {
    const sha = "c".repeat(40);
    store.createTrigger({ targetSha: sha, branch: "staging" });

    store.recordSuccess("f1", sha);
    store.recordSuccess("f2", sha);

    expect(store.allCurrent(["f1", "f2"])).toBe(true);
    // The trigger stays active: the leader keeps no enrollment roster, so "every follower
    // we can see is current" cannot establish that every enrolled follower is.
    expect(store.getActiveTrigger()).not.toBeNull();
    expect(store.load()?.completedAt).toBeUndefined();
  });

  it("does not report all-current while any named follower still lags", () => {
    const sha = "c1".repeat(20);
    store.createTrigger({ targetSha: sha, branch: "staging" });
    store.recordSuccess("f1", sha);

    expect(store.allCurrent(["f1", "f2"])).toBe(false);
  });

  it("markCompleted still retires a trigger when something explicitly closes it out", () => {
    const sha = "c2".repeat(20);
    store.createTrigger({ targetSha: sha, branch: "staging" });

    store.markCompleted();

    expect(store.getActiveTrigger()).toBeNull();
    expect(store.load()?.completedAt).toBeDefined();
  });

  it("supersedes an outstanding trigger when a newer leader update writes one", () => {
    const oldSha = "d".repeat(40);
    const newSha = "e".repeat(40);
    store.createTrigger({ targetSha: oldSha, branch: "staging" });
    store.recordFailure("f1", oldSha, "build timeout");

    store.createTrigger({ targetSha: newSha, branch: "staging" });

    const active = store.getActiveTrigger();
    expect(active?.targetSha).toBe(newSha);
    // The new target clears the old failure suppression rather than inheriting it.
    expect(store.hasFailed("f1", oldSha)).toBe(false);
    expect(active?.attempts).toEqual({});
  });

  it("reports corrupt trigger files as invalid rather than as absent", () => {
    writeFileSync(storePath, "{ this is not valid json }", "utf-8");

    const result = store.read();
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" && result.reason).toContain("unparseable JSON");
    // Still non-throwing for callers that only ask for the trigger, so boot is unaffected.
    expect(store.load()).toBeNull();
    expect(store.getActiveTrigger()).toBeNull();
  });

  it("reports a document from an incompatible schema version as invalid, not absent", () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: FOLLOWER_UPDATE_TRIGGER_VERSION + 1,
        triggerId: "t1",
        targetSha: "f".repeat(40),
        branch: "staging",
        createdAt: new Date().toISOString(),
        attempts: {},
      }),
      "utf-8"
    );

    const result = store.read();
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" && result.reason).toContain("unsupported schema version");
  });

  it("rejects a document whose branch or attempt records are malformed", () => {
    const base = {
      version: FOLLOWER_UPDATE_TRIGGER_VERSION,
      triggerId: "t1",
      targetSha: "a".repeat(40),
      createdAt: new Date().toISOString(),
    };

    // A malformed branch would otherwise be handed to updateFollower as a deploy target.
    writeFileSync(storePath, JSON.stringify({ ...base, branch: 42, attempts: {} }), "utf-8");
    expect(store.read()).toEqual({ kind: "invalid", reason: "missing or invalid 'branch'" });

    // A bad attempt record would otherwise be silently dropped, un-suppressing a follower
    // that had already failed this target.
    writeFileSync(
      storePath,
      JSON.stringify({ ...base, branch: "staging", attempts: { f1: { status: "bogus" } } }),
      "utf-8"
    );
    const result = store.read();
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" && result.reason).toContain(
      "attempt record for follower 'f1'"
    );
  });

  it("reports a missing file as absent", () => {
    expect(store.read()).toEqual({ kind: "absent" });
  });
});
