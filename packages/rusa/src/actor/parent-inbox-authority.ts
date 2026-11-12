import type { InboxEntry } from "../repositories/inbox-repository.js";

// A parent's authority to clear a child's exhausted inbox work, as one
// function of durable reads, so the mesh and a write operation decide it the
// same way (#1289). Inside a write operation it reads the transaction's
// state, so the decision and the write it authorizes cannot be split.

/** The durable reads the parent-clearance check makes. */
export interface ParentInboxAuthorityReader {
  /** The actor's durable record, or undefined when it has none. */
  actor(id: string): { readonly parentId?: string | null } | undefined;
  readEntry(actorId: string, entryId: string): InboxEntry | null;
  /**
   * How many completed runs focused each entry; an entry counted twice has
   * exhausted bounded recovery. Absent, no entry counts as exhausted.
   */
  completedFocusEntryCounts?(actorId: string): ReadonlyMap<string, number>;
}

export interface ParentInboxAuthorityQuery {
  readonly callerId: string;
  readonly childId: string;
  readonly entryIds: readonly string[];
  /** The thread the legacy `root` alias names, if any. */
  readonly rootId: string | null;
}

/**
 * Validate authority and preconditions for parent clearance of exhausted
 * inbox work, returning the resolved child and its entries in request order.
 */
export function assertParentExhaustedInboxAuthority(
  reader: ParentInboxAuthorityReader,
  query: ParentInboxAuthorityQuery
): { childId: string; entries: InboxEntry[] } {
  const resolve = (id: string) => (id === "root" && query.rootId ? query.rootId : id);
  const callerId = resolve(query.callerId);
  const childId = resolve(query.childId);

  if (callerId === childId) {
    throw new Error(
      "Actors cannot self-clear exhausted inbox work; escalation resolves through the parent"
    );
  }

  const childRecord = reader.actor(childId);
  if (!childRecord) {
    throw new Error(`unknown thread id: ${childId}`);
  }

  if (childId === query.rootId || !childRecord.parentId) {
    throw new Error(
      "Root has no parent in the mesh; root inbox work must be dismissed by the operator via the dashboard"
    );
  }

  if (resolve(childRecord.parentId) !== callerId) {
    throw new Error(
      `Only the parent thread (${childRecord.parentId}) can clear exhausted inbox work for thread ${childId}`
    );
  }

  const uniqueIds = [...new Set(query.entryIds)];
  if (uniqueIds.length === 0 || uniqueIds.length > 100) {
    throw new Error("Provide between 1 and 100 unique inbox entry ids");
  }

  const counts = reader.completedFocusEntryCounts?.(childId);
  const entries: InboxEntry[] = [];
  for (const id of uniqueIds) {
    const entry = reader.readEntry(childId, id);
    if (!entry) {
      throw new Error(`inbox entry not found: ${id}`);
    }
    if (entry.handledAt) {
      throw new Error(`inbox entry already handled: ${id}`);
    }
    if ((counts?.get(id) ?? 0) < 2) {
      throw new Error(
        `Cannot clear entry ${id}: entry has not exhausted bounded recovery; parent clearance is restricted to exhausted entries`
      );
    }
    entries.push(entry);
  }

  return { childId, entries };
}
