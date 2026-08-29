import { readFileSync, writeFileSync } from "node:fs";

/**
 * Event-source subscriptions (design ISSUE_NUM, phase 1). An actor subscribes to an
 * external event source — in v1 a GitHub repository — so that events from that
 * source (pushes, issues, PRs, …) are routed to it. This module is the pure
 * persistence layer for those subscriptions; the mesh wiring, router, and MCP
 * tools that act on them live one layer up (later phases).
 *
 * Subscriptions attach to the subscriber's **actor id** (its stable thread id),
 * not a handle. Only the root subscribes in v1 ({@link EventSubscription.subscribedBy}),
 * enforced one layer up; this module is pure persistence with one data-layer
 * invariant baked in — see {@link EventSubscriptionStore.subscribe}.
 */
export type EventSourceKind =
  | "github_org"
  | "github_repo"
  | "github_issue"
  | "github_pr"
  | "github_branch"
  | "chat"
  | "chat_space"
  | "system";

export type EventResource =
  | { kind: "github_org"; org: string }
  | { kind: "github_repo"; repo: string }
  | { kind: "github_issue"; repo: string; number: number }
  | { kind: "github_pr"; repo: string; number: number }
  | { kind: "github_branch"; repo: string; ref: string }
  | { kind: "chat" }
  | { kind: "chat_space"; space: string }
  | { kind: "system" };

export interface EventSubscription {
  /** The subscribed-to event source. */
  resource: EventResource;
  /** The subscriber's actor id (stable thread id), not a handle. */
  actorId: string;
  /** Who created the subscription (the root, in v1). */
  subscribedBy: string;
  /** ISO timestamp of the (most recent) subscribe. */
  subscribedAt: string;
  /** ISO timestamp of unsubscription; absent while the subscription is active. */
  unsubscribedAt?: string;
}

/**
 * Persistence boundary for event subscriptions — mirrors
 * {@link CapabilityGrantStore}: a local JSON file in production
 * ({@link FileEventSubscriptionStore}), in-memory for tests. Keyed on
 * (resource, actorId); one record per pair.
 */
export interface EventSubscriptionStore {
  /**
   * Subscribe `actorId` to `resource`. Idempotent on (resource, actorId):
   * re-subscribing the same actor reactivates it (clearing any prior
   * `unsubscribedAt`) and refreshes the metadata, without duplicating the row.
   *
   * Enforces **one active subscriber per resource**: throws if a *different*
   * actor is already actively subscribed to `resource`. A same-actor
   * re-subscribe never throws (it is idempotent), and an inactive
   * (unsubscribed) prior holder does not block a new subscriber.
   */
  subscribe(subscription: EventSubscription): void;
  /** Mark the (resource, actorId) subscription inactive; no-op if none is active. */
  unsubscribe(resource: EventSubscription["resource"], actorId: string, at: string): void;
  /** Every subscription, active and inactive — the audit/inspection view. */
  list(): EventSubscription[];
  /** The subscriptions currently active for a resource (≤1 by the invariant). */
  activeForResource(resource: EventSubscription["resource"]): EventSubscription[];
}

export const resourceKey = (resource: EventResource): string => {
  switch (resource.kind) {
    case "github_org":
      return `${resource.kind}:${resource.org}`;
    case "github_repo":
      return `${resource.kind}:${resource.repo}`;
    case "github_issue":
    case "github_pr":
      return `${resource.kind}:${resource.repo}#${resource.number}`;
    case "github_branch":
      return `${resource.kind}:${resource.repo}@${resource.ref}`;
    case "chat":
      return "chat";
    case "chat_space":
      return `chat_space:${resource.space}`;
    case "system":
      return "system";
  }
};

export const sameResource = (a: EventResource, b: EventResource): boolean => {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "github_org":
      return a.org === (b as typeof a).org;
    case "github_repo":
      return a.repo === (b as typeof a).repo;
    case "github_issue":
    case "github_pr":
      return a.repo === (b as typeof a).repo && a.number === (b as typeof a).number;
    case "github_branch":
      return a.repo === (b as typeof a).repo && a.ref === (b as typeof a).ref;
    case "chat":
    case "system":
      return true;
    case "chat_space":
      return a.space === (b as typeof a).space;
  }
};

/**
 * Resolves the parent resource of a given resource in the hierarchy:
 * issue/pr -> repo -> org -> undefined.
 */
export function parentOf(resource: EventResource): EventResource | undefined {
  switch (resource.kind) {
    case "github_issue":
    case "github_pr":
    case "github_branch":
      return { kind: "github_repo", repo: resource.repo };
    case "github_repo":
      return { kind: "github_org", org: resource.repo.split("/")[0] };
    case "github_org":
    case "chat":
    case "system":
      return undefined;
    case "chat_space":
      return { kind: "chat" };
  }
}

export interface EventSourceBootSyncResult {
  store: EventSubscriptionStore;
  droppedDelegations: EventSubscription[];
}

export function reconcileEventSources(
  persistentStore: EventSubscriptionStore,
  configured: EventResource[],
  rootId: string,
  now: () => string
): EventSourceBootSyncResult {
  const impliedStore = new InMemoryEventSubscriptionStore();
  const droppedDelegations: EventSubscription[] = [];

  for (const resource of configured) {
    // One active subscriber per resource. We seed implied subscriptions for the root,
    // but the UnionEventSubscriptionStore means persistent explicit overrides (if any)
    // will take precedence if the root later delegates it or drops it.
    impliedStore.subscribe({
      resource,
      actorId: rootId,
      subscribedBy: rootId,
      subscribedAt: now(),
    });
  }

  for (const sub of persistentStore.list()) {
    if (sub.unsubscribedAt) continue;

    let isAnchored = false;
    for (const configResource of configured) {
      if (isSubResourceOf(sub.resource, configResource)) {
        isAnchored = true;
        break;
      }
    }

    if (!isAnchored) {
      persistentStore.unsubscribe(sub.resource, sub.actorId, now());
      droppedDelegations.push({ ...sub, unsubscribedAt: now() });
    }
  }

  return {
    store: new UnionEventSubscriptionStore(impliedStore, persistentStore),
    droppedDelegations,
  };
}

/**
 * Returns true if resource `x` is contained under (is equal to or a descendant of) resource `y`.
 */
export function isSubResourceOf(x: EventResource, y: EventResource): boolean {
  let current: EventResource | undefined = x;
  while (current) {
    if (sameResource(current, y)) {
      return true;
    }
    current = parentOf(current);
  }
  return false;
}

/** Returns true if resource `x` is a proper descendant of resource `y`. */
export function isStrictSubResourceOf(x: EventResource, y: EventResource): boolean {
  return !sameResource(x, y) && isSubResourceOf(x, y);
}

/** In-memory subscription store — for tests and the e2e runner. */
export class InMemoryEventSubscriptionStore implements EventSubscriptionStore {
  private readonly subs = new Map<string, EventSubscription>();

  subscribe(subscription: EventSubscription): void {
    const { resource, actorId } = subscription;
    // One active subscriber per resource: a *different* active actor blocks.
    const holder = this.activeForResource(resource).find((s) => s.actorId !== actorId);
    if (holder) {
      throw new Error(
        `event source ${resourceKey(resource)} already has an active subscriber ` +
          `(actor ${holder.actorId}); unsubscribe it before subscribing actor ${actorId}`
      );
    }
    // Re-subscribing reactivates: drop any prior unsubscription, refresh metadata.
    this.subs.set(`${resourceKey(resource)}:${actorId}`, {
      ...subscription,
      unsubscribedAt: undefined,
    });
  }

  unsubscribe(resource: EventSubscription["resource"], actorId: string, at: string): void {
    const existing = this.subs.get(`${resourceKey(resource)}:${actorId}`);
    if (!existing || existing.unsubscribedAt) return;
    this.subs.set(`${resourceKey(resource)}:${actorId}`, { ...existing, unsubscribedAt: at });
  }

  list(): EventSubscription[] {
    return [...this.subs.values()].map((s) => ({ ...s, resource: { ...s.resource } }));
  }

  activeForResource(resource: EventSubscription["resource"]): EventSubscription[] {
    return this.list().filter((s) => sameResource(s.resource, resource) && !s.unsubscribedAt);
  }
}

export class UnionEventSubscriptionStore implements EventSubscriptionStore {
  constructor(
    private readonly baseStore: EventSubscriptionStore,
    private readonly mutatingStore: EventSubscriptionStore
  ) {}

  subscribe(subscription: EventSubscription): void {
    this.mutatingStore.subscribe(subscription);
  }

  unsubscribe(resource: EventSubscription["resource"], actorId: string, at: string): void {
    const active = this.activeForResource(resource).find((s) => s.actorId === actorId);
    if (active) {
      // Ensure the row exists in the mutating store so that the unsubscription
      // leaves a permanent tombstone, overriding the base store.
      this.mutatingStore.subscribe(active);
    }
    this.mutatingStore.unsubscribe(resource, actorId, at);
  }

  list(): EventSubscription[] {
    const base = this.baseStore.list();
    const mutating = this.mutatingStore.list();
    const activeMutatingResources = new Set(
      mutating.filter((s) => !s.unsubscribedAt).map((s) => resourceKey(s.resource))
    );

    const merged = new Map<string, EventSubscription>();
    for (const s of base) {
      if (activeMutatingResources.has(resourceKey(s.resource))) {
        continue;
      }
      merged.set(`${resourceKey(s.resource)}:${s.actorId}`, s);
    }
    for (const s of mutating) {
      merged.set(`${resourceKey(s.resource)}:${s.actorId}`, s);
    }
    return [...merged.values()];
  }

  activeForResource(resource: EventSubscription["resource"]): EventSubscription[] {
    return this.list().filter((s) => sameResource(s.resource, resource) && !s.unsubscribedAt);
  }
}

/**
 * JSON-file-backed subscription store — the durable store, mirroring
 * {@link FileCapabilityGrantStore}: loads once on construction, rewrites the
 * whole file on every mutation, and keeps an authoritative in-memory copy so the
 * mesh keeps working even if the disk is momentarily unwritable.
 */
export class FileEventSubscriptionStore implements EventSubscriptionStore {
  private readonly mem = new InMemoryEventSubscriptionStore();

  constructor(
    private readonly file: string,
    rootId: string
  ) {
    let isUnversioned = false;
    let didLoadSubscriptions = false;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
        version?: number;
        subscriptions?: EventSubscription[];
      };
      isUnversioned = !parsed.version;
      for (const s of parsed.subscriptions ?? []) {
        didLoadSubscriptions = true;
        if (isUnversioned && s.actorId === rootId && s.subscribedBy === rootId) {
          continue;
        }
        this.mem.subscribe(s);
        if (s.unsubscribedAt) this.mem.unsubscribe(s.resource, s.actorId, s.unsubscribedAt);
      }
    } catch {
      /* missing / empty / invalid → start empty */
    }
    if (isUnversioned && didLoadSubscriptions) {
      this.flush();
    }
  }

  private flush(): void {
    try {
      writeFileSync(
        this.file,
        JSON.stringify({ version: 2, subscriptions: this.mem.list() }, null, 2)
      );
    } catch {
      /* best effort — in-memory copy remains authoritative for this process */
    }
  }

  subscribe(subscription: EventSubscription): void {
    this.mem.subscribe(subscription); // throws on a conflicting active subscriber — before any flush
    this.flush();
  }

  unsubscribe(resource: EventSubscription["resource"], actorId: string, at: string): void {
    this.mem.unsubscribe(resource, actorId, at);
    this.flush();
  }

  list(): EventSubscription[] {
    return this.mem.list();
  }

  activeForResource(resource: EventSubscription["resource"]): EventSubscription[] {
    return this.mem.activeForResource(resource);
  }
}
