import type { ActorRecord } from "../actor/actor-record.js";
import { generateHandle } from "../actor/handle-generator.js";
import { abandonedRunHadStarted, type RUN_TERMINAL_EVENT_KINDS } from "../actor/mesh-events.js";
import type { MeshEvent, MeshEventKind } from "../db/repositories/mesh-event-repository.js";

export type CommitmentKind = "failed_run" | "missed_wake" | "request_commitment" | "silent_actor";
export type CommitmentStatus = "open" | "resolved" | "ignored";
export type SourceArtifactType = "mesh_event" | "yield_note" | "message" | "github" | "manual";

export interface CommitmentThresholds {
  failedRunMs: number;
  missedWakeMs: number;
  silentActorMs: number;
}

export interface CommitmentLedgerRow {
  id: string;
  status: CommitmentStatus;
  kind: CommitmentKind;
  owner_actor_id: string | null;
  subject_actor_id: string | null;
  source_artifact_type: SourceArtifactType;
  source_artifact_ref: string | null;
  waiting_on: string | null;
  owner_expects_retirement: boolean | null;
  confidence: number;
  reason: string;
  evidence_json: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  age_ms: number;
}

export interface CommitmentLedgerReport {
  generated_at: string;
  min_confidence: number;
  thresholds: CommitmentThresholds;
  rows: CommitmentLedgerRow[];
}

export interface RequestCommitmentInput {
  id: string;
  ownerActorId: string;
  subject: string;
  requestedAt: string;
  doneWhen: string;
  resolvedAt?: string | null;
  sourceArtifactType?: SourceArtifactType;
  sourceArtifactRef?: string | null;
  waitingOn?: string | null;
}

export interface CommitmentLedgerStoryboardSnapshot {
  id: string;
  title: string;
  narration: string;
  report: CommitmentLedgerReport;
}

export const DEFAULT_COMMITMENT_THRESHOLDS: CommitmentThresholds = {
  failedRunMs: 15 * 60 * 1000, // 15 minutes
  // 10 minutes, against the wake → `run_queued` leg  — a measured gap of
  // 30 s healthy vs 10 h dropped, so the exact figure is not load-bearing. It was
  // load-bearing, and wrong, while this row keyed on `run_start`: that leg races
  // `quota.throttle.maxIntervalSeconds`, which a config edit can raise above
  // any constant written here. If this row is ever re-keyed onto a dispatch leg,
  // derive the bound from that config instead of editing this number.
  missedWakeMs: 10 * 60 * 1000,
  silentActorMs: 24 * 60 * 60 * 1000, // 24 hours
};

export const DEFAULT_COMMITMENT_MIN_CONFIDENCE = 0.7;

/**
 * How a run-terminal kind bears on progress.
 *
 * Three arms rather than a boolean, because one of the kinds genuinely cannot be
 * answered from the kind alone.
 */
export type TerminalProgressRule =
  /** The actor ran. Unconditional proof of life. */
  | "progress"
  /** Never the actor acting — only something happening *to* it. */
  | "not-progress"
  /** Answerable only from the event payload, via `abandonedRunHadStarted`. */
  | "progress-if-started";

/**
 * Every kind that closes a run opportunity, mapped to what it means for progress.
 *
 * This is a total `Record` over {@link RUN_TERMINAL_EVENT_KINDS} on purpose: a
 * terminal kind added there fails to compile here until somebody decides what it
 * means, which is the property this file kept losing. It lost it once before —
 * the reader took `run_end` and silently omitted `run_abandoned` (ISSUE_NUM, and
 * ISSUE_NUM before it) — and a set of kinds cannot express the omission as an error,
 * only as an absence nobody sees. A missing key is a type error; a wrong answer
 * is a decision somebody made.
 *
 * `run_abandoned` is the reason a boolean would not do. It covers both a run the
 * actor executed and had superseded (`coalesced`, `started: true`) and a run the
 * scheduler tore down before `onRunStart` ever fired (`start-cancelled`,
 * `started: false`). Only the first is the actor acting; the second is the same
 * class of fact as `run_queued`, which is why neither counts. Reading it as
 * unconditional progress would make an actor looping
 * `run_queued` → `run_abandoned(started: false)` register as alive while it does
 * nothing at all — a `silent_actor` miss, which is the failure this row exists to
 * catch, and the more dangerous direction to be wrong in than the false alarm.
 */
export const RUN_TERMINAL_PROGRESS_RULES: Readonly<
  Record<(typeof RUN_TERMINAL_EVENT_KINDS)[number], TerminalProgressRule>
> = {
  run_end: "progress",
  run_abandoned: "progress-if-started",
};

/**
 * The non-terminal events that count as an actor having done something.
 *
 * Run-terminal kinds are deliberately absent — they live in
 * {@link RUN_TERMINAL_PROGRESS_RULES} so each has exactly one home. `run_queued`
 * is absent from both: the scheduler accepting an actor is the scheduler acting,
 * not the actor progressing .
 */
const PROGRESS_KINDS: ReadonlySet<string> = new Set([
  "actor_spawned",
  "message_sent",
  "handle_granted",
  "actor_revived",
  "actor_charter_set",
  "actor_model_set",
  "run_start",
  "run_continued",
  "run_yielded",
  "capability_granted",
  "capability_revoked",
  "event_source_subscribed",
  "event_source_unsubscribed",
]);

/**
 * What the projection reads from an event of each kind: nothing at all, its
 * fields, or its fields *and* its `body`.
 *
 * This exists because the reader pays for every byte it does not read.
 * `projectOpenCommitments` is a fold over the whole history, and the dashboard
 * handed it one via `meshEvents.list()` — `SELECT e.*`, every kind, bodies
 * included. On the live mesh that was 74,015 rows carrying 185 MB of strings
 * and 579 MB of RSS per call, to answer questions that touch 46,086 rows and
 * 23 MB. `run_end` bodies alone are 138 MB of run transcripts, and nothing
 * here reads one.
 *
 * A total `Record` over `MeshEventKind` on purpose, the same reason
 * {@link RUN_TERMINAL_PROGRESS_RULES} is one: a new kind fails to compile until
 * somebody decides whether the ledger reads it. The dangerous direction is
 * `ignored` on a kind that matters — the projection would quietly stop seeing
 * it, and a set of kinds cannot express that omission as an error, only as an
 * absence nobody notices. `commitment-ledger.filter.test.ts` holds the claim to
 * account: every `ignored` kind must demonstrably change nothing, and every
 * non-`fields-and-body` kind's body must change nothing.
 */
type LedgerRead = "ignored" | "fields" | "fields-and-body";

const LEDGER_READS: Readonly<Record<MeshEventKind, LedgerRead>> = {
  // Progress, and the events the per-actor branches key off.
  actor_spawned: "fields",
  actor_revived: "fields",
  actor_charter_set: "fields",
  actor_model_set: "fields",
  handle_granted: "fields",
  capability_granted: "fields",
  capability_revoked: "fields",
  run_start: "fields",
  run_continued: "fields",
  run_end: "fields",
  run_abandoned: "fields",
  continuation_capped: "fields",
  actor_retired: "fields",
  scheduled_wake: "fields",
  event_source_subscribed: "fields",
  event_source_unsubscribed: "fields",

  // The two kinds whose prose is evidence: a yield note carries `waiting on`,
  // and a sent message carries the tracking/resolved lines.
  run_yielded: "fields-and-body",
  message_sent: "fields-and-body",

  // Read by nobody here. Each is either the scheduler acting rather than the
  // actor (`run_queued`, `run_coalesced`, `run_abandoned`'s queued half), a
  // finer-grained facet of a run this projection already sees whole
  // (`run_first_chunk`, `portable_context_compacted`), or an effect on some
  // system other than the mesh's own commitments.
  root_control_action: "ignored",
  message_received: "ignored",
  actor_reparented: "ignored",
  run_queued: "ignored",
  run_first_chunk: "ignored",
  run_preempted: "ignored",
  portable_context_compacted: "ignored",
  run_coalesced: "ignored",
  stamp_invalid: "ignored",
  host_job_submitted: "ignored",
  host_job_stopped: "ignored",
  host_job_exited: "ignored",
  email_sent: "ignored",
  calendar_read: "ignored",
  drive_read: "ignored",
  calendar_write: "ignored",
};

const ledgerKindsWhere = (...reads: LedgerRead[]): readonly MeshEventKind[] =>
  Object.entries(LEDGER_READS)
    .filter(([, read]) => reads.includes(read))
    .map(([kind]) => kind as MeshEventKind);

/**
 * The only kinds {@link projectOpenCommitments} reads. Feeding it any other
 * event changes nothing it returns, so a reader may filter them out in SQL and
 * never materialise them.
 */
export const COMMITMENT_LEDGER_KINDS: readonly MeshEventKind[] = ledgerKindsWhere(
  "fields",
  "fields-and-body"
);

/**
 * The only kinds whose `body` it reads. Subset of {@link COMMITMENT_LEDGER_KINDS}
 * by construction — both are derived from the one table, so they cannot drift
 * into a body that is fetched for a kind that was filtered out.
 */
export const COMMITMENT_LEDGER_BODY_KINDS: readonly MeshEventKind[] =
  ledgerKindsWhere("fields-and-body");

/**
 * Did this event show the actor doing something?
 *
 * `lastProgress` is the last event satisfying this; both `silent_actor` branches
 * key off it, and the branch for actors with none measures from
 * `thread.createdAt` and reports "no recorded progress event".
 */
export function isProgressEvent(event: Pick<MeshEvent, "kind" | "payload">): boolean {
  const terminalRule =
    RUN_TERMINAL_PROGRESS_RULES[event.kind as keyof typeof RUN_TERMINAL_PROGRESS_RULES];
  if (terminalRule) {
    switch (terminalRule) {
      case "progress":
        return true;
      case "not-progress":
        return false;
      case "progress-if-started":
        return abandonedRunHadStarted(event.payload);
    }
  }
  return PROGRESS_KINDS.has(event.kind);
}

export function projectOpenCommitments(opts: {
  threads: ActorRecord[];
  events: MeshEvent[];
  requestCommitments?: RequestCommitmentInput[];
  now?: Date;
  thresholds?: Partial<CommitmentThresholds>;
  minConfidence?: number;
  ownerActorId?: string;
  /**
   * This instance's configured root display handle (`resolveRootHandle(config)`,
   * ISSUE_NUM), so a commitment owner referenced by the configured handle (e.g.
   * `ember-familiar`) resolves to root. Omit to keep the default
   * `root-actor` resolution.
   */
  rootHandle?: string;
}): CommitmentLedgerReport {
  const now = opts.now ?? new Date();
  const minConfidence = opts.minConfidence ?? DEFAULT_COMMITMENT_MIN_CONFIDENCE;
  const thresholds = { ...DEFAULT_COMMITMENT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const threadsById = new Map(opts.threads.map((thread) => [thread.id, thread]));
  const ownerResolver = buildOwnerResolver(opts.threads, opts.rootHandle);
  const ownerFilter = opts.ownerActorId ? ownerResolver.resolve(opts.ownerActorId) : null;
  const ownerFilterId = ownerFilter?.id ?? opts.ownerActorId;
  const activeChildCountByParent = new Map<string, number>();
  for (const thread of opts.threads) {
    if (thread.parentId == null || thread.status !== "active") continue;
    activeChildCountByParent.set(
      thread.parentId,
      (activeChildCountByParent.get(thread.parentId) ?? 0) + 1
    );
  }

  const eventsByActor = new Map<string, MeshEvent[]>();
  for (const event of opts.events) {
    if (!event.actorId) continue;
    const actorEvents = eventsByActor.get(event.actorId) ?? [];
    actorEvents.push(event);
    eventsByActor.set(event.actorId, actorEvents);
  }
  for (const actorEvents of eventsByActor.values()) {
    actorEvents.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  const actorIds = new Set([...threadsById.keys(), ...eventsByActor.keys()]);
  const rows: CommitmentLedgerRow[] = [];
  const hasSpecificRow = new Set<string>();

  rows.push(
    ...projectRequestCommitmentRows({
      requests: [...extractRequestCommitments(opts.events), ...(opts.requestCommitments ?? [])],
      now,
      includeResolved: false,
      ownerResolver,
    })
  );

  for (const actorId of actorIds) {
    const thread = threadsById.get(actorId);
    const actorEvents = eventsByActor.get(actorId) ?? [];
    const lastYield = lastWhere(actorEvents, (event) => event.kind === "run_yielded");
    const lastYieldNote = lastYield?.body ?? null;
    const waitingOn = extractWaitingOn(lastYieldNote);
    const retirementExpectation = inferOwnerExpectsRetirement({
      actorId,
      thread,
      actorEvents,
      activeChildCount: activeChildCountByParent.get(actorId) ?? 0,
    });
    const lastRunYieldedBlocked =
      lastYield?.detail === "blocked" &&
      !hasLater(actorEvents, lastYield, (event) => event.kind === "run_start");

    const lastRunYieldedComplete =
      lastYield?.detail === "complete" &&
      !hasLater(actorEvents, lastYield, (event) => event.kind === "run_start");

    const eventSubscriptions = new Set<string>();
    for (const event of actorEvents) {
      if (event.kind === "event_source_subscribed" && event.detail) {
        eventSubscriptions.add(event.detail);
      } else if (event.kind === "event_source_unsubscribed" && event.detail) {
        eventSubscriptions.delete(event.detail);
      }
    }
    const isEventDriven = eventSubscriptions.size > 0;

    const lastBadRun = lastWhere(
      actorEvents,
      (event) =>
        (event.kind === "run_end" && event.success === false) ||
        event.kind === "continuation_capped"
    );
    if (
      thread?.status === "active" &&
      lastBadRun &&
      !hasLater(actorEvents, lastBadRun, (event) => event.kind === "run_start") &&
      ageMs(now, lastBadRun.ts) >= thresholds.failedRunMs
    ) {
      rows.push(
        makeRow({
          kind: "failed_run",
          actorId,
          thread,
          event: lastBadRun,
          now,
          waitingOn,
          ownerExpectsRetirement: retirementExpectation.value,
          confidence: 0.9,
          reason: "Actor had a failed or capped run with no later run start.",
          evidence: { retirement_expectation_reason: retirementExpectation.reason },
        })
      );
      hasSpecificRow.add(actorId);
    }

    // missed_wake alerts are no longer emitted .

    const lastProgress = lastWhere(actorEvents, isProgressEvent);
    if (
      thread?.status === "active" &&
      !hasSpecificRow.has(actorId) &&
      !lastRunYieldedBlocked &&
      !(lastRunYieldedComplete && isEventDriven) &&
      lastProgress &&
      ageMs(now, lastProgress.ts) >= thresholds.silentActorMs
    ) {
      rows.push(
        makeRow({
          kind: "silent_actor",
          actorId,
          thread,
          event: lastProgress,
          now,
          waitingOn,
          ownerExpectsRetirement: retirementExpectation.value,
          confidence: 0.75,
          reason: "Active actor has had no progress event past the silence threshold.",
          evidence: { retirement_expectation_reason: retirementExpectation.reason },
        })
      );
    }

    if (
      thread?.status === "active" &&
      !hasSpecificRow.has(actorId) &&
      !lastRunYieldedBlocked &&
      !(lastRunYieldedComplete && isEventDriven) &&
      !lastProgress &&
      ageMs(now, thread.createdAt) >= thresholds.silentActorMs
    ) {
      rows.push(
        makeRow({
          kind: "silent_actor",
          actorId,
          thread,
          event: null,
          now,
          waitingOn,
          ownerExpectsRetirement: retirementExpectation.value,
          confidence: 0.7,
          reason: "Active actor has no recorded progress event past the silence threshold.",
          evidence: { retirement_expectation_reason: retirementExpectation.reason },
        })
      );
    }
  }

  const filtered = rows
    .filter((row) => row.confidence >= minConfidence)
    .filter((row) => ownerFilterId == null || row.owner_actor_id === ownerFilterId);
  filtered.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.age_ms - a.age_ms ||
      (a.subject_actor_id ?? "").localeCompare(b.subject_actor_id ?? "")
  );
  return {
    generated_at: now.toISOString(),
    min_confidence: minConfidence,
    thresholds,
    rows: filtered,
  };
}

export function projectRequestCommitmentRows(opts: {
  requests: RequestCommitmentInput[];
  now?: Date;
  includeResolved?: boolean;
  ownerResolver?: OwnerResolver;
}): CommitmentLedgerRow[] {
  const now = opts.now ?? new Date();
  const ownerResolver = opts.ownerResolver ?? buildOwnerResolver([]);
  const rows: CommitmentLedgerRow[] = [];
  for (const request of opts.requests) {
    const owner = ownerResolver.resolve(request.ownerActorId);
    const resolvedAt = request.resolvedAt ?? null;
    if (resolvedAt && !opts.includeResolved) continue;
    const status: CommitmentStatus = resolvedAt ? "resolved" : "open";
    const firstSeenAt = request.requestedAt;
    rows.push({
      id: `request_commitment:${request.id}`,
      status,
      kind: "request_commitment",
      owner_actor_id: owner?.id ?? request.ownerActorId,
      subject_actor_id: request.subject,
      source_artifact_type: request.sourceArtifactType ?? "message",
      source_artifact_ref: request.sourceArtifactRef ?? request.id,
      waiting_on:
        request.waitingOn ?? `${owner?.handle ?? request.ownerActorId} -> ${request.doneWhen}`,
      owner_expects_retirement: null,
      confidence: 1,
      reason: [
        resolvedAt
          ? "Request commitment was driven to a recorded completion."
          : "Request commitment is registered and still needs its owner to drive it to done.",
        owner
          ? null
          : `Owner '${request.ownerActorId}' did not resolve to a known thread id or handle.`,
      ]
        .filter(Boolean)
        .join(" "),
      evidence_json: {
        requested_at: request.requestedAt,
        done_when: request.doneWhen,
        resolved_at: resolvedAt,
        owner_raw: request.ownerActorId,
        owner_resolution: owner ? "resolved" : "unresolved",
      },
      first_seen_at: firstSeenAt,
      last_seen_at: now.toISOString(),
      resolved_at: resolvedAt,
      age_ms: resolvedAt
        ? ageMs(new Date(resolvedAt), request.requestedAt)
        : ageMs(now, request.requestedAt),
    });
  }
  return rows;
}

function extractRequestCommitments(events: MeshEvent[]): RequestCommitmentInput[] {
  const bySubject = new Map<string, RequestCommitmentInput>();
  for (const event of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) {
    if (event.kind !== "message_sent" || !event.body) continue;
    for (const line of event.body.split(/\r?\n/)) {
      const tracking = parseTrackingLine(line);
      if (tracking) {
        bySubject.set(normalizeCommitmentSubject(tracking.subject), {
          id: event.id,
          ownerActorId: tracking.ownerActorId,
          subject: tracking.subject,
          requestedAt: event.ts,
          doneWhen: tracking.doneWhen,
          sourceArtifactType: "message",
          sourceArtifactRef: event.id,
        });
        continue;
      }

      const resolvedSubject = parseResolvedLine(line);
      if (!resolvedSubject) continue;
      const existing = bySubject.get(normalizeCommitmentSubject(resolvedSubject));
      if (existing && !existing.resolvedAt) {
        existing.resolvedAt = event.ts;
      }
    }
  }
  return [...bySubject.values()];
}

function parseTrackingLine(
  line: string
): { subject: string; ownerActorId: string; doneWhen: string } | null {
  const match = line.match(/^Tracking:\s*(.+)$/i);
  if (!match) return null;
  const parts = match[1].split("|").map((part) => part.trim());
  const subject = parts.shift()?.trim();
  if (!subject) return null;
  const values = new Map<string, string>();
  for (const part of parts) {
    const kv = part.match(/^([a-z-]+)\s*=\s*(.+)$/i);
    if (kv) values.set(kv[1].toLowerCase(), kv[2].trim());
  }
  const ownerActorId = values.get("owner");
  const doneWhen = values.get("done-when");
  if (!ownerActorId || !doneWhen) return null;
  return { subject, ownerActorId, doneWhen };
}

function parseResolvedLine(line: string): string | null {
  const match = line.match(/^(?:Done|Resolved):\s*(.+)$/i);
  return match?.[1].trim() || null;
}

function normalizeCommitmentSubject(subject: string): string {
  return subject.trim().toLowerCase().replace(/\s+/g, " ");
}

interface OwnerResolution {
  id: string;
  handle: string;
}

interface OwnerResolver {
  resolve(owner: string): OwnerResolution | null;
}

function buildOwnerResolver(threads: ActorRecord[], rootHandle?: string): OwnerResolver {
  const byIdOrHandle = new Map<string, OwnerResolution>();
  const defaultRootHandle = generateHandle("root");
  // The resolved (possibly configured, ISSUE_NUM) handle is what displays for root
  // everywhere a row renders `owner.handle` (e.g. `waiting_on`), so a
  // configured instance doesn't leak the default root-actor identity.
  const rootRecord =
    threads.find((thread) => thread.isRoot === true) ??
    threads.find((thread) => thread.id === "root");
  const root = { id: rootRecord?.id ?? "root", handle: rootHandle ?? defaultRootHandle };
  byIdOrHandle.set(root.id, root);
  byIdOrHandle.set("root", root);
  byIdOrHandle.set(defaultRootHandle, root);
  // The configured display handle resolves to root too, in addition to the
  // `"root"`/default-handle mappings above.
  if (rootHandle && rootHandle !== defaultRootHandle) byIdOrHandle.set(rootHandle, root);
  for (const thread of threads) {
    const resolution = { id: thread.id, handle: generateHandle(thread.id) };
    byIdOrHandle.set(thread.id, resolution);
    byIdOrHandle.set(resolution.handle, resolution);
  }
  return {
    resolve(owner: string): OwnerResolution | null {
      return byIdOrHandle.get(owner) ?? null;
    },
  };
}

function inferOwnerExpectsRetirement(opts: {
  actorId: string;
  thread: ActorRecord | undefined;
  actorEvents: MeshEvent[];
  activeChildCount: number;
}): { value: boolean | null; reason: string } {
  if (!opts.thread) return { value: null, reason: "missing_thread_record" };
  if (opts.thread.parentId == null) return { value: false, reason: "top_level_actor" };
  if (opts.actorEvents.some((event) => event.kind === "scheduled_wake")) {
    return { value: false, reason: "has_scheduled_wake_history" };
  }
  if (opts.activeChildCount > 0) return { value: false, reason: "has_live_children" };
  return { value: null, reason: "ambiguous_childless_leaf" };
}

function makeRow(opts: {
  kind: CommitmentKind;
  actorId: string;
  thread: ActorRecord | undefined;
  event: MeshEvent | null;
  now: Date;
  waitingOn: string | null;
  ownerExpectsRetirement: boolean | null;
  confidence: number;
  reason: string;
  evidence: Record<string, unknown>;
}): CommitmentLedgerRow {
  const since = opts.event?.ts ?? opts.thread?.createdAt ?? opts.now.toISOString();
  const ownerActorId = opts.thread?.parentId ?? null;
  return {
    id: `${opts.kind}:${opts.actorId}:${opts.event?.id ?? since}`,
    status: "open",
    kind: opts.kind,
    owner_actor_id: ownerActorId,
    subject_actor_id: opts.actorId,
    source_artifact_type: "mesh_event",
    source_artifact_ref: opts.event?.id ?? null,
    waiting_on: opts.waitingOn,
    owner_expects_retirement: opts.ownerExpectsRetirement,
    confidence: opts.confidence,
    reason: opts.reason,
    evidence_json: {
      event_kind: opts.event?.kind ?? null,
      event_ts: opts.event?.ts ?? null,
      event_detail: opts.event?.detail ?? null,
      event_success: opts.event?.success ?? null,
      ...opts.evidence,
    },
    first_seen_at: since,
    last_seen_at: opts.now.toISOString(),
    resolved_at: null,
    age_ms: ageMs(opts.now, since),
  };
}

function lastWhere<T>(items: readonly T[], pred: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (pred(items[i])) return items[i];
  }
  return undefined;
}

function hasLater(
  events: readonly MeshEvent[],
  pivot: MeshEvent,
  pred: (event: MeshEvent) => boolean
): boolean {
  const pivotIndex = events.indexOf(pivot);
  if (pivotIndex === -1) {
    return events.some((event) => event.ts > pivot.ts && pred(event));
  }
  return events.some((event, index) => index > pivotIndex && event.ts >= pivot.ts && pred(event));
}

function ageMs(now: Date, iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, now.getTime() - t);
}

function extractWaitingOn(note: string | null): string | null {
  if (!note) return null;
  const line = note.split(/\r?\n/).find((candidate) => /^Waiting-on:\s*/i.test(candidate.trim()));
  if (!line) return null;
  return line.replace(/^Waiting-on:\s*/i, "").trim() || null;
}

function renderCommitmentLedgerRowsHtml(
  report: CommitmentLedgerReport,
  opts: { previousRowIds?: Set<string> } = {}
): string {
  if (report.rows.length === 0) {
    return `        <tr class="empty-row">
          <td colspan="10">No open commitment rows.</td>
        </tr>`;
  }
  return report.rows
    .map(
      (row) => `        <tr${opts.previousRowIds?.has(row.id) === false ? ' class="new-row"' : ""}>
          <td>${escapeHtml(row.status)}</td>
          <td>${escapeHtml(row.kind)}</td>
          <td>${escapeHtml(row.owner_actor_id ? generateHandle(row.owner_actor_id) : "")}</td>
          <td>${escapeHtml(row.subject_actor_id ?? "")}</td>
          <td>${escapeHtml(row.source_artifact_type)}:${escapeHtml(row.source_artifact_ref ?? "")}</td>
          <td>${escapeHtml(row.waiting_on ?? "")}</td>
          <td>${row.confidence.toFixed(2)}</td>
          <td>${formatNullableBoolean(row.owner_expects_retirement)}</td>
          <td>${escapeHtml(row.reason)}</td>
          <td>${formatAge(row.age_ms)}</td>
        </tr>`
    )
    .join("\n");
}

function renderCommitmentLedgerTableHtml(
  report: CommitmentLedgerReport,
  opts: { previousRowIds?: Set<string> } = {}
): string {
  const rows = renderCommitmentLedgerRowsHtml(report, opts);

  return `      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Kind</th>
            <th>Owner</th>
            <th>Subject</th>
            <th>Source</th>
            <th>Waiting on</th>
            <th>Confidence</th>
            <th>Owner expects retirement</th>
            <th>Reason</th>
            <th>Age</th>
          </tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>`;
}

export function renderCommitmentLedgerHtml(report: CommitmentLedgerReport): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Commitment Ledger Sample Report</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f7f8fa;
        color: #1f2937;
      }
      body {
        margin: 0;
        padding: 32px;
      }
      main {
        max-width: 1180px;
        margin: 0 auto;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 28px;
        font-weight: 700;
      }
      .meta {
        margin: 0 0 24px;
        color: #4b5563;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        background: #ffffff;
        border: 1px solid #d1d5db;
      }
      th,
      td {
        padding: 10px 12px;
        border-bottom: 1px solid #e5e7eb;
        text-align: left;
        vertical-align: top;
      }
      th {
        background: #eef2f7;
        color: #111827;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      tbody tr:last-child td {
        border-bottom: 0;
      }
      .new-row td {
        background: #fff7d6;
      }
      .empty-row td {
        color: #4b5563;
        font-style: italic;
        text-align: center;
      }
      td:nth-child(5),
      td:nth-child(8) {
        white-space: nowrap;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Commitment Ledger Spike Report</h1>
      <p class="meta">Generated ${escapeHtml(report.generated_at)} with minimum confidence ${report.min_confidence.toFixed(2)}.</p>
${renderCommitmentLedgerTableHtml(report)}
    </main>
  </body>
</html>
`;
}

export function renderCommitmentLedgerStoryboardHtml(opts: {
  title: string;
  generatedAt: string;
  intro: string;
  snapshots: CommitmentLedgerStoryboardSnapshot[];
  knownGaps?: string[];
}): string {
  let previousRowIds = new Set<string>();
  const snapshots = opts.snapshots
    .map((snapshot) => {
      const table = renderCommitmentLedgerTableHtml(snapshot.report, { previousRowIds });
      previousRowIds = new Set(snapshot.report.rows.map((row) => row.id));
      return `      <section id="${escapeHtml(snapshot.id)}">
        <h2>${escapeHtml(snapshot.title)} - ${escapeHtml(snapshot.report.generated_at)}</h2>
        <p>${escapeHtml(snapshot.narration)}</p>
${table}
      </section>`;
    })
    .join("\n");
  const knownGaps =
    opts.knownGaps && opts.knownGaps.length > 0
      ? `      <section id="known-gaps">
        <h2>Known Gaps</h2>
        <ul>
${opts.knownGaps.map((gap) => `          <li>${escapeHtml(gap)}</li>`).join("\n")}
        </ul>
      </section>`
      : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(opts.title)}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f7f8fa;
        color: #1f2937;
      }
      body {
        margin: 0;
        padding: 32px;
      }
      main {
        max-width: 1180px;
        margin: 0 auto;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 28px;
        font-weight: 700;
      }
      h2 {
        margin: 32px 0 8px;
        font-size: 20px;
      }
      p,
      li {
        line-height: 1.5;
      }
      .meta {
        margin: 0 0 24px;
        color: #4b5563;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        background: #ffffff;
        border: 1px solid #d1d5db;
      }
      th,
      td {
        padding: 10px 12px;
        border-bottom: 1px solid #e5e7eb;
        text-align: left;
        vertical-align: top;
      }
      th {
        background: #eef2f7;
        color: #111827;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      tbody tr:last-child td {
        border-bottom: 0;
      }
      .new-row td {
        background: #fff7d6;
      }
      .empty-row td {
        color: #4b5563;
        font-style: italic;
        text-align: center;
      }
      td:nth-child(5),
      td:nth-child(8) {
        white-space: nowrap;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(opts.title)}</h1>
      <p class="meta">Generated ${escapeHtml(opts.generatedAt)}.</p>
      <p>${escapeHtml(opts.intro)}</p>
${snapshots}
${knownGaps}
    </main>
  </body>
</html>
`;
}

function formatNullableBoolean(value: boolean | null): string {
  if (value == null) return "";
  return value ? "yes" : "no";
}

function formatAge(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
