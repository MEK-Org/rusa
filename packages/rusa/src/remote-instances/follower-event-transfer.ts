import { createHash } from "node:crypto";
import {
  EVENT_TRANSFER_CAPABILITY,
  type EventTransferCapability,
  type EventTransferFragment,
  type EventTransferReply,
} from "./protocol.js";

/** Leader-side bounds on incomplete transfers (#876). */
export interface EventTransferLimits {
  maxEventBytes: number;
  maxFragmentBytes: number;
  /**
   * Smallest fragment accepted before the final one. It bounds the number of
   * fragments, and so the per-fragment records, a transfer can make the
   * leader keep.
   */
  minFragmentBytes: number;
  /** Incomplete transfers across all followers; each follower holds at most one. */
  maxTransfers: number;
  /** Declared original-event bytes reserved across incomplete transfers; excludes decode/parse copies. */
  maxReservedBytes: number;
  /** Discard staging after this long without newly accepted bytes. */
  idleMs: number;
  /** Discard staging this long after its first fragment, whatever its progress. */
  lifetimeMs: number;
}

export const EVENT_TRANSFER_LIMITS: EventTransferLimits = {
  maxEventBytes: EVENT_TRANSFER_CAPABILITY.maxEventBytes,
  maxFragmentBytes: EVENT_TRANSFER_CAPABILITY.maxFragmentBytes,
  minFragmentBytes: 64 * 1024,
  maxTransfers: 8,
  maxReservedBytes: 128 * 1024 * 1024,
  idleMs: 5 * 60_000,
  lifetimeMs: 30 * 60_000,
};

interface Staging {
  generation: string;
  transferId: string;
  eventId: string;
  totalBytes: number;
  digest: string;
  chunks: Buffer[];
  /** Where each accepted fragment began and its digest, to recognise a retry. */
  fragments: { offset: number; digest: string }[];
  receivedBytes: number;
  createdAt: number;
  progressAt: number;
}

/** Either an HTTP answer, or the verified original bytes for the caller to dispatch. */
export type EventTransferStep =
  | { httpStatus: number; reply: EventTransferReply }
  | { eventId: string; bytes: Buffer };

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseFragment(body: unknown, limits: EventTransferLimits): EventTransferFragment | null {
  if (!body || typeof body !== "object") return null;
  const f = body as Record<string, unknown>;
  if (
    typeof f.transferId !== "string" ||
    !ID.test(f.transferId) ||
    typeof f.eventId !== "string" ||
    !f.eventId.trim() ||
    f.eventId.length > 256 ||
    !isNonNegativeInteger(f.totalBytes) ||
    f.totalBytes === 0 ||
    typeof f.digest !== "string" ||
    !DIGEST.test(f.digest) ||
    !isNonNegativeInteger(f.index) ||
    !isNonNegativeInteger(f.offset) ||
    typeof f.data !== "string" ||
    // Bound the encoded text before decoding it.
    f.data.length === 0 ||
    f.data.length > Math.ceil(limits.maxFragmentBytes / 3) * 4 ||
    typeof f.fragmentDigest !== "string" ||
    !DIGEST.test(f.fragmentDigest)
  ) {
    return null;
  }
  return f as unknown as EventTransferFragment;
}

/**
 * Reassembles events posted to `/events/transfer`, one incomplete transfer per
 * authenticated follower. Staging is memory owned by this leader incarnation;
 * expiry or a replaced follower generation discards only staging, never the
 * follower's original event, which it keeps until it receives `complete`.
 */
export class EventTransferReceiver {
  private readonly staging = new Map<string, Staging>();
  private reservedBytes = 0;

  constructor(
    private readonly limits: EventTransferLimits = EVENT_TRANSFER_LIMITS,
    private readonly now: () => number = Date.now
  ) {}

  /** What the leader advertises on `/register`: exactly the limits it enforces. */
  get capability(): EventTransferCapability {
    return {
      version: 1,
      maxEventBytes: this.limits.maxEventBytes,
      maxFragmentBytes: this.limits.maxFragmentBytes,
    };
  }

  /** Also bounds the `/events/transfer` request bodies the hub reads at once. */
  get maxTransfers(): number {
    return this.limits.maxTransfers;
  }

  get usage(): { transfers: number; reservedBytes: number } {
    return { transfers: this.staging.size, reservedBytes: this.reservedBytes };
  }

  /**
   * `committed` is the follower's existing event dedupe: an event it already
   * accepted is answered `complete` without staging or dispatching it again,
   * which covers a final acknowledgement lost after staging expired.
   */
  accept(
    followerId: string,
    generation: string,
    body: unknown,
    committed: (eventId: string) => "accepted" | "failed" | undefined
  ): EventTransferStep {
    const fragment = parseFragment(body, this.limits);
    if (!fragment) return this.refuse(followerId, 400, "invalid_fragment");
    if (fragment.totalBytes > this.limits.maxEventBytes) {
      this.discard(followerId);
      return {
        httpStatus: 413,
        reply: {
          status: "refused",
          reason: "event_too_large",
          maxEventBytes: this.limits.maxEventBytes,
        },
      };
    }
    const outcome = committed(fragment.eventId);
    if (outcome) {
      if (this.staging.get(followerId)?.eventId === fragment.eventId) this.discard(followerId);
      return outcome === "accepted"
        ? { httpStatus: 200, reply: { status: "complete" } }
        : { httpStatus: 409, reply: { status: "refused", reason: "acceptance_failed" } };
    }

    let staging = this.staging.get(followerId);
    if (staging && (staging.generation !== generation || this.expired(staging))) {
      this.discard(followerId);
      staging = undefined;
    }
    if (staging && staging.transferId !== fragment.transferId) {
      return { httpStatus: 429, reply: { status: "busy", reason: "transfer_in_progress" } };
    }
    if (
      staging &&
      (staging.eventId !== fragment.eventId ||
        staging.totalBytes !== fragment.totalBytes ||
        staging.digest !== fragment.digest)
    ) {
      return this.refuse(followerId, 409, "conflicting_declaration");
    }
    if (!staging) {
      if (fragment.offset !== 0 || fragment.index !== 0) {
        return { httpStatus: 409, reply: { status: "restart", reason: "unknown_transfer" } };
      }
      if (
        this.staging.size >= this.limits.maxTransfers ||
        this.reservedBytes + fragment.totalBytes > this.limits.maxReservedBytes
      ) {
        return { httpStatus: 429, reply: { status: "busy", reason: "capacity" } };
      }
      const now = this.now();
      staging = {
        generation,
        transferId: fragment.transferId,
        eventId: fragment.eventId,
        totalBytes: fragment.totalBytes,
        digest: fragment.digest,
        chunks: [],
        fragments: [],
        receivedBytes: 0,
        createdAt: now,
        progressAt: now,
      };
      this.staging.set(followerId, staging);
      this.reservedBytes += fragment.totalBytes;
    }

    if (fragment.index < staging.fragments.length) {
      // A retry after a lost acknowledgement. It neither extends a deadline nor
      // replaces the bytes already accepted at that index. The claimed digest
      // alone is not proof: require the retained bytes' canonical encoding too.
      const accepted = staging.fragments[fragment.index];
      if (
        accepted.offset !== fragment.offset ||
        accepted.digest !== fragment.fragmentDigest ||
        staging.chunks[fragment.index].toString("base64") !== fragment.data
      ) {
        return this.refuse(followerId, 409, "conflicting_fragment");
      }
      return {
        httpStatus: 200,
        reply: { status: "fragment", receivedBytes: staging.receivedBytes },
      };
    }
    if (fragment.index !== staging.fragments.length || fragment.offset !== staging.receivedBytes) {
      this.discard(followerId);
      return { httpStatus: 409, reply: { status: "restart", reason: "non_contiguous" } };
    }
    const bytes = Buffer.from(fragment.data, "base64");
    if (
      bytes.length === 0 ||
      bytes.length > this.limits.maxFragmentBytes ||
      bytes.toString("base64") !== fragment.data ||
      staging.receivedBytes + bytes.length > staging.totalBytes ||
      (staging.receivedBytes + bytes.length < staging.totalBytes &&
        bytes.length < Math.min(this.limits.minFragmentBytes, this.limits.maxFragmentBytes)) ||
      sha256(bytes) !== fragment.fragmentDigest
    ) {
      return this.refuse(followerId, 400, "invalid_fragment");
    }
    staging.fragments.push({ offset: staging.receivedBytes, digest: fragment.fragmentDigest });
    staging.chunks.push(bytes);
    staging.receivedBytes += bytes.length;
    staging.progressAt = this.now();
    if (staging.receivedBytes < staging.totalBytes) {
      return {
        httpStatus: 200,
        reply: { status: "fragment", receivedBytes: staging.receivedBytes },
      };
    }

    const original = Buffer.concat(staging.chunks, staging.totalBytes);
    // Release chunk references before hashing/dispatching the concatenated bytes.
    staging.chunks.length = 0;
    this.discard(followerId);
    if (sha256(original) !== staging.digest) {
      return { httpStatus: 409, reply: { status: "refused", reason: "digest_mismatch" } };
    }
    return { eventId: staging.eventId, bytes: original };
  }

  /** Release a follower's staging and its reservation. */
  discard(followerId: string): void {
    const staging = this.staging.get(followerId);
    if (!staging) return;
    this.staging.delete(followerId);
    this.reservedBytes -= staging.totalBytes;
  }

  /** Release every expired staging; returns the followers whose staging expired. */
  sweep(): string[] {
    const expired: string[] = [];
    for (const [followerId, staging] of this.staging) {
      if (this.expired(staging)) {
        this.discard(followerId);
        expired.push(followerId);
      }
    }
    return expired;
  }

  private expired(staging: Staging): boolean {
    const now = this.now();
    return (
      now - staging.progressAt > this.limits.idleMs ||
      now - staging.createdAt > this.limits.lifetimeMs
    );
  }

  private refuse(followerId: string, httpStatus: number, reason: string): EventTransferStep {
    this.discard(followerId);
    return { httpStatus, reply: { status: "refused", reason } };
  }
}
