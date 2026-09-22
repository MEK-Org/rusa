import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowerInfo } from "./follower-hub.js";
import { FollowerUpdateReconciler, type ReconcilerHub } from "./follower-update-reconciler.js";
import { FollowerUpdateTriggerStore } from "./follower-update-trigger-store.js";
import type { FollowerUpdateStatus } from "./protocol.js";

describe("FollowerUpdateReconciler", () => {
  const testDir = join(__dirname, ".tmp-reconciler-test");
  const storePath = join(testDir, "follower-update-trigger.json");
  let store: FollowerUpdateTriggerStore;
  let registerCallback:
    | ((follower: { id: string; commitSha?: string; updateStatus?: FollowerUpdateStatus }) => void)
    | undefined;
  let updateStatusCallback:
    | ((followerId: string, status: FollowerUpdateStatus) => void)
    | undefined;
  let mockFollowers: FollowerInfo[];
  let mockHub: ReconcilerHub;

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    store = new FollowerUpdateTriggerStore(storePath);

    mockFollowers = [];
    mockHub = {
      list: vi.fn(() => mockFollowers),
      updateFollower: vi.fn((_followerId, options) => ({
        updateId: "up-123",
        status: "pending" as const,
        newSha: options?.targetSha,
        timestamp: new Date().toISOString(),
      })),
      onRegister: vi.fn((cb) => {
        registerCallback = cb;
        return () => {
          registerCallback = undefined;
        };
      }),
      onUpdateStatus: vi.fn((cb) => {
        updateStatusCallback = cb;
        return () => {
          updateStatusCallback = undefined;
        };
      }),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("reconciles currently connected lagging followers when reconcileAll is called", () => {
    const targetSha = "a".repeat(40);
    store.createTrigger({ targetSha, branch: "staging" });

    mockFollowers = [
      {
        id: "f1",
        platform: "linux",
        pid: 100,
        actors: [],
        lastSeen: new Date().toISOString(),
        commitSha: "old".repeat(10),
      },
      {
        id: "f2",
        platform: "darwin",
        pid: 200,
        actors: [],
        lastSeen: new Date().toISOString(),
        commitSha: targetSha,
      },
    ];

    const reconciler = new FollowerUpdateReconciler(store, mockHub);
    reconciler.reconcileAll();

    expect(mockHub.updateFollower).toHaveBeenCalledTimes(1);
    expect(mockHub.updateFollower).toHaveBeenCalledWith("f1", {
      targetSha,
      branch: "staging",
    });

    const trigger = store.getActiveTrigger();
    expect(trigger?.attempts.f1?.status).toBe("pending");
    expect(trigger?.attempts.f2?.status).toBe("success");
  });

  it("reconciles lagging follower upon registration", () => {
    const targetSha = "b".repeat(40);
    store.createTrigger({ targetSha, branch: "staging" });

    new FollowerUpdateReconciler(store, mockHub);

    expect(registerCallback).toBeDefined();
    registerCallback?.({
      id: "f-new",
      commitSha: "1".repeat(40),
    });

    expect(mockHub.updateFollower).toHaveBeenCalledWith("f-new", {
      targetSha,
      branch: "staging",
    });
    expect(store.getActiveTrigger()?.attempts["f-new"]?.status).toBe("pending");
  });

  it("marks success without dispatching update when registered follower matches targetSha", () => {
    const targetSha = "c".repeat(40);
    store.createTrigger({ targetSha, branch: "staging" });

    new FollowerUpdateReconciler(store, mockHub);

    registerCallback?.({
      id: "f-green",
      commitSha: targetSha,
    });

    expect(mockHub.updateFollower).not.toHaveBeenCalled();
    expect(store.getActiveTrigger()?.attempts["f-green"]?.status).toBe("success");
  });

  it("prevents loops by refusing to re-trigger update for follower that previously failed the targetSha", () => {
    const targetSha = "d".repeat(40);
    store.createTrigger({ targetSha, branch: "staging" });
    store.recordFailure("f-flaky", targetSha, "compile error in step build");

    new FollowerUpdateReconciler(store, mockHub);

    // Follower reconnects on old commit
    registerCallback?.({
      id: "f-flaky",
      commitSha: "old".repeat(10),
    });

    expect(mockHub.updateFollower).not.toHaveBeenCalled();
    expect(store.getActiveTrigger()?.attempts["f-flaky"]?.status).toBe("failed");
  });

  it("records failure when updateStatus event reports failure", () => {
    const targetSha = "e".repeat(40);
    store.createTrigger({ targetSha, branch: "staging" });

    new FollowerUpdateReconciler(store, mockHub);

    updateStatusCallback?.("f-fail", {
      updateId: "up-fail",
      status: "failed",
      error: "timed out during install",
      newSha: targetSha,
      timestamp: new Date().toISOString(),
    });

    expect(store.hasFailed("f-fail", targetSha)).toBe(true);
    expect(store.getActiveTrigger()?.attempts["f-fail"]?.error).toBe("timed out during install");
  });

  it("completes trigger when all registered followers succeed", () => {
    const targetSha = "f".repeat(40);
    store.createTrigger({ targetSha, branch: "staging" });

    mockFollowers = [
      {
        id: "f1",
        platform: "linux",
        pid: 10,
        actors: [],
        lastSeen: new Date().toISOString(),
        commitSha: targetSha,
      },
    ];

    const reconciler = new FollowerUpdateReconciler(store, mockHub);
    reconciler.reconcileAll();

    expect(store.getActiveTrigger()).toBeNull();
    expect(store.load()?.completedAt).toBeDefined();
  });
});
