import { describe, expect, it } from "vitest";
import {
  type EventResource,
  type EventSubscription,
  type EventSubscriptionStore,
  resourceKey,
} from "./event-subscriptions.js";

export const REPO: EventResource = "github:dummy-org/dummy-repo";
export const OTHER: EventResource = "github:dummy-org/other";
export const ROOT = "root-thread";
export const ACTOR_A = "actor-thread-a";
export const ACTOR_B = "actor-thread-b";

export const sub = (
  over: Partial<Omit<EventSubscription, "resource">> & { resource?: EventResource } = {}
): EventSubscription => ({
  actorId: ACTOR_A,
  subscribedBy: ROOT,
  subscribedAt: "2026-06-27T00:00:00Z",
  ...over,
  resource: resourceKey(over.resource ?? REPO),
});

/**
 * Behavior every {@link EventSubscriptionStore} implementation must satisfy,
 * independent of backing storage — run against `InMemoryEventSubscriptionStore`,
 * `FileEventSubscriptionStore`, and `DbEventSubscriptionStore`. Storage-specific
 * concerns (file quarantine and reload, FK/index enforcement, cross-connection
 * visibility) stay in each store's own test file.
 */
export function testEventSubscriptionStoreContract(
  name: string,
  makeStore: () => EventSubscriptionStore
): void {
  describe(`${name} (EventSubscriptionStore contract)`, () => {
    it("subscribes an actor and reports it active for the resource", () => {
      const store = makeStore();
      store.subscribe(sub());
      const active = store.activeForResource(REPO);
      expect(active).toHaveLength(1);
      expect(active[0]?.actorId).toBe(ACTOR_A);
      expect(store.activeForResource(OTHER)).toEqual([]);
    });

    it("is idempotent per (resource, actorId) — re-subscribe does not duplicate", () => {
      const store = makeStore();
      store.subscribe(sub());
      store.subscribe(sub({ subscribedAt: "2026-06-28T00:00:00Z" }));
      expect(store.list()).toHaveLength(1);
      expect(store.activeForResource(REPO)).toHaveLength(1);
    });

    it("re-subscribing the same actor clears a prior unsubscribedAt (reactivates)", () => {
      const store = makeStore();
      store.subscribe(sub());
      store.unsubscribe(REPO, ACTOR_A, "2026-06-28T00:00:00Z");
      expect(store.activeForResource(REPO)).toEqual([]);

      store.subscribe(sub({ subscribedAt: "2026-06-29T00:00:00Z" }));
      expect(store.activeForResource(REPO)).toHaveLength(1);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]?.unsubscribedAt).toBeUndefined();
    });

    it("unsubscribe marks the row inactive but keeps it in the audit list", () => {
      const store = makeStore();
      store.subscribe(sub());
      store.unsubscribe(REPO, ACTOR_A, "2026-06-28T00:00:00Z");
      expect(store.activeForResource(REPO)).toEqual([]);
      const all = store.list();
      expect(all).toHaveLength(1);
      expect(all[0]?.unsubscribedAt).toBe("2026-06-28T00:00:00Z");
    });

    it("unsubscribing an already-inactive row keeps the original unsubscribedAt", () => {
      const store = makeStore();
      store.subscribe(sub());
      store.unsubscribe(REPO, ACTOR_A, "2026-06-28T00:00:00Z");
      store.unsubscribe(REPO, ACTOR_A, "2026-06-29T00:00:00Z");
      expect(store.list()[0]?.unsubscribedAt).toBe("2026-06-28T00:00:00Z");
    });

    it("list() returns both active and inactive subscriptions", () => {
      const store = makeStore();
      store.subscribe(sub({ resource: REPO, actorId: ACTOR_A }));
      store.subscribe(sub({ resource: OTHER, actorId: ACTOR_B }));
      store.unsubscribe(OTHER, ACTOR_B, "2026-06-28T00:00:00Z");
      expect(store.list()).toHaveLength(2);
      expect(store.activeForResource(REPO)).toHaveLength(1);
      expect(store.activeForResource(OTHER)).toEqual([]);
    });

    it("unsubscribing an unknown subscription is a no-op", () => {
      const store = makeStore();
      store.unsubscribe(REPO, ACTOR_B, "2026-06-28T00:00:00Z");
      expect(store.list()).toEqual([]);
    });

    it("keys on the canonical reference, so a legacy spelling hits the same row", () => {
      const store = makeStore();
      store.subscribe(sub({ resource: REPO }));
      store.unsubscribe("github_repo:dummy-org/dummy-repo", ACTOR_A, "2026-06-28T00:00:00Z");
      expect(store.list()).toHaveLength(1);
      expect(store.activeForResource("github_repo:dummy-org/dummy-repo")).toEqual([]);
    });

    describe("one active subscriber per resource", () => {
      it("throws when a different actor is already actively subscribed", () => {
        const store = makeStore();
        store.subscribe(sub({ actorId: ACTOR_A }));
        expect(() => store.subscribe(sub({ actorId: ACTOR_B }))).toThrow(/dummy-org\/dummy-repo/);
        expect(() => store.subscribe(sub({ actorId: ACTOR_B }))).toThrow(ACTOR_A);
        // The conflicting subscribe did not land.
        expect(store.activeForResource(REPO).map((s) => s.actorId)).toEqual([ACTOR_A]);
        expect(store.list()).toHaveLength(1);
      });

      it("same-actor re-subscribe stays idempotent (no throw)", () => {
        const store = makeStore();
        store.subscribe(sub({ actorId: ACTOR_A }));
        expect(() => store.subscribe(sub({ actorId: ACTOR_A }))).not.toThrow();
        expect(store.list()).toHaveLength(1);
      });

      it("a new actor can subscribe after the prior holder unsubscribes", () => {
        const store = makeStore();
        store.subscribe(sub({ actorId: ACTOR_A }));
        store.unsubscribe(REPO, ACTOR_A, "2026-06-28T00:00:00Z");
        expect(() => store.subscribe(sub({ actorId: ACTOR_B }))).not.toThrow();
        expect(store.activeForResource(REPO).map((s) => s.actorId)).toEqual([ACTOR_B]);
        // The prior holder's row survives for audit.
        expect(store.list()).toHaveLength(2);
      });

      it("different resources are independent", () => {
        const store = makeStore();
        store.subscribe(sub({ resource: REPO, actorId: ACTOR_A }));
        expect(() => store.subscribe(sub({ resource: OTHER, actorId: ACTOR_B }))).not.toThrow();
        expect(store.activeForResource(REPO).map((s) => s.actorId)).toEqual([ACTOR_A]);
        expect(store.activeForResource(OTHER).map((s) => s.actorId)).toEqual([ACTOR_B]);
      });
    });
  });
}
