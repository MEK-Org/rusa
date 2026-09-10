import type { InboxEntry, InboxStore } from "../actor/inbox-store.js";

/**
 * Persistence boundary for actor inbox items, alongside {@link ActorRepository}.
 *
 * This follows the review guidance on #380: rather than inventing a second
 * inbox abstraction for the converged runtime, reuse the seam that already
 * exists. `InboxStore` in `actor/inbox-store.ts` is already the abstract
 * interface, and `db/repositories/inbox-repository.ts` is already its concrete
 * SQLite implementation. The only thing the converged runtime actually needs
 * on top of today's interface is the ability to hear about inbox item
 * creations.
 *
 * Target shape at implementation time (deliberately NOT done on this design
 * branch, which stays additive and changes no existing file):
 *
 * - `actor/inbox-store.ts` moves to this file and `InboxStore` becomes
 *   `InboxRepository`, mirroring `repositories/actor-repository.ts`.
 * - The SQLite `InboxRepository` class becomes `SqliteInboxRepository` in
 *   `db/repositories/sqlite-inbox-repository.ts`, mirroring
 *   `db/repositories/sqlite-actor-repository.ts`.
 * - `onItemsAppended` below is absorbed into the moved interface, so this
 *   `extends` clause disappears entirely.
 *
 * Invariants the converged runtime relies on:
 * 1. Durable storage is the single source of truth about unhandled work.
 * 2. `onItemsAppended` is an ADVISORY after-commit notification, never the
 *    source of truth. Dropping one costs latency, not correctness.
 * 3. Missed notifications (a crash, a restart, a listener registered late) are
 *    reconciled against durable state via the existing `actorsWithUnhandled()`.
 */
export interface InboxRepository extends InboxStore {
  /**
   * Subscribe to rows that have been durably committed by `append`. The
   * listener receives only rows actually inserted, so redelivery of an already
   * known id notifies nobody. Returns an unsubscribe function.
   */
  onItemsAppended(listener: (items: readonly InboxEntry[]) => void): () => void;
}
