import { randomUUID } from "node:crypto";
import type { FollowerEvent } from "./follower-hub.js";
import { FOLLOWER_HTTP_BODY_LIMIT_BYTES } from "./protocol.js";

interface FollowerEventBatch {
  batchId: string;
  events: FollowerEvent[];
}

/**
 * Retains outbound follower events until the leader has acknowledged them.
 * A second flush joins the in-flight delivery so terminal statuses cannot be
 * skipped while an earlier `/events` request is still pending.
 */
export class FollowerEventQueue {
  private readonly events: FollowerEvent[] = [];
  private pendingBatch: FollowerEventBatch | undefined;
  private inFlight: Promise<void> | undefined;

  enqueue(event: FollowerEvent): void {
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

  async flush(
    deliver: (batch: FollowerEventBatch) => Promise<void>,
    envelope: object = {}
  ): Promise<void> {
    if (this.inFlight) return this.inFlight;

    const delivery = this.deliverPending(deliver, envelope);
    this.inFlight = delivery;
    try {
      await delivery;
    } finally {
      if (this.inFlight === delivery) this.inFlight = undefined;
    }
  }

  private async deliverPending(
    deliver: (batch: FollowerEventBatch) => Promise<void>,
    envelope: object
  ): Promise<void> {
    while (this.pendingBatch || this.events.length) {
      if (!this.pendingBatch) {
        const batchId = randomUUID();
        let bytes = Buffer.byteLength(JSON.stringify({ ...envelope, batchId, events: [] }));
        let count = 0;
        for (const event of this.events.slice(0, 100)) {
          const eventBytes = Buffer.byteLength(JSON.stringify(event)) + (count > 0 ? 1 : 0);
          // Each indivisible event must fit the existing HTTP bound. Preserve it
          // intact; batch aggregation must never strand otherwise valid receipts.
          if (count > 0 && bytes + eventBytes > FOLLOWER_HTTP_BODY_LIMIT_BYTES) break;
          bytes += eventBytes;
          count++;
        }
        this.pendingBatch = { batchId, events: this.events.slice(0, count) };
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
