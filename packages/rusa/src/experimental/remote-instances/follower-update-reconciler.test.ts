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
    reconciler.arm();

    expect(mockHub.updateFollower).toHaveBeenCalledTimes(1);
    expect(mockHub.updateFollower).toHaveBeenCalledWith("f1", {
      targetSha,
      branch: "staging",
    });

    const trigger = store.getActiveTrigger();
    expect(trigger?.attempts.f1?.status).toBe("pending");
    expect(trigger?.attempts.f2?.status).toBe("success");
  });

  it("runs automatic updates one at a time and advances on failure or already_current", () => {
    const targetSha = "ab".repeat(20);
    store.createTrigger({ targetSha, branch: "staging" });
    mockFollowers = [
      follower("f1", "old".repeat(10)),
      follower("f2", "old".repeat(10)),
      follower("f3", "old".repeat(10)),
    ];

    new FollowerUpdateReconciler(store, mockHub).arm();

    // A boot sweep must not fan out a deployment to every connected follower.
    expect(mockHub.updateFollower).toHaveBeenCalledTimes(1);
    expect(mockHub.updateFollower).toHaveBeenLastCalledWith("f1", { targetSha, branch: "staging" });

    updateStatusCallback?.("f1", {
      updateId: "up-f1",
      status: "failed",
      error: "build failed",
      // A fetch failure has not resolved its new SHA. It must still terminate f1's
      // attempt against the trigger target rather than corrupting durable state.
      newSha: "",
      timestamp: new Date().toISOString(),
    });

    // A terminal failure suppresses only f1 for this target and releases f2.
    expect(mockHub.updateFollower).toHaveBeenCalledTimes(2);
    expect(mockHub.updateFollower).toHaveBeenLastCalledWith("f2", { targetSha, branch: "staging" });
    expect(store.hasFailed("f1", targetSha)).toBe(true);

    updateStatusCallback?.("f2", {
      updateId: "up-f2",
      status: "already_current",
      newSha: targetSha,
      timestamp: new Date().toISOString(),
    });

    // A different terminal outcome also releases exactly one next candidate.
    expect(mockHub.updateFollower).toHaveBeenCalledTimes(3);
    expect(mockHub.updateFollower).toHaveBeenLastCalledWith("f3", { targetSha, branch: "staging" });
  });

  it("advances after a restarted follower registers on the target", () => {
    const targetSha = "bc".repeat(20);
    store.createTrigger({ targetSha, branch: "staging" });
    mockFollowers = [follower("f1", "old".repeat(10)), follower("f2", "old".repeat(10))];

    new FollowerUpdateReconciler(store, mockHub).arm();
    expect(mockHub.updateFollower).toHaveBeenCalledTimes(1);
    expect(mockHub.updateFollower).toHaveBeenLastCalledWith("f1", { targetSha, branch: "staging" });

    // A normal update ends by restarting. Its replacement registration is the success signal.
    mockFollowers = [follower("f1", targetSha), follower("f2", "old".repeat(10))];
    registerCallback?.({ id: "f1", commitSha: targetSha });

    expect(mockHub.updateFollower).toHaveBeenCalledTimes(2);
    expect(mockHub.updateFollower).toHaveBeenLastCalledWith("f2", { targetSha, branch: "staging" });
    expect(store.hasSucceeded("f1", targetSha)).toBe(true);
  });

  it("releases a reloaded pending attempt when its replacement is current", () => {
    const targetSha = "cd".repeat(20);
    store.createTrigger({ targetSha, branch: "staging" });
    store.recordAttempt("f1", {
      status: "pending",
      targetSha,
      lastAttemptAt: new Date().toISOString(),
    });
    mockFollowers = [follower("f1", targetSha), follower("f2", "old".repeat(10))];

    // This is a replacement leader: the pending command is durable, but f1 has
    // already restarted on targetSha by the time it reconnects to the new hub.
    new FollowerUpdateReconciler(store, mockHub).arm();

    expect(store.hasSucceeded("f1", targetSha)).toBe(true);
    expect(mockHub.updateFollower).toHaveBeenCalledTimes(1);
    expect(mockHub.updateFollower).toHaveBeenLastCalledWith("f2", { targetSha, branch: "staging" });
  });

  it("reconciles lagging follower upon registration", () => {
    const targetSha = "b".repeat(40);
    store.createTrigger({ targetSha, branch: "staging" });

    new FollowerUpdateReconciler(store, mockHub).arm();

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

    new FollowerUpdateReconciler(store, mockHub).arm();

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

    new FollowerUpdateReconciler(store, mockHub).arm();

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
    mockFollowers = [follower("f-fail", "old".repeat(10))];

    new FollowerUpdateReconciler(store, mockHub).arm();

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

  const follower = (id: string, commitSha: string): FollowerInfo => ({
    id,
    platform: "linux",
    pid: 10,
    actors: [],
    lastSeen: new Date().toISOString(),
    commitSha,
  });

  it("keeps the trigger active for a follower that was offline during the leader update", () => {
    // The one connected follower is already current. Retiring the trigger here would
    // strand f2 — which is precisely the case the durable document exists to serve, since
    // the leader keeps no enrollment roster and cannot know f2 exists.
    const targetSha = "f".repeat(40);
    store.createTrigger({ targetSha, branch: "staging" });
    mockFollowers = [follower("f1", targetSha)];

    const reconciler = new FollowerUpdateReconciler(store, mockHub);
    reconciler.arm();

    expect(store.hasSucceeded("f1", targetSha)).toBe(true);
    expect(store.getActiveTrigger()).not.toBeNull();

    // f2 reconnects an hour later and still gets caught up.
    registerCallback?.({ id: "f2", commitSha: "old".repeat(10) });

    expect(mockHub.updateFollower).toHaveBeenCalledWith("f2", { targetSha, branch: "staging" });
  });

  it("reports all-connected-current without claiming the rollout finished", () => {
    const targetSha = "f0".repeat(20);
    store.createTrigger({ targetSha, branch: "staging" });
    mockFollowers = [follower("f1", targetSha)];

    const reconciler = new FollowerUpdateReconciler(store, mockHub);
    reconciler.arm();

    const status = reconciler.getStatus();
    expect(status.state).toBe("active");
    expect(status.allConnectedCurrent).toBe(true);
    expect(status.activeTrigger?.targetSha).toBe(targetSha);
  });

  it("distinguishes absent from active trigger", () => {
    const reconciler = new FollowerUpdateReconciler(store, mockHub);
    reconciler.arm();
    expect(reconciler.getStatus().state).toBe("none");

    store.createTrigger({ targetSha: "f1".repeat(20), branch: "staging" });
    expect(reconciler.getStatus().state).toBe("active");
  });

  it("dispatches nothing until armed, then reconciles whoever connected meanwhile", () => {
    // A leader that binds its gateway and then dies must not have moved anyone.
    const targetSha = "1a".repeat(20);
    store.createTrigger({ targetSha, branch: "staging" });

    const reconciler = new FollowerUpdateReconciler(store, mockHub);
    mockFollowers = [follower("f-early", "old".repeat(10))];
    registerCallback?.({ id: "f-early", commitSha: "old".repeat(10) });
    reconciler.reconcileAll();

    expect(mockHub.updateFollower).not.toHaveBeenCalled();
    expect(store.getActiveTrigger()?.attempts["f-early"]).toBeUndefined();
    expect(reconciler.getStatus().armed).toBe(false);

    reconciler.arm();

    expect(mockHub.updateFollower).toHaveBeenCalledWith("f-early", {
      targetSha,
      branch: "staging",
    });
    expect(reconciler.getStatus().armed).toBe(true);
  });

  it("records a failure when dispatch throws rather than leaving a stuck pending attempt", () => {
    // updateFollower throws on ordinary conditions (follower gone, update already running).
    // A leftover "pending" is neither failed nor succeeded, so the follower would never be
    // retried, never suppressed, and never current.
    const targetSha = "2b".repeat(20);
    store.createTrigger({ targetSha, branch: "staging" });
    mockHub.updateFollower = vi.fn(() => {
      throw new Error("Follower not connected");
    });

    new FollowerUpdateReconciler(store, mockHub).arm();
    registerCallback?.({ id: "f-gone", commitSha: "old".repeat(10) });

    const attempt = store.getActiveTrigger()?.attempts["f-gone"];
    expect(attempt?.status).toBe("failed");
    expect(attempt?.error).toBe("Follower not connected");
    expect(store.hasFailed("f-gone", targetSha)).toBe(true);
  });

  it("records success when a follower reports already_current", () => {
    const targetSha = "3c".repeat(20);
    store.createTrigger({ targetSha, branch: "staging" });

    new FollowerUpdateReconciler(store, mockHub).arm();

    updateStatusCallback?.("f-current", {
      updateId: "up-current",
      status: "already_current",
      newSha: targetSha,
      timestamp: new Date().toISOString(),
    });

    expect(store.hasSucceeded("f-current", targetSha)).toBe(true);
  });

  it("reconciles a reconnecting follower on commitSha even after a prior restarting status", () => {
    // /register builds a fresh RemoteInstance, so updateStatus does not survive a
    // reconnect. If that ever changes, a stale active phase would silently skip this
    // follower forever — there is no terminal success phase to clear it.
    const targetSha = "4d".repeat(20);
    store.createTrigger({ targetSha, branch: "staging" });

    new FollowerUpdateReconciler(store, mockHub).arm();
    registerCallback?.({ id: "f-back", commitSha: "old".repeat(10), updateStatus: undefined });

    expect(mockHub.updateFollower).toHaveBeenCalledWith("f-back", { targetSha, branch: "staging" });
  });
});
