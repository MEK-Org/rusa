import http from "node:http";
import type { ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";
import {
  COORDINATOR_PROTOCOL_MAJOR,
  DEFAULT_HARD_STALE_AFTER_MS,
  DEFAULT_MAX_INTERVAL_SECONDS,
  type PublishedThrottleCollectionResponse,
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
 * A `/v1/quota` body is only usable when it carries the two fields every snapshot has —
 * including the cold and unsupported shapes, which are answers rather than errors (§5.5).
 * Anything else is a response this client will not pass off as a provider reading.
 */
function isQuotaSnapshotBody(
  body: unknown
): body is PublishedQuotaSnapshot & { service?: unknown } {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as { provider?: unknown; status?: unknown };
  return (
    typeof candidate.provider === "string" &&
    (candidate.status === "available" ||
      candidate.status === "exhausted" ||
      candidate.status === "unknown" ||
      candidate.status === "unsupported")
  );
}

export interface QuotaCoordinatorClientOptions {
  socketPath: string;
  maxIntervalSeconds?: number;
  hardStaleAfterMs?: number;
  now?: () => number;
  logger?: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

export class QuotaCoordinatorClient {
  private lastAppliedIntervals: Map<string, number> = new Map();
  private lastSuccessfulReadMs: Map<string, number> = new Map();

  constructor(readonly options: QuotaCoordinatorClientOptions) {}

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
    const nowMs = this.options.now ? this.options.now() : Date.now();
    const hardStaleAfterMs = this.options.hardStaleAfterMs ?? DEFAULT_HARD_STALE_AFTER_MS;
    if (nowMs - lastRead > hardStaleAfterMs) {
      return Math.max(lastApplied, maxInterval);
    }

    return lastApplied;
  }

  /**
   * Apply a response from the quota coordinator, strictly enforcing client-side
   * protocolMajor compatibility on every response per §5.2 and Criterion 9.
   */
  applyResponse(provider: string, body: unknown): boolean {
    try {
      validateProtocolMajor(body, COORDINATOR_PROTOCOL_MAJOR);
    } catch (err) {
      this.options.logger?.warn(
        `[quota-client] Discarding response for ${provider} due to protocol mismatch: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return false;
    }

    if (
      typeof body === "object" &&
      body !== null &&
      "intervalSeconds" in body &&
      typeof (body as { intervalSeconds: unknown }).intervalSeconds === "number"
    ) {
      const interval = (body as { intervalSeconds: number }).intervalSeconds;
      const nowMs = this.options.now ? this.options.now() : Date.now();
      this.lastAppliedIntervals.set(provider, interval);
      this.lastSuccessfulReadMs.set(provider, nowMs);
      return true;
    }

    return false;
  }

  /**
   * The evidence view (§5.5): one provider's `ProviderQuotaSnapshot` as the service last
   * observed it. Never triggers a probe — a cold service answers `status: "unknown"` with
   * a `freshness` block, and that shape is returned as-is rather than treated as an error.
   *
   * Resolves `null` when the service answered but the response was not usable (a
   * non-200 status or a protocol-major mismatch); rejects when the socket could not be
   * reached at all. Callers that need "could not read" as a value rather than a throw
   * wrap this themselves.
   */
  async getQuota(provider: string): Promise<PublishedQuotaSnapshot | null> {
    const parsed = await this.requestJson(`/v1/quota?provider=${encodeURIComponent(provider)}`);
    if (parsed === null) return null;
    if (!this.acceptProtocol(parsed)) return null;
    if (!isQuotaSnapshotBody(parsed)) return null;
    // The `service` envelope is the transport's, not the provider's: strip it so what the
    // caller records as provider evidence is the snapshot the service stored, unchanged.
    const { service: _service, ...snapshot } = parsed;
    return snapshot;
  }

  async getThrottle(
    provider?: string
  ): Promise<PublishedThrottleResponse | PublishedThrottleCollectionResponse | null> {
    const path = provider
      ? `/v1/throttle?provider=${encodeURIComponent(provider)}`
      : "/v1/throttle";

    const parsed = await this.requestJson(path);
    if (parsed === null) return null;
    if (!this.acceptProtocol(parsed)) return null;

    if (provider) {
      this.applyResponse(provider, parsed);
    } else if (
      parsed &&
      typeof parsed === "object" &&
      "providers" in parsed &&
      parsed.providers &&
      typeof parsed.providers === "object"
    ) {
      for (const [p, pStatus] of Object.entries(parsed.providers)) {
        this.applyResponse(p, pStatus);
      }
    }
    return parsed as PublishedThrottleResponse | PublishedThrottleCollectionResponse;
  }

  /** §5.2: every response is checked for protocol-major compatibility before use. */
  private acceptProtocol(parsed: unknown): boolean {
    try {
      validateProtocolMajor(parsed, COORDINATOR_PROTOCOL_MAJOR);
      return true;
    } catch (err) {
      this.options.logger?.warn(
        `[quota-client] Discarding response due to protocol mismatch: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return false;
    }
  }

  /**
   * One GET over the unix socket. Resolves the parsed body on 200 and `null` on any other
   * status; rejects on a transport error or an unparseable body.
   */
  private requestJson(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
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
          res.on("end", () => {
            if (res.statusCode !== 200) {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }
}
