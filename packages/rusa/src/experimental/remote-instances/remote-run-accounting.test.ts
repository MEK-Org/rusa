import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorOptions } from "../../actor/actor.js";
import type { ActorFactoryContext } from "../../actor/actor-mesh.js";
import { createRunAccounting } from "../../actor/run-accounting.js";
import { runMigrations } from "../../db/migrations/runner.js";
import { ActorRunRepository } from "../../db/repositories/actor-run-repository.js";
import type { RunResult } from "../../providers/types.js";
import { ActorHandle } from "./actor-handle.js";
import { RemoteInstance } from "./remote-instance.js";

/**
 * Terminal accounting for a remotely hosted actor, against the leader's real
 * durable ledger rather than a lightweight double.
 *
 * The ledger is deliberately strict — completing a run that was never started
 * throws, and a run completes once — so these cases are the ones a smoke run
 * never reaches: a follower that dies before the actor boots, one that drops
 * while its actor sits idle, one that drops mid-run, and one that drops just as
 * a completion lands.
 */
const ACTOR_ID = "remote-actor";
const RESULT: RunResult = { success: true, output: "done", exitCode: 0 };

describe("remote actor run accounting", () => {
  let db: Database.Database;
  let runs: ActorRunRepository;
  let remote: RemoteInstance;
  let handle: ActorHandle;
  let failures: Error[];
  let accountingErrors: string[];

  const openRuns = () =>
    db
      .prepare("SELECT id FROM actor_runs WHERE actor_id = ? AND outcome IS NULL")
      .all(ACTOR_ID) as Array<{ id: string }>;
  const allRuns = () =>
    db
      .prepare("SELECT outcome, success FROM actor_runs WHERE actor_id = ? ORDER BY started_at")
      .all(ACTOR_ID) as Array<{ outcome: string | null; success: number | null }>;

  /** Everything the follower does to the leader, over a real instance channel. */
  const followerSends = (message: Parameters<RemoteInstance["receive"]>[0]["message"]) =>
    remote.receive({ actorId: ACTOR_ID, message });
  const bootActor = () => followerSends({ type: "ready", pid: 4242 });
  const startRun = () =>
    followerSends({
      type: "runStart",
      responsive: false,
      selected: { provider: "codex", model: "gpt-5.5" },
    });
  /** The follower's own run-end call: a request the leader must answer. */
  const reportComplete = (result: RunResult = RESULT) =>
    followerSends({ type: "request", requestId: 1, request: { op: "complete", result } });
  const followerDies = () => remote.close();

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    runs = new ActorRunRepository(db);
    failures = [];
    accountingErrors = [];
    const accounting = createRunAccounting(() => runs);
    remote = new RemoteInstance("test-follower", process.platform, process.pid);

    const context = {
      executionTarget: "test-follower",
      record: { id: ACTOR_ID },
      getRecord: () => ({ id: ACTOR_ID }),
      onRunEnd: (result: RunResult) => accounting.complete(ACTOR_ID, result),
      onRuntimeStateChanged: () => {},
      onQueued: () => {},
    } as unknown as ActorFactoryContext;

    const actorOptions = {
      modelConfig: [{ provider: "codex", model: "gpt-5.5" }],
      onRunStart: (_responsive: boolean, _inject: unknown, selected: { provider: string }) => {
        accounting.begin(ACTOR_ID, selected.provider);
      },
      log: (chunk: string) => {
        if (chunk.includes("run accounting failed")) accountingErrors.push(chunk);
      },
    } as unknown as ActorOptions;

    handle = new ActorHandle({
      host: remote.createHost(ACTOR_ID),
      bootstrap: { id: ACTOR_ID, cwd: "/tmp/remote-actor" },
      context,
      actorOptions,
      snapshot: () => {
        throw new Error("not admitted in this test");
      },
      saveSession: () => {},
      onFailure: (error) => failures.push(error),
    });
  });

  afterEach(() => {
    handle.close();
    db.close();
  });

  it("records nothing when the follower dies before the actor boots", async () => {
    followerDies();
    await handle.exited;

    expect(failures).toHaveLength(1);
    expect(allRuns()).toEqual([]);
    expect(accountingErrors).toEqual([]);
  });

  it("records nothing when the follower drops while the actor is idle", async () => {
    bootActor();
    await expect(handle.ready).resolves.toBe(4242);

    followerDies();
    await handle.exited;

    expect(allRuns()).toEqual([]);
    expect(accountingErrors).toEqual([]);
  });

  it("fails the in-flight run exactly once when the follower drops mid-run", async () => {
    bootActor();
    startRun();
    expect(openRuns()).toHaveLength(1);

    followerDies();
    await handle.exited;
    // The failure path is asynchronous; let its accounting settle.
    await Promise.resolve();

    expect(allRuns()).toEqual([{ outcome: "completed", success: 0 }]);
    expect(accountingErrors).toEqual([]);
  });

  it("keeps one completion when a disconnect races the run's own completion", async () => {
    bootActor();
    startRun();

    reportComplete();
    followerDies();
    await handle.exited;
    await Promise.resolve();

    expect(allRuns()).toEqual([{ outcome: "completed", success: 1 }]);
    expect(accountingErrors).toEqual([]);
  });

  it("keeps one completion when the completion lands just after a disconnect", async () => {
    bootActor();
    startRun();

    followerDies();
    reportComplete();
    await handle.exited;
    await Promise.resolve();

    expect(allRuns()).toEqual([{ outcome: "completed", success: 0 }]);
    expect(accountingErrors).toEqual([]);
  });
});
