import { describe, expect, it } from "vitest";
import type { ActorOptions } from "../../actor/actor.js";
import type { ActorFactoryContext } from "../../actor/actor-mesh.js";
import type { RusaConfig } from "../../config/types.js";
import type { RunResult } from "../../providers/types.js";
import type { ActorHandle } from "./actor-handle.js";
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
    rootActor: { provider: "codex" },
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

  it("refuses to place an actor declaring more than one candidate", () => {
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
    const options = {
      modelConfig: [
        { provider: "codex", model: "gpt-5.5" },
        { provider: "claude", model: "claude-opus-5" },
      ],
    } as unknown as ActorOptions;

    expect(() => instanceWorkerFactory(configWith({}), hub)(context, options)).toThrow(
      /single declared provider\/model/
    );
  });
});
