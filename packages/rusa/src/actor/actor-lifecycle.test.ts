import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeProvider } from "../providers/fake-provider.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import { Actor } from "./actor.js";
import { createActorLifecycle } from "./actor-lifecycle.js";
import { ActorMesh, type MeshActor } from "./actor-mesh.js";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe("actor lifecycle contract", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fans listeners out in registration order and isolates a failed listener", async () => {
    const observed: string[] = [];
    const reported: string[] = [];
    const lifecycle = createActorLifecycle(
      [
        {
          onSpawn: () => {
            observed.push("first");
          },
        },
        {
          onSpawn: () => {
            observed.push("broken");
            throw new Error("observer failed");
          },
        },
        {
          onSpawn: () => {
            observed.push("last");
          },
        },
      ],
      (failure) => reported.push(`${failure.event}:${String(failure.error)}`)
    );

    await lifecycle.emit("onSpawn", { actorId: "worker" });

    expect(observed).toEqual(["first", "broken", "last"]);
    expect(reported).toEqual(["onSpawn:Error: observer failed"]);
  });

  it("emits spawn and retire through the mesh lifecycle", async () => {
    const observed: string[] = [];
    const mesh = new ActorMesh({
      actors: new InMemoryActorRepository(),
      lifecycleListeners: [
        {
          onSpawn: ({ actorId }) => {
            observed.push(`spawn:${actorId}`);
          },
          onRetire: ({ actorId }) => {
            observed.push(`retire:${actorId}`);
          },
        },
      ],
      createActor: (context): MeshActor => ({
        id: context.record.id,
        lifecycle: context.lifecycle,
        requestRun: () => {},
        declareYield: () => {},
        markUnkillable: () => {},
        close: () => {},
        preemptForResponsive: () => ({ preempted: false }),
        isRunning: false,
      }),
    });

    const actorId = mesh.spawn({
      charter: "worker",
      parentId: "root",
      modelConfig: { provider: "fake", model: "fake-model" },
    });
    await flush();
    mesh.retire(actorId);
    await flush();

    expect(observed).toEqual([`spawn:${actorId}`, `retire:${actorId}`]);
  });

  it("keeps an actor run alive when an observer fails", async () => {
    const observed: string[] = [];
    let actor!: Actor;
    const provider = new FakeProvider(() => {
      actor.declareYield();
      return { success: true, output: "done", exitCode: 0 };
    });
    const lifecycle = createActorLifecycle([
      {
        onQueued: () => {
          throw new Error("queued observer failed");
        },
      },
      {
        onStart: () => {
          observed.push("start");
        },
        onEnd: () => {
          observed.push("end");
        },
      },
    ]);
    actor = new Actor({
      id: "worker",
      cwd: "/tmp/worker",
      modelConfig: [{ provider: provider.providerName }],
      resolveProvider: () => provider,
      mcpServers: [],
      loadSessionId: () => undefined,
      saveSessionId: () => {},
      buildPrompt: () => ({ prompt: "work" }),
      debounceMs: 10,
      lifecycle,
    });

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    await flush();

    expect(provider.calls).toHaveLength(1);
    expect(observed).toEqual(["start", "end"]);
  });

  it.each(["root", "worker"])("keeps %s run ordering and identity stable", async (actorId) => {
    const observed: string[] = [];
    const ids: string[] = [];
    let actor!: Actor;
    const provider = new FakeProvider(() => {
      actor.declareYield();
      return { success: true, output: "done", exitCode: 0 };
    });
    const lifecycle = createActorLifecycle([
      {
        onQueued: (event) => {
          observed.push("queued");
          ids.push(event.runId);
        },
        onStart: (event) => {
          observed.push("start");
          ids.push(event.runId);
        },
        onEnd: (event) => {
          observed.push("end");
          ids.push(event.runId);
          expect(event.terminal).toMatchObject({ kind: "result", result: { success: true } });
        },
      },
    ]);
    actor = new Actor({
      id: actorId,
      cwd: `/tmp/${actorId}`,
      modelConfig: [{ provider: provider.providerName }],
      resolveProvider: () => provider,
      mcpServers: [],
      loadSessionId: () => undefined,
      saveSessionId: () => {},
      buildPrompt: () => ({ prompt: "work" }),
      debounceMs: 10,
      lifecycle,
    });

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    await flush();

    expect(observed).toEqual(["queued", "start", "end"]);
    expect(new Set(ids)).toHaveLength(1);
  });

  it.each([
    "root",
    "worker",
  ])("reports %s provider errors before one failed terminal event", async (actorId) => {
    const observed: string[] = [];
    const lifecycle = createActorLifecycle([
      {
        onQueued: () => {
          observed.push("queued");
        },
        onStart: () => {
          observed.push("start");
        },
        onError: () => {
          observed.push("error");
        },
        onEnd: (event) => {
          observed.push("end");
          expect(event.terminal).toMatchObject({ kind: "result", result: { success: false } });
        },
      },
    ]);
    const actor = new Actor({
      id: actorId,
      cwd: `/tmp/${actorId}`,
      modelConfig: [{ provider: "fake" }],
      resolveProvider: () =>
        new FakeProvider(() => {
          throw new Error("provider failed");
        }),
      mcpServers: [],
      loadSessionId: () => undefined,
      saveSessionId: () => {},
      buildPrompt: () => ({ prompt: "work" }),
      debounceMs: 10,
      lifecycle,
    });

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    await flush();

    expect(observed).toEqual(["queued", "start", "error", "end"]);
  });

  it.each([
    "root",
    "worker",
  ])("closes %s cancelled queued runs exactly once without inventing a start", async (actorId) => {
    const limiter = new ConcurrencyLimiter(1);
    let release!: () => void;
    void limiter.run(() => new Promise<void>((resolve) => (release = resolve)));
    await flush();
    const observed: Array<{ event: string; runId: string }> = [];
    const lifecycle = createActorLifecycle([
      {
        onQueued: (event) => {
          observed.push({ event: "queued", runId: event.runId });
        },
        onStart: (event) => {
          observed.push({ event: "start", runId: event.runId });
        },
        onEnd: (event) => {
          observed.push({ event: "end", runId: event.runId });
          expect(event.terminal).toEqual({
            kind: "abandoned",
            reason: "start-cancelled",
            started: false,
          });
        },
      },
    ]);
    const actor = new Actor({
      id: actorId,
      cwd: `/tmp/${actorId}`,
      modelConfig: [{ provider: "fake" }],
      resolveProvider: () => new FakeProvider(),
      mcpServers: [],
      loadSessionId: () => undefined,
      saveSessionId: () => {},
      buildPrompt: () => ({ prompt: "work" }),
      debounceMs: 10,
      gate: (fn, candidates) => limiter.enqueue(() => fn(candidates[0])),
      lifecycle,
    });

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(actor.cancelQueuedRun()).toBe(true);
    await flush();
    release();
    await flush();

    expect(observed.map(({ event }) => event)).toEqual(["queued", "end"]);
    expect(new Set(observed.map(({ runId }) => runId))).toHaveLength(1);
  });
});
