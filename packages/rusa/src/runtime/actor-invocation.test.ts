import { describe, expect, it, vi } from "vitest";
import { Actor, type ActorOptions } from "../actor/actor.js";
import type { MeshActor } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import type { ProviderModelConfig, RawProviderModelConfig } from "../providers/model-config.js";
import { type ActorInvocationInput, constructActorFromInvocation } from "./actor-invocation.js";

const providerPool: RawProviderModelConfig[] = [
  { provider: "provider-a", model: "model-a", effort: "high" },
];

function record(overrides: Partial<ActorRecord> = {}): ActorRecord {
  return {
    id: "opaque-actor-id",
    charter: "characterize invocation construction",
    parentId: null,
    status: "active",
    createdAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

function invocation(overrides: Partial<ActorInvocationInput> = {}): ActorInvocationInput {
  return {
    record: record(),
    capabilities: ["process-admin"],
    workspace: { cwd: "/isolated/opaque-actor-id", addDirs: ["/checkout"], sandbox: false },
    provider: {
      modelConfig: providerPool,
      resolveProvider: vi.fn(),
    },
    mcpServers: [{ name: "mesh", url: "http://127.0.0.1:1/mcp" }],
    session: { load: () => "native-session", save: vi.fn() },
    prompt: () => ({ prompt: "configured prompt" }),
    actorOptions: {},
    ...overrides,
  };
}

describe("constructActorFromInvocation", () => {
  it("constructs an opaque configured root without deriving sandbox or privilege from topology", () => {
    const input = invocation({
      record: record({ id: "root-7cf3", parentId: null, isRoot: true }),
      capabilities: ["process-admin", "self-update"],
      workspace: {
        cwd: "/trusted/root-7cf3",
        addDirs: ["/checkout"],
        sandbox: false,
      },
    });

    const actor = constructActorFromInvocation(input);
    const options = (actor as unknown as { opts: ActorOptions }).opts;

    expect(actor).toBeInstanceOf(Actor);
    expect(options.id).toBe("root-7cf3");
    expect(options.cwd).toBe("/trusted/root-7cf3");
    expect(options.sandbox).toBe(false);
    expect(options.addDirs).toEqual(["/checkout"]);
    expect(options.mcpServers).toEqual(input.mcpServers);
    expect(options.modelConfig).toEqual(providerPool);
    expect(options.buildPrompt()).toEqual({ prompt: "configured prompt" });
    expect(input.capabilities).toEqual(["process-admin", "self-update"]);
  });

  it("passes spawned or rehydrated portable-worker inputs unchanged to an injected driver", () => {
    const driverActor = {} as MeshActor;
    const driver = vi.fn(() => driverActor);
    const portablePool: ProviderModelConfig[] = [
      { provider: "provider-a", model: "model-a" },
      { provider: "provider-b", model: "model-b", effort: "low" },
    ];
    const input = invocation({
      record: record({
        id: "worker-opaque-9",
        parentId: "root-7cf3",
        context: { type: "portable", mode: "tail" },
        modelConfig: portablePool,
      }),
      capabilities: ["tracker-read"],
      workspace: { cwd: "/workers/worker-opaque-9", sandbox: true },
      provider: { modelConfig: portablePool, resolveProvider: vi.fn() },
      session: { load: () => undefined, save: vi.fn() },
      driver,
    });

    expect(constructActorFromInvocation(input)).toBe(driverActor);
    expect(driver).toHaveBeenCalledWith(
      input,
      expect.objectContaining({
        id: "worker-opaque-9",
        cwd: "/workers/worker-opaque-9",
        sandbox: true,
        modelConfig: portablePool,
        mcpServers: input.mcpServers,
      })
    );
  });
});
