import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import {
  asGitHubBranch,
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

export interface EventSubscriptionAuditEvent {
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
export function missingAuditedEventSubscriptions(
  store: EventSubscriptionStore,
  events: readonly EventSubscriptionAuditEvent[]
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
    this.restore({ ...subscription, unsubscribedAt: undefined });
  }

  /** Hydrate one already-durable row without reactivating a tombstone. */
  restore(subscription: EventSubscription): void {
    const resource = resourceKey(subscription.resource);
    const normalized: EventSubscription = {
      ...subscription,
      resource,
    };
    // One active subscriber per resource: a *different* active actor blocks.
    const holder = normalized.unsubscribedAt
      ? undefined
      : this.activeForResource(resource).find((s) => s.actorId !== subscription.actorId);
    if (holder && !normalized.unsubscribedAt) {
      throw new Error(
        `event source ${resource} already has an active subscriber ` +
          `(actor ${holder.actorId}); unsubscribe it before subscribing actor ${subscription.actorId}`
      );
    }
    this.subs.set(`${resource}:${subscription.actorId}`, normalized);
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
 * whole file atomically on every mutation. A mutation becomes visible in memory
 * only after its snapshot has been replaced, so callers never receive a false
 * success for a failed write or rename.
 */
export class FileEventSubscriptionStore implements EventSubscriptionStore {
  private mem = new InMemoryEventSubscriptionStore();

  constructor(
    private readonly file: string,
    rootId: string,
    private readonly warn: (message: string) => void = console.warn,
    private readonly replaceFile: typeof renameSync = renameSync
  ) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

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
    if (typeof document.version === "number" && document.version > 3) {
      throw new Error(`unsupported event subscription file version: ${document.version}`);
    }
    if (document.subscriptions !== undefined && !Array.isArray(document.subscriptions)) {
      throw new Error(`invalid event subscription rows: ${file}`);
    }

    const isUnversioned = document.version === undefined;
    const rows = (document.subscriptions ?? []) as unknown[];
    let rejected = 0;
    type ParsedRow = {
      index: number;
      subscription: EventSubscription;
      stateChangedAt: number;
    };
    const parsedRows: ParsedRow[] = [];
    for (const [index, row] of rows.entries()) {
      try {
        const subscription = parsePersistedSubscription(row);
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
        rejected += 1;
        this.warn(
          `[mesh] skipped event subscription row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const reject = (row: ParsedRow, reason: string): void => {
      rejected += 1;
      this.warn(`[mesh] skipped event subscription row ${row.index + 1}: ${reason}`);
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
    for (const { subscription } of resolvedRows.filter(
      ({ subscription }) => subscription.unsubscribedAt
    )) {
      this.mem.restore(subscription);
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
      this.mem.restore(winner.subscription);
    }

    if (rejected > 0) {
      const recoveryFile = rejectedSnapshotPath(this.file, raw);
      try {
        writeFileSync(recoveryFile, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          readFileSync(recoveryFile, "utf8") !== raw
        ) {
          throw new Error(`could not preserve rejected event subscription rows: ${recoveryFile}`, {
            cause: error,
          });
        }
      }
      this.warn(
        `[mesh] preserved ${rejected} rejected event subscription row(s) in ${recoveryFile}`
      );
    }

    const needsMigrationFlush = isUnversioned || (document.version as number | undefined) !== 3;
    if (needsMigrationFlush && rows.length > 0 && rejected === 0) {
      this.flush(this.mem.list());
    } else if (needsMigrationFlush && rejected > 0) {
      this.warn(
        `[mesh] event subscription migration left the source file unchanged after ${rejected} rejected row(s)`
      );
    }
  }

  private flush(subscriptions: EventSubscription[]): void {
    // A same-directory temporary plus rename prevents a process interruption
    // from exposing a partial JSON document. This is atomic replacement, not an
    // fsync-based guarantee against host/power loss.
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 3, subscriptions }, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      this.replaceFile(temporary, this.file);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary file may not have been created. Preserve the write error.
      }
      throw error;
    }
  }

  private commit(mutate: (candidate: InMemoryEventSubscriptionStore) => void): void {
    const candidate = new InMemoryEventSubscriptionStore();
    for (const subscription of this.mem.list()) candidate.restore(subscription);
    mutate(candidate);
    this.flush(candidate.list());
    this.mem = candidate;
  }

  subscribe(subscription: Omit<EventSubscription, "resource"> & { resource: EventResource }): void {
    this.commit((candidate) => candidate.subscribe(subscription));
  }

  unsubscribe(resource: EventResource, actorId: string, at: string): void {
    this.commit((candidate) => candidate.unsubscribe(resource, actorId, at));
  }

  list(): EventSubscription[] {
    return this.mem.list();
  }

  activeForResource(resource: EventResource): EventSubscription[] {
    return this.mem.activeForResource(resource);
  }
}

function rejectedSnapshotPath(file: string, raw: string): string {
  const digest = createHash("sha256").update(raw).digest("hex");
  return `${file}.rejected-${digest}.json`;
}

function parsePersistedSubscription(value: unknown): EventSubscription {
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

function persistedRowTieKey(subscription: EventSubscription): string {
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
