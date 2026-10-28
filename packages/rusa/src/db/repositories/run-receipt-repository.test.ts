import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createRunAccounting } from "../../actor/run-accounting.js";
import { runMigrations } from "../migrations/runner.js";
import { ACTOR_RUN_OUTPUT_MAX_CHARS, ActorRunRepository } from "./actor-run-repository.js";
import { createFollowerRepositories } from "./index.js";
import {
  createRunReceipt,
  parseRunReceipt,
  type RunReceiptEnvelope,
  runReceiptDigest,
  serializeRunReceipt,
} from "./run-receipt.js";
import {
  HostRunReceiptRepository,
  InstanceRunReceiptRepository,
  RUN_RECEIPT_CONFLICTS_MAX_PER_INSTANCE,
  RunReceiptConflictLimitError,
  type RunReceiptOutcome,
} from "./run-receipt-repository.js";

const modelConfig = { version: 1 as const, provider: "claude", model: "sonnet" };
const dirs: string[] = [];

/** An isolated, migrated mesh.db on disk, so a reopen reads what was committed. */
function openDb(path?: string): { db: Database.Database; path: string } {
  let file = path;
  if (!file) {
    const dir = mkdtempSync(join(tmpdir(), "rusa-receipts-"));
    dirs.push(dir);
    file = join(dir, "mesh.db");
  }
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return { db, path: file };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Host and leader are separate databases; the test carries envelopes between them. */
function fixture() {
  const host = openDb();
  const leader = openDb();
  const hostRuns = new ActorRunRepository(host.db);
  const hostReceipts = new HostRunReceiptRepository(host.db, "host-a");
  const leaderReceipts = new InstanceRunReceiptRepository(leader.db);
  const hostStart = (runId: string, actorId = "actor-1") =>
    hostReceipts.start({ id: runId, actorId, modelConfig });
  const leaderStart = (runId: string, instanceId = "host-a", actorId = "actor-1") =>
    leaderReceipts.startRun({
      runId,
      instanceId,
      actorId,
      modelConfig,
      startedAt: "2026-10-20T08:00:00.000Z",
    });
  const startBoth = (runId: string, actorId = "actor-1") => {
    hostReceipts.start({ id: runId, actorId, modelConfig, startedAt: "2026-10-20T08:00:00.000Z" });
    leaderStart(runId, "host-a", actorId);
  };
  const leaderRun = (runId: string) =>
    leader.db
      .prepare(
        "SELECT outcome, success, exit_code, output, abandon_reason FROM actor_runs WHERE id = ?"
      )
      .get(runId);
  const conflicts = () =>
    leader.db
      .prepare("SELECT instance_id, run_id, kind FROM instance_receipt_conflicts ORDER BY id")
      .all();
  const pending = (receipts = hostReceipts) =>
    receipts.listUnacked(0, 100).map((entry) => entry.envelope);
  return {
    host,
    leader,
    hostRuns,
    hostReceipts,
    leaderReceipts,
    hostStart,
    leaderStart,
    startBoth,
    leaderRun,
    conflicts,
    pending,
  };
}
type Fixture = ReturnType<typeof fixture>;

const ok = { success: true, exitCode: 0, output: "ok" };

function forged(instanceId: string, runId: string, output = "forged"): RunReceiptEnvelope {
  const receipt = serializeRunReceipt(
    createRunReceipt({
      instanceId,
      runId,
      actorId: "actor-1",
      endedAt: "2026-10-20T09:00:00.000Z",
      outcome: "completed",
      success: true,
      exitCode: 0,
      output,
    })
  );
  return { runId, receipt, digest: runReceiptDigest(receipt) };
}

describe("run receipt document (#1020)", () => {
  it("round-trips byte-identically and bounds output at the capture limit", () => {
    const receipt = createRunReceipt({
      instanceId: "host-a",
      runId: "run-1",
      actorId: "actor-1",
      endedAt: "2026-10-20T09:00:00.000Z",
      outcome: "completed",
      success: false,
      exitCode: 2,
      output: "x".repeat(ACTOR_RUN_OUTPUT_MAX_CHARS * 2),
    });
    const serialized = serializeRunReceipt(receipt);
    expect(serializeRunReceipt(parseRunReceipt(serialized))).toBe(serialized);
    expect(receipt.outcome === "completed" && receipt.output?.length).toBeLessThan(
      ACTOR_RUN_OUTPUT_MAX_CHARS + 128
    );
  });

  it("rejects unknown versions, unexpected properties and oversized output", () => {
    const valid = JSON.parse(serializeRunReceipt(parseRunReceipt(forged("h", "r").receipt)));
    expect(() => parseRunReceipt(JSON.stringify({ ...valid, version: 2 }))).toThrow(/version/);
    expect(() => parseRunReceipt(JSON.stringify({ ...valid, extra: 1 }))).toThrow(/unexpected/);
    expect(() =>
      parseRunReceipt(
        JSON.stringify({ ...valid, output: "x".repeat(ACTOR_RUN_OUTPUT_MAX_CHARS * 2) })
      )
    ).toThrow(/capture bound/);
    expect(() => parseRunReceipt("{")).toThrow(/invalid JSON/);
    const abandoned = JSON.parse(
      serializeRunReceipt(
        createRunReceipt({
          instanceId: "h",
          runId: "r",
          actorId: "a",
          endedAt: "2026-10-20T09:00:00.000Z",
          outcome: "abandoned",
          reason: "gone",
        })
      )
    );
    expect(() => parseRunReceipt(JSON.stringify({ ...abandoned, reason: " " }))).toThrow(/reason/);
  });
});

describe("host run receipts (#1020)", () => {
  it("commits the local terminal and its receipt together, keyed by run ID", () => {
    const { host, hostReceipts, hostStart, pending } = fixture();
    hostStart("run-1");
    hostStart("run-2", "actor-2");

    expect(hostReceipts.complete("run-1", "actor-1", ok, "observed")).toBe("receipt");
    expect(hostReceipts.abandon("run-2", "actor-2", "start-cancelled", "observed")).toBe("receipt");

    expect(host.db.prepare("SELECT id, outcome FROM actor_runs ORDER BY id").all()).toEqual([
      { id: "run-1", outcome: "completed" },
      { id: "run-2", outcome: "abandoned" },
    ]);
    const [first, second] = pending();
    expect([first.runId, second.runId]).toEqual(["run-1", "run-2"]);
    expect(Object.keys(first).sort()).toEqual(["digest", "receipt", "runId"]);
    expect(parseRunReceipt(first.receipt)).toMatchObject({
      instanceId: "host-a",
      outcome: "completed",
      output: "ok",
    });
    expect(parseRunReceipt(second.receipt)).toMatchObject({
      outcome: "abandoned",
      reason: "start-cancelled",
    });
    expect(first.digest).toBe(runReceiptDigest(first.receipt));
  });

  it("writes neither the terminal nor the receipt when the receipt cannot commit", () => {
    const { host, hostReceipts, hostStart } = fixture();
    hostStart("run-1");
    hostReceipts.complete("run-1", "actor-1", ok, "observed");
    // run_id is unique: a second receipt for run-1 cannot be inserted.
    host.db.prepare("UPDATE actor_runs SET outcome = NULL WHERE id = 'run-1'").run();
    expect(() =>
      hostReceipts.complete(
        "run-1",
        "actor-1",
        { success: false, exitCode: 1, output: "again" },
        "observed"
      )
    ).toThrow();
    expect(host.db.prepare("SELECT outcome FROM actor_runs WHERE id = 'run-1'").get()).toEqual({
      outcome: null,
    });
    expect(host.db.prepare("SELECT COUNT(*) AS n FROM host_run_receipts").get()).toEqual({ n: 1 });
  });

  it("leaves a receipt-backed run without observed termination open, with no terminal or receipt", () => {
    const { host, hostReceipts, hostStart, leaderReceipts, startBoth, leaderRun, pending } =
      fixture();
    startBoth("run-1");
    hostStart("run-2");
    hostStart("run-3");
    // A timeout, abort, signal error or spawn error proves nothing, and a
    // result carrying no evidence proves nothing either.
    expect(hostReceipts.complete("run-1", "actor-1", ok, "unproven")).toBe("unresolved");
    expect(hostReceipts.complete("run-2", "actor-1", ok, undefined)).toBe("unresolved");
    expect(hostReceipts.abandon("run-3", "actor-1", "timeout", "unproven")).toBe("unresolved");
    expect(
      host.db.prepare("SELECT id FROM actor_runs WHERE outcome IS NULL ORDER BY id").all()
    ).toEqual([{ id: "run-1" }, { id: "run-2" }, { id: "run-3" }]);
    expect(pending()).toEqual([]);
    expect(leaderRun("run-1")).toMatchObject({ outcome: null, exit_code: null });

    // Only the run's own observed close writes its one terminal, applied once.
    expect(hostReceipts.complete("run-1", "actor-1", { ...ok, output: "closed" }, "observed")).toBe(
      "receipt"
    );
    const [envelope] = pending();
    expect(leaderReceipts.apply("host-a", envelope).outcome.status).toBe("applied");
    expect(leaderReceipts.apply("host-a", envelope).outcome.status).toBe("duplicate");
    expect(leaderRun("run-1")).toMatchObject({ outcome: "completed", output: "closed" });
    expect(
      host.db.prepare("SELECT id FROM actor_runs WHERE outcome IS NULL ORDER BY id").all()
    ).toEqual([{ id: "run-2" }, { id: "run-3" }]);
  });

  it("closes a run opened without the receipt contract locally, whatever its evidence, owing no receipt", () => {
    const { host, hostRuns, hostReceipts } = fixture();
    hostRuns.start({ id: "legacy-1", actorId: "actor-1", modelConfig });
    hostRuns.start({ id: "legacy-2", actorId: "actor-1", modelConfig });
    hostRuns.start({ id: "legacy-3", actorId: "actor-1", modelConfig });
    expect(hostReceipts.complete("legacy-1", "actor-1", ok, undefined)).toBe("local");
    expect(hostReceipts.complete("legacy-2", "actor-1", ok, "unproven")).toBe("local");
    expect(hostReceipts.abandon("legacy-3", "actor-1", "timeout", "unproven")).toBe("local");
    expect(host.db.prepare("SELECT id, outcome FROM actor_runs ORDER BY id").all()).toEqual([
      { id: "legacy-1", outcome: "completed" },
      { id: "legacy-2", outcome: "completed" },
      { id: "legacy-3", outcome: "abandoned" },
    ]);
    expect(host.db.prepare("SELECT COUNT(*) AS n FROM host_run_receipts").get()).toEqual({ n: 0 });
  });

  it("leaves receipt-backed runs a previous process left open unresolved, with no receipt", () => {
    const { host, hostRuns, hostReceipts } = fixture();
    const at = (n: number) => `2026-10-20T08:00:0${n}.000Z`;
    hostReceipts.start({ id: "run-1", actorId: "actor-1", modelConfig, startedAt: at(1) });
    hostReceipts.start({ id: "run-2", actorId: "actor-2", modelConfig, startedAt: at(2) });
    hostRuns.start({ id: "legacy-1", actorId: "actor-3", modelConfig, startedAt: at(3) });
    new HostRunReceiptRepository(host.db, "host-old").start({
      id: "foreign-1",
      actorId: "actor-4",
      modelConfig,
      startedAt: at(4),
    });
    host.db.close();

    const reopened = openDb(host.path).db;
    const receipts = new HostRunReceiptRepository(reopened, "host-a");
    expect(receipts.recoverOpen("host restarted before run completion")).toEqual({
      local: 1,
      unresolved: [
        { runId: "run-1", instanceId: "host-a" },
        { runId: "run-2", instanceId: "host-a" },
        { runId: "foreign-1", instanceId: "host-old" },
      ],
    });
    // A second recovery, as at shutdown, finds the same runs and changes nothing.
    expect(receipts.recoverOpen("follower shutdown drain timed out").unresolved).toHaveLength(3);
    reopened.close();

    const again = openDb(host.path).db;
    expect(again.prepare("SELECT COUNT(*) AS n FROM host_run_receipts").get()).toEqual({ n: 0 });
    expect(
      again.prepare("SELECT id, outcome FROM actor_runs WHERE outcome IS NULL ORDER BY id").all()
    ).toEqual([
      { id: "foreign-1", outcome: null },
      { id: "run-1", outcome: null },
      { id: "run-2", outcome: null },
    ]);
    expect(again.prepare("SELECT outcome FROM actor_runs WHERE id = 'legacy-1'").get()).toEqual({
      outcome: "abandoned",
    });
    again.close();
  });

  it("keeps a previous identity's runs and receipts out of a re-enrolled identity", () => {
    const { host, hostReceipts, hostStart, pending } = fixture();
    hostStart("run-1");
    hostReceipts.complete("run-1", "actor-1", { ...ok, output: "a" }, "observed");
    hostStart("run-2");

    const renamed = new HostRunReceiptRepository(host.db, "host-b");
    expect(pending(renamed)).toEqual([]);
    expect(renamed.markAcked(["run-1"])).toBe(0);
    expect(renamed.recoverOpen("host restarted before run completion")).toEqual({
      local: 0,
      unresolved: [{ runId: "run-2", instanceId: "host-a" }],
    });
    expect(() => renamed.abandon("run-2", "actor-1", "taken", "observed")).toThrow(
      /belongs to instance/
    );
    renamed.start({ id: "run-3", actorId: "actor-1", modelConfig });
    renamed.complete("run-3", "actor-1", { ...ok, output: "b" }, "observed");

    expect(pending(renamed).map((e) => e.runId)).toEqual(["run-3"]);
    expect(parseRunReceipt(pending(renamed)[0].receipt).instanceId).toBe("host-b");
    expect(pending().map((e) => e.runId)).toEqual(["run-1"]);
    expect(host.db.prepare("SELECT outcome FROM actor_runs WHERE id = 'run-2'").get()).toEqual({
      outcome: null,
    });
  });

  it("acknowledges each receipt individually and idempotently, paging by local commit order", () => {
    const { hostReceipts, hostStart } = fixture();
    for (const runId of ["run-1", "run-2", "run-3"]) {
      hostStart(runId);
      hostReceipts.complete(runId, "actor-1", ok, "observed");
    }
    const ids = hostReceipts.listUnacked(0, 10).map((entry) => entry.id);
    // An acknowledgment for the middle receipt leaves the others pending.
    expect(hostReceipts.markAcked(["run-2"])).toBe(1);
    expect(hostReceipts.markAcked(["run-2", "run-unknown"])).toBe(0);
    expect(hostReceipts.listUnacked(0, 10).map((e) => e.envelope.runId)).toEqual([
      "run-1",
      "run-3",
    ]);
    expect(hostReceipts.listUnacked(ids[0], 10).map((e) => e.envelope.runId)).toEqual(["run-3"]);
    expect(hostReceipts.listUnacked(0, 1).map((e) => e.envelope.runId)).toEqual(["run-1"]);
  });

  it("retains pending receipts, as identical bytes, across a host restart", () => {
    const { host, hostReceipts, hostStart, leaderReceipts, leaderStart, leader } = fixture();
    hostStart("run-1");
    hostStart("run-2");
    leaderStart("run-1");
    leaderStart("run-2");
    hostReceipts.complete("run-1", "actor-1", { ...ok, output: "one" }, "observed");
    hostReceipts.complete("run-2", "actor-1", { ...ok, output: "two" }, "observed");
    const before = hostReceipts.listUnacked(0, 10);
    // The leader applies run-1 but its acknowledgment is lost; nothing is marked.
    expect(leaderReceipts.apply("host-a", before[0].envelope).outcome.status).toBe("applied");
    host.db.close();

    const reopened = new HostRunReceiptRepository(openDb(host.path).db, "host-a");
    const after = reopened.listUnacked(0, 10);
    expect(after).toEqual(before);
    expect(after.map((entry) => leaderReceipts.apply("host-a", entry.envelope).outcome)).toEqual([
      { status: "duplicate" },
      { status: "applied", actorRunClosed: true },
    ]);
    expect(leader.db.prepare("SELECT COUNT(*) AS n FROM instance_run_terminals").get()).toEqual({
      n: 2,
    });
    expect(reopened.markAcked(["run-1", "run-2"])).toBe(2);
    expect(reopened.listUnacked(0, 10)).toEqual([]);
  });

  it("is reachable from follower repositories only when bound to an instance", () => {
    const { db } = openDb();
    expect(createFollowerRepositories(db).runReceipts).toBeUndefined();
    const bound = createFollowerRepositories(db, { instanceId: "host-a" });
    expect(Object.isFrozen(bound.runReceipts)).toBe(true);
    expect(Reflect.ownKeys(bound.runReceipts ?? {}).sort()).toEqual([
      "abandon",
      "complete",
      "listUnacked",
      "markAcked",
      "recoverOpen",
      "start",
    ]);
    db.close();
  });
});

interface Decision {
  name: string;
  arrange: (fx: Fixture) => void;
  envelope: RunReceiptEnvelope;
  outcome: RunReceiptOutcome;
  /** The answer to the identical bytes resent after a lost acknowledgment. */
  replay: RunReceiptOutcome;
  run: Record<string, unknown> | undefined;
  conflicts: Array<{ instance_id: string; run_id: string; kind: string }>;
}

const first = forged("host-a", "run-1", "first");
const decisions: Decision[] = [
  {
    name: "applies the owner's first receipt and closes the run",
    arrange: (fx) => fx.leaderStart("run-1"),
    envelope: first,
    outcome: { status: "applied", actorRunClosed: true },
    replay: { status: "duplicate" },
    run: { outcome: "completed", output: "first" },
    conflicts: [],
  },
  {
    name: "answers the applied bytes, resent after a lost acknowledgment, as a duplicate",
    arrange: (fx) => {
      fx.leaderStart("run-1");
      fx.leaderReceipts.apply("host-a", first);
    },
    envelope: first,
    outcome: { status: "duplicate" },
    replay: { status: "duplicate" },
    run: { outcome: "completed", output: "first" },
    conflicts: [],
  },
  {
    name: "retains a differing payload as a run conflict, never overwriting the terminal",
    arrange: (fx) => {
      fx.leaderStart("run-1");
      fx.leaderReceipts.apply("host-a", first);
    },
    envelope: forged("host-a", "run-1", "second"),
    outcome: { status: "conflict", kind: "run_conflict" },
    replay: { status: "conflict", kind: "run_conflict" },
    run: { outcome: "completed", output: "first" },
    conflicts: [{ instance_id: "host-a", run_id: "run-1", kind: "run_conflict" }],
  },
  {
    name: "retains a receipt for an open run another instance owns as wrong_instance",
    arrange: (fx) => fx.leaderStart("run-1", "host-b"),
    envelope: first,
    outcome: { status: "conflict", kind: "wrong_instance" },
    replay: { status: "conflict", kind: "wrong_instance" },
    run: { outcome: null, output: null },
    conflicts: [{ instance_id: "host-a", run_id: "run-1", kind: "wrong_instance" }],
  },
  {
    name: "retains a receipt for another instance's closed run as wrong_instance",
    arrange: (fx) => {
      fx.leaderStart("run-1", "host-b");
      fx.leaderReceipts.apply("host-b", forged("host-b", "run-1", "owner"));
    },
    envelope: first,
    outcome: { status: "conflict", kind: "wrong_instance" },
    replay: { status: "conflict", kind: "wrong_instance" },
    run: { outcome: "completed", output: "owner" },
    conflicts: [{ instance_id: "host-a", run_id: "run-1", kind: "wrong_instance" }],
  },
  {
    name: "retains a receipt for a run not yet registered as unknown_run",
    arrange: () => {},
    envelope: first,
    outcome: { status: "conflict", kind: "unknown_run" },
    replay: { status: "conflict", kind: "unknown_run" },
    run: undefined,
    conflicts: [{ instance_id: "host-a", run_id: "run-1", kind: "unknown_run" }],
  },
];

describe("leader run receipts (#1020, #1119 run-ID ruling)", () => {
  it.each(decisions)("$name", ({ arrange, envelope, outcome, replay, run, conflicts }) => {
    const fx = fixture();
    arrange(fx);
    expect(fx.leaderReceipts.apply("host-a", envelope).outcome).toEqual(outcome);
    expect(fx.leaderReceipts.apply("host-a", envelope).outcome).toEqual(replay);
    const leaderRun = fx.leaderRun("run-1") as Record<string, unknown> | undefined;
    if (run) expect(leaderRun).toMatchObject(run);
    else expect(leaderRun).toBeUndefined();
    // The replay stored nothing more.
    expect(fx.conflicts()).toEqual(conflicts);
    expect(fx.leader.db.prepare("SELECT COUNT(*) AS n FROM instance_run_terminals").get()).toEqual({
      n: run?.outcome ? 1 : 0,
    });
  });

  it("refuses, writing nothing, a receipt naming another sender, failing its digest or another run", () => {
    const { leader, leaderReceipts, leaderStart } = fixture();
    leaderStart("run-1");
    expect(() => leaderReceipts.apply("host-a", forged("host-b", "run-1"))).toThrow(
      /instance does not match/
    );
    expect(() =>
      leaderReceipts.apply("host-a", { ...forged("host-a", "run-1"), digest: "0".repeat(64) })
    ).toThrow(/digest/);
    expect(() =>
      leaderReceipts.apply("host-a", { ...forged("host-a", "run-1"), runId: "run-2" })
    ).toThrow(/run does not match/);
    const garbled = "{";
    expect(() =>
      leaderReceipts.apply("host-a", {
        runId: "run-1",
        receipt: garbled,
        digest: runReceiptDigest(garbled),
      })
    ).toThrow(/invalid JSON/);
    expect(leader.db.prepare("SELECT COUNT(*) AS n FROM instance_run_terminals").get()).toEqual({
      n: 0,
    });
    expect(leader.db.prepare("SELECT COUNT(*) AS n FROM instance_receipt_conflicts").get()).toEqual(
      { n: 0 }
    );
  });

  it("applies the registering host's receipt that overtook its run start, once", () => {
    const { leaderReceipts, leaderStart, leaderRun, conflicts } = fixture();
    const early = forged("host-a", "run-1", "early");
    const later = forged("host-a", "run-1", "later");
    expect(leaderReceipts.apply("host-a", early).outcome).toEqual({
      status: "conflict",
      kind: "unknown_run",
    });
    expect(leaderReceipts.apply("host-a", later).outcome.status).toBe("conflict");
    expect(leaderReceipts.apply("host-b", forged("host-b", "run-1", "other")).outcome).toEqual({
      status: "conflict",
      kind: "unknown_run",
    });

    expect(leaderStart("run-1")).toEqual({ status: "applied", actorRunClosed: true });
    // The oldest receipt from the registering host became the terminal; the
    // differing one and the other host's stay retained, unapplied.
    expect(leaderRun("run-1")).toMatchObject({ outcome: "completed", output: "early" });
    expect(conflicts()).toEqual([
      { instance_id: "host-a", run_id: "run-1", kind: "unknown_run" },
      { instance_id: "host-b", run_id: "run-1", kind: "unknown_run" },
    ]);
    expect(leaderReceipts.apply("host-a", early).outcome).toEqual({ status: "duplicate" });
    expect(leaderReceipts.apply("host-b", forged("host-b", "run-1", "other")).outcome).toEqual({
      status: "conflict",
      kind: "wrong_instance",
    });
    expect(leaderReceipts.unresolvedRuns(20)).toEqual({ runs: 0, sample: [] });
  });

  it("refuses, unstored, a new conflict beyond the per-identity bound", () => {
    const { leader, leaderReceipts } = fixture();
    const insert = leader.db.prepare(
      `INSERT INTO instance_receipt_conflicts
         (instance_id, run_id, kind, digest, receipt, received_at)
       VALUES ('host-a', ?, 'unknown_run', ?, 'r', 't')`
    );
    const stored = forged("host-a", "stored-1");
    leader.db.transaction(() => {
      insert.run("stored-1", stored.digest);
      for (let n = 2; n <= RUN_RECEIPT_CONFLICTS_MAX_PER_INSTANCE; n++) {
        insert.run(`stored-${n}`, "d");
      }
    })();
    let refused: unknown;
    try {
      leaderReceipts.apply("host-a", forged("host-a", "run-x"));
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(RunReceiptConflictLimitError);
    expect((refused as RunReceiptConflictLimitError).kind).toBe("unknown_run");
    expect(leader.db.prepare("SELECT COUNT(*) AS n FROM instance_receipt_conflicts").get()).toEqual(
      { n: RUN_RECEIPT_CONFLICTS_MAX_PER_INSTANCE }
    );
    // A conflict already stored still answers its retry at the bound.
    expect(leaderReceipts.apply("host-a", stored).outcome).toEqual({
      status: "conflict",
      kind: "unknown_run",
    });
    // Another identity's bound is its own.
    expect(leaderReceipts.apply("host-b", forged("host-b", "run-x")).outcome).toEqual({
      status: "conflict",
      kind: "unknown_run",
    });
  });

  it("keeps an unobserved run open on both sides until its genuine terminal applies once", () => {
    const { host, hostReceipts, leaderReceipts, startBoth, leaderRun, pending } = fixture();
    startBoth("run-1");
    startBoth("run-2");
    // Boot and shutdown recovery each find the runs open and emit nothing.
    expect(hostReceipts.recoverOpen("host restarted before run completion").unresolved).toEqual([
      { runId: "run-1", instanceId: "host-a" },
      { runId: "run-2", instanceId: "host-a" },
    ]);
    expect(hostReceipts.recoverOpen("follower shutdown drain timed out").unresolved).toHaveLength(
      2
    );
    expect(pending()).toEqual([]);
    const open = { outcome: null, success: null, exit_code: null, output: null };
    expect(leaderRun("run-1")).toMatchObject(open);
    expect(leaderRun("run-2")).toMatchObject(open);

    // Later, an observed termination writes the run's one terminal.
    hostReceipts.complete("run-1", "actor-1", { ...ok, output: "late" }, "observed");
    const [envelope] = pending();
    expect(leaderReceipts.apply("host-a", envelope).outcome).toEqual({
      status: "applied",
      actorRunClosed: true,
    });
    expect(leaderRun("run-1")).toEqual({
      outcome: "completed",
      success: 1,
      exit_code: 0,
      output: "late",
      abandon_reason: null,
    });
    expect(leaderRun("run-2")).toMatchObject(open);
    expect(
      host.db.prepare("SELECT id FROM actor_runs WHERE outcome IS NULL ORDER BY id").all()
    ).toEqual([{ id: "run-2" }]);
  });

  it("does not manufacture a terminal for a run whose completion a store rollback lost", () => {
    const { host, hostReceipts, leaderReceipts, startBoth, leaderRun, pending } = fixture();
    startBoth("run-1");
    hostReceipts.complete("run-1", "actor-1", { ...ok, output: "one" }, "observed");
    leaderReceipts.apply("host-a", pending()[0]);
    hostReceipts.markAcked(["run-1"]);
    startBoth("run-2");
    host.db.close();
    const snapshot = `${host.path}.snapshot`;
    copyFileSync(host.path, snapshot);

    // run-2 really completes, but its receipt is never sent before the store
    // is rolled back to the snapshot, where run-2 is still open.
    const before = openDb(host.path).db;
    new HostRunReceiptRepository(before, "host-a").complete(
      "run-2",
      "actor-1",
      { ...ok, output: "two" },
      "observed"
    );
    before.close();
    copyFileSync(snapshot, host.path);

    const restored = openDb(host.path).db;
    const receipts = new HostRunReceiptRepository(restored, "host-a");
    expect(receipts.recoverOpen("host restarted before run completion")).toEqual({
      local: 0,
      unresolved: [{ runId: "run-2", instanceId: "host-a" }],
    });
    // Nothing to deliver: recovery issued no receipt, so no terminal for
    // run-2 can reach the leader. It stays in the unresolved inventory.
    expect(receipts.listUnacked(0, 10)).toEqual([]);
    expect(leaderRun("run-2")).toMatchObject({ outcome: null, exit_code: null });
    expect(leaderReceipts.unresolvedRuns(20).sample).toEqual([
      { runId: "run-2", instanceId: "host-a" },
    ]);
    restored.close();
  });

  it("keeps a receipt-backed run open across leader restart recovery until its receipt lands", () => {
    const { leader, leaderReceipts, leaderStart, leaderRun } = fixture();
    const leaderRuns = new ActorRunRepository(leader.db);
    leaderStart("remote-1");
    leaderRuns.start({ id: "local-1", actorId: "actor-2", modelConfig });

    expect(leaderRuns.abandonOpen("service restarted before run completion")).toBe(1);
    expect(leaderRun("local-1")).toMatchObject({ outcome: "abandoned" });
    expect(leaderRun("remote-1")).toMatchObject({ outcome: null });
    // Restart reports it as unresolved rather than closing it.
    expect(leaderReceipts.unresolvedRuns(20)).toEqual({
      runs: 1,
      sample: [{ runId: "remote-1", instanceId: "host-a" }],
    });

    const late = forged("host-a", "remote-1", "late");
    expect(leaderReceipts.apply("host-a", late).outcome).toEqual({
      status: "applied",
      actorRunClosed: true,
    });
    expect(leaderRun("remote-1")).toMatchObject({ outcome: "completed", output: "late" });
    expect(leaderReceipts.unresolvedRuns(20)).toEqual({ runs: 0, sample: [] });

    // Applied durably: a reopened leader answers the resend as a duplicate.
    leader.db.close();
    const reopened = new InstanceRunReceiptRepository(openDb(leader.path).db);
    expect(reopened.apply("host-a", late).outcome).toEqual({ status: "duplicate" });
  });
});

describe("run receipt retention (#1119)", () => {
  const columns = (db: Database.Database, table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

  it("keeps full bytes only while a receipt is pending or refused", () => {
    const { host, leader } = fixture();
    expect(columns(host.db, "host_run_receipts")).not.toContain("acked_at");
    expect(columns(leader.db, "instance_run_terminals")).toEqual([
      "run_id",
      "instance_id",
      "digest",
      "received_at",
    ]);
    expect(columns(leader.db, "instance_receipt_conflicts")).toContain("receipt");
  });

  it("drops an acknowledged receipt, and a closed run cannot owe another", () => {
    const { host, hostReceipts, leaderReceipts, startBoth, leaderRun, pending } = fixture();
    startBoth("run-1");
    hostReceipts.complete("run-1", "actor-1", { ...ok, output: "one" }, "observed");
    const [envelope] = pending();
    expect(leaderReceipts.apply("host-a", envelope).outcome.status).toBe("applied");
    expect(hostReceipts.markAcked(["run-1"])).toBe(1);
    expect(host.db.prepare("SELECT COUNT(*) AS n FROM host_run_receipts").get()).toEqual({ n: 0 });
    // The closed local row is the host's record of the terminal.
    expect(
      host.db.prepare("SELECT outcome, output FROM actor_runs WHERE id = 'run-1'").get()
    ).toEqual({ outcome: "completed", output: "one" });

    // A second terminal for the closed run throws and writes no receipt.
    expect(() =>
      hostReceipts.complete("run-1", "actor-1", { ...ok, output: "two" }, "observed")
    ).toThrow(/active actor run not found/);
    expect(() => hostReceipts.abandon("run-1", "actor-1", "late", "observed")).toThrow(
      /active actor run not found/
    );
    expect(pending()).toEqual([]);
    // A duplicate acknowledgment is a no-op; the leader still answers the old bytes.
    expect(hostReceipts.markAcked(["run-1"])).toBe(0);
    expect(leaderReceipts.apply("host-a", envelope).outcome).toEqual({ status: "duplicate" });
    expect(leaderRun("run-1")).toMatchObject({ outcome: "completed", output: "one" });
  });
});

describe("host-minted run ID registration (#1119)", () => {
  const owner = (fx: Fixture, runId: string) =>
    fx.leader.db
      .prepare(
        `SELECT r.actor_id, i.instance_id FROM actor_runs r
         LEFT JOIN instance_runs i ON i.run_id = r.id WHERE r.id = ?`
      )
      .get(runId);

  it("refuses an ID colliding with a leader-local run, leaving it as it was", () => {
    const fx = fixture();
    new ActorRunRepository(fx.leader.db).start({ id: "run-1", actorId: "local", modelConfig });
    expect(() => fx.leaderStart("run-1", "host-a", "actor-1")).toThrow();
    expect(owner(fx, "run-1")).toEqual({ actor_id: "local", instance_id: null });
    expect(fx.leaderReceipts.isReceiptBacked("run-1")).toBe(false);
    // The host cannot then close it with a receipt.
    expect(fx.leaderReceipts.apply("host-a", forged("host-a", "run-1")).outcome).toEqual({
      status: "conflict",
      kind: "unknown_run",
    });
    expect(fx.leaderRun("run-1")).toMatchObject({ outcome: null });
  });

  it("refuses an ID colliding with another instance's run, keeping its owner", () => {
    const fx = fixture();
    fx.leaderStart("run-1", "host-b", "actor-b");
    expect(() => fx.leaderStart("run-1", "host-a", "actor-1")).toThrow();
    expect(owner(fx, "run-1")).toEqual({ actor_id: "actor-b", instance_id: "host-b" });
    expect(fx.leaderReceipts.apply("host-a", forged("host-a", "run-1")).outcome).toEqual({
      status: "conflict",
      kind: "wrong_instance",
    });
    expect(fx.leaderRun("run-1")).toMatchObject({ outcome: null });
    // The owner's receipt still applies.
    expect(fx.leaderReceipts.apply("host-b", forged("host-b", "run-1", "owner")).outcome).toEqual({
      status: "applied",
      actorRunClosed: true,
    });
    expect(fx.leaderRun("run-1")).toMatchObject({ outcome: "completed", output: "owner" });
  });

  it("refuses a duplicate registration, so the run still takes one terminal", () => {
    const fx = fixture();
    fx.leaderStart("run-1");
    expect(() => fx.leaderStart("run-1")).toThrow();
    expect(() => fx.leaderStart("run-1", "host-a", "actor-2")).toThrow();
    expect(owner(fx, "run-1")).toEqual({ actor_id: "actor-1", instance_id: "host-a" });
    expect(fx.leaderReceipts.apply("host-a", forged("host-a", "run-1")).outcome.status).toBe(
      "applied"
    );
    expect(fx.leader.db.prepare("SELECT COUNT(*) AS n FROM instance_run_terminals").get()).toEqual({
      n: 1,
    });
  });

  it("applies no early receipt from an instance other than the registering one", () => {
    const fx = fixture();
    expect(fx.leaderReceipts.apply("host-b", forged("host-b", "run-1", "other")).outcome).toEqual({
      status: "conflict",
      kind: "unknown_run",
    });
    expect(fx.leaderStart("run-1", "host-a")).toBeUndefined();
    expect(fx.leaderRun("run-1")).toMatchObject({ outcome: null });
    expect(fx.conflicts()).toEqual([
      { instance_id: "host-b", run_id: "run-1", kind: "unknown_run" },
    ]);
    // A colliding registration by the early sender leaves its receipt unapplied.
    expect(() => fx.leaderStart("run-1", "host-b")).toThrow();
    expect(fx.conflicts()).toEqual([
      { instance_id: "host-b", run_id: "run-1", kind: "unknown_run" },
    ]);
    expect(fx.leaderReceipts.apply("host-a", forged("host-a", "run-1", "genuine")).outcome).toEqual(
      { status: "applied", actorRunClosed: true }
    );
    expect(fx.leaderRun("run-1")).toMatchObject({ outcome: "completed", output: "genuine" });
  });

  it("leaves an early receipt staged when its colliding registration fails", () => {
    const fx = fixture();
    new ActorRunRepository(fx.leader.db).start({ id: "run-1", actorId: "local", modelConfig });
    // Staged early: the leader has no receipt-backed run-1 to apply it to.
    expect(fx.leaderReceipts.apply("host-a", forged("host-a", "run-1")).outcome).toEqual({
      status: "conflict",
      kind: "unknown_run",
    });
    expect(() => fx.leaderStart("run-1")).toThrow();
    expect(fx.leaderRun("run-1")).toMatchObject({ outcome: null });
    expect(owner(fx, "run-1")).toEqual({ actor_id: "local", instance_id: null });
    expect(fx.conflicts()).toEqual([
      { instance_id: "host-a", run_id: "run-1", kind: "unknown_run" },
    ]);
  });
});

describe("selected-work recovery budget for receipt-backed runs (#1119)", () => {
  /** The leader's production accounting and budget read over one mesh.db file. */
  function leaderBudget(path?: string) {
    const leader = openDb(path);
    const runs = new ActorRunRepository(leader.db);
    const receipts = new InstanceRunReceiptRepository(leader.db);
    const accounting = createRunAccounting(
      () => runs,
      () => receipts
    );
    /** `durableHost: null` opens a run without the receipt contract. */
    const begin = (runId: string, durableHost: string | null = "host-a") => {
      accounting.begin("actor-1", runId, modelConfig, durableHost ?? undefined);
      leader.db
        .prepare("UPDATE actor_runs SET focus_entry_ids_json = ? WHERE id = ?")
        .run(JSON.stringify(["entry-1"]), runId);
    };
    const returned = (runId: string, success = true, durableHost: string | null = "host-a") => {
      begin(runId, durableHost);
      accounting.complete("actor-1", runId, {
        success,
        exitCode: success ? 0 : 1,
        output: runId,
        termination: "observed",
      });
    };
    /** What the mesh reads: successful returns for entry-1, optionally excluding the current run. */
    const spent = (excludeRunId?: string) =>
      runs.completedFocusEntryCounts("actor-1", excludeRunId).get("entry-1") ?? 0;
    const outcome = (runId: string) =>
      leader.db.prepare("SELECT outcome FROM actor_runs WHERE id = ?").get(runId);
    return { ...leader, receipts, accounting, begin, returned, spent, outcome };
  }

  it("spends the budget on each successful return while receipts are withheld, durably and once per run", () => {
    const first = leaderBudget();
    first.returned("run-1");
    // The mesh retries while prior returns + this one < 2.
    expect(first.spent("run-1")).toBe(0);
    first.returned("run-2");
    expect(first.spent("run-2")).toBe(1);
    expect(first.spent()).toBe(2);
    // Neither run is closed or relabelled: both wait for their receipts.
    expect(first.outcome("run-1")).toEqual({ outcome: null });
    expect(first.outcome("run-2")).toEqual({ outcome: null });
    expect(first.receipts.unresolvedRuns(10).runs).toBe(2);

    // Neither an unproven end nor an observed failure is a successful return.
    first.begin("run-3");
    expect(first.accounting.abandon("actor-1", "run-3", "termination-unresolved")).toBe("run-3");
    first.returned("run-4", false);
    expect(first.spent()).toBe(2);
    expect(first.receipts.unresolvedRuns(10).runs).toBe(4);
    first.db.close();

    // A leader restart reads the same budget.
    const after = leaderBudget(first.path);
    expect(after.spent()).toBe(2);
    expect(after.spent("run-2")).toBe(1);

    // The receipts land later, and again: each run still counts once.
    for (const runId of ["run-1", "run-2"]) {
      expect(after.receipts.apply("host-a", forged("host-a", runId)).outcome.status).toBe(
        "applied"
      );
      expect(after.receipts.apply("host-a", forged("host-a", runId)).outcome.status).toBe(
        "duplicate"
      );
    }
    expect(after.outcome("run-1")).toEqual({ outcome: "completed" });
    expect(after.spent()).toBe(2);
    expect(after.receipts.unresolvedRuns(10).runs).toBe(2);

    // A run without the receipt contract still counts from its closed row.
    after.returned("run-5", true, null);
    expect(after.outcome("run-5")).toEqual({ outcome: "completed" });
    expect(after.spent()).toBe(3);
  });

  it("does not count a receipt-backed run before its return, nor after a failed one", () => {
    const leader = leaderBudget();
    leader.begin("run-1");
    expect(leader.spent()).toBe(0);
    leader.accounting.complete("actor-1", "run-1", {
      success: false,
      exitCode: 1,
      output: "failed",
      termination: "observed",
    });
    // A receipt that arrives for it adds nothing: it is not a successful return.
    const failed = serializeRunReceipt(
      createRunReceipt({
        instanceId: "host-a",
        runId: "run-1",
        actorId: "actor-1",
        endedAt: "2026-10-20T09:00:00.000Z",
        outcome: "completed",
        success: false,
        exitCode: 1,
        output: "failed",
      })
    );
    expect(
      leader.receipts.apply("host-a", {
        runId: "run-1",
        receipt: failed,
        digest: runReceiptDigest(failed),
      }).outcome.status
    ).toBe("applied");
    expect(leader.spent()).toBe(0);
  });

  it("does not count an unresolved run when its successful receipt lands later", () => {
    const leader = leaderBudget();
    leader.returned("run-1");
    // The recovery's transport drops: no return, so no budget is spent.
    leader.begin("run-2");
    expect(leader.accounting.abandon("actor-1", "run-2", "termination-unresolved")).toBe("run-2");
    expect(leader.spent()).toBe(1);
    // Its receipt then closes it as a success; the entry still has its recovery.
    expect(leader.receipts.apply("host-a", forged("host-a", "run-2")).outcome.status).toBe(
      "applied"
    );
    expect(leader.outcome("run-2")).toEqual({ outcome: "completed" });
    expect(leader.spent()).toBe(1);
  });
});
