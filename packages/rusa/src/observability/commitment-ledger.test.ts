import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateHandle } from "../actor/handle-generator.js";
import { RUN_TERMINAL_EVENT_KINDS } from "../actor/mesh-events.js";
import type { ThreadRecord } from "../actor/thread-registry.js";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import {
  type CommitmentLedgerStoryboardSnapshot,
  isProgressEvent,
  projectOpenCommitments,
  projectRequestCommitmentRows,
  RUN_TERMINAL_PROGRESS_RULES,
  renderCommitmentLedgerHtml,
  renderCommitmentLedgerStoryboardHtml,
} from "./commitment-ledger.js";

const NOW = new Date("2026-06-30T12:00:00.000Z");

function thread(
  id: string,
  parentId: string | null = "root",
  createdAt = "2026-06-29T00:00:00.000Z",
  extra: Partial<ThreadRecord> = {}
): ThreadRecord {
  return {
    id,
    charter: id,
    parentId,
    status: "active",
    createdAt,
    ...extra,
  };
}

function event(id: string, actorId: string, kind: string, ts: string, extra = {}): MeshEvent {
  return {
    id,
    actorId,
    kind,
    ts,
    detail: null,
    body: null,
    payload: null,
    success: null,
    ...extra,
  };
}

describe("commitment ledger projection", () => {
  it("projects open commitment rows with owner, source artifact, confidence, and waiting-on", () => {
    const report = projectOpenCommitments({
      now: NOW,
      threads: [thread("failed", "steward"), thread("silent", "root")],
      events: [
        event("e1", "failed", "run_yielded", "2026-06-30T09:00:00.000Z", {
          detail: "blocked",
          body: "implemented\nWaiting-on: thread:steward retire",
        }),
        event("e2", "failed", "run_end", "2026-06-30T11:00:00.000Z", { success: false }),
        event("e4", "silent", "message_sent", "2026-06-29T00:00:00.000Z"),
      ],
    });

    expect(report.rows.map((row) => [row.subject_actor_id, row.kind])).toEqual([
      ["failed", "failed_run"],
      ["silent", "silent_actor"],
    ]);
    expect(report.rows[0]).toEqual(
      expect.objectContaining({
        id: "failed_run:failed:e2",
        status: "open",
        owner_actor_id: "steward",
        source_artifact_type: "mesh_event",
        source_artifact_ref: "e2",
        waiting_on: "thread:steward retire",
        owner_expects_retirement: null,
        confidence: 0.9,
        resolved_at: null,
      })
    );
    expect(report.rows[0].evidence_json).toMatchObject({
      event_kind: "run_end",
      retirement_expectation_reason: "ambiguous_childless_leaf",
    });
  });

  it("does not emit missed_wake alerts for scheduled wakes", () => {
    const report = projectOpenCommitments({
      now: NOW,
      threads: [
        thread("queued-not-started", "root", "2026-06-30T10:00:00.000Z"),
        thread("never-queued", "root", "2026-06-30T10:00:00.000Z"),
      ],
      events: [
        event("q-wake", "queued-not-started", "scheduled_wake", "2026-06-30T11:00:00.000Z"),
        event("q-queued", "queued-not-started", "run_queued", "2026-06-30T11:00:30.000Z"),
        event("n-wake", "never-queued", "scheduled_wake", "2026-06-30T11:00:00.000Z"),
      ],
    });

    expect(report.rows.filter((row) => row.kind === "missed_wake")).toEqual([]);
    expect(report.rows).toEqual([]);
  });

  it("reports null retirement expectation for childless no-cron actors until Phase 2 metadata exists", () => {
    const report = projectOpenCommitments({
      now: NOW,
      threads: [thread("ambiguous")],
      events: [event("e1", "ambiguous", "run_end", "2026-06-30T11:00:00.000Z", { success: false })],
    });

    expect(report.rows[0]).toEqual(
      expect.objectContaining({
        kind: "failed_run",
        owner_expects_retirement: null,
        evidence_json: expect.objectContaining({
          retirement_expectation_reason: "ambiguous_childless_leaf",
        }),
      })
    );
  });

  it("does not treat childless complete yields as expected retirement", () => {
    const report = projectOpenCommitments({
      now: NOW,
      threads: [thread("held-lead")],
      events: [
        event("e1", "held-lead", "run_yielded", "2026-06-29T00:00:00.000Z", {
          detail: "complete",
        }),
      ],
    });

    expect(report.rows).toContainEqual(
      expect.objectContaining({
        kind: "silent_actor",
        subject_actor_id: "held-lead",
        owner_expects_retirement: null,
        evidence_json: expect.objectContaining({
          retirement_expectation_reason: "ambiguous_childless_leaf",
        }),
      })
    );
  });

  it("decides every run-terminal kind explicitly, so none can be silently omitted", () => {
    // The structural half. `RUN_TERMINAL_EVENT_KINDS` exists so the producer and
    // every reader that tracks runs stay in step; this reader had taken `run_end`
    // and silently omitted `run_abandoned` -- twice, as two separate regressions,
    // which is why this is a structural check and not one more case test. The
    // `Record` type makes a new terminal kind a compile error until it is
    // decided; this asserts the runtime shape both ways, so a stale entry for a
    // removed kind is caught too.
    expect(Object.keys(RUN_TERMINAL_PROGRESS_RULES).sort()).toEqual(
      [...RUN_TERMINAL_EVENT_KINDS].sort()
    );
  });

  it("counts an abandoned run as progress only when the actor actually started", () => {
    // The distinction is not decidable from the kind, which is the whole reason
    // the rule is payload-conditional: `run_abandoned` covers a run the actor
    // executed and had superseded (coalesced) and one the scheduler tore down
    // before `onRunStart` (start-cancelled). Every `run_abandoned` in the live
    // event log is the latter.
    expect(isProgressEvent({ kind: "run_abandoned", payload: '{"started":true}' })).toBe(true);
    expect(isProgressEvent({ kind: "run_abandoned", payload: '{"started":false}' })).toBe(false);

    // Absent or unparseable payload reads as "did not start" — the cheap
    // direction to be wrong in, matching `abandonedRunHadStarted`.
    expect(isProgressEvent({ kind: "run_abandoned", payload: null })).toBe(false);
    expect(isProgressEvent({ kind: "run_abandoned", payload: "not json" })).toBe(false);

    // Controls, so the assertions above are attributable to the payload rule
    // rather than to anything incidental: an unconditional terminal kind counts,
    // and being merely queued never does.
    expect(isProgressEvent({ kind: "run_end", payload: null })).toBe(true);
    expect(isProgressEvent({ kind: "run_queued", payload: null })).toBe(false);
  });

  it("splits silent_actor on whether the abandoned runs started", () => {
    // The behavioural half, as a discriminating pair against one thread shape:
    // both actors were created 36 h ago (past the 24 h threshold) and both have
    // exactly one event, 1 h ago, of the same kind. Only the payload differs.
    const report = projectOpenCommitments({
      now: NOW,
      threads: [thread("ran-then-superseded"), thread("never-woke")],
      events: [
        event("e1", "ran-then-superseded", "run_abandoned", "2026-06-30T11:00:00.000Z", {
          detail: "coalesced",
          payload: '{"started":true}',
        }),
        event("e2", "never-woke", "run_abandoned", "2026-06-30T11:00:00.000Z", {
          detail: "start-cancelled",
          payload: '{"started":false}',
        }),
      ],
    });

    // Started: the actor ran an hour ago, so there is nothing to flag. Before
    // this change it took the `!lastProgress` branch and was measured from
    // `createdAt`, asserting "no recorded progress event" over a log that has one.
    expect(report.rows.filter((row) => row.subject_actor_id === "ran-then-superseded")).toEqual([]);

    // Not started: the scheduler tore the run down before `onRunStart`, so the
    // actor has done nothing and the row must still fire. Counting this as
    // progress would be a silent_actor MISS — the failure this row exists to
    // catch, and the worse direction of the two.
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        kind: "silent_actor",
        subject_actor_id: "never-woke",
        source_artifact_ref: null,
        reason: "Active actor has no recorded progress event past the silence threshold.",
      })
    );
  });

  it("keeps active-silent noise down after an intentional blocked yield", () => {
    const report = projectOpenCommitments({
      now: NOW,
      threads: [thread("blocked")],
      events: [
        event("e1", "blocked", "run_yielded", "2026-06-29T00:00:00.000Z", {
          detail: "blocked",
          body: "Waiting-on: reviewer",
        }),
      ],
    });

    expect(report.rows).toEqual([]);
  });

  it("uses event order as the tie-break for same-millisecond later progress", () => {
    const report = projectOpenCommitments({
      now: NOW,
      threads: [thread("recovered")],
      events: [
        event("failed-end", "recovered", "run_end", "2026-06-30T11:00:00.000Z", {
          success: false,
        }),
        event("next-start", "recovered", "run_start", "2026-06-30T11:00:00.000Z"),
      ],
    });

    expect(report.rows).toEqual([]);
  });

  it("filters by confidence and owner", () => {
    const report = projectOpenCommitments({
      now: NOW,
      minConfidence: 0.8,
      ownerActorId: "steward",
      threads: [thread("silent", "root"), thread("failed", "steward")],
      events: [
        event("e1", "silent", "message_sent", "2026-06-29T00:00:00.000Z"),
        event("e2", "failed", "run_end", "2026-06-30T11:00:00.000Z", { success: false }),
      ],
    });

    expect(report.rows.map((row) => [row.subject_actor_id, row.kind])).toEqual([
      ["failed", "failed_run"],
    ]);
  });

  it("projects tracked message commitments as open operator-ask loops", () => {
    const report = projectOpenCommitments({
      now: NOW,
      threads: [],
      events: [
        event(
          "operator-ask-dropped",
          "cloudy-porpoise",
          "message_sent",
          "2026-06-30T08:00:00.000Z",
          {
            body: "Tracking: Operator ask: show a drive-to-done ledger report | owner=cloudy-porpoise | done-when=storyboard PR opened",
          }
        ),
      ],
    });

    expect(report.rows).toEqual([
      expect.objectContaining({
        id: "request_commitment:operator-ask-dropped",
        status: "open",
        kind: "request_commitment",
        owner_actor_id: "cloudy-porpoise",
        subject_actor_id: "Operator ask: show a drive-to-done ledger report",
        source_artifact_type: "message",
        source_artifact_ref: "operator-ask-dropped",
        waiting_on: "cloudy-porpoise -> storyboard PR opened",
        confidence: 1,
        age_ms: 4 * 60 * 60 * 1000,
      }),
    ]);
  });

  it("resolves the configured root display handle as an owner reference", () => {
    const report = projectOpenCommitments({
      now: NOW,
      rootHandle: "ember-familiar",
      threads: [],
      events: [
        event("ember-owned", "cloudy-porpoise", "message_sent", "2026-06-30T08:00:00.000Z", {
          body: "Tracking: Operator ask: root-owned work | owner=ember-familiar | done-when=configured handle resolved",
        }),
      ],
    });

    expect(report.rows).toEqual([
      expect.objectContaining({
        owner_actor_id: "root",
        waiting_on: "ember-familiar -> configured handle resolved",
      }),
    ]);
  });

  it("still resolves the default root-actor handle as root when a root handle is configured", () => {
    const report = projectOpenCommitments({
      now: NOW,
      rootHandle: "ember-familiar",
      threads: [],
      events: [
        event("default-owned", "cloudy-porpoise", "message_sent", "2026-06-30T08:00:00.000Z", {
          body: "Tracking: Operator ask: default-owned work | owner=root-actor | done-when=default handle resolved",
        }),
      ],
    });

    expect(report.rows).toEqual([expect.objectContaining({ owner_actor_id: "root" })]);
  });

  it("normalizes handle-owned and id-owned commitments to canonical owner ids", () => {
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const ownerHandle = generateHandle(ownerId);
    const report = projectOpenCommitments({
      now: NOW,
      ownerActorId: ownerId,
      threads: [thread(ownerId, "root")],
      events: [
        event("handle-owned", "root", "message_sent", "2026-06-30T08:00:00.000Z", {
          body: `Tracking: Operator ask: handle-owned work | owner=${ownerHandle} | done-when=handle row tested`,
        }),
        event("id-owned", "root", "message_sent", "2026-06-30T08:05:00.000Z", {
          body: `Tracking: Operator ask: id-owned work | owner=${ownerId} | done-when=id row tested`,
        }),
      ],
    });

    expect(report.rows.map((row) => row.source_artifact_ref)).toEqual(["handle-owned", "id-owned"]);
    expect(report.rows).toEqual([
      expect.objectContaining({
        owner_actor_id: ownerId,
        waiting_on: `${ownerHandle} -> handle row tested`,
      }),
      expect.objectContaining({
        owner_actor_id: ownerId,
        waiting_on: `${ownerHandle} -> id row tested`,
      }),
    ]);
  });

  it("normalizes owner filters supplied as handles", () => {
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const ownerHandle = generateHandle(ownerId);
    const report = projectOpenCommitments({
      now: NOW,
      ownerActorId: ownerHandle,
      threads: [thread(ownerId, "root")],
      events: [
        event("handle-owned", "root", "message_sent", "2026-06-30T08:00:00.000Z", {
          body: `Tracking: Operator ask: handle-owned work | owner=${ownerHandle} | done-when=handle row tested`,
        }),
      ],
    });

    expect(report.rows).toEqual([
      expect.objectContaining({
        owner_actor_id: ownerId,
      }),
    ]);
  });

  it("keeps active-silent noise down for healthy idle event-driven standing owners", () => {
    const report = projectOpenCommitments({
      now: NOW,
      threads: [thread("sleepy-topi")],
      events: [
        event("e1", "sleepy-topi", "event_source_subscribed", "2026-06-29T00:00:00.000Z", {
          detail: "repo:invoice-machine",
        }),
        event("e2", "sleepy-topi", "run_yielded", "2026-06-29T01:00:00.000Z", {
          detail: "complete",
        }),
      ],
    });

    expect(report.rows).toEqual([]);
  });

  it("keeps and flags request commitments with unresolvable owners", () => {
    const report = projectOpenCommitments({
      now: NOW,
      threads: [],
      events: [
        event("typo-owned", "root", "message_sent", "2026-06-30T08:00:00.000Z", {
          body: "Tracking: Operator ask: typo-owned work | owner=cloudy-propoise | done-when=typo row tested",
        }),
      ],
    });

    expect(report.rows).toEqual([
      expect.objectContaining({
        owner_actor_id: "cloudy-propoise",
        reason: expect.stringContaining("did not resolve"),
        evidence_json: expect.objectContaining({
          owner_raw: "cloudy-propoise",
          owner_resolution: "unresolved",
        }),
      }),
    ]);
  });

  it("resolves tracked message commitments on a later done marker", () => {
    const rows = projectRequestCommitmentRows({
      now: NOW,
      includeResolved: true,
      requests: [
        {
          id: "happy-path",
          ownerActorId: "root",
          subject: "Operator ask: close issue #530",
          requestedAt: "2026-06-30T09:00:00.000Z",
          doneWhen: "issue #530 closed",
          resolvedAt: "2026-06-30T09:20:00.000Z",
          sourceArtifactRef: "happy-path-message",
        },
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        status: "resolved",
        confidence: 1,
        reason: "Request commitment was driven to a recorded completion.",
        age_ms: 20 * 60 * 1000,
      }),
    ]);
  });

  it("renders a deterministic single-snapshot ledger report", () => {
    const report = projectOpenCommitments({
      now: NOW,
      threads: [
        thread("root", null, "2026-06-30T11:45:00.000Z"),
        thread("cloudy-porpoise", "root", "2026-06-30T11:45:00.000Z", { status: "retired" }),
        thread("failed-worker", "steward", "2026-06-30T10:00:00.000Z"),
        thread("standing-cron", "root", "2026-06-30T08:00:00.000Z"),
      ],
      events: [
        event("root-run", "root", "run_start", "2026-06-30T11:50:00.000Z"),
        event("failed-start", "failed-worker", "run_start", "2026-06-30T11:00:00.000Z"),
        event("failed-end", "failed-worker", "run_end", "2026-06-30T11:30:00.000Z", {
          success: false,
        }),
        event("cron-wake", "standing-cron", "scheduled_wake", "2026-06-30T09:00:00.000Z"),
        // A honoured wake queues first and starts second — `run_start` is what counts as progress.
        event("cron-queued", "standing-cron", "run_queued", "2026-06-30T09:00:30.000Z"),
        event("cron-run", "standing-cron", "run_start", "2026-06-30T09:05:00.000Z"),
      ],
      requestCommitments: [
        {
          id: "operator-ask-dropped",
          ownerActorId: "cloudy-porpoise",
          subject: "Operator ask: turn observability into a drive-to-done report",
          requestedAt: "2026-06-30T08:00:00.000Z",
          doneWhen: "storyboard PR opened",
          sourceArtifactRef: "mesh-message:operator-ask-dropped",
          waitingOn: "observability lead follow-through",
        },
      ],
    });

    expect(report.rows.map((row) => row.subject_actor_id)).toEqual([
      "Operator ask: turn observability into a drive-to-done report",
      "failed-worker",
    ]);
    expect(report.rows).toEqual([
      expect.objectContaining({
        status: "open",
        kind: "request_commitment",
        owner_actor_id: "cloudy-porpoise",
        subject_actor_id: "Operator ask: turn observability into a drive-to-done report",
        source_artifact_ref: "mesh-message:operator-ask-dropped",
        waiting_on: "observability lead follow-through",
        confidence: 1,
        age_ms: 4 * 60 * 60 * 1000,
      }),
      expect.objectContaining({
        kind: "failed_run",
        owner_actor_id: "steward",
        subject_actor_id: "failed-worker",
        source_artifact_ref: "failed-end",
        waiting_on: null,
        confidence: 0.9,
        owner_expects_retirement: null,
        age_ms: 30 * 60 * 1000,
      }),
    ]);

    const html = renderCommitmentLedgerHtml(report);
    const sample = readFileSync(
      join(process.cwd(), "src/observability/testdata/sample-ledger-report.html"),
      "utf8"
    );
    expect(html).toBe(sample);
  });

  it("renders the deterministic MVP storyboard report", () => {
    const html = buildMvpStoryboardHtml();
    const sample = readFileSync(
      join(process.cwd(), "src/observability/testdata/mvp-storyboard-report.html"),
      "utf8"
    );
    expect(html).toBe(sample);
  });
});

function buildMvpStoryboardHtml(): string {
  return renderCommitmentLedgerStoryboardHtml({
    title: "Commitment Ledger MVP Storyboard",
    generatedAt: "2026-07-01T23:30:00.000Z",
    intro:
      "A deterministic vertical slice of the ledger as an observe-and-route surface: registered work appears, stale ownership becomes visible, and rows dissolve only after the owner acts.",
    snapshots: buildMvpStoryboardSnapshots(),
    knownGaps: [
      "The 2026-07-01 21:35Z mesh restart killed kickoff runs while the registry still showed actors active. The current four divergence classes would miss that for up to 24h because run_start is treated as progress; a future interrupted_run rule should flag run_start with no run_end or yield after roughly 30-60 minutes.",
    ],
  });
}

function buildMvpStoryboardSnapshots(): CommitmentLedgerStoryboardSnapshot[] {
  const allThreads = [
    thread("root", null, "2026-06-30T00:00:00.000Z"),
    thread("standing-cron", "root", "2026-06-30T00:00:00.000Z"),
    thread("review-worker", "root", "2026-07-01T15:00:00.000Z"),
  ];
  const allEvents = [
    event("cron-wake-t0", "standing-cron", "scheduled_wake", "2026-06-30T17:50:00.000Z"),
    event("cron-queued-t0", "standing-cron", "run_queued", "2026-06-30T17:50:30.000Z"),
    event("cron-run-t0", "standing-cron", "run_start", "2026-06-30T17:51:00.000Z"),
    event("root-run-t0", "root", "run_start", "2026-06-30T17:55:00.000Z"),
    event("happy-tracking", "root", "message_sent", "2026-06-30T18:20:00.000Z", {
      body: "Tracking: Operator ask: close issue #530 after verifying it is complete | owner=root | done-when=issue #530 closed",
    }),
    event("issue-531-tracking", "root", "message_sent", "2026-06-30T18:40:00.000Z", {
      body: "Tracking: Operator ask: can we mark issue #531 complete? | owner=root | done-when=issue #531 closed",
    }),
    event("happy-resolved", "root", "message_sent", "2026-06-30T19:05:00.000Z", {
      body: "Done: Operator ask: close issue #530 after verifying it is complete",
    }),
    event("review-worker-yield", "review-worker", "run_yielded", "2026-07-01T15:10:00.000Z", {
      detail: "complete",
      body: "Review complete.\nWaiting-on: root retire review-worker",
    }),
    event("cron-wake-t2", "standing-cron", "scheduled_wake", "2026-07-01T21:50:00.000Z"),
    event("cron-queued-t2", "standing-cron", "run_queued", "2026-07-01T21:50:30.000Z"),
    event("cron-run-t2", "standing-cron", "run_start", "2026-07-01T21:51:00.000Z"),
    event("root-run-t2", "root", "run_start", "2026-07-01T21:55:00.000Z"),
    event("issue-531-resolved", "root", "message_sent", "2026-07-01T22:11:00.000Z", {
      body: "Done: Operator ask: can we mark issue #531 complete?",
    }),
    event("review-worker-retired", "review-worker", "actor_retired", "2026-07-01T22:11:30.000Z"),
  ];

  const snapshots = [
    {
      id: "t0",
      title: "T0 healthy",
      now: new Date("2026-06-30T18:00:00.000Z"),
      narration:
        "The standing root and cron actors are producing normal progress, and the ledger is empty. This is the false-positive guard made visible.",
    },
    {
      id: "t1",
      title: "T1 registered",
      now: new Date("2026-06-30T18:45:00.000Z"),
      narration:
        "Two operator-asks have been acknowledged with Tracking lines, so the ledger can show owner, done-when, and age immediately instead of relying on the operator to remember.",
    },
    {
      id: "t2",
      title: "T2 the slip",
      now: new Date("2026-07-01T22:10:00.000Z"),
      narration:
        "Mocked time jumps forward: one ask dissolved because root drove it to done, while #531 is still open after 27h 30m.",
    },
    {
      id: "t3",
      title: "T3 driven to done",
      now: new Date("2026-07-01T22:12:00.000Z"),
      narration:
        "Root acts on the routed attention and records the completion, then retires the finished worker. The report returns to empty because owners acted; the ledger only observed and routed.",
    },
  ];

  return snapshots.map((snapshot) => {
    const nowIso = snapshot.now.toISOString();
    const events = allEvents.filter((rec) => rec.ts <= nowIso);
    const retiredThreadIds = new Set(
      events.filter((rec) => rec.kind === "actor_retired").map((rec) => rec.actorId)
    );
    const threads = allThreads
      .filter((rec) => rec.createdAt <= nowIso)
      .map((rec) => (retiredThreadIds.has(rec.id) ? { ...rec, status: "retired" as const } : rec));
    return {
      id: snapshot.id,
      title: snapshot.title,
      narration: snapshot.narration,
      report: projectOpenCommitments({ now: snapshot.now, threads, events }),
    };
  });
}
