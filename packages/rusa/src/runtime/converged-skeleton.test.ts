import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ActorOptions } from "../actor/actor.js";
import type {
  InboxActorWork,
  InboxAppendInput,
  InboxEntry,
  InboxListOptions,
  InboxPage,
  InboxStore,
  MarkHandledResult,
} from "../actor/inbox-store.js";
import { validateInboxPayload } from "../actor/inbox-store.js";
import type { RunResult } from "../providers/types.js";
import type { ActorLifecycleListener } from "./actor-lifecycle.js";
import { ActorMeshCoordinator } from "./actor-mesh-coordinator.js";
import {
  EventManager,
  type EventSourceResolver,
  type RawIntegrationEvent,
} from "./event-manager.js";
import { NotifyingInboxRepository } from "./notifying-inbox-repository.js";
import { type ActorInvocationInputs, createActorFromInputs, RunManager } from "./run-manager.js";

const successResult: RunResult = { success: true, output: "ok", exitCode: 0 };
const failedResult: RunResult = { success: false, output: "err", exitCode: 1 };

/**
 * Minimal in-memory `InboxStore`, standing in for the SQLite implementation so
 * these tests exercise the seam the converged runtime actually consumes rather
 * than a purpose-built double of its own.
 */
class FakeInboxStore implements InboxStore {
  private readonly entries: InboxEntry[] = [];

  append(inputs: InboxAppendInput[]): InboxEntry[] {
    const inserted: InboxEntry[] = [];
    for (const input of inputs) {
      validateInboxPayload(input.payload);
      const id = input.id ?? randomUUID();
      if (this.entries.some((entry) => entry.id === id)) continue;
      const entry: InboxEntry = {
        id,
        actorId: input.actorId,
        source: input.source,
        deliveredAt: input.deliveredAt ?? new Date(),
        seenAt: null,
        handledAt: null,
        handledNote: null,
        payload: input.payload,
      };
      this.entries.push(entry);
      inserted.push(entry);
    }
    return inserted;
  }

  list(actorId: string, options?: InboxListOptions): InboxPage {
    const status = options?.status ?? "unhandled";
    const mine = this.entries.filter((entry) => entry.actorId === actorId);
    const entries = mine.filter((entry) =>
      status === "all"
        ? true
        : status === "unhandled"
          ? entry.handledAt === null
          : entry.handledAt !== null
    );
    return {
      entries,
      unhandledCount: mine.filter((entry) => entry.handledAt === null).length,
      nextCursor: null,
    };
  }

  read(actorId: string, entryId: string): InboxEntry | null {
    return this.entries.find((entry) => entry.actorId === actorId && entry.id === entryId) ?? null;
  }

  countUnhandled(actorId: string, options?: { responsiveOnly?: boolean }): number {
    return this.entries.filter(
      (entry) =>
        entry.actorId === actorId &&
        entry.handledAt === null &&
        (!options?.responsiveOnly || entry.payload.priority === "responsive")
    ).length;
  }

  actorsWithUnhandled(): InboxActorWork[] {
    return this.promote((entry) => entry.handledAt === null);
  }

  actorsWithUnseen(): InboxActorWork[] {
    return this.promote((entry) => entry.handledAt === null && entry.seenAt === null);
  }

  markSeen(actorId: string, seenAt: Date = new Date()): InboxEntry[] {
    const seen: InboxEntry[] = [];
    for (const entry of this.entries) {
      if (entry.actorId === actorId && entry.handledAt === null && entry.seenAt === null) {
        entry.seenAt = seenAt;
        seen.push(entry);
      }
    }
    return seen;
  }

  markHandled(
    actorId: string,
    entryIds: string[],
    handledAt: Date = new Date(),
    handledNote?: string
  ): MarkHandledResult[] {
    const wanted = new Set(entryIds);
    const results: MarkHandledResult[] = [];
    for (const entry of this.entries) {
      if (entry.actorId !== actorId || !wanted.has(entry.id)) continue;
      const alreadyHandled = entry.handledAt !== null;
      if (!alreadyHandled) {
        entry.handledAt = handledAt;
        entry.handledNote = handledNote?.trim() || null;
      }
      results.push({ id: entry.id, handledAt: entry.handledAt ?? handledAt, alreadyHandled });
    }
    return results;
  }

  /** Mirrors the store contract: an actor is responsive if any matching entry is. */
  private promote(predicate: (entry: InboxEntry) => boolean): InboxActorWork[] {
    const work = new Map<string, InboxActorWork>();
    for (const entry of this.entries) {
      if (!predicate(entry)) continue;
      const responsive = entry.payload.priority === "responsive";
      const existing = work.get(entry.actorId);
      if (!existing) {
        work.set(entry.actorId, {
          actorId: entry.actorId,
          priority: responsive ? "responsive" : "normal",
        });
      } else if (responsive) {
        existing.priority = "responsive";
      }
    }
    return [...work.values()];
  }
}

function newInboxRepository(): NotifyingInboxRepository {
  return new NotifyingInboxRepository(new FakeInboxStore());
}

function fakeActorOptions(): Omit<ActorOptions, "id" | "cwd" | "sandbox" | "onRunEnd"> {
  return {
    modelConfig: [{ provider: "mock", model: "mock-model" }],
    resolveProvider: () => ({
      name: "mock",
      providerName: "mock",
      run: async () => successResult,
    }),
    mcpServers: [],
    loadSessionId: () => undefined,
    saveSessionId: () => {},
    buildPrompt: () => ({ prompt: "mock" }),
  };
}

describe("Converged Architecture Skeleton", () => {
  describe("EventManager (External event normalization and recipient routing)", () => {
    it("normalizes events and writes durable inbox items without invoking actors", async () => {
      const inboxRepo = newInboxRepository();
      const mockResolver: EventSourceResolver = {
        resolveRecipients: async (resource) => {
          if (resource === "github:org/repo/issues/42") {
            return {
              ownerId: "actor-owner",
              subscriberIds: ["actor-sub-1", "actor-sub-2"],
            };
          }
          return { ownerId: null, subscriberIds: [] };
        },
      };

      const eventManager = new EventManager(inboxRepo, mockResolver);

      const rawEvent: RawIntegrationEvent = {
        sourceType: "github",
        rawResource: "github:org/repo/issues/42",
        rawPayload: { action: "opened", issue: { number: 42 } },
        idempotencyKey: "evt-123",
      };

      const inserted = await eventManager.handleExternalEvent(rawEvent);

      // Delivered to owner + both subscribers
      expect(inserted.length).toBe(3);
      const recipientIds = inserted.map((i) => i.actorId).sort();
      expect(recipientIds).toEqual(["actor-owner", "actor-sub-1", "actor-sub-2"]);

      // Invariant: EventManager does not invoke actors, only appends to the inbox
      const ownerItems = inboxRepo.list("actor-owner", { status: "unhandled" }).entries;
      expect(ownerItems.length).toBe(1);
      expect(ownerItems[0].source).toBe("github:org/repo/issues/42");
      expect(ownerItems[0].payload.type).toBe("github.event");
    });

    it("returns empty array when no recipient exists for resource", async () => {
      const inboxRepo = newInboxRepository();
      const mockResolver: EventSourceResolver = {
        resolveRecipients: async () => ({ ownerId: null, subscriberIds: [] }),
      };
      const eventManager = new EventManager(inboxRepo, mockResolver);

      const inserted = await eventManager.handleExternalEvent({
        sourceType: "custom",
        rawResource: "unhandled:event",
        rawPayload: {},
      });

      expect(inserted).toEqual([]);
    });
  });

  describe("InboxRepository (Existing store, extended with append notifications)", () => {
    it("emits after-commit advisory notifications and supports authoritative boot reconciliation", () => {
      const inboxRepo = newInboxRepository();
      const committed: InboxEntry[][] = [];
      const unsubscribe = inboxRepo.onItemsAppended((items) => {
        committed.push([...items]);
      });

      inboxRepo.append([
        { actorId: "actor-1", source: "test:source", payload: { type: "test" } },
        { actorId: "actor-2", source: "test:source", payload: { type: "test" } },
      ]);

      expect(committed.length).toBe(1);
      expect(committed[0].map((i) => i.actorId)).toEqual(["actor-1", "actor-2"]);

      // Unsubscribe advisory notification (simulating process restart/crash)
      unsubscribe();

      // Authoritative boot reconciliation recovers pending actors even without callbacks
      const pendingActors = inboxRepo.actorsWithUnhandled().map((work) => work.actorId);
      expect([...pendingActors].sort()).toEqual(["actor-1", "actor-2"]);
    });

    it("notifies only about rows the delegate actually inserted", () => {
      const inboxRepo = newInboxRepository();
      const committed: InboxEntry[][] = [];
      inboxRepo.onItemsAppended((items) => committed.push([...items]));

      const input: InboxAppendInput = {
        id: "dedupe:evt-1",
        actorId: "actor-dupe",
        source: "test:source",
        payload: { type: "test" },
      };
      inboxRepo.append([input]);
      inboxRepo.append([input]);

      expect(committed.length).toBe(1);
      expect(inboxRepo.countUnhandled("actor-dupe")).toBe(1);
    });

    it("promotes an actor to responsive when any pending row is responsive", () => {
      const inboxRepo = newInboxRepository();
      inboxRepo.append([
        { actorId: "actor-mixed", source: "batch", payload: { type: "batch" } },
        {
          actorId: "actor-mixed",
          source: "urgent",
          payload: { type: "urgent", priority: "responsive" },
        },
      ]);

      expect(inboxRepo.actorsWithUnhandled()).toEqual([
        { actorId: "actor-mixed", priority: "responsive" },
      ]);
    });

    it("survives throwing listener during advisory notification without failing commit", () => {
      const inboxRepo = newInboxRepository();
      inboxRepo.onItemsAppended(() => {
        throw new Error("listener failure");
      });

      const inserted = inboxRepo.append([
        { actorId: "actor-safe", source: "test:safe", payload: { type: "safe" } },
      ]);

      expect(inserted.length).toBe(1);
      expect(inboxRepo.actorsWithUnhandled().map((work) => work.actorId)).toContain("actor-safe");
    });
  });

  describe("RunManager (Content-free poke, priority, single-flight & invocation inputs)", () => {
    it("dispatch is a content-free poke and reads priority from durable inbox", async () => {
      const inboxRepo = newInboxRepository();
      let executedActorId: string | null = null;

      const runManager = new RunManager({
        inboxRepository: inboxRepo,
        resolveInvocationInputs: async (actorId) => ({
          actorId,
          capabilities: new Set(["mock-cap"]),
          workspace: { path: `/tmp/${actorId}`, sandboxed: false },
          driver: { kind: "local", instantiate: (opts) => opts },
          options: fakeActorOptions(),
          runActor: async () => {
            executedActorId = actorId;
            return successResult;
          },
        }),
      });

      // Poking an actor with no unhandled items does nothing
      await runManager.dispatch("actor-empty");
      expect(executedActorId).toBeNull();
      expect(runManager.stateOf("actor-empty")).toBe("idle");

      // Append regular item
      inboxRepo.append([
        { actorId: "actor-normal", source: "work:source", payload: { type: "work" } },
      ]);

      // Content-free poke: dispatch receives ONLY actorId
      await runManager.dispatch("actor-normal");
      expect(executedActorId).toBe("actor-normal");
    });

    it("coalesces multiple pokes and executes follow-up runs when dirtied", async () => {
      const inboxRepo = newInboxRepository();
      let runCount = 0;
      let resolveRun!: () => void;

      const runManager = new RunManager({
        inboxRepository: inboxRepo,
        resolveInvocationInputs: async (actorId) => ({
          actorId,
          capabilities: new Set(["cap"]),
          workspace: { path: `/tmp/${actorId}`, sandboxed: false },
          driver: { kind: "local", instantiate: (opts) => opts },
          options: fakeActorOptions(),
          runActor: async () => {
            runCount++;
            await new Promise<void>((res) => {
              resolveRun = res;
            });
            return successResult;
          },
        }),
      });

      inboxRepo.append([{ actorId: "actor-c", source: "work:1", payload: { type: "job" } }]);

      // First poke starts running
      const firstDispatch = runManager.dispatch("actor-c");
      await vi.waitFor(() => {
        expect(runManager.stateOf("actor-c")).toBe("running");
      });

      // Second and third pokes arrive while running -> coalesced into dirty follow-up
      inboxRepo.append([{ actorId: "actor-c", source: "work:2", payload: { type: "job" } }]);
      await runManager.dispatch("actor-c");
      await runManager.dispatch("actor-c");

      // Still running first run
      expect(runCount).toBe(1);

      // Complete first run
      resolveRun();
      await firstDispatch;

      // Follow-up was automatically triggered by the dirty nudge.
      await vi.waitFor(() => {
        expect(runCount).toBe(2);
      });

      // Complete second run
      resolveRun();
      await vi.waitFor(() => {
        expect(runManager.stateOf("actor-c")).toBe("idle");
      });
    });

    it("interrupts active run when responsive inbox item arrives", async () => {
      const inboxRepo = newInboxRepository();
      let wasAborted = false;
      let runCount = 0;

      const runManager = new RunManager({
        inboxRepository: inboxRepo,
        resolveInvocationInputs: async (actorId) => ({
          actorId,
          capabilities: new Set(),
          workspace: { path: `/tmp/${actorId}`, sandboxed: false },
          driver: { kind: "local", instantiate: (opts) => opts },
          options: fakeActorOptions(),
          runActor: async (_actor, signal) => {
            runCount++;
            if (runCount > 1) return successResult;
            signal?.addEventListener("abort", () => {
              wasAborted = true;
            });
            await new Promise<void>((resolve) => {
              signal?.addEventListener("abort", () => resolve());
            });
            return failedResult;
          },
        }),
      });

      inboxRepo.append([{ actorId: "actor-i", source: "batch:job", payload: { type: "batch" } }]);

      const dispatchPromise = runManager.dispatch("actor-i");
      await vi.waitFor(() => {
        expect(runManager.stateOf("actor-i")).toBe("running");
      });

      // Responsive item arrives while running
      inboxRepo.append([
        {
          actorId: "actor-i",
          source: "urgent:msg",
          payload: { type: "urgent", priority: "responsive" },
        },
      ]);

      await runManager.dispatch("actor-i");
      expect(wasAborted).toBe(true);
      await dispatchPromise;
      await vi.waitFor(() => {
        expect(runCount).toBe(2);
        expect(runManager.stateOf("actor-i")).toBe("idle");
      });
    });

    it("consumes ONLY execution inputs without actor hierarchy and constructs via createActorFromInputs", async () => {
      const inboxRepo = newInboxRepository();
      let receivedProfileActorId: string | null = null;
      const received = { options: null as ActorOptions | null };

      const invocationInputs: ActorInvocationInputs<ActorOptions> = {
        actorId: "worker-xyz",
        capabilities: new Set(["read", "write"]),
        workspace: { path: "/work/xyz", sandboxed: true },
        driver: {
          kind: "local",
          instantiate: (opts) => {
            received.options = opts;
            return opts;
          },
        },
        options: fakeActorOptions(),
        runActor: async (actor) => {
          receivedProfileActorId = actor.id;
          return successResult;
        },
      };

      const runManager = new RunManager({
        inboxRepository: inboxRepo,
        resolveInvocationInputs: async () => invocationInputs,
      });

      inboxRepo.append([{ actorId: "worker-xyz", source: "test", payload: { type: "test" } }]);

      await runManager.dispatch("worker-xyz");

      expect(receivedProfileActorId).toBe("worker-xyz");
      expect(received.options?.cwd).toBe("/work/xyz");
      expect(received.options?.sandbox).toBe(true);

      // Duck rootness check: actor construction inputs do not have role or isRoot or hierarchy
      const constructed = createActorFromInputs(invocationInputs);
      expect(constructed.id).toBe("worker-xyz");
      // @ts-expect-error role is not part of options
      expect(constructed.role).toBeUndefined();
      // @ts-expect-error isRoot is not part of options
      expect(constructed.isRoot).toBeUndefined();
    });

    it("enforces v1 parallelism and quota admission throttling", async () => {
      const inboxRepo = newInboxRepository();
      let quotaAllowed = true;
      let activeCount = 0;
      let maxObservedActive = 0;

      const runManager = new RunManager({
        inboxRepository: inboxRepo,
        maxParallelism: 1, // Only 1 concurrent run
        checkQuota: () => quotaAllowed,
        resolveInvocationInputs: async (actorId) => ({
          actorId,
          capabilities: new Set(),
          workspace: { path: `/tmp/${actorId}`, sandboxed: false },
          driver: { kind: "local", instantiate: (opts) => opts },
          options: fakeActorOptions(),
          runActor: async () => {
            activeCount++;
            maxObservedActive = Math.max(maxObservedActive, activeCount);
            await new Promise((r) => setTimeout(r, 20));
            activeCount--;
            return successResult;
          },
        }),
      });

      inboxRepo.append([
        { actorId: "actor-p1", source: "job", payload: { type: "job" } },
        { actorId: "actor-p2", source: "job", payload: { type: "job" } },
      ]);

      // Poke both concurrently
      const p1 = runManager.dispatch("actor-p1");
      const p2 = runManager.dispatch("actor-p2");

      await Promise.all([p1, p2]);
      await new Promise((r) => setTimeout(r, 60));

      // Max active runs never exceeded maxParallelism (1)
      expect(maxObservedActive).toBe(1);

      // Verify quota throttling blocks run when quotaAllowed is false
      quotaAllowed = false;
      inboxRepo.append([{ actorId: "actor-q", source: "job", payload: { type: "job" } }]);
      await runManager.dispatch("actor-q");
      expect(runManager.stateOf("actor-q")).toBe("queued");
    });
  });

  describe("Actor lifecycle events", () => {
    it("emits queued/start/end to every listener with one shared run id", async () => {
      const inboxRepo = newInboxRepository();
      const order: string[] = [];

      // Two listeners of identical shape: what used to be logRunEnd and
      // recordRunEnd are now peers rather than two named hooks.
      const runLog: ActorLifecycleListener = {
        onQueued: ({ actorId }) => {
          order.push(`queued:${actorId}`);
        },
        onStart: ({ runId }) => {
          order.push(`log-start:${runId}`);
        },
        onEnd: ({ runId, result }) => {
          order.push(`log-end:${runId}:${result.success}`);
        },
      };
      const runAccounting: ActorLifecycleListener = {
        onEnd: async ({ runId }) => {
          order.push(`record-end:${runId}`);
        },
      };

      const runManager = new RunManager({
        inboxRepository: inboxRepo,
        lifecycle: [runLog, runAccounting],
        newRunId: () => "run-fixed",
        resolveInvocationInputs: async (actorId) => ({
          actorId,
          capabilities: new Set(),
          workspace: { path: `/tmp/${actorId}`, sandboxed: false },
          driver: { kind: "local", instantiate: (opts) => opts },
          options: fakeActorOptions(),
          runActor: async () => successResult,
        }),
      });

      inboxRepo.append([{ actorId: "actor-l", source: "job", payload: { type: "job" } }]);
      await runManager.dispatch("actor-l");

      expect(order).toEqual([
        "queued:actor-l",
        "log-start:run-fixed",
        "log-end:run-fixed:true",
        "record-end:run-fixed",
      ]);
    });

    it("emits onError instead of onEnd when the run throws, and one bad listener cannot starve the next", async () => {
      const inboxRepo = newInboxRepository();
      const seen: string[] = [];

      const runManager = new RunManager({
        inboxRepository: inboxRepo,
        lifecycle: [
          {
            onError: () => {
              throw new Error("observer blew up");
            },
          },
          {
            onEnd: () => {
              seen.push("end");
            },
            onError: ({ error }) =>
              void seen.push(`error:${error instanceof Error ? error.message : "?"}`),
          },
        ],
        resolveInvocationInputs: async (actorId) => ({
          actorId,
          capabilities: new Set(),
          workspace: { path: `/tmp/${actorId}`, sandboxed: false },
          driver: { kind: "local", instantiate: (opts) => opts },
          options: fakeActorOptions(),
          runActor: async () => {
            throw new Error("run exploded");
          },
        }),
      });

      inboxRepo.append([{ actorId: "actor-e", source: "job", payload: { type: "job" } }]);
      await runManager.dispatch("actor-e");

      expect(seen).toEqual(["error:run exploded"]);
      expect(runManager.stateOf("actor-e")).toBe("idle");
    });
  });

  describe("ActorMeshCoordinator (Sibling component coordination)", () => {
    it("coordinates inbox notifications and boot reconciliation as a sibling to EventManager", async () => {
      const inboxRepo = newInboxRepository();
      const pokedActors: string[] = [];

      const mockRunManager = {
        dispatch: vi.fn(async (actorId: string) => {
          pokedActors.push(actorId);
        }),
      } as unknown as RunManager;

      // Seed unhandled work before boot
      inboxRepo.append([
        { actorId: "actor-stale-1", source: "src", payload: { type: "stale" } },
        { actorId: "actor-stale-2", source: "src", payload: { type: "stale" } },
      ]);

      const coordinator = new ActorMeshCoordinator({
        inboxRepository: inboxRepo,
        runManager: mockRunManager,
      });

      // Boot coordinator: should reconcile all unhandled work
      await coordinator.start();
      expect(pokedActors.sort()).toEqual(["actor-stale-1", "actor-stale-2"]);

      // Sibling EventManager delivers an event to the inbox repository
      const resolver: EventSourceResolver = {
        resolveRecipients: async () => ({
          ownerId: "actor-fresh",
          subscriberIds: [],
        }),
      };
      const eventManager = new EventManager(inboxRepo, resolver);

      await eventManager.handleExternalEvent({
        sourceType: "chat",
        rawResource: "chat:spaces/general",
        rawPayload: { text: "hello" },
      });

      // Coordinator received after-commit advisory notification and poked RunManager
      expect(pokedActors).toContain("actor-fresh");

      await coordinator.shutdown();
    });

    it("owns the mesh half of the lifecycle: onSpawn and onRetire", async () => {
      const inboxRepo = newInboxRepository();
      const events: string[] = [];

      const coordinator = new ActorMeshCoordinator({
        inboxRepository: inboxRepo,
        runManager: { dispatch: vi.fn(async () => {}) } as unknown as RunManager,
        lifecycle: [
          {
            onSpawn: ({ actorId }) => void events.push(`spawn:${actorId}`),
            onRetire: ({ actorId }) => void events.push(`retire:${actorId}`),
          },
        ],
      });

      await coordinator.registerActor({ id: "actor-s", parentId: null, status: "active" });
      // Re-registering an existing record is not a second spawn.
      await coordinator.registerActor({ id: "actor-s", parentId: null, status: "active" });
      await coordinator.retireActor("actor-s");
      // Retiring twice is not a second retire.
      await coordinator.retireActor("actor-s");

      expect(events).toEqual(["spawn:actor-s", "retire:actor-s"]);
    });
  });
});
