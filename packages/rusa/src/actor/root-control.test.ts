import { describe, expect, it, vi } from "vitest";
import { type RootControlMesh, RootControlService } from "./root-control.js";

function setup() {
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
  return { mesh, events, service: new RootControlService({ mesh, providers: ["claude", "agy"] }) };
}

describe("RootControlService", () => {
  it("spawns under root and records the external principal without changing ownership", () => {
    const { mesh, events, service } = setup();
    const id = service.spawnChild(
      {
        charter: "  Investigate the failure  ",
        provider: " agy ",
        model: " gemini-3.5-flash-medium ",
      },
      "human:operator"
    );

    expect(id).toBe("child-1");
    expect(mesh.spawn).toHaveBeenCalledWith({
      charter: "Investigate the failure",
      parentId: "root",
      provider: "agy",
      model: "gemini-3.5-flash-medium",
      context: undefined,
      conversationId: undefined,
      title: undefined,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "root_control_action",
      actorId: "root",
      detail: "human:operator spawn_child",
    });
    expect(JSON.parse(events[0].payload ?? "{}")).toMatchObject({
      principal: "human:operator",
      action: "spawn_child",
      targetId: "child-1",
    });
  });

  it("forwards and audits an independent effort setting", () => {
    const { mesh, events, service } = setup();
    service.spawnChild(
      {
        charter: "review",
        provider: "claude",
        model: "claude-opus-4-8",
        effort: "max",
      },
      "root-llm"
    );

    expect(mesh.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-8", effort: "max" })
    );
    expect(JSON.parse(events[0].payload ?? "{}")).toMatchObject({
      model: "claude-opus-4-8",
      effort: "max",
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
      undefined
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
        { charter: "work", provider: "missing", model: "claude-sonnet-4-6" },
        "human:operator"
      )
    ).toThrow(/unknown provider/);
    expect(mesh.spawn).not.toHaveBeenCalled();
  });

  it("rejects spawnChild when provider or model is missing ", () => {
    const { mesh, service } = setup();
    expect(() =>
      service.spawnChild(
        { charter: "work", provider: "", model: "claude-sonnet-4-6" },
        "human:operator"
      )
    ).toThrow(/provider is required/);
    expect(() =>
      service.spawnChild({ charter: "work", provider: "agy", model: "" }, "human:operator")
    ).toThrow(/model is required/);
    expect(() =>
      service.spawnChild(
        { charter: "work", provider: "   ", model: "claude-sonnet-4-6" },
        "human:operator"
      )
    ).toThrow(/provider is required/);
    expect(() =>
      service.spawnChild({ charter: "work", provider: "agy", model: "   " }, "human:operator")
    ).toThrow(/model is required/);
    expect(mesh.spawn).not.toHaveBeenCalled();
  });

  it("normalizes and audits a per-actor portable context policy", () => {
    const { mesh, events, service } = setup();
    service.spawnChild(
      {
        charter: "research a treatment",
        provider: "agy",
        model: "gemini-3.5-flash-medium",
        context: {
          type: "portable",
          mode: "ledger",
          compactionModel: "  gemini-custom  ",
        },
      },
      "e2e-controller"
    );

    const context = {
      type: "portable",
      mode: "ledger",
      compactionModel: "gemini-custom",
    };
    expect(mesh.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ context, provider: "agy", model: "gemini-3.5-flash-medium" })
    );
    expect(JSON.parse(events[0].payload ?? "{}")).toMatchObject({
      context,
      provider: "agy",
      model: "gemini-3.5-flash-medium",
    });
  });

  it("refuses to retire root or a thread outside root's subtree", () => {
    const { mesh, service } = setup();
    expect(() => service.retireChild("root", "human:operator")).toThrow(/descendants/);
    vi.mocked(mesh.isAncestorOf).mockReturnValue(false);
    expect(() => service.retireChild("peer", "human:operator")).toThrow(/descendants/);
    expect(mesh.retire).not.toHaveBeenCalled();
  });

  it("retires a child under the mid-run guard by default, and audits the force override", () => {
    const { mesh, events, service } = setup();

    service.retireChild("child-1", "human:operator");
    expect(mesh.retire).toHaveBeenLastCalledWith("child-1", { force: undefined });
    expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({
      action: "retire_child",
      targetId: "child-1",
    });
    expect(JSON.parse(events[0]?.payload ?? "{}").force).toBeUndefined();

    // The operator keeps an override the actor-facing tool does not have — a wedged
    // thread must stay retirable — and it lands in the audit record.
    service.retireChild("child-1", "human:operator", { force: true });
    expect(mesh.retire).toHaveBeenLastCalledWith("child-1", {
      force: true,
      forceQueued: undefined,
    });
    expect(JSON.parse(events[1]?.payload ?? "{}")).toMatchObject({ force: true });

    service.retireChild("child-1", "human:operator", { forceQueued: true });
    expect(mesh.retire).toHaveBeenLastCalledWith("child-1", {
      force: undefined,
      forceQueued: true,
    });
    expect(JSON.parse(events[2]?.payload ?? "{}")).toMatchObject({ forceQueued: true });
  });

  it("interrupts a child in the root subtree and audits the action", () => {
    const { mesh, events, service } = setup();

    const res = service.interruptChild("child-1", "human:operator");
    expect(res.interrupted).toBe(true);
    expect(mesh.interrupt).toHaveBeenCalledWith("child-1", "human:operator");
    expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({
      action: "interrupt_child",
      targetId: "child-1",
      interrupted: true,
    });
  });

  it("runs a child immediately and audits the action", () => {
    const { mesh, events, service } = setup();

    const res = service.runNowChild("child-1", "human:operator");
    expect(res.queued).toBe(true);
    expect(mesh.runNow).toHaveBeenCalledWith("child-1", "human:operator");
    expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({
      action: "run_now_child",
      targetId: "child-1",
    });
  });
});
