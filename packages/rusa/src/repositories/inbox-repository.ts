export interface InboxPayload {
  type: string;
  /** Durable scheduling priority; absent means normal/background work. */
  priority?: "responsive";
  /**
   * Which relationship an event fan-out copy was delivered under, attributed
   * by the producer when it appends the row (#632). A directed delivery lands
   * its target as the sole owner, so it is "owner" rather than a third role.
   * The after-commit wake reads this to decide whether a recipient's active
   * run may be replaced ("owner") or only joined ("subscriber"); absent means
   * ordinary work and keeps the ordinary dispatch.
   *
   * Persisted rather than re-resolved after commit because the ownership
   * answer is a snapshot of routing at append time: a directive names a
   * handle, and ownership or subscriptions can change before the wake reads
   * the row, so routing again could give a different answer for the same copy.
   */
  deliveryRole?: InboxDeliveryRole;
  [key: string]: unknown;
}

export type InboxDeliveryRole = "owner" | "subscriber";

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
  /** Return only responsive entries while an explicit voice session is active. */
  responsiveOnly?: boolean;
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

/** Listener for rows durably committed by {@link InboxRepository.append}. */
export type InboxItemsAppendedListener = (items: readonly InboxEntry[]) => void;

/**
 * Persistence boundary for actor inbox items, alongside `ActorRepository`.
 * Only markSeen is allowed to write seenAt.
 *
 * Invariants the runtime relies on:
 * 1. Durable storage is the single source of truth about unhandled work.
 * 2. `onItemsAppended` is an ADVISORY after-commit notification, never the
 *    source of truth. Dropping one costs latency, not correctness.
 * 3. Missed notifications (a crash, a restart, a listener registered late)
 *    are reconciled against durable state via `actorsWithUnhandled()`.
 */
export interface InboxRepository {
  /**
   * Append new entries, returning only rows inserted by this call. Duplicate
   * ids are no-ops. Must be called outside any enclosing transaction: the
   * after-commit notification is only honest once the write is durable.
   */
  append(entries: InboxAppendInput[]): InboxEntry[];
  /**
   * Subscribe to rows that have been durably committed by `append`. The
   * listener receives only rows actually inserted, so redelivery of an already
   * known id notifies nobody, and a failed or rolled-back append notifies
   * nobody. Returns an unsubscribe function.
   *
   * Listeners run synchronously inside the appending caller's turn, after the
   * commit and before that caller's own follow-up (typically the recipient
   * wake), so the callback must be cheap and non-blocking: hand off async work
   * without awaiting it. A thrown error is contained and journaled, never
   * surfaced to the appender. Calling `append` from inside a listener is out of
   * contract; it re-enters this notification path and is not guarded.
   */
  onItemsAppended(listener: InboxItemsAppendedListener): () => void;
  list(actorId: string, options?: InboxListOptions): InboxPage;
  /**
   * Exact queue-card candidate across every unhandled entry, ordered responsive
   * first, then delivered timestamp and id. Optional while non-SQL test stores
   * retain the portable paginated fallback in the dashboard.
   */
  selectPrioritizedUnhandled?(actorId: string): InboxEntry | null;
  read(actorId: string, entryId: string): InboxEntry | null;
  countUnhandled(actorId: string, options?: { responsiveOnly?: boolean }): number;
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
  /**
   * Activity-feed projection of individual durable handled rows, newest first.
   * A handled timestamp or note is not a durable batch identity, so callers
   * receive each item separately rather than a guessed coalesced group.
   */
  listRecentHandledEntries(limit?: number): InboxEntry[];
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
  const deliveryRole = (payload as { deliveryRole?: unknown }).deliveryRole;
  if (deliveryRole !== undefined && deliveryRole !== "owner" && deliveryRole !== "subscriber") {
    throw new Error('inbox payload.deliveryRole must be "owner" or "subscriber" when present');
  }
}

/**
 * An immutable empty inbox repository that holds no entries.
 * Used for lightweight test meshes and environments where inbox storage
 * is not configured, ensuring durable-only dispatch contracts are preserved
 * without manufacturing work.
 */
export class EmptyInboxRepository implements InboxRepository {
  append(_entries: InboxAppendInput[]): InboxEntry[] {
    return [];
  }
  onItemsAppended(_listener: InboxItemsAppendedListener): () => void {
    return () => {};
  }
  list(_actorId: string, _options?: InboxListOptions): InboxPage {
    return { entries: [], unhandledCount: 0, nextCursor: null };
  }
  selectPrioritizedUnhandled?(_actorId: string): InboxEntry | null {
    return null;
  }
  read(_actorId: string, _entryId: string): InboxEntry | null {
    return null;
  }
  countUnhandled(_actorId: string, _options?: { responsiveOnly?: boolean }): number {
    return 0;
  }
  actorsWithUnhandled(): InboxActorWork[] {
    return [];
  }
  actorsWithUnseen(): InboxActorWork[] {
    return [];
  }
  markSeen(_actorId: string, _seenAt?: Date): InboxEntry[] {
    return [];
  }
  markHandled(
    _actorId: string,
    _entryIds: string[],
    _handledAt?: Date,
    _handledNote?: string
  ): MarkHandledResult[] {
    return [];
  }
  listRecentHandledEntries(_limit = 50): InboxEntry[] {
    return [];
  }
}
