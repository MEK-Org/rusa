import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EventResource,
  type EventSubscription,
  FileEventSubscriptionStore,
  InMemoryEventSubscriptionStore,
  isStrictSubResourceOf,
  isSubResourceOf,
  parentOf,
  reconcileEventSources,
  resourceKey,
  sameResource,
} from "./event-subscriptions.js";

const REPO = { kind: "github_repo", repo: "dummy-org/dummy-repo" } as const;
const OTHER = { kind: "github_repo", repo: "dummy-org/other" } as const;
const ACTOR_A = "actor-thread-a";
const ACTOR_B = "actor-thread-b";

const sub = (over: Partial<EventSubscription> = {}): EventSubscription => ({
  resource: REPO,
  actorId: ACTOR_A,
  subscribedBy: "root",
  subscribedAt: "2026-06-27T00:00:00Z",
  ...over,
});

describe("InMemoryEventSubscriptionStore", () => {
  it("subscribes an actor and reports it active for the resource", () => {
    const store = new InMemoryEventSubscriptionStore();
    store.subscribe(sub());
    const active = store.activeForResource(REPO);
    expect(active).toHaveLength(1);
    expect(active[0]?.actorId).toBe(ACTOR_A);
    expect(store.activeForResource(OTHER)).toEqual([]);
  });

  it("is idempotent per (resource, actorId) — re-subscribe does not duplicate", () => {
    const store = new InMemoryEventSubscriptionStore();
    store.subscribe(sub());
    store.subscribe(sub({ subscribedAt: "2026-06-28T00:00:00Z" }));
    expect(store.list()).toHaveLength(1);
    expect(store.activeForResource(REPO)).toHaveLength(1);
  });

  it("re-subscribing the same actor clears a prior unsubscribedAt (reactivates)", () => {
    const store = new InMemoryEventSubscriptionStore();
    store.subscribe(sub());
    store.unsubscribe(REPO, ACTOR_A, "2026-06-28T00:00:00Z");
    expect(store.activeForResource(REPO)).toEqual([]);

    store.subscribe(sub({ subscribedAt: "2026-06-29T00:00:00Z" }));
    expect(store.activeForResource(REPO)).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.unsubscribedAt).toBeUndefined();
  });

  it("unsubscribe marks the row inactive but keeps it in the audit list", () => {
    const store = new InMemoryEventSubscriptionStore();
    store.subscribe(sub());
    store.unsubscribe(REPO, ACTOR_A, "2026-06-28T00:00:00Z");
    expect(store.activeForResource(REPO)).toEqual([]);
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.unsubscribedAt).toBe("2026-06-28T00:00:00Z");
  });

  it("list() returns both active and inactive subscriptions", () => {
    const store = new InMemoryEventSubscriptionStore();
    store.subscribe(sub({ resource: REPO, actorId: ACTOR_A }));
    store.subscribe(sub({ resource: OTHER, actorId: ACTOR_B }));
    store.unsubscribe(OTHER, ACTOR_B, "2026-06-28T00:00:00Z");
    expect(store.list()).toHaveLength(2);
    expect(store.activeForResource(REPO)).toHaveLength(1);
    expect(store.activeForResource(OTHER)).toEqual([]);
  });

  it("unsubscribing an unknown subscription is a no-op", () => {
    const store = new InMemoryEventSubscriptionStore();
    store.unsubscribe(REPO, "nobody", "2026-06-28T00:00:00Z");
    expect(store.list()).toEqual([]);
  });

  describe("one active subscriber per resource", () => {
    it("throws when a different actor is already actively subscribed", () => {
      const store = new InMemoryEventSubscriptionStore();
      store.subscribe(sub({ actorId: ACTOR_A }));
      expect(() => store.subscribe(sub({ actorId: ACTOR_B }))).toThrow(/dummy-org\/dummy-repo/);
      expect(() => store.subscribe(sub({ actorId: ACTOR_B }))).toThrow(ACTOR_A);
      // The conflicting subscribe did not land.
      expect(store.activeForResource(REPO).map((s) => s.actorId)).toEqual([ACTOR_A]);
      expect(store.list()).toHaveLength(1);
    });

    it("same-actor re-subscribe stays idempotent (no throw)", () => {
      const store = new InMemoryEventSubscriptionStore();
      store.subscribe(sub({ actorId: ACTOR_A }));
      expect(() => store.subscribe(sub({ actorId: ACTOR_A }))).not.toThrow();
      expect(store.list()).toHaveLength(1);
    });

    it("a new actor can subscribe after the prior holder unsubscribes", () => {
      const store = new InMemoryEventSubscriptionStore();
      store.subscribe(sub({ actorId: ACTOR_A }));
      store.unsubscribe(REPO, ACTOR_A, "2026-06-28T00:00:00Z");
      expect(() => store.subscribe(sub({ actorId: ACTOR_B }))).not.toThrow();
      expect(store.activeForResource(REPO).map((s) => s.actorId)).toEqual([ACTOR_B]);
      // The prior holder's row survives for audit.
      expect(store.list()).toHaveLength(2);
    });

    it("different resources are independent", () => {
      const store = new InMemoryEventSubscriptionStore();
      store.subscribe(sub({ resource: REPO, actorId: ACTOR_A }));
      expect(() => store.subscribe(sub({ resource: OTHER, actorId: ACTOR_B }))).not.toThrow();
      expect(store.activeForResource(REPO).map((s) => s.actorId)).toEqual([ACTOR_A]);
      expect(store.activeForResource(OTHER).map((s) => s.actorId)).toEqual([ACTOR_B]);
    });
  });
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

  it("starts empty (no crash) when the file is corrupt JSON", () => {
    writeFileSync(file, "{ this is not valid json ]");
    const store = new FileEventSubscriptionStore(file, rootId);
    expect(store.list()).toEqual([]);
    // …and remains usable.
    store.subscribe(sub());
    expect(store.activeForResource(REPO)).toHaveLength(1);
  });

  it("keeps in-memory state authoritative when the disk write fails", () => {
    // Point the store at a path whose parent is a *file*, not a directory, so
    // every writeFileSync throws (ENOTDIR) — the flush is swallowed best-effort.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const store = new FileEventSubscriptionStore(join(blocker, "event-subscriptions.json"), rootId);
    expect(() => store.subscribe(sub())).not.toThrow();
    // In-memory copy is authoritative for the process despite the failed write.
    expect(store.activeForResource(REPO).map((s) => s.actorId)).toEqual([ACTOR_A]);
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

describe("reconcileEventSources", () => {
  const rootOrg = { kind: "github_org", org: "dummy-org" } as const;
  const chat = { kind: "chat" } as const;
  const system = { kind: "system" } as const;
  const removedOrg = { kind: "github_org", org: "Old-Org" } as const;
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

  it("drops orphaned delegations in the persistent store", () => {
    const store = new InMemoryEventSubscriptionStore();
    store.subscribe(sub({ resource: removedOrg, actorId: "child", subscribedBy: "root" }));
    store.subscribe(
      sub({
        resource: { kind: "github_repo", repo: "Old-Org/dummy-repo" },
        actorId: "child",
        subscribedBy: "root",
      })
    );
    store.subscribe(
      sub({
        resource: { kind: "github_pr", repo: "dummy-org/dummy-repo", number: 616 },
        actorId: "root",
        subscribedBy: "root",
      })
    );

    const result = reconcileEventSources(store, [rootOrg], rootId, () => "2026-07-02T00:00:00Z");

    expect(result.droppedDelegations.map((s) => s.resource)).toEqual([
      removedOrg,
      { kind: "github_repo", repo: "Old-Org/dummy-repo" },
    ]);
    expect(result.store.activeForResource(removedOrg)).toEqual([]);
    expect(result.store.activeForResource(rootOrg)).toHaveLength(1);
    expect(
      result.store.activeForResource({
        kind: "github_pr",
        repo: "dummy-org/dummy-repo",
        number: 616,
      })
    ).toHaveLength(1);
  });

  it("seeds a configured github_repo source and drops orphaned delegations", () => {
    const store = new InMemoryEventSubscriptionStore();
    const reclaimed = { kind: "github_repo", repo: "dummy-org/reclaimed" } as const;
    store.subscribe(sub({ resource: reclaimed, actorId: "root", subscribedBy: "root" }));
    const legacyBranch = {
      kind: "github_branch",
      repo: "dummy-org/deploy",
      ref: "refs/heads/master",
    } as const;
    store.subscribe(sub({ resource: legacyBranch, actorId: "root", subscribedBy: "root" }));

    // New config: subscribe root to the test-bed repo only, dropping the org.
    const testBed = { kind: "github_repo", repo: "dummy-org/dummy-repo-test-bed" } as const;
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
    const keptSpace = { kind: "chat_space", space: "spaces/KEPT" } as const;
    const removedSpace = { kind: "chat_space", space: "spaces/REMOVED" } as const;
    const childSpace = { kind: "chat_space", space: "spaces/CHILD" } as const;

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
  it("shows an implied-only row disappears immediately and stays suppressed after reloading the v2 file", () => {
    const file = join(tmpdir(), `event-subs-test-legacy-${Date.now()}.json`);
    const rootOrg = { kind: "github_org" as const, org: "dummy-org" };
    const rootId = "root";

    // Legacy file with no version and an implied-only row
    writeFileSync(
      file,
      JSON.stringify({
        subscriptions: [
          {
            resource: rootOrg,
            actorId: rootId,
            subscribedBy: rootId,
            subscribedAt: "2025-01-01T00:00:00Z",
          },
        ],
      })
    );

    // Boot 1: The file is unversioned, so it should run the migration, drop the row, and immediately flush version: 2
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
    expect(saved.version).toBe(2);
    expect(saved.subscriptions).toEqual([]);

    // Boot 2: Reloading the v2 file. The implied row stays suppressed from disk.
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

  it("locks the existing same-key inactive-collision behavior", () => {
    const file = join(tmpdir(), `event-subs-test-tombstone-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ version: 2, subscriptions: [] }));
    const rootOrg = { kind: "github_org" as const, org: "dummy-org" };
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

    // Boot 2: Reloading the v2 file
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

describe("Event Resource Primitives", () => {
  const org = { kind: "github_org", org: "dummy-org" } as const;
  const repo = { kind: "github_repo", repo: "dummy-org/dummy-repo" } as const;
  const issue = { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 123 } as const;
  const pr = { kind: "github_pr", repo: "dummy-org/dummy-repo", number: 456 } as const;
  const branch = {
    kind: "github_branch",
    repo: "dummy-org/dummy-repo",
    ref: "refs/heads/staging",
  } as const;
  const chat = { kind: "chat" } as const;
  const chatSpace = { kind: "chat_space", space: "spaces/123" } as const;
  const system = { kind: "system" } as const;

  const otherOrg = { kind: "github_org", org: "Other-Org" } as const;
  const otherRepo = { kind: "github_repo", repo: "Other-Org/dummy-repo" } as const;
  const otherIssue = { kind: "github_issue", repo: "Other-Org/dummy-repo", number: 123 } as const;
  const otherBranch = {
    kind: "github_branch",
    repo: "dummy-org/dummy-repo",
    ref: "refs/heads/master",
  } as const;

  describe("parentOf", () => {
    it("resolves parent of issue/pr/branch to repo", () => {
      expect(parentOf(issue)).toEqual(repo);
      expect(parentOf(pr)).toEqual(repo);
      expect(parentOf(branch)).toEqual(repo);
    });

    it("resolves parent of repo to org", () => {
      expect(parentOf(repo)).toEqual(org);
    });

    it("resolves parent of org to undefined", () => {
      expect(parentOf(org)).toBeUndefined();
    });

    it("resolves parent of chat to undefined", () => {
      expect(parentOf(chat)).toBeUndefined();
    });

    it("resolves parent of chat_space to chat", () => {
      expect(parentOf(chatSpace)).toEqual(chat);
    });

    it("keeps system as a top-level family", () => {
      expect(parentOf(system)).toBeUndefined();
    });
  });

  describe("resourceKey", () => {
    it("returns space-specific key for chat_space", () => {
      expect(resourceKey(chatSpace)).toBe("chat_space:spaces/123");
    });

    it("returns the family key for system", () => {
      expect(resourceKey(system)).toBe("system");
    });
  });

  describe("sameResource", () => {
    it("returns true for same chat_space", () => {
      expect(sameResource(chatSpace, chatSpace)).toBe(true);
      expect(sameResource(chatSpace, { kind: "chat_space", space: "spaces/123" })).toBe(true);
    });

    it("returns false for different chat_spaces", () => {
      expect(sameResource(chatSpace, { kind: "chat_space", space: "spaces/456" })).toBe(false);
    });
  });

  describe("isSubResourceOf", () => {
    it("returns true for identical resources (inclusive containment)", () => {
      expect(isSubResourceOf(org, org)).toBe(true);
      expect(isSubResourceOf(repo, repo)).toBe(true);
      expect(isSubResourceOf(issue, issue)).toBe(true);
      expect(isSubResourceOf(pr, pr)).toBe(true);
      expect(isSubResourceOf(branch, branch)).toBe(true);
      expect(isSubResourceOf(chat, chat)).toBe(true);
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
      expect(isSubResourceOf(chatSpace, chat)).toBe(true);
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

  describe("serialization and round-trip", () => {
    it("round-trips all kinds through JSON", () => {
      const resources: EventResource[] = [org, repo, issue, pr];
      for (const r of resources) {
        const serialized = JSON.stringify(r);
        const deserialized = JSON.parse(serialized);
        expect(deserialized).toEqual(r);
      }
    });
  });
});
