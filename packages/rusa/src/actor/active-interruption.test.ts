import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import { FakeProvider } from "../providers/fake-provider.js";
import type { CodingProvider, RunResult } from "../providers/types.js";
import { createHarness, waitUntil } from "../remote-instances/harness.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import { Actor } from "./actor.js";
import { ActorMesh, type ActorMeshOptions, type SpawnRequest } from "./actor-mesh.js";
import { InMemoryCapabilityGrantStore } from "./capability-grants.js";
import {
  InMemoryEventSourceOwnerStore,
  InMemoryEventSourceSubscriptionStore,
} from "./event-subscriptions.js";
import type { MeshEventInput } from "./mesh-events.js";
import {
  type JevDecisionRequest,
  type JevDecisionResponse,
  JevInputUnavailableError,
  ShadowResponsiveInterruptionClassifier,
} from "./responsive-interruption.js";

const TEST_USER_ID = "usr_test_operator";

function createTestInbox(): SqliteInboxRepository {
  const db = new Database(":memory:");
  runMigrations(db);
  return new SqliteInboxRepository(db);
}

const defaultTestSecretsDir = mkdtempSync(join(tmpdir(), "rusa-active-interruption-secrets-"));
writeFileSync(join(defaultTestSecretsDir, "gemini-api-key"), "test-gemini-key");

afterAll(() => {
  rmSync(defaultTestSecretsDir, { recursive: true, force: true });
});

function setup(opts: {
  responsiveInterruption?: ShadowResponsiveInterruptionClassifier;
  responsiveInterruptionMode?: "shadow" | "active";
  sharedProvider?: CodingProvider;
  inboxStore?: SqliteInboxRepository;
  events?: MeshEventInput[];
}) {
  const registry = new InMemoryActorRepository();
  const inboxStore = opts.inboxStore ?? createTestInbox();
  const eventSourceOwners = new InMemoryEventSourceOwnerStore();
  const eventSourceSubscriptions = new InMemoryEventSourceSubscriptionStore();
  const capabilityGrants = new InMemoryCapabilityGrantStore();
  const events = opts.events ?? [];
  let seq = 0;

  const mesh = new ActorMesh({
    actors: registry,
    principals: {
      getUser: (id: string) =>
        id === TEST_USER_ID
          ? {
              id,
              kind: "user" as const,
              email: "local@example.test",
              createdAt: "2026-01-01T00:00:00Z",
            }
          : undefined,
    } as unknown as ActorMeshOptions["principals"],
    rootId: "root",
    capabilityGrants,
    maxConcurrent: 2,
    inboxStore,
    eventSourceOwners,
    eventSourceSubscriptions,
    events: (e) => events.push(e),
    secretsDir: defaultTestSecretsDir,
    idgen: () => `t${++seq}`,
    recordChat: (chat) => chat.id ?? `msg-${++seq}`,
    responsiveInterruption: opts.responsiveInterruption,
    responsiveInterruptionMode: opts.responsiveInterruptionMode,
    createActor: (ctx) => {
      const provider = opts.sharedProvider ?? new FakeProvider(() => Promise.resolve({}));
      return new Actor({
        id: ctx.record.id,
        cwd: `/tmp/${ctx.record.id}`,
        modelConfig: [{ provider: provider.providerName }],
        resolveProvider: () => provider,
        mcpServers: [],
        loadSessionId: () => ctx.getRecord()?.sessionId,
        saveSessionId: (id) => registry.patch(ctx.record.id, { sessionId: id }),
        buildPrompt: () => ({ prompt: "test" }),
        gate: ctx.gate,
        beforeRun: ctx.beforeRun,
        admitRun: ctx.admitRun,
        lifecycle: ctx.lifecycle,
        onQueuedRunCancelled: ctx.onQueuedRunCancelled,
        onRuntimeStateChanged: ctx.onRuntimeStateChanged,
        debounceMs: 0,
      });
    },
  });

  const rawSpawn = mesh.spawn.bind(mesh);
  const testMesh = mesh as unknown as ActorMesh & {
    spawn: (req: Partial<SpawnRequest> & { charter: string; parentId: string }) => string;
  };
  testMesh.spawn = (req: Partial<SpawnRequest> & { charter: string; parentId: string }) =>
    rawSpawn({
      modelConfig: { provider: "fake", model: "fake-model" },
      ...req,
    } as SpawnRequest);

  const tick = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  };

  return { mesh: testMesh, inboxStore, events, tick };
}

type Decide = (request: JevDecisionRequest) => Promise<JevDecisionResponse>;

/**
 * A worker whose run hangs, with one task appended and, unless `select` is
 * false, selected in that run: the state every active-mode decision starts from.
 */
async function hungWorker(
  decide: Decide,
  /** `mode: "default"` omits the mesh option, so the mesh picks its own default. */
  opts: { select?: boolean; timeoutMs?: number; mode?: "active" | "default" } = {}
) {
  let signal: AbortSignal | undefined;
  let decideCalls = 0;
  const provider = new FakeProvider((run) => {
    signal = run.signal;
    return new Promise<Partial<RunResult>>(() => {});
  });
  const classifier = new ShadowResponsiveInterruptionClassifier({
    threshold: 0.5,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    client: {
      decide: (request) => {
        decideCalls++;
        return decide(request);
      },
    },
  });
  const t = setup({
    sharedProvider: provider,
    responsiveInterruption: classifier,
    ...(opts.mode === "default" ? {} : { responsiveInterruptionMode: "active" as const }),
  });
  const worker = t.mesh.spawn({ charter: "worker", parentId: "root" });
  const [entry] = t.inboxStore.append([
    { actorId: worker, source: "test", payload: { type: "task" } },
  ]);
  t.mesh.dispatch(worker);
  await t.tick();
  if (opts.select !== false) t.mesh.selectInboxEntries(worker, [entry.id]);
  return {
    ...t,
    worker,
    entry,
    aborted: () => signal?.aborted,
    decideCalls: () => decideCalls,
  };
}

const queue: Decide = async () => ({ interruptProbability: 0.1 });

describe("Active JEV Responsive Interruption Policy (#533)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("defaults to shadow: never suppresses preemption and records detail: shadow", async () => {
    // A below-threshold decision would queue in active mode.
    const t = await hungWorker(queue, { mode: "default" });
    expect(t.aborted()).toBe(false);
    t.mesh.sendMessage(t.worker, "operator responsive", TEST_USER_ID, "s1");
    await t.tick();

    expect(t.aborted()).toBe(true);
    const shadow = t.events.filter((e) => e.kind === "responsive_interruption_shadow");
    expect(shadow.length).toBeGreaterThanOrEqual(1);
    expect(shadow[0].detail).toBe("shadow");
  });

  describe("Active Mode Eligibility", () => {
    it("suppresses preemption for running actor with live unhandled selection when JEV decides queue", async () => {
      const t = await hungWorker(queue);
      expect(t.mesh.selectedInboxEntries(t.worker)).toEqual([t.entry.id]);

      t.mesh.sendMessage(t.worker, "operator responsive message", TEST_USER_ID, "s1");
      await t.tick();

      expect(t.decideCalls()).toBe(1);
      expect(t.aborted()).toBe(false);
      const audit = t.events.find(
        (e) => e.kind === "responsive_interruption_shadow" && e.actorId === t.worker
      );
      expect(audit?.detail).toBe("active");
      expect(JSON.parse(audit?.payload ?? "{}").decision.outcome).toBe("queue");
    });

    it("does not call JEV for idle actor", async () => {
      let decideCalled = false;
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        client: {
          decide: async () => {
            decideCalled = true;
            return { interruptProbability: 0.1 };
          },
        },
      });
      const { mesh, tick } = setup({
        responsiveInterruption: classifier,
        responsiveInterruptionMode: "active",
      });
      const worker = mesh.spawn({ charter: "worker", parentId: "root" });
      expect(mesh.runningThreadIds().has(worker)).toBe(false);

      mesh.sendMessage(worker, "hello idle", TEST_USER_ID, "s1");
      await tick();

      expect(decideCalled).toBe(false);
    });

    it("does not call JEV and interrupts immediately when running actor has NO selection", async () => {
      const t = await hungWorker(queue, { select: false });
      expect(t.mesh.selectedInboxEntries(t.worker)).toEqual([]);

      t.mesh.sendMessage(t.worker, "operator message", TEST_USER_ID, "s1");
      await t.tick();

      expect(t.decideCalls()).toBe(0);
      expect(t.aborted()).toBe(true);
    });

    it("does not call JEV and interrupts immediately when selected work is already handled", async () => {
      const t = await hungWorker(queue);
      t.inboxStore.markHandled(t.worker, [t.entry.id]);

      t.mesh.sendMessage(t.worker, "operator message", TEST_USER_ID, "s1");
      await t.tick();

      expect(t.decideCalls()).toBe(0);
      expect(t.aborted()).toBe(true);
    });

    it("does not call JEV and interrupts immediately for operator.run_now", async () => {
      const t = await hungWorker(queue);
      t.inboxStore.append([
        {
          actorId: t.worker,
          source: "operator:control",
          payload: { type: "operator.run_now", priority: "responsive" },
        },
      ]);
      t.mesh.dispatch(t.worker);
      await t.tick();

      expect(t.decideCalls()).toBe(0);
      expect(t.aborted()).toBe(true);
    });
  });

  describe("Deadline & Late Responses", () => {
    it("preempts running actor when JEV decision deadline expires", async () => {
      const t = await hungWorker(() => new Promise(() => {}), { timeoutMs: 50 });
      t.mesh.sendMessage(t.worker, "operator message", TEST_USER_ID, "s1");
      await t.tick();
      // Held while waiting for the deadline.
      expect(t.aborted()).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 80));
      await t.tick();

      expect(t.aborted()).toBe(true);
    });

    it("ignores late JEV response after run finishes without preempting subsequent run", async () => {
      let runCount = 0;
      const signals: AbortSignal[] = [];
      let resolveFirstRun!: (r: Partial<RunResult>) => void;
      const provider = new FakeProvider((opts) => {
        runCount++;
        if (opts.signal) signals.push(opts.signal);
        if (runCount === 1) {
          return new Promise<Partial<RunResult>>((resolve) => {
            resolveFirstRun = resolve;
          });
        }
        return new Promise<Partial<RunResult>>(() => {});
      });
      let resolveJev!: (res: JevDecisionResponse) => void;
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        client: {
          decide: () =>
            new Promise<JevDecisionResponse>((resolve) => {
              resolveJev = resolve;
            }),
        },
      });
      const { mesh, inboxStore, events, tick } = setup({
        sharedProvider: provider,
        responsiveInterruption: classifier,
        responsiveInterruptionMode: "active",
      });
      const worker = mesh.spawn({ charter: "worker", parentId: "root" });
      const [entry] = inboxStore.append([
        { actorId: worker, source: "test", payload: { type: "task" } },
      ]);
      mesh.dispatch(worker);
      await tick();
      mesh.selectInboxEntries(worker, [entry.id]);
      expect(runCount).toBe(1);

      mesh.sendMessage(worker, "operator message", TEST_USER_ID, "s1");
      await tick();

      // Run 1 finishes before the decision resolves.
      mesh.finishInboxRun(worker, { successful: true });
      resolveFirstRun({});
      await tick();
      expect(runCount).toBe(2);
      expect(signals[1].aborted).toBe(false);

      resolveJev({ interruptProbability: 0.9 });
      await tick();

      expect(signals[1].aborted).toBe(false);
      const audit = events.find((e) => e.kind === "responsive_interruption_shadow");
      expect(audit?.detail).toBe("active");
    });
  });

  describe("Batch Arrivals & Replay Deduplication", () => {
    it("any interrupting batchrow wins when multiple rows arrive concurrently", async () => {
      let first: { id: string } | undefined;
      const t = await hungWorker(async (req) => ({
        interruptProbability: first && req.input.incomingEntryId === first.id ? 0.1 : 0.9,
      }));
      const batch = t.inboxStore.append([
        { actorId: t.worker, source: "test", payload: { type: "task", priority: "responsive" } },
        { actorId: t.worker, source: "test", payload: { type: "task", priority: "responsive" } },
      ]);
      first = batch[0];
      t.mesh.dispatch(t.worker);
      await t.tick();

      expect(t.aborted()).toBe(true);
    });

    it("later dispatches while an arrival is held do not re-call JEV or bypass suppression", async () => {
      const t = await hungWorker(queue);
      t.mesh.sendMessage(t.worker, "operator message", TEST_USER_ID, "s1");
      await t.tick();
      expect(t.decideCalls()).toBe(1);
      expect(t.aborted()).toBe(false);

      // Redundant pokes for the same unseen arrival, then an ordinary row: each
      // dispatch still sees the held arrival as unseen responsive work.
      t.mesh.dispatch(t.worker);
      t.mesh.dispatch(t.worker);
      t.inboxStore.append([{ actorId: t.worker, source: "test", payload: { type: "task" } }]);
      t.mesh.dispatch(t.worker);
      await t.tick();

      expect(t.decideCalls()).toBe(1);
      expect(t.aborted()).toBe(false);
    });
  });

  describe("Follower Instance Active Policy", () => {
    it("suppresses follower remote preemption when active JEV decides queue", async () => {
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        client: { decide: queue },
      });
      const h = createHarness({
        cwd: "/tmp",
        delayMs: 300,
        responsiveInterruption: classifier,
        responsiveInterruptionMode: "active",
      });
      const id = h.spawn("follower worker");
      h.dispatchNormal(id);
      await waitUntil(() => h.mesh.runningThreadIds().has(id));
      const entries = h.inboxStore.list(id).entries;
      expect(entries.length).toBeGreaterThan(0);
      h.mesh.selectInboxEntries(id, [entries[0].id]);

      h.dispatchResponsive(id);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(h.logs.some((l) => l.event === "remote_preempt_requested")).toBe(false);
      expect(h.meshEvents.some((e) => e.kind === "run_preempted" && e.actorId === id)).toBe(false);
      await h.close();
    });

    it("preempts a follower run on a late interrupt decision and re-runs with the arrival", async () => {
      const decisions: Array<(response: JevDecisionResponse) => void> = [];
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        client: { decide: () => new Promise((resolve) => decisions.push(resolve)) },
      });
      const h = createHarness({
        cwd: "/tmp",
        delayMs: 1000,
        responsiveInterruption: classifier,
        responsiveInterruptionMode: "active",
      });
      const id = h.spawn("follower worker");
      h.dispatchNormal(id);
      await waitUntil(() => h.mesh.runningThreadIds().has(id));
      const entries = h.inboxStore.list(id).entries;
      expect(entries.length).toBeGreaterThan(0);
      h.mesh.selectInboxEntries(id, [entries[0].id]);

      h.dispatchResponsive(id);
      await waitUntil(() => decisions.length > 0);
      // Let the arrival's own wake reach the follower first, so the decision is
      // late: the follower drops that coalesced follow-up when it preempts, and
      // the leader must re-request the replacement run or the arrival stays unseen.
      await new Promise((resolve) => setTimeout(resolve, 100));
      decisions[0]?.({ interruptProbability: 0.8 });
      await waitUntil(() => h.logs.some((l) => l.event === "remote_preempt_requested"));
      await waitUntil(
        () =>
          h.inboxStore
            .list(id)
            .entries.some((e) => e.payload.type === "test.responsive" && e.seenAt !== null),
        5000
      );
      await h.close();
    });
  });
});

describe("Active JEV late interrupt keeps the replacement run (#533)", () => {
  async function lateInterrupt(decide: Decide, reselect = false) {
    const signals: AbortSignal[] = [];
    const provider = new FakeProvider((opts) => {
      const signal = opts.signal;
      if (signal) signals.push(signal);
      return new Promise<Partial<RunResult>>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const classifier = new ShadowResponsiveInterruptionClassifier({
      threshold: 0.5,
      client: { decide },
    });
    const { mesh, inboxStore, events, tick } = setup({
      sharedProvider: provider,
      responsiveInterruption: classifier,
      responsiveInterruptionMode: "active",
    });
    const worker = mesh.spawn({ charter: "worker", parentId: "root" });
    const [entry] = inboxStore.append([
      { actorId: worker, source: "test", payload: { type: "task" } },
    ]);
    mesh.dispatch(worker);
    await tick();
    mesh.selectInboxEntries(worker, [entry.id]);
    mesh.sendMessage(worker, "urgent", TEST_USER_ID, "s1");
    await tick();
    if (reselect) {
      mesh.selectInboxEntries(worker, [entry.id]);
      await tick();
    }
    await waitUntil(() => signals.length >= 2, 3000);
    const unseen = inboxStore.list(worker).entries.filter((e) => !e.seenAt && !e.handledAt);
    const audit = events.find((e) => e.kind === "responsive_interruption_shadow");
    return { signals, unseen, events, worker, audit: JSON.parse(audit?.payload ?? "{}") };
  }

  it.each<[string, Decide]>([
    [">= threshold decision", async () => ({ interruptProbability: 0.75 })],
    [
      "client error fallback",
      async () => {
        throw new Error("HTTP 500 internal error");
      },
    ],
    [
      "input unavailable fallback",
      async () => {
        throw new JevInputUnavailableError();
      },
    ],
    ["invalid probability fallback", async () => ({ interruptProbability: Number.NaN })],
  ])("preempts and re-runs with the arrival after a %s", async (_case, decide) => {
    const { signals, unseen, events, worker, audit } = await lateInterrupt(decide);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals).toHaveLength(2);
    expect(unseen).toHaveLength(0);
    expect(events.some((e) => e.kind === "run_preempted" && e.actorId === worker)).toBe(true);
    expect(audit.decision.outcome).toBe("interrupt");
    expect(audit.applied).toBe(true);
  });

  it("re-runs with the queued arrival when ABA reselection invalidates suppression", async () => {
    const { signals, unseen } = await lateInterrupt(queue, true);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals).toHaveLength(2);
    expect(unseen).toHaveLength(0);
  });
});

describe("Active JEV invalidation preempts only for remaining responsive work (#533)", () => {
  async function running() {
    const decisions: Array<(response: JevDecisionResponse) => void> = [];
    const runs: Array<{ signal: AbortSignal; settle: () => void }> = [];
    const provider = new FakeProvider((opts) => {
      const signal = opts.signal ?? new AbortController().signal;
      return new Promise<Partial<RunResult>>((resolve, reject) => {
        runs.push({ signal, settle: () => resolve({}) });
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const classifier = new ShadowResponsiveInterruptionClassifier({
      threshold: 0.5,
      client: {
        decide: () => new Promise<JevDecisionResponse>((resolve) => decisions.push(resolve)),
      },
    });
    const { mesh, inboxStore, tick } = setup({
      sharedProvider: provider,
      responsiveInterruption: classifier,
      responsiveInterruptionMode: "active",
    });
    const worker = mesh.spawn({ charter: "worker", parentId: "root" });
    const [a, b] = inboxStore.append([
      { actorId: worker, source: "test", payload: { type: "task", id: "a" } },
      { actorId: worker, source: "test", payload: { type: "task", id: "b" } },
    ]);
    mesh.dispatch(worker);
    await tick();
    const known = new Set([a.id, b.id]);
    const arrive = async (text: string) => {
      mesh.sendMessage(worker, text, TEST_USER_ID, "s1");
      await tick();
      const arrival = inboxStore.list(worker).entries.find((e) => !known.has(e.id));
      if (!arrival) throw new Error("arrival not appended");
      known.add(arrival.id);
      return arrival.id;
    };
    const entry = (id: string) => inboxStore.list(worker).entries.find((e) => e.id === id);
    return { mesh, inboxStore, tick, worker, a: a.id, b: b.id, arrive, entry, decisions, runs };
  }

  it("does not preempt when the queued arrival was handled before the selection changed", async () => {
    const t = await running();
    t.mesh.selectInboxEntries(t.worker, [t.a]);
    const arrival = await t.arrive("low priority");
    t.decisions.shift()?.({ interruptProbability: 0.1 });
    await t.tick();
    expect(t.mesh.isPreemptionSuppressed(t.worker)).toBe(true);

    t.inboxStore.markHandled(t.worker, [arrival]);
    t.mesh.selectInboxEntries(t.worker, [t.b]);
    await t.tick();

    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]?.signal.aborted).toBe(false);
    expect(t.mesh.isPreemptionSuppressed(t.worker)).toBe(false);
    t.runs[0]?.settle();
  });

  it("does not preempt when the run selects the arrival it was holding", async () => {
    const t = await running();
    t.mesh.selectInboxEntries(t.worker, [t.a]);
    const arrival = await t.arrive("low priority");
    t.decisions.shift()?.({ interruptProbability: 0.1 });
    await t.tick();

    t.mesh.selectInboxEntries(t.worker, [t.a, arrival]);
    await t.tick();

    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]?.signal.aborted).toBe(false);
    t.runs[0]?.settle();
  });

  it("lets the turn finish once the whole selection is handled; the queued arrival runs next", async () => {
    const t = await running();
    t.mesh.selectInboxEntries(t.worker, [t.a, t.b]);
    const arrival = await t.arrive("low priority");
    t.decisions.shift()?.({ interruptProbability: 0.1 });
    await t.tick();

    t.inboxStore.markHandled(t.worker, [t.a]);
    t.inboxStore.markHandled(t.worker, [t.b]);
    // Tail steps after the last mark_handled, such as a new ordinary row
    // arriving, must not cancel the turn either.
    t.inboxStore.append([{ actorId: t.worker, source: "test", payload: { type: "task" } }]);
    t.mesh.dispatch(t.worker);
    await t.tick();
    expect(t.runs[0]?.signal.aborted).toBe(false);
    expect(t.mesh.isPreemptionSuppressed(t.worker)).toBe(true);

    t.runs[0]?.settle();
    await waitUntil(() => t.runs.length >= 2, 3000);
    expect(t.runs).toHaveLength(2);
    expect(t.entry(arrival)?.seenAt).toBeTruthy();
    t.runs[1]?.settle();
  });

  it("interrupts when the selection is handled before the decision arrives", async () => {
    const t = await running();
    t.mesh.selectInboxEntries(t.worker, [t.a]);
    const arrival = await t.arrive("undecided");

    t.inboxStore.markHandled(t.worker, [t.a]);
    await waitUntil(() => t.runs.length >= 2, 3000);
    expect(t.runs[0]?.signal.aborted).toBe(true);
    expect(t.runs).toHaveLength(2);
    expect(t.entry(arrival)?.seenAt).toBeTruthy();
    expect(t.mesh.isPreemptionSuppressed(t.worker)).toBe(false);
    t.runs[1]?.settle();
  });

  it("ignores a decision from an earlier A selection after A -> B -> A", async () => {
    const t = await running();
    t.mesh.selectInboxEntries(t.worker, [t.a]);
    const first = await t.arrive("first");
    const staleDecision = t.decisions.shift();
    t.inboxStore.markHandled(t.worker, [first]);
    t.mesh.selectInboxEntries(t.worker, [t.b]);
    t.mesh.selectInboxEntries(t.worker, [t.a]);
    const second = await t.arrive("second");
    const currentDecision = t.decisions.shift();

    staleDecision?.({ interruptProbability: 0.9 });
    await t.tick();
    expect(t.runs[0]?.signal.aborted).toBe(false);

    currentDecision?.({ interruptProbability: 0.1 });
    await t.tick();
    expect(t.runs[0]?.signal.aborted).toBe(false);
    expect(t.mesh.isPreemptionSuppressed(t.worker)).toBe(true);

    t.runs[0]?.settle();
    await waitUntil(() => t.runs.length >= 2, 3000);
    expect(t.runs).toHaveLength(2);
    expect(t.entry(second)?.seenAt).toBeTruthy();
    t.runs[1]?.settle();
  });

  it("a late interrupt decision after Stop does not start another run", async () => {
    const t = await running();
    t.mesh.selectInboxEntries(t.worker, [t.a]);
    await t.arrive("pending");
    const pending = t.decisions.shift();
    expect(t.mesh.isPreemptionSuppressed(t.worker)).toBe(true);

    t.mesh.interrupt(t.worker, "root");
    await t.tick();
    expect(t.runs[0]?.signal.aborted).toBe(true);
    const afterStop = t.runs.length;

    pending?.({ interruptProbability: 0.9 });
    await t.tick();
    await t.tick();
    expect(t.runs).toHaveLength(afterStop);
    expect(t.mesh.isPreemptionSuppressed(t.worker)).toBe(false);
    for (const run of t.runs) run.settle();
  });
});
