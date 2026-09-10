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
import { deriveGitHubInboxNotification } from "../github/inbox-notification.js";
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
  directedTarget?: string | null;
  stampedAuthor?: StampedAuthorInfo | null;
  instanceId?: string;
  eventSummary?: string;
}

export interface EventSourceRecipients {
  /**
   * True only when a directive named a live actor and that actor became the
   * sole owner — the resolver's own answer, never re-derived by a consumer.
   *
   * A consumer cannot reconstruct this from {@link ownerIds}: a directive names
   * a *handle*, while `ownerIds` carries resolved actor *ids*, so string
   * equality against the raw target misses every landed handle directive and
   * falsely matches a governing obligation whose owner happens to equal an
   * id-form target. Two rules read this flag — subscribers do not compose with
   * a landed directive, and only a landed directive earns the author
   * suppression exemption — so a wrong answer changes delivery both ways.
   */
  directed: boolean;
  /**
   * Live owners in ladder order, empty when ownership resolved to nobody.
   * Subscribers compose on top of this rather than displacing it.
   */
  ownerIds: readonly string[];
  subscriberIds: readonly string[];
}

export interface AuthorSuppressionInput {
  /** The resolver's own answer, not a re-derivation. See {@link EventSourceRecipients.directed}. */
  directed: boolean;
  /** Candidate destinations in delivery order. */
  destinations: readonly string[];
  stampedAuthor?: StampedAuthorInfo | null;
  instanceId?: string;
  eventSummary: string;
  log?: (message: string) => void;
}

/**
 * Filters destinations an author stamp says should not be woken, preserving
 * input order.
 *
 * A verified `system:*` stamp marks a persistence-only write performed by mesh
 * infrastructure rather than a peer actor — it withholds delivery to EVERY
 * destination, not just an author-match. Only a verified stamp may trigger
 * this (`stampedAuthor` only exists when `resolveStampedAuthor`'s HMAC +
 * freshness checks passed in `start.ts`); an unverified or stale
 * system-looking stamp resolves to null upstream and falls through to the
 * ordinary per-destination checks, so it still fails open and delivers.
 *
 * A landed directive is exempt from both arms: a valid bot-authored
 * `mesh:deliver` directive intentionally targets the actor even though the
 * underlying bot event would otherwise self-suppress.
 *
 * Single-sourced deliberately — the durable path in
 * {@link EventManager.handleExternalEvent} and the payload-less path in
 * `ActorMesh.deliverEvent` are the same rule, and a second copy is how the
 * two silently drift into disagreeing about who gets woken.
 */
export function applyAuthorSuppression(input: AuthorSuppressionInput): string[] {
  const { directed, destinations, stampedAuthor, instanceId, eventSummary, log } = input;
  if (directed || stampedAuthor == null || instanceId === undefined) {
    return [...destinations];
  }

  if (isSystemActor(stampedAuthor.actorId) && stampedAuthor.instanceId === instanceId) {
    log?.(
      `system-event suppressed by author stamp: actor=${stampedAuthor.actorId} instance=${stampedAuthor.instanceId} (${eventSummary})`
    );
    return [];
  }

  const deliverable: string[] = [];
  for (const dest of destinations) {
    if (stampedAuthor.actorId === dest && stampedAuthor.instanceId === instanceId) {
      log?.(
        `self-event suppressed by author stamp: actor=${stampedAuthor.actorId} instance=${stampedAuthor.instanceId} (${eventSummary})`
      );
      continue;
    }
    deliverable.push(dest);
  }
  return deliverable;
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

    // Direct subscribers are added to whatever ownership resolved to — the two
    // relationships compose rather than compete. A subscriber is added even when
    // ownership resolved to nobody (an obligation held by a human, an absent
    // owner, a source no live actor owns), and never displaces the owner when it
    // did. The exact resource only: a subscription does not bubble.
    //
    // A *successfully targeted* delivery is the one case where this does not
    // apply. A verified bot directive names the single actor an event is for;
    // fanning it out to subscribers would make `mesh:deliver` mean something
    // other than what it says.
    //
    // Read `directed` precisely: it is set only on that happy path. A directive
    // overridden by a live obligation, or one naming a target that is no longer
    // live, resolves ownership normally and still reaches subscribers. That is
    // deliberate rather than incidental — a standing interest in a source's
    // direct events is not defeated by a directive aimed at someone else, or by
    // one that failed to land. Those paths also leave `directed` false for the
    // author-suppression exemption in {@link applyAuthorSuppression}, which only
    // a landed directive earns.
    const subscriberIds: string[] = [];
    if (!directed) {
      const subs = this.options.eventSourceSubscriptions.subscribersOf(key);
      for (const sub of subs) {
        if (this.options.isLive(sub.actorId) && !subscriberIds.includes(sub.actorId)) {
          subscriberIds.push(sub.actorId);
        }
      }
    }

    return { directed, ownerIds, subscriberIds };
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
  private readonly log?: (message: string) => void;

  constructor(options: EventManagerOptions) {
    this.inboxStore = options.inboxStore;
    this.resolver = options.resolver;
    this.log = options.log;
  }

  /**
   * Normalizes an incoming integration event into the canonical payload shape
   * while preserving public payload contracts for existing consumers.
   */
  normalizeEvent(raw: RawIntegrationEvent): NormalizedIntegrationEvent {
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

      // 1. Explicit { event: string, payload: Record<string, unknown> } envelope.
      //
      // The event name is carried, never guessed. Inferring it from which keys
      // a payload happens to have cannot distinguish GitHub's own overlapping
      // shapes — `pull_request_review` and `pull_request_review_comment` both
      // carry `pull_request`, and would both be mislabelled `pull_request` —
      // so an ingress that knows its event name states it here.
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
            directedTarget: raw.directedTarget,
            stampedAuthor: raw.stampedAuthor,
            instanceId: raw.instanceId,
            eventSummary: raw.eventSummary,
          };
        }
      }

      // 2. Pre-derived or explicit InboxPayload with string type
      if (typeof rec.type === "string") {
        const payload: InboxPayload = { ...rec, type: rec.type };
        if (raw.priority === "responsive") payload.priority = "responsive";
        return {
          resource: safeResourceKey(raw.rawResource ?? "github"),
          payload,
          dedupeKey: raw.idempotencyKey,
          deliveredAt,
          directedTarget: raw.directedTarget,
          stampedAuthor: raw.stampedAuthor,
          instanceId: raw.instanceId,
          eventSummary: raw.eventSummary,
        };
      }
    }

    // 3. Default integration envelope for generic payloads
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
    const normalized = this.normalizeEvent(raw);
    const summary = normalized.eventSummary ?? normalized.resource;
    const recipients = await this.resolver.resolveRecipients(normalized.resource, {
      eventPayload: normalized.payload,
      directedTarget: normalized.directedTarget,
      eventSummary: normalized.eventSummary,
    });

    // Owners first, then subscribers — an explicit ordered array rather than a
    // Set, so delivery order is a property of this code instead of an unwritten
    // dependency on Set iteration semantics.
    const destinations: string[] = [];
    for (const id of recipients.ownerIds) {
      if (!destinations.includes(id)) destinations.push(id);
    }
    for (const sub of recipients.subscriberIds) {
      if (!destinations.includes(sub)) destinations.push(sub);
    }

    if (destinations.length === 0) {
      // Invariant this drop relies on (#369 review): root retains a covering
      // source for anything it delegates from (config-declared sources persist;
      // delegation only adds child sub-slices). So a live event that's in-scope
      // always matches an ancestor source before reaching here — an uncovered
      // event is genuinely out-of-scope for this instance, and dropping it
      // (journal-visible) is correct rather than a silent loss. If a future
      // change ever lets root delegate away its only covering source for a
      // slice, events under it would hit this drop when the delegate dies —
      // still visible here, but the invariant is what keeps that from happening.
      this.log?.(`event not covered by any subscription — dropped (${summary})`);
      return [];
    }

    const deliverable = applyAuthorSuppression({
      directed: recipients.directed,
      destinations,
      stampedAuthor: normalized.stampedAuthor,
      instanceId: normalized.instanceId,
      eventSummary: summary,
      log: this.log,
    });
    if (deliverable.length === 0) return [];

    const newItems: InboxAppendInput[] = deliverable.map((actorId) => ({
      id: normalized.dedupeKey
        ? deduplicatedInboxEntryId(normalized.dedupeKey, actorId)
        : undefined,
      actorId,
      source: normalized.resource,
      deliveredAt: normalized.deliveredAt,
      payload: normalized.payload,
    }));

    const entries = this.inboxStore.append(newItems);
    // The append result is what wakes actors downstream, so it is checked
    // against the recipients this component actually computed. Routing now
    // happens behind a component boundary; without this, a suppression or
    // resolution bug here would silently wake whoever the store returned
    // instead of failing loudly at the seam that produced the mistake.
    for (const entry of entries) {
      if (!deliverable.includes(entry.actorId)) {
        throw new Error(`Inbox append returned an unexpected actor: ${entry.actorId}`);
      }
    }
    return entries;
  }
}
