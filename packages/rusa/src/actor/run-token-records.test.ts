import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../db/index.js";
import { createActorRunModelConfig } from "../db/repositories/actor-run-model-config.js";
import { ActorRunRepository } from "../db/repositories/actor-run-repository.js";
import {
  createRunReceipt,
  runReceiptDigest,
  serializeRunReceipt,
} from "../db/repositories/run-receipt.js";
import { InstanceRunReceiptRepository } from "../db/repositories/run-receipt-repository.js";
import { SqliteActorRepository } from "../db/repositories/sqlite-actor-repository.js";
import type { RunTokenUsage } from "../providers/token-accounting.js";
import type { RunResult } from "../providers/types.js";
import { ActorHandle } from "../remote-instances/actor-handle.js";
import { RemoteInstance } from "../remote-instances/remote-instance.js";
import { type ActorFactoryContext, ActorMesh, type MeshActor } from "./actor-mesh.js";
import type { ActorRecord } from "./actor-record.js";
import { analyzeTokenRecords, applyTokenRecordsBackfill } from "./backfill-run-token-records.js";
import { createRunAccounting, projectActorRunLaunchConfig } from "./run-accounting.js";

const MODEL_CONFIG = createActorRunModelConfig({
  provider: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
});

function fakeActor(id: string): MeshActor {
  return {
    id,
    requestRun: () => {},
    markUnkillable: () => {},
    preemptForResponsive: () => ({ preempted: false as const }),
    close: () => {},
    get isRunning() {
      return false;
    },
    get isQueued() {
      return false;
    },
  };
}

describe("run_token_records run identity", () => {
  let tmpDir: string;
  let runs: ActorRunRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rusa-token-test-"));
    const db = initDb(tmpDir);
    runs = new ActorRunRepository(db);
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("characterizes bug #442: multiple runs for one actor must yield token records joined by actor_runs.id, not actor id", async () => {
    const db = getDb();
    const actorRecords = new SqliteActorRepository(db);
    const accounting = createRunAccounting(() => runs);

    actorRecords.upsert({
      id: "root",
      charter: "Root Orchestrator",
      parentId: null,
      executionConfig: { unsandboxed: true },
      status: "active",
      createdAt: new Date().toISOString(),
    });

    let factoryCtx: ActorFactoryContext | undefined;
    const mesh = new ActorMesh({
      actors: actorRecords,
      rootId: "root",
      createActor: (ctx) => {
        factoryCtx = ctx;
        return fakeActor(ctx.record.id);
      },
    });

    const workerId = mesh.spawn({
      charter: "worker charter",
      parentId: "root",
      modelConfig: { provider: "codex", model: "gpt-5.6-sol" },
    });

    expect(factoryCtx).toBeDefined();
    if (!factoryCtx) throw new Error("factoryCtx not initialized");

    // Run 1 for actor
    const runId1 = "run-1";
    accounting.begin(workerId, runId1, MODEL_CONFIG);
    const result1: RunResult = {
      success: true,
      output: "run 1 finished",
      exitCode: 0,
      tokenUsage: {
        provider: "codex",
        model: "gpt-5.6-sol",
        scrapedAt: new Date().toISOString(),
        uncachedInput: 1000,
        cacheRead: 200,
        output: 300,
        reasoning: null,
        response: null,
      },
    };
    accounting.complete(workerId, runId1, result1);
    await factoryCtx.lifecycle.emit("onEnd", {
      actorId: workerId,
      runId: runId1,
      terminal: { kind: "result", result: result1 },
    });

    // Run 2 for actor
    const runId2 = "run-2";
    accounting.begin(workerId, runId2, MODEL_CONFIG);
    const result2: RunResult = {
      success: true,
      output: "run 2 finished",
      exitCode: 0,
      tokenUsage: {
        provider: "codex",
        model: "gpt-5.6-sol",
        scrapedAt: new Date().toISOString(),
        uncachedInput: 1500,
        cacheRead: 400,
        output: 500,
        reasoning: null,
        response: null,
      },
    };
    accounting.complete(workerId, runId2, result2);
    await factoryCtx.lifecycle.emit("onEnd", {
      actorId: workerId,
      runId: runId2,
      terminal: { kind: "result", result: result2 },
    });

    // 1. Token records must NOT store the actor ID in run_id
    const actorIdMatches = db
      .prepare("SELECT count(*) as cnt FROM run_token_records WHERE run_id = ?")
      .get(workerId) as { cnt: number };
    expect(actorIdMatches.cnt).toBe(0);

    // 2. Token records must join exactly to actor_runs.id for each run
    const joinedRuns = db
      .prepare(
        `SELECT rtr.id as token_record_id, rtr.run_id, ar.id as run_id_fk, ar.actor_id
         FROM run_token_records rtr
         JOIN actor_runs ar ON rtr.run_id = ar.id
         WHERE ar.actor_id = ?
         ORDER BY ar.started_at`
      )
      .all(workerId) as Array<{
      token_record_id: string;
      run_id: string;
      run_id_fk: string;
      actor_id: string;
    }>;

    expect(joinedRuns).toHaveLength(2);
    expect(joinedRuns[0].run_id).toBe(runId1);
    expect(joinedRuns[0].actor_id).toBe(workerId);
    expect(joinedRuns[1].run_id).toBe(runId2);
    expect(joinedRuns[1].actor_id).toBe(workerId);
  });

  it("requires runId when tokenUsage is present, and throws if runId is omitted", async () => {
    const db = getDb();
    const actorRecords = new SqliteActorRepository(db);
    const accounting = createRunAccounting(() => runs);

    actorRecords.upsert({
      id: "root",
      charter: "Root",
      parentId: null,
      executionConfig: { unsandboxed: true },
      status: "active",
      createdAt: new Date().toISOString(),
    });

    let factoryCtx: ActorFactoryContext | undefined;
    const mesh = new ActorMesh({
      actors: actorRecords,
      rootId: "root",
      createActor: (ctx) => {
        factoryCtx = ctx;
        return fakeActor(ctx.record.id);
      },
    });

    const workerId = mesh.spawn({
      charter: "token worker",
      parentId: "root",
      modelConfig: { provider: "codex", model: "gpt-5.6-sol" },
    });
    expect(factoryCtx).toBeDefined();
    if (!factoryCtx) throw new Error("factoryCtx not initialized");

    // Run created in actor_runs
    const runId = "run-1";
    accounting.begin(workerId, runId, MODEL_CONFIG);
    const resultWithTokens: RunResult = {
      success: true,
      output: "done",
      exitCode: 0,
      tokenUsage: {
        provider: "codex",
        model: "gpt-5.6-sol",
        scrapedAt: new Date().toISOString(),
        uncachedInput: 500,
        cacheRead: 0,
        output: 100,
        reasoning: null,
        response: null,
      },
    };
    accounting.complete(workerId, runId, resultWithTokens);

    // Call without passing runId: throws because token accounting requires explicit runId
    expect(() => mesh.accountRun(workerId, resultWithTokens)).toThrow(
      /token accounting requires a runId/
    );

    // Call with runId: succeeds
    expect(() => mesh.accountRun(workerId, resultWithTokens, runId)).not.toThrow();

    const record = db.prepare("SELECT run_id FROM run_token_records WHERE run_id = ?").get(runId) as
      | { run_id: string }
      | undefined;
    expect(record?.run_id).toBe(runId);

    // Call without tokenUsage: does not require runId and succeeds without throwing
    const resultWithoutTokens: RunResult = {
      success: true,
      output: "done without tokens",
      exitCode: 0,
    };
    expect(() => mesh.accountRun(workerId, resultWithoutTokens)).not.toThrow();
  });

  describe("backfill-run-token-records", () => {
    it("deterministically updates legacy rows and safely skips ambiguous or colliding rows without guessing", () => {
      const db = getDb();
      const actorId = "legacy-actor-1";
      const runId1 = "run-001";
      const runId2 = "run-002";

      // 1. Setup actor_runs for legacy actor
      db.prepare(
        `INSERT INTO actor_runs (id, actor_id, started_at, ended_at, outcome, success)
         VALUES (?, ?, ?, ?, 'completed', 1)`
      ).run(runId1, actorId, "2026-08-01T10:00:00.000Z", "2026-08-01T10:05:00.000Z");

      db.prepare(
        `INSERT INTO actor_runs (id, actor_id, started_at, ended_at, outcome, success)
         VALUES (?, ?, ?, ?, 'completed', 1)`
      ).run(runId2, actorId, "2026-08-01T11:00:00.000Z", "2026-08-01T11:05:00.000Z");

      // 2. Insert legacy token records carrying actorId in run_id
      const tok1 = randomUUID();
      const tok2 = randomUUID();
      db.prepare(
        `INSERT INTO run_token_records (id, run_id, provider, model, scraped_at, uncached_input, output)
         VALUES (?, ?, 'codex', 'gpt-5.6-sol', '2026-08-01T10:04:59.000Z', 100, 50)`
      ).run(tok1, actorId);

      db.prepare(
        `INSERT INTO run_token_records (id, run_id, provider, model, scraped_at, uncached_input, output)
         VALUES (?, ?, 'codex', 'gpt-5.6-sol', '2026-08-01T11:04:59.000Z', 200, 80)`
      ).run(tok2, actorId);

      // 3. Insert an already-correct row (run_id matches actor_runs.id directly)
      const correctTok = randomUUID();
      db.prepare(
        `INSERT INTO run_token_records (id, run_id, provider, model, scraped_at, uncached_input, output)
         VALUES (?, ?, 'codex', 'gpt-5.6-sol', '2026-08-01T10:05:00.000Z', 100, 50)`
      ).run(correctTok, runId1);

      // 4. Insert an ambiguous case: actor with two overlapping candidate runs
      const ambActor = "ambiguous-actor";
      const ambRunA = "amb-run-A";
      const ambRunB = "amb-run-B";
      db.prepare(
        `INSERT INTO actor_runs (id, actor_id, started_at, ended_at, outcome, success)
         VALUES (?, ?, '2026-08-01T12:00:00.000Z', '2026-08-01T12:10:00.000Z', 'completed', 1)`
      ).run(ambRunA, ambActor);
      db.prepare(
        `INSERT INTO actor_runs (id, actor_id, started_at, ended_at, outcome, success)
         VALUES (?, ?, '2026-08-01T12:05:00.000Z', '2026-08-01T12:15:00.000Z', 'completed', 1)`
      ).run(ambRunB, ambActor);

      const ambTok = randomUUID();
      db.prepare(
        `INSERT INTO run_token_records (id, run_id, provider, model, scraped_at, uncached_input, output)
         VALUES (?, ?, 'codex', 'gpt-5.6-sol', '2026-08-01T12:07:00.000Z', 100, 50)`
      ).run(ambTok, ambActor);

      // 5. Insert an unresolvable case: scraped_at outside any run
      const unresTok = randomUUID();
      db.prepare(
        `INSERT INTO run_token_records (id, run_id, provider, model, scraped_at, uncached_input, output)
         VALUES (?, ?, 'codex', 'gpt-5.6-sol', '2026-08-01T20:00:00.000Z', 100, 50)`
      ).run(unresTok, actorId);

      // Analyze
      const plan = analyzeTokenRecords(db);
      expect(plan.totalRecords).toBe(5);
      expect(plan.alreadyCorrect).toHaveLength(1);
      expect(plan.deterministicallyResolved).toHaveLength(2);
      expect(plan.ambiguous).toHaveLength(1);
      expect(plan.ambiguous[0].tokenRecord.id).toBe(ambTok);
      expect(plan.unresolvable).toHaveLength(1);
      expect(plan.unresolvable[0].tokenRecord.id).toBe(unresTok);

      // Apply
      const { updated } = applyTokenRecordsBackfill(db, plan);
      expect(updated).toBe(2);

      // Verify db changes
      const r1 = db.prepare("SELECT run_id FROM run_token_records WHERE id = ?").get(tok1) as {
        run_id: string;
      };
      expect(r1.run_id).toBe(runId1);

      const r2 = db.prepare("SELECT run_id FROM run_token_records WHERE id = ?").get(tok2) as {
        run_id: string;
      };
      expect(r2.run_id).toBe(runId2);

      // Ambiguous and unresolvable remain unchanged
      const rAmb = db.prepare("SELECT run_id FROM run_token_records WHERE id = ?").get(ambTok) as {
        run_id: string;
      };
      expect(rAmb.run_id).toBe(ambActor);

      const rUnres = db
        .prepare("SELECT run_id FROM run_token_records WHERE id = ?")
        .get(unresTok) as { run_id: string };
      expect(rUnres.run_id).toBe(actorId);

      // Re-running analyze shows resolved rows are now in alreadyCorrect (idempotent)
      const rePlan = analyzeTokenRecords(db);
      expect(rePlan.alreadyCorrect).toHaveLength(3);
      expect(rePlan.deterministicallyResolved).toHaveLength(0);
    });

    it("maps multiple token records contained in the same candidate run interval to that run", () => {
      const db = getDb();
      const actorId = "multi-turn-actor";
      const runId = "run-multi-turn";

      db.prepare(
        `INSERT INTO actor_runs (id, actor_id, started_at, ended_at, outcome, success)
         VALUES (?, ?, '2026-08-01T15:00:00.000Z', '2026-08-01T15:10:00.000Z', 'completed', 1)`
      ).run(runId, actorId);

      const tokA = randomUUID();
      const tokB = randomUUID();
      db.prepare(
        `INSERT INTO run_token_records (id, run_id, provider, model, scraped_at, uncached_input, output)
         VALUES (?, ?, 'codex', 'gpt-5.6-sol', '2026-08-01T15:02:00.000Z', 100, 20)`
      ).run(tokA, actorId);

      db.prepare(
        `INSERT INTO run_token_records (id, run_id, provider, model, scraped_at, uncached_input, output)
         VALUES (?, ?, 'codex', 'gpt-5.6-sol', '2026-08-01T15:08:00.000Z', 200, 40)`
      ).run(tokB, actorId);

      const plan = analyzeTokenRecords(db);
      expect(plan.deterministicallyResolved).toHaveLength(2);
      expect(plan.collisions).toHaveLength(0);

      const { updated } = applyTokenRecordsBackfill(db, plan);
      expect(updated).toBe(2);

      const rowA = db.prepare("SELECT run_id FROM run_token_records WHERE id = ?").get(tokA) as {
        run_id: string;
      };
      const rowB = db.prepare("SELECT run_id FROM run_token_records WHERE id = ?").get(tokB) as {
        run_id: string;
      };
      expect(rowA.run_id).toBe(runId);
      expect(rowB.run_id).toBe(runId);
    });
  });
});

describe("run_token_records for a remote run whose end the host did not observe (#1119)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rusa-token-remote-"));
    initDb(tmpDir);
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const usage = (uncachedInput: number): RunTokenUsage => ({
    provider: "codex",
    model: "gpt-5.6-sol",
    scrapedAt: "2026-10-20T08:30:00.000Z",
    uncachedInput,
    cacheRead: 0,
    output: 10,
    reasoning: null,
    response: null,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * A real mesh hosting a worker on a remote instance, with the leader's
   * production accounting: the mesh's own lifecycle records token usage, and
   * receipt-backed runs close only from the host's receipt.
   */
  function remoteWorker(runReceipts: boolean) {
    const db = getDb();
    const actorRecords = new SqliteActorRepository(db);
    const runs = new ActorRunRepository(db);
    const leaderReceipts = new InstanceRunReceiptRepository(db);
    const accounting = createRunAccounting(
      () => runs,
      () => leaderReceipts
    );
    actorRecords.upsert({
      id: "root",
      charter: "Root",
      parentId: null,
      executionConfig: { unsandboxed: true },
      status: "active",
      createdAt: new Date().toISOString(),
    });
    const remote = new RemoteInstance("host-a", process.platform, process.pid);
    remote.runReceipts = runReceipts;
    const handles: ActorHandle[] = [];
    const mesh = new ActorMesh({
      actors: actorRecords,
      rootId: "root",
      createActor: (ctx) => {
        ctx.lifecycle.add({
          onStart: (event) =>
            accounting.begin(
              ctx.record.id,
              event.runId,
              projectActorRunLaunchConfig(event.selected),
              event.durableHost
            ),
          onEnd: (event) => {
            if (event.terminal.kind === "result") {
              accounting.complete(ctx.record.id, event.runId, event.terminal.result);
            } else if (event.terminal.started) {
              accounting.abandon(ctx.record.id, event.runId, event.terminal.reason);
            }
          },
        });
        const handle = new ActorHandle({
          host: remote.createHost(ctx.record.id),
          bootstrap: { id: ctx.record.id, cwd: tmpDir },
          context: ctx,
          snapshot: () => ({ record: ctx.getRecord() as ActorRecord, prompt: "fixture" }),
          saveSession: () => {},
          onFailure: () => {},
        });
        handles.push(handle);
        return handle;
      },
    });
    const workerId = mesh.spawn({
      charter: "remote worker",
      parentId: "root",
      modelConfig: { provider: "codex", model: "gpt-5.6-sol" },
    });
    const send = async (message: Parameters<RemoteInstance["receive"]>[0]["message"]) => {
      remote.receive({ actorId: workerId, message });
      await settle();
    };
    const start = (runId: string) =>
      send({
        type: "runStart",
        runId,
        responsive: false,
        selected: { provider: "codex", model: "gpt-5.6-sol" },
      });
    const complete = (requestId: number, result: RunResult) =>
      send({ type: "request", requestId, request: { op: "complete", result } });
    const tokens = () =>
      db
        .prepare("SELECT run_id, uncached_input FROM run_token_records ORDER BY uncached_input")
        .all();
    const leaderRun = (runId: string) =>
      db.prepare("SELECT outcome, output FROM actor_runs WHERE id = ?").get(runId);
    const close = () => {
      for (const handle of handles) handle.close();
      remote.close();
    };
    return { workerId, leaderReceipts, send, start, complete, tokens, leaderRun, close };
  }

  it("records usage from an unproven end once, with its run, and leaves the outcome to the receipt", async () => {
    const w = remoteWorker(true);
    try {
      await w.send({ type: "ready", pid: 4242 });
      await w.start("run-1");
      const unproven: RunResult = {
        success: false,
        exitCode: -1,
        output: "stall watchdog",
        termination: "unproven",
        tokenUsage: usage(100),
      };
      await w.complete(1, unproven);
      expect(w.tokens()).toEqual([{ run_id: "run-1", uncached_input: 100 }]);
      expect(w.leaderRun("run-1")).toEqual({ outcome: null, output: null });

      // A duplicate delivery of the same end, by request or by event, counts nothing more.
      await w.complete(2, unproven);
      await w.send({ type: "result", result: unproven });
      expect(w.tokens()).toEqual([{ run_id: "run-1", uncached_input: 100 }]);

      // The genuine terminal arrives as the host's receipt; it books no usage.
      const receipt = serializeRunReceipt(
        createRunReceipt({
          instanceId: "host-a",
          runId: "run-1",
          actorId: w.workerId,
          endedAt: "2026-10-20T09:00:00.000Z",
          outcome: "completed",
          success: false,
          exitCode: 1,
          output: "genuine",
        })
      );
      expect(
        w.leaderReceipts.apply("host-a", {
          runId: "run-1",
          receipt,
          digest: runReceiptDigest(receipt),
        }).outcome
      ).toEqual({ status: "applied", actorRunClosed: true });
      expect(w.leaderRun("run-1")).toEqual({ outcome: "completed", output: "genuine" });
      expect(w.tokens()).toEqual([{ run_id: "run-1", uncached_input: 100 }]);

      // The next run, observed, is attributed to itself.
      await w.start("run-2");
      await w.complete(3, {
        success: true,
        exitCode: 0,
        output: "observed",
        termination: "observed",
        tokenUsage: usage(200),
      });
      expect(w.tokens()).toEqual([
        { run_id: "run-1", uncached_input: 100 },
        { run_id: "run-2", uncached_input: 200 },
      ]);
      expect(w.leaderRun("run-2")).toEqual({ outcome: null, output: null });
    } finally {
      w.close();
    }
  });

  it("keeps the legacy contract: a host without receipts ends the run with its result", async () => {
    const w = remoteWorker(false);
    try {
      await w.send({ type: "ready", pid: 4242 });
      await w.start("run-1");
      await w.complete(1, {
        success: false,
        exitCode: -1,
        output: "legacy",
        termination: "unproven",
        tokenUsage: usage(100),
      });
      expect(w.tokens()).toEqual([{ run_id: "run-1", uncached_input: 100 }]);
      expect(w.leaderRun("run-1")).toEqual({ outcome: "completed", output: "legacy" });
    } finally {
      w.close();
    }
  });
});
