import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname } from "node:path";
import { QUOTA_THROTTLE_PROVIDERS } from "../providers/registry.js";
import {
  COORDINATOR_PROTOCOL_MAJOR,
  COORDINATOR_PROTOCOL_MINOR,
  DEFAULT_HARD_STALE_AFTER_MS,
  DEFAULT_MAX_INTERVAL_SECONDS,
  DEFAULT_STALE_AFTER_MS,
  type PublishedThrottleProviderStatus,
  publishedThrottle,
  type QuotaCoordinatorError,
  type QuotaCoordinatorErrorResponse,
  type QuotaCoordinatorServiceInfo,
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
}

export class QuotaCoordinatorService {
  private server: http.Server | null = null;
  private boundSocketPath: string | null = null;
  private readonly configuredProviders: readonly string[];
  private readonly maxIntervalSeconds: number;
  private readonly staleAfterMs: number;
  private readonly hardStaleAfterMs: number;

  constructor(readonly options: QuotaCoordinatorServiceOptions) {
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
    error: QuotaCoordinatorError,
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

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      this.dispatchRequest(req, res);
    } catch (err) {
      this.sendError(res, 500, {
        code: "internal_error",
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      });
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

        const provider = rawParam === "antigravity" ? "agy" : rawParam.toLocaleLowerCase("en-US");
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
          this.sendError(res, 503, {
            code: "not_ready",
            message: `Coordinator is cold: no observations recorded for provider "${provider}" yet`,
            retryable: true,
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

      // Collection form: /v1/throttle without ?provider=
      const providersMap: Record<string, PublishedThrottleProviderStatus> = {};
      for (const p of this.configuredProviders) {
        const stored = this.options.store.getProviderThrottle(p);
        if (stored) {
          providersMap[p] = publishedThrottle(stored, {
            maxIntervalSeconds: this.maxIntervalSeconds,
            staleAfterMs: this.staleAfterMs,
            hardStaleAfterMs: this.hardStaleAfterMs,
            nowMs,
          });
        }
      }

      this.sendJson(res, 200, {
        service: serviceInfo,
        providers: providersMap,
      });
      return;
    }

    if (pathname === "/v1/quota") {
      const rawParam = url.searchParams.get("provider")?.trim() ?? "";
      const provider = rawParam === "antigravity" ? "agy" : rawParam.toLocaleLowerCase("en-US");

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
      const provider = rawParam === "antigravity" ? "agy" : rawParam.toLocaleLowerCase("en-US");

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

        const scrapes: Record<
          string,
          { scrapedAt: string; status: "ok" | "error"; error?: string }
        > = {};
        for (const r of scrapeRows) {
          scrapes[r.provider] = {
            scrapedAt: r.scraped_at,
            status: r.parse_error ? "error" : "ok",
            ...(r.parse_error ? { error: r.parse_error } : {}),
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

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        service: serviceInfo,
        error: {
          code: "provider_unknown",
          message: `Path ${pathname} not found`,
          retryable: false,
        },
      })
    );
  }
}
