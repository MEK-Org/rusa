import type { PersistedQuotaBucketStatus, PersistedQuotaProviderStatus } from "./shared-store.js";

export const COORDINATOR_PROTOCOL_MAJOR = 1;
export const COORDINATOR_PROTOCOL_MINOR = 0;
export const DEFAULT_STALE_AFTER_MS = 900_000; // 15 min (3 x 300s)
export const DEFAULT_HARD_STALE_AFTER_MS = 3_600_000; // 1 hour
export const DEFAULT_MAX_INTERVAL_SECONDS = 3600;

export interface QuotaCoordinatorServiceInfo {
  protocolMajor: number;
  protocolMinor: number;
  serverVersion: string;
  serverTime: string;
}

export interface QuotaFreshness {
  ageMs: number | null;
  buckets: Record<string, number>;
  stale: boolean;
  hardStale: boolean;
}

export interface PublishedThrottleProviderStatus {
  provider: string;
  intervalSeconds: number;
  uncappedIntervalSeconds: number;
  governingBucketKey: string | null;
  capped: boolean;
  expired: boolean;
  exhaustedUntil: string | null;
  updatedAt: string;
  buckets: PersistedQuotaBucketStatus[];
  freshness: QuotaFreshness;
}

export interface PublishedThrottleResponse extends PublishedThrottleProviderStatus {
  service: QuotaCoordinatorServiceInfo;
}

export interface PublishedThrottleCollectionResponse {
  service: QuotaCoordinatorServiceInfo;
  providers: Record<string, PublishedThrottleProviderStatus>;
}

export type QuotaCoordinatorErrorCode =
  | "not_ready"
  | "provider_unknown"
  | "method_not_allowed"
  | "internal_error";

export interface QuotaCoordinatorError {
  code: QuotaCoordinatorErrorCode;
  message: string;
  retryable: boolean;
}

/**
 * A request that does not select a v1 endpoint has an HTTP routing failure,
 * not a quota-service state. Keep its response typed and versioned without
 * inventing a third semantic error code in the v1 endpoint contract.
 */
export interface QuotaCoordinatorPathMismatchError {
  message: string;
  retryable: boolean;
}

export interface QuotaCoordinatorErrorResponse {
  service: QuotaCoordinatorServiceInfo;
  error: QuotaCoordinatorError | QuotaCoordinatorPathMismatchError;
}

export interface QuotaCoordinatorHealthResponse {
  service: QuotaCoordinatorServiceInfo;
  ok: boolean;
}

export interface QuotaCoordinatorReadyResponse {
  service: QuotaCoordinatorServiceInfo;
  ready: boolean;
  cold: boolean;
  schemaVersion: number;
  scrapes?: Record<string, { scrapedAt: string; status: "ok" | "error"; error?: string }>;
}

export interface PublishedThrottleOptions {
  maxIntervalSeconds?: number;
  staleAfterMs?: number;
  hardStaleAfterMs?: number;
  nowMs?: number;
}

export class ProtocolMismatchError extends Error {
  constructor(
    readonly serverMajor: number,
    readonly clientMajor: number,
    message?: string
  ) {
    super(
      message ??
        `Server protocol major ${serverMajor} does not match client protocol major ${clientMajor}`
    );
    this.name = "ProtocolMismatchError";
  }
}

export function calculateFreshness(
  stored: PersistedQuotaProviderStatus,
  options?: { staleAfterMs?: number; hardStaleAfterMs?: number; nowMs?: number }
): QuotaFreshness {
  const nowMs = options?.nowMs ?? Date.now();
  const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const hardStaleAfterMs = options?.hardStaleAfterMs ?? DEFAULT_HARD_STALE_AFTER_MS;

  const buckets: Record<string, number> = {};
  if (stored.buckets && stored.buckets.length > 0) {
    for (const b of stored.buckets) {
      const observedMs = Date.parse(b.observedAt);
      buckets[b.key] = Number.isFinite(observedMs)
        ? Math.max(0, nowMs - observedMs)
        : Number.POSITIVE_INFINITY;
    }
  }

  const bucketAges = Object.values(buckets);
  const updatedParsed = Date.parse(stored.updatedAt);
  const updatedAge = Number.isFinite(updatedParsed)
    ? Math.max(0, nowMs - updatedParsed)
    : Number.POSITIVE_INFINITY;

  const ageMs = bucketAges.length > 0 ? Math.max(...bucketAges) : updatedAge;

  const stale = ageMs > staleAfterMs;
  const hardStale = ageMs > hardStaleAfterMs;

  return {
    ageMs,
    buckets,
    stale,
    hardStale,
  };
}

export function publishedThrottle(
  stored: PersistedQuotaProviderStatus,
  options?: PublishedThrottleOptions
): PublishedThrottleProviderStatus {
  const maxIntervalSeconds = options?.maxIntervalSeconds ?? DEFAULT_MAX_INTERVAL_SECONDS;
  const freshness = calculateFreshness(stored, options);

  const intervalSeconds = freshness.hardStale
    ? Math.max(stored.intervalSeconds, maxIntervalSeconds)
    : stored.intervalSeconds;

  const capped = stored.uncappedIntervalSeconds > intervalSeconds;

  return {
    provider: stored.provider,
    intervalSeconds,
    uncappedIntervalSeconds: stored.uncappedIntervalSeconds,
    governingBucketKey: stored.governingBucketKey,
    capped,
    expired: stored.expired,
    exhaustedUntil: stored.exhaustedUntil,
    updatedAt: stored.updatedAt,
    buckets: stored.buckets,
    freshness,
  };
}

export function validateProtocolMajor(
  body: unknown,
  expectedMajor: number = COORDINATOR_PROTOCOL_MAJOR
): void {
  if (typeof body !== "object" || body === null) {
    throw new Error("Invalid response: body must be an object");
  }
  const service = (body as { service?: { protocolMajor?: unknown } }).service;
  if (!service || typeof service.protocolMajor !== "number") {
    throw new Error("Invalid response: missing service.protocolMajor");
  }
  if (service.protocolMajor !== expectedMajor) {
    throw new ProtocolMismatchError(service.protocolMajor, expectedMajor);
  }
}
