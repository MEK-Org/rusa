import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import type { IssueClient } from "../gitops/issue-client.js";
import { resolveStampedAuthor, SYSTEM_TRACKER_HYGIENE } from "../mcp/stamp.js";
import { createTrackerMcpServer } from "../mcp/tracker-mcp.js";
import { FakeProvider } from "../providers/fake-provider.js";
import type { CodingProvider, RunResult } from "../providers/types.js";
import { Actor } from "./actor.js";
import type {
  ActorFactoryContext,
  ActorMeshOptions,
  EventDeliveryOptions,
  RetireCleanup,
  SpawnRequest,
} from "./actor-mesh.js";
import { ActorMesh } from "./actor-mesh.js";
import { RunStartCancelledError, type RunStartHandle } from "./concurrency-limiter.js";
import type { EventResource } from "./event-subscriptions.js";
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
import { InMemoryThreadRegistry } from "./thread-registry.js";
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
      senderId: string;
      recipientId: string;
      body: string;
      sessionId?: string;
    }) => string;
    idgen?: () => string;
    onYield?: (actorId: string, ctx: { notifyingParent: boolean }) => string | null | undefined;
    inboxStore?: InboxStore;
    onInboxEntriesSeen?: ActorMeshOptions["onInboxEntriesSeen"];
    grantableCapabilities?: ReadonlySet<string>;
    validateSpawn?: ActorMeshOptions["validateSpawn"];
    validateModel?: ActorMeshOptions["validateModel"];
    onModelSet?: ActorMeshOptions["onModelSet"];
    createActor?: ActorMeshOptions["createActor"];
    rootId?: string;
    obligations?: ActorMeshOptions["obligations"];
  } = {}
) {
  const registry = new InMemoryThreadRegistry();
  const providers = new Map<string, CodingProvider>();
  const logs: string[] = [];
  let seq = 0;
  let chatSeq = 0;

  const mesh = new ActorMesh({
    registry,
    rootId: opts.rootId ?? "root",
    validateSpawn: opts.validateSpawn,
    validateModel: opts.validateModel,
    onModelSet: opts.onModelSet,
    maxConcurrent: opts.maxConcurrent ?? 4,
    isHalted: opts.isHalted,
    isShuttingDown: opts.isShuttingDown,
    events: opts.events,
    recordChat: opts.recordChat ?? (() => `message-${++chatSeq}`),
    inboxStore: opts.inboxStore ?? createMemoryInboxStore(),
    obligations: opts.obligations,
    onInboxEntriesSeen: opts.onInboxEntriesSeen,
    grantableCapabilities: opts.grantableCapabilities,
    idgen: opts.idgen ?? (() => `t${++seq}`),
    onYield: opts.onYield,
    now: () => "2026-01-01T00:00:00Z",
    onRetire: opts.onRetire,
    onSpawn: opts.onSpawn,
    onRevive: opts.onRevive,
    retireCleanups: opts.retireCleanups,
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
        provider,
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
        onRunEnd: ctx.onRunEnd,
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
    provider: rootProvider,
    mcpServers: [],
    loadSessionId: () => registry.get(rootId)?.sessionId,
    saveSessionId: (id) => registry.patch(rootId, { sessionId: id }),
    buildPrompt: () => ({ prompt: "Work from your inbox." }),
    onQueued: (context) => mesh.actorQueued(rootId, context),
    onRunEnd: () => mesh.finishInboxRun(rootId),
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
      provider: "claude",
      model: "claude-sonnet-4-6",
      ...req,
    } as SpawnRequest);

  const tick = () => vi.advanceTimersByTimeAsync(DEBOUNCE + 1);
  const fake = (id: string) => providers.get(id) as FakeProvider;
  return { registry, mesh: testMesh, rawSpawn, providers, root, logs, tick, fake };
}

const payload = (type: string, merged?: boolean): InboxPayload =>
  ({ type, ...(merged !== undefined ? { merged } : {}) }) as unknown as InboxPayload;

describe("ActorMesh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passes the provider through the shared rate gate", async () => {
    const registry = new InMemoryThreadRegistry();
    const selected: string[] = [];
    let gate!: ActorFactoryContext["gate"];
    const mesh = new ActorMesh({
      registry,
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
          isRunning: false,
        };
      },
    });

    mesh.spawn({ charter: "worker", parentId: "root", provider: "codex", model: "gpt-5.6-sol" });
    await expect(gate(async () => 42, "codex", false).result).resolves.toBe(42);

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
    const registry = new InMemoryThreadRegistry();
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
      registry,
      idgen: () => "t3",
      now: () => "2026-01-01T00:00:00Z",
      log: (m) => logs.push(m),
      createActor: (ctx) => {
        if (ctx.record.id === "t1") {
          throw new Error("unresolvable provider mock error");
        }
        return new Actor({
          id: ctx.record.id,
          cwd: `/tmp/${ctx.record.id}`,
          provider: new FakeProvider(),
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
      mesh.spawn({ charter: "must not spawn", parentId: "root", provider: "codex", model: "bad" })
    ).toThrow("locally rejected model pin");
    expect(idAllocations).toBe(0);
    expect(registry.list().map((record) => record.id)).toEqual(["root"]);
  });

  it("refuses spawn when provider is missing or whitespace ", () => {
    const { rawSpawn } = setup();
    expect(() =>
      rawSpawn({ charter: "child", parentId: "root", provider: "", model: "claude-sonnet-4-6" })
    ).toThrow("provider is required");
    expect(() =>
      rawSpawn({ charter: "child", parentId: "root", provider: "   ", model: "claude-sonnet-4-6" })
    ).toThrow("provider is required");
    expect(() =>
      rawSpawn({
        charter: "child",
        parentId: "root",
        provider: undefined as unknown as string,
        model: "claude-sonnet-4-6",
      })
    ).toThrow("provider is required");
  });

  it("refuses spawn when model is missing or whitespace ", () => {
    const { rawSpawn } = setup();
    expect(() =>
      rawSpawn({ charter: "child", parentId: "root", provider: "claude", model: "" })
    ).toThrow("model is required");
    expect(() =>
      rawSpawn({ charter: "child", parentId: "root", provider: "claude", model: "   " })
    ).toThrow("model is required");
    expect(() =>
      rawSpawn({
        charter: "child",
        parentId: "root",
        provider: "claude",
        model: undefined as unknown as string,
      })
    ).toThrow("model is required");
  });

  it("records trimmed provider and model on thread record and event ", () => {
    const events: MeshEventInput[] = [];
    const { rawSpawn, registry } = setup({
      events: (e) => events.push(e),
    });
    const id = rawSpawn({
      charter: "custom worker",
      parentId: "root",
      provider: "  antigravity  ",
      model: "  Gemini 3.7 Flash (High)  ",
    });
    const record = registry.get(id);
    expect(record?.provider).toBe("antigravity");
    expect(record?.model).toBe("Gemini 3.7 Flash (High)");
    const spawnEvent = events.find((e) => e.kind === "actor_spawned" && e.actorId === id);
    expect(spawnEvent).toBeDefined();
    expect(spawnEvent?.body).toBe("provider=antigravity model=Gemini 3.7 Flash (High)");
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
    const resource = { kind: "github_repo" as const, repo: "dummy-org/dummy-repo" };
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
    mesh.subscribeEventSource({ kind: "system" }, "root", "root");

    await mesh.deliverEvent({ kind: "system" }, "disk low", {
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
        source: "system",
        payload: expect.objectContaining({
          type: "system.disk",
          priority: "responsive",
          volume: "/",
        }),
      }),
    ]);
    expect(fake("root").calls).toHaveLength(1);
  });

  it("mechanically notifies the parent when a parent-triggered run yields", async () => {
    const chat: { senderId: string; recipientId: string; body: string; sessionId?: string }[] = [];
    const inboxStore = createMemoryInboxStore();
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
      runId: id,
      actorId: id,
      status: "complete",
      fromId: id,
    });
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
        registry,
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
    const resource = { kind: "github_repo" as const, repo: "dummy-org/dummy-repo" };
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
    const resource = { kind: "github_repo" as const, repo: "dummy-org/dummy-repo" };
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
    const rootId = mesh.registry.get("root")?.id ?? "root";
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

  it("enforces the lease: stops running and retires when maxRuns is hit", async () => {
    const { mesh, registry, fake, tick } = setup();
    const id = mesh.spawn({ charter: "bounded work", parentId: "root", budget: { maxRuns: 2 } });
    mesh.sendMessage(id, "go", "root");
    await tick(); // run 1
    mesh.sendMessage(id, "again", "root");
    await tick(); // run 2
    mesh.sendMessage(id, "and again", "root");
    await tick(); // run 3 attempted → lease exhausted → retire, no run

    expect(fake(id).calls).toHaveLength(2);
    expect(registry.get(id)?.status).toBe("retired");
    expect(mesh.get(id)).toBeUndefined();
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
    const active = { kind: "github_repo" as const, repo: "dummy-org/dummy-repo" };
    const alreadyInactive = { kind: "github_repo" as const, repo: "dummy-org/old" };

    mesh.subscribeEventSource(active, actorId, "root");
    mesh.subscribeEventSource(alreadyInactive, actorId, "root");
    mesh.unsubscribeEventSource(alreadyInactive, actorId, "2025-12-31T00:00:00Z");

    mesh.retire(actorId);

    expect(
      mesh
        .listSubscriptions()
        .find(
          (s) =>
            s.actorId === actorId &&
            s.resource.kind === "github_repo" &&
            s.resource.repo === active.repo
        )?.unsubscribedAt
    ).toBe("2026-01-01T00:00:00Z");
    expect(
      mesh
        .listSubscriptions()
        .find(
          (s) =>
            s.actorId === actorId &&
            s.resource.kind === "github_repo" &&
            s.resource.repo === alreadyInactive.repo
        )?.unsubscribedAt
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
    const running = mesh.spawn({ charter: "running", parentId: "root", provider: "claude" });
    const blocked = mesh.spawn({ charter: "blocked", parentId: "root", provider: "codex" });
    const unaffected = mesh.spawn({
      charter: "unaffected",
      parentId: "root",
      provider: "claude",
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

  it("runningThreadIds excludes a halt/lease-gated wake (nothing actually executes)", async () => {
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
    const registry = new InMemoryThreadRegistry();
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
      registry,
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
    const registry = new InMemoryThreadRegistry();
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
      registry,
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
    const modelSets: Array<{ actorId: string; newModel: string }> = [];
    const { mesh, registry } = setup({
      events: (event) => events.push(event),
      onModelSet: (actorId, newModel) => modelSets.push({ actorId, newModel }),
      validateModel: (_record, newModel) => {
        if (newModel === "forbidden-model") throw new Error("forbidden model");
      },
    });
    const parent = mesh.spawn({ charter: "parent", parentId: "root", model: "claude-sonnet-5" });
    const child = mesh.spawn({ charter: "child", parentId: parent, model: "claude-sonnet-5" });
    const sibling = mesh.spawn({ charter: "sibling", parentId: "root" });

    // Parent can update child's model
    mesh.setActorModel(child, "claude-opus-4-8", parent);
    expect(registry.get(child)?.model).toBe("claude-opus-4-8");
    expect(modelSets).toEqual([{ actorId: child, newModel: "claude-opus-4-8" }]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "actor_model_set",
        actorId: child,

        detail: "claude-sonnet-5 -> claude-opus-4-8",
      })
    );

    // Root can update any child's model
    mesh.setActorModel(parent, "gemini-3.1-pro", "root");
    expect(registry.get(parent)?.model).toBe("gemini-3.1-pro");

    // An actor cannot set its own model (tier-raising guard)
    expect(() => mesh.setActorModel(child, "claude-opus-4-8", child)).toThrow(
      /cannot set its own model/
    );

    // Sibling cannot set model on another thread
    expect(() => mesh.setActorModel(child, "claude-opus-4-8", sibling)).toThrow(/not an ancestor/);

    // Refuses empty/whitespace model
    expect(() => mesh.setActorModel(child, "   ", parent)).toThrow(/empty model/);

    // Throws on unknown thread
    expect(() => mesh.setActorModel("non-existent", "claude-opus-4-8", "root")).toThrow(
      /unknown thread/
    );

    // Validation hook failure aborts before patching registry
    expect(() => mesh.setActorModel(child, "forbidden-model", parent)).toThrow(/forbidden model/);
    expect(registry.get(child)?.model).toBe("claude-opus-4-8");
  });

  it("setActorModel supports cross-provider moves for portable actors and rejects them for native actors", async () => {
    const events: MeshEventInput[] = [];
    const validations: Array<{ recordId: string; newModel: string; newProvider?: string }> = [];
    const { mesh, registry } = setup({
      events: (event) => events.push(event),
      validateModel: (record, newModel, newProvider) => {
        validations.push({ recordId: record.id, newModel, newProvider });
        if (newProvider === "antigravity" && newModel === "invalid-model") {
          throw new Error("invalid model for antigravity");
        }
      },
    });

    // 1. Portable ledger actor cross-provider move
    const ledgerChild = mesh.spawn({
      charter: "ledger child",
      parentId: "root",
      provider: "claude",
      model: "claude-opus-4-8",
      context: { type: "portable", mode: "ledger" },
    });
    mesh.setActorModel(ledgerChild, "gemini-3.7-flash-high", "root", "antigravity");
    expect(registry.get(ledgerChild)?.provider).toBe("antigravity");
    expect(registry.get(ledgerChild)?.model).toBe("gemini-3.7-flash-high");
    expect(validations).toContainEqual({
      recordId: ledgerChild,
      newModel: "gemini-3.7-flash-high",
      newProvider: "antigravity",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "actor_model_set",
        actorId: ledgerChild,
        detail: "claude:claude-opus-4-8 -> antigravity:gemini-3.7-flash-high",
      })
    );

    // 2. Portable tail actor cross-provider move
    const tailChild = mesh.spawn({
      charter: "tail child",
      parentId: "root",
      provider: "claude",
      model: "claude-sonnet-5",
      context: { type: "portable", mode: "tail" },
    });
    mesh.setActorModel(tailChild, "gpt-5.6-sol", "root", "codex");
    expect(registry.get(tailChild)?.provider).toBe("codex");
    expect(registry.get(tailChild)?.model).toBe("gpt-5.6-sol");

    // 3. Validation failure aborts cross-provider move
    expect(() => mesh.setActorModel(ledgerChild, "invalid-model", "root", "antigravity")).toThrow(
      /invalid model for antigravity/
    );
    expect(registry.get(ledgerChild)?.model).toBe("gemini-3.7-flash-high");

    // 4. Non-portable (native context) actor rejects provider move
    const nativeChild = mesh.spawn({
      charter: "native child",
      parentId: "root",
      provider: "claude",
      model: "claude-sonnet-5",
      context: { type: "native" },
    });
    expect(() =>
      mesh.setActorModel(nativeChild, "gemini-3.7-flash-high", "root", "antigravity")
    ).toThrow(/Cannot change provider on non-portable actor/);
    expect(registry.get(nativeChild)?.provider).toBe("claude");
    expect(registry.get(nativeChild)?.model).toBe("claude-sonnet-5");

    // 5. Default context (implicit native) rejects provider move
    const defaultContextChild = mesh.spawn({
      charter: "default child",
      parentId: "root",
      provider: "claude",
      model: "claude-sonnet-5",
    });
    expect(() =>
      mesh.setActorModel(defaultContextChild, "gemini-3.7-flash-high", "root", "antigravity")
    ).toThrow(/Cannot change provider on non-portable actor/);

    // 6. Native actor accepts model update when explicit provider equals existing provider
    mesh.setActorModel(nativeChild, "claude-opus-4-8", "root", "claude");
    expect(registry.get(nativeChild)?.provider).toBe("claude");
    expect(registry.get(nativeChild)?.model).toBe("claude-opus-4-8");

    // 7. Refuses model/provider changes while actor is running or queued
    const busyChild = mesh.spawn({
      charter: "busy child",
      parentId: "root",
      provider: "claude",
      model: "claude-opus-4-8",
      context: { type: "portable", mode: "ledger" },
    });
    const liveBusyActor = mesh.get(busyChild);
    if (liveBusyActor) {
      Object.defineProperty(liveBusyActor, "isRunning", { value: true, configurable: true });
    }
    expect(() =>
      mesh.setActorModel(busyChild, "gemini-3.7-flash-high", "root", "antigravity")
    ).toThrow(/Cannot change model or provider while actor .* is running or queued/);

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
    const dynamicMeshSetup = setup({
      sharedProvider: mockProviderA,
      isHalted: (p) => p === haltedProvider,
      onModelSet: (actorId, _newModel, record) => {
        const live = dynamicMeshSetup.mesh.get(actorId);
        if (live && record.provider === "provider-b") {
          live.setProvider?.(mockProviderB);
        }
      },
    });
    const movingWorker = dynamicMeshSetup.mesh.spawn({
      charter: "moving worker",
      parentId: "root",
      provider: "provider-a",
      model: "model-a",
      context: { type: "portable", mode: "ledger" },
    });
    // Move to provider-b
    dynamicMeshSetup.mesh.setActorModel(movingWorker, "model-b", "root", "provider-b");
    expect(dynamicMeshSetup.registry.get(movingWorker)?.provider).toBe("provider-b");

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
      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        actorId,
        "root"
      );
      expect(mesh.listSubscriptions()).toHaveLength(1);
      expect(mesh.listSubscriptions()[0]).toMatchObject({
        resource: { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        actorId,
        subscribedBy: "root",
      });

      expect(events).toHaveLength(3); // handle_granted, actor_spawned, event_source_subscribed
      expect(events[2]).toMatchObject({
        kind: "event_source_subscribed",
        actorId,
        detail: "github_repo:dummy-org/dummy-repo",
        payload: JSON.stringify({ subscribedBy: "root" }),
      });

      // Unsubscribe
      mesh.unsubscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        actorId,
        "2026-01-01T12:00:00Z"
      );
      expect(mesh.listSubscriptions()[0].unsubscribedAt).toBe("2026-01-01T12:00:00Z");

      expect(events).toHaveLength(4);
      expect(events[3]).toMatchObject({
        kind: "event_source_unsubscribed",
        actorId,
        detail: "github_repo:dummy-org/dummy-repo",
        body: "at=2026-01-01T12:00:00Z",
      });
    });

    it("enforces one active subscriber per resource and propagates throws", () => {
      const { mesh } = setup();
      const actor1 = mesh.spawn({ charter: "worker 1", parentId: "root" });
      const actor2 = mesh.spawn({ charter: "worker 2", parentId: "root" });

      const resource = { kind: "github_repo" as const, repo: "dummy-org/dummy-repo" };

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

      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        parent,
        "root"
      );
      mesh.delegateEventSource(
        { kind: "github_pr", repo: "dummy-org/dummy-repo", number: 616 },
        child,
        parent
      );

      expect(mesh.listSubscriptions()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actorId: parent,
            resource: { kind: "github_repo", repo: "dummy-org/dummy-repo" },
            subscribedBy: "root",
          }),
          expect.objectContaining({
            actorId: child,
            resource: { kind: "github_pr", repo: "dummy-org/dummy-repo", number: 616 },
            subscribedBy: parent,
          }),
        ])
      );

      mesh.deliverEvent(
        { kind: "github_pr", repo: "dummy-org/dummy-repo", number: 616 },
        "pr event",
        { inboxPayload: payload("pull_request.opened") }
      );
      mesh.deliverEvent({ kind: "github_repo", repo: "dummy-org/dummy-repo" }, "repo event", {
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

      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        parent,
        "root"
      );

      expect(() =>
        mesh.delegateEventSource(
          { kind: "github_pr", repo: "dummy-org/other", number: 1 },
          child,
          parent
        )
      ).toThrow(/current effective owner/);
      expect(() =>
        mesh.delegateEventSource({ kind: "github_org", org: "dummy-org" }, child, parent)
      ).toThrow(/current effective owner/);
    });

    it("hands off an exact resource the delegator itself holds", async () => {
      // Mechanical creator subscriptions  make this the common case: the
      // creator holds github_pr:<repo>#<n> exactly and delegates it onward.
      const { mesh, tick, fake } = setup();
      const parent = mesh.spawn({ charter: "pr creator", parentId: "root" });
      const child = mesh.spawn({ charter: "pr worker", parentId: parent });
      const pr = { kind: "github_pr" as const, repo: "dummy-org/dummy-repo", number: 616 };

      mesh.subscribeEventSource(pr, parent, parent);

      expect(() => mesh.delegateEventSource(pr, child, parent)).not.toThrow();

      const subs = mesh.listSubscriptions();
      expect(subs.find((s) => s.actorId === parent)?.unsubscribedAt).toBe("2026-01-01T00:00:00Z");
      expect(subs.find((s) => s.actorId === child)).toMatchObject({
        resource: pr,
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
      const pr = { kind: "github_pr" as const, repo: "dummy-org/dummy-repo", number: 616 };

      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        parent,
        "root"
      );

      expect(() => mesh.delegateEventSource(pr, sibling, parent)).not.toThrow();
      expect(
        mesh
          .listSubscriptions()
          .find((s) => s.actorId === sibling && s.resource.kind === "github_pr")?.subscribedBy
      ).toBe(parent);
    });

    it("lets an effective owner delegate to its parent", () => {
      const { mesh } = setup();
      const parent = mesh.spawn({ charter: "repo steward", parentId: "root" });
      const child = mesh.spawn({ charter: "child", parentId: parent });
      const pr = { kind: "github_pr" as const, repo: "dummy-org/dummy-repo", number: 616 };

      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        child,
        "root"
      );

      expect(() => mesh.delegateEventSource(pr, parent, child)).not.toThrow();
      expect(
        mesh
          .listSubscriptions()
          .find((s) => s.actorId === parent && s.resource.kind === "github_pr")?.subscribedBy
      ).toBe(child);
    });

    it("rejects reaching into a slice delegated away", () => {
      const { mesh } = setup();
      const repoOwner = mesh.spawn({ charter: "repo steward", parentId: "root" });
      const issueWorker = mesh.spawn({ charter: "issue worker", parentId: "root" });

      mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");
      mesh.delegateEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        repoOwner,
        "root"
      );

      expect(() =>
        mesh.delegateEventSource(
          { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 720 },
          issueWorker,
          "root"
        )
      ).toThrow(/current effective owner/);
    });

    it("preserves same-resource conflicts for delegated resources", () => {
      const { mesh } = setup();
      const parent = mesh.spawn({ charter: "repo steward", parentId: "root" });
      const child1 = mesh.spawn({ charter: "pr worker 1", parentId: parent });
      const child2 = mesh.spawn({ charter: "pr worker 2", parentId: parent });
      const pr = { kind: "github_pr" as const, repo: "dummy-org/dummy-repo", number: 616 };

      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        parent,
        "root"
      );
      mesh.delegateEventSource(pr, child1, parent);

      expect(() => mesh.delegateEventSource(pr, child2, parent)).toThrow(/current effective owner/);
    });

    it("lets root delegate a repo from its configured org source", async () => {
      const { mesh, tick, fake } = setup();
      const child = mesh.spawn({ charter: "repo steward", parentId: "root" });

      mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");
      mesh.delegateEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        child,
        "root"
      );

      mesh.deliverEvent({ kind: "github_repo", repo: "dummy-org/dummy-repo" }, "repo event", {
        inboxPayload: payload("push"),
      });
      mesh.deliverEvent({ kind: "github_repo", repo: "dummy-org/other" }, "other repo event", {
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

      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        parent,
        "root"
      );
      mesh.delegateEventSource(
        { kind: "github_pr", repo: "dummy-org/dummy-repo", number: 616 },
        child,
        parent
      );
      mesh.retire(child);

      mesh.deliverEvent(
        { kind: "github_pr", repo: "dummy-org/dummy-repo", number: 616 },
        "pr event",
        { inboxPayload: payload("pull_request.opened") }
      );
      await tick();

      expect(fake(child).calls).toHaveLength(0);
      expect(fake(parent).calls).toHaveLength(1);
      expect(fake(parent).calls[0]?.prompt).toContain("Work from your inbox");
    });

    it("lets a delegating parent reclaim a child-owned topic and receive its events again", async () => {
      const { mesh, tick, fake } = setup();
      const parent = mesh.spawn({ charter: "repo steward", parentId: "root" });
      const child = mesh.spawn({ charter: "pr worker", parentId: parent });
      const pr = { kind: "github_pr" as const, repo: "dummy-org/dummy-repo", number: 616 };

      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        parent,
        "root"
      );
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
        mesh.listSubscriptions().find((s) => s.actorId === child && s.resource.kind === "github_pr")
          ?.unsubscribedAt
      ).toBe("2026-01-01T00:00:00Z");
      expect(
        mesh
          .listSubscriptions()
          .find((s) => s.actorId === parent && s.resource.kind === "github_pr")?.subscribedBy
      ).toBe(parent);
    });

    it("rejects reclaim by a non-owner", () => {
      const { mesh } = setup();
      const parent = mesh.spawn({ charter: "repo steward", parentId: "root" });
      const child = mesh.spawn({ charter: "pr worker", parentId: parent });
      const sibling = mesh.spawn({ charter: "sibling", parentId: "root" });
      const pr = { kind: "github_pr" as const, repo: "dummy-org/dummy-repo", number: 616 };

      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        parent,
        "root"
      );
      mesh.delegateEventSource(pr, child, parent);

      expect(() => mesh.reclaimEventSource(pr, sibling)).toThrow(/effective owner after reclaim/);
    });

    it("an actor may self-delegate a strict descendant of a parent it effectively owns", () => {
      const { mesh } = setup();
      const actor = mesh.spawn({ charter: "repo steward", parentId: "root" });

      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        actor,
        "root"
      );

      // Actor owns the repo. It can self-delegate a branch.
      expect(() =>
        mesh.delegateEventSource(
          { kind: "github_branch", repo: "dummy-org/dummy-repo", ref: "staging" },
          actor,
          actor
        )
      ).not.toThrow();
    });

    it("an actor may not self-delegate an unrelated resource", () => {
      const { mesh } = setup();
      const actor = mesh.spawn({ charter: "steward", parentId: "root" });

      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        actor,
        "root"
      );

      // Cannot self-delegate an unrelated branch
      expect(() =>
        mesh.delegateEventSource(
          { kind: "github_branch", repo: "dummy-org/other-repo", ref: "staging" },
          actor,
          actor
        )
      ).toThrow(/strict descendant of an already-owned parent/);
    });

    it("holding only the exact resource is not sufficient", () => {
      const { mesh } = setup();
      const actor = mesh.spawn({ charter: "steward", parentId: "root" });
      const branch = {
        kind: "github_branch" as const,
        repo: "dummy-org/dummy-repo",
        ref: "staging",
      };

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
      const branch = {
        kind: "github_branch" as const,
        repo: "dummy-org/dummy-repo",
        ref: "staging",
      };

      // actor holds the repo (parent) AND holds the branch (exact)
      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        actor,
        "root"
      );
      mesh.subscribeEventSource(branch, actor, "root");

      // Can self-delegate the exact resource because they ALSO own the parent
      expect(() => mesh.delegateEventSource(branch, actor, actor)).not.toThrow();
    });

    it("routes repo events to the subscriber when live", async () => {
      const { mesh, tick, fake } = setup();
      const actorId = mesh.spawn({ charter: "worker", parentId: "root" });

      // Subscribe worker to the repo
      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        actorId,
        "root"
      );

      // Deliver event
      mesh.deliverEvent({ kind: "github_repo", repo: "dummy-org/dummy-repo" }, "suite completed", {
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
      mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");
      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        actorId,
        "root"
      );

      // Retire the worker (makes it not live)
      mesh.retire(actorId);

      // Deliver an allowlisted event. A non-allowlisted push would now stop at
      // the retired exact subscriber instead of waking the covering org owner.
      mesh.deliverEvent({ kind: "github_repo", repo: "dummy-org/dummy-repo" }, "suite completed", {
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

      mesh.subscribeEventSource(
        { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 123 },
        actorId,
        "root"
      );

      mesh.deliverEvent(
        { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 123 },
        "new comment",
        { inboxPayload: payload("issue_comment.created") }
      );
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
      const resource = { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 903 } as const;
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
          source: "github_issue:dummy-org/dummy-repo#903",
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
      const halted = mesh.spawn({ charter: "halted", parentId: "root", provider: "claude" });
      const available = mesh.spawn({ charter: "available", parentId: "root", provider: "agy" });
      const haltedResource = {
        kind: "github_issue",
        repo: "dummy-org/dummy-repo",
        number: 1288,
      } as const;
      const availableResource = {
        kind: "github_issue",
        repo: "dummy-org/dummy-repo",
        number: 1291,
      } as const;
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
      const resource = { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 903 } as const;
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
      const resource = { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 903 } as const;
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

      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        repoActorId,
        "root"
      );
      mesh.subscribeEventSource(
        { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 123 },
        issueActorId,
        "root"
      );

      // Retire issue subscriber so it is no longer live
      mesh.retire(issueActorId);

      mesh.deliverEvent(
        { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 123 },
        "new comment",
        { inboxPayload: payload("issue_comment.created") }
      );
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

      mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, orgActorId, "root");

      mesh.deliverEvent(
        { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 123 },
        "new comment",
        { inboxPayload: payload("issue_comment.created") }
      );
      await tick();

      // Org worker should be woken (bubbled up 2 levels)
      expect(fake(orgActorId).calls).toHaveLength(1);
      expect(fake(orgActorId).calls[0]?.prompt).toContain("Work from your inbox");
      // Root should not be woken
      expect(fake("root").calls).toHaveLength(0);
    });

    it("routes org-covered events with no more-specific subscriber to root", async () => {
      const { mesh, tick, fake } = setup();

      mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");
      mesh.deliverEvent(
        { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 123 },
        "new comment",
        { inboxPayload: payload("issues.opened") }
      );
      await tick();

      expect(fake("root").calls).toHaveLength(1);
      expect(fake("root").calls[0]?.prompt).toContain("Work from your inbox");
    });

    it("drops an event no subscription covers instead of waking root ", async () => {
      const { mesh, tick, fake } = setup();

      mesh.deliverEvent(
        { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 123 },
        "new comment",
        { inboxPayload: payload("issue_comment.created") }
      );
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
        const branch = {
          kind: "github_branch" as const,
          repo: "dummy-org/dummy-repo",
          ref: "refs/heads/staging",
        };

        mesh.subscribeEventSource(branch, branchOwner, "root");
        mesh.subscribeEventSource(
          { kind: "github_repo", repo: "dummy-org/dummy-repo" },
          repoOwner,
          "root"
        );

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
        const branch = {
          kind: "github_branch" as const,
          repo: "dummy-org/dummy-repo",
          ref: "refs/heads/worker",
        };
        mesh.subscribeEventSource(
          { kind: "github_repo", repo: "dummy-org/dummy-repo" },
          repoOwner,
          "root"
        );

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
        const branch = {
          kind: "github_branch" as const,
          repo: "dummy-org/dummy-repo",
          ref: "refs/heads/worker",
        };
        mesh.subscribeEventSource(
          { kind: "github_repo", repo: "dummy-org/dummy-repo" },
          repoOwner,
          "root"
        );

        await mesh.deliverEvent(branch, "suite complete", {
          inboxPayload: payload("check_suite.completed"),
        });
        await tick();

        expect(fake(repoOwner).calls).toHaveLength(1);
      });

      it("bubbles merged PR closure but not an unmerged closure", async () => {
        const { mesh, tick, fake } = setup();
        const repoOwner = mesh.spawn({ charter: "repo steward", parentId: "root" });
        const pr = { kind: "github_pr" as const, repo: "dummy-org/dummy-repo", number: 1022 };
        mesh.subscribeEventSource(
          { kind: "github_repo", repo: "dummy-org/dummy-repo" },
          repoOwner,
          "root"
        );

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
        const pr = { kind: "github_pr" as const, repo: "dummy-org/dummy-repo", number: 1022 };
        mesh.subscribeEventSource(
          { kind: "github_repo", repo: "dummy-org/dummy-repo" },
          repoOwner,
          "root"
        );

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
        mesh.subscribeEventSource({ kind: "chat" }, "root", "root");

        await mesh.deliverEvent({ kind: "chat_space", space: "spaces/new" }, "chat message", {
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

      mesh.deliverEvent(
        { kind: "github_issue", repo: "dummy-org/uncovered", number: 123 },
        "directed comment",
        {
          directedTarget: actorId,
          inboxPayload: payload("issue_comment.created"),
        }
      );
      await tick();

      expect(fake(actorId).calls).toHaveLength(1);
      expect(fake(actorId).calls[0]?.prompt).toContain("Work from your inbox");
      expect(fake("root").calls).toHaveLength(0);
    });

    it("directed-delivers to a live actor by handle", async () => {
      const actorId = "b4b43d69-5e63-4db2-b44b-35c031096aad";
      const { mesh, tick, fake } = setup({ idgen: () => actorId });
      expect(mesh.spawn({ charter: "cloudy worker", parentId: "root" })).toBe(actorId);

      mesh.deliverEvent(
        { kind: "github_issue", repo: "dummy-org/uncovered", number: 123 },
        "directed comment",
        {
          directedTarget: "cloudy-porpoise",
          inboxPayload: payload("issue_comment.created"),
        }
      );
      await tick();

      expect(fake(actorId).calls).toHaveLength(1);
      expect(fake(actorId).calls[0]?.prompt).toContain("Work from your inbox");
    });

    it("drops an invalid directive but not the event", async () => {
      const { mesh, tick, fake, logs } = setup();

      mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");
      mesh.deliverEvent(
        { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 123 },
        "normal fallback",
        { directedTarget: "not-live", inboxPayload: payload("issue_comment.created") }
      );
      await tick();

      expect(logs).toContain("mesh:deliver target not live: not-live — directive ignored");
      expect(fake("root").calls).toHaveLength(1);
      expect(fake("root").calls[0]?.prompt).toContain("Work from your inbox");
    });

    describe("an issue self-echo suppression with author stamps", () => {
      it("suppresses same-actor same-instance self-post", async () => {
        const { mesh, tick, fake, logs } = setup();
        mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");

        mesh.deliverEvent(
          { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 123 },
          "self-echo test",
          {
            stampedAuthor: { actorId: "root", instanceId: "staging-instance" },
            instanceId: "staging-instance",
            inboxPayload: payload("issue_comment.created"),
          }
        );
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
        mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");

        mesh.deliverEvent(
          { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 123 },
          "cross-instance test",
          {
            stampedAuthor: { actorId: "root", instanceId: "prod-instance" },
            instanceId: "staging-instance",
            inboxPayload: payload("issue_comment.created"),
          }
        );
        await tick();

        expect(fake("root").calls).toHaveLength(1);
        expect(fake("root").calls[0]?.prompt).toContain("Work from your inbox");
      });

      it("suppresses only matching destination in fanned multi-destination", async () => {
        const { mesh, tick, fake, logs } = setup();
        // biome-ignore lint/suspicious/noExplicitAny: test helper mock
        (mesh as any).eventSubscriptions.activeForResource = () => [
          {
            resource: { kind: "github_org", org: "dummy-org" },
            actorId: "root",
            subscribedBy: "root",
            subscribedAt: "2026-01-01T00:00:00Z",
          },
          {
            resource: { kind: "github_org", org: "dummy-org" },
            actorId: "t1",
            subscribedBy: "root",
            subscribedAt: "2026-01-01T00:00:00Z",
          },
        ];

        mesh.spawn({ charter: "t1-worker", parentId: "root" });

        mesh.deliverEvent(
          { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 123 },
          "fanned test",
          {
            stampedAuthor: { actorId: "t1", instanceId: "staging-instance" },
            instanceId: "staging-instance",
          }
        );
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
        mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");

        mesh.deliverEvent(
          { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 123 },
          "fail-open missing stamp",
          {
            stampedAuthor: null,
            instanceId: "staging-instance",
            inboxPayload: payload("issue_comment.created"),
          }
        );
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
        (mesh as any).eventSubscriptions.activeForResource = () =>
          ["root", "t1"].map((actorId) => ({
            resource: { kind: "github_org", org: "dummy-org" },
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

        mesh.deliverEvent({ kind: "github_issue", repo, number: issueNumber }, "peer reply", {
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
        (mesh as any).eventSubscriptions.activeForResource = () => [
          {
            resource: { kind: "github_org", org: "dummy-org" },
            actorId: "root",
            subscribedBy: "root",
            subscribedAt: "2026-01-01T00:00:00Z",
          },
          {
            resource: { kind: "github_org", org: "dummy-org" },
            actorId: "t1",
            subscribedBy: "root",
            subscribedAt: "2026-01-01T00:00:00Z",
          },
        ];
        mesh.spawn({ charter: "t1-worker", parentId: "root" });

        mesh.deliverEvent(
          { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 1048 },
          "hygiene comment echo",
          {
            stampedAuthor: { actorId: SYSTEM_TRACKER_HYGIENE, instanceId: "staging-instance" },
            instanceId: "staging-instance",
          }
        );
        await tick();

        // Neither "root" nor "t1" is the stamp's actorId, so an author-match
        // rule would have delivered to both — the system:* rule withholds
        // delivery from BOTH regardless.
        expect(fake("root").calls).toHaveLength(0);
        expect(fake("t1").calls).toHaveLength(0);
        expect(
          logs.some((l) =>
            l.includes(
              `system-event suppressed by author stamp: actor=${SYSTEM_TRACKER_HYGIENE} instance=staging-instance`
            )
          )
        ).toBe(true);
      });

      it("delivers when stampedAuthor is null even for a would-be system-shaped wake", async () => {
        const { mesh, tick, fake } = setup();
        mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");

        mesh.deliverEvent(
          { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 1048 },
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
        mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");

        mesh.deliverEvent(
          { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 1048 },
          "cross-instance system stamp",
          {
            stampedAuthor: { actorId: SYSTEM_TRACKER_HYGIENE, instanceId: "prod-instance" },
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

  describe("Scheduled messages ", () => {
    it("rejects immediate self-sends and sub-minimum delay self-sends", () => {
      const { mesh } = setup();
      const t1 = mesh.spawn({ charter: "t1", parentId: "root" });

      expect(() => mesh.sendMessage(t1, "hello", t1)).toThrow(/Immediate self-sends/);

      const tooSoon = new Date(Date.now() + 30000).toISOString();
      expect(() => mesh.sendMessage(t1, "hello", t1, undefined, tooSoon)).toThrow(
        /minimum 60s delay/
      );
    });

    it("rejects over-horizon deliver_at", () => {
      const { mesh } = setup();
      const t1 = mesh.spawn({ charter: "t1", parentId: "root" });
      const t2 = mesh.spawn({ charter: "t2", parentId: "root" });

      const tooLate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      expect(() => mesh.sendMessage(t1, "hello", t2, undefined, tooLate)).toThrow(
        /beyond max horizon/
      );
    });

    it("rejects scheduling if the recipient has reached the cap of 10 pending deliveries", () => {
      const { mesh } = setup();
      const t1 = mesh.spawn({ charter: "t1", parentId: "root" });
      const t2 = mesh.spawn({ charter: "t2", parentId: "root" });

      const future = new Date(Date.now() + 5000).toISOString();
      for (let i = 0; i < 10; i++) {
        mesh.sendMessage(t1, `msg ${i}`, t2, undefined, future);
      }

      expect(() => mesh.sendMessage(t1, "11th msg", t2, undefined, future)).toThrow(
        /cap of 10 pending deliveries/
      );
    });

    it("survives mesh restart and fires exactly-once (re-arms timers)", async () => {
      // Required test: Schedule a send, restart the mesh, assert it still fires.
      const { registry, mesh: mesh1 } = setup();
      const t1 = mesh1.spawn({ charter: "t1", parentId: "root" });
      const t2 = mesh1.spawn({ charter: "t2", parentId: "root" });

      const deliverAt = new Date(Date.now() + 100000).toISOString();
      mesh1.sendMessage(t1, "scheduled message", t2, undefined, deliverAt);

      // It is pending in the registry
      expect(registry.get(t1)?.pendingDeliveries).toHaveLength(1);
      expect(registry.get(t1)).not.toHaveProperty("messageClaims");

      // Restart the mesh (simulate restart by creating a new ActorMesh instance on the same registry)
      mesh1.shutdownAll();

      const { mesh: mesh2, fake } = setup();
      // Point mesh2 to the same registry
      Object.assign(mesh2, { registry });
      // Run boot sequence
      mesh2.rehydrateAll();
      mesh2.reconcilePendingDeliveries();
      mesh2.reconcileInbox();

      // Still pending
      expect(registry.get(t1)?.pendingDeliveries).toHaveLength(1);

      // Fast-forward time so timer fires and runner executes
      await vi.advanceTimersByTimeAsync(100000 + 30000);

      // It should have fired and woken the actor.
      expect(registry.get(t1)?.pendingDeliveries).toHaveLength(0);
      expect(fake(t1).calls).toHaveLength(1);
      expect(fake(t1).calls[0]?.prompt).toContain("Work from your inbox");
    });

    it("fires overdue deliveries at startup", async () => {
      const { registry, mesh: mesh1 } = setup();
      const t1 = mesh1.spawn({ charter: "t1", parentId: "root" });
      const t2 = mesh1.spawn({ charter: "t2", parentId: "root" });

      // Schedule it
      const deliverAt = new Date(Date.now() + 100000).toISOString();
      mesh1.sendMessage(t1, "overdue", t2, undefined, deliverAt);

      mesh1.shutdownAll();

      // Advance time while mesh is dead
      await vi.advanceTimersByTimeAsync(150000);

      const { mesh: mesh2, fake } = setup();
      Object.assign(mesh2, { registry });

      // Boot
      mesh2.rehydrateAll();
      mesh2.reconcilePendingDeliveries(); // Should queue setTimeout(0)
      mesh2.reconcileInbox();

      // Let setTimeout(0) and the runner execute
      await vi.advanceTimersByTimeAsync(30000);

      expect(registry.get(t1)?.pendingDeliveries).toHaveLength(0);
      expect(fake(t1).calls).toHaveLength(1);
      expect(fake(t1).calls[0]?.prompt).toContain("Work from your inbox");
    });

    it("notifies sender exactly once when recipient retires while holding pending deliveries", async () => {
      const inboxStore = createMemoryInboxStore();
      const { mesh, registry, fake, tick } = setup({ inboxStore });
      const sender = mesh.spawn({ charter: "sender", parentId: "root" });
      const recipient = mesh.spawn({ charter: "recipient", parentId: "root" });

      const deliverAt = new Date(Date.now() + 100000).toISOString();
      mesh.sendMessage(recipient, "long wait", sender, undefined, deliverAt);
      const pendingMessageId = registry.get(recipient)?.pendingDeliveries?.[0]?.id;

      expect(registry.get(recipient)?.pendingDeliveries).toHaveLength(1);

      // Retire the recipient before timers advance
      mesh.retire(recipient);
      await tick();

      // Assert sender receives exactly one drop notification
      const senderCalls = fake(sender).calls;
      expect(senderCalls).toHaveLength(1);
      expect(senderCalls[0]?.prompt).toContain("Work from your inbox");
      expect(inboxStore.entries).toEqual([
        expect.objectContaining({
          actorId: sender,
          source: "mesh:mechanical:system:mesh",
          payload: expect.objectContaining({
            type: "mesh.mechanical_note",
            note: expect.stringContaining("[scheduled message dropped]"),
            runId: recipient,
            actorId: recipient,
            originalFromId: sender,
            pendingMessageId,
            fromId: "system:mesh",
          }),
        }),
      ]);

      // Assert pendingDeliveries is empty on recipient
      expect(registry.get(recipient)?.pendingDeliveries ?? []).toEqual([]);

      // Advance past deliverAt and ensure NO duplicate notification is sent
      await vi.advanceTimersByTimeAsync(150000);
      expect(fake(sender).calls).toHaveLength(1);
    });

    it("notifies sender's parent when both sender and recipient retire while holding pending deliveries", async () => {
      const inboxStore = createMemoryInboxStore();
      const { mesh, fake, tick } = setup({ inboxStore });
      const parent = mesh.spawn({ charter: "parent", parentId: "root" });
      const sender = mesh.spawn({ charter: "sender", parentId: parent });
      const recipient = mesh.spawn({ charter: "recipient", parentId: "root" });

      const deliverAt = new Date(Date.now() + 100000).toISOString();
      mesh.sendMessage(recipient, "never arrive", sender, undefined, deliverAt);

      // Retire sender first
      mesh.retire(sender);
      await tick();

      // Then retire recipient
      mesh.retire(recipient);
      await tick();

      // Ensure sender's parent got the notification
      const parentCalls = fake(parent).calls;
      expect(parentCalls).toHaveLength(1);
      expect(parentCalls[0]?.prompt).toContain("Work from your inbox");
      expect(inboxStore.entries[0]).toMatchObject({
        actorId: parent,
        payload: expect.objectContaining({
          note: expect.stringContaining("[scheduled message dropped]"),
          originalFromId: sender,
          fromId: "system:mesh",
        }),
      });
    });

    // Retiring a subtree recurses into children *before* marking the ancestor
    // retired, so the sender still reads `status: "active"` while it is itself
    // being torn down. Notifying it posts into an actor that is about to be
    // closed and have its claims cleared — accepted, then destroyed.
    it("notifies the nearest live ancestor when the sender is an ancestor mid-retire", async () => {
      const inboxStore = createMemoryInboxStore();
      const { mesh, fake, tick } = setup({ inboxStore });
      const grandparent = mesh.spawn({ charter: "grandparent", parentId: "root" });
      const ancestor = mesh.spawn({ charter: "ancestor", parentId: grandparent });
      const recipient = mesh.spawn({ charter: "recipient", parentId: ancestor });

      const deliverAt = new Date(Date.now() + 100000).toISOString();
      mesh.sendMessage(recipient, "never arrive", ancestor, undefined, deliverAt);

      // Retiring the ancestor takes the recipient down with it. The drop
      // notification must not be handed to the ancestor, which is unwinding.
      mesh.retire(ancestor);
      await tick();

      expect(fake(ancestor).calls).toHaveLength(0);

      const gpCalls = fake(grandparent).calls;
      expect(gpCalls).toHaveLength(1);
      expect(gpCalls[0]?.prompt).toContain("Work from your inbox");
      expect(inboxStore.entries[0]).toMatchObject({
        actorId: grandparent,
        payload: expect.objectContaining({
          note: expect.stringContaining("[scheduled message dropped]"),
          originalFromId: ancestor,
          fromId: "system:mesh",
        }),
      });
    });
  });

  describe("retire cancels pending wakes & late wakes no-op ", () => {
    it("cancels an actor's own self-scheduled pending delivery when retired", async () => {
      const inboxStore = createMemoryInboxStore();
      const { mesh, registry, fake, tick } = setup({ inboxStore });
      const parent = mesh.spawn({ charter: "parent", parentId: "root" });
      const worker = mesh.spawn({ charter: "worker", parentId: parent });

      // Actor schedules a wake for itself 100s in the future
      const deliverAt = new Date(Date.now() + 100000).toISOString();
      const res = mesh.sendMessage(worker, "self follow-up wake", worker, undefined, deliverAt);
      expect(res.delivered).toBe(true);
      expect(registry.get(worker)?.pendingDeliveries).toHaveLength(1);

      // Retire the worker
      mesh.retire(worker);
      await tick();

      // Pending deliveries on retired worker should be cleared
      expect(registry.get(worker)?.pendingDeliveries ?? []).toEqual([]);
      expect(registry.get(worker)?.status).toBe("retired");

      // Advance time past the deliverAt timestamp
      await vi.advanceTimersByTimeAsync(150000);

      // Worker should NOT have run
      expect(fake(worker).calls).toHaveLength(0);
      // Parent should have received the dropped scheduled message notification
      expect(fake(parent).calls).toHaveLength(1);
      expect(inboxStore.entries).toContainEqual(
        expect.objectContaining({
          actorId: parent,
          payload: expect.objectContaining({
            note: expect.stringContaining("retired before delivery: self follow-up wake"),
            originalFromId: worker,
          }),
        })
      );
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

    it("late firePendingDelivery on retired actor drops cleanly without attempting execution", async () => {
      const inboxStore = createMemoryInboxStore();
      const { mesh, registry, fake, tick } = setup({ inboxStore });
      const parent = mesh.spawn({ charter: "parent", parentId: "root" });
      const worker = mesh.spawn({ charter: "worker", parentId: parent });

      const deliverAt = new Date(Date.now() + 100000).toISOString();
      mesh.sendMessage(worker, "late message", parent, undefined, deliverAt);
      const pendingId = registry.get(worker)?.pendingDeliveries?.[0]?.id ?? "";
      expect(pendingId).toBeTruthy();

      // Retire worker
      mesh.retire(worker);
      await tick();

      // Calling firePendingDelivery after retirement should drop cleanly
      (
        mesh as unknown as { firePendingDelivery: (toId: string, id: string) => void }
      ).firePendingDelivery(worker, pendingId);
      await tick();

      // Worker should not have run
      expect(fake(worker).calls).toHaveLength(0);
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
            provider,
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
      expect(mesh.registry.get(worker2)?.status).toBe("retired");

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
            provider,
            mcpServers: [],
            loadSessionId: () => undefined,
            saveSessionId: () => {},
            buildPrompt: () => ({ prompt: "prompt" }),
            gate: <T>(fn: () => Promise<T>, prov: string, resp: boolean): RunStartHandle<T> => {
              if (ctx.record.id === "t1") {
                let resolve!: (val: unknown) => void;
                let reject!: (err: unknown) => void;
                const result = new Promise<unknown>((res, rej) => {
                  resolve = res;
                  reject = rej;
                });
                runInvoke = async () => {
                  try {
                    const res = await fn();
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
              return ctx.gate(fn, prov, resp);
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
      expect(mesh.registry.get(worker)?.status).toBe("retired");

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

    const issue = { kind: "github_issue" as const, repo: "MEK-Org/rusa", number: 33 };
    const REF = "github:MEK-Org/rusa/issues/33";

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
      const pull = { kind: "github_pr" as const, repo: "MEK-Org/rusa", number: 33 };
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

    it("leaves a source the grammar cannot name entirely to subscriptions", async () => {
      // Only an issue or PR can be an obligation's identity, so a repo-level
      // source has no reference to match and routes as it always did.
      const repoResource = { kind: "github_repo" as const, repo: "MEK-Org/rusa" };
      let steward = "";
      const woken = await wokenBy(
        owning({ [REF]: "someone-else" }),
        (mesh) => {
          steward = mesh.spawn({ charter: "repo steward", parentId: "root" });
          mesh.subscribeEventSource(repoResource, steward, "root");
        },
        repoResource
      );

      expect(woken).toEqual([steward]);
    });
  });
});
