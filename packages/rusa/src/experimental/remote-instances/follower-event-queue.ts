import { randomUUID } from "node:crypto";

export interface FollowerEventBatch<T> {
  batchId: string;
  events: T[];
}

/**
 * Retains outbound follower events until the leader has acknowledged them.
 * A second flush joins the in-flight delivery so terminal statuses cannot be
 * skipped while an earlier `/events` request is still pending.
 */
export class FollowerEventQueue<T> {
  private readonly events: T[] = [];
  private pendingBatch: FollowerEventBatch<T> | undefined;
  private inFlight: Promise<void> | undefined;

  enqueue(event: T): void {
    this.events.push(event);
  }

  get hasPending(): boolean {
    return this.pendingBatch !== undefined || this.events.length > 0;
  }

  get isFlushing(): boolean {
    return this.inFlight !== undefined;
  }

  clear(): void {
    this.pendingBatch = undefined;
    this.events.length = 0;
  }

  async flush(deliver: (batch: FollowerEventBatch<T>) => Promise<void>): Promise<void> {
    if (this.inFlight) return this.inFlight;

    const delivery = this.deliverPending(deliver);
    this.inFlight = delivery;
    try {
      await delivery;
    } finally {
      if (this.inFlight === delivery) this.inFlight = undefined;
    }
  }

  private async deliverPending(
    deliver: (batch: FollowerEventBatch<T>) => Promise<void>
  ): Promise<void> {
    while (this.pendingBatch || this.events.length) {
      if (!this.pendingBatch) {
        const count = Math.min(this.events.length, 100);
        this.pendingBatch = {
          batchId: randomUUID(),
          events: this.events.slice(0, count),
        };
      }
      const batch = this.pendingBatch;
      await deliver(batch);
      // A leader-incarnation fence may clear the queue while its final old
      // request is in flight. In that case, never acknowledge or splice a
      // newer queue using the old batch's length.
      if (this.pendingBatch !== batch) continue;
      this.events.splice(0, batch.events.length);
      this.pendingBatch = undefined;
    }
  }
}
