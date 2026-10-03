/**
 * The versioned JSON document stored with each Room entry episode (#829).
 *
 * SQLite stores it opaquely; this module is its only reader and writer, so the
 * shape, version and bounds are enforced here. A whole candidate document is
 * validated before it is committed, so a write either fits every bound or
 * changes nothing.
 */

export const ROOM_ENTRY_DOCUMENT_VERSION = 1;

/**
 * Reconnect lease: a tab stays present for this long after its last accepted
 * authenticated renewal, measured by server time.
 */
export const ROOM_ENTRY_LEASE_MS = 120_000;

/** How often a present tab is expected to renew; the client's cadence. */
export const ROOM_ENTRY_RENEW_INTERVAL_MS = 30_000;

/** Consumer-enforced bounds on one episode document. */
export const ROOM_ENTRY_LIMITS = {
  /** Current client leases per principal episode. */
  maxLeases: 16,
  /** UTF-8 bytes in a document-scoped client id. */
  maxClientIdBytes: 128,
  /** Actors in one recipient snapshot. */
  maxRecipients: 1_024,
  /** Serialized document size. */
  maxDocumentBytes: 512 * 1024,
} as const;

/** One tab's lease on the episode. */
export interface RoomEntryLease {
  /** Document-scoped id the browser keeps across reconnects and rebuilds. */
  clientId: string;
  /** Server-issued attachment generation; a reattach replaces it. */
  generation: string;
  /**
   * Digest of the session cookie last used to renew this lease, so signing
   * that session out can invalidate the leases it holds.
   */
  sessionKey: string;
  /** Server time (ms) of the last accepted authenticated renewal. */
  renewedAt: number;
}

/**
 * Notice delivery state for one snapshot recipient.
 * - `pending`: delivery intent committed, notice not yet confirmed appended.
 * - `delivered`: the deterministic notice row is confirmed durable.
 * - `skipped`: the recipient was retired or gone before its notice could be appended.
 * - `invalidated`: the recipient left the Room during the episode; its invitation is void.
 */
export type RoomEntryRecipientStatus = "pending" | "delivered" | "skipped" | "invalidated";

export interface RoomEntryRecipient {
  actorId: string;
  status: RoomEntryRecipientStatus;
}

export interface RoomEntryDocument {
  version: typeof ROOM_ENTRY_DOCUMENT_VERSION;
  leases: RoomEntryLease[];
  recipients: RoomEntryRecipient[];
}

/** A request that would push an episode past one of its bounds. */
export class RoomEntryLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomEntryLimitError";
  }
}

const RECIPIENT_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "delivered",
  "skipped",
  "invalidated",
]);

/** Whether a client id is acceptable: non-empty and within the byte bound. */
export function isValidRoomClientId(clientId: unknown): clientId is string {
  return (
    typeof clientId === "string" &&
    clientId.length > 0 &&
    !clientId.includes("\u0000") &&
    Buffer.byteLength(clientId, "utf8") <= ROOM_ENTRY_LIMITS.maxClientIdBytes
  );
}

/** Decode a stored document, throwing when it is not a valid version-1 document. */
export function parseRoomEntryDocument(json: string): RoomEntryDocument {
  if (Buffer.byteLength(json, "utf8") > ROOM_ENTRY_LIMITS.maxDocumentBytes) {
    throw new RoomEntryLimitError("room entry episode document exceeds its size bound");
  }
  const value: unknown = JSON.parse(json);
  // Stored rows obey the same consumer bounds as newly written candidates.
  validateRoomEntryDocument(value);
  return value;
}

/**
 * Serialize a candidate document after checking every bound. Throws
 * {@link RoomEntryLimitError} for a bound and a plain error for a malformed
 * shape, which is a programming error rather than a request problem.
 */
export function serializeRoomEntryDocument(document: RoomEntryDocument): string {
  validateRoomEntryDocument(document);
  const json = JSON.stringify(document);
  if (Buffer.byteLength(json, "utf8") > ROOM_ENTRY_LIMITS.maxDocumentBytes) {
    throw new RoomEntryLimitError("room entry episode document exceeds its size bound");
  }
  return json;
}

/** Shared structural/count checks; reads already checked their raw byte bound. */
function validateRoomEntryDocument(value: unknown): asserts value is RoomEntryDocument {
  const problem = documentProblem(value);
  if (problem) throw new Error(`invalid room entry document: ${problem}`);
  const document = value as RoomEntryDocument;
  if (document.leases.length > ROOM_ENTRY_LIMITS.maxLeases) {
    throw new RoomEntryLimitError(
      `room entry episode already holds ${ROOM_ENTRY_LIMITS.maxLeases} client leases`
    );
  }
  if (document.recipients.length > ROOM_ENTRY_LIMITS.maxRecipients) {
    throw new RoomEntryLimitError(
      `room roster exceeds ${ROOM_ENTRY_LIMITS.maxRecipients} entry notice recipients`
    );
  }
}

function documentProblem(value: unknown): string | null {
  if (!isRecord(value)) return "not an object";
  if (value.version !== ROOM_ENTRY_DOCUMENT_VERSION) {
    return `unsupported version ${JSON.stringify(value.version)}`;
  }
  if (!Array.isArray(value.leases)) return "leases must be an array";
  for (const lease of value.leases) {
    if (
      !isRecord(lease) ||
      !isValidRoomClientId(lease.clientId) ||
      !isNonEmptyString(lease.generation) ||
      !isNonEmptyString(lease.sessionKey) ||
      typeof lease.renewedAt !== "number" ||
      !Number.isFinite(lease.renewedAt)
    ) {
      return "malformed lease";
    }
  }
  if (new Set(value.leases.map((lease) => lease.clientId)).size !== value.leases.length) {
    return "duplicate client lease";
  }
  if (!Array.isArray(value.recipients)) return "recipients must be an array";
  for (const recipient of value.recipients) {
    if (
      !isRecord(recipient) ||
      !isNonEmptyString(recipient.actorId) ||
      typeof recipient.status !== "string" ||
      !RECIPIENT_STATUSES.has(recipient.status)
    ) {
      return "malformed recipient";
    }
  }
  if (
    new Set(value.recipients.map((recipient) => recipient.actorId)).size !== value.recipients.length
  ) {
    return "duplicate recipient";
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> & { [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
