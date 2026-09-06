import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { ActorRunRepository } from "../db/repositories/actor-run-repository.js";
import type { RunResult } from "../providers/types.js";
import { createRunAccounting, type RunAccounting } from "./run-accounting.js";

const RESULT: RunResult = { success: true, output: "done", exitCode: 0 };

describe("createRunAccounting", () => {
  let db: Database.Database;
  let runs: ActorRunRepository;
  let accounting: RunAccounting;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    runs = new ActorRunRepository(db);
    accounting = createRunAccounting(() => runs);
  });

  it("opens and closes one run per actor", () => {
    const runId = accounting.begin("actor-a", "codex");
    expect(accounting.activeRunId("actor-a")).toBe(runId);

    expect(accounting.complete("actor-a", RESULT)).toBe(runId);
    expect(accounting.activeRunId("actor-a")).toBeUndefined();
    expect(runs.getById(runId)).toMatchObject({ outcome: "completed", success: true });
  });

  it("refuses to open a second run for an actor that already has one", () => {
    accounting.begin("actor-a", "codex");
    expect(() => accounting.begin("actor-a", "codex")).toThrow(/already has an active durable run/);
  });

  it("refuses to close a run that was never opened", () => {
    expect(() => accounting.complete("actor-a", RESULT)).toThrow(/no active durable run/);
  });

  it("closes a run once — a second completion finds nothing to close", () => {
    accounting.begin("actor-a", "codex");
    accounting.complete("actor-a", RESULT);
    expect(() => accounting.complete("actor-a", RESULT)).toThrow(/no active durable run/);
  });

  it("keeps the claim when the durable write fails, so the close can be retried", () => {
    let failWrite = false;
    const guard = () => {
      if (failWrite) throw new Error("database is locked");
    };
    // Only the three methods the ledger actually calls; everything else is
    // read straight off the real repository the assertions below inspect.
    const flakyRuns = {
      start: (opts: Parameters<ActorRunRepository["start"]>[0]) => runs.start(opts),
      complete: (...args: Parameters<ActorRunRepository["complete"]>) => {
        guard();
        runs.complete(...args);
      },
      abandon: (...args: Parameters<ActorRunRepository["abandon"]>) => {
        guard();
        runs.abandon(...args);
      },
    } as unknown as ActorRunRepository;
    const flaky = createRunAccounting(() => flakyRuns);

    const runId = flaky.begin("actor-a", "codex");
    failWrite = true;
    expect(() => flaky.complete("actor-a", RESULT)).toThrow(/database is locked/);

    // The row is still open, so the claim has to still name it: dropping the
    // claim first would strand an open run with nothing left in memory able to
    // close it, and would let a second run start over the top of it.
    expect(runs.getById(runId)).toMatchObject({ outcome: null });
    expect(flaky.activeRunId("actor-a")).toBe(runId);
    expect(() => flaky.begin("actor-a", "codex")).toThrow(/already has an active durable run/);

    failWrite = false;
    expect(flaky.complete("actor-a", RESULT)).toBe(runId);
    expect(runs.getById(runId)).toMatchObject({ outcome: "completed", success: true });
  });

  it("keeps the claim when an abandon write fails", () => {
    let failWrite = false;
    const flakyRuns = {
      start: (opts: Parameters<ActorRunRepository["start"]>[0]) => runs.start(opts),
      abandon: (...args: Parameters<ActorRunRepository["abandon"]>) => {
        if (failWrite) throw new Error("database is locked");
        runs.abandon(...args);
      },
    } as unknown as ActorRunRepository;
    const flaky = createRunAccounting(() => flakyRuns);

    const runId = flaky.begin("actor-a", "codex");
    failWrite = true;
    expect(() => flaky.abandon("actor-a", "coalesced")).toThrow(/database is locked/);
    expect(flaky.activeRunId("actor-a")).toBe(runId);

    failWrite = false;
    expect(flaky.abandon("actor-a", "coalesced")).toBe(runId);
    expect(runs.getById(runId)).toMatchObject({ outcome: "abandoned" });
  });

  it("abandons an open run and reports none when there is nothing open", () => {
    const runId = accounting.begin("actor-a", "codex");
    expect(accounting.abandon("actor-a", "coalesced")).toBe(runId);
    expect(runs.getById(runId)).toMatchObject({ outcome: "abandoned", abandonReason: "coalesced" });
    expect(accounting.abandon("actor-a", "coalesced")).toBeNull();
  });

  it("keeps each actor's run separate", () => {
    const a = accounting.begin("actor-a", "codex");
    const b = accounting.begin("actor-b", "claude");
    expect(a).not.toBe(b);

    accounting.complete("actor-a", RESULT);
    expect(accounting.activeRunId("actor-b")).toBe(b);
  });
});
