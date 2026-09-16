import http from "node:http";
import type { ProviderPacer } from "../actor/provider-pacer.js";
import type { ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";
import {
  COORDINATOR_PROTOCOL_MAJOR,
  DEFAULT_HARD_STALE_AFTER_MS,
  DEFAULT_MAX_INTERVAL_SECONDS,
  HISTORY_WINDOW_MS,
  isValidHistoryRecord,
  type PublishedHistoryRecord,
  type PublishedThrottleColdResponse,
  type PublishedThrottleCollectionResponse,
  type PublishedThrottleProviderStatus,
  type PublishedThrottleResponse,
  type QuotaFreshness,
  validateProtocolMajor,
} from "./coordinator-protocol.js";

/**
 * What `GET /v1/quota` answers with, minus the `service` envelope: the provider's
 * `ProviderQuotaSnapshot` unchanged (so `scrapedAt` is the service's own scrape stamp),
 * plus a `freshness` block on the cold-service shape (§5.5).
 */
export type PublishedQuotaSnapshot = ProviderQuotaSnapshot & { freshness?: QuotaFreshness };

/**
 * A `/v1/quota` body is only usable when it matches the requested provider and carries
 * the fields needed for provider evidence. For `available` and `exhausted` snapshots, it
 * requires a string `scrapedAt` and a `limits` array to preserve timestamp identity for
 * diffQuota. The cold (`unknown`) and `unsupported` shapes are answers rather than errors
 * (§5.5) and are allowed with their sparse shapes.
 */
export function isQuotaSnapshotBody(
  body: unknown,
  requestedProvider: string
): body is PublishedQuotaSnapshot & { service?: unknown } {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as {
    provider?: unknown;
    status?: unknown;
    limits?: unknown;
    scrapedAt?: unknown;
  };
  if (candidate.provider !== requestedProvider) {
    return false;
  }
  if (candidate.status === "available" || candidate.status === "exhausted") {
    if (typeof candidate.scrapedAt !== "string" || !Array.isArray(candidate.limits)) {
      return false;
    }
    return true;
  }
  if (candidate.status === "unknown" || candidate.status === "unsupported") {
    return true;
  }
  return false;
}

export interface QuotaCoordinatorClientOptions {
  socketPath: string;
  maxIntervalSeconds?: number;
  hardStaleAfterMs?: number;
  /**
   * Wall-clock deadline for a single read before it is abandoned as unavailable.
   * A socket that accepts and trickles or hangs is the same freshness event as
   * a socket that refuses (§5.7), so it must not leave a read outstanding.
   */
  requestTimeoutMs?: number;
  now?: () => number;
  logger?: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

/**
 * The instance-owned half of coordinator health (§5.7 rule 6, §9.3). A service
 * cannot count the clients it cannot see, so this gauge belongs to the client
 * and is read from here by whatever samples instance health.
 */
export interface QuotaCoordinatorClientHealth {
  quota_client_service_connected: 0 | 1;
}

/**
 * First retry delay after a read the client could not use (§6.4).
 *
 * Explicit #359 acceptance behavior: reconnect backoff on the client socket.
 * At the default 300s instance tick cadence this 1–60s window is normally inert,
 * but it actively protects instances configured with faster tick intervals
 * (`tickSeconds` has no lower bound).
 */
export const RECONNECT_BACKOFF_MIN_MS = 1_000;
/** Ceiling for the doubling retry delay, so a long outage settles at one try a minute. */
export const RECONNECT_BACKOFF_MAX_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

function isNotReadyEnvelope(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "object" &&
    (body as { error: unknown }).error !== null &&
    (body as { error: { code?: unknown } }).error.code === "not_ready"
  );
}

function isValidSingleThrottlePayload(body: unknown, provider?: string): boolean {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as { provider?: unknown; intervalSeconds?: unknown };
  if (
    typeof obj.provider !== "string" ||
    typeof obj.intervalSeconds !== "number" ||
    !Number.isFinite(obj.intervalSeconds)
  ) {
    return false;
  }
  if (provider !== undefined && obj.provider !== provider) {
    return false;
  }
  return true;
}

function isValidCollectionThrottlePayload(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as { providers?: unknown };
  if (!obj.providers || typeof obj.providers !== "object" || Array.isArray(obj.providers)) {
    return false;
  }
  const providers = obj.providers as Record<string, unknown>;
  for (const status of Object.values(providers)) {
    if (typeof status !== "object" || status === null) {
      return false;
    }
    // A warm provider status with finite intervalSeconds...
    if (
      "intervalSeconds" in status &&
      typeof (status as { intervalSeconds?: unknown }).intervalSeconds === "number" &&
      Number.isFinite((status as { intervalSeconds: number }).intervalSeconds)
    ) {
      continue;
    }
    // ...or a cold lane carrying the not_ready envelope (§5.5, #480)
    if (isNotReadyEnvelope(status)) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Apply a published throttle status to a ProviderPacer: sets the pacer's interval
 * in milliseconds and defers until exhaustedUntil when expired.
 */
export function applyThrottleStatusToPacer(
  pacer: ProviderPacer,
  status: PublishedThrottleProviderStatus | PublishedThrottleResponse
): void {
  pacer.setInterval(status.intervalSeconds * 1000);
  if (status.expired && status.exhaustedUntil) {
    const deferTargetMs = Date.parse(status.exhaustedUntil);
    if (!Number.isNaN(deferTargetMs)) {
      pacer.deferUntil(deferTargetMs);
    }
  }
}

/**
 * Determine the initial pacer interval in seconds. When quota throttling is disabled,
 * pacers remain unpaced (0). When throttling is enabled, pacers start with the
 * client's last applied interval (which evaluates to maxIntervalSeconds at cold start per Rule 0),
 * or maxIntervalSeconds when no client is present.
 */
export function initialPacerIntervalSeconds(
  quotaThrottleEnabled: boolean,
  client: Pick<QuotaCoordinatorClient, "getLastAppliedInterval"> | null | undefined,
  provider: string,
  maxIntervalSeconds?: number
): number {
  if (!quotaThrottleEnabled) {
    return 0;
  }
  if (client) {
    return client.getLastAppliedInterval(provider);
  }
  return maxIntervalSeconds ?? DEFAULT_MAX_INTERVAL_SECONDS;
}

/**
 * Reconcile each configured provider's ProviderPacer interval from the coordinator client's
 * last applied interval (which preserves the last reasoned interval during an outage or cold lane,
 * and widens past hardStaleAfterMs to maxIntervalSeconds per §5.7 Rule 2).
 *
 * Only calls setInterval when the target interval differs from the pacer's current interval.
 * When setInterval is called, any retained published exhaustedUntil deferral is reapplied so
 * that hard-stale widening or interval changes do not clobber an active exhaustion gate.
 */
export function reconcileProviderPacersFromClient(
  pacerFor: (
    provider: string
  ) => Pick<ProviderPacer, "setInterval" | "interval"> & Partial<Pick<ProviderPacer, "deferUntil">>,
  providers: readonly string[],
  client: Pick<QuotaCoordinatorClient, "getLastAppliedInterval"> &
    Partial<Pick<QuotaCoordinatorClient, "getLastPublishedStatus">>
): void {
  for (const provider of providers) {
    const pacer = pacerFor(provider);
    const targetIntervalMs = client.getLastAppliedInterval(provider) * 1000;
    if (pacer.interval !== targetIntervalMs) {
      pacer.setInterval(targetIntervalMs);
      const status = client.getLastPublishedStatus?.(provider);
      if (status?.expired && status.exhaustedUntil) {
        const deferTargetMs = Date.parse(status.exhaustedUntil);
        if (!Number.isNaN(deferTargetMs)) {
          pacer.deferUntil?.(deferTargetMs);
        }
      }
    }
  }
}

export class QuotaCoordinatorClient {
  private lastAppliedIntervals: Map<string, number> = new Map();
  private lastSuccessfulReadMs: Map<string, number> = new Map();
  private lastPublishedStatuses: Map<string, PublishedThrottleProviderStatus> = new Map();
  private historyCache: Map<string, readonly PublishedHistoryRecord[]> = new Map();
  private serviceConnected = false;
  private nextReadAllowedAtMs = 0;
  private reconnectBackoffMs = RECONNECT_BACKOFF_MIN_MS;

  constructor(readonly options: QuotaCoordinatorClientOptions) {}

  /**
   * `quota_client_service_connected`: 1 once a response the client could
   * actually use has arrived, 0 while the socket is gone, the read failed, or
   * the answer was refused on `protocolMajor` (§5.7 rule 6). It reports
   * reachability only — under v1 nothing consults it to decide whether a
   * launch may proceed.
   */
  getHealth(): QuotaCoordinatorClientHealth {
    return { quota_client_service_connected: this.serviceConnected ? 1 : 0 };
  }

  getLastAppliedInterval(provider: string): number {
    // §5.7 Rule 0/Rule 2 read only the ceiling: a client that has never had a
    // successful read starts at maxIntervalSeconds, and the hard-stale widening
    // target is the same value. Degradation is always toward slower, never
    // faster — a "normal interval" default must not substitute for the ceiling.
    const maxInterval = this.options.maxIntervalSeconds ?? DEFAULT_MAX_INTERVAL_SECONDS;

    const lastApplied = this.lastAppliedIntervals.get(provider);
    const lastRead = this.lastSuccessfulReadMs.get(provider);

    // §5.7 Rule 0: A client that has never had a successful read starts at maxIntervalSeconds
    if (lastApplied === undefined || lastRead === undefined) {
      return maxInterval;
    }

    // §5.7 Rule 2: Past hardStaleAfterMs since its last successful read, the client widens to maxIntervalSeconds on its own
    const nowMs = this.nowMs();
    const hardStaleAfterMs = this.options.hardStaleAfterMs ?? DEFAULT_HARD_STALE_AFTER_MS;
    if (nowMs - lastRead > hardStaleAfterMs) {
      return Math.max(lastApplied, maxInterval);
    }

    return lastApplied;
  }

  /**
   * Returns the most recently published throttle provider status received from
   * a successful coordinator response, if any.
   */
  getLastPublishedStatus(provider: string): PublishedThrottleProviderStatus | undefined {
    return this.lastPublishedStatuses.get(provider);
  }

  /**
   * Return the cached history records for a provider, optionally filtered by sinceIso.
   * Synchronous accessor matching the QuotaApiDeps listHistory signature.
   */
  getCachedHistory(provider: string, sinceIso?: string): readonly PublishedHistoryRecord[] {
    const cached = this.historyCache.get(provider) ?? [];
    if (!sinceIso) return cached;
    const sinceMs = Date.parse(sinceIso);
    if (Number.isNaN(sinceMs)) return cached;
    return cached.filter((record) => {
      const observedMs = Date.parse(record.observedAt);
      return !Number.isNaN(observedMs) && observedMs >= sinceMs;
    });
  }

  /**
   * Apply a response from the quota coordinator, strictly enforcing client-side
   * protocolMajor compatibility and usable shape before marking reachable per
   * §5.2, §5.7, and Criterion 9.
   */
  applyResponse(provider: string, body: unknown): boolean {
    try {
      validateProtocolMajor(body, COORDINATOR_PROTOCOL_MAJOR);
    } catch (err) {
      // §5.7 counts a refusal on protocolMajor as unavailability: the socket is
      // there, the answer is unusable, and the client reaches the same state by
      // the same route the outage takes.
      this.markUnavailable();
      this.options.logger?.warn(
        `[quota-client] Discarding response for ${provider} due to protocol mismatch: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return false;
    }

    // A cold provider response carries the not_ready envelope (§5.5, #480).
    // The service is reachable, but has no interval to apply.
    if (isNotReadyEnvelope(body)) {
      this.markReachable();
      return false;
    }

    if (!isValidSingleThrottlePayload(body, provider)) {
      this.markUnavailable();
      this.options.logger?.warn(
        `[quota-client] Discarding response for ${provider} due to invalid payload shape`
      );
      return false;
    }

    this.markReachable();
    return this.applyPublishedInterval(provider, body);
  }

  async getThrottle(
    provider?: string
  ): Promise<
    | PublishedThrottleResponse
    | PublishedThrottleColdResponse
    | PublishedThrottleCollectionResponse
    | null
  > {
    // §6.4: retry with backoff rather than on every tick. A read inside the
    // backoff window is skipped, which is indistinguishable to a caller from a
    // read that failed — both mean "no new interval", never "do not launch".
    if (this.nowMs() < this.nextReadAllowedAtMs) {
      return null;
    }

    const path = provider
      ? `/v1/throttle?provider=${encodeURIComponent(provider)}`
      : "/v1/throttle";

    return new Promise((resolve) => {
      let settled = false;
      let deadlineTimer: NodeJS.Timeout | undefined;

      const finish = (
        value:
          | PublishedThrottleResponse
          | PublishedThrottleColdResponse
          | PublishedThrottleCollectionResponse
          | null
      ): void => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
        }
        resolve(value);
      };

      // An unreachable coordinator is a freshness event, not an error a caller
      // could turn into a launch gate (§5.7 rule 3), so every failure resolves
      // null instead of rejecting.
      const fail = (err: unknown): void => {
        this.markUnavailable();
        this.options.logger?.warn(
          `[quota-client] Coordinator read failed for ${path}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        finish(null);
      };

      const req = http.request(
        {
          socketPath: this.options.socketPath,
          path,
          method: "GET",
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("error", fail);
          res.on("end", () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
              validateProtocolMajor(parsed, COORDINATOR_PROTOCOL_MAJOR);
            } catch (err) {
              fail(err);
              return;
            }

            // §5.6 / §5.7: a `not_ready` envelope from a service speaking a
            // compatible protocol is reachable — it is cold, not lost. Since #480
            // the service serves it as 200 (handled below); a 503 carrying the
            // same envelope is the pre-#480 shape and is read the same way.
            if (res.statusCode === 503 && isNotReadyEnvelope(parsed)) {
              this.markReachable();
              finish(null);
              return;
            }

            if (res.statusCode === 200) {
              if (provider) {
                // A cold single-provider response (200 not_ready, §5.5, #480)
                if (isNotReadyEnvelope(parsed)) {
                  this.markReachable();
                  finish(parsed as PublishedThrottleColdResponse);
                  return;
                }
                if (isValidSingleThrottlePayload(parsed, provider)) {
                  this.markReachable();
                  this.applyPublishedInterval(provider, parsed);
                  finish(parsed as PublishedThrottleResponse);
                  return;
                }
              } else if (isValidCollectionThrottlePayload(parsed)) {
                this.markReachable();
                // Per-provider entries of the collection body carry no `service`
                // of their own; the envelope was validated once, above.
                for (const [p, pStatus] of Object.entries(
                  (parsed as PublishedThrottleCollectionResponse).providers
                )) {
                  // A cold lane carries the not_ready envelope rather than a
                  // throttle body (§5.5, #480). There is nothing to apply, and the
                  // client stays on §5.7 rule 0 / its last applied interval.
                  if (isNotReadyEnvelope(pStatus)) {
                    continue;
                  }
                  this.applyPublishedInterval(p, pStatus);
                }
                finish(parsed as PublishedThrottleCollectionResponse);
                return;
              }
            }

            // Any non-200 (other than 503 not_ready) or 200 with an unusable
            // shape fails reachability and backs off, matching protocol mismatch.
            fail(
              new Error(
                `Unusable coordinator response: status=${res.statusCode} shape=${
                  typeof parsed === "object" && parsed !== null
                    ? "invalid_payload"
                    : "not_an_object"
                }`
              )
            );
          });
        }
      );

      req.on("error", fail);

      const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      deadlineTimer = setTimeout(() => {
        req.destroy(new Error(`coordinator read timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      deadlineTimer.unref?.();

      req.end();
    });
  }

  /**
   * Fetch published history for a provider from the coordinator service via GET /v1/history.
   * Treats history failures as null without replacing the existing cache entry on transport,
   * timeout, HTTP non-200, JSON parse, protocolMajor mismatch, identity mismatch, or invalid shape.
   * [] is reserved for a valid empty response.
   */
  async getHistory(
    provider: string,
    since?: string
  ): Promise<readonly PublishedHistoryRecord[] | null> {
    const query = new URLSearchParams({ provider });
    const effectiveSince = since ?? new Date(this.nowMs() - HISTORY_WINDOW_MS).toISOString();
    query.set("since", effectiveSince);
    const path = `/v1/history?${query.toString()}`;

    return new Promise((resolve) => {
      let settled = false;
      let deadlineTimer: NodeJS.Timeout | undefined;

      const finish = (value: readonly PublishedHistoryRecord[] | null): void => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
        }
        resolve(value);
      };

      const fail = (err: unknown): void => {
        this.options.logger?.warn(
          `[quota-client] Coordinator history read failed for ${path}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        finish(null);
      };

      const req = http.request(
        {
          socketPath: this.options.socketPath,
          path,
          method: "GET",
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("error", fail);
          res.on("end", () => {
            if (res.statusCode !== 200) {
              fail(new Error(`Non-200 status code: ${res.statusCode}`));
              return;
            }

            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
              validateProtocolMajor(parsed, COORDINATOR_PROTOCOL_MAJOR);
            } catch (err) {
              fail(err);
              return;
            }

            if (
              typeof parsed !== "object" ||
              parsed === null ||
              !("provider" in parsed) ||
              (parsed as { provider: unknown }).provider !== provider ||
              !("records" in parsed) ||
              !Array.isArray((parsed as { records: unknown }).records)
            ) {
              fail(new Error("Invalid history response envelope or provider mismatch"));
              return;
            }

            const records = (parsed as { records: unknown[] }).records;
            for (const r of records) {
              if (!isValidHistoryRecord(r)) {
                fail(new Error("Invalid history record shape"));
                return;
              }
            }

            const validRecords = records as PublishedHistoryRecord[];
            this.historyCache.set(provider, validRecords);
            finish(validRecords);
          });
        }
      );

      req.on("error", fail);

      const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      deadlineTimer = setTimeout(() => {
        req.destroy(new Error(`coordinator history read timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      deadlineTimer.unref?.();

      req.end();
    });
  }

  /**
   * The evidence view (§5.5): one provider's `ProviderQuotaSnapshot` as the service last
   * observed it. Never triggers a probe — a cold service answers `status: "unknown"` with
   * a `freshness` block, and that shape is returned as-is rather than treated as an error.
   *
   * Treats quota read failures as null on transport error, timeout, HTTP non-200, JSON parse error,
   * protocolMajor mismatch, requested provider mismatch, or invalid shape. Never rejects.
   * Callers that need "could not read" as a failure wrap this themselves.
   */
  async getQuota(provider: string): Promise<PublishedQuotaSnapshot | null> {
    const path = `/v1/quota?provider=${encodeURIComponent(provider)}`;

    return new Promise((resolve) => {
      let settled = false;
      let deadlineTimer: NodeJS.Timeout | undefined;

      const finish = (value: PublishedQuotaSnapshot | null): void => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
        }
        resolve(value);
      };

      const fail = (err: unknown): void => {
        this.options.logger?.warn(
          `[quota-client] Coordinator quota read failed for ${path}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        finish(null);
      };

      const req = http.request(
        {
          socketPath: this.options.socketPath,
          path,
          method: "GET",
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("error", fail);
          res.on("end", () => {
            if (res.statusCode !== 200) {
              fail(new Error(`Non-200 status code: ${res.statusCode}`));
              return;
            }

            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
              validateProtocolMajor(parsed, COORDINATOR_PROTOCOL_MAJOR);
            } catch (err) {
              fail(err);
              return;
            }

            if (!isQuotaSnapshotBody(parsed, provider)) {
              fail(new Error(`Invalid quota snapshot shape or provider mismatch for ${provider}`));
              return;
            }

            const { service: _service, ...snapshot } = parsed as PublishedQuotaSnapshot & {
              service?: unknown;
            };
            finish(snapshot);
          });
        }
      );

      req.on("error", fail);

      const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      deadlineTimer = setTimeout(() => {
        req.destroy(new Error(`coordinator quota read timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      deadlineTimer.unref?.();

      req.end();
    });
  }

  private nowMs(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private applyPublishedInterval(provider: string, body: unknown): boolean {
    if (
      typeof body === "object" &&
      body !== null &&
      "intervalSeconds" in body &&
      typeof (body as { intervalSeconds: unknown }).intervalSeconds === "number"
    ) {
      const interval = (body as { intervalSeconds: number }).intervalSeconds;
      this.lastAppliedIntervals.set(provider, interval);
      this.lastSuccessfulReadMs.set(provider, this.nowMs());
      if ("buckets" in body && Array.isArray((body as { buckets: unknown }).buckets)) {
        this.lastPublishedStatuses.set(provider, body as PublishedThrottleProviderStatus);
      }
      return true;
    }

    return false;
  }

  private markReachable(): void {
    this.serviceConnected = true;
    this.nextReadAllowedAtMs = 0;
    this.reconnectBackoffMs = RECONNECT_BACKOFF_MIN_MS;
  }

  private markUnavailable(): void {
    this.serviceConnected = false;
    this.nextReadAllowedAtMs = this.nowMs() + this.reconnectBackoffMs;
    this.reconnectBackoffMs = Math.min(this.reconnectBackoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
  }
}
