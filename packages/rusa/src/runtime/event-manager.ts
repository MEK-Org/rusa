import { createHash } from "node:crypto";
import { type EventResource, resourceKey } from "../actor/event-subscriptions.js";
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

export type IntegrationSourceType = "github" | "chat" | "timer";

export interface StampedAuthorInfo {
  actorId: string;
  instanceId: string;
}

interface RawEventMetadata {
  rawResource?: EventResource | string;
  receivedAt?: Date;
  idempotencyKey?: string;
  priority?: "responsive" | "normal";
  directedTarget?: string | null;
  stampedAuthor?: StampedAuthorInfo | null;
  instanceId?: string;
  eventSummary?: string;
}

/** The webhook server carries GitHub's event name separately from its body. */
export interface RawGitHubIntegrationEvent extends RawEventMetadata {
  sourceType: "github";
  rawPayload: { event: string; payload: Record<string, unknown> };
}

/** The Chat source exposes this source-backed message pointer after trigger filtering. */
export interface RawChatIntegrationEvent extends RawEventMetadata {
  sourceType: "chat";
  rawPayload: {
    name: string;
    spaceName: string;
    threadName?: string;
    senderName?: string;
    createTime?: string;
  };
}

/** Timer ingress already owns a canonical payload; EventManager adds routing and durability. */
export interface RawTimerIntegrationEvent extends RawEventMetadata {
  sourceType: "timer";
  rawPayload: InboxPayload;
}

export type RawIntegrationEvent =
  | RawGitHubIntegrationEvent
  | RawChatIntegrationEvent
  | RawTimerIntegrationEvent;

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

/**
 * Recipient resolution is deliberately synchronous. Delivery depends on a
 * same-turn invariant: recipient liveness, durable append, and the caller's
 * wake must not be separated by an await, or an actor can retire after being
 * selected as live and leave a durable unhandled row nobody is alive to take
 * (`InboxRepository.append` validates only non-empty ids, and the inbox table
 * has no actor foreign key). Every read port behind this is a synchronous
 * in-memory or better-sqlite3 read, so a promise here would buy nothing and
 * cost the invariant.
 */
export interface EventSourceResolver {
  resolveRecipients(
    resource: EventResource | string,
    options?: ResolveRecipientsOptions
  ): EventSourceRecipients;
}

/** Narrow read-only ports owned by the runtime assembly. */
export interface EventRoutingReadPorts {
  parentOf: (resource: EventResource) => EventResource | undefined;
  isLive: (actorId: string) => boolean;
  activeDelegationsFor: (resource: EventResource) => readonly { actorId: string }[];
  directSubscribersFor: (resource: EventResource) => readonly { actorId: string }[];
  governingObligationOwnerFor: (resource: EventResource) => string | undefined;
  resolveActor?: (handleOrId: string) => { id: string } | undefined;
}

export interface HierarchicalEventSourceResolverOptions {
  ports: EventRoutingReadPorts;
  log?: (message: string) => void;
}

export interface ResolveOwnerOptions {
  ignoreExactResource?: EventResource;
  eventPayload?: InboxPayload;
  enforceBubblingPolicy?: boolean;
  /** A precomputed exact-resource lookup; `null` means it found no claim. */
  exactObligationOwner?: string | null;
}

export interface EventSourceOwnershipDiagnostic {
  resource: EventResource;
  governingSource: "obligation" | "subscription" | null;
  principal: string | null;
  resourceLevel: EventResource | null;
  isLive: boolean;
}

export interface EventSourceOwnerResolution {
  diagnostic: EventSourceOwnershipDiagnostic;
  ownerIds: string[];
}

/** One ownership ladder shared by delivery and ActorMesh authority checks. */
export interface EventRoutingKernel extends EventSourceResolver {
  resolveOwner(
    resource: EventResource | string,
    options?: ResolveOwnerOptions
  ): EventSourceOwnerResolution;
}

/**
 * Resolves event recipients following hierarchical event-source rules:
 * obligation claims take precedence over explicit subscriptions, live owners
 * govern, allowlisted events bubble up ancestor resources, direct subscribers
 * receive exact-resource events, and directives target specific live actors.
 */
export class HierarchicalEventSourceResolver implements EventRoutingKernel {
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
      const governing = this.options.ports.governingObligationOwnerFor(key);
      if (governing) {
        ownerIds = this.options.ports.isLive(governing) ? [governing] : [];
      } else {
        const target = this.options.ports.resolveActor?.(opts.directedTarget);
        if (target && this.options.ports.isLive(target.id)) {
          this.options.log?.(
            `mesh:deliver directed-delivered to ${opts.directedTarget} (${summary})`
          );
          ownerIds = [target.id];
          directed = true;
        } else {
          this.options.log?.(
            `mesh:deliver target not live: ${opts.directedTarget} — directive ignored`
          );
          ownerIds = this.resolveOwner(key, {
            eventPayload: opts.eventPayload,
            enforceBubblingPolicy: true,
            exactObligationOwner: null,
          }).ownerIds;
        }
      }
    } else {
      ownerIds = this.resolveOwner(key, {
        eventPayload: opts.eventPayload,
        enforceBubblingPolicy: true,
      }).ownerIds;
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
      const subs = this.options.ports.directSubscribersFor(key);
      for (const sub of subs) {
        if (this.options.ports.isLive(sub.actorId) && !subscriberIds.includes(sub.actorId)) {
          subscriberIds.push(sub.actorId);
        }
      }
    }

    return { directed, ownerIds, subscriberIds };
  }

  resolveOwner(
    resource: EventResource | string,
    opts: ResolveOwnerOptions = {}
  ): EventSourceOwnerResolution {
    const key = safeResourceKey(resource);
    const ignoredExactResource = opts.ignoreExactResource
      ? safeResourceKey(opts.ignoreExactResource)
      : undefined;
    let current: EventResource | undefined = key;
    let exact = true;

    while (current) {
      const governing =
        exact && opts.exactObligationOwner !== undefined
          ? (opts.exactObligationOwner ?? undefined)
          : this.options.ports.governingObligationOwnerFor(current);
      exact = false;

      if (governing) {
        const isLive = this.options.ports.isLive(governing);
        return {
          diagnostic: {
            resource: key,
            governingSource: "obligation",
            principal: governing,
            resourceLevel: current,
            isLive,
          },
          ownerIds: isLive ? [governing] : [],
        };
      }

      const activeSubs = this.options.ports.activeDelegationsFor(current);
      const liveSubs: string[] = [];
      for (const sub of activeSubs) {
        if (current === ignoredExactResource) continue;
        if (this.options.ports.isLive(sub.actorId) && !liveSubs.includes(sub.actorId)) {
          liveSubs.push(sub.actorId);
        }
      }
      if (liveSubs.length > 0) {
        return {
          diagnostic: {
            resource: key,
            governingSource: "subscription",
            principal: liveSubs[0] ?? null,
            resourceLevel: current,
            isLive: true,
          },
          ownerIds: liveSubs,
        };
      }

      if (current === key && opts.enforceBubblingPolicy) {
        const allowParent = mayBubbleToParent(
          opts.eventPayload?.type,
          opts.eventPayload?.merged === true
        );
        if (!allowParent) {
          break;
        }
      }

      current = this.options.ports.parentOf(current);
    }

    return {
      diagnostic: {
        resource: key,
        governingSource: null,
        principal: null,
        resourceLevel: null,
        isLive: false,
      },
      ownerIds: [],
    };
  }
}

export interface EventManagerOptions {
  inboxStore: InboxStore;
  /**
   * The one routing kernel assembled by the host. EventManager re-exposes it as
   * {@link EventManager.routing} so a mesh cannot be handed a second, competing
   * ladder alongside this one.
   */
  resolver: EventRoutingKernel;
  log?: (message: string) => void;
}

/**
 * EventManager is a sibling process component to ActorMesh.
 *
 * Responsibilities:
 * 1. Normalize external events from the live GitHub, Chat, and timer ingress
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
  /**
   * The host-assembled ownership ladder, readable by collaborators that need
   * routing authority (ActorMesh's delegation guards and audit inspection).
   * Exposing the manager's own kernel is what makes "two authoritative
   * policies in one process" unrepresentable rather than merely unconventional.
   */
  readonly routing: EventRoutingKernel;
  private readonly log?: (message: string) => void;

  constructor(options: EventManagerOptions) {
    this.inboxStore = options.inboxStore;
    this.routing = options.resolver;
    this.log = options.log;
  }

  /**
   * Normalizes an incoming integration event into the canonical payload shape
   * while preserving public payload contracts for existing consumers.
   */
  normalizeEvent(raw: RawIntegrationEvent): NormalizedIntegrationEvent | null {
    switch (raw.sourceType) {
      case "github":
        return this.normalizeGitHubEvent(raw);
      case "chat":
        return this.normalizeChatEvent(raw);
      case "timer":
        return this.normalizeTimerEvent(raw);
    }
  }

  private normalizeGitHubEvent(raw: RawGitHubIntegrationEvent): NormalizedIntegrationEvent | null {
    const { event, payload: githubPayload } = raw.rawPayload;
    // GitHub's event name is an ingress fact, never inferred from overlapping
    // payload keys. `pull_request_review` and `pull_request_review_comment`,
    // for example, both carry `pull_request`.
    if (
      event === "check_suite" &&
      githubPayload.action === "completed" &&
      !checkSuiteWakesAnyone(githubPayload)
    ) {
      this.log?.(`non-actionable check suite dropped (${raw.eventSummary ?? event})`);
      return null;
    }
    const notification = deriveGitHubInboxNotification(event, githubPayload);
    if (!notification) {
      // This is the same error the former start.ts ingress raised after it had
      // accepted a repository-backed webhook but could not derive its durable
      // source pointer.
      throw new Error("GitHub event repository could not be resolved");
    }
    const payload: InboxPayload = { ...notification.payload };
    if (raw.priority === "responsive") payload.priority = "responsive";
    return {
      resource: raw.rawResource ? safeResourceKey(raw.rawResource) : notification.resource,
      payload,
      dedupeKey: raw.idempotencyKey,
      deliveredAt: raw.receivedAt,
      directedTarget: raw.directedTarget,
      stampedAuthor: raw.stampedAuthor,
      instanceId: raw.instanceId,
      eventSummary: raw.eventSummary,
    };
  }

  private normalizeChatEvent(raw: RawChatIntegrationEvent): NormalizedIntegrationEvent {
    const message = raw.rawPayload;
    const spaceName = message.spaceName.startsWith("spaces/")
      ? message.spaceName
      : `spaces/${message.spaceName}`;
    const resource = raw.rawResource ? safeResourceKey(raw.rawResource) : `gchat:${spaceName}`;
    const payload: InboxPayload = {
      type: "gchat.message",
      messageName: message.name,
      spaceName: message.spaceName,
      threadName: message.threadName,
      senderName: message.senderName,
      priority: "responsive",
    };
    return {
      resource,
      payload,
      dedupeKey: raw.idempotencyKey ?? message.name,
      deliveredAt:
        raw.receivedAt ?? (message.createTime ? new Date(message.createTime) : undefined),
      directedTarget: raw.directedTarget,
      stampedAuthor: raw.stampedAuthor,
      instanceId: raw.instanceId,
      eventSummary: raw.eventSummary,
    };
  }

  private normalizeTimerEvent(raw: RawTimerIntegrationEvent): NormalizedIntegrationEvent {
    const resource = safeResourceKey(raw.rawResource ?? "system:events");
    const priority = raw.priority ?? "responsive";
    const payload: InboxPayload = {
      ...raw.rawPayload,
      ...(priority === "responsive" ? { priority: "responsive" } : {}),
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

  /**
   * Delivers an external event by resolving recipients and committing durable
   * inbox rows. Actors are not invoked here; downstream components respond to
   * durable changes.
   */
  handleExternalEvent(raw: RawIntegrationEvent): readonly InboxEntry[] {
    const normalized = this.normalizeEvent(raw);
    if (!normalized) return [];
    return this.handleNormalizedEvent(normalized);
  }

  /**
   * Routes and durably appends an already-canonical payload. This preserves the
   * legacy ActorMesh delivery contract without inventing a fourth ingress
   * normalizer branch.
   */
  handleNormalizedEvent(normalized: NormalizedIntegrationEvent): readonly InboxEntry[] {
    const summary = normalized.eventSummary ?? normalized.resource;
    const recipients = this.routing.resolveRecipients(normalized.resource, {
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
