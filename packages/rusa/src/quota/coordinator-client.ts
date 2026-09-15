import http from "node:http";
import {
  nullQuotaMetrics,
  QUOTA_CLIENT_METRICS,
  type QuotaMetrics,
} from "./coordinator-metrics.js";
import {
  COORDINATOR_PROTOCOL_MAJOR,
  DEFAULT_HARD_STALE_AFTER_MS,
  DEFAULT_MAX_INTERVAL_SECONDS,
  type PublishedThrottleCollectionResponse,
  type PublishedThrottleResponse,
  validateProtocolMajor,
} from "./coordinator-protocol.js";

export interface QuotaCoordinatorClientOptions {
  socketPath: string;
  maxIntervalSeconds?: number;
  hardStaleAfterMs?: number;
  now?: () => number;
  logger?: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  /** Metric sink; defaults to the discarding one. */
  metrics?: QuotaMetrics;
  /**
   * The `source` label the two client series carry — which reader this is.
   * The series exist to be compared across many readers at once, so an
   * unlabelled one is not useful; an unset source reports as `unknown` rather
   * than silently merging distinct readers into one line.
   */
  source?: string;
}

export class QuotaCoordinatorClient {
  private lastAppliedIntervals: Map<string, number> = new Map();
  private lastSuccessfulReadMs: Map<string, number> = new Map();
  private readonly metrics: QuotaMetrics;
  private readonly source: string;

  constructor(readonly options: QuotaCoordinatorClientOptions) {
    this.metrics = options.metrics ?? nullQuotaMetrics;
    this.source = options.source ?? "unknown";
  }

  /**
   * Whether the last read reached the service. Reported as 0/1 rather than as
   * an event, because the condition that matters is a client sitting
   * disconnected across ticks — a gauge shows that as a flat line at zero,
   * where a failure counter only shows it as an absence of increments.
   */
  private recordConnected(connected: boolean): void {
    this.metrics.gauge(QUOTA_CLIENT_METRICS.serviceConnected, connected ? 1 : 0, {
      source: this.source,
    });
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
      this.metrics.gauge(QUOTA_CLIENT_METRICS.appliedIntervalSeconds, interval, {
        source: this.source,
        provider,
      });
      return true;
    }

    return false;
  }

  async getThrottle(
    provider?: string
  ): Promise<PublishedThrottleResponse | PublishedThrottleCollectionResponse | null> {
    const path = provider
      ? `/v1/throttle?provider=${encodeURIComponent(provider)}`
      : "/v1/throttle";

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
            // Reaching a response at all is the connection signal, whatever the
            // service said: a 503 from a cold coordinator is a service that is
            // up and answering, and reporting it as disconnected would fire the
            // §9.5 alert on a healthy pool during startup.
            this.recordConnected(true);
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(data);
                try {
                  validateProtocolMajor(parsed, COORDINATOR_PROTOCOL_MAJOR);
                } catch (err) {
                  this.options.logger?.warn(
                    `[quota-client] Discarding response due to protocol mismatch: ${
                      err instanceof Error ? err.message : String(err)
                    }`
                  );
                  resolve(null);
                  return;
                }

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
                resolve(parsed);
              } catch (err) {
                reject(err);
              }
            } else {
              resolve(null);
            }
          });
        }
      );
      req.on("error", (err) => {
        this.recordConnected(false);
        reject(err);
      });
      req.end();
    });
  }
}
