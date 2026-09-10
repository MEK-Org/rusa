import { describe, expect, it, vi } from "vitest";
import type { ActorOptions } from "../actor/actor.js";
import type { RunResult } from "../providers/types.js";
import { ActorMeshCoordinator } from "./actor-mesh-coordinator.js";
import {
  EventManager,
  type EventSourceResolver,
  type RawIntegrationEvent,
} from "./event-manager.js";
import { DurableInboxItemRepository, type InboxItem } from "./inbox-item-repository.js";
import { type ActorInvocationInputs, createActorFromInputs, RunManager } from "./run-manager.js";

const successResult: RunResult = { success: true, output: "ok", exitCode: 0 };
const failedResult: RunResult = { success: false, output: "err", exitCode: 1 };

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
      const inboxRepo = new DurableInboxItemRepository();
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

      // Invariant: EventManager does not invoke actors, only appends to InboxItemRepository
      const ownerItems = await inboxRepo.getUnhandledItems("actor-owner");
      expect(ownerItems.length).toBe(1);
      expect(ownerItems[0].source).toBe("github:org/repo/issues/42");
      expect(ownerItems[0].payload.type).toBe("github.event");
    });

    it("returns empty array when no recipient exists for resource", async () => {
      const inboxRepo = new DurableInboxItemRepository();
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

  describe("InboxItemRepository (Authoritative storage & advisory notifications)", () => {
    it("emits after-commit advisory notifications and supports authoritative boot reconciliation", async () => {
      const inboxRepo = new DurableInboxItemRepository();
      const committed: InboxItem[][] = [];
      const unsubscribe = inboxRepo.onItemsCommitted((items) => {
        committed.push([...items]);
      });

      await inboxRepo.append([
        {
          actorId: "actor-1",
          source: "test:source",
          payload: { type: "test" },
        },
        {
          actorId: "actor-2",
          source: "test:source",
          payload: { type: "test" },
        },
      ]);

      expect(committed.length).toBe(1);
      expect(committed[0].map((i) => i.actorId)).toEqual(["actor-1", "actor-2"]);

      // Unsubscribe advisory notification (simulating process restart/crash)
      unsubscribe();

      // Authoritative boot reconciliation recovers pending actors even without callbacks
      const pendingActors = await inboxRepo.listActorsWithUnhandledItems();
      expect([...pendingActors].sort()).toEqual(["actor-1", "actor-2"]);
    });

    it("marks items seen and handled correctly", async () => {
      const inboxRepo = new DurableInboxItemRepository();
      const inserted = await inboxRepo.append([
        {
          id: "item-1",
          actorId: "actor-handled",
          source: "test:source",
          payload: { type: "test" },
        },
      ]);

      expect(inserted[0].seenAt).toBeNull();
      expect(inserted[0].handledAt).toBeNull();

      const seen = await inboxRepo.markSeen("actor-handled");
      expect(seen.length).toBe(1);
      expect(seen[0].seenAt).not.toBeNull();

      const handledResults = await inboxRepo.markHandled(
        "actor-handled",
        ["item-1"],
        "resolved note"
      );
      expect(handledResults).toEqual([
        expect.objectContaining({
          id: "item-1",
          alreadyHandled: false,
        }),
      ]);

      const unhandledAfter = await inboxRepo.getUnhandledItems("actor-handled");
      expect(unhandledAfter.length).toBe(0);
    });

    it("survives throwing listener during advisory notification without failing commit", async () => {
      const inboxRepo = new DurableInboxItemRepository();
      inboxRepo.onItemsCommitted(() => {
        throw new Error("listener failure");
      });

      const inserted = await inboxRepo.append([
        {
          actorId: "actor-safe",
          source: "test:safe",
          payload: { type: "safe" },
        },
      ]);

      expect(inserted.length).toBe(1);
      const pending = await inboxRepo.listActorsWithUnhandledItems();
      expect(pending).toContain("actor-safe");
    });
  });

  describe("RunManager (Content-free poke, priority, single-flight & invocation inputs)", () => {
    it("dispatchRun is a content-free poke and reads priority from durable inbox", async () => {
      const inboxRepo = new DurableInboxItemRepository();
      let executedActorId: string | null = null;

      const runManager = new RunManager({
        inboxRepository: inboxRepo,
        resolveInvocationInputs: async (actorId) => ({
          actorId,
          capabilities: new Set(["mock-cap"]),
          workspace: { path: `/tmp/${actorId}`, sandboxed: false },
          driver: { kind: "local", instantiate: (opts) => opts },
          options: fakeActorOptions(),
          terminal: {
            completeRun: () => "run-1",
            logRunEnd: () => {},
            recordRunEnd: () => {},
          },
          runActor: async () => {
            executedActorId = actorId;
            return successResult;
          },
        }),
      });

      // Poking an actor with no unhandled items does nothing
      await runManager.dispatchRun("actor-empty");
      expect(executedActorId).toBeNull();
      expect(runManager.stateOf("actor-empty")).toBe("idle");

      // Append regular item
      await inboxRepo.append([
        {
          actorId: "actor-normal",
          source: "work:source",
          payload: { type: "work" },
        },
      ]);

      // Content-free poke: dispatchRun receives ONLY actorId
      await runManager.dispatchRun("actor-normal");
      expect(executedActorId).toBe("actor-normal");
    });

    it("coalesces multiple pokes and executes follow-up runs when dirtied", async () => {
      const inboxRepo = new DurableInboxItemRepository();
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
          terminal: {
            completeRun: () => `run-${runCount}`,
            logRunEnd: () => {},
            recordRunEnd: () => {},
          },
          runActor: async () => {
            runCount++;
            await new Promise<void>((res) => {
              resolveRun = res;
            });
            return successResult;
          },
        }),
      });

      await inboxRepo.append([{ actorId: "actor-c", source: "work:1", payload: { type: "job" } }]);

      // First poke starts running
      const firstDispatch = runManager.dispatchRun("actor-c");
      await vi.waitFor(() => {
        expect(runManager.stateOf("actor-c")).toBe("running");
      });
      expect(runManager.stateOf("actor-c")).toBe("running");

      // Second and third pokes arrive while running -> coalesced into dirty follow-up
      await inboxRepo.append([{ actorId: "actor-c", source: "work:2", payload: { type: "job" } }]);
      await runManager.dispatchRun("actor-c");
      await runManager.dispatchRun("actor-c");

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
      const inboxRepo = new DurableInboxItemRepository();
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
          terminal: {
            completeRun: () => "run-interrupt",
            logRunEnd: () => {},
            recordRunEnd: () => {},
          },
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

      await inboxRepo.append([
        { actorId: "actor-i", source: "batch:job", payload: { type: "batch" } },
      ]);

      const dispatchPromise = runManager.dispatchRun("actor-i");
      await vi.waitFor(() => {
        expect(runManager.stateOf("actor-i")).toBe("running");
      });
      expect(runManager.stateOf("actor-i")).toBe("running");

      // Responsive item arrives while running
      await inboxRepo.append([
        {
          actorId: "actor-i",
          source: "urgent:msg",
          payload: { type: "urgent", priority: "responsive" },
        },
      ]);

      await runManager.dispatchRun("actor-i");
      expect(wasAborted).toBe(true);
      await dispatchPromise;
      await vi.waitFor(() => {
        expect(runCount).toBe(2);
        expect(runManager.stateOf("actor-i")).toBe("idle");
      });
    });

    it("consumes ONLY execution inputs without actor hierarchy and constructs via createActorFromInputs", async () => {
      const inboxRepo = new DurableInboxItemRepository();
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
        terminal: {
          completeRun: () => "run-xyz",
          logRunEnd: () => {},
          recordRunEnd: () => {},
        },
        runActor: async (actor) => {
          receivedProfileActorId = actor.id;
          return successResult;
        },
      };

      const runManager = new RunManager({
        inboxRepository: inboxRepo,
        resolveInvocationInputs: async () => invocationInputs,
      });

      await inboxRepo.append([
        { actorId: "worker-xyz", source: "test", payload: { type: "test" } },
      ]);

      await runManager.dispatchRun("worker-xyz");

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
      const inboxRepo = new DurableInboxItemRepository();
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
          terminal: {
            completeRun: () => "run-admit",
            logRunEnd: () => {},
            recordRunEnd: () => {},
          },
          runActor: async () => {
            activeCount++;
            maxObservedActive = Math.max(maxObservedActive, activeCount);
            await new Promise((r) => setTimeout(r, 20));
            activeCount--;
            return successResult;
          },
        }),
      });

      await inboxRepo.append([
        { actorId: "actor-p1", source: "job", payload: { type: "job" } },
        { actorId: "actor-p2", source: "job", payload: { type: "job" } },
      ]);

      // Poke both concurrently
      const p1 = runManager.dispatchRun("actor-p1");
      const p2 = runManager.dispatchRun("actor-p2");

      await Promise.all([p1, p2]);
      await new Promise((r) => setTimeout(r, 60));

      // Max active runs never exceeded maxParallelism (1)
      expect(maxObservedActive).toBe(1);

      // Verify quota throttling blocks run when quotaAllowed is false
      quotaAllowed = false;
      await inboxRepo.append([{ actorId: "actor-q", source: "job", payload: { type: "job" } }]);
      await runManager.dispatchRun("actor-q");
      expect(runManager.stateOf("actor-q")).toBe("queued");
    });
  });

  describe("ActorMeshCoordinator (Sibling component coordination)", () => {
    it("coordinates inbox notifications and boot reconciliation as a sibling to EventManager", async () => {
      const inboxRepo = new DurableInboxItemRepository();
      const pokedActors: string[] = [];

      const mockRunManager = {
        dispatchRun: vi.fn(async (actorId: string) => {
          pokedActors.push(actorId);
        }),
      } as unknown as RunManager;

      // Seed unhandled work before boot
      await inboxRepo.append([
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
  });
});
