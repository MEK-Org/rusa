// Reproduction and verification for MEK-Org/rusa#1272.
//
// Deploy observation: the new leader dispatched a run to a follower still on
// the old revision while an update trigger for it was already persisted; two
// seconds later it told the follower to update, and the follower's restart
// killed the run. The leader booked it as a failed run and notified the
// parent, rather than treating it as an interruption.
//
// Repaired behaviors verified here against disposable followers:
// (a) Placement gate: refuse placement on stale followers while an update trigger
//     is active, unless the attempt terminally failed; resume on target revision.
// (b) Attribution & booking: attribute update restart exit to the in-flight update,
//     booking it as an interruption rather than a failed run, with exactly one
//     inbox reconcile re-queue on reconnect. Unrelated exit -1 stays a failed result.
// (c) Unchanged: boot-time hold on reconciliation arming; retained-admission drop.

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorLifecycle, type ActorLifecycleEndEvent } from "../actor/actor-lifecycle.js";
import type { ActorFactoryContext, ActorMesh } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import type { ActorChannel } from "./actor-channel.js";
import { ActorHandle } from "./actor-handle.js";
import { FollowerHub } from "./follower-hub.js";
import { FollowerUpdateTriggerStore } from "./follower-update-trigger-store.js";
import { INSTANCE_PROTOCOL_VERSION, type LeaderCommand } from "./protocol.js";

const TARGET_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const STALE_SHA = "0011223344556677889900aabbccddeeff001122";

const hubs: FollowerHub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});

describe("MEK-Org/rusa#1272 (a) dispatch to a stale-revision follower", () => {
  it("refuses new placement while an update trigger is active and reconciliation is unarmed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-1272-trigger-"));
    try {
      const store = new FollowerUpdateTriggerStore(dir);
      store.createTrigger({ targetSha: TARGET_SHA, branch: "staging" });
      const token = randomBytes(32).toString("hex");
      const hub = new FollowerHub(token, { triggerStore: store });
      hubs.push(hub);
      const origin = await hub.listen("127.0.0.1", 0);

      const response = await fetch(`${origin}/register`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          id: "edge",
          platform: "linux",
          pid: 4321,
          generation: "edge-process-one",
          protocolVersion: INSTANCE_PROTOCOL_VERSION,
          commitSha: STALE_SHA,
        }),
      });
      expect(response.status).toBe(200);
      expect(hub.getReconciliationStatus().armed).toBe(false);
      expect(hub.getReconciliationStatus().state).toBe("active");

      // Stale follower is pending update; placement must be refused.
      expect(() => hub.createHost("edge", "actor-1")).toThrow(/pending update to a1b2c3d4/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("permits placement when the follower is already on the target revision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-1272-current-"));
    try {
      const store = new FollowerUpdateTriggerStore(dir);
      store.createTrigger({ targetSha: TARGET_SHA, branch: "staging" });
      const token = randomBytes(32).toString("hex");
      const hub = new FollowerHub(token, { triggerStore: store });
      hubs.push(hub);
      const origin = await hub.listen("127.0.0.1", 0);

      const response = await fetch(`${origin}/register`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          id: "current-node",
          platform: "linux",
          pid: 4322,
          generation: "current-process-one",
          protocolVersion: INSTANCE_PROTOCOL_VERSION,
          commitSha: TARGET_SHA,
        }),
      });
      expect(response.status).toBe(200);

      expect(() => hub.createHost("current-node", "actor-current")).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("permits placement on a stale follower after a terminal update failure (broken updater does not strand actors)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-1272-failed-"));
    try {
      const store = new FollowerUpdateTriggerStore(dir);
      store.createTrigger({ targetSha: TARGET_SHA, branch: "staging" });
      // Follower attempted the update but failed terminally.
      store.recordFailure("edge-failed", TARGET_SHA, "git pull rejected");

      const token = randomBytes(32).toString("hex");
      const hub = new FollowerHub(token, { triggerStore: store });
      hubs.push(hub);
      const origin = await hub.listen("127.0.0.1", 0);

      const response = await fetch(`${origin}/register`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          id: "edge-failed",
          platform: "linux",
          pid: 4323,
          generation: "edge-process-failed",
          protocolVersion: INSTANCE_PROTOCOL_VERSION,
          commitSha: STALE_SHA,
        }),
      });
      expect(response.status).toBe(200);

      // Terminal failure recorded on active trigger: gate lifts, dispatch proceeds on old revision.
      expect(() => hub.createHost("edge-failed", "actor-fallback")).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses placement while an update is actively in progress on the follower", async () => {
    const token = randomBytes(32).toString("hex");
    const hub = new FollowerHub(token);
    hubs.push(hub);
    const origin = await hub.listen("127.0.0.1", 0);

    const response = await fetch(`${origin}/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        id: "draining-node",
        platform: "linux",
        pid: 4324,
        generation: "draining-process",
        protocolVersion: INSTANCE_PROTOCOL_VERSION,
        commitSha: TARGET_SHA,
      }),
    });
    expect(response.status).toBe(200);

    // Trigger update on follower so status is active (pending/draining).
    hub.updateFollower("draining-node", { targetSha: TARGET_SHA, branch: "staging" });
    expect(() => hub.createHost("draining-node", "actor-draining")).toThrow(
      /update is in progress/i
    );
  });
});

/** In-memory actor channel; stands in for the follower-side host connection. */
class SyntheticChannel extends EventEmitter implements ActorChannel {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  updateRestart = false;
  readonly nodeId = "edge";
  readonly sent: LeaderCommand[] = [];

  send(message: LeaderCommand, callback: (error: Error | null) => void): boolean {
    if (!this.connected) {
      callback(new Error("Remote instance actor disconnected"));
      return false;
    }
    this.sent.push(message);
    callback(null);
    return true;
  }

  isUpdateRestart(): boolean {
    return this.updateRestart;
  }

  /** What RemoteInstance.close() synthesizes when the hub drops the follower. */
  followerProcessDied(options?: { updateRestart?: boolean }): void {
    this.connected = false;
    this.exitCode = -1;
    this.updateRestart = options?.updateRestart ?? true;
    this.emit("exit", -1, null);
  }
}

describe("MEK-Org/rusa#1272 (b) update restart ends an in-flight run", () => {
  it("books the run as an interruption, not a failed run with a parent notice, when exit is an update restart", async () => {
    const channel = new SyntheticChannel();
    const ends: ActorLifecycleEndEvent[] = [];
    const lifecycle = new ActorLifecycle([{ onEnd: (event) => void ends.push(event) }]);
    const handle = new ActorHandle({
      host: channel,
      bootstrap: { id: "actor-1", cwd: "/tmp/rusa-1272" },
      context: {
        lifecycle,
        onRuntimeStateChanged: () => {},
      } as unknown as ActorFactoryContext,
      snapshot: () => {
        throw new Error("snapshot not needed for this reproduction");
      },
      saveSession: () => {},
      onFailure: () => {},
    });

    channel.emit("message", {
      type: "runStart",
      runId: "run-1",
      selected: { provider: "test" },
      responsive: false,
    });
    expect(ends).toHaveLength(0);

    // Follower restart caused by update
    channel.followerProcessDied({ updateRestart: true });
    await handle.exited;

    const end = ends.find((event) => event.runId === "run-1");
    expect(end).toBeDefined();
    expect(end?.terminal.kind).toBe("abandoned");
    if (end?.terminal.kind === "abandoned") {
      expect(end.terminal.started).toBe(true);
      expect(end.terminal.reason).toBe("unreported");
    }
  });

  it("books the run as a failed result with parent notice when exit is not an update restart", async () => {
    const channel = new SyntheticChannel();
    const ends: ActorLifecycleEndEvent[] = [];
    const lifecycle = new ActorLifecycle([{ onEnd: (event) => void ends.push(event) }]);
    const handle = new ActorHandle({
      host: channel,
      bootstrap: { id: "actor-unrelated", cwd: "/tmp/rusa-1272" },
      context: {
        lifecycle,
        onRuntimeStateChanged: () => {},
      } as unknown as ActorFactoryContext,
      snapshot: () => {
        throw new Error("snapshot not needed for this reproduction");
      },
      saveSession: () => {},
      onFailure: () => {},
    });

    channel.emit("message", {
      type: "runStart",
      runId: "run-unrelated",
      selected: { provider: "test" },
      responsive: false,
    });
    expect(ends).toHaveLength(0);

    // Follower crash with NO update in flight
    channel.followerProcessDied({ updateRestart: false });
    await handle.exited;

    const end = ends.find((event) => event.runId === "run-unrelated");
    expect(end).toBeDefined();
    expect(end?.terminal.kind).toBe("result");
    if (end?.terminal.kind === "result") {
      expect(end.terminal.result.success).toBe(false);
      expect(end.terminal.result.exitCode).toBe(-1);
      expect(end.terminal.result.output).toBe("Remote actor exited (-1)");
    }
  });

  it("owes inbox reconciliation after an update restart and triggers exactly one re-queue on reattach", async () => {
    const channel = new SyntheticChannel();
    const ends: ActorLifecycleEndEvent[] = [];
    const lifecycle = new ActorLifecycle([{ onEnd: (event) => void ends.push(event) }]);
    const reconcileInboxSpy = vi.fn();
    const mockMesh = {
      reconcileActorInbox: reconcileInboxSpy,
    } as unknown as ActorMesh;

    const handle = new ActorHandle({
      host: channel,
      bootstrap: { id: "actor-reconcile", cwd: "/tmp/rusa-1272" },
      context: {
        lifecycle,
        mesh: mockMesh,
        onRuntimeStateChanged: () => {},
      } as unknown as ActorFactoryContext,
      snapshot: () => ({
        record: { id: "actor-reconcile", modelConfig: [] } as unknown as ActorRecord,
        prompt: "",
        mcpServers: [],
      }),
      saveSession: () => {},
      onFailure: () => {},
    });

    channel.emit("message", {
      type: "runStart",
      runId: "run-interrupted",
      selected: { provider: "test" },
      responsive: false,
    });

    // Update restart occurs
    channel.followerProcessDied({ updateRestart: true });
    await handle.exited;
    expect(reconcileInboxSpy).not.toHaveBeenCalled();

    // Reconnected channel rebinds
    const replacementChannel = new SyntheticChannel();
    handle.attachHost(replacementChannel);

    // Exactly one re-queue triggered through reconcileActorInbox
    expect(reconcileInboxSpy).toHaveBeenCalledTimes(1);
    expect(reconcileInboxSpy).toHaveBeenCalledWith("actor-reconcile");
  });
});

describe("MEK-Org/rusa#1272 unchanged reconciliation and admission behaviors", () => {
  it("preserves the boot-time hold on automatic reconciliation until armed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-1272-boot-"));
    try {
      const store = new FollowerUpdateTriggerStore(dir);
      store.createTrigger({ targetSha: TARGET_SHA, branch: "staging" });
      const token = randomBytes(32).toString("hex");
      const hub = new FollowerHub(token, { triggerStore: store });
      hubs.push(hub);
      const origin = await hub.listen("127.0.0.1", 0);

      const response = await fetch(`${origin}/register`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          id: "lagging-boot-follower",
          platform: "linux",
          pid: 4325,
          generation: "boot-process",
          protocolVersion: INSTANCE_PROTOCOL_VERSION,
          commitSha: STALE_SHA,
        }),
      });
      expect(response.status).toBe(200);

      // 1. Automatic reconciliation is held back while leader boot is incomplete
      expect(hub.getReconciliationStatus().armed).toBe(false);
      expect(hub.getFollowerUpdateStatus("lagging-boot-follower")).toBeUndefined();

      // 2. Arming dispatches automatic reconciliation to connected followers
      hub.armReconciliation();
      expect(hub.getReconciliationStatus().armed).toBe(true);
      expect(hub.getFollowerUpdateStatus("lagging-boot-follower")?.status).toBe("pending");
      expect(hub.getFollowerUpdateStatus("lagging-boot-follower")?.newSha).toBe(TARGET_SHA);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves retained-admission drop and inbox re-queue when an unclaimed ticket is dropped", async () => {
    const channel = new SyntheticChannel();
    const ends: ActorLifecycleEndEvent[] = [];
    const lifecycle = new ActorLifecycle([{ onEnd: (event) => void ends.push(event) }]);
    const reconcileInboxSpy = vi.fn();
    const mockMesh = {
      reconcileActorInbox: reconcileInboxSpy,
      hasActiveCapability: () => false,
    } as unknown as ActorMesh;

    const gateHandle = {
      started: false,
      cancel: vi.fn(),
      result: new Promise(() => {}),
    };

    const handle = new ActorHandle({
      host: channel,
      bootstrap: { id: "actor-retained", cwd: "/tmp/rusa-1272" },
      context: {
        lifecycle,
        mesh: mockMesh,
        onRuntimeStateChanged: () => {},
        gate: vi.fn(() => gateHandle),
      } as unknown as ActorFactoryContext,
      snapshot: () => ({
        record: { id: "actor-retained", modelConfig: [] } as unknown as ActorRecord,
        prompt: "",
        mcpServers: [],
      }),
      saveSession: () => {},
      onFailure: () => {},
    });

    // Simulate leader admitting run #42
    channel.emit("message", {
      type: "queued",
      runId: "run-42",
      mode: "normal",
      priority: "normal",
    });

    // Follower requests admission, creating a gate entry
    channel.emit("message", {
      type: "request",
      requestId: 101,
      request: {
        op: "admit",
        candidates: [{ provider: "mock", model: "mock" }],
        responsive: false,
      },
    });

    // Allow async admit handler to register the gate
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Channel disconnects while admission is retained
    channel.followerProcessDied({ updateRestart: false });
    await handle.exited;

    // Follower reattaches with a fresh generation that does not reclaim the admission
    const replacementChannel = new SyntheticChannel();
    handle.attachHost(replacementChannel);

    // Initial state report from follower does not report run-42, dropping the ticket
    replacementChannel.emit("message", {
      type: "state",
      state: "idle",
      generation: "new-gen",
      ready: true,
      hasQueued: false,
    });

    // Allow async dropRetainedAdmission to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    const dropEnd = ends.find((event) => event.runId === "run-42");
    expect(dropEnd).toBeDefined();
    expect(dropEnd?.terminal.kind).toBe("abandoned");
    if (dropEnd?.terminal.kind === "abandoned") {
      expect(dropEnd.terminal.started).toBe(false);
      expect(dropEnd.terminal.reason).toBe("start-cancelled");
    }
    // Dropping an unclaimed retained admission re-queues via reconcileActorInbox
    expect(reconcileInboxSpy).toHaveBeenCalledTimes(1);
    expect(reconcileInboxSpy).toHaveBeenCalledWith("actor-retained");
  });
});
