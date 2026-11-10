// MEK-Org/rusa#1272: a leader started a run on a follower still on the old
// revision while that follower's update was persisted, then the update's
// restart killed the run and the leader booked it as a failed run with a
// parent notice.
//
// (a) Hold: placement always succeeds, but run admission on a follower waits
//     while its own update is pending or running, or during the boot window.
//     A terminal outcome, read from the reconciler's record, releases it and
//     its actors are dispatched again.
// (b) Attribution: an exit while the follower drains or restarts for an
//     update is an interruption, and the work runs on the new revision.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorLifecycleEndEvent } from "../actor/actor-lifecycle.js";
import { ActorMesh } from "../actor/actor-mesh.js";
import { InMemoryCapabilityGrantStore } from "../actor/capability-grants.js";
import {
  InMemoryEventSourceOwnerStore,
  InMemoryEventSourceSubscriptionStore,
} from "../actor/event-subscriptions.js";
import { ExternalRootDriver } from "../actor/external-root-driver.js";
import { runMigrations } from "../db/migrations/runner.js";
import { PrincipalRepository } from "../db/repositories/principal-repository.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import type { Logger } from "../observability/logger.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import { ActorHandle } from "./actor-handle.js";
import { type FollowerEvent, FollowerHub } from "./follower-hub.js";
import { FollowerInstance } from "./follower-instance.js";
import { registerFollowerRegistrationRecovery } from "./follower-registration-recovery.js";
import { FollowerUpdateTriggerStore } from "./follower-update-trigger-store.js";
import {
  type FollowerUpdateStatusPhase,
  INSTANCE_PROTOCOL_VERSION,
  type ProviderFactory,
} from "./protocol.js";

const TARGET_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const STALE_SHA = "0011223344556677889900aabbccddeeff001122";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function eventually(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function leaderHub(store?: FollowerUpdateTriggerStore, logger?: Logger) {
  const token = randomBytes(32).toString("hex");
  const hub = new FollowerHub(token, { triggerStore: store, logger });
  cleanups.push(() => hub.close());
  const origin = await hub.listen("127.0.0.1", 0);
  const post = (path: string, body: object, signal?: AbortSignal) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  const register = async (id: string, generation: string, commitSha?: string) => {
    const response = await post("/register", {
      id,
      platform: process.platform,
      pid: process.pid,
      generation,
      protocolVersion: INSTANCE_PROTOCOL_VERSION,
      ...(commitSha ? { commitSha } : {}),
    });
    expect(response.status).toBe(200);
    return { id, ...((await response.json()) as { session: string }) };
  };
  const reportStatus = async (
    session: { id: string; session: string },
    status: FollowerUpdateStatusPhase,
    extra: Record<string, unknown> = {}
  ) => {
    const response = await post("/events", {
      ...session,
      batchId: randomUUID(),
      events: [
        {
          eventId: randomUUID(),
          actorId: "$instance",
          message: { type: "update_status", updateId: "update-1", status, ...extra },
        },
      ],
    });
    expect(response.status).toBe(200);
  };
  return { hub, post, register, reportStatus };
}

function triggerStore(): FollowerUpdateTriggerStore {
  const store = new FollowerUpdateTriggerStore(tempDir("rusa-1272-trigger-"));
  store.createTrigger({ targetSha: TARGET_SHA, branch: "staging" });
  return store;
}

describe("MEK-Org/rusa#1272 (a) which followers the update holds", () => {
  it("holds a follower not on the target during the boot window, unless its outcome is terminal", async () => {
    const store = triggerStore();
    store.recordFailure("failed-edge", TARGET_SHA, "git pull rejected");
    // already_current records success before a registration refreshes commitSha,
    // and registration keeps commitSha only when it is a full SHA.
    store.recordSuccess("short-sha-edge", TARGET_SHA);
    const { hub, register } = await leaderHub(store);
    await register("stale-edge", "stale-one", STALE_SHA);
    await register("current-edge", "current-one", TARGET_SHA);
    await register("failed-edge", "failed-one", STALE_SHA);
    await register("short-sha-edge", "short-one");

    expect(hub.getReconciliationStatus().armed).toBe(false);
    expect(hub.isPlacementHeld("stale-edge")).toBe(true);
    expect(hub.isPlacementHeld("current-edge")).toBe(false);
    expect(hub.isPlacementHeld("failed-edge")).toBe(false);
    expect(hub.isPlacementHeld("short-sha-edge")).toBe(false);
    // Placement itself is never refused: only runs wait.
    expect(() => hub.createHost("stale-edge", "actor-stale")).not.toThrow();
  });

  it("once armed, holds only the follower with the pending attempt, and arming releases the rest", async () => {
    const store = triggerStore();
    const { hub, register } = await leaderHub(store);
    const released: string[] = [];
    hub.onPlacementReleased((followerId) => released.push(followerId));
    await register("edge-a", "a-one", STALE_SHA);
    await register("edge-b", "b-one", STALE_SHA);
    expect(hub.isPlacementHeld("edge-a")).toBe(true);
    expect(hub.isPlacementHeld("edge-b")).toBe(true);

    hub.armReconciliation();

    const pending = Object.entries(store.getActiveTrigger()?.attempts ?? {})
      .filter(([, attempt]) => attempt.status === "pending")
      .map(([id]) => id);
    expect(pending).toHaveLength(1);
    const [updating] = pending;
    const waiting = updating === "edge-a" ? "edge-b" : "edge-a";
    expect(hub.isPlacementHeld(updating as string)).toBe(true);
    // Waiting behind another follower's attempt holds nothing here.
    expect(hub.isPlacementHeld(waiting)).toBe(false);
    expect(released).toEqual([waiting]);
  });

  it("holds a follower running an update without a trigger, and releases it once on a terminal status", async () => {
    const { hub, register, reportStatus } = await leaderHub();
    const released: string[] = [];
    hub.onPlacementReleased((followerId) => released.push(followerId));
    const edge = await register("manual-edge", "manual-one", STALE_SHA);
    expect(hub.isPlacementHeld("manual-edge")).toBe(false);

    await reportStatus(edge, "building");
    expect(hub.isPlacementHeld("manual-edge")).toBe(true);
    await reportStatus(edge, "building", { step: "build" });
    expect(released).toEqual([]);

    await reportStatus(edge, "failed", { error: "build failed" });
    expect(hub.isPlacementHeld("manual-edge")).toBe(false);
    expect(released).toEqual(["manual-edge"]);
  });
});

/** A leader mesh with registration recovery and one in-process follower per generation. */
async function leaderWithFollowers(opts: { store?: FollowerUpdateTriggerStore }) {
  const home = tempDir("rusa-1272-e2e-");
  const records: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  let log!: Logger;
  const write = (event: string, fields?: Record<string, unknown>) =>
    records.push({ event, fields });
  log = { debug: write, info: write, warn: write, error: write, child: () => log };
  const leader = await leaderHub(opts.store, log);
  const { hub } = leader;

  const actors = new InMemoryActorRepository();
  const inboxDb = new Database(":memory:");
  runMigrations(inboxDb);
  cleanups.push(() => {
    inboxDb.close();
  });
  const inboxStore = new SqliteInboxRepository(inboxDb);
  const principals = new PrincipalRepository(inboxDb);
  principals.createUser({ email: "operator@example.test", createdAt: "t" });
  const starts: string[] = [];
  const ends: ActorLifecycleEndEvent[] = [];
  let releaseRuns: (() => void) | undefined;
  let blockRuns = false;
  const provider: ProviderFactory = (_bridge, _options, selected) => ({
    name: "update-fixture",
    providerName: "update-fixture",
    model: selected?.model,
    async run() {
      if (blockRuns) await new Promise<void>((resolve) => (releaseRuns = resolve));
      return { success: true, output: "done", exitCode: 0 };
    },
  });
  const mesh = new ActorMesh({
    actors,
    principals,
    rootId: "root",
    inboxStore,
    eventSourceOwners: new InMemoryEventSourceOwnerStore(),
    eventSourceSubscriptions: new InMemoryEventSourceSubscriptionStore(),
    capabilityGrants: new InMemoryCapabilityGrantStore(),
    recordChat: () => "message",
    supportsExecutionTarget: (target) => target.length > 0,
    createActor: (context) => {
      const target = context.record.executionConfig?.executionTarget;
      if (!target) throw new Error("fixture worker lacks a follower target");
      context.lifecycle.add({
        onStart: (event) => void starts.push(event.runId),
        onEnd: (event) => void ends.push(event),
      });
      return new ActorHandle({
        host: hub.createHost(target, context.record.id),
        context,
        isPlacementHeld: () => hub.isPlacementHeld(target),
        bootstrap: {
          id: context.record.id,
          cwd: home,
          modelConfig: context.record.modelConfig,
          providerOptions: { delayMs: 0 },
        },
        snapshot: () => ({ record: context.record, prompt: "update fixture" }),
        saveSession: () => {},
        onFailure: () => {},
        logger: log,
      });
    },
  });
  const root = {
    id: "root",
    parentId: null,
    charter: "root",
    executionConfig: { unsandboxed: true },
    status: "active" as const,
    createdAt: new Date().toISOString(),
  };
  actors.upsert(root);
  mesh.adopt(root, new ExternalRootDriver("root"));
  cleanups.push(registerFollowerRegistrationRecovery({ actors, hub, log, mesh }));

  /** Register a follower generation and pump its commands and events. */
  const follower = async (id: string, generation: string, commitSha: string) => {
    const events: FollowerEvent[] = [];
    const instance = new FollowerInstance(
      join(home, generation),
      false,
      (event) => events.push(event),
      provider
    );
    cleanups.push(() => instance.close());
    const session = await leader.register(id, generation, commitSha);
    const pump = async (done: () => boolean, turns = 60) => {
      for (let turn = 0; turn < turns && !done(); turn++) {
        if (events.length) {
          const response = await leader.post("/events", {
            ...session,
            batchId: randomUUID(),
            events: events.splice(0),
          });
          expect(response.status).toBe(200);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 50);
        try {
          const response = await leader.post("/poll", session, controller.signal);
          if (response.ok) {
            for (const command of (await response.json()) as Array<{
              actorId?: string;
              message: never;
            }>) {
              // The fixture follower has no updater; tests report its status.
              if (typeof command.actorId === "string") instance.dispatch(command as never);
            }
          }
        } catch (error) {
          if (!(error instanceof Error && error.name === "AbortError")) throw error;
        } finally {
          clearTimeout(timer);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (!done()) throw new Error("follower pump finished without reaching its condition");
    };
    return { session, instance, pump };
  };

  const deliver = (actorId: string) => {
    const [entry] = inboxStore.append([
      { actorId, source: "test:work", payload: { type: "test.work" } },
    ]);
    if (!entry) throw new Error("expected a durable work entry");
    mesh.dispatch(actorId);
    return entry;
  };
  const heldAdmissions = () =>
    records.filter((record) => record.event === "remote_admission_held_for_update").length;

  return {
    ...leader,
    actors,
    mesh,
    inboxStore,
    starts,
    ends,
    follower,
    deliver,
    heldAdmissions,
    blockRuns: () => {
      blockRuns = true;
    },
    releaseRun: () => releaseRuns?.(),
  };
}

describe("MEK-Org/rusa#1272 (a) held runs wait and then run once", () => {
  it("spawns onto a follower whose update is pending, holds its work, and runs it once when the update fails", async () => {
    const store = triggerStore();
    store.recordAttempt("edge", {
      status: "pending",
      targetSha: TARGET_SHA,
      lastAttemptAt: new Date().toISOString(),
    });
    const leader = await leaderWithFollowers({ store });
    leader.hub.armReconciliation();
    const edge = await leader.follower("edge", "edge-one", STALE_SHA);
    expect(leader.hub.isPlacementHeld("edge")).toBe(true);

    // Spawn succeeds and the child stays active rather than being retired.
    const workerId = leader.mesh.spawn({
      charter: "work on the edge follower",
      parentId: "root",
      modelConfig: [{ provider: "update-fixture", model: "test" }],
      executionTarget: "edge",
    });
    expect(leader.actors.get(workerId)?.status).toBe("active");
    expect(leader.mesh.get(workerId)).toBeDefined();

    const work = leader.deliver(workerId);
    await edge.pump(() => leader.heldAdmissions() > 0);
    expect(leader.starts).toEqual([]);
    expect(leader.inboxStore.read(workerId, work.id)?.handledAt).toBeNull();

    await leader.reportStatus(edge.session, "failed", { error: "build failed" });
    expect(store.hasFailed("edge", TARGET_SHA)).toBe(true);
    expect(leader.hub.isPlacementHeld("edge")).toBe(false);

    await edge.pump(() => leader.ends.some((event) => event.terminal.kind === "result"));
    expect(leader.starts).toHaveLength(1);
    const finished = leader.ends.filter((event) => event.terminal.kind === "result");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      runId: leader.starts[0],
      terminal: { kind: "result", result: { success: true, output: "done" } },
    });
    expect(leader.heldAdmissions()).toBe(1);
  }, 15_000);

  it("revives a thread onto a follower whose update is pending without rolling it back", async () => {
    const store = triggerStore();
    store.recordAttempt("edge", {
      status: "pending",
      targetSha: TARGET_SHA,
      lastAttemptAt: new Date().toISOString(),
    });
    const leader = await leaderWithFollowers({ store });
    leader.hub.armReconciliation();
    await leader.follower("edge", "edge-one", STALE_SHA);
    const record = {
      id: "retired-worker",
      parentId: "root",
      charter: "revived on the edge follower",
      executionConfig: { executionTarget: "edge" },
      modelConfig: [{ provider: "update-fixture", model: "test" }],
      status: "retired" as const,
      createdAt: new Date().toISOString(),
    };
    leader.actors.upsert(record);
    expect(leader.hub.isPlacementHeld("edge")).toBe(true);

    leader.mesh.reviveThread(record.id);

    expect(leader.actors.get(record.id)?.status).toBe("active");
    expect(leader.mesh.get(record.id)).toBeDefined();
  });
});

describe("MEK-Org/rusa#1272 (b) an update restart interrupts the run in flight", () => {
  it("books an exit while draining as an interruption and runs the work once on the new revision", async () => {
    const leader = await leaderWithFollowers({});
    const old = await leader.follower("edge", "edge-one", STALE_SHA);
    const worker = {
      id: "restart-worker",
      parentId: "root",
      charter: "interrupted by an update",
      executionConfig: { executionTarget: "edge" },
      modelConfig: [{ provider: "update-fixture", model: "test" }],
      status: "active" as const,
      createdAt: new Date().toISOString(),
    };
    leader.actors.upsert(worker);
    leader.mesh.rehydrate(worker);
    leader.blockRuns();
    const work = leader.deliver(worker.id);
    await old.pump(() => leader.starts.length > 0);

    await leader.reportStatus(old.session, "draining");
    // The updated process is a new generation on the target, which ends the old one.
    const updated = await leader.follower("edge", "edge-two", TARGET_SHA);

    await eventually(() => leader.ends.length > 0);
    expect(leader.ends[0]).toMatchObject({
      runId: leader.starts[0],
      terminal: { kind: "abandoned", reason: "unreported", started: true },
    });
    expect(leader.inboxStore.read(worker.id, work.id)?.handledAt).toBeNull();

    await updated.pump(() => leader.starts.length > 1);
    leader.releaseRun();
    await updated.pump(() => leader.ends.some((event) => event.terminal.kind === "result"));
    expect(leader.starts).toHaveLength(2);
    expect(leader.ends.filter((event) => event.terminal.kind === "abandoned")).toEqual([
      expect.objectContaining({
        runId: leader.starts[0],
        terminal: { kind: "abandoned", reason: "unreported", started: true },
      }),
    ]);
    expect(leader.ends.filter((event) => event.terminal.kind === "result")).toEqual([
      expect.objectContaining({
        runId: leader.starts[1],
        terminal: expect.objectContaining({
          kind: "result",
          result: expect.objectContaining({ success: true, output: "done" }),
        }),
      }),
    ]);
  }, 15_000);
});
