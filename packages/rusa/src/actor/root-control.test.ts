import { describe, expect, it, vi } from "vitest";
import { assertConcreteModelConfig, isModelClassReference } from "../providers/model-config.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import type { Actor } from "./actor.js";
import { ActorMesh } from "./actor-mesh.js";
import { defaultGrantRecipient } from "./administrative-capabilities.js";
import {
  type RootControlMesh,
  type RootControlOptions,
  RootControlService,
} from "./root-control.js";

function setup(extra: Partial<RootControlOptions> = {}) {
  const events: Parameters<RootControlMesh["recordEvent"]>[0][] = [];
  const mesh: RootControlMesh = {
    spawn: vi.fn(() => "child-1"),
    sendMessage: vi.fn(() => ({ delivered: true })),
    grantHandle: vi.fn(),
    isAncestorOf: vi.fn(() => true),
    retire: vi.fn(),
    interrupt: vi.fn(() => ({ interrupted: true })),
    runNow: vi.fn(() => ({ queued: true })),
    recordEvent: (event) => events.push(event),
    list: vi.fn(() => []),
  };
  return {
    mesh,
    events,
    service: new RootControlService({
      mesh,
      rootId: "root",
      providers: ["claude", "agy"],
      ...extra,
    }),
  };
}

describe("RootControlService", () => {
  it("refuses actor-controlled bootstrap when an empty store has no root actor", () => {
    const { mesh, events, service } = setup({ rootId: undefined });

    expect(() =>
      service.spawnChild(
        { charter: "do not synthesize a parent", modelConfig: { provider: "agy", model: "flash" } },
        "root-llm"
      )
    ).toThrow(/authenticated.*operator/);
    expect(mesh.spawn).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("lets an operator create the first parentless actor, then creates children under it", () => {
    const actors = new InMemoryActorRepository();
    const mesh = new ActorMesh({
      actors,
      idgen: (() => {
        let n = 0;
        return () => `actor-${++n}`;
      })(),
      createActor: () => ({ run: vi.fn() }) as unknown as Actor,
    });
    const service = new RootControlService({ mesh, providers: ["agy"] });
    const request = { charter: "start here", modelConfig: { provider: "agy", model: "flash" } };
    const first = service.spawnChild(request, "e2e-controller");
    const second = service.spawnChild(request, "e2e-controller");
    expect(actors.get(first)?.parentId).toBeNull();
    expect(actors.get(second)?.parentId).toBe(first);
    expect(actors.get(first)?.handles).toContainEqual({ id: second });
    expect(service.rootId).toBe(first);
  });

  it("spawns under root and records the external principal without changing ownership", () => {
    const { mesh, events, service } = setup();
    const id = service.spawnChild(
      {
        charter: "  Investigate the failure  ",
        modelConfig: { provider: "agy", model: "gemini-3.5-flash-medium" },
      },
      "00000000-0000-4000-8000-000000000001"
    );

    expect(id).toBe("child-1");
    expect(mesh.spawn).toHaveBeenCalledWith({
      charter: "Investigate the failure",
      parentId: "root",
      modelConfig: { provider: "agy", model: "gemini-3.5-flash-medium" },
      context: undefined,
      conversationId: undefined,
      title: undefined,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "root_control_action",
      actorId: "root",
      detail: "00000000-0000-4000-8000-000000000001 spawn_child",
    });
    expect(JSON.parse(events[0].payload ?? "{}")).toMatchObject({
      principal: "00000000-0000-4000-8000-000000000001",
      action: "spawn_child",
      targetId: "child-1",
    });
  });

  it("forwards every defined execution target, including a blank one, to the mesh", () => {
    const { mesh, service } = setup();
    service.spawnChild(
      {
        charter: "place me",
        modelConfig: { provider: "claude", model: "claude-opus-5" },
        executionTarget: "",
      },
      "e2e-controller"
    );
    // Erasing a blank target here would turn an explicit placement request into
    // a silent local run; mesh.spawn is the gate that decides it, so it has to
    // see what was asked for.
    expect(mesh.spawn).toHaveBeenCalledWith(expect.objectContaining({ executionTarget: "" }));

    service.spawnChild(
      { charter: "run here", modelConfig: { provider: "claude", model: "claude-opus-5" } },
      "e2e-controller"
    );
    expect(vi.mocked(mesh.spawn).mock.calls[1][0]).not.toHaveProperty("executionTarget");
  });

  it("forwards and audits an independent effort setting", () => {
    const { mesh, events, service } = setup();
    service.spawnChild(
      {
        charter: "review",
        modelConfig: { provider: "claude", model: "claude-opus-4-8", effort: "max" },
      },
      "root-llm"
    );

    expect(mesh.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: { provider: "claude", model: "claude-opus-4-8", effort: "max" },
      })
    );
    expect(JSON.parse(events[0].payload ?? "{}")).toMatchObject({
      modelConfig: [{ provider: "claude", model: "claude-opus-4-8", effort: "max" }],
    });
  });

  it("sends as root while retaining controller provenance in the audit event", () => {
    const { mesh, events, service } = setup();
    service.sendMessage("child-1", "  begin now  ", "e2e-controller");

    expect(mesh.sendMessage).toHaveBeenCalledWith(
      "child-1",
      "begin now",
      "root",
      undefined,
      undefined,
      { messageStamp: undefined }
    );
    expect(events[0]).toMatchObject({
      actorId: "root",
      detail: "e2e-controller send_message",
    });
  });

  it("does not emit a success audit event when delivery fails", () => {
    const { mesh, events, service } = setup();
    vi.mocked(mesh.sendMessage).mockReturnValue({ delivered: false, status: "retired" });

    expect(() => service.sendMessage("child-1", "hello", "root-llm")).toThrow(/retired/);
    expect(events).toEqual([]);
  });

  it("throws unknown thread id error when message delivery target is missing ", () => {
    const { mesh, events, service } = setup();
    vi.mocked(mesh.sendMessage).mockReturnValue({ delivered: false, status: undefined });

    expect(() => service.sendMessage("ghost", "hello", "root-llm")).toThrow(
      "unknown thread id: ghost"
    );
    expect(events).toEqual([]);
  });

  it("rejects an unconfigured provider before mutating the mesh", () => {
    const { mesh, service } = setup();
    expect(() =>
      service.spawnChild(
        { charter: "work", modelConfig: { provider: "missing", model: "claude-sonnet-4-6" } },
        "00000000-0000-4000-8000-000000000001"
      )
    ).toThrow(/unknown provider/);
    expect(mesh.spawn).not.toHaveBeenCalled();
  });

  it("rejects spawnChild when modelConfig is an empty pool", () => {
    const { mesh, service } = setup();
    expect(() =>
      service.spawnChild(
        { charter: "work", modelConfig: [] },
        "00000000-0000-4000-8000-000000000001"
      )
    ).toThrow(/modelConfig is required/);
    expect(mesh.spawn).not.toHaveBeenCalled();
  });

  it("normalizes and audits a per-actor portable context policy", () => {
    const { mesh, events, service } = setup();
    service.spawnChild(
      {
        charter: "research a treatment",
        modelConfig: { provider: "agy", model: "gemini-3.5-flash-medium" },
        context: {
          type: "portable",
          mode: "brief",
        },
      },
      "e2e-controller"
    );

    const context = {
      type: "portable",
      mode: "brief",
    };
    expect(mesh.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        modelConfig: { provider: "agy", model: "gemini-3.5-flash-medium" },
      })
    );
    expect(JSON.parse(events[0].payload ?? "{}")).toMatchObject({
      context,
      modelConfig: [{ provider: "agy", model: "gemini-3.5-flash-medium" }],
    });
  });

  it("refuses to retire root or a thread outside root's subtree", () => {
    const { mesh, service } = setup();
    expect(() => service.retireChild("root", "00000000-0000-4000-8000-000000000001")).toThrow(
      /descendants/
    );
    vi.mocked(mesh.isAncestorOf).mockReturnValue(false);
    expect(() => service.retireChild("peer", "00000000-0000-4000-8000-000000000001")).toThrow(
      /descendants/
    );
    expect(mesh.retire).not.toHaveBeenCalled();
  });

  it("retires a child under the mid-run guard by default, and audits the force override", () => {
    const { mesh, events, service } = setup();

    service.retireChild("child-1", "00000000-0000-4000-8000-000000000001");
    expect(mesh.retire).toHaveBeenLastCalledWith("child-1", { force: undefined });
    expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({
      action: "retire_child",
      targetId: "child-1",
    });
    expect(JSON.parse(events[0]?.payload ?? "{}").force).toBeUndefined();

    // The operator keeps an override the actor-facing tool does not have — a wedged
    // thread must stay retirable — and it lands in the audit record.
    service.retireChild("child-1", "00000000-0000-4000-8000-000000000001", { force: true });
    expect(mesh.retire).toHaveBeenLastCalledWith("child-1", {
      force: true,
      forceQueued: undefined,
    });
    expect(JSON.parse(events[1]?.payload ?? "{}")).toMatchObject({ force: true });

    service.retireChild("child-1", "00000000-0000-4000-8000-000000000001", { forceQueued: true });
    expect(mesh.retire).toHaveBeenLastCalledWith("child-1", {
      force: undefined,
      forceQueued: true,
    });
    expect(JSON.parse(events[2]?.payload ?? "{}")).toMatchObject({ forceQueued: true });
  });

  it("uses the resolved class pool for the provider prewalk while forwarding its declaration", () => {
    const { mesh, events, service } = setup({
      resolveModelConfig: (input) =>
        typeof input === "object" && input !== null && "class" in input
          ? [{ provider: "agy", model: "gemini-3.5-flash-medium", effort: "high" }]
          : input,
    });

    const id = service.spawnChild(
      { charter: "work", modelConfig: { class: "fast" } },
      "00000000-0000-4000-8000-000000000001"
    );

    expect(id).toBe("child-1");
    // Root control needs the resolved pool for its provider allowlist, but it
    // keeps the original declaration for mesh.spawn. The mesh's authoritative
    // validation boundary resolves it and records class provenance directly
    // from that class reference — no sideband class field is caller-settable.
    expect(mesh.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: { class: "fast" },
      })
    );
    expect(JSON.parse(events[0].payload ?? "{}")).toMatchObject({
      modelConfig: [{ provider: "agy", model: "gemini-3.5-flash-medium", effort: "high" }],
    });
  });

  it("applies the provider allowlist to the resolved pool, not the reference", () => {
    const { mesh, service } = setup({
      resolveModelConfig: () => [{ provider: "missing", model: "some-model" }],
    });

    expect(() =>
      service.spawnChild(
        { charter: "work", modelConfig: { class: "fast" } },
        "00000000-0000-4000-8000-000000000001"
      )
    ).toThrow(/unknown provider: missing/);
    expect(mesh.spawn).not.toHaveBeenCalled();
  });

  it("rejects a class reference with a clear error when no resolver is wired in", () => {
    const { mesh, service } = setup();

    expect(() =>
      service.spawnChild(
        { charter: "work", modelConfig: { class: "fast" } },
        "00000000-0000-4000-8000-000000000001"
      )
    ).toThrow(/model class reference/);
    expect(mesh.spawn).not.toHaveBeenCalled();
  });

  it("spawns a class against a real ActorMesh and persists resolved pool plus provenance", () => {
    const actors = new InMemoryActorRepository();
    const mesh = new ActorMesh({
      actors,
      rootId: "root",
      createActor: () => ({ run: vi.fn() }) as unknown as Actor,
      validateSpawn: (request) => {
        if (isModelClassReference(request.modelConfig) && request.modelConfig.class === "fast") {
          return [{ provider: "agy", model: "gemini-3.5-flash-medium", effort: "high" }];
        }
        throw new Error("unexpected modelConfig");
      },
    });
    const service = new RootControlService({
      mesh,
      rootId: "root",
      providers: ["agy"],
      resolveModelConfig: (input) =>
        isModelClassReference(input) && input.class === "fast"
          ? [{ provider: "agy", model: "gemini-3.5-flash-medium", effort: "high" }]
          : assertConcreteModelConfig(input),
    });

    const id = service.spawnChild(
      { charter: "work", modelConfig: { class: "fast" } },
      "00000000-0000-4000-8000-000000000001"
    );

    const record = actors.get(id);
    expect(record).toMatchObject({
      modelClass: "fast",
      modelConfig: [{ provider: "agy", model: "gemini-3.5-flash-medium", effort: "high" }],
    });
  });

  it("interrupts a child in the root subtree and audits the action", () => {
    const { mesh, events, service } = setup();

    const res = service.interruptChild("child-1", "00000000-0000-4000-8000-000000000001");
    expect(res.interrupted).toBe(true);
    expect(mesh.interrupt).toHaveBeenCalledWith("child-1", "00000000-0000-4000-8000-000000000001");
    expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({
      action: "interrupt_child",
      targetId: "child-1",
      interrupted: true,
    });
  });

  it("runs a child immediately and audits the action", () => {
    const { mesh, events, service } = setup();

    const res = service.runNowChild("child-1", "00000000-0000-4000-8000-000000000001");
    expect(res.queued).toBe(true);
    expect(mesh.runNow).toHaveBeenCalledWith("child-1", "00000000-0000-4000-8000-000000000001");
    expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({
      action: "run_now_child",
      targetId: "child-1",
    });
  });

  it("clears availability holds through the hold service and audits an operator mutation", () => {
    const { mesh, events } = setup();
    const released = {
      provider: "codex",
      origin: "mesh" as const,
      reason: "maintenance",
      createdBy: "root",
      createdAt: "2026-10-16T00:00:00.000Z",
    };
    const clear = vi.fn(() => ({ released: [released], expired: [] }));
    const service = new RootControlService({ mesh, rootId: "root", availabilityHolds: { clear } });

    const result = service.clearAvailabilityHolds(
      { provider: "codex" },
      "00000000-0000-4000-8000-000000000001"
    );

    expect(result).toEqual({ released: [released], expired: [] });
    expect(clear).toHaveBeenCalledWith({ provider: "codex" });
    expect(mesh.spawn).not.toHaveBeenCalled();
    expect(mesh.runNow).not.toHaveBeenCalled();
    expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({
      action: "clear_availability_holds",
      targetId: "root",
      provider: "codex",
      released: 1,
      expiredRemoved: 0,
    });
  });

  it("refuses availability-hold recovery when the live hold service is absent", () => {
    const { service } = setup();
    expect(() =>
      service.clearAvailabilityHolds({ provider: "codex" }, "00000000-0000-4000-8000-000000000001")
    ).toThrow("availability hold recovery is unavailable");
  });

  it("clears every halt in one release and audits it as one operator action", () => {
    const { mesh, events } = setup();
    const chatHold = {
      provider: "kimi",
      origin: "chat" as const,
      reason: "chat /halt",
      createdBy: "chat:users/operator",
      createdAt: "2026-10-16T00:00:00.000Z",
    };
    const meshHold = {
      provider: "codex",
      model: "gpt-5.5",
      origin: "mesh" as const,
      reason: "capacity outage",
      createdBy: "root",
      createdAt: "2026-10-16T00:00:00.000Z",
    };
    const releaseHalts = vi.fn(() => ({
      brakeReleased: true,
      released: [chatHold, meshHold],
      expired: [],
      resumed: ["child-1"],
    }));
    const service = new RootControlService({ mesh, rootId: "root", releaseHalts });

    const result = service.clearAllHalts("00000000-0000-4000-8000-000000000001");

    expect(result.released).toEqual([chatHold, meshHold]);
    expect(releaseHalts).toHaveBeenCalledTimes(1);
    expect(mesh.spawn).not.toHaveBeenCalled();
    expect(mesh.runNow).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.payload ?? "{}")).toEqual({
      principal: "00000000-0000-4000-8000-000000000001",
      action: "clear_all_halts",
      targetId: "root",
      brakeReleased: true,
      released: [
        { provider: "kimi", model: null, origin: "chat" },
        { provider: "codex", model: "gpt-5.5", origin: "mesh" },
      ],
      expiredRemoved: 0,
      replayed: 1,
    });
  });

  it("audits no clear-all that found nothing to release", () => {
    const { mesh, events } = setup();
    const releaseHalts = vi.fn(() => ({
      brakeReleased: false,
      released: [],
      expired: [],
      resumed: [],
    }));
    const service = new RootControlService({ mesh, rootId: "root", releaseHalts });

    const result = service.clearAllHalts("00000000-0000-4000-8000-000000000001");

    expect(result).toEqual({ brakeReleased: false, released: [], expired: [], resumed: [] });
    expect(releaseHalts).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
  });

  it("refuses to clear all halts when the live release path is absent", () => {
    const { service, events } = setup();
    expect(() => service.clearAllHalts("00000000-0000-4000-8000-000000000001")).toThrow(
      "halt recovery is unavailable"
    );
    expect(events).toHaveLength(0);
  });

  it("forwards the bootstrap sandbox choice to the mesh and audits it", () => {
    const { mesh, events, service } = setup();
    service.spawnChild(
      {
        charter: "first actor",
        modelConfig: { provider: "agy", model: "flash" },
        unsandboxed: true,
      },
      "e2e-controller"
    );
    expect(mesh.spawn).toHaveBeenCalledWith(expect.objectContaining({ unsandboxed: true }));
    expect(JSON.parse(events[0].payload ?? "{}")).toMatchObject({ unsandboxed: true });

    service.spawnChild(
      { charter: "second actor", modelConfig: { provider: "agy", model: "flash" } },
      "e2e-controller"
    );
    // An absent choice keeps the sandboxed default and is not sent at all.
    expect(vi.mocked(mesh.spawn).mock.calls[1][0]).not.toHaveProperty("unsandboxed");
  });

  it("refuses unsandboxed once the mesh has any actor", () => {
    const { mesh, service } = setup();
    vi.mocked(mesh.list).mockReturnValue([{ id: "actor-1" } as never]);
    expect(() =>
      service.spawnChild(
        {
          charter: "late unsandboxed ask",
          modelConfig: { provider: "agy", model: "flash" },
          unsandboxed: true,
        },
        "e2e-controller"
      )
    ).toThrow(/empty mesh/);
    expect(mesh.spawn).not.toHaveBeenCalled();
  });

  it("records the chosen sandbox setting and makes the first actor the default grant recipient", () => {
    const actors = new InMemoryActorRepository();
    const mesh = new ActorMesh({
      actors,
      idgen: (() => {
        let n = 0;
        return () => `actor-${++n}`;
      })(),
      createActor: () => ({ run: vi.fn() }) as unknown as Actor,
    });
    const service = new RootControlService({ mesh, providers: ["agy"] });
    const operator = "00000000-0000-4000-8000-000000000001";

    const first = service.spawnChild(
      {
        charter: "bootstrap the mesh",
        modelConfig: { provider: "agy", model: "flash" },
        unsandboxed: true,
      },
      operator
    );
    // The chosen isolation is recorded on the versioned execution_config
    // document, and the first actor is the default grant recipient by being
    // the oldest active parentless actor (#1260 amendment).
    expect(actors.get(first)?.executionConfig?.unsandboxed).toBe(true);
    expect(defaultGrantRecipient(mesh.list())?.id).toBe(first);

    // Sandboxed first-actor choice on an empty mesh records unsandboxed: false
    // and is also the default grant recipient.
    const actorsSandboxed = new InMemoryActorRepository();
    const meshSandboxed = new ActorMesh({
      actors: actorsSandboxed,
      idgen: () => "actor-sandboxed",
      createActor: () => ({ run: vi.fn() }) as unknown as Actor,
    });
    const serviceSandboxed = new RootControlService({ mesh: meshSandboxed, providers: ["agy"] });
    const firstSandboxed = serviceSandboxed.spawnChild(
      {
        charter: "bootstrap the mesh sandboxed",
        modelConfig: { provider: "agy", model: "flash" },
        unsandboxed: false,
      },
      operator
    );
    expect(actorsSandboxed.get(firstSandboxed)?.executionConfig?.unsandboxed ?? false).toBe(false);
    expect(defaultGrantRecipient(meshSandboxed.list())?.id).toBe(firstSandboxed);

    const second = service.spawnChild(
      { charter: "ordinary child", modelConfig: { provider: "agy", model: "flash" } },
      operator
    );
    expect(actors.get(second)?.executionConfig?.unsandboxed ?? false).toBe(false);

    // The mesh is no longer empty: unsandboxed is refused from here on.
    expect(() =>
      service.spawnChild(
        {
          charter: "late unsandboxed ask",
          modelConfig: { provider: "agy", model: "flash" },
          unsandboxed: true,
        },
        operator
      )
    ).toThrow(/empty mesh/);
  });
});
