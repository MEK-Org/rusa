import { describe, expect, it, vi } from "vitest";
import { Actor, type ActorOptions } from "../actor/actor.js";
import type { MeshActor } from "../actor/actor-mesh.js";
import type { ProviderModelConfig, RawProviderModelConfig } from "../providers/model-config.js";
import { constructActorFromInvocation } from "./actor-invocation.js";

const providerPool: RawProviderModelConfig[] = [
  { provider: "provider-a", model: "model-a", effort: "high" },
];

function actorOptions(overrides: Partial<ActorOptions> = {}): ActorOptions {
  return {
    id: "opaque-actor-id",
    cwd: "/isolated/opaque-actor-id",
    modelConfig: providerPool,
    resolveProvider: vi.fn(),
    mcpServers: [{ name: "mesh", url: "http://127.0.0.1:1/mcp" }],
    sandbox: false,
    loadSessionId: () => "native-session",
    saveSessionId: vi.fn(),
    buildPrompt: () => ({ prompt: "configured prompt" }),
    ...overrides,
  };
}

describe("constructActorFromInvocation", () => {
  it("constructs the local actor when no execution driver is configured", () => {
    expect(constructActorFromInvocation({ actorOptions: actorOptions() })).toBeInstanceOf(Actor);
  });

  it("passes configured-root options unchanged to its execution driver", () => {
    const driverActor = {} as MeshActor;
    const driver = vi.fn(() => driverActor);
    const options = actorOptions({
      id: "root-7cf3",
      cwd: "/trusted/root-7cf3",
      sandbox: false,
      addDirs: ["/checkout"],
    });

    expect(constructActorFromInvocation({ actorOptions: options, driver })).toBe(driverActor);
    expect(driver).toHaveBeenCalledWith(options);
  });

  it("passes spawned or rehydrated portable-worker options unchanged to its execution driver", () => {
    const driverActor = {} as MeshActor;
    const driver = vi.fn(() => driverActor);
    const portablePool: ProviderModelConfig[] = [
      { provider: "provider-a", model: "model-a" },
      { provider: "provider-b", model: "model-b", effort: "low" },
    ];
    const options = actorOptions({
      id: "worker-opaque-9",
      cwd: "/workers/worker-opaque-9",
      sandbox: true,
      modelConfig: portablePool,
    });

    expect(constructActorFromInvocation({ actorOptions: options, driver })).toBe(driverActor);
    expect(driver).toHaveBeenCalledWith(options);
  });
});
