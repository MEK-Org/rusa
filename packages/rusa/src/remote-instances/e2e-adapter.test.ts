import { describe, expect, it } from "vitest";
import type { ActorOptions } from "../actor/actor.js";
import type { ActorFactoryContext } from "../actor/actor-mesh.js";
import type { RusaConfig } from "../config/types.js";
import type { RunResult } from "../providers/types.js";
import type { ActorHandle } from "./actor-handle.js";
import { createProvider } from "./configured-provider.js";
import { instanceWorkerFactory } from "./e2e-adapter.js";
import type { FollowerHub } from "./follower-hub.js";
import { RemoteInstance } from "./remote-instance.js";

const ACTOR_ID = "placed-actor";
const TARGET = "test-follower";

/**
 * The adapter reads only `providers` and `rootActor`, but it takes the whole
 * config, so the fixture is a real one rather than a cast off a fragment.
 */
function configWith(providers: RusaConfig["providers"]): RusaConfig {
  return {
    github: { account: "test-bot" },
    webhook: { port: 0, secret: "test-secret" },
    providers,
    rootActor: { provider: "codex", model: "gpt-5.6-sol" },
  };
}

/**
 * A connection failure is not a run outcome.
 *
 * The adapter used to synthesize a failed run end for every failure the handle
 * reported, including ones that arrive with no run in flight — a startup
 * timeout, or a follower dropping while its actor sits idle. Leader accounting
 * has no run to close in those cases.
 */
function place() {
  const remote = new RemoteInstance(TARGET, process.platform, process.pid);
  const hub = {
    createHost: (_followerId: string, actorId: string) => remote.createHost(actorId),
    toolUrls: () => [],
  } as unknown as FollowerHub;
  const config = configWith({ codex: { cliCommand: "codex" } });

  const runEnds: RunResult[] = [];
  const context = {
    executionTarget: TARGET,
    record: { id: ACTOR_ID },
    getRecord: () => ({ id: ACTOR_ID }),
    onRunEnd: () => {},
    onRuntimeStateChanged: () => {},
    onQueued: () => {},
  } as unknown as ActorFactoryContext;
  const options = {
    cwd: "/tmp/placed-actor",
    mcpServers: [],
    modelConfig: [{ provider: "codex", model: "gpt-5.5" }],
    loadSessionId: () => undefined,
    saveSessionId: () => {},
    buildPrompt: () => ({ prompt: "" }),
    onRunEnd: (result: RunResult) => {
      runEnds.push(result);
    },
    log: () => {},
  } as unknown as ActorOptions;

  const actor = instanceWorkerFactory(config, hub)(context, options) as ActorHandle;
  return { actor, remote, runEnds };
}

describe("instanceWorkerFactory", () => {
  it("reports no run end when the follower drops while the actor is idle", async () => {
    const { actor, remote, runEnds } = place();
    remote.receive({ actorId: ACTOR_ID, message: { type: "ready", pid: 4242 } });
    await expect(actor.ready).resolves.toBe(4242);

    remote.close();
    await actor.exited;

    expect(runEnds).toEqual([]);
  });

  it("reports no run end when the actor never boots", async () => {
    const { actor, remote, runEnds } = place();
    remote.close();
    await actor.exited;

    expect(runEnds).toEqual([]);
  });

  it("sends a defined-but-blank target to the hub rather than running it locally", () => {
    const hub = {
      createHost: (followerId: string) => {
        throw new Error(`Follower ${followerId} is not connected`);
      },
      toolUrls: () => [],
    } as unknown as FollowerHub;
    const context = {
      executionTarget: "",
      record: { id: ACTOR_ID },
      getRecord: () => ({ id: ACTOR_ID }),
    } as unknown as ActorFactoryContext;
    const options = {
      modelConfig: [{ provider: "codex", model: "gpt-5.5" }],
    } as unknown as ActorOptions;

    // Only an omitted target means "run here"; a blank one is a placement
    // request the hub refuses by name.
    expect(() => instanceWorkerFactory(configWith({}), hub)(context, options)).toThrow(
      /is not connected/
    );
  });

  it("places an actor declaring several candidates with its whole pool (#608)", () => {
    const remote = new RemoteInstance(TARGET, process.platform, process.pid);
    const hub = {
      createHost: (_followerId: string, actorId: string) => remote.createHost(actorId),
      toolUrls: () => [],
    } as unknown as FollowerHub;
    const context = {
      executionTarget: TARGET,
      record: { id: ACTOR_ID },
      getRecord: () => ({ id: ACTOR_ID }),
    } as unknown as ActorFactoryContext;
    const pool = [
      { provider: "codex", model: "gpt-5.5", effort: "high" },
      { provider: "claude", model: "claude-opus-5" },
    ];
    const options = {
      cwd: "/tmp/placed-actor",
      mcpServers: [],
      modelConfig: pool,
      loadSessionId: () => undefined,
    } as unknown as ActorOptions;

    // The follower resolves each admitted tuple itself, so the leader hands it
    // the declared pool and admission picks the candidate per run.
    const config = configWith({ codex: { cliCommand: "codex" }, claude: { cliCommand: "claude" } });
    instanceWorkerFactory(config, hub)(context, options);
    const init = remote.commands.find(
      (command) => "actorId" in command && command.message.type === "init"
    );
    const bootstrap =
      init && "actorId" in init && init.message.type === "init"
        ? init.message.bootstrap
        : undefined;
    expect(bootstrap).toMatchObject({ modelConfig: pool });

    // A deployed follower builds each admitted tuple from these provider
    // options, filling the tuple's unset fields from them. The second
    // candidate must not run at the first one's model or effort.
    const bridge = { sendMessage: async () => "" };
    for (const candidate of pool) {
      const provider = createProvider(bridge, bootstrap?.providerOptions ?? {}, candidate);
      expect({
        name: provider.providerName,
        model: provider.model,
        effort: provider.effort,
      }).toEqual({ name: candidate.provider, model: candidate.model, effort: candidate.effort });
    }
  });
});
