import { describe, expect, it } from "vitest";
import { testEventSubscriptionStoreContract } from "./event-subscription-store.contract.js";
import {
  type EventResource,
  type EventSubscription,
  InMemoryEventSubscriptionStore,
  isStrictSubResourceOf,
  isSubResourceOf,
  missingAuditedEventSubscriptions,
  normalizeEventResource,
  parentOf,
  parseLegacyEventSubscriptionDocument,
  reconcileEventSources,
  resourceKey,
  sameResource,
} from "./event-subscriptions.js";

const REPO = "github:dummy-org/dummy-repo";
const OTHER = "github:dummy-org/other";
const ACTOR_A = "actor-thread-a";
const ACTOR_B = "actor-thread-b";

const sub = (
  over: Partial<Omit<EventSubscription, "resource">> & { resource?: EventResource } = {}
): EventSubscription => ({
  actorId: ACTOR_A,
  subscribedBy: "root",
  subscribedAt: "2026-06-27T00:00:00Z",
  ...over,
  resource: resourceKey(over.resource ?? REPO),
});

// Behavior shared by every store implementation lives in the contract suite so
// the in-memory seed store and the SQLite store are held to the same rules.
testEventSubscriptionStoreContract(
  "InMemoryEventSubscriptionStore",
  () => new InMemoryEventSubscriptionStore()
);

// The SQLite importer is now the only caller of the legacy parse, so the
// pre-cutover document semantics are pinned here directly instead of through
// the retired JSON store. Every rejection is an ownership claim the importer
// refuses the whole file over; these cases fix which rows produce one.
describe("parseLegacyEventSubscriptionDocument", () => {
  const rootId = "root";
  const parse = (document: unknown) =>
    parseLegacyEventSubscriptionDocument(JSON.stringify(document), {
      file: "event-subscriptions.json",
      rootId,
    });

  it("fails closed on a document it cannot read rather than reporting no subscriptions", () => {
    expect(() =>
      parseLegacyEventSubscriptionDocument("{ this is not valid json ]", {
        file: "event-subscriptions.json",
        rootId,
      })
    ).toThrow(/invalid event subscription file/);
    expect(() => parse([])).toThrow(/invalid event subscription file root/);
    expect(() => parse({ version: 0, subscriptions: [] })).toThrow(
      /invalid event subscription file version/
    );
    expect(() => parse({ version: 4, subscriptions: [] })).toThrow(
      /unsupported event subscription file version/
    );
    expect(() => parse({ version: 3, subscriptions: {} })).toThrow(
      /invalid event subscription rows/
    );
  });

  it("reads an empty or absent subscription list as no subscriptions", () => {
    expect(parse({ version: 3 })).toEqual({ subscriptions: [], rejections: [] });
    expect(parse({ version: 3, subscriptions: [] })).toEqual({ subscriptions: [], rejections: [] });
  });

  it("reports a malformed row by position instead of dropping it silently", () => {
    const document = parse({
      version: 3,
      subscriptions: [sub({ actorId: ACTOR_A }), { resource: OTHER, actorId: "" }],
    });

    expect(document.subscriptions.map((row) => row.actorId)).toEqual([ACTOR_A]);
    expect(document.rejections).toEqual([{ row: 2, reason: "actorId must be a non-empty string" }]);
  });

  it("rejects an invalid timestamp instead of letting it outrank a valid row", () => {
    const document = parse({
      version: 3,
      subscriptions: [
        sub({ actorId: ACTOR_A, subscribedAt: "zzz" }),
        sub({ actorId: ACTOR_B, subscribedAt: "2026-06-29T00:00:00Z" }),
      ],
    });

    expect(document.subscriptions.map((row) => row.actorId)).toEqual([ACTOR_B]);
    expect(document.rejections).toEqual([
      { row: 1, reason: "subscribedAt must be a valid timestamp" },
    ]);
  });

  it("keeps the newest active owner and rejects the loser, independently of row order", () => {
    const older = sub({ actorId: ACTOR_A, subscribedAt: "2026-06-27T00:00:00Z" });
    const newer = sub({ actorId: ACTOR_B, subscribedAt: "2026-06-29T00:00:00Z" });

    for (const subscriptions of [
      [older, newer],
      [newer, older],
    ]) {
      const document = parse({ version: 3, subscriptions });
      expect(document.subscriptions.map((row) => row.actorId)).toEqual([ACTOR_B]);
      expect(document.rejections.map((rejection) => rejection.reason)).toEqual([
        `a newer active subscriber already owns ${REPO}`,
      ]);
    }
  });

  it("rejects tied active owners rather than assigning ownership from row order", () => {
    const utc = sub({ actorId: ACTOR_A, subscribedAt: "2026-06-27T00:00:00Z" });
    const offset = sub({ actorId: ACTOR_B, subscribedAt: "2026-06-26T20:00:00-04:00" });

    for (const subscriptions of [
      [utc, offset],
      [offset, utc],
    ]) {
      const document = parse({ version: 3, subscriptions });
      expect(document.subscriptions).toEqual([]);
      expect(document.rejections.map((rejection) => rejection.reason)).toEqual([
        `ambiguous active subscribers for ${REPO}`,
        `ambiguous active subscribers for ${REPO}`,
      ]);
    }
  });

  it("collapses two spellings of one (resource, actor) pair onto its latest transition", () => {
    // The legacy spelling normalizes onto the same canonical key as the
    // tombstone, so the pair resolves to the later of the two states.
    const active = {
      resource: "github_repo:dummy-org/dummy-repo",
      actorId: ACTOR_A,
      subscribedBy: rootId,
      subscribedAt: "2026-06-27T00:00:00Z",
    };
    const tombstone = sub({
      actorId: ACTOR_A,
      subscribedAt: "2026-06-27T00:00:00Z",
      unsubscribedAt: "2026-06-28T00:00:00Z",
    });

    for (const subscriptions of [
      [active, tombstone],
      [tombstone, active],
    ]) {
      const document = parse({ version: 3, subscriptions });
      expect(document.subscriptions).toEqual([
        expect.objectContaining({ resource: REPO, unsubscribedAt: "2026-06-28T00:00:00Z" }),
      ]);
      expect(document.rejections.map((rejection) => rejection.reason)).toEqual([
        `a later state already exists for ${REPO}`,
      ]);
    }
  });

  it("orders tombstones ahead of active rows so a replay never trips the ownership guard", () => {
    const document = parse({
      version: 3,
      subscriptions: [
        sub({ actorId: ACTOR_B, subscribedAt: "2026-06-27T00:00:00Z" }),
        sub({
          actorId: ACTOR_A,
          subscribedAt: "2026-06-25T00:00:00Z",
          unsubscribedAt: "2026-06-26T00:00:00Z",
        }),
      ],
    });

    expect(document.rejections).toEqual([]);
    expect(document.subscriptions.map((row) => row.actorId)).toEqual([ACTOR_A, ACTOR_B]);

    // Replaying in that order is exactly what the importer does.
    const store = new InMemoryEventSubscriptionStore();
    for (const subscription of document.subscriptions) store.restore(subscription);
    expect(store.activeForResource(REPO).map((row) => row.actorId)).toEqual([ACTOR_B]);
  });

  it("normalizes version 2 object resources onto canonical reference strings", () => {
    const document = parse({
      version: 2,
      subscriptions: [
        {
          resource: { kind: "github_repo", repo: "dummy-org/dummy-repo" },
          actorId: "child-worker",
          subscribedBy: rootId,
          subscribedAt: "2026-01-01T00:00:00Z",
        },
        {
          resource: {
            kind: "github_branch",
            repo: "dummy-org/dummy-repo",
            ref: "refs/heads/staging",
          },
          actorId: "deploy-worker",
          subscribedBy: rootId,
          subscribedAt: "2026-01-01T00:00:00Z",
        },
        {
          resource: { kind: "chat_space", space: "spaces/ALERT" },
          actorId: "chat-worker",
          subscribedBy: rootId,
          subscribedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });

    expect(document.rejections).toEqual([]);
    expect(document.subscriptions.map((row) => row.resource)).toEqual([
      "github:dummy-org/dummy-repo",
      "github:dummy-org/dummy-repo/branches/staging",
      "gchat:spaces/ALERT",
    ]);
  });

  it("drops an unversioned document's config-implied root rows and keeps explicit ones", () => {
    const document = parse({
      subscriptions: [
        {
          resource: { kind: "github_org", org: "dummy-org" },
          actorId: rootId,
          subscribedBy: rootId,
          subscribedAt: "2025-01-01T00:00:00Z",
        },
        {
          resource: { kind: "github_repo", repo: "dummy-org/dummy-repo" },
          actorId: ACTOR_A,
          subscribedBy: rootId,
          subscribedAt: "2025-01-01T00:00:00Z",
        },
      ],
    });

    expect(document.rejections).toEqual([]);
    expect(document.subscriptions).toEqual([
      expect.objectContaining({ resource: REPO, actorId: ACTOR_A }),
    ]);
  });
});

describe("missingAuditedEventSubscriptions", () => {
  it("reports only audit-confirmed active rows missing from the durable store", () => {
    const store = new InMemoryEventSubscriptionStore();
    store.subscribe(sub({ resource: OTHER, actorId: ACTOR_B }));

    expect(
      missingAuditedEventSubscriptions(store, [
        { kind: "event_source_subscribed", actorId: ACTOR_A, detail: REPO },
        { kind: "event_source_subscribed", actorId: ACTOR_B, detail: OTHER },
      ])
    ).toEqual([{ resource: REPO, actorId: ACTOR_A }]);
  });

  it("treats a later unsubscribe as settled and an empty audit stream as unknown", () => {
    const store = new InMemoryEventSubscriptionStore();
    expect(
      missingAuditedEventSubscriptions(store, [
        { kind: "event_source_subscribed", actorId: ACTOR_A, detail: REPO },
        { kind: "event_source_unsubscribed", actorId: ACTOR_A, detail: REPO },
      ])
    ).toEqual([]);
    expect(missingAuditedEventSubscriptions(store, [])).toEqual([]);
  });
});

describe("reconcileEventSources", () => {
  const rootOrg = "github:dummy-org";
  const chat = "gchat:spaces";
  const system = "system:events";
  const removedOrg = "github:Old-Org";
  const rootId = "root";

  it("seeds configured root sources and is idempotent across reboots", () => {
    const store = new InMemoryEventSubscriptionStore();
    const now = () => "2026-07-02T00:00:00Z";

    const first = reconcileEventSources(store, [rootOrg, chat], rootId, now);
    const second = reconcileEventSources(store, [rootOrg, chat], rootId, now);

    expect(first.droppedDelegations).toEqual([]);
    expect(second.droppedDelegations).toEqual([]);
    expect(first.store.list()).toHaveLength(2);
    expect(first.store.activeForResource(rootOrg)[0]).toMatchObject({
      actorId: "root",
      subscribedBy: "root",
    });
    expect(first.store.activeForResource(chat)[0]).toMatchObject({
      actorId: "root",
      subscribedBy: "root",
    });
  });

  it("seeds and reconciles the system family as a config-owned root source", () => {
    const store = new InMemoryEventSubscriptionStore();
    const now = () => "2026-07-02T00:00:00Z";

    const first = reconcileEventSources(store, [system], rootId, now);
    expect(first.store.activeForResource(system)[0]?.actorId).toBe("root");

    const second = reconcileEventSources(store, [], rootId, now);
    expect(second.droppedDelegations).toEqual([]);
    expect(second.store.activeForResource(system)).toEqual([]);
  });

  // A delegation disappearing across a restart reads like lost state, and is
  // not: reconciliation prunes exactly what config no longer reaches. These two
  // pin the rule from the surviving side, which had no coverage — narrowing
  // config to drop a delegation is tested above, keeping one is not.
  it("keeps a delegation of a repo under a still-configured org", () => {
    const store = new InMemoryEventSubscriptionStore();
    const repo = "github:dummy-org/dummy-repo";
    store.subscribe(sub({ resource: repo, actorId: "child", subscribedBy: "root" }));

    const result = reconcileEventSources(store, [rootOrg], rootId, () => "2026-07-02T00:00:00Z");

    expect(result.droppedDelegations).toEqual([]);
    expect(result.store.activeForResource(repo).map((s) => s.actorId)).toEqual(["child"]);
    // The org above it still seeds to root, so the delegation narrows rather
    // than replaces: repo events reach the child, org-wide ones still reach root.
    expect(result.store.activeForResource(rootOrg).map((s) => s.actorId)).toEqual(["root"]);
  });

  it("lets a delegation of a configured repo outrank the implied root seed", () => {
    const store = new InMemoryEventSubscriptionStore();
    const repo = "github:dummy-org/dummy-repo";
    store.subscribe(sub({ resource: repo, actorId: "child", subscribedBy: "root" }));

    // Same resource on both sides of the union: config implies root, the
    // persistent store records the delegation away from it. Restart must not
    // hand the repo back to root.
    const result = reconcileEventSources(store, [repo], rootId, () => "2026-07-02T00:00:00Z");

    expect(result.droppedDelegations).toEqual([]);
    expect(result.store.activeForResource(repo).map((s) => s.actorId)).toEqual(["child"]);
  });

  it("drops orphaned delegations in the persistent store", () => {
    const store = new InMemoryEventSubscriptionStore();
    store.subscribe(sub({ resource: removedOrg, actorId: "child", subscribedBy: "root" }));
    store.subscribe(
      sub({
        resource: "github:Old-Org/dummy-repo",
        actorId: "child",
        subscribedBy: "root",
      })
    );
    store.subscribe(
      sub({
        resource: "github:dummy-org/dummy-repo/pulls/616",
        actorId: "root",
        subscribedBy: "root",
      })
    );

    const result = reconcileEventSources(store, [rootOrg], rootId, () => "2026-07-02T00:00:00Z");

    expect(result.droppedDelegations.map((s) => s.resource)).toEqual([
      "github:Old-Org",
      "github:Old-Org/dummy-repo",
    ]);
    expect(result.store.activeForResource(removedOrg)).toEqual([]);
    expect(result.store.activeForResource(rootOrg)).toHaveLength(1);
    expect(result.store.activeForResource("github:dummy-org/dummy-repo/pulls/616")).toHaveLength(1);
  });

  it("seeds a configured github_repo source and drops orphaned delegations", () => {
    const store = new InMemoryEventSubscriptionStore();
    const reclaimed = "github:dummy-org/reclaimed";
    store.subscribe(sub({ resource: reclaimed, actorId: "root", subscribedBy: "root" }));
    const legacyBranch = "github:dummy-org/deploy/branches/master";
    store.subscribe(sub({ resource: legacyBranch, actorId: "root", subscribedBy: "root" }));

    // New config: subscribe root to the test-bed repo only, dropping the org.
    const testBed = "github:dummy-org/dummy-repo-test-bed";
    const result = reconcileEventSources(store, [testBed], rootId, () => "2026-07-02T00:00:00Z");

    expect(result.droppedDelegations.map((s) => s.resource)).toEqual([reclaimed, legacyBranch]);
    expect(result.store.activeForResource(rootOrg)).toEqual([]);
    // The configured repo is seeded.
    expect(result.store.activeForResource(testBed)).toHaveLength(1);
    expect(result.store.activeForResource(reclaimed)).toEqual([]);
    expect(result.store.activeForResource(legacyBranch)).toEqual([]);
  });

  it("drops removed chat_space active delegations", () => {
    const store = new InMemoryEventSubscriptionStore();
    const keptSpace = "gchat:spaces/KEPT";
    const removedSpace = "gchat:spaces/REMOVED";
    const childSpace = "gchat:spaces/CHILD";

    store.subscribe(sub({ resource: removedSpace, actorId: "child", subscribedBy: "root" }));
    store.subscribe(sub({ resource: childSpace, actorId: "child-1", subscribedBy: "root" }));

    const result = reconcileEventSources(
      store,
      [keptSpace, childSpace],
      rootId,
      () => "2026-07-02T00:00:00Z"
    );

    expect(result.droppedDelegations.map((s) => s.resource)).toEqual([removedSpace]);
    expect(result.store.activeForResource(removedSpace)).toEqual([]);
    // keptSpace is present in configured → remains active
    expect(result.store.activeForResource(keptSpace)).toHaveLength(1);
    // childSpace is explicitly in configured and subscribed by child-1 → untouched
    expect(result.store.activeForResource(childSpace)).toHaveLength(1);
  });
});

describe("UnionEventSubscriptionStore and implied persistence", () => {
  // Durability of these outcomes across a restart is pinned on the SQLite store
  // (event-subscription-repository.test.ts); what is fixed here is the union
  // rule itself — which side of the union wins for a given resource.
  it("suppresses the config-implied row once the explicit store holds a tombstone", () => {
    const rootOrg = "github:dummy-org";
    const rootId = "root";
    const explicit = new InMemoryEventSubscriptionStore();

    const sync = reconcileEventSources(explicit, [rootOrg], rootId, () => "2026-01-01T00:00:00Z");
    expect(sync.store.activeForResource(rootOrg)).toHaveLength(1);

    // Unsubscribing writes a tombstone to the explicit store, which outranks
    // the implied seed config keeps re-deriving.
    sync.store.unsubscribe(rootOrg, rootId, "2026-02-01T00:00:00Z");
    expect(sync.store.activeForResource(rootOrg)).toEqual([]);
    expect(explicit.list()).toEqual([
      expect.objectContaining({ actorId: rootId, unsubscribedAt: "2026-02-01T00:00:00Z" }),
    ]);

    // A later boot re-derives the same implied seed and stays suppressed.
    const rebooted = reconcileEventSources(
      explicit,
      [rootOrg],
      rootId,
      () => "2026-03-01T00:00:00Z"
    );
    expect(rebooted.store.activeForResource(rootOrg)).toEqual([]);
  });

  it("keeps the implied row out of the explicit store entirely", () => {
    const rootOrg = "github:dummy-org";
    const rootId = "root";
    const explicit = new InMemoryEventSubscriptionStore();

    const sync = reconcileEventSources(explicit, [rootOrg], rootId, () => "2026-01-01T00:00:00Z");

    expect(sync.store.activeForResource(rootOrg)).toHaveLength(1);
    expect(explicit.list()).toEqual([]);
  });
});

describe("Event Resource Primitives with Reference Grammar", () => {
  const org = "github:dummy-org";
  const repo = "github:dummy-org/dummy-repo";
  const issue = "github:dummy-org/dummy-repo/issues/123";
  const pr = "github:dummy-org/dummy-repo/pulls/456";
  const branch = "github:dummy-org/dummy-repo/branches/staging";
  const chatSpace = "gchat:spaces/123";
  const chatMessage = "gchat:spaces/123/messages/456";
  const system = "system:events";
  const diskAlert = "system:events/alerts/disk";

  const otherOrg = "github:Other-Org";
  const otherRepo = "github:Other-Org/dummy-repo";
  const otherIssue = "github:Other-Org/dummy-repo/issues/123";
  const otherBranch = "github:dummy-org/dummy-repo/branches/master";

  describe("parentOf", () => {
    it("resolves parent of issue/pr/branch to repo", () => {
      expect(parentOf(issue)).toBe(repo);
      expect(parentOf(pr)).toBe(repo);
      expect(parentOf(branch)).toBe(repo);
    });

    it("resolves parent of repo to org", () => {
      expect(parentOf(repo)).toBe(org);
    });

    it("resolves parent of org to undefined", () => {
      expect(parentOf(org)).toBeUndefined();
    });

    it("resolves parent of chat message to chat space", () => {
      expect(parentOf(chatMessage)).toBe(chatSpace);
    });

    it("resolves parent of root system events to undefined", () => {
      expect(parentOf(system)).toBeUndefined();
    });

    it("resolves parent of nested system alerts to system events", () => {
      expect(parentOf(diskAlert)).toBe(system);
    });
  });

  describe("resourceKey", () => {
    it("returns canonical keys while the migration boundary accepts a legacy object", () => {
      expect(resourceKey(chatSpace)).toBe("gchat:spaces/123");
      expect(resourceKey(system)).toBe("system:events");
      expect(normalizeEventResource({ kind: "github_issue", repo: "o/r", number: 42 })).toBe(
        "github:o/r/issues/42"
      );
      expect(() => normalizeEventResource("not-a-reference")).toThrow(/<scheme>:<path>/);
      expect(normalizeEventResource("github:o/r/branches/feature%2fchild")).toBe(
        "github:o/r/branches/feature%2Fchild"
      );
      expect(normalizeEventResource("github:o/r/branches/refs%2Fheads%2Ffeature%2Fchild")).toBe(
        "github:o/r/branches/feature%2Fchild"
      );
    });
  });

  describe("sameResource", () => {
    it("returns true for same chat_space", () => {
      expect(sameResource(chatSpace, chatSpace)).toBe(true);
      expect(sameResource(chatSpace, "gchat:spaces/123")).toBe(true);
    });

    it("returns false for different chat_spaces", () => {
      expect(sameResource(chatSpace, "gchat:spaces/456")).toBe(false);
    });
  });

  describe("isSubResourceOf", () => {
    it("returns true for identical resources (inclusive containment)", () => {
      expect(isSubResourceOf(org, org)).toBe(true);
      expect(isSubResourceOf(repo, repo)).toBe(true);
      expect(isSubResourceOf(issue, issue)).toBe(true);
      expect(isSubResourceOf(pr, pr)).toBe(true);
      expect(isSubResourceOf(branch, branch)).toBe(true);
      expect(isSubResourceOf(chatSpace, chatSpace)).toBe(true);
    });

    it("returns true for ancestors (strict containment)", () => {
      expect(isSubResourceOf(repo, org)).toBe(true);
      expect(isSubResourceOf(issue, repo)).toBe(true);
      expect(isSubResourceOf(issue, org)).toBe(true);
      expect(isSubResourceOf(pr, repo)).toBe(true);
      expect(isSubResourceOf(pr, org)).toBe(true);
      expect(isSubResourceOf(branch, repo)).toBe(true);
      expect(isSubResourceOf(branch, org)).toBe(true);
      expect(isSubResourceOf(chatMessage, chatSpace)).toBe(true);
      expect(isSubResourceOf(diskAlert, system)).toBe(true);
    });

    it("returns false for descendants", () => {
      expect(isSubResourceOf(org, repo)).toBe(false);
      expect(isSubResourceOf(org, issue)).toBe(false);
      expect(isSubResourceOf(repo, issue)).toBe(false);
    });

    it("returns false for siblings and unrelated resources", () => {
      expect(isSubResourceOf(pr, issue)).toBe(false);
      expect(isSubResourceOf(issue, pr)).toBe(false);
      expect(isSubResourceOf(branch, issue)).toBe(false);
      expect(isSubResourceOf(branch, otherBranch)).toBe(false);
      expect(isSubResourceOf(otherOrg, org)).toBe(false);
      expect(isSubResourceOf(otherRepo, repo)).toBe(false);
      expect(isSubResourceOf(otherIssue, issue)).toBe(false);
      expect(isSubResourceOf(issue, otherRepo)).toBe(false);
      expect(isSubResourceOf(branch, otherRepo)).toBe(false);
    });
  });

  describe("isStrictSubResourceOf", () => {
    it("accepts only proper descendants", () => {
      expect(isStrictSubResourceOf(issue, repo)).toBe(true);
      expect(isStrictSubResourceOf(pr, repo)).toBe(true);
      expect(isStrictSubResourceOf(branch, repo)).toBe(true);
      expect(isStrictSubResourceOf(repo, org)).toBe(true);
      expect(isStrictSubResourceOf(repo, repo)).toBe(false);
      expect(isStrictSubResourceOf(repo, issue)).toBe(false);
      expect(isStrictSubResourceOf(pr, issue)).toBe(false);
      expect(isStrictSubResourceOf(branch, repo)).toBe(true);
    });
  });
});
