import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuotaService } from "../mcp/quota-mcp.js";
import { createLogger } from "../observability/logger.js";
import { QuotaCoordinatorClient } from "./coordinator-client.js";
import { QuotaCollectionLoop } from "./coordinator-collection.js";
import {
  createQuotaMetrics,
  QUOTA_CLIENT_METRICS,
  QUOTA_METRIC_EVENT,
  QUOTA_SERVICE_METRICS,
  type QuotaMetricLabels,
  type QuotaMetrics,
} from "./coordinator-metrics.js";
import { QuotaCoordinatorService } from "./coordinator-service.js";
import { SharedQuotaStore } from "./shared-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

interface RecordedMetric {
  metric: string;
  type: string;
  value: number;
  labels: QuotaMetricLabels;
}

/** A metrics sink that keeps every emission, for asserting on series. */
function recordingMetrics(): { metrics: QuotaMetrics; emitted: RecordedMetric[] } {
  const emitted: RecordedMetric[] = [];
  const metrics: QuotaMetrics = {
    counter: (metric, labels, delta = 1) =>
      emitted.push({ metric, type: "counter", value: delta, labels: labels ?? {} }),
    histogram: (metric, value, labels) =>
      emitted.push({ metric, type: "histogram", value, labels: labels ?? {} }),
    gauge: (metric, value, labels) =>
      emitted.push({ metric, type: "gauge", value, labels: labels ?? {} }),
  };
  return { metrics, emitted };
}

function seriesOf(emitted: RecordedMetric[], metric: string): RecordedMetric[] {
  return emitted.filter((m) => m.metric === metric);
}

function request(socketPath: string, path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        let json: unknown = {};
        try {
          json = JSON.parse(body);
        } catch {}
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("createQuotaMetrics", () => {
  it("emits one structured record per sample, with the series in fields not prose", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      format: "json",
      destination: {
        write: (chunk: string) => {
          lines.push(chunk);
        },
      },
    });

    createQuotaMetrics(logger).counter(QUOTA_SERVICE_METRICS.scrapesTotal, {
      provider: "claude",
      outcome: "failure",
    });

    const records = lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      msg: QUOTA_METRIC_EVENT,
      metric: "quota_service_scrapes_total",
      type: "counter",
      value: 1,
      provider: "claude",
      outcome: "failure",
    });
  });

  it("carries the increment, not a running total, so a restart reads as a gap", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      format: "json",
      destination: {
        write: (chunk: string) => {
          lines.push(chunk);
        },
      },
    });
    const metrics = createQuotaMetrics(logger);
    metrics.counter(QUOTA_SERVICE_METRICS.readsTotal, { path: "/v1/throttle" });
    metrics.counter(QUOTA_SERVICE_METRICS.readsTotal, { path: "/v1/throttle" });

    const values = lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { value: number }).value);
    expect(values).toEqual([1, 1]);
  });

  it("emits at the default level under its own event name, so no unit-wide level flip is needed", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      format: "json",
      destination: {
        write: (chunk: string) => {
          lines.push(chunk);
        },
      },
    });
    createQuotaMetrics(logger).gauge(QUOTA_SERVICE_METRICS.snapshotAgeSeconds, 12, {
      provider: "claude",
    });
    const records = lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    // The event name is the selector between metrics and lifecycle records.
    expect(records[0]).toMatchObject({ level: "info", msg: QUOTA_METRIC_EVENT });
  });

  it("drops a non-finite sample rather than writing NaN into the series", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      format: "json",
      destination: {
        write: (chunk: string) => {
          lines.push(chunk);
        },
      },
    });
    createQuotaMetrics(logger).gauge(QUOTA_SERVICE_METRICS.snapshotAgeSeconds, Number.NaN, {
      provider: "claude",
    });
    expect(lines).toEqual([]);
  });
});

describe("collection metrics", () => {
  it("counts a probe by outcome and times it", async () => {
    const store = new SharedQuotaStore(join(makeRoot("rusa-quota-metrics-"), "quota.db"));
    const { metrics, emitted } = recordingMetrics();
    try {
      const loop = new QuotaCollectionLoop({
        store,
        metrics,
        quotaService: {
          getQuotaProbeOutcome: vi
            .fn()
            .mockResolvedValueOnce({
              state: { provider: "claude", status: "available", scrapedAt: "2030-01-01T00:00:00Z" },
              didProbe: true,
            })
            .mockResolvedValueOnce({
              error: new Error("workersDir is not writable"),
              didProbe: true,
            })
            // A cached reading is not a probe and must not move the series.
            .mockResolvedValue({
              state: { provider: "claude", status: "available" },
              didProbe: false,
            }),
          hydrate: vi.fn(),
        } as unknown as QuotaService,
        providers: ["claude"],
      });

      await loop.tick();
      await loop.tick();
      await loop.tick();

      expect(
        seriesOf(emitted, QUOTA_SERVICE_METRICS.scrapesTotal).map((m) => m.labels.outcome)
      ).toEqual(["success", "failure"]);
      expect(seriesOf(emitted, QUOTA_SERVICE_METRICS.scrapeSeconds)).toHaveLength(2);
      expect(
        seriesOf(emitted, QUOTA_SERVICE_METRICS.scrapeSeconds)[0].value
      ).toBeGreaterThanOrEqual(0);
    } finally {
      store.close();
    }
  });

  it("retains an unknown reading's own message where readiness can read it", async () => {
    // The probe path reports a failed scrape or parse as data, not a throw. Its
    // message is the only thing that distinguishes "the codex TUI never
    // launched" from "the panel would not parse" (#517), so readiness must
    // report it instead of the generic unknown-reading phrase.
    const store = new SharedQuotaStore(join(makeRoot("rusa-quota-metrics-"), "quota.db"));
    try {
      const loop = new QuotaCollectionLoop({
        store,
        quotaService: {
          getQuotaProbeOutcome: vi.fn().mockResolvedValue({
            state: {
              provider: "codex",
              status: "unknown",
              message:
                "codex /status scrape failed: codex /status scrape failed with exit code 1: " +
                "ERROR: /status panel never rendered in Codex session",
            },
            didProbe: true,
          }),
          hydrate: vi.fn(),
        } as unknown as QuotaService,
        providers: ["codex"],
      });

      await loop.tick();

      const stats = loop.getAllStats().codex;
      expect(stats.lastOutcome).toBe("failure");
      expect(stats.lastError).toContain("panel never rendered");
      expect(stats.lastError).not.toContain("probe returned an unknown reading");
    } finally {
      store.close();
    }
  });

  it("retains the failing probe's message where readiness can read it", async () => {
    const store = new SharedQuotaStore(join(makeRoot("rusa-quota-metrics-"), "quota.db"));
    try {
      const loop = new QuotaCollectionLoop({
        store,
        quotaService: {
          getQuotaProbeOutcome: vi
            .fn()
            .mockResolvedValue({ error: new Error("ENOENT: workers dir"), didProbe: true }),
          hydrate: vi.fn(),
        } as unknown as QuotaService,
        providers: ["claude"],
      });

      await loop.tick();

      const stats = loop.getAllStats().claude;
      expect(stats.lastOutcome).toBe("failure");
      expect(stats.lastError).toContain("workers dir");
      expect(stats.lastAttemptAt).not.toBeNull();
      // No successful reading ever landed, so there is nothing to report as one.
      expect(stats.lastScrapedAt).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("store metrics", () => {
  it("counts parses, observations and controller steps at the sites that own them", () => {
    const store = new SharedQuotaStore(join(makeRoot("rusa-quota-metrics-"), "quota.db"));
    const { metrics, emitted } = recordingMetrics();
    try {
      store.setMetrics(metrics);
      store.configureController({ maxIntervalSeconds: 3600 });
      const scrapedAt = "2030-01-01T00:00:00.000Z";
      const state = {
        provider: "claude",
        status: "available" as const,
        scrapedAt,
        limits: [
          {
            label: "Weekly",
            kind: "weekly" as const,
            percentLeft: 50,
            resetAtIso: "2030-01-08T00:00:00.000Z",
            scope: { provider: "claude" },
          },
        ],
      };
      const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "fixture" });
      store.recordParsed(id, state, state);

      expect(seriesOf(emitted, QUOTA_SERVICE_METRICS.parsesTotal)).toMatchObject([
        { labels: { provider: "claude", outcome: "success" } },
      ]);
      expect(seriesOf(emitted, QUOTA_SERVICE_METRICS.observationsTotal)).toMatchObject([
        { labels: { provider: "claude", result: "recorded" } },
      ]);
      expect(seriesOf(emitted, QUOTA_SERVICE_METRICS.controllerStepsTotal)).toMatchObject([
        { labels: { provider: "claude" } },
      ]);
    } finally {
      store.close();
    }
  });

  it("counts a failed parse against the provider whose scrape it was", () => {
    const store = new SharedQuotaStore(join(makeRoot("rusa-quota-metrics-"), "quota.db"));
    const { metrics, emitted } = recordingMetrics();
    try {
      store.setMetrics(metrics);
      const id = store.recordRaw({
        provider: "codex",
        scrapedAt: "2030-01-01T00:00:00.000Z",
        rawOutput: "unparseable",
      });
      store.recordParseError(id, new Error("no windows found"));

      expect(seriesOf(emitted, QUOTA_SERVICE_METRICS.parsesTotal)).toMatchObject([
        { labels: { provider: "codex", outcome: "failure" } },
      ]);
    } finally {
      store.close();
    }
  });
});

describe("service metrics and readiness", () => {
  it("counts reads by routed path and status, never by raw URL", async () => {
    const root = makeRoot("rusa-quota-metrics-");
    const store = new SharedQuotaStore(join(root, "quota.db"));
    const { metrics, emitted } = recordingMetrics();
    const socketPath = join(root, "coordinator.sock");
    const service = new QuotaCoordinatorService({
      socketPath,
      store,
      metrics,
      configuredProviders: ["claude"],
    });
    await service.start();
    try {
      await request(socketPath, "/v1/healthz");
      await request(socketPath, "/v1/throttle?provider=claude");
      await request(socketPath, "/v1/nope");

      expect(
        seriesOf(emitted, QUOTA_SERVICE_METRICS.readsTotal).map((m) => [
          m.labels.path,
          m.labels.status,
        ])
      ).toEqual([
        ["/v1/healthz", 200],
        // Cold coordinator: a 200 not_ready (#480) is still a read, and the label is the routed
        // path, not the provider-bearing query string.
        ["/v1/throttle", 200],
        ["unrouted", 404],
      ]);
    } finally {
      await service.stop();
      store.close();
    }
  });

  it("samples the published interval and snapshot age once per controller step", async () => {
    const root = makeRoot("rusa-quota-metrics-");
    const store = new SharedQuotaStore(join(root, "quota.db"));
    const { metrics, emitted } = recordingMetrics();
    store.configureController({ maxIntervalSeconds: 3600 });
    const scrapedAt = new Date().toISOString();
    const state = {
      provider: "claude",
      status: "available" as const,
      scrapedAt,
      limits: [
        {
          label: "Weekly",
          kind: "weekly" as const,
          percentLeft: 50,
          resetAtIso: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
          scope: { provider: "claude" },
        },
      ],
    };
    const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "fixture" });
    store.recordParsed(id, state, state);

    const socketPath = join(root, "coordinator.sock");
    const loop = new QuotaCollectionLoop({
      store,
      quotaService: {
        getQuotaProbeOutcome: vi.fn().mockResolvedValue({ didProbe: false }),
        hydrate: vi.fn(),
      } as unknown as QuotaService,
      providers: ["claude"],
      maxIntervalSeconds: 3600,
      metrics,
    });
    const service = new QuotaCoordinatorService({
      socketPath,
      store,
      metrics,
      maxIntervalSeconds: 3600,
      configuredProviders: ["claude"],
      collectionStats: () => loop.getAllStats(),
    });
    await service.start();
    try {
      await loop.tick();

      const published = seriesOf(emitted, QUOTA_SERVICE_METRICS.publishedIntervalSeconds);
      expect(published).toHaveLength(1);
      expect(published[0].labels.provider).toBe("claude");
      const age = seriesOf(emitted, QUOTA_SERVICE_METRICS.snapshotAgeSeconds);
      expect(age).toHaveLength(1);
      expect(age[0].value).toBeGreaterThanOrEqual(0);

      // The gauge is the value the service serves, not an approximation of it.
      const res = await request(socketPath, "/v1/throttle?provider=claude");
      expect(res.status).toBe(200);
      expect(published[0].value).toBe((res.json as { intervalSeconds: number }).intervalSeconds);
    } finally {
      await service.stop();
      store.close();
    }
  });

  it("does not emit a published gauge per read, so the series is not a read rate", async () => {
    const root = makeRoot("rusa-quota-metrics-");
    const store = new SharedQuotaStore(join(root, "quota.db"));
    const { metrics, emitted } = recordingMetrics();
    store.configureController({ maxIntervalSeconds: 3600 });
    const scrapedAt = new Date().toISOString();
    const state = {
      provider: "claude",
      status: "available" as const,
      scrapedAt,
      limits: [],
    };
    const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "fixture" });
    store.recordParsed(id, state, state);

    const socketPath = join(root, "coordinator.sock");
    const service = new QuotaCoordinatorService({
      socketPath,
      store,
      metrics,
      configuredProviders: ["claude"],
    });
    await service.start();
    try {
      // Five reads, in both the single and collection forms. A pool of twenty
      // instances polling would otherwise turn one controller value into
      // hundreds of identical gauge samples an hour.
      for (let i = 0; i < 3; i++) await request(socketPath, "/v1/throttle?provider=claude");
      for (let i = 0; i < 2; i++) await request(socketPath, "/v1/throttle");

      expect(seriesOf(emitted, QUOTA_SERVICE_METRICS.publishedIntervalSeconds)).toHaveLength(0);
      expect(seriesOf(emitted, QUOTA_SERVICE_METRICS.snapshotAgeSeconds)).toHaveLength(0);
      // The read rate lives on the counter that is meant to carry it.
      expect(seriesOf(emitted, QUOTA_SERVICE_METRICS.readsTotal)).toHaveLength(5);
    } finally {
      await service.stop();
      store.close();
    }
  });

  it("reports a probe failure in readyz that never reached the database", async () => {
    const root = makeRoot("rusa-quota-metrics-");
    const store = new SharedQuotaStore(join(root, "quota.db"));
    const socketPath = join(root, "coordinator.sock");
    const loop = new QuotaCollectionLoop({
      store,
      quotaService: {
        getQuotaProbeOutcome: vi
          .fn()
          .mockResolvedValue({ error: new Error("workersDir is not writable"), didProbe: true }),
        hydrate: vi.fn(),
      } as unknown as QuotaService,
      providers: ["claude"],
    });
    const service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
      collectionStats: () => loop.getAllStats(),
    });
    await service.start();
    try {
      await loop.tick();

      // The probe failed before it could persist anything, so the database has
      // no scrape row at all — this is the silent failure mode the drill exists
      // to catch, and readiness has to surface it from the live loop.
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM quota_scrapes").get()).toMatchObject({
        n: 0,
      });

      const health = await request(socketPath, "/v1/healthz");
      expect(health.status).toBe(200);
      expect((health.json as { ok: boolean }).ok).toBe(true);

      const ready = await request(socketPath, "/v1/readyz");
      expect(ready.status).toBe(200);
      const scrapes = (ready.json as { scrapes: Record<string, Record<string, unknown>> }).scrapes;
      expect(scrapes.claude.status).toBe("error");
      expect(scrapes.claude.error).toContain("workersDir");
      expect(scrapes.claude.failures).toBe(1);
      expect(scrapes.claude.scrapedAt).toBeNull();
    } finally {
      await service.stop();
      store.close();
    }
  });

  it("reports a configured provider that has not been probed yet as pending", async () => {
    const root = makeRoot("rusa-quota-metrics-");
    const store = new SharedQuotaStore(join(root, "quota.db"));
    const socketPath = join(root, "coordinator.sock");
    const loop = new QuotaCollectionLoop({
      store,
      quotaService: { getQuotaProbeOutcome: vi.fn(), hydrate: vi.fn() } as unknown as QuotaService,
      providers: ["claude"],
    });
    const service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
      collectionStats: () => loop.getAllStats(),
    });
    await service.start();
    try {
      const ready = await request(socketPath, "/v1/readyz");
      const scrapes = (ready.json as { scrapes: Record<string, Record<string, unknown>> }).scrapes;
      expect(scrapes.claude.status).toBe("pending");
      expect(scrapes.claude.attempts).toBe(0);
    } finally {
      await service.stop();
      store.close();
    }
  });
});

describe("client metrics", () => {
  it("reports the applied interval and a reachable service", async () => {
    const root = makeRoot("rusa-quota-metrics-");
    const store = new SharedQuotaStore(join(root, "quota.db"));
    const { metrics, emitted } = recordingMetrics();
    store.configureController({ maxIntervalSeconds: 3600 });
    const scrapedAt = new Date().toISOString();
    const state = {
      provider: "claude",
      status: "available" as const,
      scrapedAt,
      limits: [
        {
          label: "Weekly",
          kind: "weekly" as const,
          percentLeft: 50,
          resetAtIso: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
          scope: { provider: "claude" },
        },
      ],
    };
    const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "fixture" });
    store.recordParsed(id, state, state);

    const socketPath = join(root, "coordinator.sock");
    const service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
    });
    await service.start();
    try {
      const client = new QuotaCoordinatorClient({ socketPath, metrics, source: "drill-client" });
      await client.getThrottle("claude");

      expect(seriesOf(emitted, QUOTA_CLIENT_METRICS.serviceConnected)).toMatchObject([
        { value: 1, labels: { source: "drill-client" } },
      ]);
      expect(seriesOf(emitted, QUOTA_CLIENT_METRICS.appliedIntervalSeconds)).toMatchObject([
        { labels: { source: "drill-client", provider: "claude" } },
      ]);
    } finally {
      await service.stop();
      store.close();
    }
  });

  it("reports zero when the socket is gone, which is what the alert watches", async () => {
    const root = makeRoot("rusa-quota-metrics-");
    const { metrics, emitted } = recordingMetrics();
    const client = new QuotaCoordinatorClient({
      socketPath: join(root, "absent.sock"),
      metrics,
      source: "drill-client",
    });

    expect(await client.getThrottle("claude")).toBeNull();

    expect(seriesOf(emitted, QUOTA_CLIENT_METRICS.serviceConnected)).toMatchObject([
      { value: 0, labels: { source: "drill-client" } },
    ]);
    // Rule 0 still holds: a client that never read starts at the ceiling.
    expect(client.getLastAppliedInterval("claude")).toBe(3600);
  });
});
