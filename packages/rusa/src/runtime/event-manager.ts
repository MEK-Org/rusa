import type { InboxAppendInput, InboxEntry, InboxPayload } from "../actor/inbox-store.js";
import type { InboxRepository } from "../repositories/inbox-repository.js";

export interface RawIntegrationEvent {
  sourceType: "github" | "chat" | "timer" | "custom";
  rawResource: string;
  rawPayload: unknown;
  receivedAt?: Date;
  idempotencyKey?: string;
  priority?: "responsive";
}

export interface NormalizedIntegrationEvent {
  resource: string;
  payload: InboxPayload;
  dedupeKey?: string;
  deliveredAt: Date;
}

export interface EventSourceResolver {
  resolveRecipients(resource: string): Promise<{
    ownerId: string | null;
    subscriberIds: readonly string[];
  }>;
}

/**
 * EventManager is a sibling process component to ActorMesh.
 *
 * Responsibilities:
 * 1. Normalize external events from integrations into rusa-shaped events.
 * 2. Apply event source ownership and subscription rules to determine which
 *    actor(s) should receive an inbox item.
 * 3. Append deduplicated inbox items into the authoritative InboxRepository.
 *
 * Strict invariant:
 * EventManager NEVER directly invokes actors or schedules runs. It ends its
 * responsibility at durable inbox delivery.
 */
export class EventManager {
  constructor(
    private readonly inboxRepository: InboxRepository,
    private readonly resolver: EventSourceResolver,
    private readonly normalizer?: (event: RawIntegrationEvent) => NormalizedIntegrationEvent
  ) {}

  /**
   * Normalizes an incoming integration event into the canonical payload shape.
   */
  normalizeEvent(raw: RawIntegrationEvent): NormalizedIntegrationEvent {
    if (this.normalizer) {
      return this.normalizer(raw);
    }

    const deliveredAt = raw.receivedAt ?? new Date();
    const payload: InboxPayload = {
      type: `${raw.sourceType}.event`,
      sourceType: raw.sourceType,
      rawResource: raw.rawResource,
      rawPayload: raw.rawPayload,
      ...(raw.priority === "responsive" ? { priority: "responsive" } : {}),
    };

    return {
      resource: raw.rawResource,
      payload,
      dedupeKey: raw.idempotencyKey,
      deliveredAt,
    };
  }

  /**
   * Delivers an external event by resolving recipients and committing durable
   * inbox rows. Actors are not invoked here; the downstream mesh and run manager
   * respond to durable changes.
   */
  async handleExternalEvent(raw: RawIntegrationEvent): Promise<readonly InboxEntry[]> {
    const normalized = this.normalizeEvent(raw);
    const { ownerId, subscriberIds } = await this.resolver.resolveRecipients(normalized.resource);

    const targetActorIds = new Set<string>();
    if (ownerId) targetActorIds.add(ownerId);
    for (const sub of subscriberIds) {
      targetActorIds.add(sub);
    }

    if (targetActorIds.size === 0) {
      return [];
    }

    const newItems: InboxAppendInput[] = [];
    for (const actorId of targetActorIds) {
      const id = normalized.dedupeKey ? `dedupe:${normalized.dedupeKey}:${actorId}` : undefined;
      newItems.push({
        id,
        actorId,
        source: normalized.resource,
        deliveredAt: normalized.deliveredAt,
        payload: normalized.payload,
      });
    }

    return this.inboxRepository.append(newItems);
  }
}
