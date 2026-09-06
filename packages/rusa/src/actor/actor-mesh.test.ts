import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import type { IssueClient } from "../gitops/issue-client.js";
import { MESH_SYSTEM, resolveStampedAuthor } from "../mcp/stamp.js";
import { createTrackerMcpServer } from "../mcp/tracker-mcp.js";
import { FakeProvider } from "../providers/fake-provider.js";
import type { RawProviderModelConfig } from "../providers/model-config.js";
import { normalizeModelEffortSelection } from "../providers/reasoning-effort.js";
import type { CodingProvider, RunResult } from "../providers/types.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import { Actor } from "./actor.js";
import type {
  ActorFactoryContext,
  ActorMeshOptions,
  EventDeliveryOptions,
  LiveObligationSummary,
  RetireCleanup,
  SpawnRequest,
} from "./actor-mesh.js";
import { ActorMesh, RetirementBlockedError } from "./actor-mesh.js";
import type { ActorRecord } from "./actor-record.js";
import { RunStartCancelledError, type RunStartHandle } from "./concurrency-limiter.js";
import type { EventResource } from "./event-subscriptions.js";
import { ExternalRootDriver } from "./external-root-driver.js";
import { routeRunFailure } from "./failure-sink.js";
import type {
  InboxActorWork,
  InboxEntry,
  InboxListOptions,
  InboxPage,
  InboxPayload,
  InboxStore,
} from "./inbox-store.js";
import type { MeshEventInput, MeshEventSink } from "./mesh-events.js";
import type { ScheduledMessage, ScheduledMessageScheduler } from "./os-scheduler.js";
import { type PoolLaneCandidate, ProviderPacer, submitPoolGate } from "./provider-pacer.js";
import { buildWorkerPrompt, resolveHandleLabels } from "./worker-prompt.js";

const DEBOUNCE = 10;

function createMemoryInboxStore(): InboxStore & { entries: InboxEntry[] } {
  const entries: InboxEntry[] = [];
  const pendingActors = (predicate: (entry: InboxEntry) => boolean): InboxActorWork[] => {
    const priorities = new Map<string, InboxActorWork["priority"]>();
    for (const entry of entries.filter(predicate)) {
      const priority = entry.payload.priority === "responsive" ? "responsive" : "normal";
      if (priority === "responsive" || !priorities.has(entry.actorId)) {
        priorities.set(entry.actorId, priority);
      }
    }
    return [...priorities].map(([actorId, priority]) => ({ actorId, priority }));
  };
  return {
    entries,
    append: (inputs) => {
      // Mirrors InboxRepository: the insert is `ON CONFLICT(id) DO NOTHING` and
      // the return is filtered to rows actually inserted, so a caller-supplied
      // duplicate id is suppressed and reported as "nothing new". Without this
      // the fake silently grants at-least-once where the real store gives
      // exactly-once, and dedupe-dependent behaviour cannot be tested here.
      const inserted = inputs
        .map((input, index) => ({
          id: input.id ?? `entry-${entries.length + index + 1}`,
          actorId: input.actorId,
          source: input.source,
          deliveredAt: input.deliveredAt ?? new Date("2026-01-01T00:00:00Z"),
          seenAt: null,
          handledAt: null,
          handledNote: null,
          payload: input.payload,
        }))
        .filter((row) => !entries.some((existing) => existing.id === row.id));
      entries.push(...inserted);
      return inserted;
    },
    list: (actorId: string, options: InboxListOptions = {}): InboxPage => {
      const status = options.status ?? "unhandled";
      let matched = entries.filter((entry) => entry.actorId === actorId);
      if (status === "unhandled") matched = matched.filter((entry) => entry.handledAt === null);
      else if (status === "handled") matched = matched.filter((entry) => entry.handledAt !== null);
      if (options.source !== undefined) {
        matched = matched.filter((entry) => entry.source === options.source);
      }
      matched = [...matched].reverse();
      return {
        entries: matched,
        unhandledCount: entries.filter(
          (entry) => entry.actorId === actorId && entry.handledAt === null
        ).length,
        nextCursor: null,
      };
    },
    read: (actorId: string, entryId: string) =>
      entries.find((entry) => entry.actorId === actorId && entry.id === entryId) ?? null,
    countUnhandled: (actorId: string) =>
      entries.filter((entry) => entry.actorId === actorId && entry.handledAt === null).length,
    actorsWithUnhandled: () => pendingActors((entry) => entry.handledAt === null),
    actorsWithUnseen: () =>
      pendingActors((entry) => entry.handledAt === null && entry.seenAt === null),
    markSeen: (actorId, seenAt = new Date("2026-01-01T00:00:00Z")) => {
      const unseen = entries.filter(
        (entry) => entry.actorId === actorId && entry.seenAt === null && entry.handledAt === null
      );
      for (const entry of unseen) entry.seenAt = seenAt;
      return unseen;
    },
    markHandled: (actorId, entryIds, handledAt = new Date("2026-01-01T00:00:00Z")) => {
      return entryIds.map((id) => {
        const entry = entries.find(
          (candidate) => candidate.actorId === actorId && candidate.id === id
        );
        if (!entry) throw new Error("inbox entry not found");
        const alreadyHandled = entry.handledAt !== null;
        if (!entry.handledAt) entry.handledAt = handledAt;
        return { id, handledAt: entry.handledAt, alreadyHandled };
      });
    },
  };
}

/** A provider whose runs block until released — for concurrency assertions. */
function deferredProvider() {
  const gates: Array<(r: RunResult) => void> = [];
  const provider: CodingProvider = {
    name: "deferred",
    providerName: "deferred",
    run: () =>
      new Promise<RunResult>((resolve) => {
        gates.push(resolve);
      }),
  };
  return {
    provider,
    pending: () => gates.length,
    releaseAll: () => {
      for (const g of gates.splice(0)) g({ success: true, output: "", exitCode: 0 });
    },
  };
}

function setup(
  opts: {
    maxConcurrent?: number;
    sharedProvider?: CodingProvider;
    onRetire?: (record: { id: string }) => void;
    onSpawn?: (record: { id: string }) => void;
    onRevive?: (record: { id: string }) => void;
    retireCleanups?: RetireCleanup[];
    isHalted?: (provider?: string) => boolean;
    isShuttingDown?: () => boolean;
    events?: MeshEventSink;
    recordChat?: (opts: {
      id?: string;
      senderId: string;
      recipientId: string;
      body: string;
      sessionId?: string;
    }) => string;
    idgen?: () => string;
    onYield?: (actorId: string, ctx: { notifyingParent: boolean }) => string | null | undefined;
    recordRunYield?: ActorMeshOptions["recordRunYield"];
    inboxStore?: InboxStore;
    onInboxEntriesSeen?: ActorMeshOptions["onInboxEntriesSeen"];
    grantableCapabilities?: ReadonlySet<string>;
    validateSpawn?: ActorMeshOptions["validateSpawn"];
    validateModel?: ActorMeshOptions["validateModel"];
    onModelSet?: ActorMeshOptions["onModelSet"];
    onQueued?: ActorMeshOptions["onQueued"];
    createActor?: ActorMeshOptions["createActor"];
    rootId?: string;
    obligations?: ActorMeshOptions["obligations"];
    configuredEventSources?: ActorMeshOptions["configuredEventSources"];
    providerGate?: ActorMeshOptions["providerGate"];
    scheduledMessages?: FakeScheduledMessageScheduler;
    actors?: InMemoryActorRepository;
    withTransaction?: ActorMeshOptions["withTransaction"];
  } = {}
) {
  const registry = opts.actors ?? new InMemoryActorRepository();
  const providers = new Map<string, CodingProvider>();
  const logs: string[] = [];
  let seq = 0;
  let chatSeq = 0;
  const scheduledMessages = opts.scheduledMessages ?? new FakeScheduledMessageScheduler();

  const mesh = new ActorMesh({
    actors: registry,
    rootId: opts.rootId ?? "root",
    validateSpawn: opts.validateSpawn,
    validateModel: opts.validateModel,
    onModelSet: opts.onModelSet,
    onQueued: opts.onQueued,
    maxConcurrent: opts.maxConcurrent ?? 4,
    isHalted: opts.isHalted,
    isShuttingDown: opts.isShuttingDown,
    events: opts.events,
    recordChat: opts.recordChat ?? (() => `message-${++chatSeq}`),
    inboxStore: opts.inboxStore ?? createMemoryInboxStore(),
    obligations: opts.obligations,
    configuredEventSources: opts.configuredEventSources,
    scheduledMessages,
    withTransaction: opts.withTransaction,
    onInboxEntriesSeen: opts.onInboxEntriesSeen,
    grantableCapabilities: opts.grantableCapabilities,
    idgen: opts.idgen ?? (() => `t${++seq}`),
    onYield: opts.onYield,
    recordRunYield: opts.recordRunYield,
    now: () => "2026-01-01T00:00:00Z",
    onRetire: opts.onRetire,
    onSpawn: opts.onSpawn,
    onRevive: opts.onRevive,
    retireCleanups: opts.retireCleanups,
    providerGate: opts.providerGate,
    log: (m) => logs.push(m),
    createActor: (ctx) => {
      if (opts.createActor) return opts.createActor(ctx);
      let actor!: Actor;
      const sharedProvider = opts.sharedProvider;
      const provider: CodingProvider =
        sharedProvider !== undefined
          ? {
              ...sharedProvider,
              run: async (runOpts) => {
                const ids =
                  opts.inboxStore?.list(ctx.record.id).entries.map((entry) => entry.id) ?? [];
                if (ids.length > 0) mesh.selectInboxEntries(ctx.record.id, ids);
                const result = await sharedProvider.run(runOpts);
                if (result.success) actor.declareYield();
                return result;
              },
            }
          : new FakeProvider(() => {
              const ids =
                opts.inboxStore?.list(ctx.record.id).entries.map((entry) => entry.id) ?? [];
              if (ids.length > 0) mesh.selectInboxEntries(ctx.record.id, ids);
              actor.declareYield();
              return {};
            });
      providers.set(ctx.record.id, provider);
      actor = new Actor({
        id: ctx.record.id,
        cwd: `/tmp/${ctx.record.id}`,
        modelConfig: [{ provider: provider.providerName }],
        resolveProvider: () => provider,
        mcpServers: [],
        loadSessionId: () => ctx.getRecord()?.sessionId,
        saveSessionId: (id) => registry.patch(ctx.record.id, { sessionId: id }),
        buildPrompt: () => {
          const r = ctx.getRecord();
          if (!r) return { prompt: "No active thread record." };
          return {
            prompt: buildWorkerPrompt(r.charter, {
              threadId: r.id,
              parentId: r.parentId ?? "human",
              handles: resolveHandleLabels(r.handles, (hid) => registry.get(hid)?.charter),
            }),
          };
        },
        gate: ctx.gate,
        beforeRun: ctx.beforeRun,
        onQueued: ctx.onQueued,
        // Mirrors the production onRunStart wiring in start.ts (#199): apply a
        // pending model/provider/effort tuple before this run's own dispatch,
        // the same way start.ts calls `mesh.applyPendingModel` there.
        onRunStart: () => mesh.applyPendingModel(ctx.record.id),
        onRunEnd: ctx.onRunEnd,
        onRuntimeStateChanged: ctx.onRuntimeStateChanged,
        debounceMs: DEBOUNCE,
      });
      return actor;
    },
  });

  // Adopt a root so workers can message it.
  let root!: Actor;
  const rootProvider = new FakeProvider(() => {
    root.declareYield();
    return {};
  });
  const rootId = opts.rootId ?? "root";
  providers.set(rootId, rootProvider);
  root = new Actor({
    id: rootId,
    cwd: `/tmp/${rootId}`,
    modelConfig: [{ provider: rootProvider.providerName }],
    resolveProvider: () => rootProvider,
    mcpServers: [],
    loadSessionId: () => registry.get(rootId)?.sessionId,
    saveSessionId: (id) => registry.patch(rootId, { sessionId: id }),
    buildPrompt: () => ({ prompt: "Work from your inbox." }),
    onQueued: (context) => mesh.actorQueued(rootId, context),
    onRunStart: () => mesh.applyPendingModel(rootId),
    onRunEnd: () => mesh.finishInboxRun(rootId),
    onRuntimeStateChanged: (state) => mesh.actorRuntimeStateChanged(rootId, state),
    debounceMs: DEBOUNCE,
  });
  mesh.adopt(
    {
      id: rootId,
      charter: "root",
      parentId: null,
      isRoot: true,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    },
    root
  );

  const rawSpawn = mesh.spawn.bind(mesh);
  const testMesh = mesh as unknown as ActorMesh & {
    spawn: (req: Partial<SpawnRequest> & { charter: string; parentId: string }) => string;
  };
  testMesh.spawn = (req: Partial<SpawnRequest> & { charter: string; parentId: string }) =>
    rawSpawn({
      modelConfig: { provider: "claude", model: "claude-sonnet-4-6" },
      ...req,
    } as SpawnRequest);

  const tick = () => vi.advanceTimersByTimeAsync(DEBOUNCE + 1);
  const fake = (id: string) => providers.get(id) as FakeProvider;
  return {
    registry,
    mesh: testMesh,
    rawSpawn,
    providers,
    root,
    logs,
    tick,
    fake,
    scheduledMessages,
  };
}

class FakeScheduledMessageScheduler implements ScheduledMessageScheduler {
  messageDeliveries = new Map<string, ScheduledMessage>();
  scheduleMessageDeliveryImpl?: (message: ScheduledMessage) => void;

  scheduleMessageDelivery(message: ScheduledMessage): void {
    this.scheduleMessageDeliveryImpl?.(message);
    this.messageDeliveries.set(message.id, structuredClone(message));
  }
  cancelMessageDelivery(id: string): void {
    this.messageDeliveries.delete(id);
  }
  listMessageDeliveries(): ScheduledMessage[] {
    return [...this.messageDeliveries.values()].map((message) => structuredClone(message));
  }
  listForRecipient(actorId: string): ScheduledMessage[] {
    return this.listMessageDeliveries().filter((message) => message.toId === actorId);
  }
  fire(id: string): ScheduledMessage {
    const message = this.messageDeliveries.get(id);
    if (!message) throw new Error(`scheduled message not found: ${id}`);
    this.messageDeliveries.delete(id);
    return structuredClone(message);
  }
}

const payload = (type: string, merged?: boolean): InboxPayload =>
  ({ type, ...(merged !== undefined ? { merged } : {}) }) as unknown as InboxPayload;

describe("ActorMesh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sequences real actor and external-root transitions on one contiguous revision", async () => {
    const { mesh, root, tick } = setup();
    const externalId = "external";
    const external = new ExternalRootDriver(
      externalId,
      () => "2026-01-01T00:00:00Z",
      (state) => mesh.actorRuntimeStateChanged(externalId, state)
    );
    mesh.adopt(
      {
        id: externalId,
        charter: "external root",
        parentId: "root",
        isRoot: false,
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
      },
      external
    );
    const before = mesh.runtimeStateSnapshot();
    const deltas: Array<{ actorId: string; revision: number; runState: string }> = [];
    mesh.onRuntimeStateDelta((delta) => deltas.push(delta));

    external.requestRun();
    external.requestRun({ priority: "responsive" });
    root.requestRun();
    await tick();
    const [wake] = external.listWakes();
    if (!wake) throw new Error("external wake not queued");
    external.acknowledge([wake.id]);

    expect(deltas.map(({ revision }) => revision)).toEqual(
      deltas.map((_, index) => before.revision + index + 1)
    );
    expect(
      deltas.filter(({ actorId, runState }) => actorId === externalId && runState === "queued")
    ).toHaveLength(1);
    expect(deltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorId: "root", runState: "queued" }),
        expect.objectContaining({ actorId: "root", runState: "running" }),
        expect.objectContaining({ actorId: externalId, runState: "idle" }),
      ])
    );
    const after = mesh.runtimeStateSnapshot();
    expect(after.states.get("root")).toBe("idle");
    expect(after.states.get(externalId)).toBe("idle");
  });

  it("passes the provider through the shared rate gate", async () => {
    const registry = new InMemoryActorRepository();
    const selected: string[] = [];
    let gate!: ActorFactoryContext["gate"];
    const mesh = new ActorMesh({
      actors: registry,
      idgen: () => "worker",
      rateLimit: async (fn, provider) => {
        selected.push(provider);
        return fn();
      },
      createActor: (ctx) => {
        gate = ctx.gate;
        return {
          id: ctx.record.id,
          requestRun: () => {},
          declareYield: () => {},
          markUnkillable: () => {},
          close: () => {},
          preemptForResponsive: () => ({ preempted: false }),
          isRunning: false,
        };
      },
    });

    mesh.spawn({
      charter: "worker",
      parentId: "root",
      modelConfig: { provider: "codex", model: "gpt-5.6-sol" },
    });
    await expect(gate(async () => 42, [{ provider: "codex" }], false).result).resolves.toBe(42);

    expect(selected).toEqual(["codex"]);
  });

  it("skips worker runs while the mesh is halted, and runs once resumed", async () => {
    let halted = true;
    const { mesh, fake, tick } = setup({ isHalted: () => halted });
    const id = mesh.spawn({ charter: "do work", parentId: "root" });
    mesh.sendMessage(id, "begin", "root");
    await tick();
    expect(fake(id).calls).toHaveLength(0); // halted → beforeRun gates the run off

    halted = false;
    mesh.sendMessage(id, "begin again", "root");
    await tick();
    expect(fake(id).calls).toHaveLength(1); // resumed → runs normally
  });

  it("skips worker runs while gracefully shutting down, and runs once cancelled", async () => {
    let shuttingDown = true;
    const { mesh, fake, tick } = setup({ isShuttingDown: () => shuttingDown });
    const id = mesh.spawn({ charter: "do work", parentId: "root" });
    mesh.sendMessage(id, "begin", "root");
    await tick();
    expect(fake(id).calls).toHaveLength(0); // draining → beforeRun gates the run off

    shuttingDown = false;
    mesh.sendMessage(id, "begin again", "root");
    await tick();
    expect(fake(id).calls).toHaveLength(1); // drain cancelled → runs normally
  });

  it("halt and graceful-shutdown gate independently (either one alone skips)", async () => {
    let halted = false;
    let shuttingDown = true;
    const { mesh, fake, tick } = setup({
      isHalted: () => halted,
      isShuttingDown: () => shuttingDown,
    });
    const id = mesh.spawn({ charter: "do work", parentId: "root" });
    mesh.sendMessage(id, "begin", "root");
    await tick();
    expect(fake(id).calls).toHaveLength(0); // shuttingDown alone gates it off

    shuttingDown = false;
    halted = true;
    mesh.sendMessage(id, "begin", "root");
    await tick();
    expect(fake(id).calls).toHaveLength(0); // halt alone still gates it off

    halted = false;
    mesh.sendMessage(id, "begin", "root");
    await tick();
    expect(fake(id).calls).toHaveLength(1); // both clear → runs
  });

  it("spawns a worker and records it, but does NOT wake it (spawn ≠ message)", async () => {
    const { mesh, registry, fake, tick } = setup();
    const id = mesh.spawn({
      charter: "implement X",
      parentId: "root",
      context: { type: "portable", mode: "ledger", compactionModel: "gemini-test" },
    });
    expect(id).toBe("t1");
    const rec = registry.get("t1");
    expect(rec?.status).toBe("active");
    expect(rec?.charter).toBe("implement X");
    expect(rec?.parentId).toBe("root");
    expect(rec?.context).toEqual({
      type: "portable",
      mode: "ledger",
      compactionModel: "gemini-test",
    });

    // Spawning is not an implicit message: the child is born idle with an empty
    // inbox and does not run until something messages it.
    await tick();
    expect(fake("t1").calls).toHaveLength(0); // no phantom wake on spawn

    // A message is what puts it to work.
    mesh.sendMessage("t1", "begin", "root");
    await tick();
    expect(fake("t1").calls).toHaveLength(1);

    // Spawning granted the parent a (role-less) handle to the child; the child's
    // own charter is the label.
    expect(registry.get("root")?.handles).toEqual([{ id: "t1" }]);
  });

  it("resumes an existing conversation when spawned with conversationId", async () => {
    const { mesh, registry, fake, tick } = setup();
    const id = mesh.spawn({
      charter: "continue prior work",
      parentId: "root",
      conversationId: "agy-conv-123",
    });
    // The seed lands on the record, so loadSessionId returns it.
    expect(registry.get(id)?.sessionId).toBe("agy-conv-123");
    mesh.sendMessage(id, "carry on", "root");
    await tick();
    // The first run resumes that conversation rather than creating a fresh one.
    expect(fake(id).calls[0]?.session?.id).toBe("agy-conv-123");
  });

  it("starts a fresh session when spawned without conversationId", async () => {
    const { mesh, registry, fake, tick } = setup();
    const id = mesh.spawn({ charter: "fresh work", parentId: "root" });
    expect(registry.get(id)?.sessionId).toBeUndefined();
    mesh.sendMessage(id, "begin", "root");
    await tick();
    expect(fake(id).calls[0]?.session?.id).toBeUndefined(); // created, not resumed
  });

  it("rehydrates an active record into a live, reachable actor without waking it", async () => {
    const { mesh, registry, fake, tick } = setup();
    // A worker the registry persisted across a 'restart' — record present, not live.
    registry.upsert({
      id: "t1",
      charter: "resumed work",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(mesh.get("t1")).toBeUndefined();

    mesh.rehydrateAll();
    expect(mesh.get("t1")).toBeDefined(); // now live

    // Rehydration alone does not run it — its inbox is empty (no phantom wake).
    await tick();
    expect(fake("t1").calls).toHaveLength(0);

    // But it is reachable: a message wakes it and it resumes normally.
    mesh.sendMessage("t1", "carry on", "root");
    await tick();
    expect(fake("t1").calls).toHaveLength(1);
  });

  it("isolates rehydration failures so one throwing thread does not block other threads", () => {
    const registry = new InMemoryActorRepository();
    registry.upsert({
      id: "t1",
      charter: "bad worker",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    registry.upsert({
      id: "t2",
      charter: "good worker",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });

    const logs: string[] = [];
    const mesh = new ActorMesh({
      actors: registry,
      idgen: () => "t3",
      now: () => "2026-01-01T00:00:00Z",
      log: (m) => logs.push(m),
      createActor: (ctx) => {
        if (ctx.record.id === "t1") {
          throw new Error("unresolvable provider mock error");
        }
        const provider = new FakeProvider();
        return new Actor({
          id: ctx.record.id,
          cwd: `/tmp/${ctx.record.id}`,
          modelConfig: [{ provider: provider.providerName }],
          resolveProvider: () => provider,
          mcpServers: [],
          loadSessionId: () => undefined,
          saveSessionId: () => {},
          buildPrompt: () => ({ prompt: "Read inbox" }),
          onRunEnd: () => {},
        });
      },
    });

    mesh.rehydrateAll();

    expect(mesh.get("t1")).toBeUndefined(); // failed to rehydrate
    expect(mesh.get("t2")).toBeDefined(); // successfully rehydrated

    // Verify it logged the failure
    expect(
      logs.some((l) =>
        l.includes("rehydrate(t1) failed, skipping: unresolvable provider mock error")
      )
    ).toBe(true);
  });

  it("rehydration skips retired records and the already-live root", () => {
    const { mesh, registry } = setup();
    registry.upsert({
      id: "dead",
      charter: "done",
      parentId: "root",
      status: "retired",
      createdAt: "2026-01-01T00:00:00Z",
    });

    mesh.rehydrateAll();
    expect(mesh.get("dead")).toBeUndefined(); // retired stays dead
    expect(mesh.get("root")).toBeDefined(); // root untouched (was already live)
  });

  it("rehydrate is idempotent — a second call doesn't replace a live actor", () => {
    const { mesh, registry } = setup();
    registry.upsert({
      id: "t1",
      charter: "work",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    mesh.rehydrateAll();
    const first = mesh.get("t1");
    mesh.rehydrateAll();
    expect(mesh.get("t1")).toBe(first); // same instance, not rebuilt
  });

  it("rehydrates a seeded session so the first run resumes that conversation", async () => {
    const { mesh, registry, fake, tick } = setup();
    registry.upsert({
      id: "t1",
      charter: "the elder",
      parentId: "root",
      sessionId: "agy-conv-xyz",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    mesh.rehydrateAll();
    mesh.sendMessage("t1", "what did we decide?", "root");
    await tick();
    expect(fake("t1").calls[0]?.session?.id).toBe("agy-conv-xyz"); // resumed, not fresh
  });

  it("boot reconciliation nudges each live actor with unhandled inbox entries once", async () => {
    const inboxStore = {
      actorsWithUnhandled: () => [
        { actorId: "t1", priority: "responsive" as const },
        { actorId: "not-live", priority: "normal" as const },
      ],
      actorsWithUnseen: () => [
        { actorId: "t1", priority: "responsive" as const },
        { actorId: "not-live", priority: "normal" as const },
      ],
      countUnhandled: (actorId: string) => (actorId === "t1" ? 1 : 0),
      markSeen: () => [],
    } as unknown as InboxStore;
    const { mesh, registry, fake, logs } = setup({ inboxStore });
    registry.upsert({
      id: "t1",
      charter: "resumed work",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    mesh.rehydrateAll();
    mesh.reconcileInbox();
    await vi.advanceTimersByTimeAsync(0);

    expect(fake("t1").calls).toHaveLength(1);
    expect(fake("t1").calls[0]?.prompt).toContain("Work from your inbox");
    expect(logs).toContain("inbox_changed for not-live not nudged — no live actor");
  });

  it("coalesces inbox changes during a run into one dirty follow-up", async () => {
    const d = deferredProvider();
    const { mesh, tick } = setup({ sharedProvider: d.provider });
    const id = mesh.spawn({ charter: "do work", parentId: "root" });

    mesh.sendMessage(id, "first", "root");
    await tick();
    expect(d.pending()).toBe(1);

    mesh.sendMessage(id, "second", "root");

    d.releaseAll();
    await tick();

    expect(d.pending()).toBe(1);

    d.releaseAll();
    await tick();
  });

  it("runs spawn validation before allocating an id or durable record", () => {
    let idAllocations = 0;
    const { mesh, registry } = setup({
      idgen: () => {
        idAllocations += 1;
        return "should-not-exist";
      },
      validateSpawn: () => {
        throw new Error("locally rejected model pin");
      },
    });

    expect(() =>
      mesh.spawn({
        charter: "must not spawn",
        parentId: "root",
        modelConfig: { provider: "codex", model: "bad" },
      })
    ).toThrow("locally rejected model pin");
    expect(idAllocations).toBe(0);
    expect(registry.list().map((record) => record.id)).toEqual(["root"]);
  });

  // NOTE(MEK-Org/rusa#169): "refuses spawn when provider/model is missing or
  // whitespace" used to live here, back when ActorMesh.spawn itself parsed
  // scalar provider/model fields. That validation now lives in
  // validateModelConfigPool ("rejects an entry missing a provider", in
  // src/providers/model-config.test.ts) — ActorMesh no longer inspects
  // modelConfig entries unless a validateSpawn hook is wired in, so there is
  // nothing left here for those two tests to exercise. Removed rather than
  // rewritten.

  it("records modelConfig pool on thread record and event", () => {
    const events: MeshEventInput[] = [];
    const { rawSpawn, registry } = setup({
      events: (e) => events.push(e),
    });
    const id = rawSpawn({
      charter: "custom worker",
      parentId: "root",
      modelConfig: { provider: "antigravity", model: "Gemini 3.7 Flash", effort: "high" },
    });
    const record = registry.get(id);
    expect(record?.modelConfig).toEqual([
      { provider: "antigravity", model: "Gemini 3.7 Flash", effort: "high" },
    ]);
    const spawnEvent = events.find((e) => e.kind === "actor_spawned" && e.actorId === id);
    expect(spawnEvent).toBeDefined();
    expect(spawnEvent?.body).toBe("modelConfig=antigravity:Gemini 3.7 Flash @ high");
  });

  it("revokes parent handle and marks record retired when createActor throws on spawn", () => {
    const { mesh, registry } = setup({
      createActor: ({ record }) => {
        if (record.charter === "failing child") {
          throw new Error("factory failed");
        }
        return {} as unknown as Actor;
      },
    });

    expect(() => mesh.spawn({ charter: "failing child", parentId: "root" })).toThrow(
      "factory failed"
    );

    // Root should not retain a handle to the failed child
    const rootRecord = registry.get("root");
    expect(rootRecord?.handles ?? []).toEqual([]);

    // Failed child record must be transitioned to retired and absent from live mesh
    const childRecords = registry.list().filter((r) => r.charter === "failing child");
    expect(childRecords).toHaveLength(1);
    const failedChild = childRecords[0];
    expect(failedChild?.status).toBe("retired");
    expect(mesh.get(failedChild?.id ?? "")).toBeUndefined();
  });

  it("revokeHandle removes handle from actor address book idempotently", () => {
    const { mesh, registry } = setup();
    const coder = mesh.spawn({ charter: "coder", parentId: "root" });
    const reviewer = mesh.spawn({ charter: "reviewer", parentId: "root" });
    mesh.grantHandle(coder, { id: reviewer, role: "code reviewer" });
    expect(registry.get(coder)?.handles).toEqual([{ id: reviewer, role: "code reviewer" }]);

    mesh.revokeHandle(coder, reviewer);
    expect(registry.get(coder)?.handles).toEqual([]);

    // Idempotent: revoking again is a no-op
    mesh.revokeHandle(coder, reviewer);
    expect(registry.get(coder)?.handles).toEqual([]);

    // Unknown holder is a no-op
    mesh.revokeHandle("unknown-id", reviewer);
  });

  it("does not add delivery claims for cron wakes or GitHub events", async () => {
    const { mesh, registry, tick } = setup();
    const cronActor = mesh.spawn({ charter: "nightly", parentId: "root" });
    const eventActor = mesh.spawn({ charter: "repo steward", parentId: "root" });
    const resource = "github:dummy-org/dummy-repo";
    mesh.subscribeEventSource(resource, eventActor, "root");

    expect(mesh.deliverWake(cronActor, "nightly distill run")).toBe(true);
    mesh.deliverEvent(resource, "GitHub push on dummy-org/dummy-repo");
    await tick();

    expect(registry.get(cronActor)).not.toHaveProperty("messageClaims");
    expect(registry.get(eventActor)).not.toHaveProperty("messageClaims");
  });

  it("routes a message to a thread's inbox (async, not a return value)", async () => {
    const { mesh, fake, tick } = setup();
    mesh.spawn({ charter: "do work", parentId: "root" });
    await tick(); // spawn alone does not run it
    mesh.sendMessage("t1", "please rebase", "root");
    await tick();
    const calls = fake("t1").calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("Work from your inbox");
  });

  it("delivers ready-head attention exactly once per transition, across repeats and restarts", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, tick } = setup({ inboxStore });
    const rootEntries = () => inboxStore.entries.filter((entry) => entry.actorId === "root");

    expect(mesh.deliverReadyHeadAttention("root", { id: "ob-1", intent: "ship it" }, null)).toBe(
      true
    );
    await tick();

    const first = rootEntries();
    expect(first).toHaveLength(1);
    expect(first[0].source).toBe("obligation:ob-1");
    expect(first[0].payload).toMatchObject({ type: "obligation.ready_head", obligationId: "ob-1" });

    // Replay of the same transition — and, since the id is derived from the
    // transition rather than a run, this is also what a restart looks like.
    expect(mesh.deliverReadyHeadAttention("root", { id: "ob-1", intent: "ship it" }, null)).toBe(
      false
    );
    expect(rootEntries()).toHaveLength(1);

    // A genuinely different head is genuinely new attention.
    expect(mesh.deliverReadyHeadAttention("root", { id: "ob-2", intent: "next" }, "ob-1")).toBe(
      true
    );
    expect(rootEntries()).toHaveLength(2);

    // ob-1 becoming the head again after ob-2 displaced it is a NEW transition,
    // not a repeat of the first one. Keying on the head alone made this silent,
    // which left an actor that had already handled the ob-1 entry sitting on
    // live work with nothing to wake it.
    expect(mesh.deliverReadyHeadAttention("root", { id: "ob-1", intent: "ship it" }, "ob-2")).toBe(
      true
    );
    expect(rootEntries()).toHaveLength(3);
  });

  it("does not re-wake actor when an already delivered transition sequence is repeated after being handled", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, fake, tick } = setup({ inboxStore });
    const rootEntries = () => inboxStore.entries.filter((entry) => entry.actorId === "root");

    expect(mesh.deliverReadyHeadAttention("root", { id: "ob-1", intent: "ship it" }, null, 1)).toBe(
      true
    );
    await tick();
    expect(rootEntries()).toHaveLength(1);

    // Still unhandled: the wake is outstanding, so a repeat is pure noise.
    const beforeUnhandledRepeat = fake("root").calls.length;
    expect(mesh.deliverReadyHeadAttention("root", { id: "ob-1", intent: "ship it" }, null, 1)).toBe(
      false
    );
    await tick();
    expect(fake("root").calls.length).toBe(beforeUnhandledRepeat);

    // Once handled, repeating the exact same transition sequence does NOT re-wake the actor.
    inboxStore.markHandled("root", [rootEntries()[0].id]);
    expect(mesh.deliverReadyHeadAttention("root", { id: "ob-1", intent: "ship it" }, null, 1)).toBe(
      false
    );
    await tick();
    expect(rootEntries()).toHaveLength(1);
    expect(fake("root").calls.length).toBe(beforeUnhandledRepeat);
  });

  it("collapses a run's ready-head churn into the one net transition", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, tick } = setup({ inboxStore });
    const headEntries = () =>
      inboxStore.entries.filter(
        (entry) =>
          entry.actorId === "root" &&
          (entry.payload as { type?: string }).type === "obligation.ready_head"
      );

    mesh.actorQueued("root", { responsive: true, mode: "ordinary" });

    // The shape a real root produced on 2026-08-30: create the parent, then
    // nest a child under it. Both move root's head, and the first head is
    // waiting again by the time the run ends.
    expect(
      mesh.deliverReadyHeadAttention("root", { id: "parent", intent: "root goal" }, null)
    ).toBe(false);
    expect(
      mesh.deliverReadyHeadAttention("root", { id: "child", intent: "first pass" }, "parent")
    ).toBe(false);
    expect(headEntries()).toHaveLength(0);

    mesh.finishInboxRun("root");
    await tick();

    const delivered = headEntries();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].source).toBe("obligation:child");
  });

  it("says nothing when a run leaves its head where it found it", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, tick } = setup({ inboxStore });
    const headEntries = () =>
      inboxStore.entries.filter(
        (entry) =>
          entry.actorId === "root" &&
          (entry.payload as { type?: string }).type === "obligation.ready_head"
      );

    mesh.actorQueued("root", { responsive: true, mode: "ordinary" });
    mesh.deliverReadyHeadAttention("root", { id: "b", intent: null }, "a");
    mesh.deliverReadyHeadAttention("root", { id: "a", intent: null }, "b");
    mesh.finishInboxRun("root");
    await tick();

    // Churned and settled back: waking an actor about the head it already had
    // is the noise this collapse exists to remove.
    expect(headEntries()).toHaveLength(0);
  });

  it("says nothing when a run ends with no ready head at all", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, tick } = setup({ inboxStore });
    const headEntries = () =>
      inboxStore.entries.filter(
        (entry) =>
          entry.actorId === "root" &&
          (entry.payload as { type?: string }).type === "obligation.ready_head"
      );

    mesh.actorQueued("root", { responsive: true, mode: "ordinary" });
    mesh.deliverReadyHeadAttention("root", { id: "parent", intent: null }, null);
    // Filing a question owned by the operator under it leaves root waiting with
    // nothing ready — there is no obligation to point it at.
    mesh.deliverReadyHeadAttention("root", null, "parent");
    mesh.finishInboxRun("root");
    await tick();

    expect(headEntries()).toHaveLength(0);
  });

  it("delivers immediately when no run is open", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh } = setup({ inboxStore });

    // Every non-run producer — a peer's mutation, the dashboard, a cron — must
    // still wake the actor at once.
    expect(mesh.deliverReadyHeadAttention("root", { id: "ob-1", intent: null }, null)).toBe(true);
    expect(mesh.deliverReadyHeadAttention("root", null, "ob-1")).toBe(false);
  });

  it("does not deliver ready-head attention to a retired actor", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, registry } = setup({ inboxStore });
    const id = mesh.spawn({ charter: "worker", parentId: "root" });
    registry.patch(id, { status: "retired" });

    expect(mesh.deliverReadyHeadAttention(id, { id: "ob-1", intent: null })).toBe(false);
    expect(inboxStore.entries.filter((entry) => entry.actorId === id)).toHaveLength(0);
  });

  it("reconciles missing ready-head attention on boot and repair", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, fake, tick } = setup({ inboxStore });
    const rootEntries = () => inboxStore.entries.filter((entry) => entry.actorId === "root");

    const obligations = {
      readyHeadTransitions: () => [
        { ownerId: "root", headId: "ob-1", previousHeadId: null, sequence: 1 },
      ],
      get: (id: string) => (id === "ob-1" ? { id: "ob-1", intent: "repair me" } : null),
    };

    // Before reconciliation: inbox has 0 entries for root.
    expect(rootEntries()).toHaveLength(0);

    // Run boot reconciliation for ready heads
    mesh.reconcileReadyHeads(obligations);
    await tick();

    // Missed attention was delivered and actor nudged
    expect(rootEntries()).toHaveLength(1);
    expect(rootEntries()[0].source).toBe("obligation:ob-1");
    expect(rootEntries()[0].payload).toMatchObject({
      type: "obligation.ready_head",
      obligationId: "ob-1",
      intent: "repair me",
    });
    expect(fake("root").calls.length).toBeGreaterThan(0);

    // Second boot reconciliation pass (restart idempotence test):
    // Attention for ob-1 is already in inbox, so no new entry or duplicate wake occurs.
    const callCountBefore = fake("root").calls.length;
    mesh.reconcileReadyHeads(obligations);
    await tick();

    expect(rootEntries()).toHaveLength(1);
    expect(fake("root").calls.length).toBe(callCountBefore);
  });

  it("is idempotent when transition-based attention was already delivered before restart", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, fake, tick } = setup({ inboxStore });
    const rootEntries = () => inboxStore.entries.filter((entry) => entry.actorId === "root");

    // Simulate transition-derived delivery during runtime (e.g. ob-0 -> ob-1, sequence 1)
    mesh.deliverReadyHeadAttention("root", { id: "ob-1", intent: "ship it" }, "ob-0", 1);
    await tick();
    expect(rootEntries()).toHaveLength(1);
    expect(rootEntries()[0].source).toBe("obligation:ob-1");

    const callsBeforeReconcile = fake("root").calls.length;

    // Simulate restart and run reconcileReadyHeads
    const obligations = {
      readyHeadTransitions: () => [
        { ownerId: "root", headId: "ob-1", previousHeadId: "ob-0", sequence: 1 },
      ],
      get: (id: string) => (id === "ob-1" ? { id: "ob-1", intent: "ship it" } : null),
    };

    mesh.reconcileReadyHeads(obligations);
    await tick();

    // No duplicate entry or extra wake!
    expect(rootEntries()).toHaveLength(1);
    expect(fake("root").calls.length).toBe(callsBeforeReconcile);
  });

  it("reconciles a missed recurrence transition when multiple consecutive listener failures occurred", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, fake, tick } = setup({ inboxStore });
    const rootEntries = () => inboxStore.entries.filter((entry) => entry.actorId === "root");

    // 1. H becomes head initially (sequence 1). Delivered and handled.
    mesh.deliverReadyHeadAttention("root", { id: "ob-H", intent: "do H" }, null, 1);
    await tick();
    const entryH1 = rootEntries().find((e) => e.source === "obligation:ob-H");
    expect(entryH1).toBeDefined();
    if (!entryH1) return;
    inboxStore.markHandled("root", [entryH1.id]);

    // 2. H -> X commits (sequence 2), listener fails (not delivered to inbox).
    // 3. X -> H commits (sequence 3), listener fails (not delivered to inbox).

    // 4. Boot reconciliation runs with persistent transition fact (sequence 3, prev: ob-X, head: ob-H):
    const obligations = {
      readyHeadTransitions: () => [
        { ownerId: "root", headId: "ob-H", previousHeadId: "ob-X", sequence: 3 },
      ],
      get: (id: string) => (id === "ob-H" ? { id: "ob-H", intent: "do H" } : null),
    };

    const callsBefore = fake("root").calls.length;
    mesh.reconcileReadyHeads(obligations);
    await tick();

    // Boot delivers sequence 3 (ob-X -> ob-H) attention.
    expect(rootEntries()).toHaveLength(2);
    const newEntry = rootEntries()[1];
    expect(newEntry.source).toBe("obligation:ob-H");
    expect(newEntry.payload).toMatchObject({
      type: "obligation.ready_head",
      obligationId: "ob-H",
      intent: "do H",
    });
    expect(fake("root").calls.length).toBeGreaterThan(callsBefore);

    // 5. Subsequent boot passes are idempotent.
    const callsBeforePass2 = fake("root").calls.length;
    mesh.reconcileReadyHeads(obligations);
    await tick();
    expect(rootEntries()).toHaveLength(2);
    expect(fake("root").calls.length).toBe(callsBeforePass2);
  });

  it("skips non-actor owners and retired actors during ready-head reconciliation", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, registry } = setup({ inboxStore });
    const retiredId = mesh.spawn({ charter: "worker", parentId: "root" });
    registry.patch(retiredId, { status: "retired" });

    const obligations = {
      readyHeads: () =>
        [
          ["human:matt", "ob-human"],
          ["system:cron", "ob-sys"],
          [retiredId, "ob-retired"],
        ] as [string, string][],
      get: (id: string) => ({ id, intent: null }),
    };

    mesh.reconcileReadyHeads(obligations);
    expect(inboxStore.entries).toHaveLength(0);
  });

  it("delivers prerequisite-cancellation attention exactly once per (dependent, prerequisite) pair (#212)", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, tick } = setup({ inboxStore });
    const rootEntries = () => inboxStore.entries.filter((entry) => entry.actorId === "root");

    expect(mesh.deliverPrerequisiteCancelledAttention("root", "dep-1", "gate-1")).toBe(true);
    await tick();

    const first = rootEntries();
    expect(first).toHaveLength(1);
    expect(first[0].source).toBe("obligation:dep-1");
    expect(first[0].payload).toMatchObject({
      type: "obligation.prerequisite_cancelled",
      obligationId: "dep-1",
      prerequisiteId: "gate-1",
    });

    // Replay of the exact same fact is a no-op.
    expect(mesh.deliverPrerequisiteCancelledAttention("root", "dep-1", "gate-1")).toBe(false);
    expect(rootEntries()).toHaveLength(1);

    // A different prerequisite on the same dependent is genuinely new attention.
    expect(mesh.deliverPrerequisiteCancelledAttention("root", "dep-1", "gate-2")).toBe(true);
    expect(rootEntries()).toHaveLength(2);
  });

  it("keeps prerequisite-cancellation attention distinct for id pairs that collide under a delimiter join (#212)", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, tick } = setup({ inboxStore });
    const rootEntries = () => inboxStore.entries.filter((entry) => entry.actorId === "root");

    // An obligation id is only required to be non-empty, so `:` is legal
    // inside one. Joining the pair on a fixed separator collapses
    // `("a:b", "c")` and `("a", "b:c")` onto one dedupe key, which for a
    // one-shot notice means one dependent's repair prompt silently
    // suppressing the other's.
    expect(mesh.deliverPrerequisiteCancelledAttention("root", "a:b", "c")).toBe(true);
    expect(mesh.deliverPrerequisiteCancelledAttention("root", "a", "b:c")).toBe(true);
    await tick();

    expect(rootEntries()).toHaveLength(2);
    expect(rootEntries().map((entry) => entry.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ obligationId: "a:b", prerequisiteId: "c" }),
        expect.objectContaining({ obligationId: "a", prerequisiteId: "b:c" }),
      ])
    );
  });

  it("does not deliver prerequisite-cancellation attention to a retired actor", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, registry } = setup({ inboxStore });
    const id = mesh.spawn({ charter: "worker", parentId: "root" });
    registry.patch(id, { status: "retired" });

    expect(mesh.deliverPrerequisiteCancelledAttention(id, "dep-1", "gate-1")).toBe(false);
    expect(inboxStore.entries.filter((entry) => entry.actorId === id)).toHaveLength(0);
  });

  it("reconciles missing prerequisite-cancellation attention on boot and is idempotent on repeat (#212)", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, fake, tick } = setup({ inboxStore });
    const rootEntries = () => inboxStore.entries.filter((entry) => entry.actorId === "root");

    const obligations = {
      listPrerequisiteCancellationAttention: () => [
        { dependentId: "dep-1", dependentOwnerId: "root", prerequisiteId: "gate-1" },
      ],
    };

    expect(rootEntries()).toHaveLength(0);

    mesh.reconcileCancelledPrerequisiteAttention(obligations);
    await tick();

    expect(rootEntries()).toHaveLength(1);
    expect(rootEntries()[0].source).toBe("obligation:dep-1");
    expect(rootEntries()[0].payload).toMatchObject({
      type: "obligation.prerequisite_cancelled",
      obligationId: "dep-1",
      prerequisiteId: "gate-1",
    });
    expect(fake("root").calls.length).toBeGreaterThan(0);

    const callCountBefore = fake("root").calls.length;
    mesh.reconcileCancelledPrerequisiteAttention(obligations);
    await tick();

    expect(rootEntries()).toHaveLength(1);
    expect(fake("root").calls.length).toBe(callCountBefore);
  });

  it("skips non-actor owners and retired actors during prerequisite-cancellation reconciliation", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, registry } = setup({ inboxStore });
    const retiredId = mesh.spawn({ charter: "worker", parentId: "root" });
    registry.patch(retiredId, { status: "retired" });

    const obligations = {
      listPrerequisiteCancellationAttention: () => [
        { dependentId: "dep-human", dependentOwnerId: "human:matt", prerequisiteId: "gate" },
        { dependentId: "dep-sys", dependentOwnerId: "system:cron", prerequisiteId: "gate" },
        { dependentId: "dep-retired", dependentOwnerId: retiredId, prerequisiteId: "gate" },
      ],
    };

    mesh.reconcileCancelledPrerequisiteAttention(obligations);
    expect(inboxStore.entries).toHaveLength(0);
  });

  it("re-queues an actor that leaves inbox work unhandled, and stops once the inbox drains", async () => {
    const inboxStore = createMemoryInboxStore();
    // Handle exactly one entry per run so the actor deliberately under-drains,
    // which is the deferral pattern the inbox contract is meant to support.
    const { mesh, fake, tick } = setup({
      inboxStore,
      createActor: undefined,
    });
    inboxStore.append([
      { actorId: "root", source: "mesh:a", payload: payload("mesh.message") },
      { actorId: "root", source: "mesh:b", payload: payload("mesh.message") },
      { actorId: "root", source: "mesh:c", payload: payload("mesh.message") },
    ]);

    const handleOne = () => {
      const next = inboxStore.list("root").entries[0];
      if (!next) return 0;
      mesh.selectInboxEntries("root", [next.id]);
      inboxStore.markHandled("root", [next.id]);
      mesh.inboxHandled("root");
      return inboxStore.countUnhandled("root");
    };

    expect(handleOne()).toBe(2);
    await tick();
    expect(fake("root").calls.length).toBeGreaterThan(0);

    const afterFirst = fake("root").calls.length;
    expect(handleOne()).toBe(1);
    await tick();
    expect(fake("root").calls.length).toBeGreaterThan(afterFirst);

    // Draining the last entry must NOT schedule another run: an empty inbox is
    // the termination condition, otherwise the actor spins forever.
    const afterSecond = fake("root").calls.length;
    expect(handleOne()).toBe(0);
    await tick();
    expect(fake("root").calls).toHaveLength(afterSecond);
  });

  it("delivers a system.disk event to the system subscriber as responsive inbox work", async () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh, fake, tick } = setup({ inboxStore });
    mesh.subscribeEventSource("system:events", "root", "root");

    await mesh.deliverEvent("system:events", "disk low", {
      inboxPayload: {
        type: "system.disk",
        priority: "responsive",
        volume: "/",
        freeBytes: 1024,
      },
      inboxPriority: "responsive",
    });
    await tick();

    expect(inboxStore.entries).toEqual([
      expect.objectContaining({
        actorId: "root",
        source: "system:events",
        payload: expect.objectContaining({
          type: "system.disk",
          priority: "responsive",
          volume: "/",
        }),
      }),
    ]);
    expect(fake("root").calls).toHaveLength(1);
  });

  it("preempts an active run for durable responsive inbox work and runs the replacement", async () => {
    const inboxStore = createMemoryInboxStore();
    const events: MeshEventInput[] = [];
    let resolveFirst!: (result: Partial<RunResult>) => void;
    let firstSignal: AbortSignal | undefined;
    let runIndex = 0;
    const provider = new FakeProvider((opts) => {
      if (runIndex++ === 0) {
        firstSignal = opts.signal;
        return new Promise<Partial<RunResult>>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { success: true, exitCode: 0, output: "responsive work handled" };
    });
    const { mesh, fake, tick } = setup({
      inboxStore,
      events: (event) => events.push(event),
      sharedProvider: provider,
    });
    const worker = mesh.spawn({ charter: "worker", parentId: "root" });

    inboxStore.append([{ actorId: worker, source: "mesh:root", payload: payload("mesh.message") }]);
    mesh.notifyInboxChanged(worker);
    await tick();
    expect(fake(worker).calls).toHaveLength(1);
    expect(firstSignal?.aborted).toBe(false);

    const [responsive] = inboxStore.append([
      {
        actorId: worker,
        source: "system:events",
        payload: { type: "system.disk", priority: "responsive" },
      },
    ]);
    mesh.notifyInboxChanged(worker, { priority: "responsive" });

    expect(firstSignal?.aborted).toBe(true);
    expect(firstSignal?.reason).toBe("interrupt:responsive-notification");
    expect(responsive?.handledAt).toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "run_preempted",
        actorId: worker,
        detail: "running",
        payload: JSON.stringify({ reason: "responsive_notification" }),
      })
    );

    resolveFirst({
      success: false,
      exitCode: 143,
      cancelled: true,
      interrupted: true,
      output: "[Task interrupted by responsive-notification]",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake(worker).calls).toHaveLength(2);

    // Assert the inbox seam preserves both the old unhandled and new responsive entries
    const unhandled = inboxStore.entries.filter((e) => e.actorId === worker && !e.handledAt);
    expect(unhandled).toHaveLength(2);
    expect(unhandled.map((e) => e.payload.type)).toEqual(["mesh.message", "system.disk"]);
  });

  it("delivers responsive inbox work to an idle actor without a preemption event", async () => {
    const inboxStore = createMemoryInboxStore();
    const events: MeshEventInput[] = [];
    const { mesh, fake, tick } = setup({ inboxStore, events: (event) => events.push(event) });
    const worker = mesh.spawn({ charter: "worker", parentId: "root" });

    inboxStore.append([
      {
        actorId: worker,
        source: "system:events",
        payload: { type: "system.disk", priority: "responsive" },
      },
    ]);
    mesh.notifyInboxChanged(worker, { priority: "responsive" });
    await tick();

    expect(fake(worker).calls).toHaveLength(1);
    expect(events.some((event) => event.kind === "run_preempted")).toBe(false);
  });

  it("mechanically notifies the parent when a parent-triggered run yields", async () => {
    const chat: { senderId: string; recipientId: string; body: string; sessionId?: string }[] = [];
    const inboxStore = createMemoryInboxStore();
    const recordRunYield = vi.fn(() => "durable-run-1");
    let mesh!: ReturnType<typeof setup>["mesh"];
    let id!: string;
    const provider = new FakeProvider(() => {
      mesh.declareYield(id, "complete", "done");
      return {};
    });
    const env = setup({
      sharedProvider: provider,
      recordChat: (opts) => {
        chat.push(opts);
        return "msg";
      },
      inboxStore,
      recordRunYield,
    });
    mesh = env.mesh;
    id = mesh.spawn({ charter: "do work", parentId: "root" });

    mesh.sendMessage(id, "please do it", "root");
    await env.tick();
    await env.tick();

    // ISSUE_NUM: a mechanical yield notice must NOT surface in the root⇄child chat.
    expect(chat.find((c) => c.senderId === id && c.recipientId === "root")).toBeUndefined();
    expect(inboxStore.entries.find((entry) => entry.actorId === "root")?.payload).toMatchObject({
      type: "mesh.mechanical_note",
      note: `[yield/complete] ${id}: done`,
      runId: "durable-run-1",
      actorId: id,
      status: "complete",
      fromId: id,
    });
    expect(recordRunYield).toHaveBeenCalledWith(id, "complete", "done");
    expect(env.fake("root").calls.at(-1)?.prompt).toContain("Work from your inbox");
  });

  it("failed run notices wake the parent through the mechanical inbox", async () => {
    const inboxStore = createMemoryInboxStore();
    const events: MeshEventInput[] = [];
    const { mesh, registry, fake, tick, logs } = setup({
      inboxStore,
      events: (event) => events.push(event),
    });
    const id = mesh.spawn({ charter: "do work", parentId: "root" });

    await routeRunFailure(
      {
        actors: registry,
        sendToParent: (toId, body, fromId, forensics) =>
          mesh.deliverMechanicalInboxNotice(toId, body, fromId, forensics),
        postToErrorChat: null,
        rootId: "root",
        log: (message) => logs.push(message),
      },
      id,
      {
        success: false,
        output: "boom",
        exitCode: 1,
      }
    );
    await tick();

    expect(inboxStore.entries).toEqual([
      expect.objectContaining({
        actorId: "root",
        source: `mesh:mechanical:${id}`,
        payload: expect.objectContaining({
          type: "mesh.mechanical_note",
          note: expect.stringContaining("[run failed]"),
          runId: id,
          actorId: id,
          exitCode: 1,
          fromId: id,
        }),
      }),
    ]);
    expect(fake("root").calls.at(-1)?.prompt).toContain("Work from your inbox");
    expect(events.some((e) => e.kind === "message_sent" && e.body?.includes("[run failed]"))).toBe(
      false
    );
  });

  it("appends git-bridge review instructions to the parent yield notification", async () => {
    const chat: { senderId: string; recipientId: string; body: string; sessionId?: string }[] = [];
    const inboxStore = createMemoryInboxStore();
    const consumed: string[] = [];
    let mesh!: ReturnType<typeof setup>["mesh"];
    let id!: string;
    const provider = new FakeProvider(() => {
      mesh.declareYield(id, "complete", "branch delivered");
      return {};
    });
    const env = setup({
      sharedProvider: provider,
      recordChat: (opts) => {
        chat.push(opts);
        return "msg";
      },
      inboxStore,
      onYield: (actorId, { notifyingParent }) => {
        if (actorId !== id || !notifyingParent) return undefined;
        consumed.push(actorId);
        return "git fetch dummy-repo\ngit diff main...dummy-repo/mc/test";
      },
    });
    mesh = env.mesh;
    id = mesh.spawn({ charter: "do work", parentId: "root" });

    mesh.sendMessage(id, "please do it", "root");
    await env.tick();
    await env.tick();

    expect(consumed).toEqual([id]);
    // ISSUE_NUM: the appendix rides the inbox note, not a mesh_chat row.
    expect(chat.find((c) => c.senderId === id && c.recipientId === "root")).toBeUndefined();
    expect(inboxStore.entries.find((entry) => entry.actorId === "root")?.payload).toMatchObject({
      note: `[yield/complete] ${id}: branch delivered\n\ngit fetch dummy-repo\ngit diff main...dummy-repo/mc/test`,
    });
  });

  it("does not send duplicate failure note when run yields and is then grace-killed ", async () => {
    const inboxStore = createMemoryInboxStore();
    let mesh!: ReturnType<typeof setup>["mesh"];
    let id!: string;
    const provider = new FakeProvider(async (opts) => {
      mesh.declareYield(id, "complete", "charter completed");
      return new Promise<RunResult>((resolve) => {
        opts.signal?.addEventListener("abort", () => {
          resolve({
            success: false,
            exitCode: 143,
            cancelled: true,
            graceKilled: true,
            output: "[Task killed by supervisor (yield grace period exceeded)]",
          });
        });
      });
    });
    const env = setup({
      sharedProvider: provider,
      inboxStore,
    });
    mesh = env.mesh;
    id = mesh.spawn({ charter: "finish task", parentId: "root" });

    mesh.sendMessage(id, "start working", "root");
    await env.tick();
    await vi.advanceTimersByTimeAsync(10_000);
    await env.tick();

    const rootEntries = inboxStore.entries.filter((entry) => entry.actorId === "root");
    expect(rootEntries).toHaveLength(1);
    expect(rootEntries[0]?.payload).toMatchObject({
      note: `[yield/complete] ${id}: charter completed`,
    });
    expect(
      rootEntries.some(
        (entry) =>
          typeof entry.payload === "object" &&
          "note" in entry.payload &&
          typeof entry.payload.note === "string" &&
          entry.payload.note.includes("[run failed]")
      )
    ).toBe(false);
  });

  it("does not mechanically notify the parent when an external GitHub event run yields", async () => {
    const events: MeshEventInput[] = [];
    let mesh!: ReturnType<typeof setup>["mesh"];
    let id!: string;
    const provider = new FakeProvider(() => {
      mesh.declareYield(id, "complete", "synced");
      return {};
    });
    const env = setup({ sharedProvider: provider, events: (e) => events.push(e) });
    mesh = env.mesh;
    id = mesh.spawn({ charter: "repo steward", parentId: "root" });
    const resource = "github:dummy-org/dummy-repo";
    mesh.subscribeEventSource(resource, id, "root");

    mesh.deliverEvent(resource, "GitHub issues/opened on dummy-org/dummy-repo", {
      inboxPayload: payload("issues.opened"),
    });
    await env.tick();

    expect(events.some((e) => e.kind === "run_yielded" && e.actorId === id)).toBe(true);
    expect(events.some((e) => e.kind === "message_sent" && e.actorId === id)).toBe(false);
  });

  it("does not carry a stale git-bridge appendix from an external run into a later parent-triggered yield", async () => {
    const chat: { senderId: string; recipientId: string; body: string; sessionId?: string }[] = [];
    const inboxStore = createMemoryInboxStore();
    const consumed: string[] = [];
    let mesh!: ReturnType<typeof setup>["mesh"];
    let id!: string;
    let yieldText = "external work";
    const provider = new FakeProvider(() => {
      mesh.declareYield(id, "complete", yieldText);
      return {};
    });
    const env = setup({
      sharedProvider: provider,
      recordChat: (opts) => {
        chat.push(opts);
        return "msg";
      },
      inboxStore,
      onYield: (actorId, { notifyingParent }) => {
        if (notifyingParent) return null; // no new deliverable produced on the parent run
        consumed.push(actorId); // but the external run produced one, which this clears
        return `stale deliverable instructions`;
      },
    });
    mesh = env.mesh;
    id = mesh.spawn({ charter: "repo steward", parentId: "root" });
    const resource = "github:dummy-org/dummy-repo";
    mesh.subscribeEventSource(resource, id, "root");

    mesh.deliverEvent(resource, "GitHub issues/opened on dummy-org/dummy-repo", {
      inboxPayload: { type: "issue.opened", issueNumber: 1 },
    });
    await env.tick();

    yieldText = "unrelated parent work";
    mesh.sendMessage(id, "please do unrelated work", "root");
    await env.tick();
    await env.tick();

    expect(consumed).toEqual([id]);
    // ISSUE_NUM: the notice rides the inbox note (no stale appendix), not a chat row.
    expect(chat.find((c) => c.senderId === id && c.recipientId === "root")).toBeUndefined();
    expect(inboxStore.entries.find((entry) => entry.actorId === "root")?.payload).toMatchObject({
      note: `[yield/complete] ${id}: unrelated parent work`,
    });
  });

  it("does not mechanically notify the parent when a scheduled wake run yields", async () => {
    const events: MeshEventInput[] = [];
    let mesh!: ReturnType<typeof setup>["mesh"];
    let id!: string;
    const provider = new FakeProvider(() => {
      mesh.declareYield(id, "complete", "nightly done");
      return {};
    });
    const env = setup({ sharedProvider: provider, events: (e) => events.push(e) });
    mesh = env.mesh;
    id = mesh.spawn({ charter: "nightly distill", parentId: "root" });

    expect(mesh.deliverWake(id, "nightly distill run")).toBe(true);
    await env.tick();

    expect(events.some((e) => e.kind === "run_yielded" && e.actorId === id)).toBe(true);
    expect(events.some((e) => e.kind === "message_sent" && e.actorId === id)).toBe(false);
  });

  it("drops a message to a non-live thread without throwing", async () => {
    const { mesh, logs } = setup();
    expect(mesh.sendMessage("ghost", "hi", "root")).toEqual({ delivered: false });
    expect(logs.some((l) => l.includes("dropped"))).toBe(true);
  });

  it("deliverWake wakes a live actor (true) with the reason as its prompt", async () => {
    const { mesh, fake, tick } = setup();
    const id = mesh.spawn({ charter: "nightly distill", parentId: "root" });
    await tick();
    expect(fake(id).calls).toHaveLength(0); // idle until woken

    expect(mesh.deliverWake(id, "nightly distill run")).toBe(true);
    await tick();
    const calls = fake(id).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("Work from your inbox");
  });

  it("deliverWake on a non-live thread returns false and drops without throwing", async () => {
    const { mesh, logs } = setup();
    expect(mesh.deliverWake("ghost", "wake")).toBe(false);
    expect(logs.some((l) => l.includes("scheduled wake for ghost dropped"))).toBe(true);
  });

  it("deliverWake with responsive priority delivers responsive inbox work and scheduled_wake event", async () => {
    const events: MeshEventInput[] = [];
    const inboxStore = createMemoryInboxStore();
    const { mesh, tick } = setup({
      inboxStore,
      events: (e) => events.push(e),
    });
    const id = mesh.spawn({ charter: "standing op", parentId: "root" });
    await tick();

    expect(mesh.deliverWake(id, "bless cut", "responsive")).toBe(true);
    await tick();

    const inboxEntry = inboxStore.entries.find((e) => e.actorId === id);
    expect(inboxEntry).toBeDefined();
    expect(inboxEntry?.payload).toMatchObject({
      type: "scheduled.wake",
      priority: "responsive",
    });

    const wakeEvent = events.find((e) => e.kind === "scheduled_wake" && e.actorId === id);
    expect(wakeEvent).toBeDefined();
    expect(JSON.parse(wakeEvent?.payload ?? "{}")).toMatchObject({
      priority: "responsive",
    });
  });

  it("deliverWake with suffixed wake slot delivers to the base actor with slot metadata", async () => {
    const events: MeshEventInput[] = [];
    const inboxStore = createMemoryInboxStore();
    const { mesh, tick } = setup({
      inboxStore,
      events: (e) => events.push(e),
    });
    const rootId = mesh.actors.get("root")?.id ?? "root";
    expect(mesh.deliverWake("root:daily-bless-cut", "cut morning bless", "responsive")).toBe(true);
    await tick();

    const inboxEntry = inboxStore.entries.find((e) => e.actorId === rootId);
    expect(inboxEntry).toBeDefined();
    expect(inboxEntry?.payload).toMatchObject({
      type: "scheduled.wake",
      slot: "root:daily-bless-cut",
      priority: "responsive",
    });

    const wakeEvent = events.find((e) => e.kind === "scheduled_wake" && e.actorId === rootId);
    expect(wakeEvent).toBeDefined();
    expect(wakeEvent?.detail).toBeUndefined();
    expect(JSON.parse(wakeEvent?.payload ?? "{}")).toMatchObject({
      slot: "root:daily-bless-cut",
      priority: "responsive",
    });

    // Dropped suffixed wake
    expect(mesh.deliverWake("unknown-actor:nightly", "nightly run")).toBe(false);
    const droppedEvent = events.find(
      (e) => e.kind === "scheduled_wake" && e.actorId === "unknown-actor"
    );
    expect(droppedEvent).toBeDefined();
    expect(droppedEvent?.detail).toBe("dropped — no live actor");
    expect(JSON.parse(droppedEvent?.payload ?? "{}")).toMatchObject({
      slot: "unknown-actor:nightly",
    });
  });

  it("lets a parent introduce peers — coder ↔ reviewer message directly", async () => {
    const { mesh, registry, fake, tick } = setup();
    // Root spawns a coder and a high-tier reviewer, owns both.
    const coder = mesh.spawn({ charter: "implement in repo X", parentId: "root" });
    const reviewer = mesh.spawn({ charter: "review code", parentId: "root" });
    // Root introduces the reviewer to the coder.
    mesh.grantHandle(coder, { id: reviewer, role: "code reviewer (high-tier)" });
    await tick();

    expect(registry.get(coder)?.handles).toEqual([
      { id: reviewer, role: "code reviewer (high-tier)" },
    ]);

    // Coder asks the reviewer for a review (a direct peer message, not via root).
    mesh.sendMessage(reviewer, "review PR #5 please", coder);
    await tick();
    const reviewerCalls = fake(reviewer).calls;
    expect(reviewerCalls.at(-1)?.prompt).toContain("Work from your inbox");

    // Reviewer replies straight back to the coder.
    mesh.sendMessage(coder, "LGTM with nits", reviewer);
    await tick();
    const coderCalls = fake(coder).calls;
    const last = coderCalls.at(-1)?.prompt ?? "";
    expect(last).toContain("Work from your inbox");
    // The coder's prompt advertises the reviewer handle it was granted.
    expect(last).toContain("code reviewer (high-tier)");
  });

  it("calls onRetire for every node in a retired subtree", async () => {
    const retired: string[] = [];
    const { mesh, tick } = setup({ onRetire: (r) => retired.push(r.id) });
    const parent = mesh.spawn({ charter: "parent", parentId: "root" });
    await tick();
    const child = mesh.spawn({ charter: "child", parentId: parent });
    await tick();

    mesh.retire(parent);
    expect(retired.sort()).toEqual([child, parent].sort());
  });

  it("runs registered retire cleanups for every retired actor", () => {
    const cleaned: string[] = [];
    const { mesh } = setup({
      retireCleanups: [
        {
          name: "external durable registration",
          run: (r) => {
            cleaned.push(r.id);
          },
        },
      ],
    });
    const parent = mesh.spawn({ charter: "parent", parentId: "root" });
    const child = mesh.spawn({ charter: "child", parentId: parent });

    mesh.retire(parent);

    expect(cleaned.sort()).toEqual([child, parent].sort());
  });

  it("defers destructive retire cleanups for an active run until run_end", () => {
    const destructiveCleaned: string[] = [];
    const immediateCleaned: string[] = [];
    const { mesh, registry, logs } = setup({
      retireCleanups: [
        {
          name: "worker workdir",
          deferUntilRunEnd: true,
          run: (r) => {
            destructiveCleaned.push(r.id);
          },
        },
        {
          name: "cron wake",
          run: (r) => {
            immediateCleaned.push(r.id);
          },
        },
      ],
    });
    const id = mesh.spawn({ charter: "active worker", parentId: "root" });
    mesh.recordEvent({ kind: "run_queued", actorId: id });

    mesh.retire(id);

    expect(registry.get(id)?.status).toBe("retired");
    expect(immediateCleaned).toEqual([id]);
    expect(destructiveCleaned).toEqual([]);
    expect(logs).toContain(`deferred 1 retire cleanup(s) for ${id} until active run_end`);

    mesh.recordEvent({ kind: "run_end", actorId: id, success: true });

    expect(destructiveCleaned).toEqual([id]);
  });

  it("releases a deferred retire cleanup when the run ends without a result ", () => {
    // The run that was in flight at retire time terminates via a path that emits
    // no run_end — a cancelled queued start or a coalesce-abort. Before the
    // terminal-kind fix nothing ever released this cleanup: the workdir was
    // never reclaimed, and the only trace was the reassuring "deferred" log.
    const destructiveCleaned: string[] = [];
    const { mesh } = setup({
      retireCleanups: [
        {
          name: "worker workdir",
          deferUntilRunEnd: true,
          run: (r) => {
            destructiveCleaned.push(r.id);
          },
        },
      ],
    });
    const id = mesh.spawn({ charter: "active worker", parentId: "root" });
    mesh.recordEvent({ kind: "run_queued", actorId: id });

    mesh.retire(id);
    expect(destructiveCleaned).toEqual([]);

    mesh.recordEvent({ kind: "run_abandoned", actorId: id, detail: "coalesced" });

    expect(destructiveCleaned).toEqual([id]);
  });

  it("does not read an abandoned run as still in flight at retire time ", () => {
    // The other half, and the one that made the leak permanent: an actor that
    // abandoned a run BEFORE being retired must not still look busy, or every
    // later deferred cleanup is queued behind a run that already ended.
    const destructiveCleaned: string[] = [];
    const { mesh, logs } = setup({
      retireCleanups: [
        {
          name: "worker workdir",
          deferUntilRunEnd: true,
          run: (r) => {
            destructiveCleaned.push(r.id);
          },
        },
      ],
    });
    const id = mesh.spawn({ charter: "worker", parentId: "root" });
    mesh.recordEvent({ kind: "run_queued", actorId: id });
    mesh.recordEvent({ kind: "run_abandoned", actorId: id, detail: "start-cancelled" });

    mesh.retire(id);

    expect(destructiveCleaned).toEqual([id]);
    expect(logs.some((m) => m.includes("deferred 1 retire cleanup(s)"))).toBe(false);
  });

  it("isolates retire cleanup failures and keeps running later cleanups", () => {
    const cleaned: string[] = [];
    const { mesh, logs } = setup({
      retireCleanups: [
        {
          name: "throwing cleanup",
          run: () => {
            throw new Error("cleanup boom");
          },
        },
        {
          name: "later cleanup",
          run: (r) => {
            cleaned.push(r.id);
          },
        },
      ],
    });
    const id = mesh.spawn({ charter: "worker", parentId: "root" });

    expect(() => mesh.retire(id)).not.toThrow();

    expect(cleaned).toEqual([id]);
    expect(
      logs.some(
        (m) =>
          m.includes(`retire cleanup throwing cleanup(${id}) failed`) && m.includes("cleanup boom")
      )
    ).toBe(true);
  });

  it("retiring an actor with no external cleanup registrations is a clean no-op", () => {
    const { mesh, registry, logs } = setup();
    const id = mesh.spawn({ charter: "plain worker", parentId: "root" });

    expect(() => mesh.retire(id)).not.toThrow();

    expect(registry.get(id)?.status).toBe("retired");
    expect(logs.some((m) => m.includes("retire cleanup") && m.includes("failed"))).toBe(false);
  });

  it("deactivates the retired actor's active event subscriptions", () => {
    const { mesh } = setup();
    const actorId = mesh.spawn({ charter: "repo worker", parentId: "root" });
    const active = "github:dummy-org/dummy-repo";
    const alreadyInactive = "github:dummy-org/old";

    mesh.subscribeEventSource(active, actorId, "root");
    mesh.subscribeEventSource(alreadyInactive, actorId, "root");
    mesh.unsubscribeEventSource(alreadyInactive, actorId, "2025-12-31T00:00:00Z");

    mesh.retire(actorId);

    expect(
      mesh
        .listSubscriptions()
        .find((s) => s.actorId === actorId && s.resource === "github:dummy-org/dummy-repo")
        ?.unsubscribedAt
    ).toBe("2026-01-01T00:00:00Z");
    expect(
      mesh
        .listSubscriptions()
        .find((s) => s.actorId === actorId && s.resource === "github:dummy-org/old")?.unsubscribedAt
    ).toBe("2025-12-31T00:00:00Z");
  });

  it("calls onSpawn once per genuine spawn, with the new record", async () => {
    const spawned: string[] = [];
    const { mesh } = setup({ onSpawn: (r) => spawned.push(r.id) });
    const a = mesh.spawn({ charter: "a", parentId: "root" });
    const b = mesh.spawn({ charter: "b", parentId: a });
    // Fires synchronously inside spawn(), once each, and NOT for the adopted root.
    expect(spawned).toEqual([a, b]);
  });

  it("a throwing onSpawn never breaks spawn (logged, id still returned)", async () => {
    const { mesh, registry, logs } = setup({
      onSpawn: () => {
        throw new Error("boom");
      },
    });
    const id = mesh.spawn({ charter: "resilient", parentId: "root" });
    // Spawn still succeeded: record exists and the id came back.
    expect(registry.get(id)?.status).toBe("active");
    expect(logs.some((m) => m.includes("onSpawn") && m.includes("boom"))).toBe(true);
  });

  it("does NOT call onSpawn on rehydrate (boot restore is not a birth)", async () => {
    const spawned: string[] = [];
    const { mesh, registry } = setup({ onSpawn: (r) => spawned.push(r.id) });
    const id = mesh.spawn({ charter: "worker", parentId: "root" });
    expect(spawned).toEqual([id]);
    // Simulate a restart: drop the live actor, then rehydrate from the registry.
    mesh.shutdownAll();
    spawned.length = 0;
    for (const r of registry.list()) mesh.rehydrate(r);
    expect(spawned).toEqual([]); // rehydrate must not re-fire onSpawn
  });

  it("retires a whole subtree when a parent is retired", async () => {
    const { mesh, registry, tick } = setup();
    const parent = mesh.spawn({ charter: "parent", parentId: "root" });
    await tick();
    const child = mesh.spawn({ charter: "child", parentId: parent });
    const grandchild = mesh.spawn({ charter: "grandchild", parentId: child });
    await tick();

    mesh.retire(parent);
    for (const id of [parent, child, grandchild]) {
      expect(registry.get(id)?.status).toBe("retired");
      expect(mesh.get(id)).toBeUndefined();
    }
    // The root (not in the subtree) is untouched.
    expect(registry.get("root")?.status).toBe("active");
  });

  it("refuses to retire a thread with its own run in flight, naming the run ", async () => {
    const d = deferredProvider();
    const { mesh, registry, tick } = setup({ sharedProvider: d.provider });
    const id = mesh.spawn({ charter: "arm", parentId: "root" });
    mesh.sendMessage(id, "build", "root");
    await tick();

    expect(() => mesh.retire(id)).toThrow(
      new RegExp(`cannot retire ${id}: it has a run in flight — ${id} \\(running\\)`)
    );
    expect(registry.get(id)?.status).toBe("active");
    expect(mesh.get(id)).toBeDefined();

    // Once the run drains, the same call succeeds.
    d.releaseAll();
    await tick();
    expect(() => mesh.retire(id)).not.toThrow();
    expect(registry.get(id)?.status).toBe("retired");
  });

  it("refuses to retire an ancestor of a busy descendant, and force overrides", async () => {
    const d = deferredProvider();
    const { mesh, registry, tick } = setup({ sharedProvider: d.provider });
    const parent = mesh.spawn({ charter: "parent", parentId: "root" });
    await tick();
    const child = mesh.spawn({ charter: "child", parentId: parent });
    mesh.sendMessage(child, "build", parent);
    await tick();

    expect(() => mesh.retire(parent)).toThrow(
      new RegExp(`a thread in its subtree has a run in flight — ${child} \\(running\\)`)
    );
    expect(registry.get(parent)?.status).toBe("active");
    expect(registry.get(child)?.status).toBe("active");

    // The operator's override tears the whole subtree down anyway — the cascade
    // must not re-check the subtree the entry call already cleared.
    mesh.retire(parent, { force: true });
    expect(registry.get(parent)?.status).toBe("retired");
    expect(registry.get(child)?.status).toBe("retired");

    d.releaseAll();
    await tick();
  });

  it("names the queued phase for a run waiting behind concurrency", async () => {
    const d = deferredProvider();
    const { mesh, tick } = setup({ maxConcurrent: 1, sharedProvider: d.provider });
    const w1 = mesh.spawn({ charter: "w1", parentId: "root" });
    const w2 = mesh.spawn({ charter: "w2", parentId: "root" });
    mesh.sendMessage(w1, "go", "root");
    mesh.sendMessage(w2, "go", "root");
    await tick();

    expect(mesh.activeRunState(w2)).toEqual({ actorId: w2, phase: "queued" });
    expect(() => mesh.retire(w2)).toThrow(`${w2} (queued)`);

    d.releaseAll();
    await tick();
    d.releaseAll();
    await tick();
  });

  it("retires a queued thread with forceQueued, cancelling the start before provider runs ", async () => {
    const d = deferredProvider();
    const { mesh, registry, tick } = setup({ maxConcurrent: 1, sharedProvider: d.provider });
    const w1 = mesh.spawn({ charter: "w1", parentId: "root" });
    const w2 = mesh.spawn({ charter: "w2", parentId: "root" });
    mesh.sendMessage(w1, "go", "root");
    mesh.sendMessage(w2, "go", "root");
    await tick();

    expect(mesh.activeRunState(w1)).toEqual({ actorId: w1, phase: "running" });
    expect(mesh.activeRunState(w2)).toEqual({ actorId: w2, phase: "queued" });

    // Unforced retire fails because it's queued
    expect(() => mesh.retire(w2)).toThrow(`${w2} (queued)`);

    // With forceQueued: true, retiring the queued worker succeeds
    mesh.retire(w2, { forceQueued: true });
    expect(registry.get(w2)?.status).toBe("retired");
    expect(mesh.get(w2)).toBeUndefined();

    // Releasing w1 allows w1 to finish; w2 was cancelled and never runs
    d.releaseAll();
    await tick();
    expect(mesh.activeRunState(w1)).toBeNull();
    expect(mesh.activeRunState(w2)).toBeNull();
  });

  it("refuses to retire a subtree with forceQueued if any descendant is running ", async () => {
    const d = deferredProvider();
    const { mesh, registry, tick } = setup({ maxConcurrent: 1, sharedProvider: d.provider });
    const parent = mesh.spawn({ charter: "parent", parentId: "root" });
    const c1 = mesh.spawn({ charter: "c1", parentId: parent });
    const c2 = mesh.spawn({ charter: "c2", parentId: parent });
    mesh.sendMessage(c1, "go", parent);
    mesh.sendMessage(c2, "go", parent);
    await tick();

    expect(mesh.activeRunState(c1)).toEqual({ actorId: c1, phase: "running" });
    expect(mesh.activeRunState(c2)).toEqual({ actorId: c2, phase: "queued" });

    // forceQueued on the parent should refuse because c1 is running (not queued)
    expect(() => mesh.retire(parent, { forceQueued: true })).toThrow(
      new RegExp(
        `cannot retire ${parent}: a thread in its subtree has a run in flight — ${c1} \\(running\\)`
      )
    );
    expect(registry.get(parent)?.status).toBe("active");
    expect(registry.get(c1)?.status).toBe("active");
    expect(registry.get(c2)?.status).toBe("active");

    d.releaseAll();
    await tick();
    d.releaseAll();
    await tick();
  });

  it("reports every busy thread when a whole subtree is mid-run", async () => {
    const d = deferredProvider();
    const { mesh, tick } = setup({ sharedProvider: d.provider });
    const parent = mesh.spawn({ charter: "parent", parentId: "root" });
    await tick();
    const child = mesh.spawn({ charter: "child", parentId: parent });
    await tick();
    mesh.sendMessage(parent, "go", "root");
    mesh.sendMessage(child, "go", parent);
    await tick();

    expect(
      mesh
        .activeRunsInSubtree(parent)
        .map((r) => r.actorId)
        .sort()
    ).toEqual([child, parent].sort());
    expect(() => mesh.retire(parent)).toThrow(/2 threads in its subtree have runs in flight/);

    d.releaseAll();
    await tick();
  });

  it("retires an idle thread whose stale run_queued event never got a run_end", async () => {
    // The activeRunCounts counter leaks on cancelled/coalesced starts, so a guard
    // built on it would make this thread permanently un-retirable. The live actor's
    // flags clear in a finally, so the guard reads idle here and the retire lands.
    const { mesh, registry } = setup();
    const id = mesh.spawn({ charter: "worker", parentId: "root" });
    mesh.recordEvent({ kind: "run_queued", actorId: id });

    expect(mesh.activeRunState(id)).toBeNull();
    expect(() => mesh.retire(id)).not.toThrow();
    expect(registry.get(id)?.status).toBe("retired");
  });

  it("listChildRunStates labels each direct child running, queued, or idle", async () => {
    const d = deferredProvider();
    const { mesh, tick } = setup({ maxConcurrent: 1, sharedProvider: d.provider });
    const w1 = mesh.spawn({ charter: "w1", parentId: "root" });
    const w2 = mesh.spawn({ charter: "w2", parentId: "root" });
    const w3 = mesh.spawn({ charter: "w3", parentId: "root" });
    mesh.sendMessage(w1, "go", "root");
    mesh.sendMessage(w2, "go", "root");
    await tick();

    const states = mesh.listChildRunStates("root");
    expect(states.get(w1)).toBe("running");
    expect(states.get(w2)).toBe("queued");
    expect(states.get(w3)).toBe("idle");

    d.releaseAll();
    await tick();
    d.releaseAll();
    await tick();
  });

  it("listChildRunStates and activeRunState report winding_down after yield until exit", async () => {
    const d = deferredProvider();
    const { mesh, tick } = setup({ maxConcurrent: 2, sharedProvider: d.provider });
    const w1 = mesh.spawn({ charter: "w1", parentId: "root" });
    mesh.sendMessage(w1, "go", "root");
    await tick();

    expect(mesh.activeRunState(w1)?.phase).toBe("running");
    expect(mesh.listChildRunStates("root").get(w1)).toBe("running");
    expect(mesh.isYielded(w1)).toBe(false);

    // Child declares yield while still executing
    mesh.declareYield(w1, "done");

    expect(mesh.isYielded(w1)).toBe(true);
    expect(mesh.activeRunState(w1)?.phase).toBe("winding_down");
    expect(mesh.listChildRunStates("root").get(w1)).toBe("winding_down");

    // Process finishes
    d.releaseAll();
    await tick();

    expect(mesh.activeRunState(w1)).toBeNull();
    expect(mesh.listChildRunStates("root").get(w1)).toBe("idle");
  });

  it("bounds concurrency across actors at maxConcurrent", async () => {
    const d = deferredProvider();
    const { mesh, tick } = setup({ maxConcurrent: 2, sharedProvider: d.provider });
    const w1 = mesh.spawn({ charter: "w1", parentId: "root" });
    const w2 = mesh.spawn({ charter: "w2", parentId: "root" });
    const w3 = mesh.spawn({ charter: "w3", parentId: "root" });
    // Spawn doesn't run them; message each to put it to work.
    mesh.sendMessage(w1, "go", "root");
    mesh.sendMessage(w2, "go", "root");
    mesh.sendMessage(w3, "go", "root");
    await tick(); // all three debounces fire; gate admits only 2

    expect(mesh.inFlight).toBe(2);
    expect(d.pending()).toBe(2);

    d.releaseAll(); // first two finish → third starts
    await tick();
    expect(d.pending()).toBe(1);
    expect(mesh.inFlight).toBe(1);
    d.releaseAll();
    await tick();
  });

  it("promotes an actor already waiting for normal concurrency on a human wake", async () => {
    const d = deferredProvider();
    const { mesh, tick } = setup({ maxConcurrent: 1, sharedProvider: d.provider });
    const w1 = mesh.spawn({ charter: "w1", parentId: "root" });
    const w2 = mesh.spawn({ charter: "w2", parentId: "root" });
    mesh.sendMessage(w1, "background one", "root");
    mesh.sendMessage(w2, "background two", "root");
    await tick();

    expect(mesh.inFlight).toBe(1);
    expect(d.pending()).toBe(1);

    mesh.sendHumanMessage(w2, "urgent", "human-session");
    await vi.advanceTimersByTimeAsync(0);

    // w2 jumps out of the normal queue. Only w1 counts against maxConcurrent;
    // the responsive provider run is live alongside it.
    expect(mesh.inFlight).toBe(1);
    expect(d.pending()).toBe(2);

    d.releaseAll();
    await tick();
    d.releaseAll();
    await tick();
  });

  it("runningThreadIds reports only actors with a run in flight", async () => {
    const d = deferredProvider();
    const { mesh, tick } = setup({ sharedProvider: d.provider });
    const w1 = mesh.spawn({ charter: "w1", parentId: "root" });
    const w2 = mesh.spawn({ charter: "w2", parentId: "root" });

    // Nothing is running before any wake.
    expect(mesh.runningThreadIds()).toEqual(new Set());

    // Wake only w1; its run blocks in the deferred provider, so w1 is running
    // while w2 (never messaged) and the idle root are not.
    mesh.sendMessage(w1, "go", "root");
    await tick();
    const running = mesh.runningThreadIds();
    expect(running).toEqual(new Set([w1]));
    expect(running.has(w2)).toBe(false);
    expect(running.has("root")).toBe(false);

    // Releasing the run drains it back to idle.
    d.releaseAll();
    await tick();
    expect(mesh.runningThreadIds()).toEqual(new Set());
  });

  it("distinguishes actors queued behind concurrency from running actors", async () => {
    const d = deferredProvider();
    const { mesh, tick } = setup({ maxConcurrent: 1, sharedProvider: d.provider });
    const w1 = mesh.spawn({ charter: "w1", parentId: "root" });
    const w2 = mesh.spawn({ charter: "w2", parentId: "root" });

    mesh.sendMessage(w1, "go", "root");
    mesh.sendMessage(w2, "go", "root");
    await tick();

    expect(mesh.runningThreadIds()).toEqual(new Set([w1]));
    expect(mesh.queuedThreadIds()).toEqual(new Set([w2]));
    expect(mesh.activeRunThreadIds()).toEqual(new Set([w1, w2]));

    d.releaseAll();
    await tick();
    expect(mesh.runningThreadIds()).toEqual(new Set([w2]));
    expect(mesh.queuedThreadIds()).toEqual(new Set());

    d.releaseAll();
    await tick();
  });

  it("cancels and replays only queued runs covered by a provider-scoped halt", async () => {
    const d = deferredProvider();
    const halted = new Set<string>();
    const { mesh, tick } = setup({
      maxConcurrent: 1,
      sharedProvider: d.provider,
      isHalted: (provider) => (provider ? halted.has(provider) : halted.size > 0),
    });
    const running = mesh.spawn({
      charter: "running",
      parentId: "root",
      modelConfig: { provider: "claude", model: "claude-sonnet-5" },
    });
    const blocked = mesh.spawn({
      charter: "blocked",
      parentId: "root",
      modelConfig: { provider: "codex", model: "gpt-5.6-sol" },
    });
    const unaffected = mesh.spawn({
      charter: "unaffected",
      parentId: "root",
      modelConfig: { provider: "claude", model: "claude-sonnet-5" },
    });
    mesh.sendMessage(running, "go", "root");
    mesh.sendMessage(blocked, "go", "root");
    mesh.sendMessage(unaffected, "go", "root");
    await tick();

    halted.add("codex");
    expect(mesh.cancelHaltedQueuedRuns()).toEqual([blocked]);
    await tick();
    expect(mesh.queuedThreadIds()).toEqual(new Set([unaffected]));

    halted.clear();
    expect(mesh.resumeCancelledRuns()).toEqual([blocked]);
    await tick();
    expect(mesh.queuedThreadIds()).toEqual(new Set([unaffected, blocked]));

    d.releaseAll();
    await tick();
    d.releaseAll();
    await tick();
    d.releaseAll();
    await tick();
  });

  it("a staged move to an already-halted provider never invokes it, and dispatches once the halt lifts (idle actor)", async () => {
    const d = deferredProvider();
    const halted = new Set<string>();
    const { mesh, registry, tick } = setup({
      sharedProvider: d.provider,
      isHalted: (provider) => (provider ? halted.has(provider) : halted.size > 0),
    });
    const worker = mesh.spawn({
      charter: "worker",
      parentId: "root",
      modelConfig: { provider: "provider-a", model: "model-a" },
      context: { type: "portable", mode: "ledger" },
    });

    // Stage a move to provider-b, then halt provider-b, while worker is idle —
    // the tuple has not launched yet, so beforeRun's halt gate must consult
    // the provider this run will actually dispatch to, not the stale current one.
    mesh.setActorModel(worker, { provider: "provider-b", model: "model-b" }, "root");
    halted.add("provider-b");

    mesh.sendMessage(worker, "go", "root");
    await tick();

    // Gated off before the provider ever launched.
    expect(d.pending()).toBe(0);
    expect(mesh.runningThreadIds()).toEqual(new Set());
    expect(mesh.queuedThreadIds()).toEqual(new Set());
    expect(registry.get(worker)?.modelConfig?.[0]?.provider).toBe("provider-a");

    // Lifting the halt and reconciling unseen inbox work (the production
    // halt-expiry/`/resume` path) replays the gated-off wake without a fresh
    // external trigger.
    halted.delete("provider-b");
    mesh.resumeCancelledRuns();
    mesh.reconcileUnseenInbox();
    await tick();

    expect(d.pending()).toBe(1);
    expect(registry.get(worker)?.modelConfig?.[0]?.provider).toBe("provider-b");

    d.releaseAll();
    await tick();
  });

  it("a provider swap staged while genuinely queued is cancelled by a halt on the new provider, not the old one, and replays on resume", async () => {
    const d = deferredProvider();
    const halted = new Set<string>();
    const { mesh, registry, tick } = setup({
      maxConcurrent: 1,
      sharedProvider: d.provider,
      isHalted: (provider) => (provider ? halted.has(provider) : halted.size > 0),
    });
    const running = mesh.spawn({
      charter: "running",
      parentId: "root",
      modelConfig: { provider: "provider-a", model: "model-a" },
    });
    const worker = mesh.spawn({
      charter: "worker",
      parentId: "root",
      modelConfig: { provider: "provider-a", model: "model-a" },
      context: { type: "portable", mode: "ledger" },
    });
    mesh.sendMessage(running, "go", "root");
    mesh.sendMessage(worker, "go", "root");
    await tick();
    expect(mesh.queuedThreadIds()).toEqual(new Set([worker]));

    // Stage the cross-provider swap while worker already sits queued behind
    // mesh capacity, then halt the new provider — not the old one it's
    // registered under.
    mesh.setActorModel(worker, { provider: "provider-b", model: "model-b" }, "root");
    expect(registry.get(worker)?.modelConfig?.[0]?.provider).toBe("provider-a");
    halted.add("provider-b");

    expect(mesh.cancelHaltedQueuedRuns()).toEqual([worker]);
    await tick();
    expect(mesh.queuedThreadIds()).toEqual(new Set());

    halted.delete("provider-b");
    expect(mesh.resumeCancelledRuns()).toEqual([worker]);
    await tick();
    expect(mesh.queuedThreadIds()).toEqual(new Set([worker]));

    // Free the concurrency slot: worker is admitted here, after the swap.
    d.releaseAll();
    await tick();

    expect(registry.get(worker)?.modelConfig?.[0]?.provider).toBe("provider-b");
    expect(d.pending()).toBe(1);

    d.releaseAll();
    await tick();
  });

  it("runningThreadIds excludes a halt-gated wake (nothing actually executes)", async () => {
    const d = deferredProvider();
    // Halted: every wake is gated off in beforeRun before the run body, so the
    // actor must never be reported as running even though it was poked.
    const { mesh, tick } = setup({ sharedProvider: d.provider, isHalted: () => true });
    const w1 = mesh.spawn({ charter: "w1", parentId: "root" });

    mesh.sendMessage(w1, "go", "root");
    await tick();
    expect(mesh.runningThreadIds()).toEqual(new Set());
    expect(d.pending()).toBe(0); // the gate stopped it before the provider ran
  });

  it("does not block the spawner — spawn and message both return synchronously", async () => {
    const d = deferredProvider();
    const { mesh } = setup({ sharedProvider: d.provider });
    const id = mesh.spawn({ charter: "slow", parentId: "root" });
    // Returned synchronously with an id; spawn alone starts no run.
    expect(id).toBe("t1");
    expect(mesh.get(id)).toBeDefined();
    // Messaging kicks off a run that blocks, but the call itself returns at once.
    expect(() => mesh.sendMessage(id, "go", "root")).not.toThrow();
    d.releaseAll();
  });

  it("a revoke triggers the unmount hook for the endpoint, idempotently", async () => {
    const revoked: Array<[string, string]> = [];
    const registry = new InMemoryActorRepository();
    registry.upsert({
      id: "root",
      charter: "root",
      parentId: null,
      isRoot: true,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    registry.upsert({
      id: "iu-thread",
      charter: "iu steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const mesh = new ActorMesh({
      actors: registry,
      createActor: () => ({}) as unknown as Actor,
      onCapabilityRevoked: (actorId, capability) => {
        revoked.push([actorId, capability]);
      },
    });
    // The hook fires even if the store had no active grant, so a stale mounted
    // endpoint is always torn down (idempotent teardown).
    await mesh.revokeCapability("iu-thread", "understanding-write", "root");
    expect(revoked).toEqual([["iu-thread", "understanding-write"]]);
  });

  it("a grant triggers the live-mount hook after the grant is active", () => {
    const mounted: Array<[string, string, string[]]> = [];
    const registry = new InMemoryActorRepository();
    registry.upsert({
      id: "root",
      charter: "root",
      parentId: null,
      isRoot: true,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    registry.upsert({
      id: "iu-thread",
      charter: "iu steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    let mesh!: ActorMesh;
    mesh = new ActorMesh({
      actors: registry,
      createActor: () => ({}) as unknown as Actor,
      grantableCapabilities: new Set(["understanding-write"]),
      onCapabilityGranted: (actorId, capability) => {
        mounted.push([actorId, capability, mesh.activeCapabilitiesFor(actorId)]);
      },
    });

    mesh.grantCapability("iu-thread", "understanding-write", "root");
    expect(mounted).toEqual([["iu-thread", "understanding-write", ["understanding-write"]]]);
  });

  // ── Grantor authorization : root grants anything grantable; a non-root
  // parent grants/revokes only PARENT_GRANTABLE secrets, only to direct children.

  it("root grants any grantable capability to any actor (unchanged), audited with peerId = grantor", () => {
    const events: MeshEventInput[] = [];
    const { mesh, registry } = setup({
      events: (e) => events.push(e),
      grantableCapabilities: new Set(["understanding-write", "secret:gemini-api-key"]),
    });
    registry.upsert({
      id: "iu-thread",
      charter: "iu steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    mesh.grantCapability("iu-thread", "understanding-write", "root");
    expect(mesh.activeCapabilitiesFor("iu-thread")).toEqual(["understanding-write"]);
    expect(events.find((e) => e.kind === "capability_granted")).toMatchObject({
      actorId: "iu-thread",
      detail: "understanding-write",
      payload: JSON.stringify({ grantedBy: "root" }),
    });
  });

  it("requires calendar-read grants to name an explicit calendar ID", () => {
    const { mesh, registry } = setup({
      grantableCapabilities: new Set(["calendar-read"]),
    });
    registry.upsert({
      id: "iu-thread",
      charter: "iu steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });

    expect(() => mesh.grantCapability("iu-thread", "calendar-read", "root")).toThrow(
      "bare calendar-read grant is not allowed"
    );
    expect(() => mesh.grantCapability("iu-thread", "calendar-read:", "root")).toThrow(
      "bare calendar-read grant is not allowed"
    );
    expect(() => mesh.grantCapability("iu-thread", "calendar-read:account:", "root")).toThrow(
      "calendar-read grant must specify"
    );
    mesh.grantCapability("iu-thread", "calendar-read:person@example.com", "root");
    mesh.grantCapability("iu-thread", "calendar-read:account:a@example.com", "root");
    expect(mesh.activeCapabilitiesFor("iu-thread")).toEqual([
      "calendar-read:person@example.com",
      "calendar-read:account:a@example.com",
    ]);
  });

  it("requires calendar-write grants to name an explicit calendar ID", () => {
    const { mesh, registry } = setup({
      grantableCapabilities: new Set(["calendar-write"]),
    });
    registry.upsert({
      id: "iu-thread",
      charter: "iu steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });

    expect(() => mesh.grantCapability("iu-thread", "calendar-write", "root")).toThrow(
      "bare calendar-write grant is not allowed"
    );
    expect(() => mesh.grantCapability("iu-thread", "calendar-write:", "root")).toThrow(
      "bare calendar-write grant is not allowed"
    );
    mesh.grantCapability("iu-thread", "calendar-write:person@example.com", "root");
    expect(mesh.activeCapabilitiesFor("iu-thread")).toEqual(["calendar-write:person@example.com"]);
  });

  it("requires email-send grants to name an explicit recipient", () => {
    const { mesh, registry } = setup({
      grantableCapabilities: new Set(["email-send"]),
    });
    registry.upsert({
      id: "iu-thread",
      charter: "iu steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });

    expect(() => mesh.grantCapability("iu-thread", "email-send", "root")).toThrow(
      "bare email-send grant is not allowed"
    );
    expect(() => mesh.grantCapability("iu-thread", "email-send:", "root")).toThrow(
      "bare email-send grant is not allowed"
    );
    mesh.grantCapability("iu-thread", "email-send:person@example.com", "root");
    expect(mesh.activeCapabilitiesFor("iu-thread")).toEqual(["email-send:person@example.com"]);
  });

  it("allows bare drive-read grants as well as scoped folder grants", () => {
    const { mesh, registry } = setup({
      grantableCapabilities: new Set(["drive-read"]),
    });
    registry.upsert({
      id: "iu-thread",
      charter: "iu steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });

    mesh.grantCapability("iu-thread", "drive-read", "root");
    mesh.grantCapability("iu-thread", "drive-read:some-folder", "root");
    expect(mesh.activeCapabilitiesFor("iu-thread")).toEqual([
      "drive-read",
      "drive-read:some-folder",
    ]);
  });

  it("requires a space name for chat-write grants", () => {
    const { mesh, registry } = setup({
      grantableCapabilities: new Set(["chat-write"]),
    });
    registry.upsert({
      id: "worker-thread",
      charter: "doc-toolkit steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });

    expect(() => mesh.grantCapability("worker-thread", "chat-write", "root")).toThrow(
      "bare chat-write grant is not allowed"
    );
    expect(() => mesh.grantCapability("worker-thread", "chat-write:", "root")).toThrow(
      "bare chat-write grant is not allowed"
    );

    mesh.grantCapability("worker-thread", "chat-write:spaces/AAQA29JwOwg", "root");
    expect(mesh.activeCapabilitiesFor("worker-thread")).toEqual(["chat-write:spaces/AAQA29JwOwg"]);
  });

  it("a parent grants an allow-listed secret to its DIRECT child, audited with peerId = grantor", async () => {
    const events: MeshEventInput[] = [];
    const { mesh } = setup({
      events: (e) => events.push(e),
      grantableCapabilities: new Set(["secret:gemini-api-key"]),
    });
    const parent = mesh.spawn({ charter: "parent", parentId: "root" });
    const child = mesh.spawn({ charter: "child", parentId: parent });

    mesh.grantCapability(child, "secret:gemini-api-key", parent);
    expect(mesh.activeCapabilitiesFor(child)).toEqual(["secret:gemini-api-key"]);
    expect(events.find((e) => e.kind === "capability_granted")).toMatchObject({
      actorId: child,
      detail: "secret:gemini-api-key",
      payload: JSON.stringify({ grantedBy: parent }),
    });

    // ...and revokes it again.
    await mesh.revokeCapability(child, "secret:gemini-api-key", parent);
    expect(mesh.activeCapabilitiesFor(child)).toEqual([]);
  });

  it("a parent cannot grant a secret to a non-child (sibling, grandchild, or itself)", async () => {
    const { mesh } = setup({
      grantableCapabilities: new Set(["secret:gemini-api-key"]),
    });
    const parent = mesh.spawn({ charter: "parent", parentId: "root" });
    const sibling = mesh.spawn({ charter: "sibling", parentId: "root" });
    const child = mesh.spawn({ charter: "child", parentId: parent });
    const grandchild = mesh.spawn({ charter: "grandchild", parentId: child });

    expect(() => mesh.grantCapability(sibling, "secret:gemini-api-key", parent)).toThrow(
      /direct children/
    );
    expect(() => mesh.grantCapability(grandchild, "secret:gemini-api-key", parent)).toThrow(
      /direct children/
    );
    expect(() => mesh.grantCapability(parent, "secret:gemini-api-key", parent)).toThrow(
      /direct children/
    );
    expect(() => mesh.grantCapability("ghost-grantee", "secret:gemini-api-key", parent)).toThrow(
      "unknown thread id: ghost-grantee"
    );
    expect(mesh.activeCapabilitiesFor(sibling)).toEqual([]);
    expect(mesh.activeCapabilitiesFor(grandchild)).toEqual([]);
    expect(mesh.activeCapabilitiesFor(parent)).toEqual([]);
    // A non-child revoke is rejected the same way (a parent can't strip a
    // capability root granted to some other actor).
    await expect(mesh.revokeCapability(sibling, "secret:gemini-api-key", parent)).rejects.toThrow(
      /direct children/
    );
    await expect(
      mesh.revokeCapability("ghost-grantee", "secret:gemini-api-key", parent)
    ).rejects.toThrow("unknown thread id: ghost-grantee");
  });

  it("root grant and revoke on an unknown grantee throw unknown thread id error ", async () => {
    const { mesh } = setup({
      grantableCapabilities: new Set(["understanding-write", "secret:gemini-api-key"]),
    });
    expect(() => mesh.grantCapability("ghost-grantee", "understanding-write", "root")).toThrow(
      "unknown thread id: ghost-grantee"
    );
    await expect(
      mesh.revokeCapability("ghost-grantee", "understanding-write", "root")
    ).rejects.toThrow("unknown thread id: ghost-grantee");
  });

  it("a parent cannot grant a non-allow-listed capability, even to its direct child", async () => {
    const { mesh } = setup({
      grantableCapabilities: new Set(["understanding-write", "secret:gemini-api-key"]),
    });
    const parent = mesh.spawn({ charter: "parent", parentId: "root" });
    const child = mesh.spawn({ charter: "child", parentId: parent });

    expect(() => mesh.grantCapability(child, "understanding-write", parent)).toThrow(
      /only the root may grant/
    );
    expect(mesh.activeCapabilitiesFor(child)).toEqual([]);
    await expect(mesh.revokeCapability(child, "understanding-write", parent)).rejects.toThrow(
      /only the root may revoke/
    );
  });

  it("an unknown grantor is never root (fail-closed)", () => {
    const { mesh, registry } = setup({
      grantableCapabilities: new Set(["understanding-write"]),
    });
    registry.upsert({
      id: "iu-thread",
      charter: "iu steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(() => mesh.grantCapability("iu-thread", "understanding-write", "ghost")).toThrow(
      /only the root may grant/
    );
  });

  it("refuses grant authority to a parentless non-root record (ab-rig-holder shape) ", async () => {
    const { mesh, registry } = setup({
      grantableCapabilities: new Set(["understanding-write"]),
    });
    registry.upsert({
      id: "ab-rig-holder",
      charter: "rig holder",
      parentId: null,
      isRoot: false,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    registry.upsert({
      id: "legacy-parentless",
      charter: "legacy record without explicit isRoot",
      parentId: null,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    registry.upsert({
      id: "iu-thread",
      charter: "iu steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });

    // Root (with isRoot: true) has grant and revoke authority
    expect(() => mesh.grantCapability("iu-thread", "understanding-write", "root")).not.toThrow();
    await expect(
      mesh.revokeCapability("iu-thread", "understanding-write", "root")
    ).resolves.not.toThrow();

    // ab-rig-holder (parentId: null, isRoot: false) is refused grant & revoke authority
    expect(() => mesh.grantCapability("iu-thread", "understanding-write", "ab-rig-holder")).toThrow(
      /only the root may grant/
    );
    await expect(
      mesh.revokeCapability("iu-thread", "understanding-write", "ab-rig-holder")
    ).rejects.toThrow(/only the root may revoke/);

    // Legacy parentless record without explicit isRoot (defaults falsy) is also refused
    expect(() =>
      mesh.grantCapability("iu-thread", "understanding-write", "legacy-parentless")
    ).toThrow(/only the root may grant/);
  });

  it("scopes a root's capability authority to its own subtree ", () => {
    const { mesh, registry } = setup({
      grantableCapabilities: new Set(["understanding-write"]),
    });
    registry.upsert({
      id: "account-b-root",
      charter: "another account root",
      parentId: null,
      isRoot: true,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    registry.upsert({
      id: "account-b-child",
      charter: "another account child",
      parentId: "account-b-root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });

    expect(() => mesh.grantCapability("account-b-child", "understanding-write", "root")).toThrow(
      /own subtree/
    );
    expect(() =>
      mesh.grantCapability("account-b-child", "understanding-write", "account-b-root")
    ).not.toThrow();
  });

  it('routes the grandfathered "root" id to a generated-id root', async () => {
    const generatedRootId = "11111111-1111-4111-8111-111111111111";
    const inboxStore = createMemoryInboxStore();
    const { mesh, tick } = setup({ rootId: generatedRootId, inboxStore });

    expect(mesh.sendMessage("root", "legacy address", "worker")).toEqual({ delivered: true });
    await tick();
    expect(inboxStore.entries.some((entry) => entry.actorId === generatedRootId)).toBe(true);
  });

  it('resolves the grandfathered "root" address across control entry points', () => {
    const generatedRootId = "11111111-1111-4111-8111-111111111111";
    const inboxStore = createMemoryInboxStore();
    const { mesh, registry, root } = setup({
      rootId: generatedRootId,
      inboxStore,
      grantableCapabilities: new Set(["understanding-write"]),
    });

    expect(mesh.interrupt("root")).toEqual({ interrupted: false, status: "idle" });

    const markUnkillable = vi.spyOn(root, "markUnkillable");
    mesh.markUnkillable("root");
    expect(markUnkillable).toHaveBeenCalledOnce();

    const parent = mesh.spawn({ charter: "parent", parentId: "root" });
    const child = mesh.spawn({ charter: "child", parentId: parent });
    expect(registry.get(parent)?.parentId).toBe(generatedRootId);
    mesh.grantCapability(parent, "understanding-write", "root");
    expect(mesh.activeCapabilitiesFor(parent)).toEqual(["understanding-write"]);
    mesh.reparentThread(child, "root");
    expect(registry.get(child)?.parentId).toBe(generatedRootId);

    expect(mesh.runNow("root", "test")).toEqual({ queued: true });
    const nudge = inboxStore.entries.find(
      (entry) => entry.actorId === generatedRootId && entry.payload.type === "operator.run_now"
    );
    expect(nudge).toBeDefined();
    expect(mesh.selectInboxEntries("root", [nudge?.id as string])).toHaveLength(1);
    expect(mesh.selectedInboxEntries(generatedRootId)).toEqual([nudge?.id]);

    mesh.setThreadTitle("root", "Generated root");
    mesh.setThreadCharter("root", "generated root charter");
    expect(registry.get(generatedRootId)).toMatchObject({
      title: "Generated root",
      charter: "generated root charter",
    });

    const retirement = setup({ rootId: generatedRootId });
    retirement.mesh.retire("root", { force: true });
    expect(retirement.registry.get(generatedRootId)?.status).toBe("retired");
  });

  it("installs the handled-entry guard only after durable selection succeeds", () => {
    const inboxStore = createMemoryInboxStore();
    const { mesh } = setup({ inboxStore });
    const [entry] = inboxStore.append([
      { actorId: "root", source: "mesh:parent", payload: payload("mesh.message") },
    ]);

    expect(() =>
      mesh.selectInboxEntries("root", [entry.id], () => {
        throw new Error("durable focus rejected");
      })
    ).toThrow("durable focus rejected");
    expect(mesh.selectedInboxEntries("root")).toEqual([]);

    expect(mesh.selectInboxEntries("root", [entry.id], () => {})).toEqual([entry]);
    expect(mesh.selectedInboxEntries("root")).toEqual([entry.id]);
  });

  it("reviveThread flips retired -> active, recreates the actor, keeps sessionId, and runs onRevive", async () => {
    const revived: string[] = [];
    const { mesh, registry, tick } = setup({
      onRevive: (r) => revived.push(r.id),
    });

    const id = mesh.spawn({
      charter: "task",
      parentId: "root",
      conversationId: "sess-123",
    });

    expect(registry.get(id)?.sessionId).toBe("sess-123");

    await tick();

    // Retire the actor
    mesh.retire(id);
    expect(registry.get(id)?.status).toBe("retired");
    expect(mesh.get(id)).toBeUndefined();

    // Revive the actor
    mesh.reviveThread(id);
    expect(registry.get(id)?.status).toBe("active");

    const actor = mesh.get(id);
    expect(actor).toBeDefined();
    expect(registry.get(id)?.sessionId).toBe("sess-123");

    expect(revived).toEqual([id]);
  });

  it("reviveThread throws on active or unknown id", async () => {
    const { mesh } = setup();
    const id = mesh.spawn({ charter: "task", parentId: "root" });

    // Throws on active id
    expect(() => mesh.reviveThread(id)).toThrow(/status is active/);

    // Throws on unknown id
    expect(() => mesh.reviveThread("non-existent")).toThrow(/unknown thread/);
  });

  it("setThreadTitle patches the record title (and re-titles) and throws on unknown id", async () => {
    const { mesh, registry } = setup();
    const id = mesh.spawn({ charter: "task", parentId: "root" });

    mesh.setThreadTitle(id, "My Title");
    expect(registry.get(id)?.title).toBe("My Title");

    // re-title overwrites
    mesh.setThreadTitle(id, "New Title");
    expect(registry.get(id)?.title).toBe("New Title");

    // throws on unknown id
    expect(() => mesh.setThreadTitle("non-existent", "x")).toThrow(/unknown thread/);
  });

  it("setThreadCharter replaces the record charter (wholesale) and throws on unknown id", async () => {
    const { mesh, registry } = setup();
    const id = mesh.spawn({ charter: "advisory reviewer", parentId: "root" });

    mesh.setThreadCharter(id, "dummy-repo steward — owns the repo day-to-day");
    expect(registry.get(id)?.charter).toBe("dummy-repo steward — owns the repo day-to-day");

    // replace overwrites wholesale (no append/merge)
    mesh.setThreadCharter(id, "reassigned to a fresh task");
    expect(registry.get(id)?.charter).toBe("reassigned to a fresh task");

    // refuses an empty/whitespace charter (would silently wipe the mandate),
    // leaving the existing charter intact
    expect(() => mesh.setThreadCharter(id, "   ")).toThrow(/empty charter/);
    expect(registry.get(id)?.charter).toBe("reassigned to a fresh task");

    // throws on unknown id
    expect(() => mesh.setThreadCharter("non-existent", "x")).toThrow(/unknown thread/);
  });

  it("setActorModel updates the record model, emits event, and enforces authority", async () => {
    const events: MeshEventInput[] = [];
    const modelSets: Array<{ actorId: string; newModel?: string }> = [];
    const { mesh, registry, tick } = setup({
      events: (event) => events.push(event),
      onModelSet: (actorId, modelConfig) =>
        modelSets.push({ actorId, newModel: modelConfig[0]?.model }),
      validateModel: (_record, modelConfig) => {
        const list = Array.isArray(modelConfig) ? modelConfig : [modelConfig];
        return list.map((entry) => {
          const model = entry.model?.trim();
          if (!model)
            throw new Error(
              `modelConfig entry for provider "${entry.provider}" is missing a model`
            );
          if (model === "forbidden-model") throw new Error("forbidden model");
          return { provider: entry.provider, model, effort: entry.effort };
        });
      },
    });
    const parent = mesh.spawn({
      charter: "parent",
      parentId: "root",
      modelConfig: { provider: "claude", model: "claude-sonnet-5" },
    });
    const child = mesh.spawn({
      charter: "child",
      parentId: parent,
      modelConfig: { provider: "claude", model: "claude-sonnet-5" },
    });
    const sibling = mesh.spawn({ charter: "sibling", parentId: "root" });

    // Parent can stage a child's model. The child is idle, so the staged
    // pool stays pending until its next dispatch (triggered below by
    // sendMessage), where it applies before that run's run_start.
    mesh.setActorModel(child, { provider: "claude", model: "claude-opus-4-8" }, parent);
    expect(registry.get(child)?.modelConfig?.[0]?.model).toBe("claude-sonnet-5");
    expect(registry.get(child)?.desiredModelConfig?.[0]?.model).toBe("claude-opus-4-8");
    expect(modelSets).toEqual([]);
    mesh.sendMessage(child, "apply staged model", parent);
    await tick();
    expect(registry.get(child)?.modelConfig?.[0]?.model).toBe("claude-opus-4-8");
    expect(registry.get(child)?.desiredModelConfig).toBeUndefined();
    expect(modelSets).toEqual([{ actorId: child, newModel: "claude-opus-4-8" }]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "actor_model_set",
        actorId: child,

        detail: "claude:claude-sonnet-5 -> claude:claude-opus-4-8",
      })
    );

    // Root can stage any child's model under the same boundary rule.
    mesh.setActorModel(parent, { provider: "claude", model: "gemini-3.1-pro" }, "root");
    expect(registry.get(parent)?.modelConfig?.[0]?.model).toBe("claude-sonnet-5");
    mesh.sendMessage(parent, "apply staged model", "root");
    await tick();
    expect(registry.get(parent)?.modelConfig?.[0]?.model).toBe("gemini-3.1-pro");

    // An actor cannot set its own model (tier-raising guard)
    expect(() =>
      mesh.setActorModel(child, { provider: "claude", model: "claude-opus-4-8" }, child)
    ).toThrow(/cannot set its own model/);

    // Sibling cannot set model on another thread
    expect(() =>
      mesh.setActorModel(child, { provider: "claude", model: "claude-opus-4-8" }, sibling)
    ).toThrow(/not an ancestor/);

    // Refuses an empty/whitespace modelConfig pool
    expect(() => mesh.setActorModel(child, { provider: "claude", model: "   " }, parent)).toThrow(
      /missing a model/
    );

    // Throws on unknown thread
    expect(() =>
      mesh.setActorModel("non-existent", { provider: "claude", model: "claude-opus-4-8" }, "root")
    ).toThrow(/unknown thread/);

    // Validation hook failure aborts before patching registry
    expect(() =>
      mesh.setActorModel(child, { provider: "claude", model: "forbidden-model" }, parent)
    ).toThrow(/forbidden model/);
    expect(registry.get(child)?.modelConfig?.[0]?.model).toBe("claude-opus-4-8");
  });

  it("persists, updates, and clears effort independently at run boundaries", async () => {
    const events: MeshEventInput[] = [];
    const validations: Array<{ model?: string; effort?: string }> = [];
    const { mesh, registry, tick } = setup({
      events: (event) => events.push(event),
      validateModel: (_record, modelConfig) => {
        const list = Array.isArray(modelConfig) ? modelConfig : [modelConfig];
        return list.map((entry) => {
          validations.push({ model: entry.model, effort: entry.effort });
          const model = entry.model?.trim();
          if (!model)
            throw new Error(
              `modelConfig entry for provider "${entry.provider}" is missing a model`
            );
          return { provider: entry.provider, model, effort: entry.effort };
        });
      },
    });
    const child = mesh.spawn({
      charter: "codex child",
      parentId: "root",
      modelConfig: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
    });
    expect(registry.get(child)?.modelConfig).toEqual([
      { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
    ]);

    // A complete-object effort-only change: same provider/model, new effort.
    mesh.setActorModel(child, { provider: "codex", model: "gpt-5.6-sol", effort: "xhigh" }, "root");
    expect(registry.get(child)?.modelConfig?.[0]?.effort).toBe("high");
    expect(registry.get(child)?.desiredModelConfig?.[0]?.effort).toBe("xhigh");
    mesh.sendMessage(child, "apply effort", "root");
    await tick();
    expect(registry.get(child)?.modelConfig?.[0]?.effort).toBe("xhigh");
    expect(registry.get(child)?.desiredModelConfig).toBeUndefined();
    expect(validations).toContainEqual({ model: "gpt-5.6-sol", effort: "xhigh" });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "actor_model_set",
        actorId: child,
        detail: "codex:gpt-5.6-sol @ high -> codex:gpt-5.6-sol @ xhigh",
      })
    );

    // Omitting effort in the complete replacement restores the provider/model default.
    mesh.setActorModel(child, { provider: "codex", model: "gpt-5.6-sol" }, "root");
    expect(registry.get(child)?.desiredModelConfig?.[0]?.effort).toBeUndefined();
    mesh.sendMessage(child, "restore provider default", "root");
    await tick();
    expect(registry.get(child)?.modelConfig?.[0]?.effort).toBeUndefined();
    expect(registry.get(child)?.desiredModelConfig).toBeUndefined();
  });

  it("rejects an effort-only update when there is no current model on record to carry forward", () => {
    // A root using its provider's own default model (#169) has no concrete
    // model to record — commands/start.ts leaves `modelConfig` unset on that
    // ActorRecord entirely (see rootRecord construction). With no current
    // model to fall back to, an effort-only update has nothing to carry the
    // model from and must fail rather than silently pick a default; this
    // mirrors production's `fillModelConfigFromCurrent` + `validateModelConfigPool`
    // wiring in start.ts, which the fake `validateModel` below stands in for.
    const validations: Array<{ model?: string; effort?: string }> = [];
    const { mesh, registry } = setup({
      validateModel: (_record, modelConfig) => {
        const list = Array.isArray(modelConfig) ? modelConfig : [modelConfig];
        return list.map((entry) => {
          validations.push({ model: entry.model, effort: entry.effort });
          const model = entry.model?.trim();
          if (!model)
            throw new Error(
              `modelConfig entry for provider "${entry.provider}" is missing a model`
            );
          return { provider: entry.provider, model, effort: entry.effort };
        });
      },
    });
    expect(registry.get("root")?.modelConfig).toBeUndefined();

    expect(() =>
      mesh.setActorModel("root", { provider: "claude", effort: "high" }, "root")
    ).toThrow(/missing a model/);
    expect(validations).toEqual([{ model: undefined, effort: "high" }]);
    expect(registry.get("root")?.desiredModelConfig).toBeUndefined();
  });

  it("lets only the root set its own portable model at its run boundary", () => {
    const events: MeshEventInput[] = [];
    const modelSets: Array<{ actorId: string; newModel: string; record: ActorRecord }> = [];
    const { mesh, registry } = setup({
      events: (event) => events.push(event),
      onModelSet: (actorId, modelConfig, record) =>
        modelSets.push({ actorId, newModel: modelConfig[0]?.model, record }),
    });
    registry.patch("root", {
      modelConfig: [{ provider: "claude", model: "claude-opus-4-8" }],
      context: { type: "portable", mode: "ledger" },
    });
    const child = mesh.spawn({
      charter: "child",
      parentId: "root",
      modelConfig: { provider: "claude", model: "claude-sonnet-5" },
    });

    mesh.setActorModel("root", { provider: "codex", model: "gpt-5.6-sol" }, "root");

    expect(registry.get("root")?.modelConfig).toEqual([
      { provider: "claude", model: "claude-opus-4-8" },
    ]);
    expect(registry.get("root")?.desiredModelConfig).toEqual([
      { provider: "codex", model: "gpt-5.6-sol" },
    ]);
    expect(() =>
      mesh.setActorModel(child, { provider: "claude", model: "claude-opus-4-8" }, child)
    ).toThrow(/cannot set its own model/);

    mesh.finishInboxRun("root");

    expect(registry.get("root")?.modelConfig).toEqual([
      { provider: "codex", model: "gpt-5.6-sol" },
    ]);
    expect(registry.get("root")?.desiredModelConfig).toBeUndefined();
    expect(modelSets).toEqual([
      {
        actorId: "root",
        newModel: "gpt-5.6-sol",
        record: expect.objectContaining({
          modelConfig: [{ provider: "codex", model: "gpt-5.6-sol" }],
        }),
      },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "actor_model_set",
        actorId: "root",
        detail: "claude:claude-opus-4-8 -> codex:gpt-5.6-sol",
      })
    );
  });

  it("setActorModel supports cross-provider moves for portable actors and rejects them for native actors", async () => {
    const events: MeshEventInput[] = [];
    const validations: Array<{ recordId: string; newModel?: string; newProvider?: string }> = [];
    const { mesh, registry, tick } = setup({
      events: (event) => events.push(event),
      validateModel: (record, modelConfig) => {
        const list = Array.isArray(modelConfig) ? modelConfig : [modelConfig];
        return list.map((entry) => {
          const provider = entry.provider ?? record.modelConfig?.[0]?.provider;
          validations.push({
            recordId: record.id,
            newModel: entry.model,
            newProvider: entry.provider,
          });
          if (provider === "antigravity" && entry.model === "invalid-model") {
            throw new Error("invalid model for antigravity");
          }
          const sel = normalizeModelEffortSelection(provider as string, entry.model, entry.effort);
          if (!sel.model) {
            throw new Error(`modelConfig entry for provider "${provider}" is missing a model`);
          }
          return { provider: provider as string, model: sel.model, effort: sel.effort };
        });
      },
    });

    // 1. Portable ledger actor cross-provider move
    const ledgerChild = mesh.spawn({
      charter: "ledger child",
      parentId: "root",
      modelConfig: { provider: "claude", model: "claude-opus-4-8" },
      context: { type: "portable", mode: "ledger" },
    });
    mesh.setActorModel(
      ledgerChild,
      { provider: "antigravity", model: "gemini-3.7-flash-high" },
      "root"
    );
    expect(registry.get(ledgerChild)?.modelConfig).toEqual([
      { provider: "claude", model: "claude-opus-4-8" },
    ]);
    expect(registry.get(ledgerChild)?.desiredModelConfig).toEqual([
      { provider: "antigravity", model: "gemini-3.7-flash", effort: "high" },
    ]);
    mesh.sendMessage(ledgerChild, "apply staged provider", "root");
    await tick();
    expect(registry.get(ledgerChild)?.modelConfig).toEqual([
      { provider: "antigravity", model: "gemini-3.7-flash", effort: "high" },
    ]);
    expect(registry.get(ledgerChild)?.desiredModelConfig).toBeUndefined();
    expect(validations).toContainEqual({
      recordId: ledgerChild,
      newModel: "gemini-3.7-flash-high",
      newProvider: "antigravity",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "actor_model_set",
        actorId: ledgerChild,
        detail: "claude:claude-opus-4-8 -> antigravity:gemini-3.7-flash @ high",
      })
    );

    // 2. Portable tail actor cross-provider move
    const tailChild = mesh.spawn({
      charter: "tail child",
      parentId: "root",
      modelConfig: { provider: "claude", model: "claude-sonnet-5" },
      context: { type: "portable", mode: "tail" },
    });
    mesh.setActorModel(tailChild, { provider: "codex", model: "gpt-5.6-sol" }, "root");
    expect(registry.get(tailChild)?.modelConfig).toEqual([
      { provider: "claude", model: "claude-sonnet-5" },
    ]);
    mesh.sendMessage(tailChild, "apply staged provider", "root");
    await tick();
    expect(registry.get(tailChild)?.modelConfig).toEqual([
      { provider: "codex", model: "gpt-5.6-sol" },
    ]);

    // 3. Validation failure aborts cross-provider move
    expect(() =>
      mesh.setActorModel(ledgerChild, { provider: "antigravity", model: "invalid-model" }, "root")
    ).toThrow(/invalid model for antigravity/);
    expect(registry.get(ledgerChild)?.modelConfig?.[0]?.model).toBe("gemini-3.7-flash");

    // 4. Non-portable (native context) actor rejects provider move
    const nativeChild = mesh.spawn({
      charter: "native child",
      parentId: "root",
      modelConfig: { provider: "claude", model: "claude-sonnet-5" },
      context: { type: "native" },
    });
    expect(() =>
      mesh.setActorModel(
        nativeChild,
        { provider: "antigravity", model: "gemini-3.7-flash-high" },
        "root"
      )
    ).toThrow(/Cannot change provider on non-portable actor/);
    expect(registry.get(nativeChild)?.modelConfig).toEqual([
      { provider: "claude", model: "claude-sonnet-5" },
    ]);

    // 5. Default context (implicit native) rejects provider move
    const defaultContextChild = mesh.spawn({
      charter: "default child",
      parentId: "root",
      modelConfig: { provider: "claude", model: "claude-sonnet-5" },
    });
    expect(() =>
      mesh.setActorModel(
        defaultContextChild,
        { provider: "antigravity", model: "gemini-3.7-flash-high" },
        "root"
      )
    ).toThrow(/Cannot change provider on non-portable actor/);

    // 6. Native actor accepts model update when explicit provider equals existing provider
    mesh.setActorModel(nativeChild, { provider: "claude", model: "claude-opus-4-8" }, "root");
    expect(registry.get(nativeChild)?.modelConfig?.[0]?.model).toBe("claude-sonnet-5");
    mesh.sendMessage(nativeChild, "apply staged model", "root");
    await tick();
    expect(registry.get(nativeChild)?.modelConfig).toEqual([
      { provider: "claude", model: "claude-opus-4-8" },
    ]);

    // 7. Defers model/provider changes while actor is running; applies at run end
    const { provider: deferredRunProvider, releaseAll: releaseDeferred } = deferredProvider();
    const modelSetCalls: Array<{ actorId: string; newModel: string; record: ActorRecord }> = [];
    const busyMeshSetup = setup({
      sharedProvider: deferredRunProvider,
      events: (event) => events.push(event),
      onModelSet: (actorId, modelConfig, record) =>
        modelSetCalls.push({ actorId, newModel: modelConfig[0]?.model, record }),
    });

    const busyChild = busyMeshSetup.mesh.spawn({
      charter: "busy child",
      parentId: "root",
      modelConfig: { provider: "claude", model: "claude-opus-4-8" },
      context: { type: "portable", mode: "ledger" },
    });

    // Start a run so the actor is running
    busyMeshSetup.mesh.sendMessage(busyChild, "run 1", "root");
    await busyMeshSetup.tick();
    expect(busyMeshSetup.mesh.activeRunState(busyChild)?.phase).toBe("running");

    // setActorModel does NOT reject when running; persists desiredModelConfig
    busyMeshSetup.mesh.setActorModel(
      busyChild,
      { provider: "antigravity", model: "gemini-3.7-flash", effort: "high" },
      "root"
    );
    expect(busyMeshSetup.registry.get(busyChild)?.modelConfig).toEqual([
      { provider: "claude", model: "claude-opus-4-8" },
    ]);
    expect(busyMeshSetup.registry.get(busyChild)?.desiredModelConfig).toEqual([
      { provider: "antigravity", model: "gemini-3.7-flash", effort: "high" },
    ]);
    expect(modelSetCalls).toHaveLength(0);

    // Overwrite test (last-write-wins before boundary)
    busyMeshSetup.mesh.setActorModel(
      busyChild,
      { provider: "codex", model: "gpt-5.6-sol" },
      "root"
    );
    expect(busyMeshSetup.registry.get(busyChild)?.desiredModelConfig).toEqual([
      { provider: "codex", model: "gpt-5.6-sol" },
    ]);

    // Complete the in-flight run; deferred model is applied at the run end boundary
    releaseDeferred();
    await busyMeshSetup.tick();
    expect(busyMeshSetup.registry.get(busyChild)?.modelConfig).toEqual([
      { provider: "codex", model: "gpt-5.6-sol" },
    ]);
    expect(busyMeshSetup.registry.get(busyChild)?.desiredModelConfig).toBeUndefined();
    expect(modelSetCalls).toContainEqual(
      expect.objectContaining({
        actorId: busyChild,
        newModel: "gpt-5.6-sol",
        record: expect.objectContaining({
          modelConfig: [{ provider: "codex", model: "gpt-5.6-sol" }],
        }),
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "actor_model_set",
        actorId: busyChild,
        detail: "claude:claude-opus-4-8 -> codex:gpt-5.6-sol",
      })
    );

    // Queued run boundary test: occupy the one concurrency slot so this actor is
    // genuinely waiting in the mesh gate (rather than merely dirty while running).
    const queuedDeferred = deferredProvider();
    const queuedMeshSetup = setup({
      maxConcurrent: 1,
      sharedProvider: queuedDeferred.provider,
      events: (event) => events.push(event),
      onModelSet: (actorId, modelConfig, record) =>
        modelSetCalls.push({ actorId, newModel: modelConfig[0]?.model, record }),
    });
    const blocker = queuedMeshSetup.mesh.spawn({
      charter: "blocker",
      parentId: "root",
      modelConfig: { provider: "claude", model: "claude-sonnet-5" },
    });
    const queuedChild = queuedMeshSetup.mesh.spawn({
      charter: "queued child",
      parentId: "root",
      modelConfig: { provider: "claude", model: "claude-sonnet-5" },
      context: { type: "portable", mode: "ledger" },
    });
    queuedMeshSetup.mesh.sendMessage(blocker, "hold the slot", "root");
    await queuedMeshSetup.tick();
    expect(queuedMeshSetup.mesh.activeRunState(blocker)?.phase).toBe("running");

    queuedMeshSetup.mesh.sendMessage(queuedChild, "queued run", "root");
    await queuedMeshSetup.tick();
    expect(queuedMeshSetup.mesh.activeRunState(queuedChild)?.phase).toBe("queued");

    queuedMeshSetup.mesh.setActorModel(
      queuedChild,
      { provider: "claude", model: "claude-opus-4-8" },
      "root"
    );
    expect(queuedMeshSetup.registry.get(queuedChild)?.modelConfig).toEqual([
      { provider: "claude", model: "claude-sonnet-5" },
    ]);
    expect(queuedMeshSetup.registry.get(queuedChild)?.desiredModelConfig).toEqual([
      { provider: "claude", model: "claude-opus-4-8" },
    ]);

    // Releasing the blocker admits the queued run. Per #199, a tuple staged
    // while queued is applied at THIS dispatch — before the queued run's own
    // run_start — not deferred to the end of the run it was staged behind.
    queuedDeferred.releaseAll();
    await queuedMeshSetup.tick();
    expect(queuedMeshSetup.mesh.activeRunState(queuedChild)?.phase).toBe("running");
    expect(queuedMeshSetup.registry.get(queuedChild)?.modelConfig).toEqual([
      { provider: "claude", model: "claude-opus-4-8" },
    ]);
    expect(queuedMeshSetup.registry.get(queuedChild)?.desiredModelConfig).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "actor_model_set",
        actorId: queuedChild,
        detail: "claude:claude-sonnet-5 -> claude:claude-opus-4-8",
      })
    );

    // The now-launched run itself completes on the tuple it was admitted
    // with; nothing further is staged, so this release is a plain run end.
    queuedDeferred.releaseAll();
    await queuedMeshSetup.tick();
    expect(queuedMeshSetup.registry.get(queuedChild)?.modelConfig).toEqual([
      { provider: "claude", model: "claude-opus-4-8" },
    ]);
    expect(queuedMeshSetup.registry.get(queuedChild)?.desiredModelConfig).toBeUndefined();

    // 8. Dynamic provider halt check: moved actor obeys new provider's halt state on wake
    let providerBExecuted = false;
    let haltedProvider = "";
    const mockProviderA: CodingProvider = {
      name: "provider-a",
      providerName: "provider-a",
      run: async () => ({ success: true, exitCode: 0, output: "a" }),
    };
    const mockProviderB: CodingProvider = {
      name: "provider-b",
      providerName: "provider-b",
      run: async () => {
        providerBExecuted = true;
        return { success: true, exitCode: 0, output: "b" };
      },
    };
    const providerByName = new Map<string, CodingProvider>([["provider-a", mockProviderA]]);
    let dynamicMesh!: ActorMesh;
    const dynamicMeshSetup = setup({
      isHalted: (p) => p === haltedProvider,
      onModelSet: (actorId, modelConfig) => {
        if (modelConfig[0]?.provider === "provider-b") {
          providerByName.set("provider-b", mockProviderB);
        }
        // Production onModelSet wiring adopts the staged pool on the live actor;
        // ActorMesh itself never calls setModelConfig (see Actor.setModelConfig doc).
        dynamicMesh.get(actorId)?.setModelConfig?.(modelConfig);
      },
      createActor: (ctx) => {
        let actor!: Actor;
        actor = new Actor({
          id: ctx.record.id,
          cwd: `/tmp/${ctx.record.id}`,
          modelConfig: ctx.record.modelConfig ?? [{ provider: "provider-a" }],
          resolveProvider: (config) => {
            const base = providerByName.get(config.provider);
            if (!base) throw new Error(`no provider registered for ${config.provider}`);
            return {
              ...base,
              run: async (runOpts) => {
                const result = await base.run(runOpts);
                if (result.success) actor.declareYield();
                return result;
              },
            };
          },
          mcpServers: [],
          loadSessionId: () => ctx.getRecord()?.sessionId,
          saveSessionId: (id) => ctx.mesh.actors.patch(ctx.record.id, { sessionId: id }),
          buildPrompt: () => ({ prompt: "Work from your inbox." }),
          gate: ctx.gate,
          beforeRun: ctx.beforeRun,
          onQueued: ctx.onQueued,
          onRunEnd: ctx.onRunEnd,
          onRuntimeStateChanged: ctx.onRuntimeStateChanged,
          debounceMs: DEBOUNCE,
        });
        return actor;
      },
    });
    dynamicMesh = dynamicMeshSetup.mesh;
    const movingWorker = dynamicMeshSetup.mesh.spawn({
      charter: "moving worker",
      parentId: "root",
      modelConfig: { provider: "provider-a", model: "model-a" },
      context: { type: "portable", mode: "ledger" },
    });
    // Move to provider-b
    dynamicMeshSetup.mesh.setActorModel(
      movingWorker,
      { provider: "provider-b", model: "model-b" },
      "root"
    );
    expect(dynamicMeshSetup.registry.get(movingWorker)?.modelConfig?.[0]?.provider).toBe(
      "provider-a"
    );
    dynamicMeshSetup.mesh.sendMessage(movingWorker, "apply staged provider", "root");
    await dynamicMeshSetup.tick();
    expect(dynamicMeshSetup.registry.get(movingWorker)?.modelConfig?.[0]?.provider).toBe(
      "provider-b"
    );
    // Per #199, the staged pool applies at THIS dispatch (movingWorker was
    // idle when staged), so this very run already launched on provider-b.
    expect(providerBExecuted).toBe(true);
    providerBExecuted = false;

    // When provider-b is halted, wake is skipped (provider-a halt does not block it)
    haltedProvider = "provider-b";
    dynamicMeshSetup.mesh.sendMessage(movingWorker, "do work", "root");
    await dynamicMeshSetup.tick();
    expect(providerBExecuted).toBe(false);

    // When provider-b is unhalted, wake runs on mockProviderB
    haltedProvider = "";
    dynamicMeshSetup.mesh.sendMessage(movingWorker, "do work", "root");
    await dynamicMeshSetup.tick();
    expect(providerBExecuted).toBe(true);
  });

  // #199: a tuple staged while an actor is queued/idle must apply at that
  // actor's next dispatch (before run_start / provider launch), not at the
  // end of the run it happens to land in.
  describe("setActorModel dispatch-time boundary (#199, extended to pools)", () => {
    it("applies a pool staged while idle to the very next run, before that run's provider launch", async () => {
      const events: MeshEventInput[] = [];
      const seenModelAtRunStart: string[] = [];
      const { mesh, registry, tick } = setup({
        events: (event) => events.push(event),
        sharedProvider: {
          name: "test-provider",
          providerName: "test-provider",
          run: async () => {
            seenModelAtRunStart.push(registry.get(worker)?.modelConfig?.[0]?.model ?? "");
            return { success: true, exitCode: 0, output: "ok" };
          },
        },
      });

      const worker = mesh.spawn({
        charter: "worker",
        parentId: "root",
        modelConfig: { provider: "test-provider", model: "model-a" },
        context: { type: "portable", mode: "ledger" },
      });

      // Idle, no unhandled inbox: staging must not itself dispatch anything.
      mesh.setActorModel(worker, { provider: "test-provider", model: "model-b" }, "root");
      expect(mesh.activeRunState(worker)).toBeNull();
      expect(registry.get(worker)?.modelConfig?.[0]?.model).toBe("model-a");
      expect(registry.get(worker)?.desiredModelConfig?.[0]?.model).toBe("model-b");

      // The next dispatch (a fresh message) must already run on the staged
      // pool — the run body itself observes "model-b", not "model-a".
      mesh.sendMessage(worker, "work", "root");
      await tick();

      expect(seenModelAtRunStart).toEqual(["model-b"]);
      expect(registry.get(worker)?.modelConfig?.[0]?.model).toBe("model-b");
      expect(registry.get(worker)?.desiredModelConfig).toBeUndefined();
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "actor_model_set", actorId: worker })
      );
    });

    it("applies a pool staged while queued to that same queued run, before it launches", async () => {
      const seenModelAtRunStart: string[] = [];
      const deferred = deferredProvider();
      const { mesh, registry, tick } = setup({
        maxConcurrent: 1,
        sharedProvider: {
          name: "deferred",
          providerName: "deferred",
          run: async (opts) => {
            if (opts.cwd === `/tmp/${worker}`) {
              seenModelAtRunStart.push(registry.get(worker)?.modelConfig?.[0]?.model ?? "");
            }
            return deferred.provider.run(opts);
          },
        },
      });

      const blocker = mesh.spawn({ charter: "blocker", parentId: "root" });
      const worker = mesh.spawn({
        charter: "worker",
        parentId: "root",
        modelConfig: { provider: "deferred", model: "model-a" },
        context: { type: "portable", mode: "ledger" },
      });

      mesh.sendMessage(blocker, "hold the slot", "root");
      await tick();
      expect(mesh.activeRunState(blocker)?.phase).toBe("running");

      mesh.sendMessage(worker, "work", "root");
      await tick();
      expect(mesh.activeRunState(worker)?.phase).toBe("queued");

      // Re-pin while queued, still behind the blocker.
      mesh.setActorModel(worker, { provider: "deferred", model: "model-b" }, "root");
      expect(registry.get(worker)?.modelConfig?.[0]?.model).toBe("model-a");
      expect(registry.get(worker)?.desiredModelConfig?.[0]?.model).toBe("model-b");

      // Admit the queued run: its own body must already see "model-b".
      deferred.releaseAll();
      await tick();
      expect(mesh.activeRunState(worker)?.phase).toBe("running");
      expect(seenModelAtRunStart).toEqual(["model-b"]);
      expect(registry.get(worker)?.modelConfig?.[0]?.model).toBe("model-b");
      expect(registry.get(worker)?.desiredModelConfig).toBeUndefined();

      deferred.releaseAll();
      await tick();
    });

    it("keeps an in-flight run on its already-launched pool; only the following run picks up the staged one", async () => {
      const seenModelAtRunStart: string[] = [];
      const deferred = deferredProvider();
      const { mesh, registry, tick } = setup({
        sharedProvider: {
          name: "deferred",
          providerName: "deferred",
          run: async (opts) => {
            seenModelAtRunStart.push(registry.get(worker)?.modelConfig?.[0]?.model ?? "");
            return deferred.provider.run(opts);
          },
        },
      });

      const worker = mesh.spawn({
        charter: "worker",
        parentId: "root",
        modelConfig: { provider: "deferred", model: "model-a" },
        context: { type: "portable", mode: "ledger" },
      });

      mesh.sendMessage(worker, "run 1", "root");
      await tick();
      expect(mesh.activeRunState(worker)?.phase).toBe("running");
      expect(seenModelAtRunStart).toEqual(["model-a"]);

      // Staged mid-flight: must not disturb the run already underway.
      mesh.setActorModel(worker, { provider: "deferred", model: "model-b" }, "root");
      expect(registry.get(worker)?.modelConfig?.[0]?.model).toBe("model-a");

      deferred.releaseAll();
      await tick();
      expect(mesh.activeRunState(worker)).toBeNull();
      expect(registry.get(worker)?.modelConfig?.[0]?.model).toBe("model-b");
      expect(registry.get(worker)?.desiredModelConfig).toBeUndefined();

      // The following run is the first to actually execute on "model-b".
      mesh.sendMessage(worker, "run 2", "root");
      await tick();
      expect(seenModelAtRunStart).toEqual(["model-a", "model-b"]);

      deferred.releaseAll();
      await tick();
    });

    it("emits actor_model_set at the applying dispatch, not when the pool is merely staged", async () => {
      const trace: string[] = [];
      const { mesh, tick } = setup({
        events: (event) => {
          if (event.kind === "actor_model_set") trace.push(`event:${event.actorId}`);
        },
        sharedProvider: {
          name: "test-provider",
          providerName: "test-provider",
          run: async () => {
            trace.push("run-body");
            return { success: true, exitCode: 0, output: "ok" };
          },
        },
      });

      const worker = mesh.spawn({
        charter: "worker",
        parentId: "root",
        modelConfig: { provider: "test-provider", model: "model-a" },
        context: { type: "portable", mode: "ledger" },
      });

      mesh.setActorModel(worker, { provider: "test-provider", model: "model-b" }, "root");
      expect(trace).toEqual([]); // no event yet: nothing has been applied

      mesh.sendMessage(worker, "work", "root");
      await tick();

      // The event fires at dispatch, ahead of the run body it applies to.
      expect(trace).toEqual([`event:${worker}`, "run-body"]);
    });

    it("re-pinning an idle actor with unhandled inbox dispatches exactly one run, already on the new pool", async () => {
      let runCount = 0;
      const seenModelAtRunStart: string[] = [];
      const { mesh, registry, tick } = setup({
        onQueued: (actorId, ctx) =>
          mesh.recordEvent({ kind: "run_queued", actorId, detail: ctx.mode }),
        sharedProvider: {
          name: "test-provider",
          providerName: "test-provider",
          run: async () => {
            runCount++;
            seenModelAtRunStart.push(registry.get(worker)?.modelConfig?.[0]?.model ?? "");
            if (runCount === 1) return { success: false, exitCode: 1, output: "failed" };
            return { success: true, exitCode: 0, output: "ok" };
          },
        },
      });

      const worker = mesh.spawn({
        charter: "worker",
        parentId: "root",
        modelConfig: { provider: "test-provider", model: "model-a" },
        context: { type: "portable", mode: "ledger" },
      });

      mesh.sendMessage(worker, "work", "root");
      await tick();
      expect(runCount).toBe(1);
      expect(mesh.activeRunState(worker)).toBeNull(); // idle again, failed run left inbox unhandled

      // Re-pin: this is the #202 path (idle + unhandled inbox => immediate dispatch).
      mesh.setActorModel(worker, { provider: "test-provider", model: "model-c" }, "root");
      await tick();

      // Exactly one new run — the re-pin dispatch itself, not a duplicate.
      expect(runCount).toBe(2);
      expect(seenModelAtRunStart).toEqual(["model-a", "model-c"]);
      expect(registry.get(worker)?.modelConfig?.[0]?.model).toBe("model-c");
    });
  });

  // #199 amend gap 2 (extended to pools): the gate reads `this.opts.modelConfig`
  // once, before selecting a pacer lane. A pool staged while the request is
  // genuinely queued behind mesh capacity must not launch (and charge the
  // interval clock) under the stale lane it was submitted to.
  describe("cross-provider swap while queued is gated under the new provider (#199 amend gap 2, extended to pools)", () => {
    it("a provider swap staged while genuinely queued behind mesh capacity launches under the new provider, never the old one", async () => {
      const providerARuns: string[] = [];
      const providerBRuns: string[] = [];
      const liveActors = new Map<string, Actor>();
      const blockerDeferred = deferredProvider();
      const providerByName = new Map<string, CodingProvider>([
        [
          "provider-a",
          {
            name: "provider-a",
            providerName: "provider-a",
            run: async (runOpts) => {
              providerARuns.push(runOpts.cwd);
              liveActors.get(runOpts.cwd.replace("/tmp/", ""))?.declareYield();
              return { success: true, exitCode: 0, output: "a" };
            },
          },
        ],
      ]);
      const pacers = new Map<string, ProviderPacer>();
      const pacerFor = (name: string): ProviderPacer => {
        let pacer = pacers.get(name);
        if (!pacer) {
          pacer = new ProviderPacer(0);
          pacers.set(name, pacer);
        }
        return pacer;
      };

      const { mesh, registry, tick } = setup({
        maxConcurrent: 1,
        onModelSet: (actorId, newModelConfig) => {
          if (newModelConfig[0]?.provider === "provider-b" && !providerByName.has("provider-b")) {
            providerByName.set("provider-b", {
              name: "provider-b",
              providerName: "provider-b",
              run: async (runOpts) => {
                providerBRuns.push(runOpts.cwd);
                liveActors.get(actorId)?.declareYield();
                return { success: true, exitCode: 0, output: "b" };
              },
            });
          }
          mesh.get(actorId)?.setModelConfig?.(newModelConfig);
        },
        // Mirrors the production providerGate wiring in start.ts: one
        // ProviderPacer lane per provider, revalidated (via applyPendingModel)
        // right before a queued request would actually start.
        providerGate: (fn, candidates, request) => {
          const selected = candidates[0];
          return pacerFor(selected.provider).submit(() => fn(selected), {
            responsive: request.responsive,
            threadId: request.threadId,
            enqueueNormal: request.enqueueNormal,
            revalidateProvider: request.threadId
              ? () => {
                  mesh.applyPendingModel(request.threadId as string);
                  const live = registry.get(request.threadId as string)?.modelConfig?.[0];
                  if (!live) return true;
                  return live.provider === selected.provider;
                }
              : undefined,
          });
        },
        createActor: (ctx) => {
          let actor!: Actor;
          const isBlocker = ctx.record.charter === "blocker";
          actor = new Actor({
            id: ctx.record.id,
            cwd: `/tmp/${ctx.record.id}`,
            modelConfig: isBlocker
              ? [{ provider: "blocker", model: "model-blocker" }]
              : (ctx.record.modelConfig ?? [{ provider: "provider-a", model: "model-a" }]),
            resolveProvider: isBlocker
              ? () => ({
                  ...blockerDeferred.provider,
                  run: async (runOpts) => {
                    const result = await blockerDeferred.provider.run(runOpts);
                    if (result.success) actor.declareYield();
                    return result;
                  },
                })
              : (selected) => {
                  const base = providerByName.get(selected.provider);
                  if (!base) throw new Error(`no provider registered for ${selected.provider}`);
                  return base;
                },
            mcpServers: [],
            loadSessionId: () => ctx.getRecord()?.sessionId,
            saveSessionId: (id) => registry.patch(ctx.record.id, { sessionId: id }),
            buildPrompt: () => ({ prompt: "work" }),
            gate: ctx.gate,
            beforeRun: ctx.beforeRun,
            onQueued: ctx.onQueued,
            onRunEnd: (result) => ctx.onRunEnd(result),
            onRuntimeStateChanged: ctx.onRuntimeStateChanged,
            debounceMs: DEBOUNCE,
          });
          liveActors.set(ctx.record.id, actor);
          return actor;
        },
      });

      const blocker = mesh.spawn({
        charter: "blocker",
        parentId: "root",
        modelConfig: { provider: "blocker", model: "model-blocker" },
      });
      const worker = mesh.spawn({
        charter: "worker",
        parentId: "root",
        modelConfig: { provider: "provider-a", model: "model-a" },
        context: { type: "portable", mode: "ledger" },
      });

      // Occupy the mesh's one concurrency slot.
      mesh.sendMessage(blocker, "hold the slot", "root");
      await tick();
      expect(mesh.activeRunState(blocker)?.phase).toBe("running");

      // Worker is genuinely queued behind mesh capacity, not merely staged.
      mesh.sendMessage(worker, "work", "root");
      await tick();
      expect(mesh.activeRunState(worker)?.phase).toBe("queued");

      // Stage the cross-provider swap while the request already sits in the
      // mesh queue — the exact race the retry/revalidation exists for.
      mesh.setActorModel(worker, { provider: "provider-b", model: "model-b" }, "root");
      expect(registry.get(worker)?.modelConfig?.[0]?.provider).toBe("provider-a");

      // Free the slot: the queued worker request is admitted for the first
      // time here, after the swap was staged.
      blockerDeferred.releaseAll();
      await tick();

      expect(registry.get(worker)?.modelConfig?.[0]?.provider).toBe("provider-b");
      expect(providerBRuns).toEqual([`/tmp/${worker}`]);
      expect(providerARuns).toEqual([]);
    });
  });

  // #199 amend gap 3: a halt already in effect on provider B, from before the
  // swap was even staged, must still block a queued-on-A ticket that lands on
  // B only once it is naturally selected from the mesh queue. No `/halt`
  // command fires after staging, so `cancelHaltedQueuedRuns` never scans this
  // ticket — the only remaining choke point is the RunStartStaleProviderError
  // retry in `Actor.executeTurn`, which must re-check the halt gate (via
  // `beforeRun`) before resubmitting under the newly-live provider.
  describe("cross-provider swap onto an already-halted provider while genuinely queued (#199 amend gap 3, extended to pools)", () => {
    it("never invokes the halted provider, leaves nothing active, and replays once on resume without a fresh external delivery", async () => {
      const providerARuns: string[] = [];
      const providerBRuns: string[] = [];
      const liveActors = new Map<string, Actor>();
      const blockerDeferred = deferredProvider();
      const halted = new Set<string>();
      const providerByName = new Map<string, CodingProvider>([
        [
          "provider-a",
          {
            name: "provider-a",
            providerName: "provider-a",
            run: async (runOpts) => {
              providerARuns.push(runOpts.cwd);
              liveActors.get(runOpts.cwd.replace("/tmp/", ""))?.declareYield();
              return { success: true, exitCode: 0, output: "a" };
            },
          },
        ],
      ]);
      const pacers = new Map<string, ProviderPacer>();
      const pacerFor = (name: string): ProviderPacer => {
        let pacer = pacers.get(name);
        if (!pacer) {
          pacer = new ProviderPacer(0);
          pacers.set(name, pacer);
        }
        return pacer;
      };

      const { mesh, registry, tick } = setup({
        maxConcurrent: 1,
        isHalted: (provider) => (provider ? halted.has(provider) : false),
        onModelSet: (actorId, newModelConfig) => {
          if (newModelConfig[0]?.provider === "provider-b" && !providerByName.has("provider-b")) {
            providerByName.set("provider-b", {
              name: "provider-b",
              providerName: "provider-b",
              run: async (runOpts) => {
                providerBRuns.push(runOpts.cwd);
                liveActors.get(actorId)?.declareYield();
                return { success: true, exitCode: 0, output: "b" };
              },
            });
          }
          mesh.get(actorId)?.setModelConfig?.(newModelConfig);
        },
        // Mirrors the production providerGate wiring in start.ts (same as the
        // gap-2 describe block above).
        providerGate: (fn, candidates, request) => {
          const selected = candidates[0];
          return pacerFor(selected.provider).submit(() => fn(selected), {
            responsive: request.responsive,
            threadId: request.threadId,
            enqueueNormal: request.enqueueNormal,
            revalidateProvider: request.threadId
              ? () => {
                  mesh.applyPendingModel(request.threadId as string);
                  const live = registry.get(request.threadId as string)?.modelConfig?.[0];
                  if (!live) return true;
                  return live.provider === selected.provider;
                }
              : undefined,
          });
        },
        createActor: (ctx) => {
          let actor!: Actor;
          const isBlocker = ctx.record.charter === "blocker";
          actor = new Actor({
            id: ctx.record.id,
            cwd: `/tmp/${ctx.record.id}`,
            modelConfig: isBlocker
              ? [{ provider: "blocker", model: "model-blocker" }]
              : (ctx.record.modelConfig ?? [{ provider: "provider-a", model: "model-a" }]),
            resolveProvider: isBlocker
              ? () => ({
                  ...blockerDeferred.provider,
                  run: async (runOpts) => {
                    const result = await blockerDeferred.provider.run(runOpts);
                    if (result.success) actor.declareYield();
                    return result;
                  },
                })
              : (selected) => {
                  const base = providerByName.get(selected.provider);
                  if (!base) throw new Error(`no provider registered for ${selected.provider}`);
                  return base;
                },
            mcpServers: [],
            loadSessionId: () => ctx.getRecord()?.sessionId,
            saveSessionId: (id) => registry.patch(ctx.record.id, { sessionId: id }),
            buildPrompt: () => ({ prompt: "work" }),
            gate: ctx.gate,
            beforeRun: ctx.beforeRun,
            onQueued: ctx.onQueued,
            onRunEnd: (result) => ctx.onRunEnd(result),
            onRuntimeStateChanged: ctx.onRuntimeStateChanged,
            debounceMs: DEBOUNCE,
          });
          liveActors.set(ctx.record.id, actor);
          return actor;
        },
      });

      // Provider B is already halted, before anything is staged or queued.
      halted.add("provider-b");

      const blocker = mesh.spawn({
        charter: "blocker",
        parentId: "root",
        modelConfig: { provider: "blocker", model: "model-blocker" },
      });
      const worker = mesh.spawn({
        charter: "worker",
        parentId: "root",
        modelConfig: { provider: "provider-a", model: "model-a" },
        context: { type: "portable", mode: "ledger" },
      });

      // Occupy the mesh's one concurrency slot.
      mesh.sendMessage(blocker, "hold the slot", "root");
      await tick();
      expect(mesh.activeRunState(blocker)?.phase).toBe("running");

      // Worker's beforeRun passes on provider-a (not halted) and sits
      // genuinely queued behind mesh capacity.
      mesh.sendMessage(worker, "work", "root");
      await tick();
      expect(mesh.activeRunState(worker)?.phase).toBe("queued");

      // Stage the cross-provider swap onto the already-halted provider-b
      // while worker is genuinely queued. No halt command fires here, so
      // `cancelHaltedQueuedRuns` is never invoked for this ticket.
      mesh.setActorModel(worker, { provider: "provider-b", model: "model-b" }, "root");
      expect(registry.get(worker)?.modelConfig?.[0]?.provider).toBe("provider-a");
      expect(halted.has("provider-b")).toBe(true);

      // Free the slot: the queued ticket is naturally selected here, well
      // after the swap was staged and B was halted.
      blockerDeferred.releaseAll();
      await tick();

      // The halted provider must never actually be invoked, and the run must
      // not be left dangling as active.
      expect(providerBRuns).toEqual([]);
      expect(providerARuns).toEqual([]);
      expect(mesh.runningThreadIds()).toEqual(new Set());
      expect(mesh.queuedThreadIds()).toEqual(new Set());

      // Clear the halt and drive the production resume/reconcile path: the
      // same unhandled work launches once on provider-b, with no fresh
      // external delivery.
      halted.delete("provider-b");
      mesh.resumeCancelledRuns();
      mesh.reconcileUnseenInbox();
      await tick();

      expect(providerBRuns).toEqual([`/tmp/${worker}`]);
      expect(providerARuns).toEqual([]);
    });
  });

  // #169 pool-aware HALT keying: with a genuine multi-candidate pool wired
  // through `submitPoolGate` (mirroring the production providerGate in
  // start.ts), a queued run's cancellation must key off the *actual reserved
  // lane* (`mesh.getSelection`), not a whole-pool `allCandidatesHalted` scan —
  // otherwise a halt on the reserved lane is masked by a healthy, unreserved
  // sibling still sitting in the same declared pool.
  describe("cancellation keys off the actual reserved lane, not the whole pool (#169)", () => {
    it("cancels a queued run whose reserved lane is halted even though a healthy sibling remains in the pool, then resumes cleanly once cleared", async () => {
      const poolARuns: string[] = [];
      const poolBRuns: string[] = [];
      const liveActors = new Map<string, Actor>();
      const blockerDeferred = deferredProvider();
      const halted = new Set<string>();
      const providerByName = new Map<string, CodingProvider>([
        [
          "pool-a",
          {
            name: "pool-a",
            providerName: "pool-a",
            run: async (runOpts) => {
              poolARuns.push(runOpts.cwd);
              liveActors.get(runOpts.cwd.replace("/tmp/", ""))?.declareYield();
              return { success: true, exitCode: 0, output: "a" };
            },
          },
        ],
        [
          "pool-b",
          {
            name: "pool-b",
            providerName: "pool-b",
            run: async (runOpts) => {
              poolBRuns.push(runOpts.cwd);
              liveActors.get(runOpts.cwd.replace("/tmp/", ""))?.declareYield();
              return { success: true, exitCode: 0, output: "b" };
            },
          },
        ],
      ]);
      const pacers = new Map<string, ProviderPacer>();
      const pacerFor = (name: string): ProviderPacer => {
        let pacer = pacers.get(name);
        if (!pacer) {
          pacer = new ProviderPacer(0);
          pacers.set(name, pacer);
        }
        return pacer;
      };

      const { mesh, registry, tick } = setup({
        maxConcurrent: 1,
        isHalted: (provider) => (provider ? halted.has(provider) : false),
        // Mirrors the production providerGate wiring in start.ts: a real
        // multi-lane pool selection via `submitPoolGate`, not the naive
        // `candidates[0]` scaffold the gap-2/gap-3 blocks above use.
        providerGate: (fn, candidates, request) => {
          const lanes: PoolLaneCandidate<RawProviderModelConfig>[] = candidates.map((c) => ({
            config: c,
            lane: c.provider,
            pacer: pacerFor(c.provider),
          }));
          return submitPoolGate(fn, lanes, {
            responsive: request.responsive,
            threadId: request.threadId,
            enqueueNormal: request.enqueueNormal,
            isHalted: (c) => halted.has(c.provider),
            onSelected: request.threadId
              ? (selection) =>
                  request.onSelected?.({
                    provider: selection.candidate.provider,
                    lane: selection.lane,
                    model: selection.candidate.model ?? "",
                    effort: selection.candidate.effort,
                    declaredIndex: selection.declaredIndex,
                    eligibleAt: selection.eligibleAt,
                    responsive: selection.responsive,
                  })
              : undefined,
          });
        },
        createActor: (ctx) => {
          let actor!: Actor;
          const isBlocker = ctx.record.charter === "blocker";
          actor = new Actor({
            id: ctx.record.id,
            cwd: `/tmp/${ctx.record.id}`,
            modelConfig: isBlocker
              ? [{ provider: "blocker", model: "model-blocker" }]
              : (ctx.record.modelConfig ?? [{ provider: "pool-a", model: "model-a" }]),
            resolveProvider: isBlocker
              ? () => ({
                  ...blockerDeferred.provider,
                  run: async (runOpts) => {
                    const result = await blockerDeferred.provider.run(runOpts);
                    if (result.success) actor.declareYield();
                    return result;
                  },
                })
              : (selected) => {
                  const base = providerByName.get(selected.provider);
                  if (!base) throw new Error(`no provider registered for ${selected.provider}`);
                  return base;
                },
            mcpServers: [],
            loadSessionId: () => ctx.getRecord()?.sessionId,
            saveSessionId: (id) => registry.patch(ctx.record.id, { sessionId: id }),
            buildPrompt: () => ({ prompt: "work" }),
            gate: ctx.gate,
            beforeRun: ctx.beforeRun,
            onQueued: ctx.onQueued,
            onQueuedRunCancelled: ctx.onQueuedRunCancelled,
            onRunEnd: (result) => ctx.onRunEnd(result),
            onRuntimeStateChanged: ctx.onRuntimeStateChanged,
            debounceMs: DEBOUNCE,
          });
          liveActors.set(ctx.record.id, actor);
          return actor;
        },
      });

      const blocker = mesh.spawn({
        charter: "blocker",
        parentId: "root",
        modelConfig: { provider: "blocker", model: "model-blocker" },
      });
      const worker = mesh.spawn({
        charter: "worker",
        parentId: "root",
        modelConfig: [
          { provider: "pool-a", model: "model-a" },
          { provider: "pool-b", model: "model-b" },
        ],
        context: { type: "portable", mode: "ledger" },
      });

      // Occupy the mesh's one concurrency slot.
      mesh.sendMessage(blocker, "hold the slot", "root");
      await tick();
      expect(mesh.activeRunState(blocker)?.phase).toBe("running");

      // Worker is genuinely queued; with both lanes tied on quote, declaration
      // order picks pool-a as the reserved lane.
      mesh.sendMessage(worker, "work", "root");
      await tick();
      expect(mesh.activeRunState(worker)?.phase).toBe("queued");
      expect(mesh.getSelection(worker)?.provider).toBe("pool-a");
      expect(mesh.getSelection(worker)?.lane).toBe("pool-a");

      // Halt only the *reserved* lane. pool-b — still healthy and still sitting
      // in the same declared pool — must not mask this: a whole-pool
      // `allCandidatesHalted` check would see pool-b healthy and wrongly skip
      // cancellation, leaving the ticket set to launch on a halted provider.
      halted.add("pool-a");
      expect(mesh.cancelHaltedQueuedRuns()).toEqual([worker]);
      await tick();

      expect(mesh.queuedThreadIds()).toEqual(new Set());
      expect(mesh.getSelection(worker)).toBeUndefined();
      expect(poolARuns).toEqual([]);
      expect(poolBRuns).toEqual([]);

      // Clearing the halt and driving the production resume path re-admits
      // the worker from the healthy pool, with no fresh external delivery.
      halted.delete("pool-a");
      expect(mesh.resumeCancelledRuns()).toEqual([worker]);
      blockerDeferred.releaseAll();
      await tick();

      expect(poolARuns).toEqual([`/tmp/${worker}`]);
      expect(poolBRuns).toEqual([]);
      expect(mesh.runningThreadIds()).toEqual(new Set());
      expect(mesh.queuedThreadIds()).toEqual(new Set());
    });
  });

  // #169 responsive promotion reselects: a normal request that queued behind
  // mesh capacity on a later-declared lane (because the earlier-declared one
  // quoted later) must, on a responsive delivery, reselect onto the first
  // healthy *declared* candidate — not merely bypass pacing on the lane it
  // happened to already be queued on.
  describe("responsive promotion reselects onto the earliest healthy declared lane (#169)", () => {
    it("promotes a queued run from a later-declared lane onto an earlier-declared one, with exactly one immediate run", async () => {
      const poolARuns: string[] = [];
      const poolBRuns: string[] = [];
      const liveActors = new Map<string, Actor>();
      const blockerDeferred = deferredProvider();
      // pool-a's run blocks until released, so the reselected-but-not-yet-
      // finished state can be inspected before the run completes.
      const poolAGates: Array<() => void> = [];
      const providerByName = new Map<string, CodingProvider>([
        [
          "pool-a",
          {
            name: "pool-a",
            providerName: "pool-a",
            run: (runOpts) => {
              poolARuns.push(runOpts.cwd);
              return new Promise((resolve) => {
                poolAGates.push(() => {
                  liveActors.get(runOpts.cwd.replace("/tmp/", ""))?.declareYield();
                  resolve({ success: true, exitCode: 0, output: "a" });
                });
              });
            },
          },
        ],
        [
          "pool-b",
          {
            name: "pool-b",
            providerName: "pool-b",
            run: async (runOpts) => {
              poolBRuns.push(runOpts.cwd);
              liveActors.get(runOpts.cwd.replace("/tmp/", ""))?.declareYield();
              return { success: true, exitCode: 0, output: "b" };
            },
          },
        ],
      ]);
      const pacers = new Map<string, ProviderPacer>();
      const pacerFor = (name: string): ProviderPacer => {
        let pacer = pacers.get(name);
        if (!pacer) {
          pacer = new ProviderPacer(0);
          pacers.set(name, pacer);
        }
        return pacer;
      };
      // pool-a is declared first but quotes later than pool-b, so the initial
      // normal selection reserves pool-b — the exact setup a responsive
      // promotion must correct.
      pacerFor("pool-a").deferUntil(Date.now() + 20_000);

      const { mesh, registry, tick } = setup({
        maxConcurrent: 1,
        providerGate: (fn, candidates, request) => {
          const lanes: PoolLaneCandidate<RawProviderModelConfig>[] = candidates.map((c) => ({
            config: c,
            lane: c.provider,
            pacer: pacerFor(c.provider),
          }));
          return submitPoolGate(fn, lanes, {
            responsive: request.responsive,
            threadId: request.threadId,
            enqueueNormal: request.enqueueNormal,
            onSelected: request.threadId
              ? (selection) =>
                  request.onSelected?.({
                    provider: selection.candidate.provider,
                    lane: selection.lane,
                    model: selection.candidate.model ?? "",
                    effort: selection.candidate.effort,
                    declaredIndex: selection.declaredIndex,
                    eligibleAt: selection.eligibleAt,
                    responsive: selection.responsive,
                  })
              : undefined,
          });
        },
        createActor: (ctx) => {
          let actor!: Actor;
          const isBlocker = ctx.record.charter === "blocker";
          actor = new Actor({
            id: ctx.record.id,
            cwd: `/tmp/${ctx.record.id}`,
            modelConfig: isBlocker
              ? [{ provider: "blocker", model: "model-blocker" }]
              : (ctx.record.modelConfig ?? [{ provider: "pool-a", model: "model-a" }]),
            resolveProvider: isBlocker
              ? () => ({
                  ...blockerDeferred.provider,
                  run: async (runOpts) => {
                    const result = await blockerDeferred.provider.run(runOpts);
                    if (result.success) actor.declareYield();
                    return result;
                  },
                })
              : (selected) => {
                  const base = providerByName.get(selected.provider);
                  if (!base) throw new Error(`no provider registered for ${selected.provider}`);
                  return base;
                },
            mcpServers: [],
            loadSessionId: () => ctx.getRecord()?.sessionId,
            saveSessionId: (id) => registry.patch(ctx.record.id, { sessionId: id }),
            buildPrompt: () => ({ prompt: "work" }),
            gate: ctx.gate,
            beforeRun: ctx.beforeRun,
            onQueued: ctx.onQueued,
            onQueuedRunCancelled: ctx.onQueuedRunCancelled,
            onRunEnd: (result) => ctx.onRunEnd(result),
            onRuntimeStateChanged: ctx.onRuntimeStateChanged,
            debounceMs: DEBOUNCE,
          });
          liveActors.set(ctx.record.id, actor);
          return actor;
        },
      });

      const blocker = mesh.spawn({
        charter: "blocker",
        parentId: "root",
        modelConfig: { provider: "blocker", model: "model-blocker" },
      });
      const worker = mesh.spawn({
        charter: "worker",
        parentId: "root",
        modelConfig: [
          { provider: "pool-a", model: "model-a" },
          { provider: "pool-b", model: "model-b" },
        ],
        context: { type: "portable", mode: "ledger" },
      });

      // Occupy the mesh's one concurrency slot.
      mesh.sendMessage(blocker, "hold the slot", "root");
      await tick();
      expect(mesh.activeRunState(blocker)?.phase).toBe("running");

      // Worker queues behind mesh capacity, reserved on pool-b (the earlier
      // quote) even though pool-a is declared first.
      mesh.sendMessage(worker, "work", "root");
      await tick();
      expect(mesh.activeRunState(worker)?.phase).toBe("queued");
      expect(mesh.getSelection(worker)?.provider).toBe("pool-b");

      // A responsive delivery must reselect onto pool-a — the first healthy
      // declared candidate — cancelling the stale pool-b reservation, and
      // bypass pacing/concurrency entirely (blocker still holds the mesh's
      // only slot).
      mesh.sendHumanMessage(worker, "urgent", "human-session");
      await vi.advanceTimersByTimeAsync(0);

      expect(poolARuns).toEqual([`/tmp/${worker}`]);
      expect(poolBRuns).toEqual([]);
      expect(mesh.getSelection(worker)?.provider).toBe("pool-a");
      expect(mesh.getSelection(worker)?.responsive).toBe(true);
      expect(mesh.runningThreadIds()).toEqual(new Set([blocker, worker]));

      poolAGates.splice(0).forEach((release) => {
        release();
      });
      blockerDeferred.releaseAll();
      await tick();

      expect(poolARuns).toEqual([`/tmp/${worker}`]);
      expect(poolBRuns).toEqual([]);
      expect(mesh.runningThreadIds()).toEqual(new Set());
      expect(mesh.queuedThreadIds()).toEqual(new Set());
    });
  });

  it("reparentThread moves the actor to a new parent and hands the new parent a handle", async () => {
    const { mesh, registry } = setup();
    const steward = mesh.spawn({ charter: "steward", parentId: "root" });
    const worker = mesh.spawn({ charter: "worker", parentId: "root" });

    mesh.reparentThread(worker, steward);
    expect(registry.get(worker)?.parentId).toBe(steward); // ownership moved
    // The new parent gained a handle so it can message the moved actor.
    expect(registry.get(steward)?.handles?.some((h) => h.id === worker)).toBe(true);
  });

  it("reparentThread rejects root, self, unknown, non-active parent, and cycles", async () => {
    const { mesh, registry } = setup();
    const a = mesh.spawn({ charter: "a", parentId: "root" });
    const b = mesh.spawn({ charter: "b", parentId: a }); // b is a's child

    expect(() => mesh.reparentThread("root", a)).toThrow(/reparent the root/);
    expect(() => mesh.reparentThread(a, a)).toThrow(/to itself/);
    expect(() => mesh.reparentThread(a, "non-existent")).toThrow(/unknown parent/);
    expect(() => mesh.reparentThread("non-existent", a)).toThrow(/unknown thread/);
    // Cycle: can't move `a` under its own descendant `b`.
    expect(() => mesh.reparentThread(a, b)).toThrow(/cycle/);
    // Non-active new parent: yields would drop into the void.
    const dead = mesh.spawn({ charter: "dead", parentId: "root" });
    registry.patch(dead, { status: "retired" });
    expect(() => mesh.reparentThread(b, dead)).toThrow(/non-active/);
  });

  it("setActorModel queues a run if the actor is idle and has unhandled inbox entries", async () => {
    let shouldFail = false;
    let runCount = 0;
    const events: MeshEventInput[] = [];
    const { mesh, tick } = setup({
      events: (e) => events.push(e),
      onQueued: (actorId, ctx) => {
        mesh.recordEvent({ kind: "run_queued", actorId, detail: ctx.mode });
      },
      sharedProvider: {
        name: "test-provider",
        providerName: "test-provider",
        run: async () => {
          runCount++;
          if (shouldFail) return { success: false, exitCode: 1, output: "failed" };
          return { success: true, exitCode: 0, output: "ok" };
        },
      },
    });

    const worker = mesh.spawn({
      charter: "worker",
      parentId: "root",
      modelConfig: { provider: "test-provider", model: "model-a" },
      context: { type: "portable", mode: "ledger" },
    });

    // Queue a run that fails.
    shouldFail = true;
    mesh.sendMessage(worker, "work", "root");
    await tick();
    expect(runCount).toBe(1);

    expect(mesh.activeRunState(worker)).toBeNull(); // idle
    events.length = 0;

    // Re-pin should queue it now.
    mesh.setActorModel(worker, { provider: "test-provider", model: "model-c" }, "root");

    // Tick to let the new run execute.
    shouldFail = false;
    await tick();

    expect(runCount).toBe(2);
    expect(mesh.actors.get(worker)?.modelConfig?.[0]?.model).toBe("model-c");
    expect(events).toContainEqual(expect.objectContaining({ kind: "run_queued", actorId: worker }));
  });

  it("setActorModel does not queue an idle actor with an empty inbox", async () => {
    let runCount = 0;
    const { mesh, tick } = setup({
      sharedProvider: {
        name: "test-provider",
        providerName: "test-provider",
        run: async () => {
          runCount++;
          return { success: true, exitCode: 0, output: "ok" };
        },
      },
    });

    const worker = mesh.spawn({
      charter: "worker",
      parentId: "root",
      modelConfig: { provider: "test-provider", model: "model-a" },
      context: { type: "portable", mode: "ledger" },
    });

    expect(mesh.activeRunState(worker)).toBeNull();

    mesh.setActorModel(worker, { provider: "test-provider", model: "model-b" }, "root");
    await tick();

    expect(runCount).toBe(0);
    expect(mesh.activeRunState(worker)).toBeNull();
    expect(mesh.actors.get(worker)?.desiredModelConfig?.[0]?.model).toBe("model-b");
    expect(mesh.actors.get(worker)?.modelConfig?.[0]?.model).toBe("model-a");
  });

  it("setActorModel does not duplicate a running run", async () => {
    let runCount = 0;
    const deferred = deferredProvider();
    const { mesh, tick } = setup({
      sharedProvider: {
        name: "deferred",
        providerName: "deferred",
        run: async (opts) => {
          runCount++;
          return deferred.provider.run(opts);
        },
      },
    });

    const worker = mesh.spawn({
      charter: "worker",
      parentId: "root",
      modelConfig: { provider: "deferred", model: "model-a" },
      context: { type: "portable", mode: "ledger" },
    });

    mesh.sendMessage(worker, "work", "root");
    await tick();
    expect(mesh.activeRunState(worker)?.phase).toBe("running");
    expect(runCount).toBe(1);

    // Re-pin while the run is in-flight.
    mesh.setActorModel(worker, { provider: "deferred", model: "model-b" }, "root");

    // Finish the in-flight run.
    deferred.releaseAll();
    await tick();

    expect(mesh.activeRunState(worker)).toBeNull();
    expect(runCount).toBe(1);
    expect(mesh.actors.get(worker)?.modelConfig?.[0]?.model).toBe("model-b");
  });

  it("setActorModel does not duplicate a queued run", async () => {
    let runCount = 0;
    const deferred = deferredProvider();
    const { mesh, tick } = setup({
      maxConcurrent: 1,
      sharedProvider: {
        name: "deferred",
        providerName: "deferred",
        run: async (opts) => {
          runCount++;
          return deferred.provider.run(opts);
        },
      },
    });

    const blocker = mesh.spawn({
      charter: "blocker",
      parentId: "root",
      modelConfig: { provider: "deferred", model: "model-blocker" },
    });

    const worker = mesh.spawn({
      charter: "worker",
      parentId: "root",
      modelConfig: { provider: "deferred", model: "model-a" },
      context: { type: "portable", mode: "ledger" },
    });

    // Blocker occupies the concurrency slot.
    mesh.sendMessage(blocker, "block", "root");
    await tick();
    expect(mesh.activeRunState(blocker)?.phase).toBe("running");

    // Worker is queued behind the blocker.
    mesh.sendMessage(worker, "work", "root");
    await tick();
    expect(mesh.activeRunState(worker)?.phase).toBe("queued");
    expect(runCount).toBe(1);

    // Re-pin while the worker is queued.
    mesh.setActorModel(worker, { provider: "deferred", model: "model-b" }, "root");
    expect(mesh.activeRunState(worker)?.phase).toBe("queued");

    // Release the blocker so the worker is admitted.
    deferred.releaseAll();
    await tick();
    expect(mesh.activeRunState(worker)?.phase).toBe("running");
    expect(runCount).toBe(2);

    // Complete the worker's run.
    deferred.releaseAll();
    await tick();
    expect(mesh.activeRunState(worker)).toBeNull();
    expect(runCount).toBe(2);
    expect(mesh.actors.get(worker)?.modelConfig?.[0]?.model).toBe("model-b");
  });

  it("reviveThread rolls back to retired if re-instantiation fails, staying re-tryable ", async () => {
    let failRevive = true;
    const { mesh, registry, tick } = setup({
      onRevive: () => {
        if (failRevive) throw new Error("revive boom");
      },
    });
    const id = mesh.spawn({ charter: "task", parentId: "root" });
    await tick();
    mesh.retire(id);

    // A failure mid-revive rethrows and rolls the record back to retired (not
    // stranded active-but-not-live).
    expect(() => mesh.reviveThread(id)).toThrow(/revive boom/);
    expect(registry.get(id)?.status).toBe("retired");
    expect(mesh.get(id)).toBeUndefined();

    // Re-tryable: a subsequent revive then succeeds.
    failRevive = false;
    mesh.reviveThread(id);
    expect(registry.get(id)?.status).toBe("active");
    expect(mesh.get(id)).toBeDefined();
  });

  describe("Event Subscriptions (Phase 2)", () => {
    it("subscribes and unsubscribes event sources and records audit events", () => {
      const events: MeshEventInput[] = [];
      const { mesh } = setup({ events: (e: MeshEventInput) => events.push(e) });
      const actorId = mesh.spawn({ charter: "worker", parentId: "root" });

      // Subscribe
      mesh.subscribeEventSource("github:dummy-org/dummy-repo", actorId, "root");
      expect(mesh.listSubscriptions()).toHaveLength(1);
      expect(mesh.listSubscriptions()[0]).toMatchObject({
        resource: "github:dummy-org/dummy-repo",
        actorId,
        subscribedBy: "root",
      });

      expect(events).toHaveLength(3); // handle_granted, actor_spawned, event_source_subscribed
      expect(events[2]).toMatchObject({
        kind: "event_source_subscribed",
        actorId,
        detail: "github:dummy-org/dummy-repo",
        payload: JSON.stringify({ subscribedBy: "root" }),
      });

      // Unsubscribe
      mesh.unsubscribeEventSource("github:dummy-org/dummy-repo", actorId, "2026-01-01T12:00:00Z");
      expect(mesh.listSubscriptions()[0].unsubscribedAt).toBe("2026-01-01T12:00:00Z");

      expect(events).toHaveLength(4);
      expect(events[3]).toMatchObject({
        kind: "event_source_unsubscribed",
        actorId,
        detail: "github:dummy-org/dummy-repo",
        body: "at=2026-01-01T12:00:00Z",
      });
    });

    it("enforces one active subscriber per resource and propagates throws", () => {
      const { mesh } = setup();
      const actor1 = mesh.spawn({ charter: "worker 1", parentId: "root" });
      const actor2 = mesh.spawn({ charter: "worker 2", parentId: "root" });

      const resource = "github:dummy-org/dummy-repo";

      mesh.subscribeEventSource(resource, actor1, "root");

      // subscribing another actor throws and propagates
      expect(() => mesh.subscribeEventSource(resource, actor2, "root")).toThrow(
        /already has an active subscriber/
      );

      // unsubscribing actor 1 allows actor 2 to subscribe
      mesh.unsubscribeEventSource(resource, actor1, "2026-01-01T12:00:00Z");
      expect(() => mesh.subscribeEventSource(resource, actor2, "root")).not.toThrow();
    });

    it("delegates a strict sub-resource to a descendant while the parent keeps the repo", async () => {
      const { mesh, tick, fake } = setup();
      const parent = mesh.spawn({ charter: "repo steward", parentId: "root" });
      const child = mesh.spawn({ charter: "pr worker", parentId: parent });

      mesh.subscribeEventSource("github:dummy-org/dummy-repo", parent, "root");
      mesh.delegateEventSource("github:dummy-org/dummy-repo/pulls/616", child, parent);

      expect(mesh.listSubscriptions()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actorId: parent,
            resource: "github:dummy-org/dummy-repo",
            subscribedBy: "root",
          }),
          expect.objectContaining({
            actorId: child,
            resource: "github:dummy-org/dummy-repo/pulls/616",
            subscribedBy: parent,
          }),
        ])
      );

      mesh.deliverEvent("github:dummy-org/dummy-repo/pulls/616", "pr event", {
        inboxPayload: payload("pull_request.opened"),
      });
      mesh.deliverEvent("github:dummy-org/dummy-repo", "repo event", {
        inboxPayload: payload("push"),
      });
      await tick();

      expect(fake(child).calls).toHaveLength(1);
      expect(fake(child).calls[0]?.prompt).toContain("Work from your inbox");
      expect(fake(parent).calls).toHaveLength(1);
      expect(fake(parent).calls[0]?.prompt).toContain("Work from your inbox");
    });

    it("rejects delegation when the caller is not the effective owner", () => {
      const { mesh } = setup();
      const parent = mesh.spawn({ charter: "repo steward", parentId: "root" });
      const child = mesh.spawn({ charter: "pr worker", parentId: parent });

      mesh.subscribeEventSource("github:dummy-org/dummy-repo", parent, "root");

      expect(() =>
        mesh.delegateEventSource("github:dummy-org/other/pulls/1", child, parent)
      ).toThrow(/current effective owner/);
      expect(() => mesh.delegateEventSource("github:dummy-org", child, parent)).toThrow(
        /current effective owner/
      );
    });

    it("hands off an exact resource the delegator itself holds", async () => {
      // Mechanical creator subscriptions  make this the common case: the
      // creator holds github_pr:<repo>#<n> exactly and delegates it onward.
      const { mesh, tick, fake } = setup();
      const parent = mesh.spawn({ charter: "pr creator", parentId: "root" });
      const child = mesh.spawn({ charter: "pr worker", parentId: parent });
      const pr = "github:dummy-org/dummy-repo/pulls/616";

      mesh.subscribeEventSource(pr, parent, parent);

      expect(() => mesh.delegateEventSource(pr, child, parent)).not.toThrow();

      const subs = mesh.listSubscriptions();
      expect(subs.find((s) => s.actorId === parent)?.unsubscribedAt).toBe("2026-01-01T00:00:00Z");
      expect(subs.find((s) => s.actorId === child)).toMatchObject({
        resource: "github:dummy-org/dummy-repo/pulls/616",
        subscribedBy: parent,
        unsubscribedAt: undefined,
      });

      mesh.deliverEvent(pr, "pr event", { inboxPayload: payload("pull_request.opened") });
      await tick();
      expect(fake(child).calls).toHaveLength(1);
      expect(fake(child).calls[0]?.prompt).toContain("Work from your inbox");
      expect(fake(parent).calls).toHaveLength(0);
    });

    it("lets an effective owner delegate to a sibling", () => {
      const { mesh } = setup();
      const parent = mesh.spawn({ charter: "repo steward", parentId: "root" });
      const sibling = mesh.spawn({ charter: "sibling", parentId: "root" });
      const pr = "github:dummy-org/dummy-repo/pulls/616";

      mesh.subscribeEventSource("github:dummy-org/dummy-repo", parent, "root");

      expect(() => mesh.delegateEventSource(pr, sibling, parent)).not.toThrow();
      expect(
        mesh
          .listSubscriptions()
          .find(
            (s) => s.actorId === sibling && s.resource === "github:dummy-org/dummy-repo/pulls/616"
          )?.subscribedBy
      ).toBe(parent);
    });

    it("lets an effective owner delegate to its parent", () => {
      const { mesh } = setup();
      const parent = mesh.spawn({ charter: "repo steward", parentId: "root" });
      const child = mesh.spawn({ charter: "child", parentId: parent });
      const pr = "github:dummy-org/dummy-repo/pulls/616";

      mesh.subscribeEventSource("github:dummy-org/dummy-repo", child, "root");

      expect(() => mesh.delegateEventSource(pr, parent, child)).not.toThrow();
      expect(
        mesh
          .listSubscriptions()
          .find(
            (s) => s.actorId === parent && s.resource === "github:dummy-org/dummy-repo/pulls/616"
          )?.subscribedBy
      ).toBe(child);
    });

    it("rejects reaching into a slice delegated away", () => {
      const { mesh } = setup();
      const repoOwner = mesh.spawn({ charter: "repo steward", parentId: "root" });
      const issueWorker = mesh.spawn({ charter: "issue worker", parentId: "root" });

      mesh.subscribeEventSource("github:dummy-org", "root", "root");
      mesh.delegateEventSource("github:dummy-org/dummy-repo", repoOwner, "root");

      expect(() =>
        mesh.delegateEventSource("github:dummy-org/dummy-repo/issues/720", issueWorker, "root")
      ).toThrow(/current effective owner/);
    });

    it("preserves same-resource conflicts for delegated resources", () => {
      const { mesh } = setup();
      const parent = mesh.spawn({ charter: "repo steward", parentId: "root" });
      const child1 = mesh.spawn({ charter: "pr worker 1", parentId: parent });
      const child2 = mesh.spawn({ charter: "pr worker 2", parentId: parent });
      const pr = "github:dummy-org/dummy-repo/pulls/616";

      mesh.subscribeEventSource("github:dummy-org/dummy-repo", parent, "root");
      mesh.delegateEventSource(pr, child1, parent);

      expect(() => mesh.delegateEventSource(pr, child2, parent)).toThrow(/current effective owner/);
    });

    it("lets root delegate a repo from its configured org source", async () => {
      const { mesh, tick, fake } = setup();
      const child = mesh.spawn({ charter: "repo steward", parentId: "root" });

      mesh.subscribeEventSource("github:dummy-org", "root", "root");
      mesh.delegateEventSource("github:dummy-org/dummy-repo", child, "root");

      mesh.deliverEvent("github:dummy-org/dummy-repo", "repo event", {
        inboxPayload: payload("push"),
      });
      mesh.deliverEvent("github:dummy-org/other", "other repo event", {
        inboxPayload: payload("issues.opened"),
      });
      await tick();

      expect(fake(child).calls).toHaveLength(1);
      expect(fake(child).calls[0]?.prompt).toContain("Work from your inbox");
      expect(fake("root").calls).toHaveLength(1);
      expect(fake("root").calls[0]?.prompt).toContain("Work from your inbox");
    });

    it("bubbles delegated events back to the parent's broader subscription when the child retires", async () => {
      const { mesh, tick, fake } = setup();
      const parent = mesh.spawn({ charter: "repo steward", parentId: "root" });
      const child = mesh.spawn({ charter: "pr worker", parentId: parent });

      mesh.subscribeEventSource("github:dummy-org/dummy-repo", parent, "root");
      mesh.delegateEventSource("github:dummy-org/dummy-repo/pulls/616", child, parent);
      mesh.retire(child);

      mesh.deliverEvent("github:dummy-org/dummy-repo/pulls/616", "pr event", {
        inboxPayload: payload("pull_request.opened"),
      });
      await tick();

      expect(fake(child).calls).toHaveLength(0);
      expect(fake(parent).calls).toHaveLength(1);
      expect(fake(parent).calls[0]?.prompt).toContain("Work from your inbox");
    });

    it("lets a delegating parent reclaim a child-owned topic and receive its events again", async () => {
      const { mesh, tick, fake } = setup();
      const parent = mesh.spawn({ charter: "repo steward", parentId: "root" });
      const child = mesh.spawn({ charter: "pr worker", parentId: parent });
      const pr = "github:dummy-org/dummy-repo/pulls/616";

      mesh.subscribeEventSource("github:dummy-org/dummy-repo", parent, "root");
      mesh.delegateEventSource(pr, child, parent);

      mesh.deliverEvent(pr, "before reclaim", { inboxPayload: payload("pull_request.opened") });
      await tick();
      expect(fake(child).calls).toHaveLength(1);

      mesh.reclaimEventSource(pr, parent);
      mesh.deliverEvent(pr, "after reclaim", { inboxPayload: payload("pull_request.opened") });
      await tick();

      expect(fake(parent).calls).toHaveLength(1);
      expect(fake(parent).calls[0]?.prompt).toContain("Work from your inbox");
      expect(
        mesh
          .listSubscriptions()
          .find(
            (s) => s.actorId === child && s.resource === "github:dummy-org/dummy-repo/pulls/616"
          )?.unsubscribedAt
      ).toBe("2026-01-01T00:00:00Z");
      expect(
        mesh
          .listSubscriptions()
          .find(
            (s) => s.actorId === parent && s.resource === "github:dummy-org/dummy-repo/pulls/616"
          )?.subscribedBy
      ).toBe(parent);
    });

    it("rejects reclaim by a non-owner", () => {
      const { mesh } = setup();
      const parent = mesh.spawn({ charter: "repo steward", parentId: "root" });
      const child = mesh.spawn({ charter: "pr worker", parentId: parent });
      const sibling = mesh.spawn({ charter: "sibling", parentId: "root" });
      const pr = "github:dummy-org/dummy-repo/pulls/616";

      mesh.subscribeEventSource("github:dummy-org/dummy-repo", parent, "root");
      mesh.delegateEventSource(pr, child, parent);

      expect(() => mesh.reclaimEventSource(pr, sibling)).toThrow(/effective owner after reclaim/);
    });

    it("an actor may self-delegate a strict descendant of a parent it effectively owns", () => {
      const { mesh } = setup();
      const actor = mesh.spawn({ charter: "repo steward", parentId: "root" });

      mesh.subscribeEventSource("github:dummy-org/dummy-repo", actor, "root");

      // Actor owns the repo. It can self-delegate a branch.
      expect(() =>
        mesh.delegateEventSource("github:dummy-org/dummy-repo/branches/staging", actor, actor)
      ).not.toThrow();
    });

    it("an actor may not self-delegate an unrelated resource", () => {
      const { mesh } = setup();
      const actor = mesh.spawn({ charter: "steward", parentId: "root" });

      mesh.subscribeEventSource("github:dummy-org/dummy-repo", actor, "root");

      // Cannot self-delegate an unrelated branch
      expect(() =>
        mesh.delegateEventSource("github:dummy-org/other-repo/branches/staging", actor, actor)
      ).toThrow(/strict descendant of an already-owned parent/);
    });

    it("holding only the exact resource is not sufficient", () => {
      const { mesh } = setup();
      const actor = mesh.spawn({ charter: "steward", parentId: "root" });
      const branch = "github:dummy-org/dummy-repo/branches/staging";

      // actor gets the branch exactly (not the parent repo)
      mesh.subscribeEventSource(branch, actor, "root");

      // Cannot self-delegate the exact resource they hold unless they own a parent
      expect(() => mesh.delegateEventSource(branch, actor, actor)).toThrow(
        /strict descendant of an already-owned parent/
      );
    });

    it("an existing exact row is ignored only while checking ancestor ownership", () => {
      const { mesh } = setup();
      const actor = mesh.spawn({ charter: "steward", parentId: "root" });
      const branch = "github:dummy-org/dummy-repo/branches/staging";

      // actor holds the repo (parent) AND holds the branch (exact)
      mesh.subscribeEventSource("github:dummy-org/dummy-repo", actor, "root");
      mesh.subscribeEventSource(branch, actor, "root");

      // Can self-delegate the exact resource because they ALSO own the parent
      expect(() => mesh.delegateEventSource(branch, actor, actor)).not.toThrow();
    });

    it("routes repo events to the subscriber when live", async () => {
      const { mesh, tick, fake } = setup();
      const actorId = mesh.spawn({ charter: "worker", parentId: "root" });

      // Subscribe worker to the repo
      mesh.subscribeEventSource("github:dummy-org/dummy-repo", actorId, "root");

      // Deliver event
      mesh.deliverEvent("github:dummy-org/dummy-repo", "suite completed", {
        inboxPayload: payload("check_suite.completed"),
      });
      await tick();

      // Subscriber should be woken
      expect(fake(actorId).calls).toHaveLength(1);
      expect(fake(actorId).calls[0]?.prompt).toContain("Work from your inbox");

      // Root should not be woken
      expect(fake("root").calls).toHaveLength(0);
    });

    it("bubbles repo events past a retired subscriber to the covering ancestor source", async () => {
      const { mesh, tick, fake } = setup();
      const actorId = mesh.spawn({ charter: "worker", parentId: "root" });

      // Real topology : root always holds the config-seeded org source;
      // the worker's repo sub is a delegated slice under it. A dead slice-holder
      // must NOT mean silent loss — the walk continues to the ancestor source.
      mesh.subscribeEventSource("github:dummy-org", "root", "root");
      mesh.subscribeEventSource("github:dummy-org/dummy-repo", actorId, "root");

      // Retire the worker (makes it not live)
      mesh.retire(actorId);

      // Deliver an allowlisted event. A non-allowlisted push would now stop at
      // the retired exact subscriber instead of waking the covering org owner.
      mesh.deliverEvent("github:dummy-org/dummy-repo", "suite completed", {
        inboxPayload: payload("check_suite.completed"),
      });
      await tick();

      // Retired subscriber should not be woken
      expect(fake(actorId).calls).toHaveLength(0);

      // Root should be woken (bubbled)
      expect(fake("root").calls).toHaveLength(1);
      expect(fake("root").calls[0]?.prompt).toContain("Work from your inbox");
    });

    it("routes issue events to issue subscriber when live", async () => {
      const { mesh, tick, fake } = setup();
      const actorId = mesh.spawn({ charter: "worker", parentId: "root" });

      mesh.subscribeEventSource("github:dummy-org/dummy-repo/issues/123", actorId, "root");

      mesh.deliverEvent("github:dummy-org/dummy-repo/issues/123", "new comment", {
        inboxPayload: payload("issue_comment.created"),
      });
      await tick();

      expect(fake(actorId).calls).toHaveLength(1);
      expect(fake(actorId).calls[0]?.prompt).toContain("Work from your inbox");
      expect(fake("root").calls).toHaveLength(0);
    });

    it("marks persisted inbox work seen only when its actor run is queued", async () => {
      const order: string[] = [];
      const appended: Array<{
        actorId: string;
        source: string;
        payload: { type: string; [key: string]: unknown };
      }> = [];
      const inboxStore = {
        append: (inputs: typeof appended) => {
          order.push("persist");
          appended.push(...inputs);
          return inputs.map((input, index) => ({
            ...input,
            id: `entry-${index}`,
            deliveredAt: new Date("2026-01-01T00:00:00Z"),
            seenAt: null,
            handledAt: null,
          }));
        },
        markSeen: () => {
          order.push("seen");
          return appended.map((input, index) => ({
            ...input,
            id: `entry-${index}`,
            deliveredAt: new Date("2026-01-01T00:00:00Z"),
            seenAt: new Date("2026-01-01T00:00:01Z"),
            handledAt: null,
          }));
        },
        countUnhandled: () => appended.length,
      } as unknown as InboxStore;
      const { mesh, tick, fake } = setup({
        inboxStore,
        onInboxEntriesSeen: () => order.push("reaction"),
      });
      const actorId = mesh.spawn({ charter: "worker", parentId: "root" });
      const resource = "github:dummy-org/dummy-repo/issues/903" as const;
      mesh.subscribeEventSource(resource, actorId, "root");

      await mesh.deliverEvent(resource, "new comment", {
        inboxPayload: { type: "issue_comment.created", commentId: 4959289232 },
      });
      expect(order).toEqual(["persist"]);
      await tick();

      expect(order).toEqual(["persist", "seen", "reaction"]);
      expect(appended).toEqual([
        {
          actorId,
          source: "github:dummy-org/dummy-repo/issues/903",
          payload: { type: "issue_comment.created", commentId: 4959289232 },
        },
      ]);
      expect(fake(actorId).calls).toHaveLength(1);
      expect(fake(actorId).calls[0]?.prompt).toContain("Work from your inbox");
      expect(fake(actorId).calls[0]?.prompt).not.toContain("new comment");
    });

    it("leaves a halted provider unseen while another provider accepts inbox work", async () => {
      const inboxStore = createMemoryInboxStore();
      const queuedActors: string[] = [];
      let claudeHalted = true;
      const { mesh, tick, fake } = setup({
        inboxStore,
        isHalted: (provider) => claudeHalted && provider === "claude",
        onInboxEntriesSeen: (actorId) => queuedActors.push(actorId),
      });
      const halted = mesh.spawn({
        charter: "halted",
        parentId: "root",
        modelConfig: { provider: "claude", model: "claude-sonnet-4-6" },
      });
      const available = mesh.spawn({
        charter: "available",
        parentId: "root",
        modelConfig: { provider: "agy", model: "agy-model" },
      });
      const haltedResource = "github:dummy-org/dummy-repo/issues/1288" as const;
      const availableResource = "github:dummy-org/dummy-repo/issues/1291" as const;
      mesh.subscribeEventSource(haltedResource, halted, "root");
      mesh.subscribeEventSource(availableResource, available, "root");

      await mesh.deliverEvent(haltedResource, "halted comment", {
        inboxPayload: {
          type: "issue_comment.created",
          commentId: 1288,
          priority: "responsive",
        },
      });
      await mesh.deliverEvent(availableResource, "available comment", {
        inboxPayload: { type: "issue_comment.created", commentId: 1291 },
      });
      await tick();

      expect(fake(halted).calls).toHaveLength(0);
      expect(fake(available).calls).toHaveLength(1);
      expect(inboxStore.entries.find((entry) => entry.actorId === halted)?.seenAt).toBeNull();
      expect(
        inboxStore.entries.find((entry) => entry.actorId === available)?.seenAt
      ).not.toBeNull();
      expect(queuedActors).toEqual([available]);

      claudeHalted = false;
      mesh.reconcileUnseenInbox();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake(halted).calls).toHaveLength(1);
      expect(fake(available).calls).toHaveLength(1);
      expect(inboxStore.entries.find((entry) => entry.actorId === halted)?.seenAt).not.toBeNull();
      expect(queuedActors).toEqual([available, halted]);
    });

    it("fails loudly without a seen claim or nudge when inbox persistence fails", async () => {
      const onInboxEntriesSeen = vi.fn();
      const inboxStore = {
        append: () => {
          throw new Error("disk full");
        },
      } as unknown as InboxStore;
      const { mesh, tick, fake } = setup({ inboxStore, onInboxEntriesSeen });
      const actorId = mesh.spawn({ charter: "worker", parentId: "root" });
      const resource = "github:dummy-org/dummy-repo/issues/903" as const;
      mesh.subscribeEventSource(resource, actorId, "root");

      await expect(
        mesh.deliverEvent(resource, "new comment", {
          inboxPayload: { type: "issue_comment.created", commentId: 1 },
        })
      ).rejects.toThrow("disk full");
      await tick();

      expect(onInboxEntriesSeen).not.toHaveBeenCalled();
      expect(fake(actorId).calls).toHaveLength(0);
    });

    it("deduplicates inbox entries with deterministic ~128-bit keys", async () => {
      const appended: Array<{
        id?: string;
        actorId: string;
        source: string;
        payload: { type: string; [key: string]: unknown };
      }> = [];
      const inboxStore = {
        append: (inputs: typeof appended) => {
          appended.push(...inputs);
          return inputs.map((input) => ({
            ...input,
            id: input.id,
            deliveredAt: new Date("2026-01-01T00:00:00Z"),
            seenAt: null,
            handledAt: null,
          }));
        },
        markSeen: () => [],
      } as unknown as InboxStore;

      const { mesh, tick } = setup({ inboxStore });
      const actorId = mesh.spawn({ charter: "worker", parentId: "root" });
      const resource = "github:dummy-org/dummy-repo/issues/903" as const;
      mesh.subscribeEventSource(resource, actorId, "root");

      // Deliver first event
      await mesh.deliverEvent(resource, "comment 1", {
        inboxPayload: { type: "issue_comment.created", commentId: 1 },
        inboxDedupeKey: "comment-1",
      });
      await tick();

      // Deliver second event with same dedupe key but different payload/recipient (or same)
      await mesh.deliverEvent(resource, "comment 1 duplicate", {
        inboxPayload: { type: "issue_comment.created", commentId: 1 },
        inboxDedupeKey: "comment-1",
      });
      await tick();

      expect(appended).toHaveLength(2);
      const id1 = appended[0].id;
      const id2 = appended[1].id;

      // Prove (a) deterministic for identical inputs
      expect(id1).toBe(id2);

      // Prove (b) ~128-bit width: starts with "dedupe:" and followed by exactly 32 hex characters
      expect(id1).toMatch(/^dedupe:[a-f0-9]{32}$/);
    });

    it("bubbles allowlisted issue events to repo subscriber when issue subscriber is not live/absent", async () => {
      const { mesh, tick, fake } = setup();
      const repoActorId = mesh.spawn({ charter: "repo worker", parentId: "root" });
      const issueActorId = mesh.spawn({ charter: "issue worker", parentId: "root" });

      mesh.subscribeEventSource("github:dummy-org/dummy-repo", repoActorId, "root");
      mesh.subscribeEventSource("github:dummy-org/dummy-repo/issues/123", issueActorId, "root");

      // Retire issue subscriber so it is no longer live
      mesh.retire(issueActorId);

      mesh.deliverEvent("github:dummy-org/dummy-repo/issues/123", "new comment", {
        inboxPayload: payload("issue_comment.created"),
      });
      await tick();

      // Issue worker should not be woken
      expect(fake(issueActorId).calls).toHaveLength(0);
      // Repo worker should be woken (bubbled)
      expect(fake(repoActorId).calls).toHaveLength(1);
      expect(fake(repoActorId).calls[0]?.prompt).toContain("Work from your inbox");
      // Root should not be woken
      expect(fake("root").calls).toHaveLength(0);
    });

    it("bubbles allowlisted issue events to org subscriber when issue and repo subscribers are absent", async () => {
      const { mesh, tick, fake } = setup();
      const orgActorId = mesh.spawn({ charter: "org worker", parentId: "root" });

      mesh.subscribeEventSource("github:dummy-org", orgActorId, "root");

      mesh.deliverEvent("github:dummy-org/dummy-repo/issues/123", "new comment", {
        inboxPayload: payload("issue_comment.created"),
      });
      await tick();

      // Org worker should be woken (bubbled up 2 levels)
      expect(fake(orgActorId).calls).toHaveLength(1);
      expect(fake(orgActorId).calls[0]?.prompt).toContain("Work from your inbox");
      // Root should not be woken
      expect(fake("root").calls).toHaveLength(0);
    });

    it("routes org-covered events with no more-specific subscriber to root", async () => {
      const { mesh, tick, fake } = setup();

      mesh.subscribeEventSource("github:dummy-org", "root", "root");
      mesh.deliverEvent("github:dummy-org/dummy-repo/issues/123", "new comment", {
        inboxPayload: payload("issues.opened"),
      });
      await tick();

      expect(fake("root").calls).toHaveLength(1);
      expect(fake("root").calls[0]?.prompt).toContain("Work from your inbox");
    });

    it("drops an event no subscription covers instead of waking root ", async () => {
      const { mesh, tick, fake } = setup();

      mesh.deliverEvent("github:dummy-org/dummy-repo/issues/123", "new comment", {
        inboxPayload: payload("issue_comment.created"),
      });
      await tick();

      // No configured/delegated source covers the resource: out-of-scope for
      // this instance — root must NOT be woken as a catch-all.
      expect(fake("root").calls).toHaveLength(0);
    });

    describe("ISSUE_NUM event-class bubble-up allowlist", () => {
      it("delivers a branch push to an exact branch subscriber", async () => {
        const { mesh, tick, fake } = setup();
        const branchOwner = mesh.spawn({ charter: "deploy staging", parentId: "root" });
        const repoOwner = mesh.spawn({ charter: "repo steward", parentId: "root" });
        const branch = "github:dummy-org/dummy-repo/branches/staging";

        mesh.subscribeEventSource(branch, branchOwner, "root");
        mesh.subscribeEventSource("github:dummy-org/dummy-repo", repoOwner, "root");

        await mesh.deliverEvent(branch, "staging push", {
          inboxPayload: payload("push"),
        });
        await tick();

        expect(fake(branchOwner).calls).toHaveLength(1);
        expect(fake(repoOwner).calls).toHaveLength(0);
      });

      it("does not bubble a branch push without an exact subscriber", async () => {
        const { mesh, tick, fake, logs } = setup();
        const repoOwner = mesh.spawn({ charter: "repo steward", parentId: "root" });
        const branch = "github:dummy-org/dummy-repo/branches/worker";
        mesh.subscribeEventSource("github:dummy-org/dummy-repo", repoOwner, "root");

        await mesh.deliverEvent(branch, "worker push", {
          inboxPayload: payload("push"),
        });
        await tick();

        expect(fake(repoOwner).calls).toHaveLength(0);
        expect(logs).toContain("event not covered by any subscription — dropped (worker push)");
      });

      it("still bubbles check_suite.completed to the repo owner", async () => {
        const { mesh, tick, fake } = setup();
        const repoOwner = mesh.spawn({ charter: "repo steward", parentId: "root" });
        const branch = "github:dummy-org/dummy-repo/branches/worker";
        mesh.subscribeEventSource("github:dummy-org/dummy-repo", repoOwner, "root");

        await mesh.deliverEvent(branch, "suite complete", {
          inboxPayload: payload("check_suite.completed"),
        });
        await tick();

        expect(fake(repoOwner).calls).toHaveLength(1);
      });

      it("bubbles merged PR closure but not an unmerged closure", async () => {
        const { mesh, tick, fake } = setup();
        const repoOwner = mesh.spawn({ charter: "repo steward", parentId: "root" });
        const pr = "github:dummy-org/dummy-repo/pulls/1022";
        mesh.subscribeEventSource("github:dummy-org/dummy-repo", repoOwner, "root");

        await mesh.deliverEvent(pr, "closed without merge", {
          inboxPayload: payload("pull_request.closed", false),
        });
        await tick();
        expect(fake(repoOwner).calls).toHaveLength(0);

        await mesh.deliverEvent(pr, "merged", {
          inboxPayload: payload("pull_request.closed", true),
        });
        await tick();
        expect(fake(repoOwner).calls).toHaveLength(1);
      });

      it("derives bubbling from eventPayload directly without coupling to scalar options", async () => {
        const { mesh, tick, fake } = setup();
        const repoOwner = mesh.spawn({ charter: "repo steward", parentId: "root" });
        const pr = "github:dummy-org/dummy-repo/pulls/1022";
        mesh.subscribeEventSource("github:dummy-org/dummy-repo", repoOwner, "root");

        // Deliver an unmerged PR closure payload. Bubbling should NOT happen.
        await mesh.deliverEvent(pr, "unmerged via payload", {
          inboxPayload: payload("pull_request.closed", false),
        });
        await tick();
        expect(fake(repoOwner).calls).toHaveLength(0);

        // Deliver a merged PR closure payload. Bubbling SHOULD happen.
        await mesh.deliverEvent(pr, "merged via payload", {
          inboxPayload: payload("pull_request.closed", true),
        });
        await tick();
        expect(fake(repoOwner).calls).toHaveLength(1);
      });

      it("bubbles chat-space messages to chat but keeps mesh messages directly addressed", async () => {
        const { mesh, tick, fake } = setup();
        const recipient = mesh.spawn({ charter: "message recipient", parentId: "root" });
        mesh.subscribeEventSource("gchat:spaces", "root", "root");

        await mesh.deliverEvent("gchat:spaces/new", "chat message", {
          inboxPayload: payload("gchat.message"),
        });
        await tick();
        expect(fake("root").calls).toHaveLength(1);

        mesh.sendMessage(recipient, "direct mesh message", "root");
        await tick();
        expect(fake(recipient).calls).toHaveLength(1);
        expect(fake("root").calls).toHaveLength(1);
      });
    });

    it("directed-delivers to a live actor by id without covering subscription", async () => {
      const { mesh, tick, fake } = setup();
      const actorId = mesh.spawn({ charter: "addressed worker", parentId: "root" });

      mesh.deliverEvent("github:dummy-org/uncovered/issues/123", "directed comment", {
        directedTarget: actorId,
        inboxPayload: payload("issue_comment.created"),
      });
      await tick();

      expect(fake(actorId).calls).toHaveLength(1);
      expect(fake(actorId).calls[0]?.prompt).toContain("Work from your inbox");
      expect(fake("root").calls).toHaveLength(0);
    });

    it("directed-delivers to a live actor by handle", async () => {
      const actorId = "b4b43d69-5e63-4db2-b44b-35c031096aad";
      const { mesh, tick, fake } = setup({ idgen: () => actorId });
      expect(mesh.spawn({ charter: "cloudy worker", parentId: "root" })).toBe(actorId);

      mesh.deliverEvent("github:dummy-org/uncovered/issues/123", "directed comment", {
        directedTarget: "cloudy-porpoise",
        inboxPayload: payload("issue_comment.created"),
      });
      await tick();

      expect(fake(actorId).calls).toHaveLength(1);
      expect(fake(actorId).calls[0]?.prompt).toContain("Work from your inbox");
    });

    it("drops an invalid directive but not the event", async () => {
      const { mesh, tick, fake, logs } = setup();

      mesh.subscribeEventSource("github:dummy-org", "root", "root");
      mesh.deliverEvent("github:dummy-org/dummy-repo/issues/123", "normal fallback", {
        directedTarget: "not-live",
        inboxPayload: payload("issue_comment.created"),
      });
      await tick();

      expect(logs).toContain("mesh:deliver target not live: not-live — directive ignored");
      expect(fake("root").calls).toHaveLength(1);
      expect(fake("root").calls[0]?.prompt).toContain("Work from your inbox");
    });

    describe("an issue self-echo suppression with author stamps", () => {
      it("suppresses same-actor same-instance self-post", async () => {
        const { mesh, tick, fake, logs } = setup();
        mesh.subscribeEventSource("github:dummy-org", "root", "root");

        mesh.deliverEvent("github:dummy-org/dummy-repo/issues/123", "self-echo test", {
          stampedAuthor: { actorId: "root", instanceId: "staging-instance" },
          instanceId: "staging-instance",
          inboxPayload: payload("issue_comment.created"),
        });
        await tick();

        expect(
          logs.some((l) =>
            l.includes(
              "self-event suppressed by author stamp: actor=root instance=staging-instance"
            )
          )
        ).toBe(true);
        expect(fake("root").calls).toHaveLength(0);
      });

      it("delivers cross-instance same-actor same-bot events", async () => {
        const { mesh, tick, fake } = setup();
        mesh.subscribeEventSource("github:dummy-org", "root", "root");

        mesh.deliverEvent("github:dummy-org/dummy-repo/issues/123", "cross-instance test", {
          stampedAuthor: { actorId: "root", instanceId: "prod-instance" },
          instanceId: "staging-instance",
          inboxPayload: payload("issue_comment.created"),
        });
        await tick();

        expect(fake("root").calls).toHaveLength(1);
        expect(fake("root").calls[0]?.prompt).toContain("Work from your inbox");
      });

      it("suppresses only matching destination in fanned multi-destination", async () => {
        const { mesh, tick, fake, logs } = setup();
        // biome-ignore lint/suspicious/noExplicitAny: test helper mock
        (mesh as any).eventSourceOwners.activeForResource = () => [
          {
            resource: "github:dummy-org",
            actorId: "root",
            subscribedBy: "root",
            subscribedAt: "2026-01-01T00:00:00Z",
          },
          {
            resource: "github:dummy-org",
            actorId: "t1",
            subscribedBy: "root",
            subscribedAt: "2026-01-01T00:00:00Z",
          },
        ];

        mesh.spawn({ charter: "t1-worker", parentId: "root" });

        mesh.deliverEvent("github:dummy-org/dummy-repo/issues/123", "fanned test", {
          stampedAuthor: { actorId: "t1", instanceId: "staging-instance" },
          instanceId: "staging-instance",
        });
        await tick();

        expect(fake("root").calls).toHaveLength(1);
        expect(fake("root").calls[0]?.prompt).toContain("Work from your inbox");
        expect(
          logs.some((l) =>
            l.includes("self-event suppressed by author stamp: actor=t1 instance=staging-instance")
          )
        ).toBe(true);
        expect(fake("t1").calls).toHaveLength(0);
      });

      it("delivers when stamp identity is missing or unverifiable", async () => {
        const { mesh, tick, fake } = setup();
        mesh.subscribeEventSource("github:dummy-org", "root", "root");

        mesh.deliverEvent("github:dummy-org/dummy-repo/issues/123", "fail-open missing stamp", {
          stampedAuthor: null,
          instanceId: "staging-instance",
          inboxPayload: payload("issue_comment.created"),
        });
        await tick();

        expect(fake("root").calls).toHaveLength(1);
        expect(fake("root").calls[0]?.prompt).toContain("Work from your inbox");
      });
    });

    // ISSUE_NUM made tracker writes stamped per-actor. That moves every peer
    // reply onto the stamped path — which means the stamp is now the sole thing
    // standing between "you woke on a colleague's answer" and silence. This
    // exercises the whole chain end to end (real stamping write tool → the
    // webhook's own resolveStampedAuthor → the mesh's delivery decision) rather
    // than hand-writing a stamp, so a change to any link fails here. The pair of
    // assertions is the point: suppression must be *author-scoped*. Widening it
    // to "unstamped or same-instance" would fix ISSUE_NUM's echo by making the mesh
    // deaf, and only the first assertion would catch that.
    describe("ISSUE_NUM peer replies still wake, through the stamped write path", () => {
      async function postAs(
        selfId: string,
        instanceId: string,
        repo: string,
        issueNumber: number,
        body: string
      ): Promise<string> {
        let posted: string | undefined;
        const issueClient = {
          postComment: async (_repo: string, _n: number, text: string) => {
            posted = text;
          },
        } as unknown as IssueClient;
        const server = createTrackerMcpServer(selfId, issueClient, { instanceId });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new Client({ name: "test", version: "0.0.0" });
        await client.connect(clientTransport);
        await client.callTool({ name: "post_comment", arguments: { repo, issueNumber, body } });
        if (posted === undefined) throw new Error("post_comment did not reach the issue client");
        return posted;
      }

      it("wakes the peer and not the author", async () => {
        const repo = "dummy-org/dummy-repo";
        const issueNumber = 1334;
        const instanceId = "staging-instance";
        const { mesh, tick, fake, logs } = setup();
        // biome-ignore lint/suspicious/noExplicitAny: test helper mock
        (mesh as any).eventSourceOwners.activeForResource = () =>
          ["root", "t1"].map((actorId) => ({
            resource: "github:dummy-org",
            actorId,
            subscribedBy: "root",
            subscribedAt: "2026-01-01T00:00:00Z",
          }));
        mesh.spawn({ charter: "t1-worker", parentId: "root" });

        // t1 answers root on the issue, through the tool ISSUE_NUM forces it onto.
        const body = await postAs("t1", instanceId, repo, issueNumber, "Answering your question.");
        expect(body).toContain("Answering your question.");

        // The webhook comes back through the bot account, exactly as GitHub sends it.
        const stampedAuthor = resolveStampedAuthor({
          event: "issue_comment",
          action: "created",
          payload: { comment: { body } },
          sender: "dummy-repobot",
          botLogin: "dummy-repobot",
          repoFullName: repo,
          number: issueNumber,
        });
        expect(stampedAuthor).toEqual({ actorId: "t1", instanceId });

        mesh.deliverEvent(`github:${repo}/issues/${issueNumber}`, "peer reply", {
          stampedAuthor,
          instanceId,
        });
        await tick();

        // The peer wakes: this is the behavior ISSUE_NUM's fix must not cost us.
        expect(fake("root").calls).toHaveLength(1);
        expect(fake("root").calls[0]?.prompt).toContain("Work from your inbox");
        // The author does not: this is ISSUE_NUM itself.
        expect(fake("t1").calls).toHaveLength(0);
        expect(
          logs.some((l) =>
            l.includes(`self-event suppressed by author stamp: actor=t1 instance=${instanceId}`)
          )
        ).toBe(true);
      });
    });

    describe("ISSUE_NUM system:* mesh-wide suppression", () => {
      it("withholds a verified system:* stamped event from every destination, including non-authors", async () => {
        const { mesh, tick, fake, logs } = setup();
        // biome-ignore lint/suspicious/noExplicitAny: test helper mock
        (mesh as any).eventSourceOwners.activeForResource = () => [
          {
            resource: "github:dummy-org",
            actorId: "root",
            subscribedBy: "root",
            subscribedAt: "2026-01-01T00:00:00Z",
          },
          {
            resource: "github:dummy-org",
            actorId: "t1",
            subscribedBy: "root",
            subscribedAt: "2026-01-01T00:00:00Z",
          },
        ];
        mesh.spawn({ charter: "t1-worker", parentId: "root" });

        mesh.deliverEvent("github:dummy-org/dummy-repo/issues/1048", "system comment echo", {
          stampedAuthor: { actorId: MESH_SYSTEM, instanceId: "staging-instance" },
          instanceId: "staging-instance",
        });
        await tick();

        // Neither "root" nor "t1" is the stamp's actorId, so an author-match
        // rule would have delivered to both — the system:* rule withholds
        // delivery from BOTH regardless.
        expect(fake("root").calls).toHaveLength(0);
        expect(fake("t1").calls).toHaveLength(0);
        expect(
          logs.some((l) =>
            l.includes(
              `system-event suppressed by author stamp: actor=${MESH_SYSTEM} instance=staging-instance`
            )
          )
        ).toBe(true);
      });

      it("delivers when stampedAuthor is null even for a would-be system-shaped wake", async () => {
        const { mesh, tick, fake } = setup();
        mesh.subscribeEventSource("github:dummy-org", "root", "root");

        mesh.deliverEvent(
          "github:dummy-org/dummy-repo/issues/1048",
          "unverified stamp fails open",
          {
            stampedAuthor: null,
            instanceId: "staging-instance",
            inboxPayload: payload("issue_comment.created"),
          }
        );
        await tick();

        // A null stampedAuthor means verification failed (or there was no
        // stamp) upstream — the CRITICAL fail-open rule: only a VERIFIED
        // stamp may suppress, so this must still deliver.
        expect(fake("root").calls).toHaveLength(1);
        expect(fake("root").calls[0]?.prompt).toContain("Work from your inbox");
      });

      it("does not suppress on an instanceId mismatch", async () => {
        const { mesh, tick, fake } = setup();
        mesh.subscribeEventSource("github:dummy-org", "root", "root");

        mesh.deliverEvent(
          "github:dummy-org/dummy-repo/issues/1048",
          "cross-instance system stamp",
          {
            stampedAuthor: { actorId: MESH_SYSTEM, instanceId: "prod-instance" },
            instanceId: "staging-instance",
            inboxPayload: payload("issue_comment.created"),
          }
        );
        await tick();

        expect(fake("root").calls).toHaveLength(1);
        expect(fake("root").calls[0]?.prompt).toContain("Work from your inbox");
      });
    });
  });

  // Direct subscriptions, the second row class 0038 introduces. Ownership is
  // one actor per source and governs delegation; a subscription is many actors
  // per source, exact-source-only, and governs nothing. These tests fix the
  // seam between them.
  describe("direct event source subscriptions", () => {
    const REPO_SOURCE = "github:dummy-org/dummy-repo";
    const ISSUE = "github:dummy-org/dummy-repo/issues/5";

    it("delivers to the owner and every live subscriber, once each", async () => {
      const { mesh, tick, fake } = setup();
      const owner = mesh.spawn({ charter: "owner", parentId: "root" });
      const watcherA = mesh.spawn({ charter: "watcher a", parentId: "root" });
      const watcherB = mesh.spawn({ charter: "watcher b", parentId: "root" });

      mesh.subscribeEventSource(ISSUE, owner, "root");
      mesh.addEventSourceSubscriber(ISSUE, watcherA, watcherA);
      mesh.addEventSourceSubscriber(ISSUE, watcherB, watcherB);

      mesh.deliverEvent(ISSUE, "issue event", { inboxPayload: payload("issues.opened") });
      await tick();

      expect(fake(owner).calls).toHaveLength(1);
      expect(fake(watcherA).calls).toHaveLength(1);
      expect(fake(watcherB).calls).toHaveLength(1);
    });

    it("does not double-deliver to an actor that both owns and subscribes", async () => {
      const { mesh, tick, fake } = setup();
      const owner = mesh.spawn({ charter: "owner", parentId: "root" });

      mesh.subscribeEventSource(ISSUE, owner, "root");
      mesh.addEventSourceSubscriber(ISSUE, owner, owner);

      mesh.deliverEvent(ISSUE, "issue event", { inboxPayload: payload("issues.opened") });
      await tick();

      expect(fake(owner).calls).toHaveLength(1);
    });

    it("delivers to a subscriber even when nobody owns the source", async () => {
      // An owner is not a precondition for a subscriber: the zero-destination
      // drop must count subscribers before it decides the event is uncovered.
      const { mesh, tick, fake } = setup();
      const watcher = mesh.spawn({ charter: "watcher", parentId: "root" });
      mesh.addEventSourceSubscriber(ISSUE, watcher, watcher);

      mesh.deliverEvent(ISSUE, "issue event", { inboxPayload: payload("issues.opened") });
      await tick();

      expect(fake(watcher).calls).toHaveLength(1);
    });

    it("is exact-source only — it neither bubbles up nor reaches down", async () => {
      const { mesh, tick, fake } = setup();
      const upward = mesh.spawn({ charter: "subscribed to the issue", parentId: "root" });
      const downward = mesh.spawn({ charter: "subscribed to the repo", parentId: "root" });
      mesh.subscribeEventSource(REPO_SOURCE, "root", "root");
      mesh.addEventSourceSubscriber(ISSUE, upward, upward);
      mesh.addEventSourceSubscriber(REPO_SOURCE, downward, downward);

      // A repo-level event: the issue subscriber must not hear it (no reaching
      // down), the repo subscriber must (exact match).
      mesh.deliverEvent(REPO_SOURCE, "repo event", { inboxPayload: payload("push") });
      await tick();
      expect(fake(upward).calls).toHaveLength(0);
      expect(fake(downward).calls).toHaveLength(1);

      // An issue-level event: the repo subscriber must not hear it. Ownership
      // bubbles; a subscription is a claim on one source and only that source.
      mesh.deliverEvent(ISSUE, "issue event", { inboxPayload: payload("issues.opened") });
      await tick();
      expect(fake(upward).calls).toHaveLength(1);
      expect(fake(downward).calls).toHaveLength(1);
    });

    it("skips a subscriber that is not live", async () => {
      const { mesh, tick, fake } = setup();
      const owner = mesh.spawn({ charter: "owner", parentId: "root" });
      const watcher = mesh.spawn({ charter: "watcher", parentId: "root" });
      mesh.subscribeEventSource(ISSUE, owner, "root");
      mesh.addEventSourceSubscriber(ISSUE, watcher, watcher);
      mesh.retire(watcher);

      mesh.deliverEvent(ISSUE, "issue event", { inboxPayload: payload("issues.opened") });
      await tick();

      expect(fake(owner).calls).toHaveLength(1);
      expect(fake(watcher).calls).toHaveLength(0);
    });

    it("leaves a directed delivery directed", async () => {
      // `mesh:deliver` addresses one actor on purpose. Fanning it out to the
      // source's subscribers would turn every targeted hand-off into a broadcast.
      const { mesh, tick, fake } = setup();
      const target = mesh.spawn({ charter: "directed target", parentId: "root" });
      const watcher = mesh.spawn({ charter: "watcher", parentId: "root" });
      mesh.addEventSourceSubscriber(ISSUE, watcher, watcher);

      mesh.deliverEvent(ISSUE, "issue event", {
        directedTarget: target,
        inboxPayload: payload("issues.opened"),
      });
      await tick();

      expect(fake(target).calls).toHaveLength(1);
      expect(fake(watcher).calls).toHaveLength(0);
    });

    it("still wakes a subscriber when the directive names a target that is not live", async () => {
      // The exemption above belongs to a directive that *landed*, not to the
      // presence of `directedTarget`. An ignored directive falls back to the
      // ownership ladder, and a standing interest in this source's events is
      // not defeated by someone else's failed hand-off.
      const { mesh, tick, fake, logs } = setup();
      const owner = mesh.spawn({ charter: "owner", parentId: "root" });
      const watcher = mesh.spawn({ charter: "watcher", parentId: "root" });
      mesh.subscribeEventSource(ISSUE, owner, "root");
      mesh.addEventSourceSubscriber(ISSUE, watcher, watcher);

      mesh.deliverEvent(ISSUE, "issue event", {
        directedTarget: "not-live",
        inboxPayload: payload("issues.opened"),
      });
      await tick();

      expect(logs).toContain("mesh:deliver target not live: not-live — directive ignored");
      expect(fake(owner).calls).toHaveLength(1);
      expect(fake(watcher).calls).toHaveLength(1);
    });

    it("does not make a subscriber the effective owner", () => {
      // The hazard this pins: `effectiveOwnerOf` reads the head of the ownership
      // resolution, and delegate/reclaim are gated on it. A subscriber leaking
      // into that result would let anyone who subscribed to a source hand it
      // away or take it back.
      const { mesh } = setup();
      const owner = mesh.spawn({ charter: "owner", parentId: "root" });
      const watcher = mesh.spawn({ charter: "watcher", parentId: "root" });
      const outsider = mesh.spawn({ charter: "outsider", parentId: "root" });

      mesh.subscribeEventSource(ISSUE, owner, "root");
      mesh.addEventSourceSubscriber(ISSUE, watcher, watcher);

      expect(() => mesh.delegateEventSource(ISSUE, outsider, watcher)).toThrow(
        /current effective owner/
      );
      expect(() => mesh.reclaimEventSource(ISSUE, watcher)).toThrow();
      // And the owner is unaffected by the subscription sitting alongside it.
      expect(() => mesh.delegateEventSource(ISSUE, outsider, owner)).not.toThrow();
    });

    it("records an audit event for each add and removal", () => {
      const events: MeshEventInput[] = [];
      const { mesh } = setup({ events: (e: MeshEventInput) => events.push(e) });
      const watcher = mesh.spawn({ charter: "watcher", parentId: "root" });

      mesh.addEventSourceSubscriber(ISSUE, watcher, "root");
      mesh.removeEventSourceSubscriber(ISSUE, watcher);

      expect(events.filter((e) => e.kind.startsWith("event_source_subscriber_"))).toEqual([
        expect.objectContaining({
          kind: "event_source_subscriber_added",
          actorId: watcher,
          detail: ISSUE,
          payload: JSON.stringify({ subscribedBy: "root" }),
        }),
        expect.objectContaining({
          kind: "event_source_subscriber_removed",
          actorId: watcher,
          detail: ISSUE,
        }),
      ]);
    });

    it("stops delivering once the subscription is removed", async () => {
      const { mesh, tick, fake } = setup();
      const watcher = mesh.spawn({ charter: "watcher", parentId: "root" });
      mesh.addEventSourceSubscriber(ISSUE, watcher, watcher);
      mesh.removeEventSourceSubscriber(ISSUE, watcher);
      expect(mesh.listEventSourceSubscriptions()).toEqual([]);

      mesh.deliverEvent(ISSUE, "issue event", { inboxPayload: payload("issues.opened") });
      await tick();
      expect(fake(watcher).calls).toHaveLength(0);
    });

    it("refuses to subscribe an unknown thread", () => {
      const { mesh } = setup();
      expect(() => mesh.addEventSourceSubscriber(ISSUE, "ghost", "root")).toThrow(
        /cannot subscribe unknown thread/
      );
    });

    it("retirement deletes the subscriptions while tombstoning the ownership", () => {
      const { mesh } = setup();
      const actorId = mesh.spawn({ charter: "worker", parentId: "root" });
      mesh.subscribeEventSource(REPO_SOURCE, actorId, "root");
      mesh.addEventSourceSubscriber(ISSUE, actorId, actorId);

      mesh.retire(actorId);

      expect(mesh.listSubscriptions().find((s) => s.actorId === actorId)?.unsubscribedAt).toBe(
        "2026-01-01T00:00:00Z"
      );
      expect(mesh.listEventSourceSubscriptions()).toEqual([]);
    });

    describe("configured scope", () => {
      it("refuses a subscription outside every configured event source", () => {
        const { mesh } = setup({ configuredEventSources: [REPO_SOURCE] });
        const watcher = mesh.spawn({ charter: "watcher", parentId: "root" });

        expect(() =>
          mesh.addEventSourceSubscriber("github:other-org/elsewhere", watcher, watcher)
        ).toThrow(/not anchored in a configured event source/);
        // The strict ancestor is refused too: config narrows this instance, and
        // subscribing to the whole org would widen it straight back out.
        expect(() => mesh.addEventSourceSubscriber("github:dummy-org", watcher, watcher)).toThrow(
          /not anchored in a configured event source/
        );
        expect(mesh.listEventSourceSubscriptions()).toEqual([]);
      });

      it("accepts the configured source itself and anything under it", () => {
        const { mesh } = setup({ configuredEventSources: [REPO_SOURCE] });
        const watcher = mesh.spawn({ charter: "watcher", parentId: "root" });

        mesh.addEventSourceSubscriber(REPO_SOURCE, watcher, watcher);
        mesh.addEventSourceSubscriber(ISSUE, watcher, watcher);
        expect(
          mesh
            .listEventSourceSubscriptions()
            .map((s) => s.resource)
            .sort()
        ).toEqual([ISSUE, REPO_SOURCE].sort());
      });
    });
  });

  describe("Scheduled messages", () => {
    it("rejects immediate self-sends and invalid delivery windows", () => {
      const { mesh } = setup();
      const t1 = mesh.spawn({ charter: "t1", parentId: "root" });
      const t2 = mesh.spawn({ charter: "t2", parentId: "root" });

      expect(() => mesh.sendMessage(t1, "hello", t1)).toThrow(/Immediate self-sends/);
      expect(() =>
        mesh.sendMessage(t1, "hello", t1, undefined, new Date(Date.now() + 30_000).toISOString())
      ).toThrow(/minimum 60s delay/);
      expect(() =>
        mesh.sendMessage(t1, "hello", t2, undefined, new Date(Date.now() - 1).toISOString())
      ).toThrow(/must be in the future/);
      expect(() =>
        mesh.sendMessage(
          t1,
          "hello",
          t2,
          undefined,
          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        )
      ).toThrow(/beyond max horizon/);
    });

    it("enforces the recipient cap from the authoritative host queue", () => {
      const { mesh, scheduledMessages } = setup();
      const recipient = mesh.spawn({ charter: "recipient", parentId: "root" });
      const sender = mesh.spawn({ charter: "sender", parentId: "root" });
      const deliverAt = new Date(Date.now() + 100_000).toISOString();

      for (let i = 0; i < 10; i++) {
        mesh.sendMessage(recipient, `msg ${i}`, sender, undefined, deliverAt);
      }

      expect(scheduledMessages.listForRecipient(recipient)).toHaveLength(10);
      expect(() => mesh.sendMessage(recipient, "11th msg", sender, undefined, deliverAt)).toThrow(
        /cap of 10 pending deliveries/
      );
    });

    it("places the complete message in the host queue and records acceptance once", () => {
      const chatRows: unknown[] = [];
      const events: MeshEventInput[] = [];
      const { mesh, scheduledMessages } = setup({
        recordChat: (row) => {
          chatRows.push(row);
          return row.id ?? "missing-id";
        },
        events: (event) => events.push(event),
      });
      const recipient = mesh.spawn({ charter: "recipient", parentId: "root" });
      const sender = mesh.spawn({ charter: "sender", parentId: "root" });
      const deliverAt = new Date(Date.now() + 100_000).toISOString();

      expect(
        mesh.sendMessage(
          recipient,
          "body with 'quotes' & newlines\nnext",
          sender,
          "session-1",
          deliverAt
        )
      ).toEqual({ delivered: true });

      expect(scheduledMessages.listForRecipient(recipient)).toEqual([
        expect.objectContaining({
          id: expect.any(String),
          toId: recipient,
          fromId: sender,
          body: "body with 'quotes' & newlines\nnext",
          deliverAt,
          sessionId: "session-1",
        }),
      ]);
      expect(chatRows).toHaveLength(1);
      expect(events.filter((event) => event.kind === "message_sent")).toHaveLength(1);
      expect(events.filter((event) => event.kind === "message_received")).toHaveLength(0);
    });

    it("does not write chat or audit state when the host rejects the job", () => {
      const scheduler = new FakeScheduledMessageScheduler();
      scheduler.scheduleMessageDeliveryImpl = () => {
        throw new Error("at rejected the job");
      };
      const recordChat = vi.fn(() => "unexpected");
      const events = vi.fn();
      const { mesh } = setup({ scheduledMessages: scheduler, recordChat, events });
      const recipient = mesh.spawn({ charter: "recipient", parentId: "root" });
      const sender = mesh.spawn({ charter: "sender", parentId: "root" });

      expect(() =>
        mesh.sendMessage(
          recipient,
          "scheduled message",
          sender,
          undefined,
          new Date(Date.now() + 100_000).toISOString()
        )
      ).toThrow(/at rejected the job/);
      expect(scheduler.listMessageDeliveries()).toEqual([]);
      expect(recordChat).not.toHaveBeenCalled();
      expect(
        events.mock.calls.some(
          ([event]) => event.kind === "message_sent" || event.kind === "message_received"
        )
      ).toBe(false);
    });

    it("removes the host job when the acceptance transaction fails", () => {
      const scheduler = new FakeScheduledMessageScheduler();
      const { mesh } = setup({
        scheduledMessages: scheduler,
        recordChat: (row) => row.id ?? "missing-id",
        events: () => {
          throw new Error("audit write failed");
        },
      });
      const recipient = mesh.spawn({ charter: "recipient", parentId: "root" });
      const sender = mesh.spawn({ charter: "sender", parentId: "root" });

      expect(() =>
        mesh.sendMessage(
          recipient,
          "scheduled message",
          sender,
          undefined,
          new Date(Date.now() + 100_000).toISOString()
        )
      ).toThrow(/audit write failed/);
      expect(scheduler.listMessageDeliveries()).toEqual([]);
    });

    it("boot reconciliation keeps live recipients and removes jobs for inactive recipients", () => {
      const inboxStore = createMemoryInboxStore();
      const { mesh, scheduledMessages } = setup({ inboxStore });
      const recipient = mesh.spawn({ charter: "recipient", parentId: "root" });
      const sender = mesh.spawn({ charter: "sender", parentId: "root" });
      const deliverAt = new Date(Date.now() + 100_000).toISOString();
      scheduledMessages.scheduleMessageDelivery({
        id: "live-message",
        toId: recipient,
        fromId: sender,
        body: "keep",
        deliverAt,
      });
      scheduledMessages.scheduleMessageDelivery({
        id: "orphan-message",
        toId: "missing-recipient",
        fromId: sender,
        body: "drop",
        deliverAt,
      });

      mesh.reconcilePendingDeliveries();

      expect(scheduledMessages.listMessageDeliveries()).toEqual([
        expect.objectContaining({ id: "live-message" }),
      ]);
      expect(inboxStore.entries).toContainEqual(
        expect.objectContaining({
          actorId: sender,
          payload: expect.objectContaining({
            pendingMessageId: "orphan-message",
            note: expect.stringContaining("[scheduled message dropped]"),
          }),
        })
      );
    });

    it("reconstructs acceptance history when a crash occurs after the at job is installed", () => {
      const chatRows = new Map<string, string>();
      const events: MeshEventInput[] = [];
      const { mesh } = setup({
        recordChat: (row) => {
          const id = row.id ?? "missing-id";
          chatRows.set(id, row.body);
          return id;
        },
        events: (event) => events.push(event),
      });
      const recipient = mesh.spawn({ charter: "recipient", parentId: "root" });
      const sender = mesh.spawn({ charter: "sender", parentId: "root" });
      events.length = 0;
      const message: ScheduledMessage = {
        id: "host-only-message",
        toId: recipient,
        fromId: sender,
        body: "survived in at",
        deliverAt: new Date(Date.now() - 1_000).toISOString(),
      };

      mesh.deliverScheduledMessage(message);

      expect(chatRows.get(message.id)).toBe(message.body);
      expect(events.map((event) => event.kind)).toEqual(["message_sent", "message_received"]);
    });

    it("makes callback retries idempotent without a local pending-message row", () => {
      const storedInbox = createMemoryInboxStore();
      let failAppend = true;
      const inboxStore: InboxStore = {
        ...storedInbox,
        append: (inputs) => {
          if (failAppend) {
            failAppend = false;
            throw new Error("disk full");
          }
          return storedInbox.append(inputs);
        },
      };
      const eventIds = new Set<string>();
      const eventKinds: string[] = [];
      const chatIds = new Set<string>();
      const { mesh, scheduledMessages } = setup({
        inboxStore,
        recordChat: (row) => {
          const id = row.id ?? "missing-id";
          chatIds.add(id);
          return id;
        },
        events: (event) => {
          if (event.id && eventIds.has(event.id)) return;
          if (event.id) eventIds.add(event.id);
          if (event.kind === "message_sent" || event.kind === "message_received") {
            eventKinds.push(event.kind);
          }
        },
      });
      const recipient = mesh.spawn({ charter: "recipient", parentId: "root" });
      const sender = mesh.spawn({ charter: "sender", parentId: "root" });
      mesh.sendMessage(
        recipient,
        "retry me",
        sender,
        undefined,
        new Date(Date.now() + 100_000).toISOString()
      );
      const queued = scheduledMessages.listForRecipient(recipient)[0];
      expect(queued).toBeDefined();

      const callbackPayload = scheduledMessages.fire(queued.id);
      expect(() => mesh.deliverScheduledMessage(callbackPayload)).toThrow(/disk full/);
      expect(() => mesh.deliverScheduledMessage(callbackPayload)).not.toThrow();

      expect(chatIds).toEqual(new Set([queued.id]));
      expect(storedInbox.entries.filter((entry) => entry.actorId === recipient)).toHaveLength(1);
      expect(eventKinds).toEqual(["message_sent", "message_received"]);
    });

    it("survives a mesh restart because the complete payload remains in the host queue", () => {
      const actors = new InMemoryActorRepository();
      const scheduler = new FakeScheduledMessageScheduler();
      const inboxStore = createMemoryInboxStore();
      const { mesh: mesh1 } = setup({
        actors,
        scheduledMessages: scheduler,
        inboxStore,
        recordChat: (row) => row.id ?? "missing-id",
      });
      const recipient = mesh1.spawn({ charter: "recipient", parentId: "root" });
      const sender = mesh1.spawn({ charter: "sender", parentId: "root" });
      mesh1.sendMessage(
        recipient,
        "restart-boundary message",
        sender,
        undefined,
        new Date(Date.now() + 100_000).toISOString()
      );
      const queued = scheduler.listForRecipient(recipient)[0];
      mesh1.shutdownAll();

      const { mesh: mesh2 } = setup({
        actors,
        scheduledMessages: scheduler,
        inboxStore,
        recordChat: (row) => row.id ?? "missing-id",
      });
      mesh2.rehydrateAll();
      mesh2.deliverScheduledMessage(scheduler.fire(queued.id));

      expect(inboxStore.entries).toContainEqual(
        expect.objectContaining({
          id: queued.id,
          actorId: recipient,
          payload: expect.objectContaining({ type: "mesh.scheduled_message" }),
        })
      );
      expect(scheduler.listMessageDeliveries()).toEqual([]);
    });

    it("refuses even a forced retirement while a delivery is pending, and drops nothing", async () => {
      const inboxStore = createMemoryInboxStore();
      const { mesh, fake, tick, registry, scheduledMessages } = setup({ inboxStore });
      const sender = mesh.spawn({ charter: "sender", parentId: "root" });
      const recipient = mesh.spawn({ charter: "recipient", parentId: "root" });
      mesh.sendMessage(
        recipient,
        "long wait",
        sender,
        undefined,
        new Date(Date.now() + 100_000).toISOString()
      );
      const pendingMessageId = scheduledMessages.listForRecipient(recipient)[0]?.id as string;

      // Retirement no longer drops a pending delivery on any path (#191).
      // `force` overrides the run-in-flight guard; it was never a licence to
      // destroy the work itself, so the operator is told to decide this
      // message by name instead of having it dropped on their behalf.
      expect(() => mesh.retire(recipient, { force: true })).toThrow(RetirementBlockedError);
      await tick();

      expect(registry.get(recipient)?.status).toBe("active");
      expect(scheduledMessages.listForRecipient(recipient).map((m) => m.id)).toEqual([
        pendingMessageId,
      ]);
      // Nothing dropped means nobody notified: no mechanical notice, no run.
      expect(fake(sender).calls).toHaveLength(0);
      expect(inboxStore.entries).toEqual([]);

      // Once someone entitled to decide has decided, the retirement goes through.
      mesh.cancelScheduledMessage(pendingMessageId, "root", "recipient is going away");
      mesh.retire(recipient, { force: true });
      await tick();
      expect(registry.get(recipient)?.status).toBe("retired");
      expect(inboxStore.entries).toEqual([]);
    });

    it("routes a dropped-message notice to the sender's nearest live ancestor", async () => {
      const inboxStore = createMemoryInboxStore();
      const { mesh, fake, tick, scheduledMessages } = setup({ inboxStore });
      const grandparent = mesh.spawn({ charter: "grandparent", parentId: "root" });
      const sender = mesh.spawn({ charter: "sender", parentId: grandparent });
      const recipient = mesh.spawn({ charter: "recipient", parentId: "root" });
      mesh.sendMessage(
        recipient,
        "never arrive",
        sender,
        undefined,
        new Date(Date.now() + 100_000).toISOString()
      );

      const pending = scheduledMessages.listForRecipient(recipient)[0];
      expect(pending).toBeDefined();

      // Retirement drops nothing now (#191), so the surviving route to this
      // notice is the one it was always really for: the OS job firing after
      // the cancellation and retirement that raced it.
      mesh.cancelScheduledMessage(pending.id, grandparent, "recipient is going away");
      mesh.retire(sender);
      await tick();
      mesh.retire(recipient);
      await tick();
      mesh.deliverScheduledMessage(pending);
      await tick();

      expect(fake(grandparent).calls).toHaveLength(1);
      expect(inboxStore.entries[0]).toMatchObject({
        actorId: grandparent,
        payload: expect.objectContaining({
          note: expect.stringContaining("[scheduled message dropped]"),
          originalFromId: sender,
        }),
      });
      expect(scheduledMessages.listForRecipient(recipient)).toEqual([]);
    });
  });
  describe("retire cancels pending wakes & late wakes no-op ", () => {
    it("blocks retirement on an actor's own pending self-wake until it is cancelled", async () => {
      const inboxStore = createMemoryInboxStore();
      const { mesh, registry, fake, tick, scheduledMessages } = setup({ inboxStore });
      const parent = mesh.spawn({ charter: "parent", parentId: "root" });
      const worker = mesh.spawn({ charter: "worker", parentId: parent });

      // Actor schedules a wake for itself 100s in the future
      const deliverAt = new Date(Date.now() + 100000).toISOString();
      const res = mesh.sendMessage(worker, "self follow-up wake", worker, undefined, deliverAt);
      expect(res.delivered).toBe(true);
      const pending = scheduledMessages.listForRecipient(worker);
      expect(pending).toHaveLength(1);

      // Both endpoints are inside the subtree, so the wake is `internal` — and
      // it blocks like any other, force included (#191).
      expect(() => mesh.retire(worker, { force: true })).toThrow(RetirementBlockedError);
      expect(registry.get(worker)?.status).toBe("active");
      expect(scheduledMessages.listForRecipient(worker)).toHaveLength(1);

      // The parent decides the wake is moot; only then does the worker go.
      mesh.cancelScheduledMessage(pending[0].id, parent, "worker is done");
      mesh.retire(worker);
      await tick();

      expect(scheduledMessages.listForRecipient(worker)).toEqual([]);
      expect(registry.get(worker)?.status).toBe("retired");

      // Advance time past the deliverAt timestamp
      await vi.advanceTimersByTimeAsync(150000);

      // Nothing wakes, and nobody is told a message was dropped, because none was.
      expect(fake(worker).calls).toHaveLength(0);
      expect(fake(parent).calls).toHaveLength(0);
      expect(inboxStore.entries).toEqual([]);
    });

    it("deliverWake gracefully drops and returns false on retired actor without crashing", async () => {
      const inboxStore = createMemoryInboxStore();
      const logs: string[] = [];
      const { mesh, fake, tick } = setup({
        inboxStore,
        onRetire: (r) => logs.push(`onRetire:${r.id}`),
      });
      const worker = mesh.spawn({ charter: "worker", parentId: "root" });

      // Retire the worker
      mesh.retire(worker);
      await tick();

      // Attempt deliverWake against retired worker
      const delivered = mesh.deliverWake(worker, "late cron wake");
      expect(delivered).toBe(false);

      // Advance time
      await tick();

      // Worker provider should never be invoked
      expect(fake(worker).calls).toHaveLength(0);
    });

    it("a late host callback after retirement is a deduplicated drop", async () => {
      const inboxStore = createMemoryInboxStore();
      const { mesh, fake, tick, scheduledMessages } = setup({ inboxStore });
      const parent = mesh.spawn({ charter: "parent", parentId: "root" });
      const worker = mesh.spawn({ charter: "worker", parentId: parent });

      const deliverAt = new Date(Date.now() + 100000).toISOString();
      mesh.sendMessage(worker, "late message", parent, undefined, deliverAt);
      const pending = scheduledMessages.listForRecipient(worker)[0];
      expect(pending).toBeDefined();

      mesh.cancelScheduledMessage(pending.id, parent, "worker is done");
      mesh.retire(worker);
      await tick();

      // An `at` process may already have started while cancellation raced it,
      // and curl may retry the callback. Both must stay harmless, and the
      // sender hears about it once rather than once per callback.
      mesh.deliverScheduledMessage(pending);
      mesh.deliverScheduledMessage(pending);
      await tick();

      // Worker should not have run
      expect(fake(worker).calls).toHaveLength(0);
      expect(inboxStore.entries.filter((entry) => entry.actorId === parent)).toHaveLength(1);
    });

    it("queued run in concurrency limiter for an actor force-retired while queued skips execution", async () => {
      let executedWorker2 = false;
      const deferred = deferredProvider();
      const { mesh } = setup({
        maxConcurrent: 1,
        createActor: (ctx) => {
          let actor!: Actor;
          const provider: CodingProvider = {
            name: "test-provider",
            providerName: "test-provider",
            run: async (opts) => {
              if (ctx.record.id === "t2") {
                executedWorker2 = true;
              }
              const res = await deferred.provider.run(opts);
              actor.declareYield();
              return res;
            },
          };
          actor = new Actor({
            id: ctx.record.id,
            cwd: `/tmp/${ctx.record.id}`,
            modelConfig: [{ provider: "test-provider" }],
            resolveProvider: () => provider,
            mcpServers: [],
            loadSessionId: () => undefined,
            saveSessionId: () => {},
            buildPrompt: () => ({ prompt: "prompt" }),
            gate: ctx.gate,
            beforeRun: ctx.beforeRun,
            onQueued: ctx.onQueued,
            onRunEnd: ctx.onRunEnd,
            debounceMs: DEBOUNCE,
          });
          return actor;
        },
      });

      const worker1 = mesh.spawn({ charter: "worker1", parentId: "root" });
      const worker2 = mesh.spawn({ charter: "worker2", parentId: "root" });

      // Worker 1 starts running and occupies the single concurrency slot
      mesh.sendMessage(worker1, "task 1", "root");
      await vi.advanceTimersByTimeAsync(DEBOUNCE + 1);

      // Worker 2 is queued behind worker 1
      mesh.sendMessage(worker2, "task 2", "root");
      await vi.advanceTimersByTimeAsync(DEBOUNCE + 1);

      expect(mesh.activeRunState(worker2)?.phase).toBe("queued");

      // Force-retire worker2 while queued
      mesh.retire(worker2, { force: true });
      expect(mesh.actors.get(worker2)?.status).toBe("retired");

      // Release worker1 so concurrency slot opens
      deferred.releaseAll();
      await vi.advanceTimersByTimeAsync(5000);

      // Worker 2 should have been skipped in invoke / beforeRun and not executed run
      expect(executedWorker2).toBe(false);
    });

    it("admitted run in gate for an actor retired before invoke drops without onRunEnd or failure forwarding ", async () => {
      let runInvoke!: () => Promise<unknown>;
      let onRunEndCalled = false;
      const deferred = deferredProvider();

      const { mesh } = setup({
        createActor: (ctx) => {
          let actor!: Actor;
          const provider: CodingProvider = {
            name: "test-provider",
            providerName: "test-provider",
            run: async (opts) => {
              const res = await deferred.provider.run(opts);
              actor.declareYield();
              return res;
            },
          };
          actor = new Actor({
            id: ctx.record.id,
            cwd: `/tmp/${ctx.record.id}`,
            modelConfig: [{ provider: "test-provider" }],
            resolveProvider: () => provider,
            mcpServers: [],
            loadSessionId: () => undefined,
            saveSessionId: () => {},
            buildPrompt: () => ({ prompt: "prompt" }),
            gate: <T>(
              fn: (selected: RawProviderModelConfig) => Promise<T>,
              candidates: readonly RawProviderModelConfig[],
              resp: boolean
            ): RunStartHandle<T> => {
              if (ctx.record.id === "t1") {
                let resolve!: (val: unknown) => void;
                let reject!: (err: unknown) => void;
                const result = new Promise<unknown>((res, rej) => {
                  resolve = res;
                  reject = rej;
                });
                runInvoke = async () => {
                  try {
                    const res = await fn(candidates[0] ?? { provider: "test-provider" });
                    resolve(res);
                    return res;
                  } catch (err) {
                    reject(err);
                    throw err;
                  }
                };
                return {
                  result: result as unknown as Promise<T>,
                  started: true,
                  promote: () => {},
                  cancel: () => false,
                };
              }
              return ctx.gate(fn, candidates, resp);
            },
            beforeRun: ctx.beforeRun,
            onQueued: ctx.onQueued,
            onRunEnd: async (res) => {
              if (ctx.record.id === "t1") {
                onRunEndCalled = true;
              }
              await ctx.onRunEnd?.(res);
            },
            debounceMs: DEBOUNCE,
          });
          return actor;
        },
      });

      const worker = mesh.spawn({ charter: "worker", parentId: "root" });
      mesh.sendMessage(worker, "task", "root");
      await vi.advanceTimersByTimeAsync(DEBOUNCE + 1);

      expect(runInvoke).toBeDefined();

      // Retire worker after gate admission but before invoke
      mesh.retire(worker, { force: true });
      expect(mesh.actors.get(worker)?.status).toBe("retired");

      // Invoke now executes post-admission
      await expect(runInvoke()).rejects.toThrow(RunStartCancelledError);
      await vi.advanceTimersByTimeAsync(100);

      expect(onRunEndCalled).toBe(false);
    });

    it("sendMessage and sendHumanMessage targeting retired actor return delivered false", () => {
      const { mesh } = setup();
      const worker = mesh.spawn({ charter: "worker", parentId: "root" });
      mesh.retire(worker);

      const msgRes = mesh.sendMessage(worker, "hello", "root");
      expect(msgRes.delivered).toBe(false);
      if (!msgRes.delivered) {
        expect(msgRes.status).toBe("retired");
      }

      const humanRes = mesh.sendHumanMessage(worker, "hello from human", "session-1");
      expect(humanRes.delivered).toBe(false);
      if (!humanRes.delivered) {
        expect(humanRes.status).toBe("retired");
      }
    });
  });

  describe("interrupt & runNow ", () => {
    it("interrupt requires ancestor authority (rejects non-ancestor peers)", () => {
      const { mesh } = setup();
      const parent = mesh.spawn({ charter: "parent", parentId: "root" });
      const child = mesh.spawn({ charter: "child", parentId: parent });
      const peer = mesh.spawn({ charter: "peer", parentId: "root" });

      expect(() => mesh.interrupt(child, peer)).toThrow(/may only interrupt its descendants/);
      expect(() => mesh.interrupt(child, parent)).not.toThrow();
      expect(() => mesh.interrupt(child, "human:operator")).not.toThrow();
    });

    it("scopes generated-root interrupt authority to its own subtree ", () => {
      const generatedRootId = "11111111-1111-4111-8111-111111111111";
      const { mesh, registry } = setup({ rootId: generatedRootId });
      const ownChild = mesh.spawn({ charter: "own child", parentId: "root" });
      const otherRoot = mesh.spawn({ charter: "another account root", parentId: "root" });
      registry.patch(otherRoot, { parentId: null, isRoot: true });
      const otherChild = mesh.spawn({ charter: "other child", parentId: otherRoot });

      expect(() => mesh.interrupt(ownChild, "root")).not.toThrow();
      expect(() => mesh.interrupt(otherChild, "root")).toThrow(
        /may only interrupt its descendants/
      );
    });

    it("interrupt on running actor aborts and respects highwatermark (no new inbox items -> stays idle)", async () => {
      const inboxStore = createMemoryInboxStore();
      const events: MeshEventInput[] = [];
      let resolveRun!: (res: RunResult) => void;
      const { mesh, tick, fake } = setup({
        inboxStore,
        events: (e) => events.push(e),
        sharedProvider: new FakeProvider(() => {
          return new Promise<RunResult>((resolve) => {
            resolveRun = resolve;
          });
        }),
      });

      const worker = mesh.spawn({ charter: "worker", parentId: "root" });
      inboxStore.append([
        {
          actorId: worker,
          source: "root",
          payload: { type: "task", content: "initial task" },
        },
      ]);
      mesh.notifyInboxChanged(worker);
      await tick();

      expect(mesh.activeRunState(worker)).toEqual({ actorId: worker, phase: "running" });
      expect(fake(worker).calls).toHaveLength(1);

      // Interrupt without any new inbox items
      const res = mesh.interrupt(worker, "human:operator");
      expect(res.interrupted).toBe(true);

      // Provider finishes with interrupted result
      resolveRun({
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        output: "[Task interrupted by human:operator]",
      });
      await tick();

      // Since no new inbox items arrived since run start, worker does NOT run again
      expect(fake(worker).calls).toHaveLength(1);
      expect(mesh.activeRunState(worker)).toBeNull();
      expect(events.some((e) => e.detail?.includes("interrupted by human:operator"))).toBe(true);
    });

    it("interrupt on running actor runs immediately if a new inbox item arrived after run start", async () => {
      const inboxStore = createMemoryInboxStore();
      let resolveRun!: (res: RunResult) => void;
      let runIndex = 0;
      const { mesh, tick, fake } = setup({
        inboxStore,
        sharedProvider: new FakeProvider(() => {
          return new Promise<RunResult>((resolve) => {
            if (runIndex++ === 0) {
              resolveRun = resolve;
            } else {
              resolve({ success: true, exitCode: 0, output: "done" });
            }
          });
        }),
      });

      const worker = mesh.spawn({ charter: "worker", parentId: "root" });
      inboxStore.append([
        {
          actorId: worker,
          source: "root",
          deliveredAt: new Date(Date.now() - 10000),
          payload: { type: "task", content: "initial task" },
        },
      ]);
      mesh.notifyInboxChanged(worker);
      await tick();

      expect(mesh.activeRunState(worker)).toEqual({ actorId: worker, phase: "running" });
      expect(fake(worker).calls).toHaveLength(1);

      // While running, a new inbox item arrives (arrived AFTER run start)
      inboxStore.append([
        {
          actorId: worker,
          source: "root",
          deliveredAt: new Date(Date.now() + 1000),
          payload: { type: "task", content: "new correction message" },
        },
      ]);

      // Interrupt the first run
      const res = mesh.interrupt(worker, "human:operator");
      expect(res.interrupted).toBe(true);

      resolveRun({
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        output: "[Task interrupted by human:operator]",
      });
      await tick();

      // Because the new inbox item arrived after run start, the worker wakes and runs again!
      expect(fake(worker).calls).toHaveLength(2);
    });

    it("runNow appends responsive nudge item and triggers a run", async () => {
      const inboxStore = createMemoryInboxStore();
      const { mesh, tick, fake } = setup({ inboxStore });
      const worker = mesh.spawn({ charter: "worker", parentId: "root" });

      expect(fake(worker).calls).toHaveLength(0);

      const res = mesh.runNow(worker, "dashboard");
      expect(res.queued).toBe(true);
      await tick();

      expect(fake(worker).calls).toHaveLength(1);
      const entry = inboxStore.entries.find((e) => e.actorId === worker);
      expect(entry?.payload).toMatchObject({
        type: "operator.run_now",
        priority: "responsive",
      });
    });

    it("runNow throws when target actor is unknown ", () => {
      const { mesh } = setup();
      expect(() => mesh.runNow("ghost-actor", "dashboard")).toThrow(
        "cannot run unknown actor ghost-actor"
      );
    });
  });

  describe("obligation-governed event source ownership", () => {
    /** A stand-in obligation store: the mesh only ever asks it one question. */
    const owning = (byRef: Record<string, string>): ActorMeshOptions["obligations"] => ({
      findLiveByExternalRef: (ref) => (byRef[ref] ? { ownerId: byRef[ref] } : null),
    });

    const REF = "github:MEK-Org/rusa/issues/33";
    const issue = REF;

    /**
     * Deliver an event and report which actors it woke.
     *
     * Uses the shared-provider + `run_yielded` pattern the other event-routing
     * tests use: a spawned actor only reaches the event sink once something
     * actually runs it, so the provider has to declare a yield.
     */
    async function wokenBy(
      obligations: ActorMeshOptions["obligations"],
      wire: (mesh: ReturnType<typeof setup>["mesh"]) => void,
      resource: EventResource,
      afterFirstDelivery?: (mesh: ReturnType<typeof setup>["mesh"]) => void,
      deliveryOptions?: (mesh: ReturnType<typeof setup>["mesh"]) => EventDeliveryOptions
    ): Promise<string[]> {
      const events: Array<{ kind: string; actorId?: string | null }> = [];
      let mesh!: ReturnType<typeof setup>["mesh"];
      const running: string[] = [];
      const provider = new FakeProvider((opts) => {
        // The scaffold names the running actor's own thread id in its prompt,
        // which is the only handle a shared provider has on who it is running.
        const id = /thread `([^`]+)`/.exec(opts.prompt ?? "")?.[1] ?? "";
        running.push(id);
        if (id) mesh.declareYield(id, "complete", "done");
        return {};
      });
      const env = setup({ obligations, sharedProvider: provider, events: (e) => events.push(e) });
      mesh = env.mesh;
      wire(mesh);
      mesh.deliverEvent(resource, "event", {
        ...deliveryOptions?.(mesh),
        inboxPayload: payload("issues.opened"),
      });
      await env.tick();
      if (afterFirstDelivery) {
        afterFirstDelivery(mesh);
        await env.tick();
      }
      return [
        ...new Set(
          events
            .filter((e) => e.kind === "run_yielded" && e.actorId)
            .map((e) => e.actorId as string)
        ),
      ];
    }

    it("routes a linked issue to the obligation owner, superseding a manual delegation", async () => {
      let delegate = "";
      let owner = "";
      const woken = await wokenBy(
        owning({ [REF]: "t2" }),
        (mesh) => {
          delegate = mesh.spawn({ charter: "earlier delegate", parentId: "root" });
          owner = mesh.spawn({ charter: "obligation owner", parentId: "root" });
          mesh.subscribeEventSource(issue, delegate, "root");
        },
        issue
      );

      expect(owner).toBe("t2");
      expect(woken).toEqual([owner]);
      expect(woken).not.toContain(delegate);
    });

    // The obligation rung *returns* from inside the ownership ladder — it is a
    // terminating answer, not one more candidate. Direct subscribers are
    // therefore resolved outside the ladder entirely; resolve them inside it and
    // the most authoritative routing case in the mesh would be the one case that
    // silently starves them.
    it("wakes a direct subscriber even when a live obligation terminates the ownership climb", async () => {
      let owner = "";
      let watcher = "";
      const woken = await wokenBy(
        owning({ [REF]: "t2" }),
        (mesh) => {
          watcher = mesh.spawn({ charter: "watcher", parentId: "root" });
          owner = mesh.spawn({ charter: "obligation owner", parentId: "root" });
          mesh.addEventSourceSubscriber(issue, watcher, watcher);
        },
        issue
      );

      expect(owner).toBe("t2");
      expect(woken.sort()).toEqual([owner, watcher].sort());
    });

    it("falls back to subscriptions when no live obligation is linked", async () => {
      let delegate = "";
      const lookedUp: string[] = [];
      const woken = await wokenBy(
        {
          findLiveByExternalRef: (ref) => {
            lookedUp.push(ref);
            return null;
          },
        },
        (mesh) => {
          delegate = mesh.spawn({ charter: "delegate", parentId: "root" });
          mesh.subscribeEventSource(issue, delegate, "root");
        },
        issue
      );

      expect(woken).toEqual([delegate]);
      expect(lookedUp).toEqual([REF]);
    });

    it("maps a linked pull request to its obligation owner", async () => {
      const pull = "github:MEK-Org/rusa/pulls/33";
      let owner = "";
      const woken = await wokenBy(
        owning({ "github:MEK-Org/rusa/pulls/33": "t1" }),
        (mesh) => {
          owner = mesh.spawn({ charter: "pull request owner", parentId: "root" });
        },
        pull
      );

      expect(woken).toEqual([owner]);
    });

    it("keeps a directed target from bypassing the obligation owner", async () => {
      let directedTarget = "";
      let owner = "";
      const woken = await wokenBy(
        owning({ [REF]: "t2" }),
        (mesh) => {
          directedTarget = mesh.spawn({ charter: "directed target", parentId: "root" });
          owner = mesh.spawn({ charter: "obligation owner", parentId: "root" });
        },
        issue,
        undefined,
        () => ({ directedTarget })
      );

      expect(woken).toEqual([owner]);
      expect(woken).not.toContain(directedTarget);
    });

    it("still wakes a subscriber when a live obligation overrides the directive", async () => {
      // The obligation beats the directive, so the delivery never becomes
      // `directed` and the subscriber is merged as usual. Worth pinning
      // separately: this is the one directed path where ownership is decided by
      // the obligation branch, and a future change that set `directed` as soon
      // as a target was named would silently drop the subscriber here.
      let owner = "";
      let watcher = "";
      let directedTarget = "";
      const woken = await wokenBy(
        owning({ [REF]: "t3" }),
        (mesh) => {
          watcher = mesh.spawn({ charter: "watcher", parentId: "root" });
          directedTarget = mesh.spawn({ charter: "directed target", parentId: "root" });
          owner = mesh.spawn({ charter: "obligation owner", parentId: "root" });
          mesh.addEventSourceSubscriber(issue, watcher, watcher);
        },
        issue,
        undefined,
        () => ({ directedTarget })
      );

      expect(owner).toBe("t3");
      expect(woken.sort()).toEqual([owner, watcher].sort());
      expect(woken).not.toContain(directedTarget);
    });

    it("routes the next event to a reassigned obligation owner without synchronizing subscriptions", async () => {
      const ownerByRef: Record<string, string> = {};
      let firstOwner = "";
      let secondOwner = "";
      const woken = await wokenBy(
        owning(ownerByRef),
        (mesh) => {
          firstOwner = mesh.spawn({ charter: "first obligation owner", parentId: "root" });
          secondOwner = mesh.spawn({ charter: "reassigned obligation owner", parentId: "root" });
          ownerByRef[REF] = firstOwner;
        },
        issue,
        (mesh) => {
          // This is the repository state change made by reassign(). No event
          // subscription write accompanies it: routing reads ownership anew.
          ownerByRef[REF] = secondOwner;
          mesh.deliverEvent(issue, "event", { inboxPayload: payload("issues.edited") });
        }
      );

      expect(woken).toEqual([firstOwner, secondOwner]);
    });

    it("routes through the real repository after an actual reassignment", async () => {
      const db = new Database(":memory:");
      try {
        runMigrations(db);
        const repository = new ObligationRepository(db, (id) => id === "t1" || id === "t2");
        repository.create({
          id: "linked-work",
          title: "Linked work",
          ownerId: "t1",
          externalRef: REF,
        });

        let firstOwner = "";
        let secondOwner = "";
        const woken = await wokenBy(
          repository,
          (mesh) => {
            firstOwner = mesh.spawn({ charter: "first owner", parentId: "root" });
            secondOwner = mesh.spawn({ charter: "second owner", parentId: "root" });
          },
          issue,
          (mesh) => {
            repository.reassign("linked-work", secondOwner);
            mesh.deliverEvent(issue, "event", { inboxPayload: payload("issues.edited") });
          }
        );

        expect(firstOwner).toBe("t1");
        expect(woken).toEqual([firstOwner, secondOwner]);
      } finally {
        db.close();
      }
    });

    it("routes the next event to the parent that inherited a retiring actor's obligation", async () => {
      const ownerByRef: Record<string, string> = {};
      let retiringOwner = "";
      let parent = "";
      const woken = await wokenBy(
        owning(ownerByRef),
        (mesh) => {
          parent = mesh.spawn({ charter: "parent", parentId: "root" });
          retiringOwner = mesh.spawn({ charter: "retiring obligation owner", parentId: parent });
          ownerByRef[REF] = retiringOwner;
        },
        issue,
        (mesh) => {
          // Mirrors inheritRetiringActorObligationsInternal(): the live claim
          // stays the same and its owner changes to the retiring actor's parent.
          ownerByRef[REF] = parent;
          mesh.deliverEvent(issue, "event", { inboxPayload: payload("issues.edited") });
        }
      );

      expect(woken).toEqual([retiringOwner, parent]);
    });

    it("wakes nobody when the obligation owner is the human operator", async () => {
      const woken = await wokenBy(
        owning({ [REF]: "human:operator" }),
        (mesh) => {
          const delegate = mesh.spawn({ charter: "stale delegate", parentId: "root" });
          mesh.subscribeEventSource(issue, delegate, "root");
        },
        issue
      );

      // No surrogate actor stands in for a human owner, and the earlier
      // subscriber must not remain authoritative. The walk stops rather than
      // bubbling; their attention belongs on the dashboard surface.
      expect(woken).toEqual([]);
    });

    it("does not revive a stale subscriber when the governing actor is absent", async () => {
      const woken = await wokenBy(
        owning({ [REF]: "retired-owner" }),
        (mesh) => {
          const delegate = mesh.spawn({ charter: "stale delegate", parentId: "root" });
          mesh.subscribeEventSource(issue, delegate, "root");
        },
        issue
      );

      // Ownership inheritance normally rewrites this id during retirement, but
      // routing must remain fail-closed if it observes an inconsistent instant.
      expect(woken).toEqual([]);
    });

    it("leaves repo-level sources to subscriptions even when an obligation claims the repo", async () => {
      // Repo-level obligations are valid identity claims, but #85 is an
      // identifier migration rather than an expansion of obligation-governed
      // routing. Only issue/PR events and their descendants are governed here.
      const repoResource = "github:MEK-Org/rusa";
      let steward = "";
      const woken = await wokenBy(
        owning({ "github:MEK-Org/rusa": "someone-else" }),
        (mesh) => {
          steward = mesh.spawn({ charter: "repo steward", parentId: "root" });
          mesh.subscribeEventSource(repoResource, steward, "root");
        },
        repoResource
      );

      expect(woken).toEqual([steward]);
    });
  });

  describe("retirement preflight is fail-closed on undisposed work (#191)", () => {
    const inFuture = (): string => new Date(Date.now() + 100_000).toISOString();

    /**
     * A mesh whose obligation store answers from a map the test fills after
     * spawning, since owner ids are only known once the actors exist.
     */
    function meshWithObligations(opts: Parameters<typeof setup>[0] = {}) {
      const owned = new Map<string, LiveObligationSummary[]>();
      const env = setup({
        ...opts,
        obligations: {
          findLiveByExternalRef: () => null,
          listLiveOwnedBy: (ownerId) => owned.get(ownerId) ?? [],
        },
      });
      return { ...env, owned };
    }

    it("refuses on a grandchild's live obligation and retires nothing in the subtree", () => {
      const { mesh, registry, owned } = meshWithObligations();
      const child = mesh.spawn({ charter: "child", parentId: "root" });
      const grandchild = mesh.spawn({ charter: "grandchild", parentId: child });
      owned.set(grandchild, [{ id: "ob-9", status: "ready", title: "answer the review" }]);

      expect(() => mesh.retire(child)).toThrow(RetirementBlockedError);
      try {
        mesh.retire(child);
      } catch (err) {
        const blocked = err as RetirementBlockedError;
        expect(blocked.blockers.obligations).toEqual([
          {
            obligationId: "ob-9",
            ownerId: grandchild,
            status: "ready",
            title: "answer the review",
          },
        ]);
        expect(blocked.message).toContain("ob-9");
        expect(blocked.message).toContain("answer the review");
        expect(blocked.message).toContain("Nothing was retired");
      }

      // The refusal is a preflight: the named thread AND its descendant are
      // untouched, so a blocker two levels down cannot leave a half-torn tree.
      expect(registry.get(child)?.status).toBe("active");
      expect(registry.get(grandchild)?.status).toBe("active");
      expect(mesh.get(child)).toBeDefined();
      expect(mesh.get(grandchild)).toBeDefined();
    });

    it("blocks on a message scheduled TO the subtree and leaves it pending", () => {
      const { mesh, registry, scheduledMessages } = meshWithObligations();
      const peer = mesh.spawn({ charter: "peer", parentId: "root" });
      const target = mesh.spawn({ charter: "target", parentId: "root" });
      mesh.sendMessage(target, "later", peer, undefined, inFuture());
      const messageId = scheduledMessages.listMessageDeliveries()[0].id;

      expect(() => mesh.retire(target)).toThrow(
        new RegExp(`${messageId} \\[incoming\\] ${peer} -> ${target}`)
      );
      expect(registry.get(target)?.status).toBe("active");
      // Refusing must not dispose of the thing it refused over.
      expect(scheduledMessages.listMessageDeliveries()).toHaveLength(1);
    });

    it("blocks on a message scheduled BY the subtree to an outside peer", () => {
      const { mesh, registry, scheduledMessages } = meshWithObligations();
      const peer = mesh.spawn({ charter: "peer", parentId: "root" });
      const target = mesh.spawn({ charter: "target", parentId: "root" });
      mesh.sendMessage(peer, "recheck the deploy", target, undefined, inFuture());
      const messageId = scheduledMessages.listMessageDeliveries()[0].id;

      expect(() => mesh.retire(target)).toThrow(
        new RegExp(`${messageId} \\[outgoing\\] ${target} -> ${peer}`)
      );
      expect(registry.get(target)?.status).toBe("active");
      expect(scheduledMessages.listMessageDeliveries()).toHaveLength(1);
    });

    it("reports a self-scheduled wake as internal to the subtree", () => {
      const { mesh } = meshWithObligations();
      const target = mesh.spawn({ charter: "target", parentId: "root" });
      mesh.sendMessage(target, "wake myself", target, undefined, inFuture());

      expect(mesh.retirementBlockers(target).messages).toMatchObject([
        { fromId: target, toId: target, direction: "internal" },
      ]);
    });

    it("refuses cancellation by an actor outside the message's ancestry", () => {
      const { mesh, scheduledMessages } = meshWithObligations();
      const peer = mesh.spawn({ charter: "peer", parentId: "root" });
      const target = mesh.spawn({ charter: "target", parentId: "root" });
      const stranger = mesh.spawn({ charter: "stranger", parentId: "root" });
      mesh.sendMessage(target, "later", peer, undefined, inFuture());
      const messageId = scheduledMessages.listMessageDeliveries()[0].id;

      expect(() => mesh.cancelScheduledMessage(messageId, stranger)).toThrow(
        /may only cancel scheduled messages/
      );
      expect(scheduledMessages.listMessageDeliveries()).toHaveLength(1);

      // ...and an id that is no longer pending is named as such rather than
      // silently succeeding.
      expect(() => mesh.cancelScheduledMessage("no-such-message", "root")).toThrow(
        /unknown pending message id/
      );
    });

    it("retires once the retirer has disposed of every blocker, recording who decided", () => {
      const events: Array<{ kind: string; actorId?: string; detail?: string; payload?: string }> =
        [];
      const { mesh, registry, scheduledMessages, owned } = meshWithObligations({
        events: (e) => events.push(e),
      });
      const parent = mesh.spawn({ charter: "parent", parentId: "root" });
      const worker = mesh.spawn({ charter: "worker", parentId: parent });
      const peer = mesh.spawn({ charter: "peer", parentId: "root" });
      mesh.sendMessage(worker, "inbound", peer, undefined, inFuture());
      mesh.sendMessage(peer, "outbound", worker, undefined, inFuture());
      owned.set(worker, [{ id: "ob-1", status: "waiting", title: null }]);

      const initial = mesh.retirementBlockers(worker);
      expect(initial.messages.map((m) => m.direction).sort()).toEqual(["incoming", "outgoing"]);
      expect(initial.obligations).toHaveLength(1);

      // The retirer cancels both directions on its ancestor authority.
      for (const message of initial.messages) {
        mesh.cancelScheduledMessage(message.messageId, parent, "worker is done");
      }
      expect(scheduledMessages.listMessageDeliveries()).toEqual([]);
      const cancellations = events.filter((e) => e.kind === "scheduled_message_cancelled");
      expect(cancellations).toHaveLength(2);
      expect(cancellations[0]).toMatchObject({
        actorId: parent,
        detail: initial.messages[0].messageId,
      });
      expect(JSON.parse(cancellations[0].payload ?? "{}")).toMatchObject({
        messageId: initial.messages[0].messageId,
        cancelledBy: parent,
        reason: "worker is done",
      });

      // Messages alone are not enough: the obligation still holds the door.
      expect(() => mesh.retire(worker)).toThrow(/ob-1/);
      expect(registry.get(worker)?.status).toBe("active");

      owned.set(worker, []);
      mesh.retire(worker);
      expect(registry.get(worker)?.status).toBe("retired");
    });

    it("refuses the operator's force too, and destroys nothing un-audited", () => {
      const events: Array<{ kind: string; actorId?: string; detail?: string }> = [];
      const { mesh, registry, owned, scheduledMessages } = meshWithObligations({
        events: (e) => events.push(e),
      });
      const worker = mesh.spawn({ charter: "worker", parentId: "root" });
      owned.set(worker, [{ id: "ob-2", status: "ready", title: "unfinished" }]);
      mesh.sendMessage(worker, "wake myself", worker, undefined, inFuture());

      // `force` answers "a run is in flight and I cannot wait for it". It was
      // never an answer to "someone's work is undisposed of", so it does not
      // buy past this boundary — and because nothing is destroyed here, there
      // is no destruction that escapes the cancellation audit either.
      expect(() => mesh.retire(worker, { force: true })).toThrow(RetirementBlockedError);
      expect(registry.get(worker)?.status).toBe("active");
      expect(scheduledMessages.listMessageDeliveries()).toHaveLength(1);
      expect(events.filter((e) => e.kind === "scheduled_message_cancelled")).toEqual([]);

      // The operator disposes of both blockers explicitly, and the message's
      // end is recorded with a decider's name on it.
      const [pending] = mesh.retirementBlockers(worker).messages;
      mesh.cancelScheduledMessage(pending.messageId, "root", "worker is wedged, wake is moot");
      owned.set(worker, []);
      mesh.retire(worker, { force: true });

      expect(registry.get(worker)?.status).toBe("retired");
      expect(events.filter((e) => e.kind === "scheduled_message_cancelled")).toMatchObject([
        { actorId: "root", detail: pending.messageId },
      ]);
    });

    it("blocks on work orphaned under an already-retired descendant", () => {
      const { mesh, registry, owned, scheduledMessages } = meshWithObligations();
      const parent = mesh.spawn({ charter: "parent", parentId: "root" });
      const child = mesh.spawn({ charter: "child", parentId: parent });
      const peer = mesh.spawn({ charter: "peer", parentId: "root" });
      mesh.retire(child);
      expect(registry.get(child)?.status).toBe("retired");

      // Rows a pre-#191 teardown could leave behind: an obligation and an
      // outgoing send whose owner is a `retired` record. Walking only active
      // children would skip exactly these, and the ancestor would then retire
      // straight over the orphans the preflight exists to catch.
      owned.set(child, [{ id: "ob-orphan", status: "ready", title: "left behind" }]);
      mesh.sendMessage(peer, "stale handoff", child, undefined, inFuture());
      const messageId = scheduledMessages.listMessageDeliveries()[0].id;

      const blockers = mesh.retirementBlockers(parent);
      expect(blockers.obligations).toMatchObject([{ obligationId: "ob-orphan", ownerId: child }]);
      expect(blockers.messages).toMatchObject([
        { messageId, fromId: child, toId: peer, direction: "outgoing" },
      ]);
      expect(() => mesh.retire(parent)).toThrow(RetirementBlockedError);
      expect(registry.get(parent)?.status).toBe("active");

      // The run guard keeps its own, narrower scope: a retired thread cannot
      // have a run in flight, so it stays out of that walk.
      expect(mesh.activeRunsInSubtree(parent)).toEqual([]);
    });
  });

  // NOTE(MEK-Org/rusa#169): "canonicalizes antigravity effort on spawn,
  // update, and restart" used to live here, exercising ActorMesh's own
  // parsing of legacy Codex/Antigravity model-pin syntax (e.g. "Gemini 3.7
  // Flash (High)") through scalar provider/model/effort fields on spawn and
  // setActorModel. ActorMesh no longer does that parsing itself — every
  // modelConfig entry is opaque to it unless a validateSpawn/validateModel
  // hook is wired in. The underlying canonicalization behavior
  // (normalizeModelEffortSelection / parseCodexModel) is covered directly in
  // src/providers/reasoning-effort.test.ts and src/providers/antigravity.test.ts,
  // and persistence of a canonicalized modelConfig across a restart is
  // covered in actor-mesh-restart-persistence.test.ts. Removed rather than
  // rewritten.
});
