// Reproduction for MEK-Org/rusa#1272 — step 1 (failing synthetic tests only).
//
// Deploy observation: the new leader dispatched a run to a follower still on
// the old revision while an update trigger for it was already persisted; two
// seconds later it told the follower to update, and the follower's restart
// killed the run. The leader booked it as a failed run and notified the
// parent, rather than treating it as an interruption.
//
// Both halves are reproduced here against disposable followers. Each test
// asserts the behavior the system should have; both fail on current staging.

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActorLifecycle, type ActorLifecycleEndEvent } from "../actor/actor-lifecycle.js";
import type { ActorFactoryContext } from "../actor/actor-mesh.js";
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
      // The update trigger is already persisted when the new leader boots.
      store.createTrigger({ targetSha: TARGET_SHA, branch: "staging" });
      const token = randomBytes(32).toString("hex");
      const hub = new FollowerHub(token, { triggerStore: store });
      hubs.push(hub);
      const origin = await hub.listen("127.0.0.1", 0);

      // The follower registers on the OLD revision while the trigger for the
      // NEW one is outstanding.
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
      // The leader is still booting: automatic reconciliation has not armed.
      expect(hub.getReconciliationStatus().armed).toBe(false);
      expect(hub.getReconciliationStatus().state).toBe("active");

      // The follower is about to be restarted onto the new revision, so new
      // work must not be placed on it. Today this succeeds, which is the
      // dispatch half of the race.
      expect(() => hub.createHost("edge", "actor-1")).toThrow(/update/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** In-memory actor channel; stands in for the follower-side host connection. */
class SyntheticChannel extends EventEmitter implements ActorChannel {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
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
  /** What RemoteInstance.close() synthesizes when the hub drops the follower. */
  followerProcessDied(): void {
    this.connected = false;
    this.exitCode = -1;
    this.emit("exit", -1, null);
  }
}

describe("MEK-Org/rusa#1272 (b) update restart ends an in-flight run", () => {
  it("books the run as an interruption, not a failed run with a parent notice", async () => {
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

    // The leader admits the run and the follower starts it.
    channel.emit("message", {
      type: "runStart",
      runId: "run-1",
      selected: { provider: "test" },
      responsive: false,
    });
    expect(ends).toHaveLength(0);

    // The follower's updater drains in-flight actors (5s default) and restarts
    // the process; the leader's hub drops the follower and each host channel
    // receives exit code -1.
    channel.followerProcessDied();
    await handle.exited;

    const end = ends.find((event) => event.runId === "run-1");
    expect(end).toBeDefined();
    // A planned update restart is an interruption, not a provider failure. The
    // run must not take the failed-result route that books a failed run and
    // mechanically notifies the parent. Today it is booked
    // { kind: "result", result: { success: false, exitCode: -1, ... } }.
    expect(end?.terminal.kind).not.toBe("result");
    if (end?.terminal.kind === "abandoned") {
      expect(end.terminal.started).toBe(true);
    }
  });
});
