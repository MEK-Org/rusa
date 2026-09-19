import type { InboxEntry } from "../actor/inbox-store.js";

/**
 * Compare two inbox entries by priority:
 * 1. Responsive entries (payload.priority === 'responsive') before normal entries.
 * 2. Earlier deliveredAt timestamps first (ascending time).
 * 3. Tiebreaker: id ascending.
 */
export function compareInboxPriority(a: InboxEntry, b: InboxEntry): number {
  const aResponsive = a.payload?.priority === "responsive" ? 1 : 0;
  const bResponsive = b.payload?.priority === "responsive" ? 1 : 0;
  if (aResponsive !== bResponsive) {
    return bResponsive - aResponsive;
  }
  const aTime = new Date(a.deliveredAt).getTime();
  const bTime = new Date(b.deliveredAt).getTime();
  if (aTime !== bTime) {
    return aTime - bTime;
  }
  return a.id.localeCompare(b.id);
}

export interface PrioritizedInboxSelection {
  item: InboxEntry;
  moreCount: number;
}

/**
 * Given a list of inbox entries and an optional total unhandled/selected count,
 * select the top entry using the (responsive first, then earliest) heuristic
 * and compute how many additional items remain.
 */
export function selectPrioritizedInboxItem(
  entries: InboxEntry[],
  totalCount?: number
): PrioritizedInboxSelection | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort(compareInboxPriority);
  const total = totalCount ?? entries.length;
  const moreCount = Math.max(0, total - 1);
  return {
    item: sorted[0],
    moreCount,
  };
}
