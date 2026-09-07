import { describe, expect, it } from "vitest";
import type { ActorOptions } from "../actor/actor.js";
import type { RunResult } from "../providers/types.js";
import { composeActorRuntime, createActorRuntime } from "./actor-runtime.js";

const failedResult: RunResult = { success: false, output: "failed", exitCode: 1 };

function baseOptions(): Omit<ActorOptions, "id" | "cwd" | "sandbox" | "onRunEnd"> {
  return {
    modelConfig: [{ provider: "test", model: "test-model" }],
    resolveProvider: () => ({
      name: "test",
      providerName: "test",
      run: async () => failedResult,
    }),
    mcpServers: [],
    loadSessionId: () => undefined,
    saveSessionId: () => {},
    buildPrompt: () => ({ prompt: "test" }),
  };
}

describe("composeActorRuntime", () => {
  it("injects actor and workspace inputs into the selected driver", () => {
    let received: ActorOptions | undefined;

    createActorRuntime({
      actor: { id: "actor-1", parentId: null },
      capabilities: new Set(["inbox"]),
      workspace: { path: "/tmp/actor-1", sandboxed: false },
      driver: {
        kind: "local",
        instantiate: (actorOptions) => {
          received = actorOptions;
          return actorOptions;
        },
      },
      options: baseOptions(),
      terminal: {
        completeRun: () => "run-1",
        logRunEnd: () => {},
        recordRunEnd: () => {},
      },
    });

    expect(received).toMatchObject({ id: "actor-1", cwd: "/tmp/actor-1", sandbox: false });
  });

  it("runs explicitly injected terminal stages in their current order", async () => {
    const stages: string[] = [];
    const options = composeActorRuntime({
      actor: { id: "actor-1", parentId: null },
      capabilities: new Set(["inbox"]),
      workspace: { path: "/tmp/actor-1", sandboxed: false },
      driver: { kind: "local", instantiate: (actorOptions) => actorOptions },
      options: baseOptions(),
      terminal: {
        finishInboxRun: () => stages.push("finish-inbox"),
        completeRun: () => {
          stages.push("complete-run");
          return "run-1";
        },
        logRunEnd: (runId) => stages.push(`log:${runId}`),
        recordRunEnd: (runId) => stages.push(`event:${runId}`),
        compact: async () => {
          stages.push("compact");
        },
        routeFailure: async () => {
          stages.push("route-failure");
        },
      },
    });

    await options.onRunEnd?.(failedResult);

    expect(stages).toEqual([
      "finish-inbox",
      "complete-run",
      "log:run-1",
      "event:run-1",
      "compact",
      "route-failure",
    ]);
  });

  it("keeps terminal bookkeeping explicit and does not route capped outcomes", async () => {
    const stages: string[] = [];
    const options = composeActorRuntime({
      actor: { id: "actor-1", parentId: "parent-1" },
      capabilities: new Set(["inbox", "worker-tool"]),
      workspace: { path: "/tmp/actor-1", sandboxed: true },
      driver: { kind: "external", instantiate: (actorOptions) => actorOptions },
      options: baseOptions(),
      terminal: {
        completeRun: () => {
          stages.push("complete-run");
          return "run-1";
        },
        logRunEnd: () => stages.push("log"),
        recordRunEnd: () => stages.push("event"),
        afterTerminal: () => stages.push("worker-accounting"),
        routeFailure: async () => {
          stages.push("route-failure");
        },
      },
    });

    await options.onRunEnd?.({ ...failedResult, capped: true });

    expect(stages).toEqual(["complete-run", "log", "event", "worker-accounting"]);
  });
});
