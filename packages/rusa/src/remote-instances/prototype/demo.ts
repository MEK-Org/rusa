import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import type { ActorRecord } from "../../actor/actor-record.js";
import { runMigrations } from "../../db/migrations/runner.js";
import { createLogger } from "../../observability/logger.js";
import type { CodingProvider } from "../../providers/types.js";
import { type EntityRef, type InstanceEvent, PrototypeInstance } from "./instance.js";

// This executable illustration uses real local SQLite stores, ActorMesh,
// RunManager and Actor. Only providers and peer transport are stand-ins.
const home = mkdtempSync(join(tmpdir(), "rusa-instance-prototype-"));
const logger = createLogger({ format: "json", context: { component: "instance-prototype" } });
const instances = new Map<string, PrototypeInstance>();
const online = new Set(["leader", "executor"]);
const outgoing: Array<{ origin: string; event: InstanceEvent }> = [];
const databases: Database.Database[] = [];
let leaveSelectedUnhandled = false;

function createInstance(id: string): PrototypeInstance {
  const db = new Database(join(home, `${id}.db`));
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  databases.push(db);
  const instance = new PrototypeInstance(id, {
    home: join(home, id),
    db,
    logger,
    publish: (event) => outgoing.push({ origin: id, event }),
    fetchMessage: async (requester, ref) => {
      if (!online.has(ref.instance)) throw new Error("Entity origin is offline");
      const origin = instances.get(ref.instance);
      if (!origin) throw new Error("Unknown entity origin");
      // A real authenticated peer authenticates the requester actor here.
      return origin.serveMessage(requester, ref);
    },
    provider: (actorId, selected): CodingProvider => ({
      name: "prototype",
      providerName: "prototype",
      model: selected.model,
      async run(options) {
        options.onPromptLaunched?.(options.prompt);
        const entries = instance.repositories.inbox.list(actorId).entries;
        instance.select(
          actorId,
          entries.map((entry) => entry.id)
        );
        const bodies: string[] = [];
        for (const entry of entries) {
          if (entry.payload.type === "mesh.message") {
            const message = await instance.readMessage(actorId, entry.payload.entity as EntityRef);
            bodies.push(message.body);
          }
        }
        await delay(20, undefined, { signal: options.signal });
        if (!leaveSelectedUnhandled)
          instance.markHandled(
            actorId,
            entries.map((entry) => entry.id)
          );
        return {
          success: true,
          exitCode: 0,
          output: JSON.stringify({ bodies, instance: id }),
        };
      },
    }),
  });
  instances.set(id, instance);
  return instance;
}

function record(id: string, parentId: string | null, peer: string): ActorRecord {
  return {
    id,
    parentId,
    charter: "Synthetic prototype actor",
    status: "active",
    createdAt: new Date().toISOString(),
    context: { type: "native" },
    modelConfig: [{ provider: "prototype", model: "synthetic" }],
    handles: [{ id: peer }],
  };
}

function deliver(): void {
  for (const queued of outgoing.splice(0)) {
    const target = queued.event.actorId === "parent" ? "leader" : "executor";
    if (!online.has(target)) {
      outgoing.push(queued);
      continue;
    }
    const instance = instances.get(target);
    if (!instance) throw new Error("Unknown event target");
    instance.receive(queued.origin, queued.event);
    // Deliberate replay: the destination's inbox deduplicates before waking.
    instance.receive(queued.origin, queued.event);
  }
}

async function settle(instance: PrototypeInstance, actorId: string): Promise<void> {
  // Bounded demo drain, not a claim that all production shutdown paths work.
  const deadline = Date.now() + 5000;
  do {
    await delay(25);
    const actor = instance.mesh.get(actorId);
    if (!actor?.isRunning && !actor?.isQueued) return;
  } while (Date.now() < deadline);
  throw new Error("Prototype run did not settle within five seconds");
}

try {
  const leader = createInstance("leader");
  let executor = createInstance("executor");
  const parent = record("parent", null, "worker");
  const worker = record("worker", "parent", "parent");
  for (const instance of [leader, executor]) {
    // Seed identities before their mutually referring handles (existing FKs).
    instance.repositories.actors.upsert({ ...parent, handles: [] });
    instance.repositories.actors.upsert({ ...worker, handles: [] });
    instance.install(parent, instance === leader);
    instance.install(worker, instance === executor);
    instance.observeQuota({
      provider: "prototype",
      observedAt: new Date().toISOString(),
      intervalMs: 5,
    });
  }

  const first = leader.sendMessage("parent", "worker", "First instruction, cached eagerly");
  const second = leader.sendMessage("parent", "worker", "Next instruction, also cached");
  await executor.readMessage("worker", first);
  await executor.readMessage("worker", second);
  // The leader is now unreachable. Deliver just the previously sent first event.
  const later = outgoing.pop();
  online.delete("leader");
  deliver();
  await settle(executor, "worker");
  logger.info("demo_finished_without_leader", {
    snapshot: executor.snapshot(),
    outgoing: outgoing.length,
  });
  if (later) outgoing.push(later);
  deliver();
  await settle(executor, "worker");
  logger.info("demo_next_run_without_leader", {
    snapshot: executor.snapshot(),
    outgoing: outgoing.length,
  });

  // Receipt survives even though the body was never fetched before the gap.
  // Pretend these bytes were queued in transport before the origin went offline.
  const uncached = leader.sendMessage("parent", "worker", "Body available only on origin");
  deliver();
  await settle(executor, "worker");
  logger.info("demo_uncached_body_offline", {
    snapshot: executor.snapshot(),
    bodyCached: !!executor.repositories.meshChat.getById(uncached.id),
    queuedFailureEvents: outgoing.map(({ event }) => event),
  });

  online.add("leader");
  await executor.readMessage("worker", uncached);
  executor.resume();
  await settle(executor, "worker");
  logger.info("demo_body_fetched_after_reconnect", { snapshot: executor.snapshot() });
  // The ordinary failure notification now reaches the parent's local inbox.
  deliver();
  await settle(leader, "parent");

  // Demonstrate that the established selected-work recovery budget is local.
  // No event ACK is involved, and durable counts survive coordinator recreation.
  leaveSelectedUnhandled = true;
  const retry = leader.sendMessage("parent", "worker", "Selected but deliberately left unhandled");
  await executor.readMessage("worker", retry);
  online.delete("leader");
  deliver();
  await settle(executor, "worker");
  const countsBefore = [...executor.repositories.actorRuns.completedFocusEntryCounts("worker")];
  executor.close();
  instances.delete("executor");
  // The DB remains open: recreate the coordinator over the same durable stores.
  // createInstance opens a second handle to that same file, as a restart would.
  executor = createInstance("executor");
  executor.install(parent, false);
  executor.install(worker, true);
  executor.resume();
  await settle(executor, "worker");
  logger.info("demo_recovery_budget_after_recreation", {
    countsBefore,
    countsAfter: [...executor.repositories.actorRuns.completedFocusEntryCounts("worker")],
    snapshot: executor.snapshot(),
  });

  logger.info("demo_artifacts", { home });
} finally {
  for (const instance of instances.values()) instance.close();
  for (const db of databases) db.close();
}
