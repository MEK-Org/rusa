import { randomUUID } from "node:crypto";
import {
  type InboxAppendInput,
  type InboxEntry,
  type InboxStore,
  type MarkHandledResult,
  validateInboxPayload,
} from "../actor/inbox-store.js";

/**
 * Note on future dispatch flags:
 * Matt sketched possible future fine-grained dispatch flags on inbox items,
 * such as `{ interrupt: boolean; skipQueue: boolean; skipWake: boolean }` (e.g. for FYI-tier items).
 * In this POC, current dispatch semantics are preserved exactly: priority is
 * derived directly from the durable inbox item payload (`payload.priority === "responsive"` vs normal).
 * Fine-grained flags are explicitly deferred future possibilities, not POC behavior or schema.
 */

export type InboxItem = InboxEntry;
export type NewInboxItem = InboxAppendInput;

/**
 * The authoritative storage seam for actor inbox items.
 *
 * Invariants:
 * 1. Durable storage is the single source of truth about unhandled work.
 * 2. Change callbacks (onItemsCommitted) are ADVISORY after-commit notifications,
 *    not the source of truth.
 * 3. Boot recovery reconciles directly against listActorsWithUnhandledItems().
 */
export interface InboxItemRepository {
  append(items: readonly NewInboxItem[]): Promise<readonly InboxItem[]>;

  /**
   * Fires advisory notifications after rows are durably committed.
   * Subscription is separate from storage; missed callbacks (e.g. across restart)
   * are reconciled via listActorsWithUnhandledItems().
   */
  onItemsCommitted(callback: (items: readonly InboxItem[]) => void): () => void;

  /**
   * Boot reconciliation query: returns every actor id with pending unhandled work.
   */
  listActorsWithUnhandledItems(): Promise<readonly string[]>;

  /**
   * Returns unhandled inbox items for an actor.
   */
  getUnhandledItems(actorId: string): Promise<readonly InboxItem[]>;

  /**
   * Marks unhandled items as seen.
   */
  markSeen(actorId: string, seenAt?: Date): Promise<readonly InboxItem[]>;

  /**
   * Marks items handled with an optional resolution note.
   */
  markHandled(
    actorId: string,
    itemIds: readonly string[],
    note?: string,
    at?: Date
  ): Promise<readonly MarkHandledResult[]>;
}

/**
 * Durable implementation of InboxItemRepository.
 *
 * Can wrap an underlying InboxStore (e.g. SQLite InboxRepository) or operate
 * in memory for focused unit tests.
 */
export class DurableInboxItemRepository implements InboxItemRepository {
  private readonly listeners = new Set<(items: readonly InboxItem[]) => void>();
  private readonly inMemoryItems: InboxItem[] = [];

  constructor(
    private readonly underlyingStore?: InboxStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async append(items: readonly NewInboxItem[]): Promise<readonly InboxItem[]> {
    if (items.length === 0) return [];

    for (const item of items) {
      validateInboxPayload(item.payload);
    }

    const inserted: InboxItem[] = [];

    if (this.underlyingStore) {
      const storeInputs: InboxAppendInput[] = items.map((item) => ({
        id: item.id ?? randomUUID(),
        actorId: item.actorId,
        source: item.source,
        deliveredAt: item.deliveredAt ?? this.now(),
        payload: item.payload,
      }));

      const storeEntries = this.underlyingStore.append(storeInputs);
      for (const entry of storeEntries) {
        inserted.push(entry);
      }
    } else {
      // In-memory fallback
      for (const item of items) {
        const id = item.id ?? randomUUID();
        // Deduplicate by ID
        if (this.inMemoryItems.some((existing) => existing.id === id)) {
          continue;
        }
        const created: InboxItem = {
          id,
          actorId: item.actorId,
          source: item.source,
          deliveredAt: item.deliveredAt ?? this.now(),
          seenAt: null,
          handledAt: null,
          handledNote: null,
          payload: item.payload,
        };
        this.inMemoryItems.push(created);
        inserted.push(created);
      }
    }

    // Advisory after-commit notification
    if (inserted.length > 0) {
      for (const listener of this.listeners) {
        try {
          listener(inserted);
        } catch {
          // Advisory notification failure must not fail the durable write
        }
      }
    }

    return inserted;
  }

  onItemsCommitted(callback: (items: readonly InboxItem[]) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  async listActorsWithUnhandledItems(): Promise<readonly string[]> {
    if (this.underlyingStore) {
      return this.underlyingStore.actorsWithUnhandled().map((w) => w.actorId);
    }
    const unhandled = new Set<string>();
    for (const item of this.inMemoryItems) {
      if (item.handledAt === null) {
        unhandled.add(item.actorId);
      }
    }
    return Array.from(unhandled);
  }

  async getUnhandledItems(actorId: string): Promise<readonly InboxItem[]> {
    if (this.underlyingStore) {
      const page = this.underlyingStore.list(actorId, { status: "unhandled", limit: 100 });
      return page.entries;
    }
    return this.inMemoryItems.filter((item) => item.actorId === actorId && item.handledAt === null);
  }

  async markSeen(actorId: string, seenAt: Date = this.now()): Promise<readonly InboxItem[]> {
    if (this.underlyingStore) {
      return this.underlyingStore.markSeen(actorId, seenAt);
    }
    const seen: InboxItem[] = [];
    for (const item of this.inMemoryItems) {
      if (item.actorId === actorId && item.handledAt === null && item.seenAt === null) {
        item.seenAt = seenAt;
        seen.push(item);
      }
    }
    return seen;
  }

  async markHandled(
    actorId: string,
    itemIds: readonly string[],
    note?: string,
    at: Date = this.now()
  ): Promise<readonly MarkHandledResult[]> {
    if (this.underlyingStore) {
      return this.underlyingStore.markHandled(actorId, [...itemIds], at, note);
    }
    const idSet = new Set(itemIds);
    const results: MarkHandledResult[] = [];
    for (const item of this.inMemoryItems) {
      if (item.actorId === actorId && idSet.has(item.id)) {
        const alreadyHandled = item.handledAt !== null;
        if (!alreadyHandled) {
          item.handledAt = at;
          item.handledNote = note?.trim() || null;
        }
        results.push({
          id: item.id,
          handledAt: item.handledAt ?? at,
          alreadyHandled,
        });
      }
    }
    return results;
  }
}
