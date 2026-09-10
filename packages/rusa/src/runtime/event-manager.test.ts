import { describe, expect, it } from "vitest";
import {
  InMemoryEventSourceOwnerStore,
  InMemoryEventSourceSubscriptionStore,
} from "../actor/event-subscriptions.js";
import type {
  InboxActorWork,
  InboxAppendInput,
  InboxEntry,
  InboxListOptions,
  InboxPage,
  InboxStore,
  MarkHandledResult,
} from "../actor/inbox-store.js";
import { validateInboxPayload } from "../actor/inbox-store.js";
import {
  deduplicatedInboxEntryId,
  EventManager,
  type EventSourceResolver,
  HierarchicalEventSourceResolver,
  type RawIntegrationEvent,
} from "./event-manager.js";

class FakeInboxStore implements InboxStore {
  readonly entries: InboxEntry[] = [];
  appendCalls: InboxAppendInput[][] = [];

  append(inputs: InboxAppendInput[]): InboxEntry[] {
    this.appendCalls.push(inputs);
    const inserted: InboxEntry[] = [];
    for (const input of inputs) {
      validateInboxPayload(input.payload);
      const id = input.id ?? `auto:${Math.random().toString(36).slice(2)}`;
      if (this.entries.some((entry) => entry.id === id)) continue;
      const entry: InboxEntry = {
        id,
        actorId: input.actorId,
        source: input.source,
        deliveredAt: input.deliveredAt ?? new Date(),
        seenAt: null,
        handledAt: null,
        handledNote: null,
        payload: input.payload,
      };
      this.entries.push(entry);
      inserted.push(entry);
    }
    return inserted;
  }

  list(actorId: string, _options?: InboxListOptions): InboxPage {
    const mine = this.entries.filter((entry) => entry.actorId === actorId);
    return {
      entries: mine,
      unhandledCount: mine.filter((entry) => entry.handledAt === null).length,
      nextCursor: null,
    };
  }

  read(actorId: string, entryId: string): InboxEntry | null {
    return this.entries.find((entry) => entry.actorId === actorId && entry.id === entryId) ?? null;
  }

  countUnhandled(actorId: string): number {
    return this.entries.filter((entry) => entry.actorId === actorId && entry.handledAt === null)
      .length;
  }

  actorsWithUnhandled(): InboxActorWork[] {
    return [];
  }

  actorsWithUnseen(): InboxActorWork[] {
    return [];
  }

  markSeen(): InboxEntry[] {
    return [];
  }

  markHandled(): MarkHandledResult[] {
    return [];
  }
}

describe("EventManager", () => {
  describe("Normalization without changing public payloads", () => {
    it("normalizes GitHub webhook payloads preserving exact issue/comment payload contracts", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({ directed: false, ownerIds: ["actor-gh"], subscriberIds: [] }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      // The ingress states its event name; the manager never guesses it from
      // which keys a payload happens to carry.
      const rawWebhook: RawIntegrationEvent = {
        sourceType: "github",
        rawPayload: {
          event: "issue_comment",
          payload: {
            repository: { full_name: "MEK-Org/rusa" },
            action: "created",
            issue: { number: 383 },
            comment: { id: 987654 },
          },
        },
        idempotencyKey: "webhook-deliv-1",
      };

      const normalized = em.normalizeEvent(rawWebhook);
      expect(normalized.resource).toBe("github:MEK-Org/rusa/issues/383");
      expect(normalized.payload).toEqual({
        type: "issue_comment.created",
        commentId: 987654,
      });

      const entries = await em.handleExternalEvent(rawWebhook);
      expect(entries.length).toBe(1);
      expect(entries[0].source).toBe("github:MEK-Org/rusa/issues/383");
      expect(entries[0].payload.type).toBe("issue_comment.created");
      expect(entries[0].payload.commentId).toBe(987654);
      expect(entries[0].id).toBe(deduplicatedInboxEntryId("webhook-deliv-1", "actor-gh"));
    });

    it("normalizes GitHub PR events including merged flag for pull_request.closed", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({ directed: false, ownerIds: ["actor-pr"], subscriberIds: [] }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      const rawPrClosed: RawIntegrationEvent = {
        sourceType: "github",
        rawPayload: {
          event: "pull_request",
          payload: {
            repository: { full_name: "MEK-Org/rusa" },
            action: "closed",
            pull_request: { number: 380, merged: true },
          },
        },
      };

      const entries = await em.handleExternalEvent(rawPrClosed);
      expect(entries.length).toBe(1);
      expect(entries[0].source).toBe("github:MEK-Org/rusa/pulls/380");
      expect(entries[0].payload.type).toBe("pull_request.closed");
      expect(entries[0].payload.merged).toBe(true);
    });

    it("normalizes Chat events into canonical gchat.message with responsive priority", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({ directed: false, ownerIds: ["actor-chat"], subscriberIds: [] }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      const rawChat: RawIntegrationEvent = {
        sourceType: "chat",
        rawPayload: {
          name: "spaces/AAA/messages/BBB",
          spaceName: "spaces/AAA",
          threadName: "spaces/AAA/threads/TTT",
          senderName: "users/123",
          createTime: "2026-09-10T12:00:00Z",
        },
      };

      const entries = await em.handleExternalEvent(rawChat);
      expect(entries.length).toBe(1);
      expect(entries[0].source).toBe("gchat:spaces/AAA");
      expect(entries[0].payload).toEqual({
        type: "gchat.message",
        messageName: "spaces/AAA/messages/BBB",
        spaceName: "spaces/AAA",
        threadName: "spaces/AAA/threads/TTT",
        senderName: "users/123",
        priority: "responsive",
      });
      expect(entries[0].id).toBe(deduplicatedInboxEntryId("spaces/AAA/messages/BBB", "actor-chat"));
    });

    it("normalizes timer events with responsive priority by default", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({
          directed: false,
          ownerIds: ["actor-timer"],
          subscriberIds: [],
        }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      const rawTimer: RawIntegrationEvent = {
        sourceType: "timer",
        rawResource: "system:events",
        rawPayload: { type: "timer.wake", reminder: "check build" },
        idempotencyKey: "timer-1",
      };

      const entries = await em.handleExternalEvent(rawTimer);
      expect(entries.length).toBe(1);
      expect(entries[0].source).toBe("system:events");
      expect(entries[0].payload.type).toBe("timer.wake");
      expect(entries[0].payload.priority).toBe("responsive");
      expect(entries[0].payload.reminder).toBe("check build");
    });

    it("normalizes custom ingress shapes preserving payload contents", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({
          directed: false,
          ownerIds: ["actor-custom"],
          subscriberIds: [],
        }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      const rawCustom: RawIntegrationEvent = {
        sourceType: "custom",
        rawResource: "system:events/deploys/b-999",
        rawPayload: { type: "service.deploy", buildId: "b-999" },
      };

      const entries = await em.handleExternalEvent(rawCustom);
      expect(entries.length).toBe(1);
      expect(entries[0].source).toBe("system:events/deploys/b-999");
      expect(entries[0].payload.type).toBe("service.deploy");
      expect(entries[0].payload.buildId).toBe("b-999");
    });

    it("distinguishes PR review events that share a pull_request key", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({ directed: false, ownerIds: ["actor-ci"], subscriberIds: [] }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      // `pull_request_review` and `pull_request_review_comment` both carry a
      // `pull_request`; only the carried event name tells them apart.
      const review = em.normalizeEvent({
        sourceType: "github",
        rawPayload: {
          event: "pull_request_review",
          payload: {
            repository: { full_name: "MEK-Org/rusa" },
            action: "submitted",
            pull_request: { number: 392 },
            review: { id: 1 },
          },
        },
      });
      const reviewComment = em.normalizeEvent({
        sourceType: "github",
        rawPayload: {
          event: "pull_request_review_comment",
          payload: {
            repository: { full_name: "MEK-Org/rusa" },
            action: "created",
            pull_request: { number: 392 },
            comment: { id: 2 },
          },
        },
      });

      expect(review.payload.type).toBe("pull_request_review.submitted");
      expect(reviewComment.payload.type).toBe("pull_request_review_comment.created");
    });
  });

  describe("Owner-plus-subscriber routing and deduplication", () => {
    it("delivers to both owner and direct subscribers", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({
          directed: false,
          ownerIds: ["owner-actor"],
          subscriberIds: ["sub-1", "sub-2"],
        }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      const entries = await em.handleExternalEvent({
        sourceType: "custom",
        rawResource: "system:events",
        rawPayload: { type: "test.event" },
      });

      expect(entries.length).toBe(3);
      const recipientIds = entries.map((e) => e.actorId).sort();
      expect(recipientIds).toEqual(["owner-actor", "sub-1", "sub-2"]);
    });

    it("deduplicates recipients when an actor is both owner and subscriber", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({
          directed: false,
          ownerIds: ["actor-both"],
          subscriberIds: ["actor-both", "other-sub"],
        }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      const entries = await em.handleExternalEvent({
        sourceType: "custom",
        rawResource: "system:events",
        rawPayload: { type: "test.event" },
      });

      expect(entries.length).toBe(2);
      const recipientIds = entries.map((e) => e.actorId).sort();
      expect(recipientIds).toEqual(["actor-both", "other-sub"]);
      expect(inbox.list("actor-both").entries.length).toBe(1);
    });

    it("returns empty array and writes nothing when no recipients exist", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({ directed: false, ownerIds: [], subscriberIds: [] }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      const entries = await em.handleExternalEvent({
        sourceType: "custom",
        rawResource: "system:events/uncovered/1",
        rawPayload: { type: "test.event" },
      });

      expect(entries).toEqual([]);
      expect(inbox.entries.length).toBe(0);
    });
  });

  describe("Stable dedupe IDs and durable idempotency", () => {
    it("generates deterministic 32-hex dedupe IDs via deduplicatedInboxEntryId", () => {
      const id1 = deduplicatedInboxEntryId("key-123", "actor-a");
      const id2 = deduplicatedInboxEntryId("key-123", "actor-a");
      const idOtherActor = deduplicatedInboxEntryId("key-123", "actor-b");

      expect(id1).toBe(id2);
      expect(id1).toMatch(/^dedupe:[0-9a-f]{32}$/);
      expect(id1).not.toBe(idOtherActor);
    });

    it("prevents duplicate inbox entries on repeated deliveries with same idempotency key", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({
          directed: false,
          ownerIds: ["actor-idemp"],
          subscriberIds: [],
        }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      const event: RawIntegrationEvent = {
        sourceType: "github",
        rawResource: "github:org/repo/issues/100",
        rawPayload: { type: "issues.opened" },
        idempotencyKey: "unique-guid-456",
      };

      const firstPass = await em.handleExternalEvent(event);
      expect(firstPass.length).toBe(1);

      const secondPass = await em.handleExternalEvent(event);
      expect(secondPass.length).toBe(0);

      expect(inbox.countUnhandled("actor-idemp")).toBe(1);
    });
  });

  describe("Strict invariant: EventManager never invokes actors", () => {
    it("only performs durable inbox append and never triggers execution", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({
          directed: false,
          ownerIds: ["actor-quiet"],
          subscriberIds: [],
        }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      // Verify no runtime, runner, or execution dispatcher is invoked
      const entries = await em.handleExternalEvent({
        sourceType: "custom",
        rawResource: "system:events/jobs/1",
        rawPayload: { type: "job.created" },
      });

      expect(entries.length).toBe(1);
      // Entry is in the inbox store
      expect(inbox.read("actor-quiet", entries[0].id)).not.toBeNull();
      // Unhandled count is 1, seenAt is null (actor has not run)
      expect(inbox.read("actor-quiet", entries[0].id)?.seenAt).toBeNull();
      expect(inbox.countUnhandled("actor-quiet")).toBe(1);
    });
  });

  describe("HierarchicalEventSourceResolver", () => {
    it("resolves exact owner and direct subscribers", () => {
      const ownerStore = new InMemoryEventSourceOwnerStore();
      const subStore = new InMemoryEventSourceSubscriptionStore();

      ownerStore.subscribe({
        resource: "github:MEK-Org/rusa/issues/383",
        actorId: "actor-issue-owner",
        subscribedBy: "root",
        subscribedAt: "2026-09-10T12:00:00Z",
      });
      subStore.subscribe({
        resource: "github:MEK-Org/rusa/issues/383",
        actorId: "actor-issue-sub",
        subscribedBy: "root",
        subscribedAt: "2026-09-10T12:00:00Z",
      });

      const resolver = new HierarchicalEventSourceResolver({
        eventSourceOwners: ownerStore,
        eventSourceSubscriptions: subStore,
        isLive: () => true,
      });

      const { directed, ownerIds, subscriberIds } = resolver.resolveRecipients(
        "github:MEK-Org/rusa/issues/383"
      );
      expect(directed).toBe(false);
      expect(ownerIds).toEqual(["actor-issue-owner"]);
      expect(subscriberIds).toEqual(["actor-issue-sub"]);
    });

    it("bubbles allowlisted events up to parent resource owner when exact owner is absent", () => {
      const ownerStore = new InMemoryEventSourceOwnerStore();
      const subStore = new InMemoryEventSourceSubscriptionStore();

      // Repo has an owner, but issue 500 has no exact owner
      ownerStore.subscribe({
        resource: "github:MEK-Org/rusa",
        actorId: "repo-owner",
        subscribedBy: "root",
        subscribedAt: "2026-09-10T12:00:00Z",
      });

      const resolver = new HierarchicalEventSourceResolver({
        eventSourceOwners: ownerStore,
        eventSourceSubscriptions: subStore,
        isLive: () => true,
      });

      // issues.opened is allowlisted for bubbling
      const bubbleResult = resolver.resolveRecipients("github:MEK-Org/rusa/issues/500", {
        eventPayload: { type: "issues.opened" },
      });
      expect(bubbleResult.ownerIds).toEqual(["repo-owner"]);

      // pull_request.closed without merged is NOT allowlisted
      const noBubbleResult = resolver.resolveRecipients("github:MEK-Org/rusa/pulls/500", {
        eventPayload: { type: "pull_request.closed", merged: false },
      });
      expect(noBubbleResult.ownerIds).toEqual([]);
    });

    it("gives live obligation claims precedence over explicit subscriptions", () => {
      const ownerStore = new InMemoryEventSourceOwnerStore();
      const subStore = new InMemoryEventSourceSubscriptionStore();

      ownerStore.subscribe({
        resource: "github:MEK-Org/rusa/issues/383",
        actorId: "subscribed-actor",
        subscribedBy: "root",
        subscribedAt: "2026-09-10T12:00:00Z",
      });

      const mockObligations = {
        findLiveByExternalRef: (ref: string) => {
          if (ref === "github:MEK-Org/rusa/issues/383") {
            return { ownerId: "obligation-actor" };
          }
          return null;
        },
      };

      const resolver = new HierarchicalEventSourceResolver({
        eventSourceOwners: ownerStore,
        eventSourceSubscriptions: subStore,
        obligations: mockObligations,
        isLive: () => true,
      });

      const { ownerIds } = resolver.resolveRecipients("github:MEK-Org/rusa/issues/383");
      expect(ownerIds).toEqual(["obligation-actor"]);
    });

    it("terminates bubbling climb when obligation is held by dead or human owner", () => {
      const ownerStore = new InMemoryEventSourceOwnerStore();
      const subStore = new InMemoryEventSourceSubscriptionStore();

      ownerStore.subscribe({
        resource: "github:MEK-Org/rusa",
        actorId: "repo-owner",
        subscribedBy: "root",
        subscribedAt: "2026-09-10T12:00:00Z",
      });

      const mockObligations = {
        findLiveByExternalRef: () => ({ ownerId: "human:operator" }),
      };

      const resolver = new HierarchicalEventSourceResolver({
        eventSourceOwners: ownerStore,
        eventSourceSubscriptions: subStore,
        obligations: mockObligations,
        isLive: (id) => id !== "human:operator",
      });

      const { ownerIds } = resolver.resolveRecipients("github:MEK-Org/rusa/issues/383", {
        eventPayload: { type: "issues.opened" },
      });
      // Obligation terminates the climb; does not fall back to repo-owner
      expect(ownerIds).toEqual([]);
    });

    it("suppresses delivery to author matching stampedAuthor", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({
          directed: false,
          ownerIds: ["actor-self"],
          subscriberIds: ["actor-other"],
        }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      const entries = await em.handleExternalEvent({
        sourceType: "github",
        rawResource: "github:org/repo/issues/1",
        rawPayload: { type: "issue_comment.created" },
        stampedAuthor: { actorId: "actor-self", instanceId: "inst-1" },
        instanceId: "inst-1",
      });

      // actor-self is suppressed, actor-other receives the event
      expect(entries.length).toBe(1);
      expect(entries[0].actorId).toBe("actor-other");
    });

    it("suppresses all destinations when stampedAuthor is a system actor on the same instance", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({
          directed: false,
          ownerIds: ["actor-1"],
          subscriberIds: ["actor-2"],
        }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      const entries = await em.handleExternalEvent({
        sourceType: "custom",
        rawResource: "system:events",
        rawPayload: { type: "system.event" },
        stampedAuthor: { actorId: "system:mesh", instanceId: "inst-1" },
        instanceId: "inst-1",
      });

      expect(entries).toEqual([]);
      expect(inbox.entries.length).toBe(0);
    });
  });
  describe("Directed delivery is the resolver's answer, not a re-derivation", () => {
    const directedResolver = (opts: {
      obligationOwner?: string;
      handle?: string;
      handleId?: string;
    }) =>
      new HierarchicalEventSourceResolver({
        eventSourceOwners: new InMemoryEventSourceOwnerStore(),
        eventSourceSubscriptions: new InMemoryEventSourceSubscriptionStore(),
        obligations: opts.obligationOwner
          ? { findLiveByExternalRef: () => ({ ownerId: opts.obligationOwner as string }) }
          : undefined,
        isLive: () => true,
        resolveActor: (handleOrId) =>
          handleOrId === opts.handle ? { id: opts.handleId as string } : undefined,
      });

    it("delivers a handle-form directive carrying a same-instance system stamp", async () => {
      // `parseDirectedDeliveryDirective` yields a *handle*; the resolver maps it
      // to an actor id. Reconstructing `directed` from `ownerIds.includes(target)`
      // misses this — the landed directive loses its suppression exemption and
      // the system-stamped event is dropped outright.
      const inbox = new FakeInboxStore();
      const em = new EventManager({
        inboxStore: inbox,
        resolver: directedResolver({ handle: "cloudy-porpoise", handleId: "uuid-cloudy" }),
      });

      const entries = await em.handleExternalEvent({
        sourceType: "custom",
        rawResource: "github:MEK-Org/rusa/issues/383",
        rawPayload: { type: "issue_comment.created" },
        directedTarget: "cloudy-porpoise",
        stampedAuthor: { actorId: "system:mesh", instanceId: "inst-1" },
        instanceId: "inst-1",
      });

      expect(entries.map((entry) => entry.actorId)).toEqual(["uuid-cloudy"]);
    });

    it("delivers a handle-form directive carrying a same-instance self stamp", async () => {
      const inbox = new FakeInboxStore();
      const em = new EventManager({
        inboxStore: inbox,
        resolver: directedResolver({ handle: "cloudy-porpoise", handleId: "uuid-cloudy" }),
      });

      const entries = await em.handleExternalEvent({
        sourceType: "custom",
        rawResource: "github:MEK-Org/rusa/issues/383",
        rawPayload: { type: "issue_comment.created" },
        directedTarget: "cloudy-porpoise",
        stampedAuthor: { actorId: "uuid-cloudy", instanceId: "inst-1" },
        instanceId: "inst-1",
      });

      expect(entries.map((entry) => entry.actorId)).toEqual(["uuid-cloudy"]);
    });

    it("does not exempt an obligation owner that merely equals an id-form target", async () => {
      // The inverse error: a live obligation overrides the directive, so the
      // resolver deliberately leaves `directed` false. String equality against
      // `ownerIds` would call this directed and skip suppression staging applies.
      const inbox = new FakeInboxStore();
      const em = new EventManager({
        inboxStore: inbox,
        resolver: directedResolver({ obligationOwner: "actor-governing" }),
      });

      const entries = await em.handleExternalEvent({
        sourceType: "custom",
        rawResource: "github:MEK-Org/rusa/issues/383",
        rawPayload: { type: "issue_comment.created" },
        directedTarget: "actor-governing",
        stampedAuthor: { actorId: "actor-governing", instanceId: "inst-1" },
        instanceId: "inst-1",
      });

      expect(entries).toEqual([]);
      expect(inbox.entries.length).toBe(0);
    });

    it("reports directed on the resolver result for a landed directive only", () => {
      expect(
        directedResolver({ handle: "cloudy-porpoise", handleId: "uuid-cloudy" }).resolveRecipients(
          "github:MEK-Org/rusa/issues/383",
          { directedTarget: "cloudy-porpoise" }
        )
      ).toEqual({ directed: true, ownerIds: ["uuid-cloudy"], subscriberIds: [] });

      // Overridden by a live obligation: ownership resolves normally instead.
      expect(
        directedResolver({ obligationOwner: "actor-governing" }).resolveRecipients(
          "github:MEK-Org/rusa/issues/383",
          { directedTarget: "actor-governing" }
        )
      ).toEqual({ directed: false, ownerIds: ["actor-governing"], subscriberIds: [] });
    });

    it("does not fan a landed directive out to subscribers", () => {
      const subs = new InMemoryEventSourceSubscriptionStore();
      subs.subscribe({
        resource: "github:MEK-Org/rusa/issues/383",
        actorId: "actor-watcher",
        subscribedBy: "root",
        subscribedAt: "2026-09-10T12:00:00Z",
      });
      const resolver = new HierarchicalEventSourceResolver({
        eventSourceOwners: new InMemoryEventSourceOwnerStore(),
        eventSourceSubscriptions: subs,
        isLive: () => true,
        resolveActor: (h) => (h === "cloudy-porpoise" ? { id: "uuid-cloudy" } : undefined),
      });

      const landed = resolver.resolveRecipients("github:MEK-Org/rusa/issues/383", {
        directedTarget: "cloudy-porpoise",
      });
      expect(landed).toEqual({ directed: true, ownerIds: ["uuid-cloudy"], subscriberIds: [] });

      // A directive that failed to land does not defeat a standing interest.
      const missed = resolver.resolveRecipients("github:MEK-Org/rusa/issues/383", {
        directedTarget: "nobody-here",
      });
      expect(missed).toEqual({
        directed: false,
        ownerIds: [],
        subscriberIds: ["actor-watcher"],
      });
    });
  });

  describe("Delivery order and append-result agreement", () => {
    it("appends owners before subscribers in resolver order", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({
          directed: false,
          ownerIds: ["owner-1", "owner-2"],
          subscriberIds: ["sub-1", "sub-2"],
        }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      const entries = await em.handleExternalEvent({
        sourceType: "custom",
        rawResource: "system:events",
        rawPayload: { type: "test.event" },
      });

      // Order is asserted rather than inferred: owners first, then subscribers.
      expect(entries.map((entry) => entry.actorId)).toEqual([
        "owner-1",
        "owner-2",
        "sub-1",
        "sub-2",
      ]);
      expect(inbox.appendCalls[0].map((input) => input.actorId)).toEqual([
        "owner-1",
        "owner-2",
        "sub-1",
        "sub-2",
      ]);
    });

    it("keeps a suppressed author out of the append and preserves the rest in order", async () => {
      const inbox = new FakeInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({
          directed: false,
          ownerIds: ["owner-1"],
          subscriberIds: ["actor-self", "sub-2"],
        }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      const entries = await em.handleExternalEvent({
        sourceType: "custom",
        rawResource: "system:events",
        rawPayload: { type: "test.event" },
        stampedAuthor: { actorId: "actor-self", instanceId: "inst-1" },
        instanceId: "inst-1",
      });

      expect(entries.map((entry) => entry.actorId)).toEqual(["owner-1", "sub-2"]);
    });

    it("throws when the store returns an actor the manager did not compute", async () => {
      class StrayingInboxStore extends FakeInboxStore {
        override append(inputs: InboxAppendInput[]): InboxEntry[] {
          return super.append([...inputs, { ...inputs[0], id: undefined, actorId: "intruder" }]);
        }
      }
      const inbox = new StrayingInboxStore();
      const resolver: EventSourceResolver = {
        resolveRecipients: () => ({
          directed: false,
          ownerIds: ["owner-1"],
          subscriberIds: [],
        }),
      };
      const em = new EventManager({ inboxStore: inbox, resolver });

      await expect(
        em.handleExternalEvent({
          sourceType: "custom",
          rawResource: "system:events",
          rawPayload: { type: "test.event" },
        })
      ).rejects.toThrow("Inbox append returned an unexpected actor: intruder");
    });
  });
});
