/**
 * A durably-owned scheduled message awaiting delivery. `id` is the one stable
 * identity that correlates this row with its OS scheduler job, its
 * `message_sent`/`message_received` mesh events (`${id}:sent`/`${id}:received`),
 * its `mesh_chat` row, and its inbox entry — see {@link ScheduledDeliveryStore}.
 */
export interface ScheduledDelivery {
  id: string;
  toId: string;
  fromId: string;
  body: string;
  deliverAt: string;
  sessionId?: string;
}

/**
 * Persistence boundary for scheduled (future-dated) actor-to-actor messages —
 * mirrors {@link ThreadRegistry}/{@link CapabilityGrantStore}: a normalized
 * SQLite table in production ({@link ScheduledMessageRepository}), in-memory for
 * tests. Deliberately NOT coupled to `ThreadRecord` or the `actors` table (#175
 * has not imported/switched actor authority yet) — a scheduled delivery outlives
 * the mesh's in-process view of its recipient across a restart on its own.
 */
export interface ScheduledDeliveryStore {
  /** Durably accept a scheduled delivery. Idempotent on `id`. */
  insert(delivery: ScheduledDelivery): void;
  /** Remove a delivered, dropped, or rolled-back scheduled delivery. No-op if absent. */
  remove(id: string): void;
  /** Fetch a single scheduled delivery by id, or `undefined` if absent. */
  get(id: string): ScheduledDelivery | undefined;
  /** Every scheduled delivery addressed to `recipientId` — for the cap check and retire cleanup. */
  listForRecipient(recipientId: string): ScheduledDelivery[];
  /** Count of deliveries addressed to `recipientId` — the cap-of-10 check. */
  countForRecipient(recipientId: string): number;
  /** Every scheduled delivery, in no particular order — boot reconciliation and `list_pending_messages`. */
  listAll(): ScheduledDelivery[];
}

/** In-memory scheduled-delivery store — the default, and what tests use. */
export class InMemoryScheduledDeliveryStore implements ScheduledDeliveryStore {
  private readonly deliveries = new Map<string, ScheduledDelivery>();

  insert(delivery: ScheduledDelivery): void {
    if (this.deliveries.has(delivery.id)) return;
    this.deliveries.set(delivery.id, { ...delivery });
  }

  remove(id: string): void {
    this.deliveries.delete(id);
  }

  get(id: string): ScheduledDelivery | undefined {
    const found = this.deliveries.get(id);
    return found ? { ...found } : undefined;
  }

  listForRecipient(recipientId: string): ScheduledDelivery[] {
    return this.listAll().filter((d) => d.toId === recipientId);
  }

  countForRecipient(recipientId: string): number {
    return this.listForRecipient(recipientId).length;
  }

  listAll(): ScheduledDelivery[] {
    return [...this.deliveries.values()].map((d) => ({ ...d }));
  }
}
