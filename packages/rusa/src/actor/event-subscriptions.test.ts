import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testEventSubscriptionStoreContract } from "./event-subscription-store.contract.js";
import {
  type EventResource,
  type EventSubscription,
  FileEventSubscriptionStore,
  InMemoryEventSubscriptionStore,
  isStrictSubResourceOf,
  isSubResourceOf,
  missingAuditedEventSubscriptions,
  normalizeEventResource,
  parentOf,
  reconcileEventSources,
  resourceKey,
  sameResource,
} from "./event-subscriptions.js";

const contractDirectories: string[] = [];
afterAll(() => {
  for (const directory of contractDirectories) rmSync(directory, { recursive: true, force: true });
});

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
// the file store and the SQLite store are held to the same rules.
testEventSubscriptionStoreContract(
  "InMemoryEventSubscriptionStore",
  () => new InMemoryEventSubscriptionStore()
);

testEventSubscriptionStoreContract("FileEventSubscriptionStore", () => {
  const directory = mkdtempSync(join(tmpdir(), "eventsubs-contract-"));
  contractDirectories.push(directory);
  return new FileEventSubscriptionStore(join(directory, "event-subscriptions.json"), "root");
});

describe("FileEventSubscriptionStore", () => {
  let dir: string;
  let file: string;
  const rootId = "root";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eventsubs-"));
    file = join(dir, "event-subscriptions.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists subscriptions across instances (reload round-trips)", () => {
    const a = new FileEventSubscriptionStore(file, rootId);
    a.subscribe(sub());
    const b = new FileEventSubscriptionStore(file, rootId);
    expect(b.activeForResource(REPO).map((s) => s.actorId)).toEqual([ACTOR_A]);
  });

  it("persists unsubscriptions across instances (active + inactive survives reload)", () => {
    const a = new FileEventSubscriptionStore(file, rootId);
    a.subscribe(sub({ resource: REPO, actorId: ACTOR_A }));
    a.subscribe(sub({ resource: OTHER, actorId: ACTOR_B }));
    a.unsubscribe(OTHER, ACTOR_B, "2026-06-28T00:00:00Z");

    const b = new FileEventSubscriptionStore(file, rootId);
    expect(b.activeForResource(REPO).map((s) => s.actorId)).toEqual([ACTOR_A]);
    expect(b.activeForResource(OTHER)).toEqual([]);
    expect(b.list()).toHaveLength(2);
    expect(b.list().find((s) => s.actorId === ACTOR_B)?.unsubscribedAt).toBe(
      "2026-06-28T00:00:00Z"
    );
  });

  it("preserves the one-active-subscriber invariant across reload", () => {
    const a = new FileEventSubscriptionStore(file, rootId);
    a.subscribe(sub({ actorId: ACTOR_A }));
    const b = new FileEventSubscriptionStore(file, rootId);
    expect(() => b.subscribe(sub({ actorId: ACTOR_B }))).toThrow(
      /already has an active subscriber/
    );
  });

  it("starts empty when the file is missing", () => {
    const store = new FileEventSubscriptionStore(join(dir, "does-not-exist.json"), rootId);
    expect(store.list()).toEqual([]);
  });

  it("fails loudly instead of accepting an empty store when the file is corrupt JSON", () => {
    writeFileSync(file, "{ this is not valid json ]");
    expect(() => new FileEventSubscriptionStore(file, rootId)).toThrow(
      /invalid event subscription file/
    );
    expect(readFileSync(file, "utf8")).toBe("{ this is not valid json ]");
  });

  it("preserves the prior snapshot when atomic replacement fails", () => {
    const seed = new FileEventSubscriptionStore(file, rootId);
    seed.subscribe(sub());
    const priorSnapshot = readFileSync(file, "utf8");
    const replaceFile = vi.fn(() => {
      throw new Error("injected rename failure");
    });
    const store = new FileEventSubscriptionStore(file, rootId, () => {}, replaceFile);

    expect(() => store.subscribe(sub({ resource: OTHER, actorId: ACTOR_B }))).toThrow(
      /injected rename failure/
    );
    expect(readFileSync(file, "utf8")).toBe(priorSnapshot);
    expect(store.list()).toEqual([expect.objectContaining({ actorId: ACTOR_A })]);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("writes snapshots through a same-directory temporary file without leftovers", () => {
    const store = new FileEventSubscriptionStore(file, rootId);
    store.subscribe(sub());

    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      version: 3,
      subscriptions: [expect.objectContaining({ actorId: ACTOR_A })],
    });
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("isolates malformed and conflicting rows while retaining later valid rows", () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 3,
        subscriptions: [
          sub({ actorId: ACTOR_A }),
          {
            ...sub({
              resource: "github_repo:dummy-org/dummy-repo",
              actorId: ACTOR_B,
              subscribedAt: "2026-06-29T00:00:00Z",
            }),
          },
          { ...sub({ resource: OTHER, actorId: "" }) },
          sub({ resource: OTHER, actorId: ACTOR_B }),
        ],
      })
    );
    const warnings: string[] = [];
    const store = new FileEventSubscriptionStore(file, rootId, (message) => warnings.push(message));

    expect(store.activeForResource(REPO).map((row) => row.actorId)).toEqual([ACTOR_B]);
    expect(store.activeForResource(OTHER).map((row) => row.actorId)).toEqual([ACTOR_B]);
    expect(
      warnings.filter((message) => message.includes("skipped event subscription row"))
    ).toHaveLength(2);
    expect(warnings).toHaveLength(3);
    expect(warnings.at(-1)).toContain("preserved 2 rejected");
  });

  it("quarantines rejected evidence before a later reconciliation rewrites the source", () => {
    const original = JSON.stringify({
      version: 3,
      subscriptions: [sub({ actorId: ACTOR_A }), { resource: REPO, actorId: "" }],
    });
    writeFileSync(file, original);
    const store = new FileEventSubscriptionStore(file, rootId, () => {});
    const recovery = readdirSync(dir).find((name) => name.includes(".rejected-"));

    expect(recovery).toBeDefined();
    expect(readFileSync(join(dir, recovery as string), "utf8")).toBe(original);

    reconcileEventSources(store, [OTHER], rootId, () => "2026-06-29T00:00:00Z");

    expect(readFileSync(join(dir, recovery as string), "utf8")).toBe(original);
    expect(readFileSync(file, "utf8")).not.toBe(original);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 3 });
  });

  it("chooses the most recent active subscriber independently of file order", () => {
    const older = sub({ actorId: ACTOR_A, subscribedAt: "2026-06-27T00:00:00Z" });
    const newer = sub({ actorId: ACTOR_B, subscribedAt: "2026-06-29T00:00:00Z" });

    for (const subscriptions of [
      [older, newer],
      [newer, older],
    ]) {
      writeFileSync(file, JSON.stringify({ version: 3, subscriptions }));
      const store = new FileEventSubscriptionStore(file, rootId, () => {});
      expect(store.activeForResource(REPO).map((row) => row.actorId)).toEqual([ACTOR_B]);
    }
  });

  it("rejects invalid timestamps instead of letting them outrank valid rows", () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 3,
        subscriptions: [
          sub({ actorId: ACTOR_A, subscribedAt: "zzz" }),
          sub({ actorId: ACTOR_B, subscribedAt: "2026-06-29T00:00:00Z" }),
        ],
      })
    );
    const warnings: string[] = [];
    const store = new FileEventSubscriptionStore(file, rootId, (message) => warnings.push(message));

    expect(store.activeForResource(REPO).map((row) => row.actorId)).toEqual([ACTOR_B]);
    expect(warnings.some((message) => message.includes("valid timestamp"))).toBe(true);
  });

  it("rejects tied active owners independently of file order", () => {
    const utc = sub({ actorId: ACTOR_A, subscribedAt: "2026-06-27T00:00:00Z" });
    const offset = sub({ actorId: ACTOR_B, subscribedAt: "2026-06-26T20:00:00-04:00" });

    for (const subscriptions of [
      [utc, offset],
      [offset, utc],
    ]) {
      writeFileSync(file, JSON.stringify({ version: 3, subscriptions }));
      const store = new FileEventSubscriptionStore(file, rootId, () => {});
      expect(store.activeForResource(REPO)).toEqual([]);
    }
  });

  it("resolves a normalized active/tombstone pair by its latest transition", () => {
    const active = sub({
      resource: "github_repo:dummy-org/dummy-repo",
      actorId: ACTOR_A,
      subscribedAt: "2026-06-27T00:00:00Z",
    });
    const tombstone = sub({
      actorId: ACTOR_A,
      subscribedAt: "2026-06-27T00:00:00Z",
      unsubscribedAt: "2026-06-28T00:00:00Z",
    });

    for (const subscriptions of [
      [active, tombstone],
      [tombstone, active],
    ]) {
      writeFileSync(file, JSON.stringify({ version: 3, subscriptions }));
      const store = new FileEventSubscriptionStore(file, rootId, () => {});
      expect(store.activeForResource(REPO)).toEqual([]);
      expect(store.list()).toEqual([
        expect.objectContaining({ unsubscribedAt: "2026-06-28T00:00:00Z" }),
      ]);
    }
  });

  it("loads an inactive row without tripping over an earlier active holder", () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 3,
        subscriptions: [
          sub({ actorId: ACTOR_A }),
          sub({
            actorId: ACTOR_B,
            unsubscribedAt: "2026-06-28T00:00:00Z",
          }),
        ],
      })
    );
    const store = new FileEventSubscriptionStore(file, rootId);

    expect(store.list()).toHaveLength(2);
    expect(store.activeForResource(REPO).map((row) => row.actorId)).toEqual([ACTOR_A]);
  });

  it("the conflict guard throws before mutating (File store)", () => {
    const store = new FileEventSubscriptionStore(file, rootId);
    store.subscribe(sub({ actorId: ACTOR_A }));
    expect(() => store.subscribe(sub({ actorId: ACTOR_B }))).toThrow();
    expect(store.list()).toHaveLength(1);
    // A reload sees only the first subscriber.
    const reloaded = new FileEventSubscriptionStore(file, rootId);
    expect(reloaded.activeForResource(REPO).map((s) => s.actorId)).toEqual([ACTOR_A]);
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
  it("shows an implied-only row disappears immediately and stays suppressed after reloading the v2/v3 file", () => {
    const file = join(tmpdir(), `event-subs-test-legacy-${Date.now()}.json`);
    const rootOrg = "github:dummy-org";
    const rootId = "root";

    // Legacy file with no version and an implied-only row
    writeFileSync(
      file,
      JSON.stringify({
        subscriptions: [
          {
            resource: { kind: "github_org", org: "dummy-org" },
            actorId: rootId,
            subscribedBy: rootId,
            subscribedAt: "2025-01-01T00:00:00Z",
          },
        ],
      })
    );

    // Boot 1: The file is unversioned, so it should run the migration, drop the row, and immediately flush version: 3
    let sync = reconcileEventSources(
      new FileEventSubscriptionStore(file, rootId),
      [rootOrg],
      rootId,
      () => "2026-01-01T00:00:00Z"
    );

    // It is active because it's implied by config
    expect(sync.store.activeForResource(rootOrg)).toHaveLength(1);

    // But it has disappeared immediately from the persistent file
    let saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.version).toBe(3);
    expect(saved.subscriptions).toEqual([]);

    // Boot 2: Reloading the v3 file. The implied row stays suppressed from disk.
    sync = reconcileEventSources(
      new FileEventSubscriptionStore(file, rootId),
      [rootOrg],
      rootId,
      () => "2026-02-01T00:00:00Z"
    );

    expect(sync.store.activeForResource(rootOrg)).toHaveLength(1);
    saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.subscriptions).toEqual([]);
  });

  it("migrates version 2 legacy object subscriptions to version 3 canonical reference strings", () => {
    const file = join(tmpdir(), `event-subs-test-v2-migration-${Date.now()}.json`);
    const rootId = "root";

    // Version 2 file with legacy object resources
    writeFileSync(
      file,
      JSON.stringify({
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
      })
    );

    const store = new FileEventSubscriptionStore(file, rootId);
    expect(store.activeForResource("github:dummy-org/dummy-repo").map((s) => s.actorId)).toEqual([
      "child-worker",
    ]);
    expect(
      store.activeForResource("github:dummy-org/dummy-repo/branches/staging").map((s) => s.actorId)
    ).toEqual(["deploy-worker"]);
    expect(store.activeForResource("gchat:spaces/ALERT").map((s) => s.actorId)).toEqual([
      "chat-worker",
    ]);

    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.version).toBe(3);
    expect(saved.subscriptions).toEqual([
      expect.objectContaining({
        resource: "github:dummy-org/dummy-repo",
        actorId: "child-worker",
      }),
      expect.objectContaining({
        resource: "github:dummy-org/dummy-repo/branches/staging",
        actorId: "deploy-worker",
      }),
      expect.objectContaining({
        resource: "gchat:spaces/ALERT",
        actorId: "chat-worker",
      }),
    ]);
  });

  it("loads valid legacy rows but leaves the source file untouched when another row is rejected", () => {
    const file = join(tmpdir(), `event-subs-test-invalid-${Date.now()}.json`);
    const rootId = "root";
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        subscriptions: [
          {
            resource: "not-a-reference",
            actorId: "invalid-worker",
            subscribedBy: rootId,
            subscribedAt: "2026-01-01T00:00:00Z",
          },
          {
            resource: { kind: "github_repo", repo: "dummy-org/dummy-repo" },
            actorId: "valid-worker",
            subscribedBy: rootId,
            subscribedAt: "2026-01-01T00:00:00Z",
          },
        ],
      })
    );

    const original = readFileSync(file, "utf8");
    const store = new FileEventSubscriptionStore(file, rootId, () => undefined);
    expect(store.list().map((subscription) => subscription.actorId)).toEqual(["valid-worker"]);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("locks the existing same-key inactive-collision behavior", () => {
    const file = join(tmpdir(), `event-subs-test-tombstone-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ version: 3, subscriptions: [] }));
    const rootOrg = "github:dummy-org";
    const rootId = "root";

    let sync = reconcileEventSources(
      new FileEventSubscriptionStore(file, rootId),
      [rootOrg],
      rootId,
      () => "2026-01-01T00:00:00Z"
    );

    // Active via baseStore
    expect(sync.store.activeForResource(rootOrg)).toHaveLength(1);

    // Explicitly unsubscribe. This should write a tombstone to the file.
    sync.store.unsubscribe(rootOrg, rootId, "2026-02-01T00:00:00Z");

    // The union store correctly hides the base active row
    expect(sync.store.activeForResource(rootOrg)).toEqual([]);

    // The tombstone is saved to disk
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.subscriptions).toHaveLength(1);
    expect(saved.subscriptions[0].unsubscribedAt).toBe("2026-02-01T00:00:00Z");

    // Boot 2: Reloading the v3 file
    sync = reconcileEventSources(
      new FileEventSubscriptionStore(file, rootId),
      [rootOrg],
      rootId,
      () => "2026-03-01T00:00:00Z"
    );

    // The tombstone continues to suppress the implied config row
    expect(sync.store.activeForResource(rootOrg)).toEqual([]);
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
