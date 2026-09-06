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

  it("completeIfActive reports whether there was anything to close", () => {
    expect(accounting.completeIfActive("actor-a", RESULT)).toBeNull();

    const runId = accounting.begin("actor-a", "codex");
    expect(accounting.completeIfActive("actor-a", RESULT)).toBe(runId);
    expect(accounting.completeIfActive("actor-a", RESULT)).toBeNull();
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
