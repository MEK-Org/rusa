import {
  asGitHubBranch,
  githubBranchReference,
  isDescendantOf,
  parseReference,
  type Reference,
  referenceParent,
} from "../references/reference.js";

/**
 * Event sources — external things that emit events (pushes, issues, PRs, chat
 * messages, ...), named with the canonical URL-style reference grammar
 * (`<scheme>:<path>`). This module is the pure persistence layer for the two
 * distinct relationships an actor can have with one.
 *
 * **Ownership** is single. One actor owns a source at a time; ownership arrives
 * by delegation, by the config-implied seed, or by creating the resource; and it
 * governs bubbling — an event with no live owner at its exact source may climb
 * to the owner of the parent resource. {@link EventSourceOwnerStore} holds it,
 * with releases kept as tombstones so a delegated-away source does not silently
 * revert to the seed at the next restart.
 *
 * **Subscription** is many. Any actor may subscribe itself to any in-scope
 * source and receives *direct* events on that exact source.
 * {@link EventSourceSubscriptionStore} holds those, and they deliberately have
 * none of ownership's machinery: no seed to outrank, so no tombstones; no
 * bubbling, so no parent walk; no part in ownership resolution, so a subscriber
 * can never be handed work an owner has claimed. Bubbling exists to stop
 * important events being missed by whoever is responsible; a subscriber is not
 * responsible, it is interested.
 *
 * Both attach to the actor's **actor id** (its stable thread id), not a handle.
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

/** The one canonical event-source representation used by stores and routing. */
export type EventResource = string;

/** Legacy input accepted only while reading old files and decomposed MCP arguments. */
export type LegacyEventResourceInput =
  | Reference
  | { kind: "github_org"; org: string }
  | { kind: "github_repo"; repo: string }
  | { kind: "github_issue"; repo: string; number: number }
  | { kind: "github_pr"; repo: string; number: number }
  | { kind: "github_branch"; repo: string; ref: string }
  | { kind: "chat" }
  | { kind: "chat_space"; space: string }
  | { kind: "system" };

export interface EventSourceOwnership {
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

/** Legacy on-disk location of the explicit subscriptions, relative to the instance home. */
export const EVENT_SUBSCRIPTIONS_FILENAME = "event-subscriptions.json";

/**
 * The one-active-owner-per-resource refusal. Shared so every store
 * implementation refuses in identical words and callers can match on it without
 * knowing which store is underneath.
 */
export function activeOwnerConflictMessage(
  resource: EventResource,
  holderActorId: string,
  actorId: string
): string {
  return (
    `event source ${resource} already has an active subscriber ` +
    `(actor ${holderActorId}); unsubscribe it before subscribing actor ${actorId}`
  );
}

/**
 * Persistence boundary for event-source **ownership** — mirrors
 * {@link CapabilityGrantStore}: SQLite in production
 * (`DbEventSourceOwnerStore`), in-memory for the config-implied seed and for
 * tests. Keyed on (resource, actorId); one record per pair.
 *
 * The verbs stay `subscribe`/`unsubscribe` because they are the actions the
 * audit stream has always recorded (`event_source_subscribed` /
 * `event_source_unsubscribed`), and renaming them would desync history from the
 * events {@link missingAuditedEventSourceOwnerships} replays. What they mean is
 * "take ownership" and "release ownership".
 */
export interface EventSourceOwnerStore {
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
  subscribe(
    subscription: Omit<EventSourceOwnership, "resource"> & { resource: EventResource }
  ): void;
  /** Mark the (resource, actorId) subscription inactive; no-op if none is active. */
  unsubscribe(resource: EventResource, actorId: string, at: string): void;
  /** Every subscription, active and inactive — the audit/inspection view. */
  list(): EventSourceOwnership[];
  /** The subscriptions currently active for a resource (≤1 by the invariant). */
  activeForResource(resource: EventResource): EventSourceOwnership[];
}

export interface EventSourceOwnershipAuditEvent {
  kind: "event_source_subscribed" | "event_source_unsubscribed" | string;
  actorId: string | null;
  detail: string | null;
}

/**
 * Find audit-confirmed active subscriptions absent from the behavioral store.
 *
 * Events must be oldest-first. This is deliberately one-way: an empty or
 * truncated analytics stream proves nothing about the durable file, so file-only
 * rows are never reported and audit data is never used to mutate behavior.
 */
export function missingAuditedEventSourceOwnerships(
  store: EventSourceOwnerStore,
  events: readonly EventSourceOwnershipAuditEvent[]
): Array<{ resource: EventResource; actorId: string }> {
  const auditedActive = new Map<string, { resource: EventResource; actorId: string }>();
  for (const event of events) {
    if (!event.actorId || !event.detail) continue;
    let resource: EventResource;
    try {
      resource = resourceKey(event.detail);
    } catch {
      continue;
    }
    const key = `${resource}\0${event.actorId}`;
    if (event.kind === "event_source_subscribed") {
      auditedActive.set(key, { resource, actorId: event.actorId });
    } else if (event.kind === "event_source_unsubscribed") {
      auditedActive.delete(key);
    }
  }
  const durableActive = new Set(
    store
      .list()
      .filter((subscription) => !subscription.unsubscribedAt)
      .map((subscription) => `${subscription.resource}\0${subscription.actorId}`)
  );
  return [...auditedActive.entries()]
    .filter(([key]) => !durableActive.has(key))
    .map(([, subscription]) => subscription);
}

/** Normalize a boundary input into one validated canonical reference string. */
export function normalizeEventResource(
  resource: EventResource | LegacyEventResourceInput
): EventResource {
  let candidate: string | undefined;
  if (typeof resource === "string") {
    const trimmed = resource.trim();
    candidate = trimmed;
    // Legacy string format conversions
    if (trimmed.startsWith("github_org:")) {
      candidate = `github:${trimmed.slice("github_org:".length)}`;
    } else if (trimmed.startsWith("github_repo:")) {
      candidate = `github:${trimmed.slice("github_repo:".length)}`;
    } else if (trimmed.startsWith("github_issue:") || trimmed.startsWith("github_pr:")) {
      const isPr = trimmed.startsWith("github_pr:");
      const rest = trimmed.slice(isPr ? "github_pr:".length : "github_issue:".length);
      const match = /^(.+)#([1-9]\d*)$/.exec(rest);
      if (match) {
        candidate = `github:${match[1]}/${isPr ? "pulls" : "issues"}/${match[2]}`;
      }
    } else if (trimmed.startsWith("github_branch:")) {
      const rest = trimmed.slice("github_branch:".length);
      const atIdx = rest.indexOf("@");
      if (atIdx > 0) {
        const repo = rest.slice(0, atIdx);
        const ref = rest.slice(atIdx + 1);
        candidate = githubBranchReference(repo, ref);
      }
    } else if (trimmed === "chat") {
      candidate = "gchat:spaces";
    } else if (trimmed.startsWith("chat_space:")) {
      const space = trimmed.slice("chat_space:".length);
      candidate = `gchat:${space.startsWith("spaces/") ? space : `spaces/${space}`}`;
    } else if (trimmed === "system") {
      candidate = "system:events";
    }
  } else if (typeof resource === "object" && resource !== null) {
    if ("key" in resource && typeof (resource as Reference).key === "string") {
      candidate = (resource as Reference).key;
    } else if ("kind" in resource) {
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
          candidate = `github:${legacy.org}`;
          break;
        case "github_repo":
          candidate = `github:${legacy.repo}`;
          break;
        case "github_issue":
          candidate = `github:${legacy.repo}/issues/${legacy.number}`;
          break;
        case "github_pr":
          candidate = `github:${legacy.repo}/pulls/${legacy.number}`;
          break;
        case "github_branch":
          candidate = githubBranchReference(legacy.repo ?? "", legacy.ref ?? "");
          break;
        case "chat":
          candidate = "gchat:spaces";
          break;
        case "chat_space":
          candidate = `gchat:${legacy.space?.startsWith("spaces/") ? legacy.space : `spaces/${legacy.space}`}`;
          break;
        case "system":
          candidate = "system:events";
          break;
      }
    }
  }

  const parsed = parseReference(candidate ?? String(resource));
  const branch = asGitHubBranch(parsed);
  return branch
    ? githubBranchReference(`${branch.owner}/${branch.repo}`, branch.branch)
    : parsed.key;
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
  store: EventSourceOwnerStore;
  droppedDelegations: EventSourceOwnership[];
}

export function reconcileEventSources(
  persistentStore: EventSourceOwnerStore,
  configured: EventResource[],
  rootId: string,
  now: () => string
): EventSourceBootSyncResult {
  const impliedStore = new InMemoryEventSourceOwnerStore();
  const droppedDelegations: EventSourceOwnership[] = [];

  for (const resource of configured) {
    // One active subscriber per resource. We seed implied subscriptions for the root,
    // but the UnionEventSourceOwnerStore means persistent explicit overrides (if any)
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
    store: new UnionEventSourceOwnerStore(impliedStore, persistentStore),
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
export class InMemoryEventSourceOwnerStore implements EventSourceOwnerStore {
  private readonly subs = new Map<string, EventSourceOwnership>();

  subscribe(
    subscription: Omit<EventSourceOwnership, "resource"> & { resource: EventResource }
  ): void {
    this.restore({ ...subscription, unsubscribedAt: undefined });
  }

  /** Hydrate one already-durable row without reactivating a tombstone. */
  restore(subscription: EventSourceOwnership): void {
    const resource = resourceKey(subscription.resource);
    const normalized: EventSourceOwnership = {
      ...subscription,
      resource,
    };
    // One active subscriber per resource: a *different* active actor blocks.
    const holder = normalized.unsubscribedAt
      ? undefined
      : this.activeForResource(resource).find((s) => s.actorId !== subscription.actorId);
    if (holder && !normalized.unsubscribedAt) {
      throw new Error(activeOwnerConflictMessage(resource, holder.actorId, subscription.actorId));
    }
    this.subs.set(`${resource}:${subscription.actorId}`, normalized);
  }

  unsubscribe(resource: EventResource, actorId: string, at: string): void {
    const key = resourceKey(resource);
    const existing = this.subs.get(`${key}:${actorId}`);
    if (!existing || existing.unsubscribedAt) return;
    this.subs.set(`${key}:${actorId}`, { ...existing, unsubscribedAt: at });
  }

  list(): EventSourceOwnership[] {
    return [...this.subs.values()].map((s) => ({ ...s }));
  }

  activeForResource(resource: EventResource): EventSourceOwnership[] {
    const key = resourceKey(resource);
    return this.list().filter((s) => s.resource === key && !s.unsubscribedAt);
  }
}

export class UnionEventSourceOwnerStore implements EventSourceOwnerStore {
  constructor(
    private readonly baseStore: EventSourceOwnerStore,
    private readonly mutatingStore: EventSourceOwnerStore
  ) {}

  subscribe(
    subscription: Omit<EventSourceOwnership, "resource"> & { resource: EventResource }
  ): void {
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

  list(): EventSourceOwnership[] {
    const base = this.baseStore.list();
    const mutating = this.mutatingStore.list();
    const activeMutatingResources = new Set(
      mutating.filter((s) => !s.unsubscribedAt).map((s) => s.resource)
    );

    const merged = new Map<string, EventSourceOwnership>();
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

  activeForResource(resource: EventResource): EventSourceOwnership[] {
    const key = resourceKey(resource);
    return this.list().filter((s) => s.resource === key && !s.unsubscribedAt);
  }
}

/**
 * One actor's standing interest in one event source. There is no
 * `unsubscribedAt` counterpart to {@link EventSourceOwnership}: ownership keeps
 * tombstones only because they have to keep outranking the config-implied seed
 * that `reconcileEventSources` re-derives on every boot, and a subscription has
 * no seed to outrank. Removing one is a deletion.
 */
export interface EventSourceSubscription {
  /** The subscribed-to event source (canonical reference string `<scheme>:<path>`). */
  resource: string;
  /** The subscriber's actor id (stable thread id), not a handle. */
  actorId: string;
  /** Who performed the subscribe — the subscriber itself, or an operator/mechanical path. */
  subscribedBy: string;
  /** ISO timestamp of the (most recent) subscribe. */
  subscribedAt: string;
}

/**
 * Persistence boundary for direct event-source **subscriptions**: SQLite in
 * production (`DbEventSourceSubscriptionStore`), in-memory for tests and the
 * e2e runner. Keyed on (resource, actorId); any number of actors may subscribe
 * to one resource.
 */
export interface EventSourceSubscriptionStore {
  /** Subscribe `actorId` to `resource`. Idempotent on (resource, actorId). */
  subscribe(subscription: EventSourceSubscription): void;
  /** Remove the (resource, actorId) subscription; no-op if absent. */
  unsubscribe(resource: EventResource, actorId: string): void;
  /** Every subscription — the audit/inspection view. */
  list(): EventSourceSubscription[];
  /** The actors subscribed to this exact resource. Never consults ancestors. */
  subscribersOf(resource: EventResource): EventSourceSubscription[];
}

/** In-memory subscription store — for tests and the e2e runner. */
export class InMemoryEventSourceSubscriptionStore implements EventSourceSubscriptionStore {
  private readonly subs = new Map<string, EventSourceSubscription>();

  subscribe(subscription: EventSourceSubscription): void {
    const resource = resourceKey(subscription.resource);
    this.subs.set(`${resource}\0${subscription.actorId}`, { ...subscription, resource });
  }

  unsubscribe(resource: EventResource, actorId: string): void {
    this.subs.delete(`${resourceKey(resource)}\0${actorId}`);
  }

  list(): EventSourceSubscription[] {
    return [...this.subs.values()].map((subscription) => ({ ...subscription }));
  }

  subscribersOf(resource: EventResource): EventSourceSubscription[] {
    const key = resourceKey(resource);
    return this.list().filter((subscription) => subscription.resource === key);
  }
}

/**
 * Boot-time anchoring for direct subscriptions, the counterpart of the
 * unanchored-delegation sweep in {@link reconcileEventSources}.
 *
 * A subscription survives only while its resource is still contained by a
 * configured source. Narrowing `config.yaml` is how an instance stops being
 * responsible for a slice of the world, and a subscription that outlived that
 * narrowing would keep delivering events from outside it — the same firehose
 * an unanchored delegation would reopen, through a door ownership already
 * closed. Deleted rather than tombstoned, because a subscription has no seed to
 * suppress; if the config widens again the actor can simply subscribe again.
 */
export function reconcileEventSourceSubscriptions(
  store: EventSourceSubscriptionStore,
  configured: readonly EventResource[]
): EventSourceSubscription[] {
  const dropped: EventSourceSubscription[] = [];
  for (const subscription of store.list()) {
    const anchored = configured.some((resource) =>
      isSubResourceOf(subscription.resource, resource)
    );
    if (anchored) continue;
    store.unsubscribe(subscription.resource, subscription.actorId);
    dropped.push(subscription);
  }
  return dropped;
}

/** The highest `event-subscriptions.json` document version this parser understands. */
export const EVENT_SUBSCRIPTION_DOCUMENT_VERSION = 3;

/** One source row the document could not resolve, with its 1-based position. */
export interface LegacyEventSubscriptionRejection {
  row: number;
  reason: string;
}

export interface LegacyEventSubscriptionDocument {
  /**
   * Accepted rows, tombstones first: replaying them through `restore()` in this
   * order never trips the one-active-subscriber invariant.
   */
  subscriptions: EventSourceOwnership[];
  /** Rows that could not be resolved. Every one is an ownership claim, so no caller may ignore them. */
  rejections: LegacyEventSubscriptionRejection[];
}

/**
 * Parse one `event-subscriptions.json` document into the rows a store should
 * hold, touching no filesystem. Structural problems (unreadable JSON, an
 * unknown document version) throw; row-level problems come back as
 * {@link LegacyEventSubscriptionRejection}s rather than being dropped, because
 * every one of them is an ownership claim. The SQLite importer is the only
 * caller and refuses the whole document when any row is rejected: committing
 * the remainder would make a dropped ownership claim durable and invisible.
 *
 * The resolutions performed here are the non-lossy deterministic ones the
 * retired JSON store also performed — legacy spellings converge to one
 * canonical key, several spellings of one (resource, actor) pair collapse to
 * that pair's latest state, and an unversioned document's root-owned rows are
 * dropped as the config-implied seed `reconcileEventSources` re-derives anyway.
 */
export function parseLegacyEventSubscriptionDocument(
  raw: string,
  options: { file: string; rootId: string }
): LegacyEventSubscriptionDocument {
  const { file, rootId } = options;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Fail closed instead of silently booting with an empty routing authority.
    // The source file remains untouched for manual repair.
    throw new Error(`invalid event subscription file: ${file}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid event subscription file root: ${file}`);
  }
  const document = parsed as { version?: unknown; subscriptions?: unknown };
  if (
    document.version !== undefined &&
    (!Number.isInteger(document.version) || (document.version as number) < 1)
  ) {
    throw new Error(`invalid event subscription file version: ${String(document.version)}`);
  }
  if (
    typeof document.version === "number" &&
    document.version > EVENT_SUBSCRIPTION_DOCUMENT_VERSION
  ) {
    throw new Error(`unsupported event subscription file version: ${document.version}`);
  }
  if (document.subscriptions !== undefined && !Array.isArray(document.subscriptions)) {
    throw new Error(`invalid event subscription rows: ${file}`);
  }

  const isUnversioned = document.version === undefined;
  const rows = (document.subscriptions ?? []) as unknown[];
  const rejections: LegacyEventSubscriptionRejection[] = [];
  type ParsedRow = {
    index: number;
    subscription: EventSourceOwnership;
    stateChangedAt: number;
  };
  const parsedRows: ParsedRow[] = [];
  for (const [index, row] of rows.entries()) {
    try {
      const subscription = parsePersistedSubscription(row);
      // Pre-union documents recorded the root's config-implied subscriptions as
      // durable rows. `reconcileEventSources` re-seeds those on every boot, so
      // carrying them forward would resurrect sources the config no longer names.
      if (
        isUnversioned &&
        subscription.actorId === rootId &&
        subscription.subscribedBy === rootId
      ) {
        continue;
      }
      parsedRows.push({
        index,
        subscription,
        stateChangedAt: Date.parse(subscription.unsubscribedAt ?? subscription.subscribedAt),
      });
    } catch (error) {
      rejections.push({
        row: index + 1,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const reject = (row: ParsedRow, reason: string): void => {
    rejections.push({ row: row.index + 1, reason });
  };

  // Legacy spellings can normalize multiple rows onto one (resource, actor)
  // key. Resolve that actor's latest state before comparing active owners.
  const pairRows = new Map<string, ParsedRow[]>();
  for (const row of parsedRows) {
    const key = `${row.subscription.resource}\0${row.subscription.actorId}`;
    const group = pairRows.get(key) ?? [];
    group.push(row);
    pairRows.set(key, group);
  }
  const resolvedRows: ParsedRow[] = [];
  for (const group of pairRows.values()) {
    const latestAt = Math.max(...group.map((row) => row.stateChangedAt));
    const latest = group.filter((row) => row.stateChangedAt === latestAt);
    // At an exact transition tie, retain an inactive state. Otherwise choose
    // by normalized row content so reversing the file cannot change behavior.
    const [winner] = [...latest].sort((a, b) => {
      const inactive =
        Number(Boolean(b.subscription.unsubscribedAt)) -
        Number(Boolean(a.subscription.unsubscribedAt));
      if (inactive !== 0) return inactive;
      return persistedRowTieKey(a.subscription).localeCompare(persistedRowTieKey(b.subscription));
    });
    if (!winner) continue;
    resolvedRows.push(winner);
    for (const row of group) {
      if (row !== winner) {
        reject(row, `a later state already exists for ${row.subscription.resource}`);
      }
    }
  }

  // Tombstones cannot contend for live ownership. Among active actors, an
  // unambiguous newest subscribe wins. Equal instants are rejected as an
  // authority conflict instead of assigning ownership from JSON file order.
  const subscriptions: EventSourceOwnership[] = [];
  for (const { subscription } of resolvedRows.filter(
    ({ subscription }) => subscription.unsubscribedAt
  )) {
    subscriptions.push(subscription);
  }
  const activeByResource = new Map<string, ParsedRow[]>();
  for (const row of resolvedRows.filter(({ subscription }) => !subscription.unsubscribedAt)) {
    const group = activeByResource.get(row.subscription.resource) ?? [];
    group.push(row);
    activeByResource.set(row.subscription.resource, group);
  }
  for (const [resource, group] of activeByResource) {
    const newestAt = Math.max(...group.map((row) => Date.parse(row.subscription.subscribedAt)));
    const newest = group.filter((row) => Date.parse(row.subscription.subscribedAt) === newestAt);
    if (newest.length !== 1) {
      for (const row of group) reject(row, `ambiguous active subscribers for ${resource}`);
      continue;
    }
    const [winner] = newest;
    if (!winner) continue;
    for (const row of group) {
      if (row !== winner) reject(row, `a newer active subscriber already owns ${resource}`);
    }
    subscriptions.push(winner.subscription);
  }

  return { subscriptions, rejections };
}

function parsePersistedSubscription(value: unknown): EventSourceOwnership {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("row is not an object");
  }
  const row = value as Record<string, unknown>;
  const actorId = requiredString(row, "actorId");
  const subscribedBy = requiredString(row, "subscribedBy");
  const subscribedAt = requiredTimestamp(row, "subscribedAt");
  let unsubscribedAt: string | undefined;
  if (row.unsubscribedAt !== undefined) {
    unsubscribedAt = requiredTimestamp(row, "unsubscribedAt");
    if (Date.parse(unsubscribedAt) < Date.parse(subscribedAt)) {
      throw new Error("unsubscribedAt must not precede subscribedAt");
    }
  }
  return {
    resource: normalizeEventResource(row.resource as EventResource | LegacyEventResourceInput),
    actorId,
    subscribedBy,
    subscribedAt,
    ...(unsubscribedAt ? { unsubscribedAt } : {}),
  };
}

function persistedRowTieKey(subscription: EventSourceOwnership): string {
  return [
    subscription.resource,
    subscription.actorId,
    subscription.subscribedBy,
    subscription.subscribedAt,
    subscription.unsubscribedAt ?? "",
  ].join("\0");
}

function requiredTimestamp(row: Record<string, unknown>, field: string): string {
  const value = requiredString(row, field);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be a valid timestamp`);
  }
  return value;
}

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}
