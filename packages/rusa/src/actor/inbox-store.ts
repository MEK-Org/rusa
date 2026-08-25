export interface InboxPayload {
  type: string;
  /** Durable scheduling priority; absent means normal/background work. */
  priority?: "responsive";
  [key: string]: unknown;
}

export interface InboxEntry {
  id: string;
  actorId: string;
  source: string;
  deliveredAt: Date;
  /** First time this entry contributed to a run that passed its pre-run gate. */
  seenAt: Date | null;
  handledAt: Date | null;
  /**
   * Explanation of how this inbox item was handled or why no action was needed.
   * The mark_handled MCP tool requires a non-empty note, so entries handled
   * through it always carry one. May still be null for entries not yet handled,
   * for historical rows, or for internal callers of the optional markHandled API.
   */
  handledNote: string | null;
  payload: InboxPayload;
}

export type InboxStatus = "unhandled" | "handled" | "all";

export interface InboxListOptions {
  status?: InboxStatus;
  source?: string;
  limit?: number;
  cursor?: string;
}

export interface InboxPage {
  entries: InboxEntry[];
  unhandledCount: number;
  nextCursor: string | null;
}

export interface InboxAppendInput {
  id?: string;
  actorId: string;
  source: string;
  deliveredAt?: Date;
  payload: InboxPayload;
}

export interface MarkHandledResult {
  id: string;
  handledAt: Date;
  alreadyHandled: boolean;
}

export interface InboxActorWork {
  actorId: string;
  priority: "normal" | "responsive";
}

/** Persistence seam. Only markSeen is allowed to write seenAt. */
export interface InboxStore {
  /** Append new entries, returning only rows inserted by this call. Duplicate ids are no-ops. */
  append(entries: InboxAppendInput[]): InboxEntry[];
  list(actorId: string, options?: InboxListOptions): InboxPage;
  read(actorId: string, entryId: string): InboxEntry | null;
  countUnhandled(actorId: string): number;
  /** Each actor with pending work, promoted when any pending entry is responsive. */
  actorsWithUnhandled(): InboxActorWork[];
  /** Each actor with unseen work, promoted when any unseen entry is responsive. */
  actorsWithUnseen(): InboxActorWork[];
  /**
   * Atomically stamp and return every unhandled entry not previously seen by
   * this actor. The empty result makes repeated queue notifications a no-op.
   */
  markSeen(actorId: string, seenAt?: Date): InboxEntry[];
  markHandled(
    actorId: string,
    entryIds: string[],
    handledAt?: Date,
    handledNote?: string
  ): MarkHandledResult[];
}

export function validateInboxPayload(payload: unknown): asserts payload is InboxPayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("inbox payload must be an object");
  }
  if (typeof (payload as { type?: unknown }).type !== "string") {
    throw new Error("inbox payload.type must be a string");
  }
  const priority = (payload as { priority?: unknown }).priority;
  if (priority !== undefined && priority !== "responsive") {
    throw new Error('inbox payload.priority must be "responsive" when present');
  }
}
