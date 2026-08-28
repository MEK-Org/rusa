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

const key = (resource: EventResource, actorId: string): string =>
  `${resourceKey(resource)}:${actorId}`;

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
  seeded: EventSubscription[];
  deactivated: EventSubscription[];
}

const CONFIG_ROOT_KINDS = new Set<EventSourceKind>([
  "github_org",
  "github_repo",
  "github_branch",
  "chat",
  "chat_space",
  "system",
]);

export function syncRootEventSources(
  store: EventSubscriptionStore,
  configured: EventResource[],
  rootId: string,
  now: () => string
): EventSourceBootSyncResult {
  const seeded: EventSubscription[] = [];
  const deactivated: EventSubscription[] = [];
  const configuredKeys = new Set(configured.map(resourceKey));

  for (const resource of configured) {
    const active = store.activeForResource(resource)[0];
    if (active) {
      continue;
    }
    const subscription: EventSubscription = {
      resource,
      actorId: rootId,
      subscribedBy: rootId,
      subscribedAt: now(),
    };
    store.subscribe(subscription);
    seeded.push(subscription);
  }

  for (const subscription of store.list()) {
    if (
      subscription.unsubscribedAt ||
      subscription.actorId !== rootId ||
      subscription.subscribedBy !== rootId ||
      !CONFIG_ROOT_KINDS.has(subscription.resource.kind) ||
      configuredKeys.has(resourceKey(subscription.resource))
    ) {
      continue;
    }
    const at = now();
    store.unsubscribe(subscription.resource, rootId, at);
    deactivated.push({ ...subscription, unsubscribedAt: at });
  }

  return { seeded, deactivated };
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
    this.subs.set(key(resource, actorId), { ...subscription, unsubscribedAt: undefined });
  }

  unsubscribe(resource: EventSubscription["resource"], actorId: string, at: string): void {
    const existing = this.subs.get(key(resource, actorId));
    if (!existing || existing.unsubscribedAt) return;
    this.subs.set(key(resource, actorId), { ...existing, unsubscribedAt: at });
  }

  list(): EventSubscription[] {
    return [...this.subs.values()].map((s) => ({ ...s, resource: { ...s.resource } }));
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

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
        subscriptions?: EventSubscription[];
      };
      for (const s of parsed.subscriptions ?? []) {
        this.mem.subscribe(s); // subscribe() clears unsubscribedAt on insert…
        if (s.unsubscribedAt) this.mem.unsubscribe(s.resource, s.actorId, s.unsubscribedAt); // …re-apply it.
      }
    } catch {
      /* missing / empty / invalid → start empty */
    }
  }

  private flush(): void {
    try {
      writeFileSync(this.file, JSON.stringify({ subscriptions: this.mem.list() }, null, 2));
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
