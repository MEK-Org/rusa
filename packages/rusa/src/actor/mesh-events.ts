/**
 * The mesh's observability seam. The mesh and its actors call a {@link MeshEventSink}
 * at each interesting moment; the wiring binds it to durable storage (the
 * `mesh_events` table) so a run can be replayed as a timeline after the fact.
 *
 * Kept as a bare function type with no storage dependency — mirroring the
 * failure-sink — so the actor layer never imports the db. The kinds and field
 * shapes intentionally match the {@link MeshEventRepository} so the wiring is a
 * one-line adapter.
 */

// Across every kind the convention is kind-specific. Say which field is which on
// every new kind; the notes here were backfilled after the names misled two
// readers into opposite conclusions about who sent what .
export type MeshEventKind =
  // A parent created a new actor. `actorId` = the SPAWNED thread, `payload` = { parentId }.
  // `detail` = the charter, `body` = a provider/model summary.
  | "actor_spawned"
  // A trusted external principal or the root LLM invoked the shared root
  // control surface. `actorId` remains root; payload records the initiator.
  | "root_control_action"
  // The actor sent a message. `actorId` = the sender, `payload` = { messageId, to }.
  | "message_sent"
  // The actor received a message (claimed or durably enqueued). `actorId` = the recipient, `payload` = { messageId, from }.
  | "message_received"
  // An actor's address book gained an entry (see `ActorMesh.grantHandle`).
  // `actorId` = the GRANTEE that now holds the handle, `payload` = { handleId }.
  // `detail` = the handle's role.
  | "handle_granted"
  // `actorId` = the retired thread, `payload` = { parentId }.
  | "actor_retired"
  // `actorId` = the revived thread, `payload` = { parentId }.
  | "actor_revived"
  // The root moved an actor to a new parent (re-org). `actorId` = the moved
  // actor, `payload` = { parentId }.
  | "actor_reparented"
  // The root durably re-scoped an actor by replacing its charter via
  // set_thread_charter (e.g. promoting an elder to a steward). `actorId` = the
  // re-chartered actor, `detail` = a charter excerpt.
  | "actor_charter_set"
  // The parent or root updated an actor's model in-place via set_thread_model .
  // `actorId` = the updated actor, `peerId` = the requester (parent or root),
  // `detail` = oldModel -> newModel summary.
  | "actor_model_set"
  // Run lifecycle brackets an execution opportunity. `run_queued` fires once
  // when the pre-run gate first accepts the actor into scheduling; deliveries
  // coalesced into that queued opportunity do not emit duplicates. It remains
  // content-free so observability does not become a second worklist.
  | "run_queued"
  // For a provider-agnostic (mesh-owned) context actor (design ISSUE_NUM), `run_start`
  // also carries the injection facet: the mesh
  // assembled the actor's own recent run outputs into a fresh, stateless prompt,
  // and the inject record rides on this event — `detail` appends a byte/run/hash
  // summary, `body` is the JSON inject record (byte count = the A/B primary
  // metric, content hash, source run_end event ids). It's a facet of the run, not
  // its own kind, so the A/B metric extraction reads injected-bytes-per-run off
  // `run_start`. `body` is absent on runs with no injection (native actors, an
  // owned actor's first run).
  // `run_start` fires on the inside of the gate, at the moment the
  // provider invoke actually begins, and is what the watchdog timers key off
  // . The pair separates a run that never started from one that started
  // and went quiet: never started = it was still queued behind the concurrency
  // cap; started = the provider invoke was live, so any silence after this
  // point is the provider's, not the mesh's.
  //
  // Starting alone does NOT say why a run went quiet, and the record shows why
  // that matters: every observed watchdog kill is a started run that
  // emitted zero bytes before it died, which is a provider that hadn't answered
  // yet — not a stall. Naming it one would file a distinct outcome under the
  // nearest label that already exists. Discriminating "never answered" from a
  // genuine mid-run stall needs a first-chunk timestamp, which `run_first_chunk`
  // carries.
  | "run_start"
  // The provider emitted its first byte — the moment it started ANSWERING, as
  // opposed to the moment it was queued (`run_queued`) or the moment the provider
  // invocation began (`run_start`). Fires once per run, on first chunk only.
  //
  // This is the timestamp that turns a classification into a reading. Start
  // event absent = queued waiting to start; started with no first chunk =
  // the provider never answered; first chunk then silence = a genuine mid-run
  // stall. Only the third is a stall. Every watchdog kill on record so far is the
  // second, which had no name until this event existed.
  //
  // A run killed before the provider answers never emits this, and that ABSENCE is
  // the datum — nothing may synthesize one on the kill path, or the distinction
  // collapses back into inference.
  | "run_first_chunk"
  // A run produced a result. `payload` = {@link RunEndPayload}.
  | "run_end"
  // The other way a queued run opportunity ends: it was abandoned before it
  // produced a result, so there is nothing to report. `actorId` = the actor,
  // `detail` = why (a coalesce-abort, a cancelled queued start, or an
  // unclassified terminal path), `payload` = {@link RunAbandonedPayload}. No
  // `success`, no `body` — an abandoned run has no outcome and no transcript,
  // and synthesizing either would file it under `run_end` semantics it does not
  // have.
  //
  // This exists because `run_end`'s absence used to be the ONLY record of these
  // paths, which made them invisible in the timeline and — worse — left the
  // mesh's in-flight accounting permanently short one decrement .
  | "run_abandoned"
  // A portable-context v2 ledger folded one or more inbound messages. `actorId`
  // is the remembered actor; detail/body carry generation/count metadata only.
  | "portable_context_compacted"
  | "run_coalesced"
  // Yield lifecycle: the actor received the one corrective yield-elicitation run
  // (`run_continued`), declared it was done/blocked (`run_yielded`), or exhausted
  // that corrective budget (`continuation_capped`).
  | "run_continued"
  | "run_yielded"
  | "continuation_capped"
  // Capability lifecycle (design ISSUE_NUM, phase 1a): the root granted/revoked an
  // extra MCP capability to an actor. `actorId` = the grantee actor, `payload` = { grantedBy },
  // `detail` = the capability name.
  | "capability_granted"
  | "capability_revoked"
  // Mechanical nightly trigger (ISSUE_NUM, phase 1c): a cron job hit the wake endpoint
  // and the mesh delivered a scheduled wake to an actor. `actorId` = the woken
  // actor, `payload` = { from, messageId }. A wake whose
  // target wasn't live carries the dropped-message marker in `detail`.
  | "scheduled_wake"
  // Event source subscriptions (design ISSUE_NUM, phase 2)
  | "event_source_subscribed"
  | "event_source_unsubscribed"
  | "stamp_invalid"
  // Host-plane `host-jobs` capability : a grantable systemd-run --user
  // runner for long host-side experiments. `actorId` = the submitting/owning
  // actor, `detail` = a short summary. The submit event carries only the unit
  // name plus audit artifact pointer + sha256; never the script label/body,
  // args, manifest contents, or job stdout/stderr.
  | "host_job_submitted"
  | "host_job_stopped"
  | "host_job_exited"
  // A granted email-send tool successfully sent via Gmail. `actorId` is the
  // sender; `detail` is the To recipient; payload contains To and Cc only.
  | "email_sent"
  | "calendar_read"
  | "drive_read"
  // A granted calendar-write tool successfully wrote to Google Calendar.
  // `actorId` is the writer; detail is the operation; payload identifies only
  // the calendar ID and issue number.
  | "calendar_write";

/**
 * The kinds that close a queued run opportunity. `run_queued` opens one; exactly
 * one of these ends it.
 *
 * Named once, here, so the producer (the actor's terminal hook) and every reader
 * that tracks in-flight runs cannot drift apart. They did drift: the mesh's
 * in-flight counter decremented on `run_end` alone, while two terminal paths
 * emitted none, so an actor that hit either read "has a run in flight" forever
 * and its deferred retire cleanup was deferred forever . Adding a
 * terminal path without adding it to this list reintroduces exactly that.
 */
export const RUN_TERMINAL_EVENT_KINDS = [
  "run_end",
  "run_abandoned",
] as const satisfies readonly MeshEventKind[];

/**
 * JSON `payload` of a `run_end` event.
 *
 * `model` is the run-scoped answer to "what did this actor actually run on?" —
 * the provider's own report (`RunResult.model`), recorded against the ONE run it
 * describes. It lives here rather than on the thread record because the thread is
 * the wrong scope for it: a per-actor copy is written on every run and cleared on
 * none, so an actor moved from a reporting provider to a non-reporting one keeps
 * answering with the model it LEFT, indefinitely and with no way to tell. That
 * stale copy is what this arc removed; recording the value against its run is what
 * replaces it.
 *
 * Absent means the provider did not report one. It is never the configured model,
 * and a reader must not substitute one — see `harness/model-identity.ts`.
 */
export interface RunEndPayload {
  /** True when the supervisor grace-killed the run after the yield grace period. */
  graceKilled?: boolean;
  /** The declared yield status ('complete' | 'blocked') if the run yielded. */
  yieldStatus?: string;
  /** What the provider reported this run ran on. Absent = not reported. */
  model?: string;
}

/**
 * Build a `run_end` payload from a finished run.
 *
 * Lives beside {@link RunEndPayload} and {@link runEndModel} on purpose: writer, reader
 * and shape in one place, so a key added to one cannot go missing from the others. The
 * two call sites (root and worker) previously each carried their own hand-copied JSON
 * literal, which is two chances to forget.
 *
 * `undefined` when there is nothing to say, so an ordinary run still records no payload
 * rather than an object of nulls.
 */
export function runEndPayload(result: RunEndPayload): string | undefined {
  if (!result.graceKilled && !result.yieldStatus && !result.model) return undefined;
  return JSON.stringify({
    graceKilled: result.graceKilled,
    yieldStatus: result.yieldStatus,
    model: result.model,
  } satisfies RunEndPayload);
}

/**
 * What the provider reported this run ran on, or null if it reported nothing.
 *
 * Null is a THIRD state, not a default: absent payload, unparseable payload, and a
 * payload whose provider stayed silent are all "not reported", and a caller that
 * collapses them into the configured model reintroduces the bug
 * `harness/model-identity.ts` was written for.
 */
export function runEndModel(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    const model = (JSON.parse(payload) as Partial<RunEndPayload>).model;
    return typeof model === "string" && model.length > 0 ? model : null;
  } catch {
    return null;
  }
}

/** JSON `payload` of a `run_abandoned` event. */
export interface RunAbandonedPayload {
  /** Whether a `run_start` was emitted for this run before it was abandoned. */
  started: boolean;
}

/**
 * Did this abandoned run ever emit `run_start`?
 *
 * There are two nested brackets and they close differently. `run_queued` … one of
 * {@link RUN_TERMINAL_EVENT_KINDS} is TOTAL — every opportunity closes. But
 * `run_start` fires later, inside the concurrency gate, so a run cancelled while
 * still queued never emits one; only an abandonment that got as far as starting
 * closes a `run_start`. A reader tracking started-but-unfinished runs that counts
 * every abandonment will cancel out an unrelated live run and report an actor
 * idle mid-run.
 *
 * Reading it through this function rather than off `detail` is deliberate: the
 * reason cannot answer this. `unreported` is by construction a path nobody has
 * classified, so a reader matching on reasons has no safe branch for it.
 *
 * Unparseable or absent payload ⇒ `false`, i.e. "this did not close a start".
 * That direction is the cheap one to be wrong in: a spurious `false` leaves a
 * waiter believing a run is still in flight, which surfaces as a visible timeout,
 * while a spurious `true` retires a bracket that is still open and reports idle
 * over a running actor — silently wrong data instead of a loud stop.
 */
export function abandonedRunHadStarted(payload: string | null | undefined): boolean {
  if (!payload) return false;
  try {
    return (JSON.parse(payload) as Partial<RunAbandonedPayload>).started === true;
  } catch {
    return false;
  }
}

/** One observed moment in the mesh. See `MeshEventRepository` for field meanings. */
export interface MeshEventInput {
  id?: string;
  kind: MeshEventKind;
  /** Subject actor: the runner, the message recipient, the spawned/retired thread. */
  actorId?: string;
  /** Short human-readable summary (a reason, a charter excerpt, a role). */
  detail?: string;
  /** Heavy payload: a run's output (message body moved to mesh_chat). */
  body?: string;
  /** JSON payload (e.g. {messageId, to} for message_sent). */
  payload?: string;
  /** Run outcome for `run_end`. */
  success?: boolean;
}

export type MeshEventSink = (event: MeshEventInput) => void;

/** Default no-op sink — observability is opt-in; the mesh works without it. */
export const NOOP_MESH_EVENT_SINK: MeshEventSink = () => {};

/**
 * `detail` set on a `message_sent` event whose recipient had no live actor, so
 * the message was recorded but never delivered. Such messages are never
 * acknowledged; readers (e.g. the dashboard inbox) use this marker to exclude
 * them from the "pending" list rather than implying a live actor is ignoring
 * them. The db repository imports this so producer and reader can't drift.
 */
export const DROPPED_MESSAGE_DETAIL = "dropped — no live actor";

/**
 * Body prefixes marking mechanical run-lifecycle notes that must never live in
 * `mesh_chat`. As of ISSUE_NUM these deliver as ISSUE_NUM inbox entries rather than chat
 * rows; the 0006 legacy backfill excludes them, and the 0007 cleanup removes
 * intermediate-vintage rows that leaked into `mesh_chat` before ISSUE_NUM shipped.
 * Producer, backfill, and cleanup import this single list so their notion of
 * "mechanical note" cannot drift apart.
 */
export const CHAT_EXCLUDED_BODY_PREFIXES = [
  "[yield/",
  "[run failed]",
  "[message redelivery capped]",
  "[capped]",
  "[scheduled message dropped]",
] as const;
