import type { InboxPayload } from "./inbox-repository.js";

/**
 * Whether a durable inbox row may replace the run in flight when it arrives.
 *
 * Priority and interruption are separate questions (#829). A row's
 * `priority` decides inbox selection, the voice-hold bypass and next-run
 * admission; this policy decides only whether the row may abort the run that
 * is already executing. `join` rows are admitted at their priority and seen by
 * the next run, but never displace the current one.
 *
 * The policy is persisted on the row rather than carried by whichever call
 * first wakes the recipient, so the initial after-commit wake, an ordinary
 * dispatch triggered by unrelated traffic, boot/resume reconciliation and a
 * dropped remote admission all reach the same answer from the same row.
 */
export type InboxInterruptionPolicy = "interrupt" | "join";

/** The one interruption value a producer may write today. */
export const INBOX_INTERRUPTION_JOIN = "join";

/** A human entering the Room invites its participants to speak up (#829). */
export const ROOM_HUMAN_ENTRY_PAYLOAD_TYPE = "room.human_entry";
export const ROOM_HUMAN_ENTRY_VERSION = 1;

export interface InboxInterruptionDecision {
  policy: InboxInterruptionPolicy;
  /**
   * Set when the stored row did not have the shape its writer must have used.
   * The row is still scheduled — conservatively, as `join` — and the caller
   * is expected to make the anomaly visible rather than silently guessing.
   */
  diagnostic?: string;
}

/**
 * The single decoder for a stored row's interruption policy.
 *
 * - An explicit `interruption: "join"` never interrupts.
 * - A Room entry notice always joins, whatever its stored shape: a malformed
 *   or newer-version notice is reported and treated conservatively rather
 *   than promoted into an interrupting human message.
 * - An unknown stored `interruption` value also joins, with a diagnostic;
 *   only an absent value keeps the legacy behavior.
 * - Absent policy keeps legacy behavior: responsive rows interrupt. Event
 *   copies persisted with `deliveryRole: "subscriber"` keep the join they get
 *   from the after-commit seam and are deliberately not reinterpreted here.
 */
export function decodeInboxInterruption(payload: InboxPayload): InboxInterruptionDecision {
  if (payload.type === ROOM_HUMAN_ENTRY_PAYLOAD_TYPE) {
    const problem = roomHumanEntryProblem(payload);
    return problem
      ? { policy: "join", diagnostic: `malformed ${ROOM_HUMAN_ENTRY_PAYLOAD_TYPE}: ${problem}` }
      : { policy: "join" };
  }
  const interruption = payload.interruption;
  if (interruption === undefined) return { policy: "interrupt" };
  if (interruption === INBOX_INTERRUPTION_JOIN) return { policy: "join" };
  return {
    policy: "join",
    diagnostic: `unsupported inbox interruption ${JSON.stringify(interruption)}`,
  };
}

/**
 * Write-side contract for the interruption field and the Room entry notice.
 * Stored rows are decoded leniently by {@link decodeInboxInterruption}; a new
 * write with an unsupported shape is refused before it can become durable.
 */
export function validateInboxInterruptionForWrite(payload: InboxPayload): void {
  const interruption = payload.interruption;
  if (interruption !== undefined && interruption !== INBOX_INTERRUPTION_JOIN) {
    throw new Error(`inbox payload.interruption must be "${INBOX_INTERRUPTION_JOIN}" when present`);
  }
  if (payload.type === ROOM_HUMAN_ENTRY_PAYLOAD_TYPE) {
    const problem = roomHumanEntryProblem(payload);
    if (problem) throw new Error(`invalid ${ROOM_HUMAN_ENTRY_PAYLOAD_TYPE} payload: ${problem}`);
  }
}

/** Why a payload is not a well-formed version-1 Room entry notice, or null. */
function roomHumanEntryProblem(payload: InboxPayload): string | null {
  if (payload.version !== ROOM_HUMAN_ENTRY_VERSION) {
    return `unsupported version ${JSON.stringify(payload.version)}`;
  }
  if (payload.priority !== "responsive") return 'priority must be "responsive"';
  if (payload.interruption !== INBOX_INTERRUPTION_JOIN) {
    return `interruption must be "${INBOX_INTERRUPTION_JOIN}"`;
  }
  if (!isNonEmptyString(payload.episodeId)) return "episodeId must be a non-empty string";
  if (!isNonEmptyString(payload.principalId)) return "principalId must be a non-empty string";
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
