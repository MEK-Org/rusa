import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname } from "node:path";
import { normalizeProviderThrottleKey, QUOTA_THROTTLE_PROVIDERS } from "../providers/registry.js";
import type { QuotaCollectionStats } from "./coordinator-collection.js";
import {
  nullQuotaMetrics,
  QUOTA_SERVICE_METRICS,
  type QuotaMetrics,
} from "./coordinator-metrics.js";
import {
  COORDINATOR_PROTOCOL_MAJOR,
  COORDINATOR_PROTOCOL_MINOR,
  DEFAULT_HARD_STALE_AFTER_MS,
  DEFAULT_MAX_INTERVAL_SECONDS,
  DEFAULT_STALE_AFTER_MS,
  type PublishedThrottleColdStatus,
  type PublishedThrottleLaneStatus,
  publishedThrottle,
  type QuotaCoordinatorError,
  type QuotaCoordinatorErrorResponse,
  type QuotaCoordinatorPathMismatchError,
  type QuotaCoordinatorServiceInfo,
  type QuotaReadyScrapeStatus,
} from "./coordinator-protocol.js";
import { assertQuotaSchemaVersion, QUOTA_SCHEMA_VERSION } from "./schema-guard.js";
import type { SharedQuotaStore } from "./shared-store.js";

export const SERVED_ROUTES = [
  "/v1/throttle",
  "/v1/quota",
  "/v1/history",
  "/v1/healthz",
  "/v1/readyz",
] as const;

export const DEFAULT_COORDINATOR_PROVIDERS = QUOTA_THROTTLE_PROVIDERS;

export interface QuotaCoordinatorServiceOptions {
  socketPath: string;
  store: SharedQuotaStore;
  configuredProviders?: readonly string[];
  maxIntervalSeconds?: number;
  staleAfterMs?: number;
  hardStaleAfterMs?: number;
  version?: string;
  now?: () => number;
  /** Metric sink; defaults to the discarding one. */
  metrics?: QuotaMetrics;
  /**
   * Live per-provider collection stats, when this service runs in a process
   * that also collects. Readiness needs them because a probe that fails before
   * it can persist a scrape row leaves nothing in the database to report.
   */
  collectionStats?: () => Record<string, Readonly<QuotaCollectionStats>>;
}

export class QuotaCoordinatorService {
  private server: http.Server | null = null;
  private boundSocketPath: string | null = null;
  private readonly configuredProviders: readonly string[];
  private readonly maxIntervalSeconds: number;
  private readonly staleAfterMs: number;
  private readonly hardStaleAfterMs: number;
  private readonly metrics: QuotaMetrics;

  constructor(readonly options: QuotaCoordinatorServiceOptions) {
    this.metrics = options.metrics ?? nullQuotaMetrics;
    this.configuredProviders = options.configuredProviders ?? DEFAULT_COORDINATOR_PROVIDERS;
    this.maxIntervalSeconds = options.maxIntervalSeconds ?? DEFAULT_MAX_INTERVAL_SECONDS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.hardStaleAfterMs = options.hardStaleAfterMs ?? DEFAULT_HARD_STALE_AFTER_MS;
  }

  private getServiceInfo(): QuotaCoordinatorServiceInfo {
    const nowMs = this.options.now ? this.options.now() : Date.now();
    return {
      protocolMajor: COORDINATOR_PROTOCOL_MAJOR,
      protocolMinor: COORDINATOR_PROTOCOL_MINOR,
      serverVersion: this.options.version ?? "0.1.0",
      serverTime: new Date(nowMs).toISOString(),
    };
  }

  async start(): Promise<void> {
    // Enforce schema guard before opening/serving per §5.2, §7, and Criterion 9
    assertQuotaSchemaVersion(this.options.store.db, QUOTA_SCHEMA_VERSION);

    const socketDir = dirname(this.options.socketPath);
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(socketDir, 0o700);
    } catch {}

    if (existsSync(this.options.socketPath)) {
      // Check if an active coordinator is already listening to prevent silent socket hijacking
      const isAlive = await new Promise<boolean>((resolve) => {
        const client = net.connect(this.options.socketPath);
        client.on("connect", () => {
          client.destroy();
          resolve(true);
        });
        client.on("error", () => {
          client.destroy();
          resolve(false);
        });
      });

      if (isAlive) {
        throw new Error(`A quota coordinator is already listening at ${this.options.socketPath}`);
      }

      try {
        unlinkSync(this.options.socketPath);
      } catch {}
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.listen(this.options.socketPath, () => {
        try {
          chmodSync(this.options.socketPath, 0o600);
          this.boundSocketPath = this.options.socketPath;
          resolve();
        } catch (err) {
          // A failed chmod must not leave a live socket with umask-default
          // permissions behind — §5.3 makes the file mode the entire v1 auth
          // story. Refuse cleanly: close the server and remove the socket.
          this.server?.close();
          this.server = null;
          try {
            unlinkSync(this.options.socketPath);
          } catch {}
          reject(err);
        }
      });
      this.server?.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }
    if (this.boundSocketPath && existsSync(this.boundSocketPath)) {
      try {
        unlinkSync(this.boundSocketPath);
      } catch {}
      this.boundSocketPath = null;
    }
  }

  private sendJson<T = unknown>(
    res: http.ServerResponse,
    status: number,
    body: T,
    extraHeaders?: Record<string, string>
  ): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      ...extraHeaders,
    });
    res.end(json);
  }

  private sendError(
    res: http.ServerResponse,
    status: number,
    error: QuotaCoordinatorError | QuotaCoordinatorPathMismatchError,
    extraHeaders?: Record<string, string>
  ): void {
    this.sendJson<QuotaCoordinatorErrorResponse>(
      res,
      status,
      {
        service: this.getServiceInfo(),
        error,
      },
      extraHeaders
    );
  }

  // A configured-but-cold lane is an application state served with HTTP 200,
  // not a 503 (§5.5, §5.6). Both throttle forms build the value here so the
  // collection entry is byte-identical to the single response minus `service`.
  private coldThrottle(provider: string): PublishedThrottleColdStatus {
    return {
      error: {
        code: "not_ready",
        message: `Coordinator is cold: no observations recorded for provider "${provider}" yet`,
        retryable: true,
      },
    };
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      this.dispatchRequest(req, res);
    } catch (err) {
      this.sendError(res, 500, {
        code: "internal_error",
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      });
    } finally {
      // Counted once per request, after the response status is decided, and
      // labelled with the routed path rather than the raw URL: the query string
      // carries a provider name, and a per-URL label set would grow with every
      // distinct query a client happens to send.
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      this.metrics.counter(QUOTA_SERVICE_METRICS.readsTotal, {
        path: (SERVED_ROUTES as readonly string[]).includes(pathname) ? pathname : "unrouted",
        status: res.statusCode,
      });
    }
  }

  /**
   * Overlay the live collection loop's view on the stored-scrape view.
   *
   * The stored rows answer "what is the newest reading we have"; the loop
   * answers "did the last probe work". Readiness needs both, and the loop's
   * answer wins on `status`, because a provider whose probes started failing an
   * hour ago still has a perfectly well-formed newest row.
   */
  private mergeCollectionStats(scrapes: Record<string, QuotaReadyScrapeStatus>): void {
    const stats = this.options.collectionStats?.();
    if (!stats) return;
    for (const [provider, stat] of Object.entries(stats)) {
      const existing = scrapes[provider];
      const status: QuotaReadyScrapeStatus["status"] =
        stat.lastOutcome === "failure"
          ? "error"
          : stat.lastOutcome === "ok"
            ? (existing?.status ?? "ok")
            : (existing?.status ?? "pending");
      const error =
        stat.lastOutcome === "failure" ? (stat.lastError ?? undefined) : existing?.error;
      scrapes[provider] = {
        scrapedAt: existing?.scrapedAt ?? stat.lastScrapedAt ?? null,
        status,
        ...(error ? { error } : {}),
        lastAttemptAt: stat.lastAttemptAt,
        attempts: stat.attempts,
        failures: stat.failures,
      };
    }
  }

  private dispatchRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const serviceInfo = this.getServiceInfo();
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // Per §5.2 and Criterion 7: Every v1 path is a GET.
    // Any other method on any v1 path returns 405 unconditionally, and no v1 path accepts a body.
    if (pathname.startsWith("/v1/")) {
      if (req.method !== "GET") {
        this.sendError(
          res,
          405,
          {
            code: "method_not_allowed",
            message: `Method ${req.method} not allowed on v1 endpoints; only GET is permitted`,
            retryable: false,
          },
          { Allow: "GET" }
        );
        return;
      }
    }

    if (pathname === "/v1/throttle") {
      const nowMs = this.options.now ? this.options.now() : Date.now();

      if (url.searchParams.has("provider")) {
        const rawParam = url.searchParams.get("provider")?.trim() ?? "";
        if (!rawParam) {
          this.sendError(res, 404, {
            code: "provider_unknown",
            message: "Query parameter ?provider= was provided but was empty",
            retryable: false,
          });
          return;
        }

        const provider = normalizeProviderThrottleKey(rawParam);
        if (!this.configuredProviders.includes(provider)) {
          this.sendError(res, 404, {
            code: "provider_unknown",
            message: `Provider "${rawParam}" is not configured on this coordinator`,
            retryable: false,
          });
          return;
        }

        const stored = this.options.store.getProviderThrottle(provider);
        if (!stored) {
          this.sendJson(res, 200, {
            service: serviceInfo,
            ...this.coldThrottle(provider),
          });
          return;
        }

        const published = publishedThrottle(stored, {
          maxIntervalSeconds: this.maxIntervalSeconds,
          staleAfterMs: this.staleAfterMs,
          hardStaleAfterMs: this.hardStaleAfterMs,
          nowMs,
        });

        this.sendJson(res, 200, {
          service: serviceInfo,
          ...published,
        });
        return;
      }

      // Collection form: /v1/throttle without ?provider= — every configured
      // provider, cold lanes included (criterion 16).
      const providersMap: Record<string, PublishedThrottleLaneStatus> = {};
      for (const p of this.configuredProviders) {
        const stored = this.options.store.getProviderThrottle(p);
        providersMap[p] = stored
          ? publishedThrottle(stored, {
              maxIntervalSeconds: this.maxIntervalSeconds,
              staleAfterMs: this.staleAfterMs,
              hardStaleAfterMs: this.hardStaleAfterMs,
              nowMs,
            })
          : this.coldThrottle(p);
      }

      this.sendJson(res, 200, {
        service: serviceInfo,
        providers: providersMap,
      });
      return;
    }

    if (pathname === "/v1/quota") {
      const rawParam = url.searchParams.get("provider")?.trim() ?? "";
      const provider = normalizeProviderThrottleKey(rawParam);

      if (!provider || !this.configuredProviders.includes(provider)) {
        this.sendJson(res, 200, {
          service: serviceInfo,
          provider: provider || "unknown",
          status: "unsupported",
          limits: [],
        });
        return;
      }

      const snapshot = this.options.store.getLatestSnapshot(provider);
      if (!snapshot) {
        this.sendJson(res, 200, {
          service: serviceInfo,
          provider,
          status: "unknown",
          limits: [],
          freshness: {
            ageMs: null,
            buckets: {},
            stale: true,
            hardStale: true,
          },
        });
        return;
      }

      this.sendJson(res, 200, {
        service: serviceInfo,
        ...snapshot,
      });
      return;
    }

    if (pathname === "/v1/history") {
      const rawParam = url.searchParams.get("provider")?.trim() ?? "";
      const provider = normalizeProviderThrottleKey(rawParam);

      if (!provider || !this.configuredProviders.includes(provider)) {
        this.sendError(res, 404, {
          code: "provider_unknown",
          message: provider
            ? `Provider "${provider}" is not configured on this coordinator`
            : "Missing required ?provider= query parameter",
          retryable: false,
        });
        return;
      }

      const since = url.searchParams.get("since") ?? new Date(0).toISOString();
      const records = this.options.store.listHistorySince(provider, since);

      this.sendJson(res, 200, {
        service: serviceInfo,
        provider,
        since,
        records,
      });
      return;
    }

    if (pathname === "/v1/healthz") {
      try {
        if (this.options.store.db.readonly) {
          throw new Error("Database connection is read-only");
        }
        // Constant-time handle and schema liveness check (O(1))
        this.options.store.db.pragma("user_version", { simple: true });
        this.sendJson(res, 200, {
          service: serviceInfo,
          ok: true,
        });
      } catch (err) {
        this.sendJson(res, 503, {
          service: serviceInfo,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (pathname === "/v1/readyz") {
      try {
        const rawVersion = this.options.store.db.pragma("user_version", {
          simple: true,
        });
        const userVersion = typeof rawVersion === "number" ? rawVersion : Number(rawVersion ?? 0);
        if (userVersion > QUOTA_SCHEMA_VERSION) {
          this.sendJson(res, 503, {
            service: serviceInfo,
            ready: false,
            cold: false,
            schemaVersion: userVersion,
            error: `Unsupported schema version ${userVersion}`,
          });
          return;
        }

        const nowMs = this.options.now ? this.options.now() : Date.now();
        const obsRow = this.options.store.db
          .prepare("SELECT MAX(observed_at) as latest FROM quota_observations")
          .get() as { latest?: string | null } | undefined;

        const hasRecentObservation =
          obsRow?.latest && Number.isFinite(Date.parse(obsRow.latest))
            ? nowMs - Date.parse(obsRow.latest) <= this.hardStaleAfterMs
            : false;

        const cold = !hasRecentObservation;

        const scrapeRows = this.options.store.db
          .prepare(
            `SELECT s.provider, s.scraped_at, s.parse_error
             FROM quota_scrapes s
             INNER JOIN (
               SELECT provider, MAX(scraped_at) as max_scraped_at
               FROM quota_scrapes
               GROUP BY provider
             ) latest ON s.provider = latest.provider AND s.scraped_at = latest.max_scraped_at`
          )
          .all() as Array<{ provider: string; scraped_at: string; parse_error: string | null }>;

        const scrapes: Record<string, QuotaReadyScrapeStatus> = {};
        for (const r of scrapeRows) {
          scrapes[r.provider] = {
            scrapedAt: r.scraped_at,
            status: r.parse_error ? "error" : "ok",
            ...(r.parse_error ? { error: r.parse_error } : {}),
          };
        }
        this.mergeCollectionStats(scrapes);

        this.sendJson(res, 200, {
          service: serviceInfo,
          ready: true,
          cold,
          schemaVersion: userVersion,
          scrapes,
        });
      } catch (err) {
        this.sendJson(res, 503, {
          service: serviceInfo,
          ready: false,
          cold: true,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Unrouted path: a typed, versioned 404. It is a routing typo rather than
    // a provider configuration error, so it intentionally has no semantic
    // endpoint error code. HTTP 404 is the complete path-mismatch signal;
    // `provider_unknown` would misdirect a client into treating it as a
    // permanent configuration failure.
    this.sendError(res, 404, {
      message: `Path ${pathname} not found`,
      retryable: false,
    });
  }
}
