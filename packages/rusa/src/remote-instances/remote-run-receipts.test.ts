import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorOptions } from "../actor/actor.js";
import { type ActorLifecycleEndEvent, createActorLifecycle } from "../actor/actor-lifecycle.js";
import type { ActorFactoryContext } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import { createRunAccounting, projectActorRunLaunchConfig } from "../actor/run-accounting.js";
import { runMigrations } from "../db/migrations/runner.js";
import { ActorRunRepository } from "../db/repositories/actor-run-repository.js";
import type { RunReceiptEnvelope } from "../db/repositories/run-receipt.js";
import {
  HostRunReceiptRepository,
  InstanceRunReceiptRepository,
} from "../db/repositories/run-receipt-repository.js";
import type { Logger } from "../observability/logger.js";
import type { RunResult, RunTermination } from "../providers/types.js";
import { ActorHandle } from "./actor-handle.js";
import { RemoteInstance } from "./remote-instance.js";

/**
 * A receipt-backed remote run (#1020) against two real databases: the
 * leader's ledger and the executing host's. A transport loss is never the
 * run's exit; only the host's committed receipt closes the leader's row.
 */
const ACTOR_ID = "remote-actor";
const HOST_ID = "host-a";
/** A result whose provider exit the host observed. */
const RESULT: RunResult = {
  success: true,
  output: "host result",
  exitCode: 0,
  termination: "observed",
};

describe("receipt-backed remote runs (#1020)", () => {
  let leaderDb: Database.Database;
  let hostDb: Database.Database;
  let leaderReceipts: InstanceRunReceiptRepository;
  let hostReceipts: HostRunReceiptRepository;
  let remote: RemoteInstance;
  let handle: ActorHandle;
  let context: ActorFactoryContext;
  let ends: ActorLifecycleEndEvent[];
  let listenerFailures: unknown[];
  let logged: Array<{ event: string; fields?: Record<string, unknown> }>;

  const leaderRuns = () =>
    leaderDb
      .prepare("SELECT id, outcome, success, exit_code, output, abandon_reason FROM actor_runs")
      .all() as Array<Record<string, unknown>>;
  const followerSends = (message: Parameters<RemoteInstance["receive"]>[0]["message"]) =>
    remote.receive({ actorId: ACTOR_ID, message });
  const startRun = (runId: string) => {
    // The host opens its own receipt-backed row for the same run id before reporting it.
    hostReceipts.start({
      id: runId,
      actorId: ACTOR_ID,
      modelConfig: projectActorRunLaunchConfig({ provider: "codex", model: "gpt-5.5" }),
    });
    return followerSends({
      type: "runStart",
      runId,
      responsive: false,
      selected: { provider: "codex", model: "gpt-5.5" },
    });
  };
  /** The host commits its terminal and receipt, and the leader applies each pending one. */
  const deliverReceipt = (
    runId: string,
    result: RunResult = RESULT,
    termination: RunTermination = "observed"
  ) => {
    hostReceipts.complete(runId, ACTOR_ID, result, termination);
    const pending = hostReceipts.listUnacked(0, 10);
    for (const entry of pending) sent.set(entry.envelope.runId, entry.envelope);
    const outcomes = pending.map((entry) => leaderReceipts.apply(HOST_ID, entry.envelope));
    hostReceipts.markAcked(pending.map((entry) => entry.envelope.runId));
    return outcomes;
  };
  /** Each run's delivered bytes, which a resend after a lost acknowledgment repeats. */
  let sent: Map<string, RunReceiptEnvelope>;
  const receiptFor = (runId: string) => {
    const envelope = sent.get(runId);
    if (!envelope) throw new Error(`no receipt delivered for ${runId}`);
    return envelope;
  };

  beforeEach(() => {
    leaderDb = new Database(":memory:");
    runMigrations(leaderDb);
    hostDb = new Database(":memory:");
    runMigrations(hostDb);
    leaderReceipts = new InstanceRunReceiptRepository(leaderDb);
    hostReceipts = new HostRunReceiptRepository(hostDb, HOST_ID);
    ends = [];
    listenerFailures = [];
    sent = new Map();
    const leaderLedger = new ActorRunRepository(leaderDb);
    logged = [];
    const logger: Logger = {
      debug: () => {},
      info: (event, fields) => logged.push({ event, fields }),
      warn: () => {},
      error: () => {},
      child: () => logger,
    };
    const accounting = createRunAccounting(
      () => leaderLedger,
      () => leaderReceipts,
      logger
    );
    context = {
      executionTarget: HOST_ID,
      record: { id: ACTOR_ID },
      getRecord: () => ({ id: ACTOR_ID }),
      lifecycle: createActorLifecycle(
        [
          {
            onStart: (event) =>
              accounting.begin(
                ACTOR_ID,
                event.runId,
                projectActorRunLaunchConfig(event.selected),
                event.durableHost
              ),
            onEnd: (event) => {
              ends.push(event);
              if (event.terminal.kind === "result") {
                accounting.complete(ACTOR_ID, event.runId, event.terminal.result);
              } else if (event.terminal.started) {
                accounting.abandon(ACTOR_ID, event.runId, event.terminal.reason);
              }
            },
          },
        ],
        (failure) => listenerFailures.push(failure.error)
      ),
      onRuntimeStateChanged: () => {},
    } as unknown as ActorFactoryContext;
    connect();
  });

  /** A host generation registers and the leader hosts the actor on it. */
  const connect = (receipts = true) => {
    remote = new RemoteInstance(HOST_ID, process.platform, process.pid);
    remote.runReceipts = receipts;
    handle = new ActorHandle({
      host: remote.createHost(ACTOR_ID),
      bootstrap: { id: ACTOR_ID, cwd: "/tmp/remote-actor" },
      context,
      actorOptions: {
        modelConfig: [{ provider: "codex", model: "gpt-5.5" }],
      } as unknown as ActorOptions,
      snapshot: () => ({ record: { id: ACTOR_ID } as ActorRecord, prompt: "fixture" }),
      saveSession: () => {},
      onFailure: () => {},
    });
    followerSends({ type: "ready", pid: 4242 });
  };
  const leaderRun = (runId: string) => leaderRuns().find((run) => run.id === runId);

  afterEach(() => {
    handle.close();
    leaderDb.close();
    hostDb.close();
  });

  it("does not fabricate an exit when the host drops mid-run, and applies its receipt later", async () => {
    await startRun("run-1");
    expect(leaderRuns()).toEqual([expect.objectContaining({ id: "run-1", outcome: null })]);
    expect(leaderReceipts.isReceiptBacked("run-1")).toBe(true);

    remote.close();
    await handle.exited;
    await Promise.resolve();

    // The leader releases its in-memory claim as host-unavailable, labelled
    // unresolved with the cause, and books nothing.
    expect(ends.map((event) => event.terminal)).toEqual([
      {
        kind: "abandoned",
        reason: "host-unavailable",
        started: true,
        unresolved: { cause: expect.any(String) },
      },
    ]);
    expect(leaderRuns()).toEqual([expect.objectContaining({ id: "run-1", outcome: null })]);
    expect(listenerFailures).toEqual([]);

    // The host's real terminal arrives as a receipt, after the connection is gone.
    const [applied] = deliverReceipt("run-1");
    expect(applied.outcome).toEqual({ status: "applied", actorRunClosed: true });
    expect(leaderRuns()).toEqual([
      {
        id: "run-1",
        outcome: "completed",
        success: 1,
        exit_code: 0,
        output: "host result",
        abandon_reason: null,
      },
    ]);
    // Both databases agree on the terminal.
    expect(hostDb.prepare("SELECT outcome, output FROM actor_runs").get()).toEqual({
      outcome: "completed",
      output: "host result",
    });
  });

  it("applies a late receipt once, after the actor's next run has started on a new host generation", async () => {
    await startRun("run-1");
    remote.close();
    await handle.exited;
    await Promise.resolve();

    // The settled claim is free: the next generation starts run-2 meanwhile.
    connect();
    await startRun("run-2");
    expect(listenerFailures).toEqual([]);
    expect(leaderRuns().map((run) => [run.id, run.outcome])).toEqual([
      ["run-1", null],
      ["run-2", null],
    ]);

    const [applied] = deliverReceipt("run-1");
    expect(applied.outcome).toMatchObject({ status: "applied", actorRunClosed: true });
    expect(leaderRun("run-1")).toMatchObject({ outcome: "completed", output: "host result" });
    expect(leaderRun("run-2")).toMatchObject({ outcome: null });

    // A re-delivery after a lost acknowledgment changes nothing.
    expect(leaderReceipts.apply(HOST_ID, receiptFor("run-1")).outcome).toEqual({
      status: "duplicate",
    });
    expect(leaderRun("run-1")).toMatchObject({ outcome: "completed", output: "host result" });
    expect(leaderRun("run-2")).toMatchObject({ outcome: null });

    // run-2 closes from its own receipt; the in-memory settle wrote neither.
    await followerSends({
      type: "request",
      requestId: 1,
      request: { op: "complete", result: { ...RESULT, output: "second" } },
    });
    deliverReceipt("run-2", { ...RESULT, output: "second" });
    expect(leaderRun("run-2")).toMatchObject({ outcome: "completed", output: "second" });
    expect(hostReceipts.listUnacked(0, 10)).toEqual([]);
  });

  it("keeps the run open across a same-generation reconnect, which is not an exit", async () => {
    await startRun("run-1");
    handle.attachHost(remote.rebindHost(ACTOR_ID));
    followerSends({ type: "ready", pid: 4242 });
    await Promise.resolve();
    expect(ends).toEqual([]);
    expect(leaderRun("run-1")).toMatchObject({ outcome: null });

    await followerSends({
      type: "request",
      requestId: 2,
      request: { op: "complete", result: RESULT },
    });
    expect(ends.map((event) => event.terminal.kind)).toEqual(["result"]);
    expect(leaderRun("run-1")).toMatchObject({ outcome: null });
    deliverReceipt("run-1");
    expect(leaderRun("run-1")).toMatchObject({ outcome: "completed" });
    expect(listenerFailures).toEqual([]);
  });

  it("closes the leader row only from the receipt when the run completes normally", async () => {
    await startRun("run-1");
    await followerSends({
      type: "request",
      requestId: 1,
      request: { op: "complete", result: RESULT },
    });
    expect(ends.map((event) => event.terminal.kind)).toEqual(["result"]);
    // The transport's completion releases the claim; it does not write the row.
    expect(leaderRuns()).toEqual([expect.objectContaining({ id: "run-1", outcome: null })]);

    deliverReceipt("run-1");
    expect(leaderRuns()).toEqual([expect.objectContaining({ id: "run-1", outcome: "completed" })]);

    // The claim is free for the actor's next run.
    await startRun("run-2");
    expect(listenerFailures).toEqual([]);
    expect(leaderReceipts.isReceiptBacked("run-2")).toBe(true);
  });

  const unproven: Array<[string, RunResult, string]> = [
    [
      "a timeout",
      {
        success: false,
        exitCode: -1,
        output: "timed out",
        termination: "unproven",
        abortReason: "run-ceiling",
      },
      "run-ceiling: timed out",
    ],
    [
      "an abort",
      {
        success: false,
        exitCode: -1,
        output: "aborted",
        termination: "unproven",
        abortReason: "interrupt:root",
      },
      "interrupt:root: aborted",
    ],
    [
      "a spawn or signal error",
      { success: false, exitCode: -1, output: "spawn ENOENT", termination: "unproven" },
      "spawn ENOENT",
    ],
    [
      "a result carrying no evidence",
      { success: true, exitCode: 0, output: "no evidence" },
      "no evidence",
    ],
  ];

  it.each(
    unproven
  )("releases the claim as unresolved, asserting no outcome, after %s the host could not observe end", async (_name, result, cause) => {
    await startRun("run-1");
    await followerSends({ type: "request", requestId: 1, request: { op: "complete", result } });
    // No result terminal: nothing downstream can emit run_end or a failure notice.
    expect(ends.map((event) => event.terminal)).toEqual([
      {
        kind: "abandoned",
        reason: "termination-unresolved",
        started: true,
        unresolved: { cause },
      },
    ]);
    expect(deliverReceipt("run-1", result, result.termination ?? "unproven")).toEqual([]);
    expect(leaderRun("run-1")).toMatchObject({ outcome: null, exit_code: null });
    expect(hostDb.prepare("SELECT outcome FROM actor_runs WHERE id = 'run-1'").get()).toEqual({
      outcome: null,
    });
    expect(hostDb.prepare("SELECT COUNT(*) AS n FROM host_run_receipts").get()).toEqual({ n: 0 });
    expect(leaderReceipts.unresolvedRuns(20).sample).toEqual([
      { runId: "run-1", instanceId: HOST_ID },
    ]);

    // Releasing the claim manufactured no terminal; the next run proceeds
    // and books exactly once from its own observed close.
    await startRun("run-2");
    expect(listenerFailures).toEqual([]);
    const [applied] = deliverReceipt("run-2", { ...RESULT, output: "second" });
    expect(applied.outcome.status).toBe("applied");
    expect(leaderReceipts.apply(HOST_ID, receiptFor("run-2")).outcome.status).toBe("duplicate");
    expect(leaderRuns().map((run) => [run.id, run.outcome, run.output])).toEqual([
      ["run-1", null, null],
      ["run-2", "completed", "second"],
    ]);
  });

  it("clears the released run's start, so a later interrupt does not report it (#1119)", async () => {
    await startRun("run-1");
    await followerSends({ type: "state", state: "running" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const released = new Date();
    await followerSends({
      type: "request",
      requestId: 1,
      request: { op: "complete", result: { ...RESULT, termination: "unproven" } },
    });
    expect(ends.map((event) => event.terminal.kind)).toEqual(["abandoned"]);
    // The host still reports its provider running; nothing the leader holds is run-1's.
    const interrupted = handle.interrupt("operator");
    expect(interrupted.interrupted).toBe(true);
    expect(interrupted.runStartTime?.getTime()).toBeGreaterThanOrEqual(released.getTime());
  });

  it("ends an observed failure as a result, by event or by request", async () => {
    const failed: RunResult = { ...RESULT, success: false, exitCode: 2, output: "failed" };
    await startRun("run-1");
    await followerSends({ type: "result", result: failed });
    await startRun("run-2");
    await followerSends({
      type: "request",
      requestId: 1,
      request: { op: "complete", result: failed },
    });
    expect(ends.map((event) => event.terminal)).toEqual([
      { kind: "result", result: failed },
      { kind: "result", result: failed },
    ]);
    // The transport's result still writes no leader row; each receipt does.
    expect(leaderRun("run-1")).toMatchObject({ outcome: null });
    deliverReceipt("run-1", failed);
    expect(leaderRun("run-1")).toMatchObject({ outcome: "completed", success: 0, exit_code: 2 });
  });

  it("labels a host-side abandonment unresolved unless the host observed the provider end", async () => {
    await startRun("run-1");
    await followerSends({
      type: "abandoned",
      abandon: { reason: "coalesced", started: true, termination: "unproven" },
    });
    await startRun("run-2");
    await followerSends({
      type: "abandoned",
      abandon: { reason: "coalesced", started: true, termination: "observed" },
    });
    expect(ends.map((event) => event.terminal)).toEqual([
      {
        kind: "abandoned",
        reason: "coalesced",
        started: true,
        unresolved: { cause: "host abandoned the run: coalesced" },
      },
      { kind: "abandoned", reason: "coalesced", started: true },
    ]);
    // Either way the leader rows wait for the host's receipt.
    expect(leaderRuns().map((run) => [run.id, run.outcome])).toEqual([
      ["run-1", null],
      ["run-2", null],
    ]);
    expect(listenerFailures).toEqual([]);
  });

  it("applies a receipt that overtook its runStart once the leader opens the run (#1119)", async () => {
    // The host opens and completes run-1, and its receipt reaches the leader
    // while the runStart event is still held back in the event transport.
    hostReceipts.start({
      id: "run-1",
      actorId: ACTOR_ID,
      modelConfig: projectActorRunLaunchConfig({ provider: "codex", model: "gpt-5.5" }),
    });
    const [early] = deliverReceipt("run-1");
    expect(early.outcome).toEqual({ status: "conflict", kind: "unknown_run" });
    expect(leaderRuns()).toEqual([]);

    // The held runStart is released: the leader opens the run and applies
    // the receipt it already holds, in the same transaction.
    await followerSends({
      type: "runStart",
      runId: "run-1",
      responsive: false,
      selected: { provider: "codex", model: "gpt-5.5" },
    });
    expect(listenerFailures).toEqual([]);
    expect(leaderRuns()).toEqual([
      {
        id: "run-1",
        outcome: "completed",
        success: 1,
        exit_code: 0,
        output: "host result",
        abandon_reason: null,
      },
    ]);
    const count = (table: string) =>
      (leaderDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("instance_run_terminals")).toBe(1);
    expect(count("instance_receipt_conflicts")).toBe(0);
    // The arrival was logged as a conflict; the apply is logged where it happens.
    expect(logged).toEqual([
      {
        event: "instance_receipt_applied",
        fields: {
          followerId: HOST_ID,
          runId: "run-1",
          actorId: ACTOR_ID,
          early: true,
          actorRunClosed: true,
        },
      },
    ]);

    // Exactly once: a retry is a duplicate, and the transport's completion
    // releases the claim without writing the row again.
    expect(leaderReceipts.apply(HOST_ID, receiptFor("run-1")).outcome).toEqual({
      status: "duplicate",
    });
    await followerSends({
      type: "request",
      requestId: 1,
      request: { op: "complete", result: { ...RESULT, output: "transport" } },
    });
    expect(ends.map((event) => event.terminal.kind)).toEqual(["result"]);
    expect(leaderRun("run-1")).toMatchObject({ outcome: "completed", output: "host result" });
    expect(hostDb.prepare("SELECT outcome, output FROM actor_runs").get()).toEqual({
      outcome: "completed",
      output: "host result",
    });

    // The claim is free, and the next run books from its own receipt.
    await startRun("run-2");
    deliverReceipt("run-2", { ...RESULT, output: "second" });
    expect(leaderRun("run-2")).toMatchObject({ outcome: "completed", output: "second" });
    expect(listenerFailures).toEqual([]);
  });

  it("leaves an unreported receipt-backed run open through leader restart recovery", async () => {
    await startRun("run-1");
    expect(
      new ActorRunRepository(leaderDb).abandonOpen("service restarted before run completion")
    ).toBe(0);
    expect(leaderRuns()).toEqual([expect.objectContaining({ id: "run-1", outcome: null })]);
  });

  it("keeps the legacy contract for a host that did not negotiate receipts", async () => {
    handle.close();
    connect(false);
    expect(remote.hosts.get(ACTOR_ID)?.durableHost).toBeUndefined();
    await followerSends({
      type: "runStart",
      runId: "legacy-1",
      responsive: false,
      selected: { provider: "codex", model: "gpt-5.5" },
    });
    expect(leaderReceipts.isReceiptBacked("legacy-1")).toBe(false);
    // Without the receipt contract the transport's result is the terminal,
    // evidence or not, and the leader books it at once.
    const timedOut: RunResult = {
      success: false,
      exitCode: -1,
      output: "timed out",
      termination: "unproven",
      abortReason: "run-ceiling",
    };
    await followerSends({
      type: "request",
      requestId: 1,
      request: { op: "complete", result: timedOut },
    });
    expect(ends.map((event) => event.terminal)).toEqual([{ kind: "result", result: timedOut }]);
    expect(leaderRun("legacy-1")).toMatchObject({
      outcome: "completed",
      success: 0,
      exit_code: -1,
    });

    // A legacy host dropping mid-run still ends the run as a failure.
    await followerSends({
      type: "runStart",
      runId: "legacy-2",
      responsive: false,
      selected: { provider: "codex", model: "gpt-5.5" },
    });
    remote.close();
    await handle.exited;
    await Promise.resolve();
    expect(ends[1]?.terminal).toMatchObject({ kind: "result", result: { success: false } });
    expect(leaderRun("legacy-2")).toMatchObject({ outcome: "completed", success: 0 });
    expect(listenerFailures).toEqual([]);
  });
});
