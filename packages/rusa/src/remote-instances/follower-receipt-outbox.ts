import type { FollowerRunReceipts } from "../db/repositories/index.js";
import type { RunReceiptEnvelope } from "../db/repositories/run-receipt.js";
import type { HostPendingReceipt } from "../db/repositories/run-receipt-repository.js";
import type { Logger } from "../observability/logger.js";
import type { RunReceiptPostResult, RunReceiptsReply } from "./protocol.js";

export interface FollowerReceiptOutboxLimits {
  maxReceipts: number;
  /** Serialized envelope bytes per request, well inside the leader's body limit. */
  maxBytes: number;
  /**
   * Delay before another pass after one the leader refused receipts in. A pass
   * resends every pending receipt in bounded batches, and a refused one stays
   * pending, so a host holding N refusals sends about N / maxReceipts requests
   * per interval for as long as it holds them.
   */
  refusedRetryMs: number;
}

const DEFAULT_LIMITS: FollowerReceiptOutboxLimits = {
  maxReceipts: 100,
  maxBytes: 1024 * 1024,
  refusedRetryMs: 5 * 60_000,
};

function parseReply(value: unknown): RunReceiptsReply {
  const reply = value as Partial<RunReceiptsReply> | null;
  if (
    !reply ||
    !Array.isArray(reply.results) ||
    !reply.results.every(
      (result: Partial<RunReceiptPostResult> | null) =>
        !!result &&
        typeof result.runId === "string" &&
        (result.status === "applied" ||
          result.status === "duplicate" ||
          result.status === "conflict" ||
          result.status === "invalid")
    )
  ) {
    throw new Error("Leader /receipts: malformed reply");
  }
  return reply as RunReceiptsReply;
}

/**
 * Delivers this host's durable run receipts to the leader (#1020). The
 * receipts live in mesh.db, not here: a restart or a new leader incarnation
 * does not clear them, and each one is marked delivered only once the leader
 * durably answers for it. A lost reply leaves it pending, and its retry is
 * the same bytes, which the leader answers as a duplicate. A receipt the
 * leader refuses as invalid stays pending without holding back the receipts
 * after it, and {@link retryDue} schedules its retry after a fixed delay:
 * a refusal can clear on its own (an early receipt at the conflict bound
 * applies once its run starts), and the delay keeps a permanent one from
 * hot-looping.
 */
export class FollowerReceiptOutbox {
  private readonly limits: FollowerReceiptOutboxLimits;
  private flushing?: Promise<void>;
  private again = false;
  private refusedRetryAt?: number;

  constructor(
    private readonly receipts: FollowerRunReceipts,
    private readonly post: (receipts: RunReceiptEnvelope[]) => Promise<unknown>,
    private readonly log: Logger,
    limits?: Partial<FollowerReceiptOutboxLimits>,
    private readonly now: () => number = Date.now
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Whether receipts the leader refused are due another pass; never while one runs. */
  retryDue(): boolean {
    return (
      this.flushing === undefined &&
      this.refusedRetryAt !== undefined &&
      this.now() >= this.refusedRetryAt
    );
  }

  /** Single-flight: a call during a flush schedules one more pass after it. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.again = false;
          this.scheduleRefusedRetry(await this.drain());
        } while (this.again);
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  private nextBatch(afterId: number): HostPendingReceipt[] {
    const batch: HostPendingReceipt[] = [];
    let bytes = 0;
    for (const pending of this.receipts.listUnacked(afterId, this.limits.maxReceipts)) {
      const size = Buffer.byteLength(JSON.stringify(pending.envelope), "utf8");
      if (batch.length > 0 && bytes + size > this.limits.maxBytes) break;
      batch.push(pending);
      bytes += size;
    }
    return batch;
  }

  private scheduleRefusedRetry(refused: number): void {
    this.refusedRetryAt = refused === 0 ? undefined : this.now() + this.limits.refusedRetryMs;
  }

  /** One pass over the pending receipts, paged in local commit order; returns how many were refused. */
  private async drain(): Promise<number> {
    let afterId = 0;
    let refused = 0;
    for (;;) {
      const batch = this.nextBatch(afterId);
      if (batch.length === 0) return refused;
      const reply = parseReply(await this.post(batch.map((pending) => pending.envelope)));
      const sent = new Set(batch.map((pending) => pending.envelope.runId));
      const acked: string[] = [];
      for (const result of reply.results) {
        if (!sent.has(result.runId)) continue;
        if (result.status === "invalid") {
          refused += 1;
          this.log.warn("follower_receipt_refused", { runId: result.runId });
        } else {
          acked.push(result.runId);
        }
      }
      this.receipts.markAcked(acked);
      afterId = batch[batch.length - 1].id;
    }
  }
}
