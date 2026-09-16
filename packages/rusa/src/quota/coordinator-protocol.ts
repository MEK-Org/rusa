import type { PersistedQuotaBucketStatus, PersistedQuotaProviderStatus } from "./shared-store.js";

export const COORDINATOR_PROTOCOL_MAJOR = 1;
export const COORDINATOR_PROTOCOL_MINOR = 0;
export const DEFAULT_STALE_AFTER_MS = 900_000; // 15 min (3 x 300s)
export const DEFAULT_HARD_STALE_AFTER_MS = 3_600_000; // 1 hour
export const DEFAULT_MAX_INTERVAL_SECONDS = 3600;
export const HISTORY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

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

/**
 * A configured provider the coordinator has no stored throttle for yet. It is
 * a valid application state, not a transport failure, so it is served with
 * HTTP 200: the single-provider form is `{ service, error }` and the
 * collection form carries the same object minus `service` (§5.5, criterion 16).
 * `503` stays reserved for genuine infrastructure failure (`healthz`/`readyz`).
 */
export interface PublishedThrottleColdStatus {
  error: QuotaCoordinatorError & { code: "not_ready"; retryable: true };
}

export interface PublishedThrottleColdResponse extends PublishedThrottleColdStatus {
  service: QuotaCoordinatorServiceInfo;
}

export type PublishedThrottleLaneStatus =
  | PublishedThrottleProviderStatus
  | PublishedThrottleColdStatus;

export interface PublishedThrottleCollectionResponse {
  service: QuotaCoordinatorServiceInfo;
  providers: Record<string, PublishedThrottleLaneStatus>;
}

export interface PublishedHistoryRecord {
  scope: "provider" | "model";
  kind: string;
  label: string;
  observedAt: string;
  percentLeft: number;
  resetAtIso: string | null;
  controllerError: number | null;
  intervalSeconds: number | null;
}

export interface PublishedHistoryResponse {
  service: QuotaCoordinatorServiceInfo;
  provider: string;
  since: string;
  records: PublishedHistoryRecord[];
}

export function isValidHistoryRecord(record: unknown): record is PublishedHistoryRecord {
  if (typeof record !== "object" || record === null) return false;
  const r = record as Record<string, unknown>;
  return (
    (r.scope === "provider" || r.scope === "model") &&
    typeof r.kind === "string" &&
    typeof r.label === "string" &&
    typeof r.observedAt === "string" &&
    typeof r.percentLeft === "number" &&
    (r.resetAtIso === null || typeof r.resetAtIso === "string") &&
    (r.controllerError === null || typeof r.controllerError === "number") &&
    (r.intervalSeconds === null || typeof r.intervalSeconds === "number")
  );
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

/**
 * Per-provider collection health, as readiness reports it.
 *
 * `status` is deliberately not derived from the database alone. A probe that
 * fails before it can persist a scrape row — an unwritable workers directory, a
 * revoked provider session, a missing CLI — leaves the newest stored row intact
 * and looking healthy, which is the exact silent failure §9.5's second drill
 * exists to catch. When the coordinator also collects, the live loop supplies
 * `lastAttemptAt`, `attempts` and `failures`, and a failing probe shows here as
 * `error` even while `scrapedAt` still points at the last good reading.
 */
export interface QuotaReadyScrapeStatus {
  /** Newest persisted scrape, or `null` when no probe has ever stored one. */
  scrapedAt: string | null;
  /** `pending` means a configured provider that has not yet been probed. */
  status: "ok" | "error" | "pending";
  error?: string;
  /** When a probe was last started, whether or not it stored anything. */
  lastAttemptAt?: string | null;
  attempts?: number;
  failures?: number;
}

export interface QuotaCoordinatorReadyResponse {
  service: QuotaCoordinatorServiceInfo;
  ready: boolean;
  cold: boolean;
  schemaVersion: number;
  scrapes?: Record<string, QuotaReadyScrapeStatus>;
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
