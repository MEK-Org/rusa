import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
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
import { INSTANCE_PROTOCOL_VERSION, type ProviderFactory } from "./protocol.js";

const homes: string[] = [];
const hubs: FollowerHub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function testLogger(records: Array<{ event: string; fields?: Record<string, unknown> }>): Logger {
  let logger!: Logger;
  const write = (event: string, fields?: Record<string, unknown>) =>
    records.push({ event, fields });
  logger = { debug: write, info: write, warn: write, error: write, child: () => logger };
  return logger;
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for relaunch recovery");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("follower registration recovery", () => {
  it("recovers one gap wake through replacement registration without a second dispatch (#891)", async () => {
    const home = mkdtempSync(join(tmpdir(), "rusa-follower-relaunch-"));
    homes.push(home);
    const token = randomBytes(32).toString("hex");
    const records: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const log = testLogger(records);
    const hub = new FollowerHub(token, { logger: log });
    hubs.push(hub);
    const origin = await hub.listen("127.0.0.1", 0);
    const post = (path: string, body: object) =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const register = async (generation: string) => {
      const response = await post("/register", {
        id: "relaunch-follower",
        platform: process.platform,
        pid: process.pid,
        generation,
        protocolVersion: INSTANCE_PROTOCOL_VERSION,
      });
      expect(response.status).toBe(200);
      return {
        id: "relaunch-follower",
        ...((await response.json()) as { session: string }),
      };
    };

    const actors = new InMemoryActorRepository();
    const inboxDb = new Database(":memory:");
    runMigrations(inboxDb);
    const inboxStore = new SqliteInboxRepository(inboxDb);
    const principals = new PrincipalRepository(inboxDb);
    principals.createUser({ email: "operator@example.test", createdAt: "t" });
    const lifecycle: Array<{ type: "start" | "end"; runId: string }> = [];
    const provider: ProviderFactory = (_bridge, _options, selected) => ({
      name: "relaunch-fixture",
      providerName: "relaunch-fixture",
      model: selected?.model,
      async run() {
        return { success: true, output: "recovered", exitCode: 0 };
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
      createActor: (context) => {
        const target = context.record.executionConfig?.executionTarget;
        if (!target) throw new Error("relaunch fixture worker lacks a follower target");
        context.lifecycle.add({
          onStart: (event) => {
            lifecycle.push({ type: "start", runId: event.runId });
          },
          onEnd: (event) => {
            lifecycle.push({ type: "end", runId: event.runId });
          },
        });
        return new ActorHandle({
          host: hub.createHost(target, context.record.id),
          context,
          bootstrap: {
            id: context.record.id,
            cwd: home,
            modelConfig: context.record.modelConfig,
            providerOptions: { delayMs: 0 },
          },
          snapshot: () => ({ record: context.record, prompt: "relaunch recovery fixture" }),
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
    const worker = {
      id: "relaunch-worker",
      parentId: "root",
      charter: "recover durable gap work",
      executionConfig: { executionTarget: "relaunch-follower" },
      modelConfig: [{ provider: "relaunch-fixture", model: "test" }],
      status: "active" as const,
      createdAt: new Date().toISOString(),
    };
    actors.upsert(worker);
    const unregisterRecovery = registerFollowerRegistrationRecovery({ actors, hub, log, mesh });
    const disableRegistrationRecovery =
      process.env.RUSA_TEST_DISABLE_FOLLOWER_REGISTRATION_RECOVERY === "1";

    const aEvents: FollowerEvent[] = [];
    const followerA = new FollowerInstance(
      join(home, "follower-a"),
      false,
      (event) => aEvents.push(event),
      provider
    );
    const a = await register("generation-a");
    const aPoll = await post("/poll", a);
    expect(aPoll.status).toBe(200);
    for (const command of (await aPoll.json()) as Array<{ actorId: string; message: never }>) {
      followerA.dispatch(command);
    }
    await eventually(() => aEvents.length > 0);
    const aEventsResponse = await post("/events", {
      ...a,
      batchId: randomUUID(),
      events: aEvents.splice(0),
    });
    expect(aEventsResponse.status).toBe(200);
    expect(followerA.actorIds).toEqual([worker.id]);

    const unregistered = await post("/unregister", a);
    expect(unregistered.status).toBe(200);
    inboxStore.append([
      {
        actorId: worker.id,
        source: "test:gap-wake",
        payload: { type: "test.work", priority: "responsive" },
      },
    ]);
    expect(mesh.dispatch(worker.id)).toBe(true);
    await eventually(() => records.some((record) => record.event === "remote_wake_dropped"));
    expect(lifecycle).toEqual([]);

    // The normal assertion below is also a reproducible red control: this
    // test-only switch removes the actual registration listener just before B
    // registers, so B's otherwise identical command/event pump never obtains
    // a host or recovers the durable row. The ordinary run keeps it installed.
    if (disableRegistrationRecovery) unregisterRecovery();

    const bEvents: FollowerEvent[] = [];
    const followerB = new FollowerInstance(
      join(home, "follower-b"),
      false,
      (event) => bEvents.push(event),
      provider
    );
    expect(followerB.actorIds).toEqual([]);
    const b = await register("generation-b");

    for (
      let turn = 0;
      turn < 30 && lifecycle.filter((event) => event.type === "end").length === 0;
      turn++
    ) {
      if (bEvents.length) {
        const response = await post("/events", {
          ...b,
          batchId: randomUUID(),
          events: bEvents.splice(0),
        });
        expect(response.status).toBe(200);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        const response = await fetch(`${origin}/poll`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(b),
          signal: controller.signal,
        });
        if (response.ok) {
          for (const command of (await response.json()) as Array<{
            actorId: string;
            message: never;
          }>) {
            followerB.dispatch(command);
          }
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) throw error;
      } finally {
        clearTimeout(timer);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(followerB.actorIds).toEqual([worker.id]);
    const starts = lifecycle.filter((event) => event.type === "start");
    const ends = lifecycle.filter((event) => event.type === "end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.runId).toBe(starts[0]?.runId);
    // The fixture provider does no inbox mutation; seeing this row proves the
    // registration-driven run read the durable gap work rather than a test
    // dispatch inventing new work after B registered.
    const [gapWake] = inboxStore.list(worker.id, { status: "unhandled" }).entries;
    expect(gapWake?.seenAt).not.toBeNull();
    if (!disableRegistrationRecovery) unregisterRecovery();

    followerA.close();
    followerB.close();
    inboxDb.close();
  }, 10_000);
});
