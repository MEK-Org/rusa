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
  isValidManualQuotaObservation,
  MANUAL_QUOTA_OBSERVATION_PATH,
  type ManualQuotaObservationResponse,
  manualQuotaObservationProblem,
  type PublishedThrottleColdStatus,
  type PublishedThrottleLaneStatus,
  publishedThrottle,
  QUOTA_READING_MODE_PATH,
  type QuotaCoordinatorError,
  type QuotaCoordinatorErrorResponse,
  type QuotaCoordinatorPathMismatchError,
  type QuotaCoordinatorServiceInfo,
  type QuotaReadingModeResponse,
  type QuotaReadyScrapeStatus,
} from "./coordinator-protocol.js";
import { assertQuotaSchemaVersion, QUOTA_SCHEMA_VERSION } from "./schema-guard.js";
import type { QuotaReadingMode, SharedQuotaStore } from "./shared-store.js";

export const SERVED_ROUTES = [
  "/v1/throttle",
  "/v1/quota",
  "/v1/history",
  "/v1/healthz",
  "/v1/readyz",
] as const;

/**
 * Write-contract policy for the operator routes. Neither value is derived
 * from observed producer behaviour; both are ceilings chosen from what the
 * coordinator already tolerates elsewhere.
 *
 * Future skew: a reading is stamped with the panel's own `scrapedAt`, so the
 * only legitimate way it is "in the future" is clock skew between the machine
 * that read the panel and this one. Five minutes is one observation slot
 * (`SLOT_MS` in shared-store.ts): anything larger would let a reading claim a
 * slot no scrape could reach yet.
 *
 * Body ceiling: a complete four-window snapshot with labels and explanations
 * serialises to well under 4 KiB; 64 KiB is sixteen times that, small enough
 * to buffer as a string on the socket and large enough that no honest client
 * has to think about it.
 */
const MANUAL_OBSERVATION_MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_WRITE_BODY_BYTES = 64 * 1024;

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
      void this.handleRequest(req, res);
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

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      await this.dispatchRequest(req, res);
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

  private async readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let body = "";
      let bytes = 0;
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_WRITE_BODY_BYTES) {
          reject(new Error("Request body exceeds 64 KiB"));
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.once("error", reject);
      req.once("aborted", () => reject(new Error("Request was aborted")));
      req.once("end", () => {
        if (!body.trim()) {
          reject(new Error("Request body must be JSON"));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("Request body must be valid JSON"));
        }
      });
    });
  }

  private configuredProvider(rawProvider: unknown): string | null {
    if (typeof rawProvider !== "string") return null;
    const provider = normalizeProviderThrottleKey(rawProvider);
    return provider && this.configuredProviders.includes(provider) ? provider : null;
  }

  private async dispatchRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const serviceInfo = this.getServiceInfo();
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // The operator write routes (#573) live outside `/v1/` so the GET-only
    // public contract below (§5.2 / Criterion 7) stays intact. The coordinator
    // daemon is the sole writer of the quota database and owns the controller
    // advance and publish that must follow the write, so the operator reports
    // the reading and the daemon records it; the socket's file mode is the
    // whole of their authorization.
    if (pathname === QUOTA_READING_MODE_PATH || pathname === MANUAL_QUOTA_OBSERVATION_PATH) {
      if (req.method !== "POST") {
        this.sendError(
          res,
          405,
          {
            code: "method_not_allowed",
            message: `Method ${req.method} not allowed on ${pathname}; only POST is permitted`,
            retryable: false,
          },
          { Allow: "POST" }
        );
        return;
      }
      if (pathname === QUOTA_READING_MODE_PATH) {
        await this.setQuotaReadingMode(req, res, serviceInfo);
      } else {
        await this.recordManualObservation(req, res, serviceInfo);
      }
      return;
    }

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
        for (const provider of this.configuredProviders) {
          const { mode, generation } = this.options.store.getQuotaReadingMode(provider);
          scrapes[provider] = {
            ...(scrapes[provider] ?? { scrapedAt: null, status: "pending" }),
            readingMode: { mode, generation },
          };
        }

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

  /** `set_quota_reading_mode(provider, mode)`: switch one lane's collection authority. */
  private async setQuotaReadingMode(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    serviceInfo: QuotaCoordinatorServiceInfo
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.readJsonBody(req);
    } catch (error) {
      this.sendError(res, 400, {
        code: "invalid_request",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
      return;
    }
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      !["manual", "scrape"].includes((body as { mode?: unknown }).mode as string)
    ) {
      this.sendError(res, 400, {
        code: "invalid_request",
        message: "Body must contain provider and mode (manual or scrape)",
        retryable: false,
      });
      return;
    }
    const provider = this.configuredProvider((body as { provider?: unknown }).provider);
    if (!provider) {
      this.sendError(res, 404, {
        code: "provider_unknown",
        message: "Provider is missing or not configured on this coordinator",
        retryable: false,
      });
      return;
    }
    const mode = (body as { mode: QuotaReadingMode }).mode;
    const state = this.options.store.setQuotaReadingMode(
      provider,
      mode,
      new Date(this.options.now ? this.options.now() : Date.now()).toISOString()
    );
    this.sendJson<QuotaReadingModeResponse>(res, 200, {
      service: serviceInfo,
      provider,
      mode: state.mode,
      generation: state.generation,
    });
  }

  /** Accept one manual reading for a manual-mode lane and reason it immediately. */
  private async recordManualObservation(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    serviceInfo: QuotaCoordinatorServiceInfo
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.readJsonBody(req);
    } catch (error) {
      this.sendError(res, 400, {
        code: "invalid_request",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      this.sendError(res, 400, {
        code: "invalid_request",
        message: "Body must be a manual observation request object",
        retryable: false,
      });
      return;
    }
    const request = body as { provider?: unknown; generation?: unknown; observation?: unknown };
    const provider = this.configuredProvider(request.provider);
    if (!provider) {
      this.sendError(res, 404, {
        code: "provider_unknown",
        message: "Provider is missing or not configured on this coordinator",
        retryable: false,
      });
      return;
    }
    const idempotencyKey = req.headers["idempotency-key"];
    const problem =
      typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200
        ? "Idempotency-Key header is required (1-200 characters)"
        : !Number.isSafeInteger(request.generation)
          ? "generation must be the integer returned by the reading-mode switch"
          : manualQuotaObservationProblem(request.observation, provider);
    if (problem !== null || !isValidManualQuotaObservation(request.observation, provider)) {
      this.sendError(res, 400, {
        code: "invalid_request",
        message: problem ?? "observation is invalid",
        retryable: false,
      });
      return;
    }
    const nowMs = this.options.now ? this.options.now() : Date.now();
    const observation = request.observation;
    const generation = request.generation as number;
    const observedAtMs = Date.parse(observation.scrapedAt);
    if (observedAtMs > nowMs + MANUAL_OBSERVATION_MAX_FUTURE_MS) {
      this.sendError(res, 400, {
        code: "invalid_request",
        message: "Observation scrapedAt is more than five minutes in the future",
        retryable: false,
      });
      return;
    }
    if (nowMs - observedAtMs > this.hardStaleAfterMs) {
      this.sendError(res, 409, {
        code: "stale_observation",
        message: "Observation is older than the coordinator hard-stale threshold",
        retryable: false,
      });
      return;
    }
    const result = this.options.store.recordManualObservation(
      {
        snapshot: observation,
        generation,
        idempotencyKey: (idempotencyKey as string).trim(),
        acceptedAt: new Date(nowMs).toISOString(),
      },
      { maxIntervalSeconds: this.maxIntervalSeconds }
    );
    if (result.result === "accepted" || result.result === "duplicate") {
      this.sendJson<ManualQuotaObservationResponse>(res, 200, {
        service: serviceInfo,
        provider,
        observedAt: result.observedAt,
        generation: result.generation,
        duplicate: result.result === "duplicate",
      });
      return;
    }
    if (result.result === "generation_mismatch") {
      this.sendError(res, 409, {
        code: "mode_generation_mismatch",
        message: `Observation generation does not match current generation ${result.generation}`,
        retryable: false,
      });
      return;
    }
    const failure = {
      manual_mode_required: {
        status: 409,
        code: "manual_mode_required" as const,
        message: "Manual observations are accepted only while the provider is in manual mode",
      },
      stale_observation: {
        status: 409,
        code: "stale_observation" as const,
        message:
          "Observation is not newer than, or is outranked by, the current authoritative observation",
      },
      idempotency_conflict: {
        status: 409,
        code: "idempotency_conflict" as const,
        message: "Idempotency-Key was already used for a different observation",
      },
    }[result.result];
    this.sendError(res, failure.status, { ...failure, retryable: false });
  }
}
