import { createHash } from "node:crypto";
import {
  type EventResource,
  type EventSourceOwnerStore,
  type EventSourceSubscriptionStore,
  parentOf,
  resourceKey,
  sameResource,
} from "../actor/event-subscriptions.js";
import type {
  InboxAppendInput,
  InboxEntry,
  InboxPayload,
  InboxStore,
} from "../actor/inbox-store.js";
import {
  checkSuiteWakesAnyone,
  deriveGitHubInboxNotification,
} from "../github/inbox-notification.js";
import { isSystemActor } from "../mcp/stamp.js";
import { asGitHubIssue, parseReference } from "../references/reference.js";

/**
 * Normalizes a resource to canonical reference form when valid, otherwise
 * trims and preserves the custom identifier.
 */
export function safeResourceKey(resource: EventResource | string): string {
  try {
    return resourceKey(resource);
  } catch {
    return typeof resource === "string" ? resource.trim() : String(resource);
  }
}

/**
 * Derives a deterministic, collision-resistant inbox entry id for deduplication.
 * Stable across instances, restarts, and runs.
 */
export function deduplicatedInboxEntryId(dedupeKey: string, actorId: string): string {
  const digest = createHash("sha256")
    .update(dedupeKey)
    .update("\0")
    .update(actorId)
    .digest("hex")
    .slice(0, 32);
  return `dedupe:${digest}`;
}

/**
 * Whether an event is important enough to climb from its exact resource to a
 * broader subscriber when no live exact subscriber exists.
 */
export function mayBubbleToParent(
  eventType: string | undefined,
  eventMerged: boolean | undefined
): boolean {
  switch (eventType) {
    case "issues.opened":
    case "issue_comment.created":
    case "pull_request.opened":
    case "pull_request_review.submitted":
    case "pull_request_review_comment.created":
    case "check_suite.completed":
    case "gchat.message":
      return true;
    case "pull_request.closed":
      return eventMerged === true;
    default:
      return false;
  }
}

/** Map only the issue-shaped event resources obligations may govern. */
function eventResourceObligationKey(resource: EventResource): string | undefined {
  try {
    const key = resourceKey(resource);
    return asGitHubIssue(parseReference(key)) ? key : undefined;
  } catch {
    return undefined;
  }
}

export type IntegrationSourceType = "github" | "chat" | "timer" | "custom";

export interface StampedAuthorInfo {
  actorId: string;
  instanceId: string;
}

export interface RawIntegrationEvent {
  sourceType: IntegrationSourceType;
  rawResource?: EventResource | string;
  rawPayload: unknown;
  receivedAt?: Date;
  idempotencyKey?: string;
  priority?: "responsive" | "normal";
  directedTarget?: string | null;
  stampedAuthor?: StampedAuthorInfo | null;
  instanceId?: string;
  eventSummary?: string;
}

export interface NormalizedIntegrationEvent {
  resource: string;
  payload: InboxPayload;
  dedupeKey?: string;
  deliveredAt?: Date;
  priority?: "responsive" | "normal";
  directedTarget?: string | null;
  stampedAuthor?: StampedAuthorInfo | null;
  instanceId?: string;
  eventSummary?: string;
}

export interface EventSourceRecipients {
  ownerId: string | null;
  ownerIds?: readonly string[];
  subscriberIds: readonly string[];
}

export interface ResolveRecipientsOptions {
  eventPayload?: InboxPayload;
  directedTarget?: string | null;
  eventSummary?: string;
}

export interface EventSourceResolver {
  resolveRecipients(
    resource: EventResource | string,
    options?: ResolveRecipientsOptions
  ): Promise<EventSourceRecipients> | EventSourceRecipients;
}

export interface ObligationLookup {
  findLiveByExternalRef(ref: string): { ownerId: string } | null | undefined;
}

export interface HierarchicalEventSourceResolverOptions {
  eventSourceOwners: EventSourceOwnerStore;
  eventSourceSubscriptions: EventSourceSubscriptionStore;
  obligations?: ObligationLookup;
  isLive: (actorId: string) => boolean;
  resolveActor?: (handleOrId: string) => { id: string } | undefined;
  log?: (message: string) => void;
}

/**
 * Resolves event recipients following hierarchical event-source rules:
 * obligation claims take precedence over explicit subscriptions, live owners
 * govern, allowlisted events bubble up ancestor resources, direct subscribers
 * receive exact-resource events, and directives target specific live actors.
 */
export class HierarchicalEventSourceResolver implements EventSourceResolver {
  constructor(private readonly options: HierarchicalEventSourceResolverOptions) {}

  resolveRecipients(
    resource: EventResource | string,
    opts: ResolveRecipientsOptions = {}
  ): EventSourceRecipients {
    const key = safeResourceKey(resource);
    const summary = opts.eventSummary ?? key;
    let directed = false;
    let ownerIds: string[] = [];

    if (opts.directedTarget) {
      const governing = this.obligationOwnerFor(key);
      if (governing) {
        ownerIds = this.options.isLive(governing) ? [governing] : [];
      } else {
        const target = this.options.resolveActor?.(opts.directedTarget);
        if (target && this.options.isLive(target.id)) {
          this.options.log?.(
            `mesh:deliver directed-delivered to ${opts.directedTarget} (${summary})`
          );
          ownerIds = [target.id];
          directed = true;
        } else {
          this.options.log?.(
            `mesh:deliver target not live: ${opts.directedTarget} — directive ignored`
          );
          ownerIds = this.resolveLiveOwnerHierarchically(key, {
            eventPayload: opts.eventPayload,
            exactObligationOwner: null,
          });
        }
      }
    } else {
      ownerIds = this.resolveLiveOwnerHierarchically(key, {
        eventPayload: opts.eventPayload,
      });
    }

    const subscriberIds: string[] = [];
    if (!directed) {
      const subs = this.options.eventSourceSubscriptions.subscribersOf(key);
      for (const sub of subs) {
        if (this.options.isLive(sub.actorId) && !subscriberIds.includes(sub.actorId)) {
          subscriberIds.push(sub.actorId);
        }
      }
    }

    return {
      ownerId: ownerIds[0] ?? null,
      ownerIds,
      subscriberIds,
    };
  }

  private obligationOwnerFor(resource: string): string | undefined {
    if (!this.options.obligations) return undefined;
    const refKey = eventResourceObligationKey(resource);
    if (!refKey) return undefined;
    return this.options.obligations.findLiveByExternalRef(refKey)?.ownerId;
  }

  private resolveLiveOwnerHierarchically(
    resource: string,
    opts: {
      eventPayload?: InboxPayload;
      exactObligationOwner?: string | null;
    }
  ): string[] {
    let current: string | undefined = resource;
    let exact = true;

    while (current) {
      const governing =
        exact && opts.exactObligationOwner !== undefined
          ? (opts.exactObligationOwner ?? undefined)
          : this.obligationOwnerFor(current);
      exact = false;

      if (governing) {
        return this.options.isLive(governing) ? [governing] : [];
      }

      const activeSubs = this.options.eventSourceOwners.activeForResource(current);
      const liveSubs: string[] = [];
      for (const sub of activeSubs) {
        if (this.options.isLive(sub.actorId) && !liveSubs.includes(sub.actorId)) {
          liveSubs.push(sub.actorId);
        }
      }
      if (liveSubs.length > 0) {
        return liveSubs;
      }

      if (sameResource(current, resource)) {
        const allowParent = mayBubbleToParent(
          opts.eventPayload?.type,
          opts.eventPayload?.merged === true
        );
        if (!allowParent) {
          break;
        }
      }

      current = parentOf(current);
    }

    return [];
  }
}

export interface EventManagerOptions {
  inboxStore: InboxStore;
  resolver: EventSourceResolver;
  normalizer?: (event: RawIntegrationEvent) => NormalizedIntegrationEvent;
  onDelivered?: (
    entries: readonly InboxEntry[],
    event: NormalizedIntegrationEvent
  ) => void | Promise<void>;
  log?: (message: string) => void;
}

/**
 * EventManager is a sibling process component to ActorMesh.
 *
 * Responsibilities:
 * 1. Normalize external events from integrations (GitHub, Chat, timer, custom)
 *    into canonical inbox payload shapes while preserving public payloads.
 * 2. Apply event-source ownership and subscription rules to determine which
 *    actor(s) should receive an inbox item.
 * 3. Append deduplicated inbox items into the authoritative InboxStore.
 *
 * Strict invariant:
 * EventManager NEVER directly invokes actors, schedules wakes, or owns run state.
 * It ends its responsibility at durable inbox delivery.
 */
export class EventManager {
  private readonly inboxStore: InboxStore;
  private readonly resolver: EventSourceResolver;
  private readonly normalizer?: (event: RawIntegrationEvent) => NormalizedIntegrationEvent;
  private readonly onDelivered?: (
    entries: readonly InboxEntry[],
    event: NormalizedIntegrationEvent
  ) => void | Promise<void>;
  private readonly log?: (message: string) => void;

  constructor(
    inboxStoreOrOptions: InboxStore | EventManagerOptions,
    resolver?: EventSourceResolver,
    normalizer?: (event: RawIntegrationEvent) => NormalizedIntegrationEvent
  ) {
    if (
      inboxStoreOrOptions &&
      "append" in inboxStoreOrOptions &&
      typeof inboxStoreOrOptions.append === "function"
    ) {
      this.inboxStore = inboxStoreOrOptions as InboxStore;
      if (!resolver) {
        throw new Error("EventSourceResolver is required when passing InboxStore directly");
      }
      this.resolver = resolver;
      this.normalizer = normalizer;
    } else {
      const opts = inboxStoreOrOptions as EventManagerOptions;
      this.inboxStore = opts.inboxStore;
      this.resolver = opts.resolver;
      this.normalizer = opts.normalizer;
      this.onDelivered = opts.onDelivered;
      this.log = opts.log;
    }
  }

  /**
   * Normalizes an incoming integration event into the canonical payload shape
   * while preserving public payload contracts for existing consumers.
   */
  normalizeEvent(raw: RawIntegrationEvent): NormalizedIntegrationEvent {
    if (this.normalizer) {
      return this.normalizer(raw);
    }

    switch (raw.sourceType) {
      case "github":
        return this.normalizeGitHubEvent(raw);
      case "chat":
        return this.normalizeChatEvent(raw);
      case "timer":
        return this.normalizeTimerEvent(raw);
      default:
        return this.normalizeCustomEvent(raw);
    }
  }

  private normalizeGitHubEvent(raw: RawIntegrationEvent): NormalizedIntegrationEvent {
    const deliveredAt = raw.receivedAt;
    const p = raw.rawPayload;
    if (p != null && typeof p === "object") {
      const rec = p as Record<string, unknown>;

      // 1. Nested { event: string, payload: Record<string, unknown> } shape
      if (typeof rec.event === "string" && rec.payload != null && typeof rec.payload === "object") {
        const ghEvent = rec.event;
        const ghPayload = rec.payload as Record<string, unknown>;
        const notif = deriveGitHubInboxNotification(ghEvent, ghPayload);
        if (notif) {
          const payload: InboxPayload = { ...notif.payload };
          if (raw.priority === "responsive") payload.priority = "responsive";
          return {
            resource: raw.rawResource ? safeResourceKey(raw.rawResource) : notif.resource,
            payload,
            dedupeKey: raw.idempotencyKey,
            deliveredAt,
            priority: raw.priority,
            directedTarget: raw.directedTarget,
            stampedAuthor: raw.stampedAuthor,
            instanceId: raw.instanceId,
            eventSummary: raw.eventSummary,
          };
        }
      }

      // 2. Direct webhook payload containing repository object
      if (rec.repository != null && typeof rec.repository === "object") {
        let ghEvent = "unknown";
        if (rec.issue != null && rec.comment != null) ghEvent = "issue_comment";
        else if (rec.issue != null) ghEvent = "issues";
        else if (rec.pull_request != null) ghEvent = "pull_request";
        else if (rec.check_suite != null) ghEvent = "check_suite";
        else if (rec.check_run != null) ghEvent = "check_run";
        else if (rec.commits != null || rec.head_commit != null) ghEvent = "push";

        if (ghEvent !== "unknown") {
          const notif = deriveGitHubInboxNotification(ghEvent, rec);
          if (notif) {
            const payload: InboxPayload = { ...notif.payload };
            if (raw.priority === "responsive") payload.priority = "responsive";
            return {
              resource: raw.rawResource ? safeResourceKey(raw.rawResource) : notif.resource,
              payload,
              dedupeKey: raw.idempotencyKey,
              deliveredAt,
              priority: raw.priority,
              directedTarget: raw.directedTarget,
              stampedAuthor: raw.stampedAuthor,
              instanceId: raw.instanceId,
              eventSummary: raw.eventSummary,
            };
          }
        }
      }

      // 3. Pre-derived or explicit InboxPayload with string type
      if (typeof rec.type === "string") {
        const payload: InboxPayload = { ...rec, type: rec.type };
        if (raw.priority === "responsive") payload.priority = "responsive";
        return {
          resource: safeResourceKey(raw.rawResource ?? "github"),
          payload,
          dedupeKey: raw.idempotencyKey,
          deliveredAt,
          priority: raw.priority ?? (payload.priority === "responsive" ? "responsive" : undefined),
          directedTarget: raw.directedTarget,
          stampedAuthor: raw.stampedAuthor,
          instanceId: raw.instanceId,
          eventSummary: raw.eventSummary,
        };
      }
    }

    // 4. Default integration envelope for generic payloads
    const resource = safeResourceKey(raw.rawResource ?? "github");
    const payload: InboxPayload = {
      type: "github.event",
      sourceType: "github",
      rawResource: resource,
      rawPayload: raw.rawPayload,
      ...(raw.priority === "responsive" ? { priority: "responsive" } : {}),
    };
    return {
      resource,
      payload,
      dedupeKey: raw.idempotencyKey,
      deliveredAt,
      priority: raw.priority,
      directedTarget: raw.directedTarget,
      stampedAuthor: raw.stampedAuthor,
      instanceId: raw.instanceId,
      eventSummary: raw.eventSummary,
    };
  }

  private normalizeChatEvent(raw: RawIntegrationEvent): NormalizedIntegrationEvent {
    const p = raw.rawPayload;
    if (p != null && typeof p === "object") {
      const rec = p as Record<string, unknown>;
      const spaceName = typeof rec.spaceName === "string" ? rec.spaceName : undefined;
      const messageName =
        typeof rec.name === "string"
          ? rec.name
          : typeof rec.messageName === "string"
            ? rec.messageName
            : undefined;

      if (spaceName || messageName) {
        const cleanSpace = spaceName
          ? spaceName.startsWith("spaces/")
            ? spaceName
            : `spaces/${spaceName}`
          : "";
        const resource = raw.rawResource
          ? safeResourceKey(raw.rawResource)
          : cleanSpace
            ? `gchat:${cleanSpace}`
            : "gchat:spaces";
        const payload: InboxPayload = {
          type: typeof rec.type === "string" ? rec.type : "gchat.message",
          messageName: messageName ?? "",
          spaceName: spaceName ?? "",
          threadName: typeof rec.threadName === "string" ? rec.threadName : undefined,
          senderName: typeof rec.senderName === "string" ? rec.senderName : undefined,
          priority: "responsive",
        };
        const createTime =
          typeof rec.createTime === "string" ? new Date(rec.createTime) : undefined;
        return {
          resource,
          payload,
          dedupeKey: raw.idempotencyKey ?? messageName,
          deliveredAt: raw.receivedAt ?? createTime,
          priority: "responsive",
          directedTarget: raw.directedTarget,
          stampedAuthor: raw.stampedAuthor,
          instanceId: raw.instanceId,
          eventSummary: raw.eventSummary,
        };
      }

      if (typeof rec.type === "string") {
        const payload: InboxPayload = { ...rec, type: rec.type, priority: "responsive" };
        return {
          resource: safeResourceKey(raw.rawResource ?? "gchat:spaces"),
          payload,
          dedupeKey: raw.idempotencyKey,
          deliveredAt: raw.receivedAt,
          priority: "responsive",
          directedTarget: raw.directedTarget,
          stampedAuthor: raw.stampedAuthor,
          instanceId: raw.instanceId,
          eventSummary: raw.eventSummary,
        };
      }
    }

    const resource = safeResourceKey(raw.rawResource ?? "gchat:spaces");
    const payload: InboxPayload = {
      type: "chat.event",
      sourceType: "chat",
      rawResource: resource,
      rawPayload: raw.rawPayload,
      priority: "responsive",
    };
    return {
      resource,
      payload,
      dedupeKey: raw.idempotencyKey,
      deliveredAt: raw.receivedAt,
      priority: "responsive",
      directedTarget: raw.directedTarget,
      stampedAuthor: raw.stampedAuthor,
      instanceId: raw.instanceId,
      eventSummary: raw.eventSummary,
    };
  }

  private normalizeTimerEvent(raw: RawIntegrationEvent): NormalizedIntegrationEvent {
    const resource = safeResourceKey(raw.rawResource ?? "system:events");
    const priority = raw.priority ?? "responsive";
    const payloadPriority = priority === "responsive" ? "responsive" : undefined;
    let payload: InboxPayload;

    if (raw.rawPayload != null && typeof raw.rawPayload === "object") {
      const rec = raw.rawPayload as Record<string, unknown>;
      if (typeof rec.type === "string") {
        payload = {
          ...rec,
          type: rec.type,
          ...(payloadPriority ? { priority: payloadPriority } : {}),
        };
      } else {
        payload = {
          type: "timer.event",
          sourceType: "timer",
          rawResource: resource,
          rawPayload: raw.rawPayload,
          ...(payloadPriority ? { priority: payloadPriority } : {}),
        };
      }
    } else {
      payload = {
        type: "timer.event",
        sourceType: "timer",
        rawResource: resource,
        rawPayload: raw.rawPayload,
        ...(payloadPriority ? { priority: payloadPriority } : {}),
      };
    }

    return {
      resource,
      payload,
      dedupeKey: raw.idempotencyKey,
      deliveredAt: raw.receivedAt,
      priority,
      directedTarget: raw.directedTarget,
      stampedAuthor: raw.stampedAuthor,
      instanceId: raw.instanceId,
      eventSummary: raw.eventSummary,
    };
  }

  private normalizeCustomEvent(raw: RawIntegrationEvent): NormalizedIntegrationEvent {
    const resource = safeResourceKey(raw.rawResource ?? "system:events");
    let payload: InboxPayload;

    if (raw.rawPayload != null && typeof raw.rawPayload === "object") {
      const rec = raw.rawPayload as Record<string, unknown>;
      if (typeof rec.type === "string") {
        payload = { ...rec, type: rec.type };
        if (raw.priority === "responsive") payload.priority = "responsive";
      } else {
        payload = {
          type: "custom.event",
          sourceType: "custom",
          rawResource: resource,
          rawPayload: raw.rawPayload,
          ...(raw.priority === "responsive" ? { priority: "responsive" } : {}),
        };
      }
    } else {
      payload = {
        type: "custom.event",
        sourceType: "custom",
        rawResource: resource,
        rawPayload: raw.rawPayload,
        ...(raw.priority === "responsive" ? { priority: "responsive" } : {}),
      };
    }

    return {
      resource,
      payload,
      dedupeKey: raw.idempotencyKey,
      deliveredAt: raw.receivedAt,
      priority: raw.priority ?? (payload.priority === "responsive" ? "responsive" : undefined),
      directedTarget: raw.directedTarget,
      stampedAuthor: raw.stampedAuthor,
      instanceId: raw.instanceId,
      eventSummary: raw.eventSummary,
    };
  }

  /**
   * Delivers an external event by resolving recipients and committing durable
   * inbox rows. Actors are not invoked here; downstream components respond to
   * durable changes.
   */
  async handleExternalEvent(raw: RawIntegrationEvent): Promise<readonly InboxEntry[]> {
    // Drop non-actionable check_suite before delivery
    if (
      raw.sourceType === "github" &&
      raw.rawPayload != null &&
      typeof raw.rawPayload === "object"
    ) {
      const p = raw.rawPayload as Record<string, unknown>;
      const innerPayload =
        p.payload != null && typeof p.payload === "object"
          ? (p.payload as Record<string, unknown>)
          : p;
      const isCheckSuite = innerPayload.check_suite != null;
      const action = innerPayload.action;
      if (isCheckSuite && action === "completed" && !checkSuiteWakesAnyone(innerPayload)) {
        return [];
      }
    }

    const normalized = this.normalizeEvent(raw);
    const summary = normalized.eventSummary ?? normalized.resource;
    const recipients = await this.resolver.resolveRecipients(normalized.resource, {
      eventPayload: normalized.payload,
      directedTarget: normalized.directedTarget,
      eventSummary: normalized.eventSummary,
    });

    const ownerIds = recipients.ownerIds ?? (recipients.ownerId ? [recipients.ownerId] : []);
    const targetActorIds = new Set<string>();
    for (const id of ownerIds) {
      targetActorIds.add(id);
    }
    for (const sub of recipients.subscriberIds) {
      targetActorIds.add(sub);
    }

    if (targetActorIds.size === 0) {
      this.log?.(`event not covered by any subscription — dropped (${summary})`);
      return [];
    }

    // Author suppression: system events suppressed for all destinations; self events suppressed for author
    const directed = Boolean(
      normalized.directedTarget && ownerIds.includes(normalized.directedTarget)
    );
    if (!directed && normalized.stampedAuthor != null && normalized.instanceId !== undefined) {
      if (
        isSystemActor(normalized.stampedAuthor.actorId) &&
        normalized.stampedAuthor.instanceId === normalized.instanceId
      ) {
        this.log?.(
          `system-event suppressed by author stamp: actor=${normalized.stampedAuthor.actorId} instance=${normalized.instanceId} (${summary})`
        );
        return [];
      }
      if (
        targetActorIds.has(normalized.stampedAuthor.actorId) &&
        normalized.stampedAuthor.instanceId === normalized.instanceId
      ) {
        this.log?.(
          `self-event suppressed by author stamp: actor=${normalized.stampedAuthor.actorId} instance=${normalized.instanceId} (${summary})`
        );
        targetActorIds.delete(normalized.stampedAuthor.actorId);
      }
      if (targetActorIds.size === 0) {
        return [];
      }
    }

    const newItems: InboxAppendInput[] = [];
    for (const actorId of targetActorIds) {
      const id = normalized.dedupeKey
        ? deduplicatedInboxEntryId(normalized.dedupeKey, actorId)
        : undefined;
      newItems.push({
        id,
        actorId,
        source: normalized.resource,
        deliveredAt: normalized.deliveredAt,
        payload: normalized.payload,
      });
    }

    const entries = this.inboxStore.append(newItems);
    if (this.onDelivered) {
      await this.onDelivered(entries, normalized);
    }
    return entries;
  }
}
