import type { ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";
import type {
  PersistedQuotaBucketStatus,
  PersistedQuotaModelLaneStatus,
  PersistedQuotaProviderStatus,
} from "./shared-store.js";
import { isProviderScopedWindow } from "./window-scope.js";

export const COORDINATOR_PROTOCOL_MAJOR = 1;
// Minor 2 adds model identities to model-scoped history rows and model-scoped
// throttle lanes (#588). Both are additive: an older reader ignores them and
// keeps its provider-only behavior.
export const COORDINATOR_PROTOCOL_MINOR = 2;
/** Routine provider probe cache TTL: one scrape per provider per ~30 minutes (#690). */
export const QUOTA_PROBE_TTL_MS = 30 * 60 * 1000;
/**
 * Scrape-mode soft stale: three missed ticks past the moment a probe refresh
 * is due, so a healthy lane reading one full TTL old is still fresh.
 */
export function scrapeStaleAfterMs(tickSeconds: number): number {
  if (
    !Number.isFinite(tickSeconds) ||
    !Number.isInteger(tickSeconds) ||
    tickSeconds <= 0 ||
    tickSeconds >= 600
  ) {
    throw new RangeError(
      `tickSeconds (${tickSeconds}) must be a positive integer less than 600 to preserve scrape hard-stale timing`
    );
  }
  return QUOTA_PROBE_TTL_MS + 3 * tickSeconds * 1000;
}
export const DEFAULT_STALE_AFTER_MS = scrapeStaleAfterMs(300); // 45 min (30m TTL + 3 x 300s)
export const DEFAULT_HARD_STALE_AFTER_MS = 3_600_000; // 1 hour
/**
 * Manual mode sizes for reader plus submitter latency on paced lanes (#690):
 * 15–40 min reader and 13–27 min submitter latency were observed in steady state.
 */
export const DEFAULT_MANUAL_STALE_AFTER_MS = 3_600_000; // 60 min
export const DEFAULT_MANUAL_HARD_STALE_AFTER_MS = 7_200_000; // 120 min; `quota.throttle.manualHardStaleSeconds`
/** Manual soft stale never exceeds its hard threshold, so the pair stays ordered. */
export function manualSoftStaleAfterMs(manualHardStaleAfterMs: number): number {
  return Math.min(DEFAULT_MANUAL_STALE_AFTER_MS, manualHardStaleAfterMs);
}

export interface FreshnessThresholdsConfig {
  scrapeStaleAfterMs?: number;
  scrapeHardStaleAfterMs?: number;
  manualHardStaleAfterMs?: number;
}

/**
 * Single helper for deriving resolved soft and hard freshness thresholds (#690).
 * In manual mode, thresholds are isolated: soft stale is min(60m, manualHard)
 * so the pair stays ordered. Manual mode never inherits scrape options.
 * In scrape mode, soft stale defaults to 45m (30m TTL + 3*300s) and hard to 60m.
 */
export function freshnessThresholds(
  mode: "manual" | "scrape" | undefined,
  config?: FreshnessThresholdsConfig
): { staleAfterMs: number; hardStaleAfterMs: number } {
  if (mode === "manual") {
    const hardStaleAfterMs = config?.manualHardStaleAfterMs ?? DEFAULT_MANUAL_HARD_STALE_AFTER_MS;
    const staleAfterMs = manualSoftStaleAfterMs(hardStaleAfterMs);
    return { staleAfterMs, hardStaleAfterMs };
  }
  const staleAfterMs = config?.scrapeStaleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const hardStaleAfterMs = config?.scrapeHardStaleAfterMs ?? DEFAULT_HARD_STALE_AFTER_MS;
  return { staleAfterMs, hardStaleAfterMs };
}
export const DEFAULT_MAX_INTERVAL_SECONDS = 3600;
export const HISTORY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * Operator write routes (#573). They are ordinary `/v1/` paths: design §5.2,
 * Criterion 7 states the allowed method per path rather than declaring the
 * whole of v1 read-only, so a POST route no longer has to sit outside the
 * version prefix in order to exist. The socket's file mode is the whole of
 * their authorization, exactly as it is for the read surface.
 */
export const QUOTA_READING_MODE_PATH = "/v1/quota/reading-mode";
export const MANUAL_QUOTA_OBSERVATION_PATH = "/v1/quota/observations";

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
  mode?: "manual" | "scrape";
  staleAfterMs?: number;
  hardStaleAfterMs?: number;
  resetWaiting?: boolean;
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
  /**
   * Independently reasoned model-scoped lanes (#588), each with its own
   * freshness and stale widening. Omitted when the provider reports none.
   */
  modelLanes?: PublishedThrottleModelLaneStatus[];
}

export interface PublishedThrottleModelLaneStatus
  extends Omit<PublishedThrottleProviderStatus, "modelLanes"> {
  /** Canonical configured model IDs this lane's windows apply to. */
  models: string[];
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
  /**
   * Canonical configured model IDs for a model-scoped row. Provider-scoped
   * rows omit this, so clients never have to infer scope from a display label.
   */
  models?: string[];
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
  const models = r.models;
  const hasValidModelIdentity =
    r.scope === "provider"
      ? models === undefined
      : Array.isArray(models) &&
        models.length > 0 &&
        models.every((model) => typeof model === "string" && model.length > 0);
  return (
    (r.scope === "provider" || r.scope === "model") &&
    hasValidModelIdentity &&
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
  | "invalid_request"
  | "manual_mode_required"
  | "mode_generation_mismatch"
  | "stale_observation"
  | "idempotency_conflict"
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

/** Durable per-provider collection authority, exposed only on the local authenticated socket. */
export interface QuotaReadingModeResponse {
  service: QuotaCoordinatorServiceInfo;
  provider: string;
  mode: "manual" | "scrape";
  generation: number;
}

/** Success envelope for a replay-safe manual observation POST. */
export interface ManualQuotaObservationResponse {
  service: QuotaCoordinatorServiceInfo;
  provider: string;
  observedAt: string;
  generation: number;
  duplicate: boolean;
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
  /**
   * The lane's durable collection authority (#573). `manual` explains a lane
   * whose probes stopped without an error; `generation` is what an
   * observation write has to echo.
   */
  readingMode?: { mode: "manual" | "scrape"; generation: number };
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
  mode?: "manual" | "scrape";
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
  options?: PublishedThrottleOptions
): QuotaFreshness {
  const nowMs = options?.nowMs ?? Date.now();
  const mode = options?.mode;
  const defaultThresholds = freshnessThresholds(mode);
  const staleAfterMs = options?.staleAfterMs ?? defaultThresholds.staleAfterMs;
  const hardStaleAfterMs = options?.hardStaleAfterMs ?? defaultThresholds.hardStaleAfterMs;

  const buckets: Record<string, number> = {};
  const currentAges: number[] = [];
  if (stored.buckets && stored.buckets.length > 0) {
    for (const b of stored.buckets) {
      const observedMs = Date.parse(b.observedAt);
      const ageMs = Number.isFinite(observedMs)
        ? Math.max(0, nowMs - observedMs)
        : Number.POSITIVE_INFINITY;
      buckets[b.key] = ageMs;
      // Lane freshness is keyed on the buckets present in the newest scrape, or
      // the governing bucket, rather than on every unexpired historical bucket
      // (§5.5). A bucket that was not emitted by the newest scrape and is not
      // governing does not age the lane.
      //
      // Membership is exact string equality with `updatedAt`, the newest
      // `observed_at` across kinds: `SharedQuotaStore.insertObservations` stamps
      // every row of one snapshot with the single `scrapedAt` string, so the rows
      // of one scrape never disagree, and a row stamped even 1 ms earlier belongs
      // to an earlier scrape.
      const isNewestScrape = b.observedAt === stored.updatedAt;
      const isGoverning =
        stored.governingBucketKey !== null &&
        stored.governingBucketKey !== undefined &&
        b.key === stored.governingBucketKey;
      if (!isNewestScrape && !isGoverning) continue;
      currentAges.push(ageMs);
    }
  }

  const updatedParsed = Date.parse(stored.updatedAt);
  const updatedAge = Number.isFinite(updatedParsed)
    ? Math.max(0, nowMs - updatedParsed)
    : Number.POSITIVE_INFINITY;

  const ageMs = currentAges.length > 0 ? Math.max(...currentAges) : updatedAge;

  const stale = ageMs > staleAfterMs;
  const hardStale = ageMs > hardStaleAfterMs;

  // Window reset-wait distinction (#690): if any window has passed its reset
  // instant (resetAtIso <= nowMs), but the observation was taken before that reset,
  // the coordinator is waiting for a fresh post-reset observation. This must never
  // be conflated with an observed zero or fresh usage reading.
  const resetWaiting =
    stored.buckets && stored.buckets.length > 0
      ? stored.buckets.some((b) => {
          if (!b.resetAtIso) return false;
          const resetMs = Date.parse(b.resetAtIso);
          const observedMs = Date.parse(b.observedAt);
          return (
            Number.isFinite(resetMs) &&
            resetMs <= nowMs &&
            Number.isFinite(observedMs) &&
            observedMs < resetMs
          );
        })
      : false;

  return {
    ageMs,
    buckets,
    stale,
    hardStale,
    mode,
    staleAfterMs,
    hardStaleAfterMs,
    resetWaiting,
  };
}

export function publishedThrottle(
  stored: PersistedQuotaProviderStatus,
  options?: PublishedThrottleOptions
): PublishedThrottleProviderStatus {
  const published = publishedLane(stored, options);
  const hardStaleAfterMs =
    options?.hardStaleAfterMs ?? freshnessThresholds(options?.mode).hardStaleAfterMs;
  const providerUpdatedMs = Date.parse(stored.updatedAt);
  // A model lane is retired, not hard-staled, once the provider has kept
  // reporting for longer than the hard-stale horizon without it: the window
  // is no longer on the panel, and pinning that model at the ceiling for the
  // rest of observation retention would be a stale reading, not caution. A
  // coordinator that stops collecting ages both lanes together instead, so
  // the conservative widening still applies there.
  const modelLanes = (stored.modelLanes ?? []).flatMap(
    (lane: PersistedQuotaModelLaneStatus): PublishedThrottleModelLaneStatus[] => {
      const laneUpdatedMs = Date.parse(lane.updatedAt);
      if (
        Number.isFinite(providerUpdatedMs) &&
        (!Number.isFinite(laneUpdatedMs) || providerUpdatedMs - laneUpdatedMs > hardStaleAfterMs)
      ) {
        return [];
      }
      return [{ ...publishedLane(lane, options), models: [...lane.models] }];
    }
  );
  return modelLanes.length > 0 ? { ...published, modelLanes } : published;
}

function publishedLane(
  stored: Omit<PersistedQuotaProviderStatus, "modelLanes">,
  options?: PublishedThrottleOptions
): Omit<PublishedThrottleProviderStatus, "modelLanes"> {
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

/** The pacing a model-scoped lane set imposes on one concrete candidate model. */
export interface ModelLanePacing {
  /** Longest interval among applicable lanes. */
  intervalSeconds: number;
  /** Latest exhaustion deadline among applicable expired lanes, or null. */
  deferUntil: string | null;
  /**
   * Latest exhaustion deadline among applicable expired lanes the coordinator
   * still publishes as fresh, or null: the same evidence rule the provider
   * lane uses before it reports a lane as absolutely exhausted.
   */
  exhaustedUntil: string | null;
}

function isPublishedModelLane(value: unknown): value is PublishedThrottleModelLaneStatus {
  if (typeof value !== "object" || value === null) return false;
  const lane = value as Partial<PublishedThrottleModelLaneStatus>;
  return (
    Array.isArray(lane.models) &&
    lane.models.length > 0 &&
    lane.models.every((model) => typeof model === "string" && model.length > 0) &&
    typeof lane.intervalSeconds === "number" &&
    Number.isFinite(lane.intervalSeconds) &&
    lane.intervalSeconds >= 0 &&
    typeof lane.expired === "boolean" &&
    isValidQuotaFreshness(lane.freshness)
  );
}

/**
 * Combine every published model lane that applies to `model` (#588). Lanes
 * scoped only to other models are ignored, and so is a malformed lane, which
 * therefore cannot pace anything. Among applicable lanes the longest interval
 * and the latest exhaustion win, which is order-independent and so
 * deterministic. Returns undefined when no lane applies, leaving the candidate
 * on its provider lane alone. The provider-wide lane is not folded in here:
 * the caller's model pacer is linked to the provider pacer, which already
 * enforces it.
 */
export function modelLanePacing(
  status: Pick<PublishedThrottleProviderStatus, "modelLanes"> | undefined,
  model: string | undefined
): ModelLanePacing | undefined {
  if (!model) return undefined;
  const lanes: unknown[] = Array.isArray(status?.modelLanes) ? status.modelLanes : [];
  const applicable = lanes.filter(
    (lane): lane is PublishedThrottleModelLaneStatus =>
      isPublishedModelLane(lane) && lane.models.includes(model)
  );
  if (applicable.length === 0) return undefined;
  let intervalSeconds = 0;
  let deferUntilMs = Number.NEGATIVE_INFINITY;
  let exhaustedUntilMs = Number.NEGATIVE_INFINITY;
  for (const lane of applicable) {
    intervalSeconds = Math.max(intervalSeconds, lane.intervalSeconds);
    const untilMs = lane.expired && lane.exhaustedUntil ? Date.parse(lane.exhaustedUntil) : NaN;
    if (!Number.isFinite(untilMs)) continue;
    deferUntilMs = Math.max(deferUntilMs, untilMs);
    if (!lane.freshness.stale) exhaustedUntilMs = Math.max(exhaustedUntilMs, untilMs);
  }
  const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  return {
    intervalSeconds,
    deferUntil: iso(deferUntilMs),
    exhaustedUntil: iso(exhaustedUntilMs),
  };
}

/**
 * Project a published throttle status onto the weekly admission observation
 * it carries. Returns undefined when there is no status or no weekly bucket
 * with a reset instant, which leaves pool ranking in declared order.
 */
export function weeklyAdmissionObservation(status: PublishedThrottleProviderStatus | undefined) {
  const bucket = status?.buckets.find((candidate) => candidate.key === `${status.provider}:weekly`);
  if (!bucket?.resetAtIso) return undefined;
  return {
    percentLeft: bucket.percentLeft,
    observedAt: bucket.observedAt,
    resetAtIso: bucket.resetAtIso,
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

export interface PublishedQuotaResponse extends ProviderQuotaSnapshot {
  service: QuotaCoordinatorServiceInfo;
  freshness?: QuotaFreshness;
}

const QUOTA_STATUSES: ReadonlySet<string> = new Set([
  "available",
  "exhausted",
  "unknown",
  "unsupported",
]);
const QUOTA_WINDOW_KINDS: ReadonlySet<string> = new Set([
  "session",
  "five_hour",
  "weekly",
  "other",
]);

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isValidQuotaWindowScope(value: unknown): boolean {
  if (value === "provider" || value === "model") return true;
  if (typeof value !== "object" || value === null) return false;
  const scope = value as Record<string, unknown>;
  return (
    typeof scope.provider === "string" &&
    (scope.models === undefined ||
      (Array.isArray(scope.models) && scope.models.every((m) => typeof m === "string")))
  );
}

function isValidQuotaLimit(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const limit = value as Record<string, unknown>;
  return (
    typeof limit.label === "string" &&
    typeof limit.percentLeft === "number" &&
    Number.isFinite(limit.percentLeft) &&
    (limit.kind === undefined ||
      (typeof limit.kind === "string" && QUOTA_WINDOW_KINDS.has(limit.kind))) &&
    isOptionalString(limit.resetAtIso) &&
    (limit.scope === undefined || isValidQuotaWindowScope(limit.scope))
  );
}

export function isValidQuotaFreshness(value: unknown): value is QuotaFreshness {
  if (typeof value !== "object" || value === null) return false;
  const freshness = value as Record<string, unknown>;
  return (
    (freshness.ageMs === null || typeof freshness.ageMs === "number") &&
    typeof freshness.buckets === "object" &&
    freshness.buckets !== null &&
    !Array.isArray(freshness.buckets) &&
    Object.values(freshness.buckets as Record<string, unknown>).every(
      (v) => typeof v === "number"
    ) &&
    typeof freshness.stale === "boolean" &&
    typeof freshness.hardStale === "boolean"
  );
}

/**
 * Structural check on a `GET /v1/quota` body before the client hands it to
 * consumers as a `ProviderQuotaSnapshot`. Matching protocolMajor promises the
 * envelope, not the nested fields, so every field a consumer dereferences
 * (`quota-api.ts` window builders, the MCP tool output) is checked here the
 * same way `isValidHistoryRecord` checks history rows. Unknown extra fields
 * pass through: a newer minor may add them.
 */
export function isValidQuotaPayload(
  body: unknown,
  provider?: string
): body is PublishedQuotaResponse {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj.provider !== "string" || typeof obj.status !== "string") {
    return false;
  }
  if (provider !== undefined && obj.provider !== provider) {
    return false;
  }
  if (!QUOTA_STATUSES.has(obj.status)) return false;
  if (obj.limits !== undefined) {
    if (!Array.isArray(obj.limits) || !obj.limits.every(isValidQuotaLimit)) return false;
  }
  if (obj.freshness !== undefined && !isValidQuotaFreshness(obj.freshness)) return false;
  return (
    isOptionalString(obj.message) && isOptionalString(obj.raw) && isOptionalString(obj.scrapedAt)
  );
}

/**
 * Manual writes are intentionally narrower than read responses: they must
 * supply a concrete, current provider snapshot that can enter the canonical
 * provider-paced observation stream without parser inference. Returns `null`
 * when valid, otherwise the first reason the reading was refused so a
 * hand-typed request gets told which field to fix. A reset that has already
 * passed is accepted, as it is from the scrapers: the controller treats it as
 * "no usable reset" rather than an error.
 */
export function manualQuotaObservationProblem(value: unknown, provider: string): string | null {
  if (!isValidQuotaPayload(value, provider)) {
    return `observation must be a ${provider} quota snapshot`;
  }
  const snapshot = value as ProviderQuotaSnapshot;
  if (snapshot.status !== "available" && snapshot.status !== "exhausted") {
    return 'observation.status must be "available" or "exhausted"';
  }
  if (!snapshot.scrapedAt || !Number.isFinite(Date.parse(snapshot.scrapedAt))) {
    return "observation.scrapedAt must be an ISO-8601 timestamp";
  }
  if (!snapshot.limits || snapshot.limits.length === 0) {
    return "observation.limits must contain at least one limit";
  }

  const seenKinds = new Set<string>();
  let providerLimitCount = 0;
  for (const [index, limit] of snapshot.limits.entries()) {
    const at = `observation.limits[${index}]`;
    const scopedProvider =
      typeof limit.scope === "object" && limit.scope !== null ? limit.scope.provider : undefined;
    if (!limit.label.trim()) return `${at}.label must not be blank`;
    if (limit.percentLeft < 0 || limit.percentLeft > 100) {
      return `${at}.percentLeft must be between 0 and 100`;
    }
    if (limit.resetAtIso !== undefined && !Number.isFinite(Date.parse(limit.resetAtIso))) {
      return `${at}.resetAtIso must be an ISO-8601 timestamp`;
    }
    if (scopedProvider !== undefined && scopedProvider !== provider) {
      return `${at}.scope.provider must be ${provider}`;
    }
    if (!isProviderScopedWindow(limit)) continue;
    const kind = limit.kind ?? "other";
    if (seenKinds.has(kind)) return `${at} repeats the provider-scoped ${kind} window`;
    seenKinds.add(kind);
    providerLimitCount += 1;
  }
  return providerLimitCount > 0 ? null : "observation.limits needs one provider-scoped window";
}

export function isValidManualQuotaObservation(
  value: unknown,
  provider: string
): value is ProviderQuotaSnapshot & {
  scrapedAt: string;
  limits: NonNullable<ProviderQuotaSnapshot["limits"]>;
} {
  return manualQuotaObservationProblem(value, provider) === null;
}
