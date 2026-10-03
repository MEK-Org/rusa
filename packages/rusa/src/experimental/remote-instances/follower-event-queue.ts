import { createHash, randomUUID } from "node:crypto";
import type { FollowerEvent } from "./follower-hub.js";
import {
  EVENT_TRANSFER_CAPABILITY,
  type EventTransferCapability,
  type EventTransferFragment,
  type EventTransferReply,
  FOLLOWER_EVENT_BATCH_MAX_EVENTS,
  FOLLOWER_HTTP_BODY_LIMIT_BYTES,
} from "./protocol.js";

interface FollowerEventBatch {
  batchId: string;
  events: FollowerEvent[];
}

/** Sends one fragment to a leader that advertised `capability` (#876). */
export interface FollowerEventTransferSender {
  capability: EventTransferCapability;
  send(fragment: EventTransferFragment): Promise<EventTransferReply>;
}

interface PendingTransfer {
  event: FollowerEvent;
  transferId: string;
  /** The original serialized event, frozen for every attempt and restart. */
  bytes: Buffer;
  digest: string;
  fragmentBytes: number;
  index: number;
  offset: number;
}

/**
 * The head event cannot be sent until the leader's capability, configuration
 * or an operator changes. Later events stay queued behind it. Carries only
 * identities, sizes and limits.
 */
export class FollowerEventParkedError extends Error {
  constructor(
    readonly reason: string,
    readonly eventId: string,
    readonly eventType: string,
    readonly eventBytes: number,
    readonly limitBytes: number | undefined,
    /** False only the first time this event parks for this reason. */
    readonly repeated: boolean
  ) {
    super(`Follower event ${eventId} parked: ${reason}`);
    this.name = "FollowerEventParkedError";
  }
}

/**
 * The leader's receiver failed while accepting one member of an ordinary
 * batch. Events before it were accepted; it and later events were not.
 */
export class FollowerEventAcceptanceFailedError extends Error {
  constructor(readonly eventId: string) {
    super(`Follower event ${eventId} failed leader acceptance`);
    this.name = "FollowerEventAcceptanceFailedError";
  }
}

/** The leader asked the transfer to back off or restart; retry the same event later. */
export class FollowerEventTransferRetryError extends Error {
  constructor(
    readonly reason: string,
    readonly retryAfterMs: number
  ) {
    super(`Follower event transfer retry: ${reason}`);
    this.name = "FollowerEventTransferRetryError";
  }
}

const BUSY_RETRY_MS = 5_000;
const ACCEPTANCE_FAILED = "acceptance_failed";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Retains outbound follower events until the leader has acknowledged them.
 * A second flush joins the in-flight delivery so terminal statuses cannot be
 * skipped while an earlier `/events` request is still pending.
 *
 * Ordinary batches are the largest FIFO prefix whose complete request fits the
 * gateway's body limit. A head event too large for any batch is sent alone by
 * negotiated transfer, and stays the head until the leader reports it complete.
 */
export class FollowerEventQueue {
  private readonly events: FollowerEvent[] = [];
  private readonly serializedBytes = new WeakMap<FollowerEvent, number>();
  private pendingBatch: FollowerEventBatch | undefined;
  private pendingTransfer: PendingTransfer | undefined;
  private inFlight: Promise<void> | undefined;
  private parkedKey: string | undefined;
  /** A leader refusal holds until a new capability (a new registration) arrives. */
  private refused:
    | { event: FollowerEvent; capability: EventTransferCapability; reason: string; limit?: number }
    | undefined;
  /**
   * The leader recorded a failed acceptance for this event. Resending cannot
   * change that within the leader's incarnation, so it stays the parked head
   * until the queue is cleared.
   */
  private acceptanceFailed: FollowerEvent | undefined;

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
    this.pendingTransfer = undefined;
    this.parkedKey = undefined;
    this.refused = undefined;
    this.acceptanceFailed = undefined;
    this.events.length = 0;
  }

  async flush(
    deliver: (batch: FollowerEventBatch) => Promise<void>,
    envelope: object = {},
    transfer?: FollowerEventTransferSender
  ): Promise<void> {
    if (this.inFlight) return this.inFlight;

    const delivery = this.deliverPending(deliver, envelope, transfer);
    this.inFlight = delivery;
    try {
      await delivery;
    } finally {
      if (this.inFlight === delivery) this.inFlight = undefined;
    }
  }

  private eventBytes(event: FollowerEvent): number {
    let bytes = this.serializedBytes.get(event);
    if (bytes === undefined) {
      bytes = Buffer.byteLength(JSON.stringify(event));
      this.serializedBytes.set(event, bytes);
    }
    return bytes;
  }

  private async deliverPending(
    deliver: (batch: FollowerEventBatch) => Promise<void>,
    envelope: object,
    transfer: FollowerEventTransferSender | undefined
  ): Promise<void> {
    while (this.pendingBatch || this.pendingTransfer || this.events.length) {
      if (!this.pendingBatch && !this.pendingTransfer) {
        if (this.acceptanceFailed && this.events[0] === this.acceptanceFailed) {
          return this.park(this.acceptanceFailed, ACCEPTANCE_FAILED);
        }
        const batchId = randomUUID();
        let bytes = Buffer.byteLength(JSON.stringify({ ...envelope, batchId, events: [] }));
        let count = 0;
        for (const event of this.events.slice(0, FOLLOWER_EVENT_BATCH_MAX_EVENTS)) {
          const eventBytes = this.eventBytes(event) + (count > 0 ? 1 : 0);
          if (bytes + eventBytes > FOLLOWER_HTTP_BODY_LIMIT_BYTES) break;
          bytes += eventBytes;
          count++;
        }
        if (count > 0) this.pendingBatch = { batchId, events: this.events.slice(0, count) };
        else this.pendingTransfer = this.startTransfer(this.events[0] as FollowerEvent, transfer);
      }
      if (this.pendingTransfer) {
        await this.sendFragment(this.pendingTransfer, envelope, transfer);
        continue;
      }
      const batch = this.pendingBatch as FollowerEventBatch;
      try {
        await deliver(batch);
      } catch (error) {
        if (!(error instanceof FollowerEventAcceptanceFailedError)) throw error;
        if (this.pendingBatch !== batch) continue;
        const failedAt = batch.events.findIndex((event) => event.eventId === error.eventId);
        if (failedAt < 0) throw error;
        // The accepted prefix is acknowledged; the failed member and everything
        // after it stay queued, in order, with their original bytes.
        this.events.splice(0, failedAt);
        this.pendingBatch = undefined;
        this.acceptanceFailed = batch.events[failedAt];
        continue;
      }
      // A leader-incarnation fence may clear the queue while its final old
      // request is in flight. In that case, never acknowledge or splice a
      // newer queue using the old batch's length.
      if (this.pendingBatch !== batch) continue;
      this.events.splice(0, batch.events.length);
      this.pendingBatch = undefined;
    }
  }

  private park(event: FollowerEvent, reason: string, limit?: number): never {
    const key = `${event.eventId}:${reason}`;
    const repeated = this.parkedKey === key;
    this.parkedKey = key;
    throw new FollowerEventParkedError(
      reason,
      event.eventId,
      event.message.type,
      this.eventBytes(event),
      limit,
      repeated
    );
  }

  private startTransfer(
    event: FollowerEvent,
    transfer: FollowerEventTransferSender | undefined
  ): PendingTransfer {
    if (!transfer) return this.park(event, "capability_missing", FOLLOWER_HTTP_BODY_LIMIT_BYTES);
    if (this.refused?.event === event && this.refused.capability === transfer.capability) {
      return this.park(event, this.refused.reason, this.refused.limit);
    }
    const maxEventBytes = Math.min(
      transfer.capability.maxEventBytes,
      EVENT_TRANSFER_CAPABILITY.maxEventBytes
    );
    if (this.eventBytes(event) > maxEventBytes) {
      return this.park(event, "event_too_large", maxEventBytes);
    }
    const bytes = Buffer.from(JSON.stringify(event), "utf8");
    return {
      event,
      transferId: randomUUID(),
      bytes,
      digest: sha256(bytes),
      fragmentBytes: Math.min(
        transfer.capability.maxFragmentBytes,
        EVENT_TRANSFER_CAPABILITY.maxFragmentBytes
      ),
      index: 0,
      offset: 0,
    };
  }

  private async sendFragment(
    pending: PendingTransfer,
    envelope: object,
    transfer: FollowerEventTransferSender | undefined
  ): Promise<void> {
    // The capability belongs to the registration that advertised it.
    if (!transfer) {
      this.pendingTransfer = undefined;
      return this.park(pending.event, "capability_missing", FOLLOWER_HTTP_BODY_LIMIT_BYTES);
    }
    const end = Math.min(pending.offset + pending.fragmentBytes, pending.bytes.length);
    const chunk = pending.bytes.subarray(pending.offset, end);
    const fragment: EventTransferFragment = {
      transferId: pending.transferId,
      eventId: pending.event.eventId,
      totalBytes: pending.bytes.length,
      digest: pending.digest,
      index: pending.index,
      offset: pending.offset,
      data: chunk.toString("base64"),
      fragmentDigest: sha256(chunk),
    };
    if (
      Buffer.byteLength(JSON.stringify({ ...envelope, ...fragment })) >
      FOLLOWER_HTTP_BODY_LIMIT_BYTES
    ) {
      this.pendingTransfer = undefined;
      return this.park(pending.event, "fragment_too_large", FOLLOWER_HTTP_BODY_LIMIT_BYTES);
    }
    const reply = await transfer.send(fragment);
    // A leader-incarnation fence cleared the queue while this request was in flight.
    if (this.pendingTransfer !== pending) return;
    switch (reply.status) {
      case "fragment":
        if (reply.receivedBytes !== end) {
          pending.index = 0;
          pending.offset = 0;
          throw new FollowerEventTransferRetryError("unexpected_progress", 0);
        }
        pending.index++;
        pending.offset = end;
        return;
      case "complete":
        this.events.shift();
        this.pendingTransfer = undefined;
        this.parkedKey = undefined;
        this.refused = undefined;
        return;
      case "restart":
        pending.index = 0;
        pending.offset = 0;
        throw new FollowerEventTransferRetryError(reply.reason, 0);
      case "busy":
        throw new FollowerEventTransferRetryError(reply.reason, BUSY_RETRY_MS);
      case "refused":
        this.pendingTransfer = undefined;
        if (reply.reason === ACCEPTANCE_FAILED) {
          this.acceptanceFailed = pending.event;
          return this.park(pending.event, ACCEPTANCE_FAILED);
        }
        this.refused = {
          event: pending.event,
          capability: transfer.capability,
          reason: reply.reason,
          limit: reply.maxEventBytes,
        };
        return this.park(pending.event, reply.reason, reply.maxEventBytes);
    }
  }
}
