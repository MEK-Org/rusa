import { describe, expect, it } from "vitest";
import type { ActorOptions } from "../actor/actor.js";
import type { RunResult } from "../providers/types.js";
import { composeActorRuntime } from "./actor-runtime.js";

const failedResult: RunResult = { success: false, output: "failed", exitCode: 1 };

function baseOptions(): Omit<ActorOptions, "onRunEnd"> {
  return {
    id: "actor-1",
    cwd: "/tmp/actor-1",
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
  it("runs the explicit root terminal stages in their current order", async () => {
    const stages: string[] = [];
    const options = composeActorRuntime({
      identity: { actorId: "actor-1", role: "root" },
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

  it("keeps worker bookkeeping explicit and does not route capped outcomes", async () => {
    const stages: string[] = [];
    const options = composeActorRuntime({
      identity: { actorId: "actor-1", role: "worker" },
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
