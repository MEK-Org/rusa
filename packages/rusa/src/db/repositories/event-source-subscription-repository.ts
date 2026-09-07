import type Database from "better-sqlite3";
import {
  type EventResource,
  type EventSourceSubscription,
  type EventSourceSubscriptionStore,
  resourceKey,
} from "../../actor/event-subscriptions.js";

type SubscriptionRow = {
  resource: string;
  actor_id: string;
  subscribed_by: string;
  subscribed_at: string;
};

function fromRow(row: SubscriptionRow): EventSourceSubscription {
  return {
    resource: row.resource,
    actorId: row.actor_id,
    subscribedBy: row.subscribed_by,
    subscribedAt: row.subscribed_at,
  };
}

const SELECT_COLUMNS = "resource, actor_id, subscribed_by, subscribed_at";

/**
 * SQLite implementation of {@link EventSourceSubscriptionStore} — every call
 * reads straight from `event_source_subscriptions` with no process-local cache,
 * so a subscribe committed by another connection is visible to the next call
 * without an orchestrator restart. `actor_id` is owned by the referenced
 * `actors` row (0038_event_sources).
 *
 * Unlike {@link DbEventSourceOwnerStore} there is no conflict check and no
 * tombstone column: many actors may subscribe to one resource, and unsubscribe
 * deletes the row.
 */
export class DbEventSourceSubscriptionStore implements EventSourceSubscriptionStore {
  constructor(private readonly db: Database.Database) {}

  subscribe(subscription: EventSourceSubscription): void {
    this.db
      .prepare(
        `INSERT INTO event_source_subscriptions
           (resource, actor_id, subscribed_by, subscribed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(resource, actor_id) DO UPDATE SET
           subscribed_by = excluded.subscribed_by,
           subscribed_at = excluded.subscribed_at`
      )
      .run(
        resourceKey(subscription.resource),
        subscription.actorId,
        subscription.subscribedBy,
        subscription.subscribedAt
      );
  }

  unsubscribe(resource: EventResource, actorId: string): void {
    this.db
      .prepare("DELETE FROM event_source_subscriptions WHERE resource = ? AND actor_id = ?")
      .run(resourceKey(resource), actorId);
  }

  list(): EventSourceSubscription[] {
    return (
      this.db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM event_source_subscriptions`)
        .all() as SubscriptionRow[]
    ).map(fromRow);
  }

  subscribersOf(resource: EventResource): EventSourceSubscription[] {
    return (
      this.db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM event_source_subscriptions WHERE resource = ?`)
        .all(resourceKey(resource)) as SubscriptionRow[]
    ).map(fromRow);
  }
}
