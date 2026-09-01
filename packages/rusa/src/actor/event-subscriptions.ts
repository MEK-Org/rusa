import { readFileSync, writeFileSync } from "node:fs";
import {
  githubBranchReference,
  isDescendantOf,
  parseReference,
  type Reference,
  referenceParent,
} from "../references/reference.js";

/**
 * Event-source subscriptions. An actor subscribes to an external event source —
 * named using the canonical URL-style reference grammar (`<scheme>:<path>`) — so
 * that events from that source (pushes, issues, PRs, chat messages, ...) are
 * routed to it. This module is the pure persistence layer for those
 * subscriptions.
 *
 * Subscriptions attach to the subscriber's **actor id** (its stable thread id),
 * not a handle.
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
  | string
  | Reference
  | { kind: "github_org"; org: string }
  | { kind: "github_repo"; repo: string }
  | { kind: "github_issue"; repo: string; number: number }
  | { kind: "github_pr"; repo: string; number: number }
  | { kind: "github_branch"; repo: string; ref: string }
  | { kind: "chat" }
  | { kind: "chat_space"; space: string }
  | { kind: "system" };

export interface EventSubscription {
  /** The subscribed-to event source (canonical reference string `<scheme>:<path>`). */
  resource: string;
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
  subscribe(subscription: Omit<EventSubscription, "resource"> & { resource: EventResource }): void;
  /** Mark the (resource, actorId) subscription inactive; no-op if none is active. */
  unsubscribe(resource: EventResource, actorId: string, at: string): void;
  /** Every subscription, active and inactive — the audit/inspection view. */
  list(): EventSubscription[];
  /** The subscriptions currently active for a resource (≤1 by the invariant). */
  activeForResource(resource: EventResource): EventSubscription[];
}

/** Normalize any event resource (reference, string, or legacy object) into a canonical reference string. */
export function normalizeEventResource(resource: unknown): string {
  if (typeof resource === "string") {
    const trimmed = resource.trim();
    if (!trimmed) return trimmed;
    // Legacy string format conversions
    if (trimmed.startsWith("github_org:")) {
      return `github:${trimmed.slice("github_org:".length)}`;
    }
    if (trimmed.startsWith("github_repo:")) {
      return `github:${trimmed.slice("github_repo:".length)}`;
    }
    if (trimmed.startsWith("github_issue:") || trimmed.startsWith("github_pr:")) {
      const isPr = trimmed.startsWith("github_pr:");
      const rest = trimmed.slice(isPr ? "github_pr:".length : "github_issue:".length);
      const match = /^(.+)#([1-9]\d*)$/.exec(rest);
      if (match) {
        return `github:${match[1]}/${isPr ? "pulls" : "issues"}/${match[2]}`;
      }
    }
    if (trimmed.startsWith("github_branch:")) {
      const rest = trimmed.slice("github_branch:".length);
      const atIdx = rest.indexOf("@");
      if (atIdx > 0) {
        const repo = rest.slice(0, atIdx);
        const ref = rest.slice(atIdx + 1);
        return githubBranchReference(repo, ref);
      }
    }
    if (trimmed === "chat") {
      return "gchat:spaces";
    }
    if (trimmed.startsWith("chat_space:")) {
      const space = trimmed.slice("chat_space:".length);
      return `gchat:${space.startsWith("spaces/") ? space : `spaces/${space}`}`;
    }
    if (trimmed === "system") {
      return "system:events";
    }
    try {
      return parseReference(trimmed).key;
    } catch {
      return trimmed;
    }
  }

  if (typeof resource === "object" && resource !== null) {
    if ("key" in resource && typeof (resource as Reference).key === "string") {
      return (resource as Reference).key;
    }
    if ("kind" in resource) {
      const legacy = resource as {
        kind: string;
        org?: string;
        repo?: string;
        number?: number;
        ref?: string;
        space?: string;
      };
      switch (legacy.kind) {
        case "github_org":
          return `github:${legacy.org}`;
        case "github_repo":
          return `github:${legacy.repo}`;
        case "github_issue":
          return `github:${legacy.repo}/issues/${legacy.number}`;
        case "github_pr":
          return `github:${legacy.repo}/pulls/${legacy.number}`;
        case "github_branch":
          return githubBranchReference(legacy.repo ?? "", legacy.ref ?? "");
        case "chat":
          return "gchat:spaces";
        case "chat_space":
          return `gchat:${legacy.space?.startsWith("spaces/") ? legacy.space : `spaces/${legacy.space}`}`;
        case "system":
          return "system:events";
      }
    }
  }

  return String(resource);
}

export const resourceKey = (resource: EventResource): string => normalizeEventResource(resource);

export const sameResource = (a: EventResource, b: EventResource): boolean =>
  resourceKey(a) === resourceKey(b);

/**
 * Resolves the parent resource of a given resource in the reference hierarchy.
 */
export function parentOf(resource: EventResource): string | undefined {
  const key = resourceKey(resource);
  try {
    const ref = parseReference(key);
    const parent = referenceParent(ref);
    return parent ? parent.key : undefined;
  } catch {
    return undefined;
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
      resource: resourceKey(resource),
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
  const keyX = resourceKey(x);
  const keyY = resourceKey(y);
  if (keyX === keyY) return true;
  try {
    const refX = parseReference(keyX);
    const refY = parseReference(keyY);
    return isDescendantOf(refX, refY);
  } catch {
    return false;
  }
}

/** Returns true if resource `x` is a proper descendant of resource `y`. */
export function isStrictSubResourceOf(x: EventResource, y: EventResource): boolean {
  return !sameResource(x, y) && isSubResourceOf(x, y);
}

/** In-memory subscription store — for tests and the e2e runner. */
export class InMemoryEventSubscriptionStore implements EventSubscriptionStore {
  private readonly subs = new Map<string, EventSubscription>();

  subscribe(subscription: Omit<EventSubscription, "resource"> & { resource: EventResource }): void {
    const key = resourceKey(subscription.resource);
    const normalized: EventSubscription = {
      ...subscription,
      resource: key,
    };
    // One active subscriber per resource: a *different* active actor blocks.
    const holder = this.activeForResource(key).find((s) => s.actorId !== subscription.actorId);
    if (holder) {
      throw new Error(
        `event source ${key} already has an active subscriber ` +
          `(actor ${holder.actorId}); unsubscribe it before subscribing actor ${subscription.actorId}`
      );
    }
    // Re-subscribing reactivates: drop any prior unsubscription, refresh metadata.
    this.subs.set(`${key}:${subscription.actorId}`, {
      ...normalized,
      unsubscribedAt: undefined,
    });
  }

  unsubscribe(resource: EventResource, actorId: string, at: string): void {
    const key = resourceKey(resource);
    const existing = this.subs.get(`${key}:${actorId}`);
    if (!existing || existing.unsubscribedAt) return;
    this.subs.set(`${key}:${actorId}`, { ...existing, unsubscribedAt: at });
  }

  list(): EventSubscription[] {
    return [...this.subs.values()].map((s) => ({ ...s }));
  }

  activeForResource(resource: EventResource): EventSubscription[] {
    const key = resourceKey(resource);
    return this.list().filter((s) => s.resource === key && !s.unsubscribedAt);
  }
}

export class UnionEventSubscriptionStore implements EventSubscriptionStore {
  constructor(
    private readonly baseStore: EventSubscriptionStore,
    private readonly mutatingStore: EventSubscriptionStore
  ) {}

  subscribe(subscription: Omit<EventSubscription, "resource"> & { resource: EventResource }): void {
    this.mutatingStore.subscribe(subscription);
  }

  unsubscribe(resource: EventResource, actorId: string, at: string): void {
    const key = resourceKey(resource);
    const active = this.activeForResource(key).find((s) => s.actorId === actorId);
    if (active) {
      // Ensure the row exists in the mutating store so that the unsubscription
      // leaves a permanent tombstone, overriding the base store.
      this.mutatingStore.subscribe(active);
    }
    this.mutatingStore.unsubscribe(key, actorId, at);
  }

  list(): EventSubscription[] {
    const base = this.baseStore.list();
    const mutating = this.mutatingStore.list();
    const activeMutatingResources = new Set(
      mutating.filter((s) => !s.unsubscribedAt).map((s) => s.resource)
    );

    const merged = new Map<string, EventSubscription>();
    for (const s of base) {
      if (activeMutatingResources.has(s.resource)) {
        continue;
      }
      merged.set(`${s.resource}:${s.actorId}`, s);
    }
    for (const s of mutating) {
      merged.set(`${s.resource}:${s.actorId}`, s);
    }
    return [...merged.values()];
  }

  activeForResource(resource: EventResource): EventSubscription[] {
    const key = resourceKey(resource);
    return this.list().filter((s) => s.resource === key && !s.unsubscribedAt);
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
    let needsMigrationFlush = false;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
        version?: number;
        subscriptions?: Array<Omit<EventSubscription, "resource"> & { resource: unknown }>;
      };
      isUnversioned = !parsed.version;
      if (isUnversioned || (parsed.version && parsed.version < 3)) {
        needsMigrationFlush = true;
      }
      for (const s of parsed.subscriptions ?? []) {
        didLoadSubscriptions = true;
        const normalizedResource = normalizeEventResource(s.resource);
        if (isUnversioned && s.actorId === rootId && s.subscribedBy === rootId) {
          continue;
        }
        this.mem.subscribe({
          ...s,
          resource: normalizedResource,
        });
        if (s.unsubscribedAt) this.mem.unsubscribe(normalizedResource, s.actorId, s.unsubscribedAt);
      }
    } catch {
      /* missing / empty / invalid → start empty */
    }
    if ((isUnversioned && didLoadSubscriptions) || (needsMigrationFlush && didLoadSubscriptions)) {
      this.flush();
    }
  }

  private flush(): void {
    try {
      writeFileSync(
        this.file,
        JSON.stringify({ version: 3, subscriptions: this.mem.list() }, null, 2)
      );
    } catch {
      /* best effort — in-memory copy remains authoritative for this process */
    }
  }

  subscribe(subscription: Omit<EventSubscription, "resource"> & { resource: EventResource }): void {
    this.mem.subscribe(subscription); // throws on a conflicting active subscriber — before any flush
    this.flush();
  }

  unsubscribe(resource: EventResource, actorId: string, at: string): void {
    this.mem.unsubscribe(resource, actorId, at);
    this.flush();
  }

  list(): EventSubscription[] {
    return this.mem.list();
  }

  activeForResource(resource: EventResource): EventSubscription[] {
    return this.mem.activeForResource(resource);
  }
}
