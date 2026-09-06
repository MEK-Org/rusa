import { describe, expect, it } from "vitest";
import {
  type EventResource,
  type EventSourceSubscription,
  type EventSourceSubscriptionStore,
  resourceKey,
} from "./event-subscriptions.js";

export const SUB_REPO: EventResource = "github:dummy-org/dummy-repo";
export const SUB_OTHER: EventResource = "github:dummy-org/other";
export const SUB_ROOT = "root-thread";
export const SUB_ACTOR_A = "actor-thread-a";
export const SUB_ACTOR_B = "actor-thread-b";

export const directSub = (
  over: Partial<Omit<EventSourceSubscription, "resource">> & { resource?: EventResource } = {}
): EventSourceSubscription => ({
  actorId: SUB_ACTOR_A,
  subscribedBy: SUB_ACTOR_A,
  subscribedAt: "2026-06-27T00:00:00Z",
  ...over,
  resource: resourceKey(over.resource ?? SUB_REPO),
});

/**
 * Behavior every {@link EventSourceSubscriptionStore} implementation must
 * satisfy, independent of backing storage — run against
 * `InMemoryEventSourceSubscriptionStore` and `DbEventSourceSubscriptionStore`.
 * Storage-specific concerns (FK enforcement, cross-connection visibility) stay
 * in each store's own test file.
 *
 * The contrast with {@link testEventSourceOwnerStoreContract} is the point of
 * this file existing separately: subscriptions admit many actors per resource,
 * never refuse on contention, and delete on unsubscribe rather than tombstone.
 */
export function testEventSourceSubscriptionStoreContract(
  name: string,
  makeStore: () => EventSourceSubscriptionStore
): void {
  describe(`${name} (EventSourceSubscriptionStore contract)`, () => {
    it("subscribes an actor and reports it a subscriber of the resource", () => {
      const store = makeStore();
      store.subscribe(directSub());
      const subscribers = store.subscribersOf(SUB_REPO);
      expect(subscribers).toHaveLength(1);
      expect(subscribers[0]?.actorId).toBe(SUB_ACTOR_A);
      expect(store.subscribersOf(SUB_OTHER)).toEqual([]);
    });

    it("admits many subscribers on one resource without refusing", () => {
      const store = makeStore();
      store.subscribe(directSub({ actorId: SUB_ACTOR_A }));
      store.subscribe(directSub({ actorId: SUB_ACTOR_B }));
      store.subscribe(directSub({ actorId: SUB_ROOT }));
      expect(
        store
          .subscribersOf(SUB_REPO)
          .map((s) => s.actorId)
          .sort()
      ).toEqual([SUB_ACTOR_A, SUB_ACTOR_B, SUB_ROOT].sort());
    });

    it("is idempotent per (resource, actorId) — re-subscribe updates in place", () => {
      const store = makeStore();
      store.subscribe(directSub());
      store.subscribe(directSub({ subscribedAt: "2026-06-28T00:00:00Z", subscribedBy: SUB_ROOT }));
      const rows = store.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        subscribedAt: "2026-06-28T00:00:00Z",
        subscribedBy: SUB_ROOT,
      });
    });

    it("unsubscribe deletes the row rather than tombstoning it", () => {
      const store = makeStore();
      store.subscribe(directSub());
      store.unsubscribe(SUB_REPO, SUB_ACTOR_A);
      expect(store.subscribersOf(SUB_REPO)).toEqual([]);
      // The owner store keeps a released claim so it can outrank the config
      // seed. A subscription has nothing to outrank: it is pure additive
      // routing, so "not subscribed" and "never subscribed" are the same state
      // and a tombstone would only be a row nobody reads.
      expect(store.list()).toEqual([]);
    });

    it("unsubscribe removes only the named actor, leaving co-subscribers", () => {
      const store = makeStore();
      store.subscribe(directSub({ actorId: SUB_ACTOR_A }));
      store.subscribe(directSub({ actorId: SUB_ACTOR_B }));
      store.unsubscribe(SUB_REPO, SUB_ACTOR_A);
      expect(store.subscribersOf(SUB_REPO).map((s) => s.actorId)).toEqual([SUB_ACTOR_B]);
    });

    it("unsubscribing something never subscribed is a no-op", () => {
      const store = makeStore();
      store.subscribe(directSub());
      store.unsubscribe(SUB_OTHER, SUB_ACTOR_B);
      store.unsubscribe(SUB_REPO, SUB_ACTOR_B);
      expect(store.list()).toHaveLength(1);
    });

    it("list() spans resources", () => {
      const store = makeStore();
      store.subscribe(directSub({ resource: SUB_REPO }));
      store.subscribe(directSub({ resource: SUB_OTHER }));
      expect(
        store
          .list()
          .map((s) => s.resource)
          .sort()
      ).toEqual([SUB_OTHER, SUB_REPO].sort());
    });

    it("keys on the canonical reference, so a legacy spelling hits the same row", () => {
      const store = makeStore();
      store.subscribe(directSub({ resource: SUB_REPO }));
      store.subscribe(directSub({ resource: "github_repo:dummy-org/dummy-repo" }));
      expect(store.list()).toHaveLength(1);
      expect(store.subscribersOf("github_repo:dummy-org/dummy-repo")).toHaveLength(1);
    });

    it("unsubscribe accepts a legacy spelling of the subscribed resource", () => {
      const store = makeStore();
      store.subscribe(directSub({ resource: SUB_REPO }));
      store.unsubscribe("github_repo:dummy-org/dummy-repo", SUB_ACTOR_A);
      expect(store.list()).toEqual([]);
    });
  });
}
