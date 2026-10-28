import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ActorRecord } from "../actor/actor-record.js";
import { type FailureSinkDeps, routeRunFailure } from "../actor/failure-sink.js";
import { createRunAccounting } from "../actor/run-accounting.js";
import { runMigrations } from "../db/migrations/runner.js";
import { createActorRunModelConfig } from "../db/repositories/actor-run-model-config.js";
import { ActorRunRepository, captureRunOutput } from "../db/repositories/actor-run-repository.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import type { RunResult } from "../providers/types.js";
import { boundRunResult, outputOmittedChars } from "./run-material.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const bound = (result: RunResult) =>
  boundRunResult(result, { bytes: Buffer.byteLength(result.output), sha256: sha(result.output) });

/** Outputs that exercise the cut: empty, at the bound, past it, and an astral pair split by it. */
const OUTPUTS = [
  "",
  "short",
  "a".repeat(40_000),
  `Error: real cause\n${"b".repeat(80_000)}\nlast line`,
  `${"c".repeat(10)}${"🙂".repeat(30_000)}`,
];

function failureNotice(result: RunResult): Promise<string> {
  const notices: string[] = [];
  const deps: FailureSinkDeps = {
    actors: {
      get: (id: string) =>
        ({ id, parentId: id === "child" ? "parent" : null }) as unknown as ActorRecord,
    },
    sendToParent: (_to, body) => notices.push(body),
    postToErrorChat: (text) => notices.push(text),
    rootId: "root",
    log: () => {},
  };
  return routeRunFailure(deps, "child", result, "claude/opus @ high", "run-1").then(() => {
    expect(notices).toHaveLength(1);
    return notices[0];
  });
}

describe("bounded completion leader parity", () => {
  it("renders actor_runs.output and the run_end body byte-identically", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const runs = new ActorRunRepository(db);
    const events = new MeshEventRepository(db);
    const accounting = createRunAccounting(() => runs);
    for (const [index, output] of OUTPUTS.entries()) {
      const full: RunResult = { success: true, exitCode: 0, output };
      const bounded = bound(full);
      expect(captureRunOutput(bounded.output, outputOmittedChars(bounded))).toBe(
        captureRunOutput(output)
      );
      for (const [label, result] of [
        ["legacy", full],
        ["bounded", bounded],
      ] as const) {
        const runId = `${label}-${index}`;
        accounting.begin(
          "worker",
          runId,
          createActorRunModelConfig({ provider: "claude", model: "opus" })
        );
        accounting.complete("worker", runId, result);
        events.record({
          id: `event-${runId}`,
          kind: "run_end",
          actorId: "worker",
          body: result.output,
          bodyOmittedChars: outputOmittedChars(result),
        });
      }
      expect(runs.getById(`bounded-${index}`)?.output).toBe(
        runs.getById(`legacy-${index}`)?.output
      );
      expect(events.getById(`event-bounded-${index}`)?.body).toBe(
        events.getById(`event-legacy-${index}`)?.body
      );
    }
  });

  it("produces the same failure notice, exit description, stage and diagnostic", async () => {
    const cases: RunResult[] = OUTPUTS.flatMap((output) => [
      { success: false, exitCode: 1, output },
      {
        success: false,
        exitCode: -1,
        output,
        abortReason: "stall-watchdog",
        failure: { stage: "provider-selection", message: "" },
      },
      {
        success: false,
        exitCode: 2,
        output,
        abortReason: "interrupt:watchdog",
        interruptSource: "watchdog",
      },
      {
        success: false,
        exitCode: 3,
        output,
        failure: { message: `Error: ${"m".repeat(2_000)}` },
      },
    ]);
    for (const full of cases) {
      expect(await failureNotice(bound(full))).toBe(await failureNotice(full));
    }
  });
});
