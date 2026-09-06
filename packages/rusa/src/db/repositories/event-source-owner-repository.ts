import type Database from "better-sqlite3";
import {
  activeOwnerConflictMessage,
  type EventResource,
  type EventSourceOwnerStore,
  type EventSourceOwnership,
  resourceKey,
} from "../../actor/event-subscriptions.js";

type SubscriptionRow = {
  resource: string;
  actor_id: string;
  subscribed_by: string;
  subscribed_at: string;
  unsubscribed_at: string | null;
};

function fromRow(row: SubscriptionRow): EventSourceOwnership {
  return {
    resource: row.resource,
    actorId: row.actor_id,
    subscribedBy: row.subscribed_by,
    subscribedAt: row.subscribed_at,
    ...(row.unsubscribed_at !== null ? { unsubscribedAt: row.unsubscribed_at } : {}),
  };
}

const SELECT_COLUMNS = "resource, actor_id, subscribed_by, subscribed_at, unsubscribed_at";

/**
 * SQLite implementation of {@link EventSourceOwnerStore} — every call reads
 * straight from `event_source_owners` with no process-local cache, so a
 * subscribe or unsubscribe committed by another connection is visible to the
 * next call without an orchestrator restart. `actor_id` is owned by the
 * referenced `actors` row (0038_event_source_owners).
 *
 * This holds only *explicit* subscriptions. The config-implied seed lives in an
 * `InMemoryEventSourceOwnerStore` that `reconcileEventSources` rebuilds each
 * boot and unions over this one, so a tombstone written here keeps suppressing
 * its implied counterpart across restarts.
 */
export class DbEventSourceOwnerStore implements EventSourceOwnerStore {
  constructor(private readonly db: Database.Database) {}

  subscribe(
    subscription: Omit<EventSourceOwnership, "resource"> & { resource: EventResource }
  ): void {
    this.write({ ...subscription, unsubscribedAt: undefined });
  }

  /**
   * Hydrate one already-durable row without reactivating a tombstone — the
   * write the legacy importer needs, and the counterpart of
   * `InMemoryEventSourceOwnerStore.restore`. Deliberately off
   * {@link EventSourceOwnerStore}: nothing in the mesh may resurrect a
   * subscription except through `subscribe`.
   */
  restore(subscription: EventSourceOwnership): void {
    this.write(subscription);
  }

  private write(subscription: EventSourceOwnership): void {
    const resource = resourceKey(subscription.resource);
    // One active subscriber per resource. The conflict check and the write are
    // one transaction so a concurrent writer cannot slip between them; the
    // partial unique index still refuses the row if one ever did.
    this.db.transaction(() => {
      if (!subscription.unsubscribedAt) {
        const holder = this.activeForResource(resource).find(
          (active) => active.actorId !== subscription.actorId
        );
        if (holder) {
          throw new Error(
            activeOwnerConflictMessage(resource, holder.actorId, subscription.actorId)
          );
        }
      }
      this.db
        .prepare(
          `INSERT INTO event_source_owners
             (resource, actor_id, subscribed_by, subscribed_at, unsubscribed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(resource, actor_id) DO UPDATE SET
             subscribed_by = excluded.subscribed_by,
             subscribed_at = excluded.subscribed_at,
             unsubscribed_at = excluded.unsubscribed_at`
        )
        .run(
          resource,
          subscription.actorId,
          subscription.subscribedBy,
          subscription.subscribedAt,
          subscription.unsubscribedAt ?? null
        );
    })();
  }

  unsubscribe(resource: EventResource, actorId: string, at: string): void {
    this.db
      .prepare(
        `UPDATE event_source_owners SET unsubscribed_at = ?
         WHERE resource = ? AND actor_id = ? AND unsubscribed_at IS NULL`
      )
      .run(at, resourceKey(resource), actorId);
  }

  list(): EventSourceOwnership[] {
    return (
      this.db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM event_source_owners`)
        .all() as SubscriptionRow[]
    ).map(fromRow);
  }

  activeForResource(resource: EventResource): EventSourceOwnership[] {
    return (
      this.db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM event_source_owners
           WHERE resource = ? AND unsubscribed_at IS NULL`
        )
        .all(resourceKey(resource)) as SubscriptionRow[]
    ).map(fromRow);
  }
}
