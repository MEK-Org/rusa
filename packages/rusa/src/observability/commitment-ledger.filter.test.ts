import { describe, expect, it } from "vitest";
import type { ActorRecord } from "../actor/actor-record.js";
import type { MeshEvent, MeshEventKind } from "../db/repositories/mesh-event-repository.js";
import {
  COMMITMENT_LEDGER_BODY_KINDS,
  COMMITMENT_LEDGER_KINDS,
  type CommitmentLedgerReport,
  projectOpenCommitments,
} from "./commitment-ledger.js";

/**
 * Holds `COMMITMENT_LEDGER_KINDS` / `COMMITMENT_LEDGER_BODY_KINDS` to account.
 *
 * Those two lists let a reader fetch a slice of history instead of all of it —
 * on the live mesh, 46k rows and 23 MB of strings instead of 74k rows and
 * 185 MB. That is only sound if the slice is *lossless*: the projection must
 * return exactly the same report from the slice as from the whole. A comment
 * cannot promise that, and the dangerous direction of drift is silent — a kind
 * marked `ignored` that the projection actually reads makes rows quietly
 * disappear, with nothing red anywhere.
 *
 * So the claim is tested as a difference, not as a list: every ignored kind is
 * injected into a fixture that is *sensitive* to being read, and the report must
 * not move. The two control tests exist to prove the fixture can in fact tell —
 * without them, a projection that read nothing at all would pass.
 */

const NOW = new Date("2026-06-30T12:00:00.000Z");
/** Just inside every threshold, so anything read here lands on a live boundary. */
const RECENTLY = "2026-06-30T11:59:00.000Z";

/**
 * Total by construction: a kind added to `MeshEventKind` and not listed here
 * fails to compile, so a new kind cannot slip past this file unexamined — the
 * same reason `LEDGER_READS` is a `Record` rather than a `Set`.
 */
const ALL_MESH_EVENT_KINDS = Object.keys({
  actor_spawned: 0,
  root_control_action: 0,
  message_sent: 0,
  message_received: 0,
  handle_granted: 0,
  actor_retired: 0,
  actor_revived: 0,
  actor_reparented: 0,
  actor_charter_set: 0,
  actor_model_set: 0,
  run_queued: 0,
  run_start: 0,
  run_first_chunk: 0,
  run_end: 0,
  run_abandoned: 0,
  run_preempted: 0,
  portable_context_compacted: 0,
  run_coalesced: 0,
  run_continued: 0,
  run_yielded: 0,
  continuation_capped: 0,
  capability_granted: 0,
  capability_revoked: 0,
  scheduled_wake: 0,
  event_source_subscribed: 0,
  event_source_unsubscribed: 0,
  stamp_invalid: 0,
  host_job_submitted: 0,
  host_job_stopped: 0,
  host_job_exited: 0,
  email_sent: 0,
  calendar_read: 0,
  drive_read: 0,
  calendar_write: 0,
} satisfies Record<MeshEventKind, 0>) as MeshEventKind[];

const IGNORED_KINDS = ALL_MESH_EVENT_KINDS.filter(
  (kind) => !COMMITMENT_LEDGER_KINDS.includes(kind)
);

function thread(id: string, parentId: string | null, extra: Partial<ActorRecord> = {}) {
  return {
    id,
    charter: `charter for ${id}`,
    parentId,
    status: "active",
    createdAt: "2026-06-27T00:00:00.000Z",
    ...extra,
  } satisfies ActorRecord;
}

function event(
  id: string,
  actorId: string,
  kind: MeshEventKind,
  ts: string,
  extra: Partial<MeshEvent> = {}
): MeshEvent {
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

/**
 * Actors positioned so that each row kind the projection can emit is present,
 * and each is one event away from flipping. `waked` and `event-driven` are the
 * negative half: they are the actors a *dropped* read would turn into a false
 * alarm, where the others are the ones it would silence.
 */
const THREADS: ActorRecord[] = [
  thread("root", null),
  thread("steward", "root"),
  thread("done-leaf", "steward"),
  thread("failed-leaf", "steward"),
  thread("capped-leaf", "steward"),
  thread("silent-leaf", "root"),
  thread("abandoned-leaf", "steward"),
  thread("event-driven", "steward"),
  thread("waked", "steward"),
  thread("never-ran", "root"),
  thread("retired-leaf", "steward", { status: "retired" }),
];

const YIELD_NOTE = ["Waiting-on: steward to bless the release", "Nothing else outstanding."].join(
  "\n"
);

const TRACKING_NOTE = [
  "Please pick this up when you can.",
  "Tracking: ship the quota retry | owner=steward | done-when=PR is merged to staging",
].join("\n");

function baseEvents(): MeshEvent[] {
  return [
    // Yielded complete, still active, no later progress → silent_actor.
    event("e-done-yield", "done-leaf", "run_yielded", "2026-06-29T00:00:00.000Z", {
      detail: "complete",
      body: YIELD_NOTE,
    }),
    // A failed run with no later start → failed_run.
    event("e-failed-start", "failed-leaf", "run_start", "2026-06-30T10:00:00.000Z"),
    event("e-failed-end", "failed-leaf", "run_end", "2026-06-30T11:00:00.000Z", {
      success: false,
    }),
    // Capped continuation counts as the same failure shape.
    event("e-capped", "capped-leaf", "continuation_capped", "2026-06-30T11:30:00.000Z"),
    // Last progress two days back → silent_actor; the body also registers a
    // request_commitment, which is the only row that reads prose.
    event("e-silent-spawn", "silent-leaf", "actor_spawned", "2026-06-28T00:00:00.000Z"),
    event("e-silent-msg", "silent-leaf", "message_sent", "2026-06-28T01:00:00.000Z", {
      body: TRACKING_NOTE,
      payload: JSON.stringify({ messageId: "m-1", to: "steward" }),
    }),
    // A run it actually executed and had superseded still counts as proof of life.
    event("e-abandoned-old", "abandoned-leaf", "actor_spawned", "2026-06-27T00:00:00.000Z"),
    event("e-abandoned", "abandoned-leaf", "run_abandoned", "2026-06-30T09:00:00.000Z", {
      payload: JSON.stringify({ started: true, reason: "coalesced" }),
    }),
    // Complete + a live subscription → deliberately no row.
    event("e-sub", "event-driven", "event_source_subscribed", "2026-06-28T00:00:00.000Z", {
      detail: "gmail:inbox",
    }),
    event("e-sub-drop", "event-driven", "event_source_unsubscribed", "2026-06-28T00:30:00.000Z", {
      detail: "gmail:archive",
    }),
    event("e-driven-yield", "event-driven", "run_yielded", "2026-06-28T02:00:00.000Z", {
      detail: "complete",
      body: YIELD_NOTE,
    }),
    // Wake history says the owner is not expected to retire it → no completion row.
    event("e-waked-wake", "waked", "scheduled_wake", "2026-06-28T00:00:00.000Z"),
    event("e-waked-yield", "waked", "run_yielded", "2026-06-28T03:00:00.000Z", {
      detail: "complete",
      body: YIELD_NOTE,
    }),
    // Events for an actor with no thread record at all.
    event("e-ghost", "ghost-actor", "run_end", "2026-06-30T11:45:00.000Z", { success: false }),
    // A retired thread stays out of every branch.
    event("e-retired", "retired-leaf", "run_yielded", "2026-06-28T00:00:00.000Z", {
      detail: "complete",
      body: YIELD_NOTE,
    }),
    ...ALL_MESH_EVENT_KINDS.map((kind, index) =>
      event(
        `e-noise-${kind}`,
        "steward",
        kind,
        `2026-06-28T04:${String(index).padStart(2, "0")}:00.000Z`
      )
    ),
  ];
}

function project(events: MeshEvent[]): CommitmentLedgerReport {
  return projectOpenCommitments({ threads: THREADS, events, now: NOW });
}

/** What `MeshEventRepository.listByKinds` hands back for these two lists. */
function asFetchedByTheReader(events: MeshEvent[]): MeshEvent[] {
  return events
    .filter((candidate) => COMMITMENT_LEDGER_KINDS.includes(candidate.kind as MeshEventKind))
    .map((candidate) =>
      COMMITMENT_LEDGER_BODY_KINDS.includes(candidate.kind as MeshEventKind)
        ? candidate
        : { ...candidate, body: null }
    );
}

/** One event of `kind` per actor, carrying every field any branch could read. */
function shoutedAtEveryActor(kind: MeshEventKind, events: MeshEvent[]): MeshEvent[] {
  const actorIds = [...new Set(events.map((candidate) => candidate.actorId ?? "root"))];
  return [
    ...events,
    ...actorIds.map((actorId) =>
      event(`e-shout-${kind}-${actorId}`, actorId, kind, RECENTLY, {
        detail: "complete",
        body: [YIELD_NOTE, TRACKING_NOTE].join("\n"),
        payload: JSON.stringify({ started: true, messageId: "m-shout", to: "root" }),
        success: false,
      })
    ),
  ];
}

describe("commitment ledger event filter", () => {
  it("is a fixture the projection has plenty to say about", () => {
    const report = project(baseEvents());
    const kinds = new Set(report.rows.map((row) => row.kind));
    expect([...kinds].sort()).toEqual(["failed_run", "request_commitment", "silent_actor"]);
    // Losslessness is only worth testing if the filter drops something.
    expect(asFetchedByTheReader(baseEvents()).length).toBeLessThan(baseEvents().length);
  });

  it("reads the same ledger from the filtered slice as from the whole history", () => {
    expect(project(asFetchedByTheReader(baseEvents()))).toEqual(project(baseEvents()));
  });

  it("does not move when a kind it ignores arrives loudly", () => {
    expect(IGNORED_KINDS.length).toBeGreaterThan(0);
    const baseline = project(baseEvents());
    for (const kind of IGNORED_KINDS) {
      expect(project(shoutedAtEveryActor(kind, baseEvents())), kind).toEqual(baseline);
    }
  });

  it("would notice: the same shout in a kind it does read moves the ledger", () => {
    const baseline = project(baseEvents());
    for (const kind of ["run_start", "run_end", "scheduled_wake"] as const) {
      expect(project(shoutedAtEveryActor(kind, baseEvents())), kind).not.toEqual(baseline);
    }
  });

  it("does not move when a body it never reads is dropped", () => {
    const withBodiesEverywhere = baseEvents().map((candidate) => ({
      ...candidate,
      body: candidate.body ?? [YIELD_NOTE, TRACKING_NOTE].join("\n"),
    }));
    const withoutUnreadBodies = withBodiesEverywhere.map((candidate) =>
      COMMITMENT_LEDGER_BODY_KINDS.includes(candidate.kind as MeshEventKind)
        ? candidate
        : { ...candidate, body: null }
    );
    expect(project(withoutUnreadBodies)).toEqual(project(withBodiesEverywhere));
  });

  it("would notice: dropping a body it does read moves the ledger", () => {
    for (const kind of COMMITMENT_LEDGER_BODY_KINDS) {
      const blanked = baseEvents().map((candidate) =>
        candidate.kind === kind ? { ...candidate, body: null } : candidate
      );
      expect(project(blanked), kind).not.toEqual(project(baseEvents()));
    }
  });

  it("never asks for a body from a kind it did not ask for", () => {
    expect(COMMITMENT_LEDGER_BODY_KINDS.length).toBeGreaterThan(0);
    for (const kind of COMMITMENT_LEDGER_BODY_KINDS) {
      expect(COMMITMENT_LEDGER_KINDS).toContain(kind);
    }
    expect(new Set(COMMITMENT_LEDGER_KINDS).size).toBe(COMMITMENT_LEDGER_KINDS.length);
  });
});
