import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
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

class FakeProvider implements CodingProvider {
  readonly name = "fake";
  readonly providerName = "fake";
  constructor(
    private readonly runner: (opts: {
      prompt: string;
      cwd: string;
      signal?: AbortSignal;
    }) => Promise<Partial<RunResult>>
  ) {}

  async run(opts: { prompt: string; cwd: string; signal?: AbortSignal }): Promise<RunResult> {
    const res = await this.runner(opts);
    return {
      success: true,
      output: "",
      exitCode: 0,
      ...res,
    };
  }
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

describe("Active JEV Responsive Interruption Policy (#533)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  describe("Default Mode is Shadow", () => {
    it("never suppresses preemption and records detail: shadow", async () => {
      let runSignal: AbortSignal | undefined;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise(() => {}); // hang
      });
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        client: {
          decide: async () => ({ interruptProbability: 0.1 }), // < 0.5 would queue in active mode
        },
      });

      const { mesh, inboxStore, events, tick } = setup({
        sharedProvider: provider,
        responsiveInterruption: classifier,
        // responsiveInterruptionMode omitted -> defaults to shadow
      });

      const worker = mesh.spawn({ charter: "worker", parentId: "root" });
      const [entry] = inboxStore.append([
        { actorId: worker, source: "test", payload: { type: "task", task: "initial" } },
      ]);
      mesh.dispatch(worker);
      await tick();

      // Worker selects initial task
      mesh.selectInboxEntries(worker, [entry.id]);
      expect(runSignal?.aborted).toBe(false);

      // Responsive message arrives
      mesh.sendMessage(worker, "operator responsive", TEST_USER_ID, "s1");
      await tick();

      // Shadow mode never suppresses: baseline interrupts immediately!
      expect(runSignal?.aborted).toBe(true);

      const shadowEvents = events.filter((e) => e.kind === "responsive_interruption_shadow");
      expect(shadowEvents.length).toBeGreaterThanOrEqual(1);
      expect(shadowEvents[0].detail).toBe("shadow");
    });
  });

  describe("Active Mode Eligibility", () => {
    it("suppresses preemption for running actor with live unhandled selection when JEV decides queue", async () => {
      let runSignal: AbortSignal | undefined;
      let resolveRun!: (result: Partial<RunResult>) => void;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise<Partial<RunResult>>((resolve) => {
          resolveRun = resolve;
        });
      });

      let decideCalled = false;
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async () => {
            decideCalled = true;
            return { interruptProbability: 0.1 }; // queue (< 0.5)
          },
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

      // Select work while running
      mesh.selectInboxEntries(worker, [entry.id]);
      expect(mesh.selectedInboxEntries(worker)).toEqual([entry.id]);

      // Responsive message arrives
      mesh.sendMessage(worker, "operator responsive message", TEST_USER_ID, "s1");
      await tick();

      expect(decideCalled).toBe(true);
      // Preemption is SUPPRESSED! Signal is NOT aborted.
      expect(runSignal?.aborted).toBe(false);

      // Audit event recorded with detail: "active"
      const audit = events.find(
        (e) => e.kind === "responsive_interruption_shadow" && e.actorId === worker
      );
      expect(audit).toBeDefined();
      expect(audit?.detail).toBe("active");
      const parsed = JSON.parse(audit?.payload ?? "{}");
      expect(parsed.decision.outcome).toBe("queue");

      // Running actor completes its turn naturally
      mesh.finishInboxRun(worker, { successful: true });
      resolveRun({});
      await tick();
    });

    it("does not call JEV for idle actor", async () => {
      let decideCalled = false;
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
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

      // Message arrives while idle
      mesh.sendMessage(worker, "hello idle", TEST_USER_ID, "s1");
      await tick();

      expect(decideCalled).toBe(false);
    });

    it("does not call JEV and interrupts immediately when running actor has NO selection", async () => {
      let runSignal: AbortSignal | undefined;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise(() => {});
      });

      let decideCalled = false;
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async () => {
            decideCalled = true;
            return { interruptProbability: 0.1 };
          },
        },
      });

      const { mesh, inboxStore, tick } = setup({
        sharedProvider: provider,
        responsiveInterruption: classifier,
        responsiveInterruptionMode: "active",
      });

      const worker = mesh.spawn({ charter: "worker", parentId: "root" });
      inboxStore.append([{ actorId: worker, source: "test", payload: { type: "task" } }]);
      mesh.dispatch(worker);
      await tick();

      // Running, but NO selection made (selectedInboxEntries is empty)
      expect(mesh.selectedInboxEntries(worker)).toEqual([]);

      // Responsive message arrives
      mesh.sendMessage(worker, "operator message", TEST_USER_ID, "s1");
      await tick();

      // Ineligible! No JEV call, interrupts immediately
      expect(decideCalled).toBe(false);
      expect(runSignal?.aborted).toBe(true);
    });

    it("does not call JEV and interrupts immediately when selected work is already handled", async () => {
      let runSignal: AbortSignal | undefined;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise(() => {});
      });

      let decideCalled = false;
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async () => {
            decideCalled = true;
            return { interruptProbability: 0.1 };
          },
        },
      });

      const { mesh, inboxStore, tick } = setup({
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
      // Mark entry handled
      inboxStore.markHandled(worker, [entry.id]);

      // Responsive message arrives
      mesh.sendMessage(worker, "operator message", TEST_USER_ID, "s1");
      await tick();

      // Ineligible! Selected work is not live unhandled -> interrupts immediately
      expect(decideCalled).toBe(false);
      expect(runSignal?.aborted).toBe(true);
    });

    it("does not call JEV and interrupts immediately for operator.run_now", async () => {
      let runSignal: AbortSignal | undefined;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise(() => {});
      });

      let decideCalled = false;
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async () => {
            decideCalled = true;
            return { interruptProbability: 0.1 };
          },
        },
      });

      const { mesh, inboxStore, tick } = setup({
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

      // Append operator.run_now responsive row
      inboxStore.append([
        {
          actorId: worker,
          source: "operator:control",
          payload: { type: "operator.run_now", priority: "responsive" },
        },
      ]);
      mesh.dispatch(worker);
      await tick();

      expect(decideCalled).toBe(false);
      expect(runSignal?.aborted).toBe(true);
    });
  });

  describe("Threshold & Decisions", () => {
    it("preempts running actor when JEV probability >= 0.5", async () => {
      let runSignal: AbortSignal | undefined;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise(() => {});
      });

      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async () => ({ interruptProbability: 0.75 }), // >= 0.5 -> interrupt
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
      expect(runSignal?.aborted).toBe(false);

      mesh.sendMessage(worker, "urgent request", TEST_USER_ID, "s1");
      await tick();

      // Preempted!
      expect(runSignal?.aborted).toBe(true);

      const preemptEvent = events.find((e) => e.kind === "run_preempted" && e.actorId === worker);
      expect(preemptEvent).toBeDefined();

      const shadowEvent = events.find(
        (e) => e.kind === "responsive_interruption_shadow" && e.actorId === worker
      );
      expect(shadowEvent?.detail).toBe("active");
      const parsed = JSON.parse(shadowEvent?.payload ?? "{}");
      expect(parsed.decision.outcome).toBe("interrupt");
    });
  });

  describe("Fallbacks & Errors", () => {
    it("preempts running actor on client error fallback", async () => {
      let runSignal: AbortSignal | undefined;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise(() => {});
      });

      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async () => {
            throw new Error("HTTP 500 internal error");
          },
        },
      });

      const { mesh, inboxStore, tick } = setup({
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
      mesh.sendMessage(worker, "operator message", TEST_USER_ID, "s1");
      await tick();

      // Client error -> fallback to interrupt -> preempted
      expect(runSignal?.aborted).toBe(true);
    });

    it("preempts running actor on input unavailable error fallback", async () => {
      let runSignal: AbortSignal | undefined;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise(() => {});
      });

      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async () => {
            throw new JevInputUnavailableError();
          },
        },
      });

      const { mesh, inboxStore, tick } = setup({
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
      mesh.sendMessage(worker, "operator message", TEST_USER_ID, "s1");
      await tick();

      expect(runSignal?.aborted).toBe(true);
    });

    it("preempts running actor on invalid probability fallback", async () => {
      let runSignal: AbortSignal | undefined;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise(() => {});
      });

      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async () => ({ interruptProbability: NaN }),
        },
      });

      const { mesh, inboxStore, tick } = setup({
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
      mesh.sendMessage(worker, "operator message", TEST_USER_ID, "s1");
      await tick();

      expect(runSignal?.aborted).toBe(true);
    });
  });

  describe("Deadline & Late Responses", () => {
    it("preempts running actor when JEV decision deadline expires", async () => {
      let runSignal: AbortSignal | undefined;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise(() => {});
      });

      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        timeoutMs: 50, // short timeout for testing
        mode: "active",
        client: {
          decide: () => new Promise(() => {}), // never resolves
        },
      });

      const { mesh, inboxStore, tick } = setup({
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
      mesh.sendMessage(worker, "operator message", TEST_USER_ID, "s1");
      await tick();

      // Initially suppressed while waiting for deadline
      expect(runSignal?.aborted).toBe(false);

      // Wait past deadline
      await new Promise((resolve) => setTimeout(resolve, 80));
      await tick();

      // Deadline expired -> preempted!
      expect(runSignal?.aborted).toBe(true);
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
        return new Promise(() => {}); // second run hangs
      });

      let resolveJev!: (res: JevDecisionResponse) => void;
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
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

      // Responsive message arrives during run 1
      mesh.sendMessage(worker, "operator message", TEST_USER_ID, "s1");
      await tick();

      // Run 1 finishes naturally before JEV resolves!
      mesh.finishInboxRun(worker, { successful: true });
      resolveFirstRun({});
      await tick();

      // Second run starts (follow-up for the responsive message)
      expect(runCount).toBe(2);
      expect(signals[1].aborted).toBe(false);

      // Now JEV resolves late with "interrupt"
      resolveJev({ interruptProbability: 0.9 });
      await tick();

      // Late response MUST NOT preempt run 2!
      expect(signals[1].aborted).toBe(false);

      // Audit event was still recorded with detail: "active"
      const audit = events.find((e) => e.kind === "responsive_interruption_shadow");
      expect(audit).toBeDefined();
      expect(audit?.detail).toBe("active");
    });
  });

  describe("Invalidation: Selection Changes, ABA, Work Handled, Stop", () => {
    it("invalidates suppression and preempts running actor when selection changes (ABA)", async () => {
      let runSignal: AbortSignal | undefined;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise(() => {});
      });

      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async () => ({ interruptProbability: 0.1 }), // queue
        },
      });

      const { mesh, inboxStore, tick } = setup({
        sharedProvider: provider,
        responsiveInterruption: classifier,
        responsiveInterruptionMode: "active",
      });

      const worker = mesh.spawn({ charter: "worker", parentId: "root" });
      const [e1, e2] = inboxStore.append([
        { actorId: worker, source: "test", payload: { type: "task", id: "t1" } },
        { actorId: worker, source: "test", payload: { type: "task", id: "t2" } },
      ]);
      mesh.dispatch(worker);
      await tick();

      // Selection A
      mesh.selectInboxEntries(worker, [e1.id]);
      mesh.sendMessage(worker, "operator message", TEST_USER_ID, "s1");
      await tick();

      // Preemption suppressed
      expect(runSignal?.aborted).toBe(false);

      // Reselection B
      mesh.selectInboxEntries(worker, [e2.id]);
      await tick();

      // Selection changed -> invalidation triggered preemption!
      expect(runSignal?.aborted).toBe(true);
    });

    it("invalidates suppression and preempts running actor when selected work is marked handled", async () => {
      let runSignal: AbortSignal | undefined;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise(() => {});
      });

      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async () => ({ interruptProbability: 0.1 }), // queue
        },
      });

      const { mesh, inboxStore, tick } = setup({
        sharedProvider: provider,
        responsiveInterruption: classifier,
        responsiveInterruptionMode: "active",
      });

      const worker = mesh.spawn({ charter: "worker", parentId: "root" });
      const [e1] = inboxStore.append([
        { actorId: worker, source: "test", payload: { type: "task", id: "t1" } },
      ]);
      mesh.dispatch(worker);
      await tick();

      mesh.selectInboxEntries(worker, [e1.id]);
      mesh.sendMessage(worker, "operator message", TEST_USER_ID, "s1");
      await tick();

      // Preemption suppressed
      expect(runSignal?.aborted).toBe(false);

      // Selected work is marked handled!
      inboxStore.markHandled(worker, [e1.id]);
      await tick();

      // Selected work handled -> invalidation triggered preemption!
      expect(runSignal?.aborted).toBe(true);
    });

    it("operator interrupt stops actor and clears active suppression", async () => {
      let runSignal: AbortSignal | undefined;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise(() => {});
      });

      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async () => ({ interruptProbability: 0.1 }), // queue
        },
      });

      const { mesh, inboxStore, tick } = setup({
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
      mesh.sendMessage(worker, "operator message", TEST_USER_ID, "s1");
      await tick();

      expect(runSignal?.aborted).toBe(false);
      expect(mesh.isPreemptionSuppressed(worker)).toBe(true);

      // Operator interrupt
      mesh.interrupt(worker, "root");
      await tick();

      expect(mesh.isPreemptionSuppressed(worker)).toBe(false);
    });
  });

  describe("Batch Arrivals & Replay Deduplication", () => {
    it("any interrupting batchrow wins when multiple rows arrive concurrently", async () => {
      let runSignal: AbortSignal | undefined;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise(() => {});
      });

      let e1: { id: string } | undefined;
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async (req: JevDecisionRequest) => {
            if (e1 && req.input.incomingEntryId === e1.id) {
              return { interruptProbability: 0.1 }; // queue
            }
            return { interruptProbability: 0.9 }; // interrupt
          },
        },
      });

      const { mesh, inboxStore, tick } = setup({
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

      // Append 2 responsive rows in the same batch
      const batch = inboxStore.append([
        { actorId: worker, source: "test", payload: { type: "task", priority: "responsive" } },
        { actorId: worker, source: "test", payload: { type: "task", priority: "responsive" } },
      ]);
      e1 = batch[0];

      mesh.dispatch(worker);
      await tick();

      // The interrupting row wins -> actor preempted!
      expect(runSignal?.aborted).toBe(true);
    });

    it("redundant dispatch pokes do not re-call JEV or bypass suppression", async () => {
      let runSignal: AbortSignal | undefined;
      const provider = new FakeProvider((opts) => {
        runSignal = opts.signal;
        return new Promise(() => {});
      });

      let decideCallCount = 0;
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async () => {
            decideCallCount++;
            return { interruptProbability: 0.1 }; // queue
          },
        },
      });

      const { mesh, inboxStore, tick } = setup({
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
      mesh.sendMessage(worker, "operator message", TEST_USER_ID, "s1");
      await tick();

      expect(decideCallCount).toBe(1);
      expect(runSignal?.aborted).toBe(false);

      // Redundant dispatch pokes
      mesh.dispatch(worker);
      mesh.dispatch(worker);
      await tick();

      // No duplicate JEV calls
      expect(decideCallCount).toBe(1);
      // No replay bypass: still not preempted!
      expect(runSignal?.aborted).toBe(false);
    });
  });

  describe("Follower Instance Active Policy", () => {
    it("suppresses follower remote preemption when active JEV decides queue", async () => {
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async () => ({ interruptProbability: 0.1 }), // queue (< 0.5)
        },
      });

      const h = createHarness({
        cwd: "/tmp",
        delayMs: 300,
        responsiveInterruption: classifier,
        responsiveInterruptionMode: "active",
      });

      const id = h.spawn("follower worker");

      // Start run on follower
      h.dispatchNormal(id);

      // Wait until follower is running
      await waitUntil(() => h.mesh.runningThreadIds().has(id));

      // Follower selects work
      const entries = h.inboxStore.list(id).entries;
      expect(entries.length).toBeGreaterThan(0);
      h.mesh.selectInboxEntries(id, [entries[0].id]);

      // Responsive entry arrives
      h.dispatchResponsive(id);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Remote preemption was SUPPRESSED! No remote_preempt_requested log
      expect(h.logs.some((l) => l.event === "remote_preempt_requested")).toBe(false);
      // No preempted mesh event
      expect(h.meshEvents.some((e) => e.kind === "run_preempted" && e.actorId === id)).toBe(false);

      await h.close();
    });

    it("preempts follower remote run when active JEV decides interrupt", async () => {
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.5,
        mode: "active",
        client: {
          decide: async () => ({ interruptProbability: 0.8 }), // interrupt (>= 0.5)
        },
      });

      const h = createHarness({
        cwd: "/tmp",
        delayMs: 500,
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
      await waitUntil(() => h.logs.some((l) => l.event === "remote_preempt_requested"));

      // Preemption requested on follower!
      expect(h.logs.some((l) => l.event === "remote_preempt_requested")).toBe(true);

      await h.close();
    });
  });
});
