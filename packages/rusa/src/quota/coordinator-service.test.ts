import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertQuotaSchemaVersion, QUOTA_SCHEMA_VERSION } from "../db/wal.js";
import { QuotaCoordinatorClient } from "./coordinator-client.js";
import {
  COORDINATOR_PROTOCOL_MAJOR,
  COORDINATOR_PROTOCOL_MINOR,
  ProtocolMismatchError,
  publishedThrottle,
  validateProtocolMajor,
} from "./coordinator-protocol.js";
import { QuotaCoordinatorService, SERVED_ROUTES } from "./coordinator-service.js";
import { type PersistedQuotaProviderStatus, SharedQuotaStore } from "./shared-store.js";

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  // biome-ignore lint/suspicious/noExplicitAny: test response payload
  json: any;
}

function makeRequest(
  socketPath: string,
  path: string,
  method: string = "GET",
  body?: string
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: body
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
          : {},
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let json: TestResponse["json"] = {};
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data,
            json,
          });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("QuotaCoordinatorService contract tests (#353)", () => {
  let tmpDir: string;
  let dbPath: string;
  let socketPath: string;
  let store: SharedQuotaStore;
  let service: QuotaCoordinatorService;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "quota-coord-test-"));
    dbPath = join(tmpDir, "quota.db");
    socketPath = join(tmpDir, "coordinator.sock");
    store = new SharedQuotaStore(dbPath);
  });

  afterEach(async () => {
    if (service) {
      await service.stop();
    }
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Criterion 7: The surface is read-only.
  it("criterion 7: route/method: returns 405 on POST, PUT, PATCH, DELETE for every served route and accepts no body", async () => {
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude", "codex"],
    });
    await service.start();

    // Enumerate served routes
    expect(SERVED_ROUTES.length).toBeGreaterThan(0);
    const nonGetMethods = ["POST", "PUT", "PATCH", "DELETE"];

    for (const route of SERVED_ROUTES) {
      for (const method of nonGetMethods) {
        const res = await makeRequest(socketPath, route, method, JSON.stringify({ mutate: true }));
        expect(res.status, `Expected 405 for ${method} on ${route}`).toBe(405);
        expect(res.headers.allow).toContain("GET");
      }
    }
  });

  // Criterion 9: Protocol-major rejection is client-side and per-response.
  it("criterion 9: client-side per-response protocolMajor rejection keeps last interval and reports mismatch", () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const client = new QuotaCoordinatorClient({
      socketPath: "/dummy/sock",
      defaultIntervalSeconds: 600,
      logger,
    });

    // Initial valid application
    const validBody = {
      service: {
        protocolMajor: COORDINATOR_PROTOCOL_MAJOR,
        protocolMinor: COORDINATOR_PROTOCOL_MINOR,
        serverVersion: "0.1.0",
        serverTime: new Date().toISOString(),
      },
      provider: "claude",
      intervalSeconds: 300,
      uncappedIntervalSeconds: 300,
      governingBucketKey: "claude:session",
      capped: false,
      expired: false,
      exhaustedUntil: null,
      updatedAt: new Date().toISOString(),
      buckets: [],
      freshness: { ageMs: 0, buckets: {}, stale: false, hardStale: false },
    };

    const applied = client.applyResponse("claude", validBody);
    expect(applied).toBe(true);
    expect(client.getLastAppliedInterval("claude")).toBe(300);

    // Mismatched major body
    const mismatchedBody = {
      ...validBody,
      service: {
        ...validBody.service,
        protocolMajor: COORDINATOR_PROTOCOL_MAJOR + 1, // major bump
      },
      intervalSeconds: 120, // should be discarded
    };

    const appliedMismatch = client.applyResponse("claude", mismatchedBody);
    expect(appliedMismatch).toBe(false);
    // Interval remains unchanged (300, not 120)
    expect(client.getLastAppliedInterval("claude")).toBe(300);
    // Mismatch was reported
    expect(logger.warn).toHaveBeenCalled();

    // Direct protocol check also throws ProtocolMismatchError
    expect(() => validateProtocolMajor(mismatchedBody)).toThrow(ProtocolMismatchError);
  });

  // Criterion 2: publishedThrottle equality and boundary pin.
  it("criterion 2: publishedThrottle equals store when fresh, widens when hard-stale, and pins the capped boundary", async () => {
    const nowMs = 1700000000000;
    const maxIntervalSeconds = 3600;

    // Subtest A: boundary pin where uncappedIntervalSeconds === maxIntervalSeconds
    // Expected: intervalSeconds === uncappedIntervalSeconds AND capped === false
    const boundaryStored: PersistedQuotaProviderStatus = {
      provider: "claude",
      intervalSeconds: 600,
      uncappedIntervalSeconds: 3600, // equals maxIntervalSeconds
      governingBucketKey: "claude:weekly",
      capped: true,
      expired: false,
      exhaustedUntil: null,
      updatedAt: new Date(nowMs - 7200000).toISOString(),
      buckets: [
        {
          key: "claude:weekly",
          percentLeft: 50,
          timeRemainingPct: 50,
          error: 0,
          derivative: 0,
          requiredIntervalSeconds: 600,
          resetAtIso: null,
          observedAt: new Date(nowMs - 7200000).toISOString(), // 2 hours old -> hard-stale
        },
      ],
    };

    const boundaryPublished = publishedThrottle(boundaryStored, {
      maxIntervalSeconds,
      nowMs,
      hardStaleAfterMs: 3600000,
    });

    expect(boundaryPublished.freshness.hardStale).toBe(true);
    expect(boundaryPublished.intervalSeconds).toBe(3600);
    expect(boundaryPublished.intervalSeconds).toBe(boundaryPublished.uncappedIntervalSeconds);
    expect(boundaryPublished.capped).toBe(false); // strictly uncapped > interval: 3600 > 3600 is FALSE!

    // Subtest B: neighbouring case where uncappedIntervalSeconds > maxIntervalSeconds
    // Expected: intervalSeconds === maxIntervalSeconds AND capped === true
    const neighbouringStored: PersistedQuotaProviderStatus = {
      ...boundaryStored,
      uncappedIntervalSeconds: 3601, // strictly greater than maxIntervalSeconds
    };

    const neighbouringPublished = publishedThrottle(neighbouringStored, {
      maxIntervalSeconds,
      nowMs,
      hardStaleAfterMs: 3600000,
    });

    expect(neighbouringPublished.freshness.hardStale).toBe(true);
    expect(neighbouringPublished.intervalSeconds).toBe(3600);
    expect(neighbouringPublished.capped).toBe(true); // 3601 > 3600 is TRUE!

    // Subtest C: endpoint returns publishedThrottle field-for-field
    // Seed database with observations
    const scrapeId = store.recordRaw({
      provider: "claude",
      scrapedAt: new Date(nowMs - 10000).toISOString(),
      rawOutput: "test",
    });
    store.recordParsed(
      scrapeId,
      {
        provider: "claude",
        status: "available",
        scrapedAt: new Date(nowMs - 10000).toISOString(),
        limits: [
          {
            kind: "session",
            label: "Session",
            percentLeft: 80,
            resetAtIso: new Date(nowMs + 100000).toISOString(),
          },
        ],
      },
      {
        provider: "claude",
        status: "available",
        scrapedAt: new Date(nowMs - 10000).toISOString(),
        limits: [
          {
            kind: "session",
            label: "Session",
            percentLeft: 80,
            resetAtIso: new Date(nowMs + 100000).toISOString(),
          },
        ],
      }
    );
    store.configureController({ maxIntervalSeconds: 3600 });

    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
      now: () => nowMs,
    });
    await service.start();

    const res = await makeRequest(socketPath, "/v1/throttle?provider=claude");
    expect(res.status).toBe(200);
    expect(res.json.service.protocolMajor).toBe(COORDINATOR_PROTOCOL_MAJOR);

    const storedStatus = store.getProviderThrottle("claude");
    expect(storedStatus).not.toBeNull();
    if (!storedStatus) throw new Error("Expected storedStatus for claude");
    const expected = publishedThrottle(storedStatus, { nowMs });

    expect(res.json.provider).toBe(expected.provider);
    expect(res.json.intervalSeconds).toBe(expected.intervalSeconds);
    expect(res.json.uncappedIntervalSeconds).toBe(expected.uncappedIntervalSeconds);
    expect(res.json.governingBucketKey).toBe(expected.governingBucketKey);
    expect(res.json.capped).toBe(expected.capped);
    expect(res.json.expired).toBe(expected.expired);
    expect(res.json.exhaustedUntil).toBe(expected.exhaustedUntil);
    expect(res.json.freshness).toEqual(expected.freshness);
  });

  // Criterion 16: Collection form is byte-identical to single form without service block.
  it("criterion 16: collection form is map keyed by provider whose values are byte-identical to single form without service block", async () => {
    const nowMs = Date.now();
    // Seed observations for claude and codex
    for (const p of ["claude", "codex"]) {
      const id = store.recordRaw({
        provider: p,
        scrapedAt: new Date(nowMs - 5000).toISOString(),
        rawOutput: p,
      });
      store.recordParsed(
        id,
        {
          provider: p,
          status: "available",
          scrapedAt: new Date(nowMs - 5000).toISOString(),
          limits: [
            {
              kind: "session",
              label: "Session",
              percentLeft: 90,
              resetAtIso: new Date(nowMs + 50000).toISOString(),
            },
          ],
        },
        {
          provider: p,
          status: "available",
          scrapedAt: new Date(nowMs - 5000).toISOString(),
          limits: [
            {
              kind: "session",
              label: "Session",
              percentLeft: 90,
              resetAtIso: new Date(nowMs + 50000).toISOString(),
            },
          ],
        }
      );
    }
    store.configureController({ maxIntervalSeconds: 3600 });

    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude", "codex"],
      now: () => nowMs,
    });
    await service.start();

    // Call collection form
    const collRes = await makeRequest(socketPath, "/v1/throttle");
    expect(collRes.status).toBe(200);
    expect(collRes.json.providers).toBeDefined();

    for (const p of ["claude", "codex"]) {
      const singleRes = await makeRequest(socketPath, `/v1/throttle?provider=${p}`);
      expect(singleRes.status).toBe(200);

      const singleJson = JSON.parse(singleRes.body);
      delete singleJson.service;

      const collProviderValue = collRes.json.providers[p];
      expect(collProviderValue).toBeDefined();

      // Assert BYTE-IDENTITY:
      expect(JSON.stringify(collProviderValue)).toBe(JSON.stringify(singleJson));
    }
  });

  // Criterion 9: no databasePath anywhere on the wire.
  it("criterion 9: no v1 response carries databasePath anywhere", async () => {
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
    });
    await service.start();

    for (const route of SERVED_ROUTES) {
      const res = await makeRequest(socketPath, route);
      expect(res.body).not.toContain("databasePath");
    }
  });

  // Criterion 9 & §7: Schema version refusal.
  it("criterion 9 & §7: service refuses to open database with PRAGMA user_version newer than supported", () => {
    // Create DB with user_version = 2
    const futureDbPath = join(tmpDir, "future.db");
    const db = new Database(futureDbPath);
    db.pragma("user_version = 2");
    db.close();

    const futureStore = new SharedQuotaStore(futureDbPath);
    expect(() => {
      assertQuotaSchemaVersion(futureStore.db, QUOTA_SCHEMA_VERSION);
    }).toThrow(/newer than supported/);
    futureStore.close();
  });

  // §5.6: Two-code error envelope: provider_unknown and not_ready
  it("§5.6: returns provider_unknown (404) for unconfigured provider and not_ready (503) when cold", async () => {
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
    });
    await service.start();

    // 1. Unconfigured provider -> provider_unknown (404, not retryable)
    const unknownRes = await makeRequest(socketPath, "/v1/throttle?provider=unconfigured");
    expect(unknownRes.status).toBe(404);
    expect(unknownRes.json.error.code).toBe("provider_unknown");
    expect(unknownRes.json.error.retryable).toBe(false);
    expect(unknownRes.json.service.protocolMajor).toBe(COORDINATOR_PROTOCOL_MAJOR);

    // 2. Configured provider with no observations -> not_ready (503, retryable)
    const coldRes = await makeRequest(socketPath, "/v1/throttle?provider=claude");
    expect(coldRes.status).toBe(503);
    expect(coldRes.json.error.code).toBe("not_ready");
    expect(coldRes.json.error.retryable).toBe(true);
    expect(coldRes.json.service.protocolMajor).toBe(COORDINATOR_PROTOCOL_MAJOR);
  });

  // §5.5: GET /v1/quota
  it("§5.5: GET /v1/quota returns unknown shape when cold, unsupported when unconfigured, and snapshot when present", async () => {
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
    });
    await service.start();

    // 1. Cold configured provider -> status: "unknown" with freshness block
    const coldRes = await makeRequest(socketPath, "/v1/quota?provider=claude");
    expect(coldRes.status).toBe(200);
    expect(coldRes.json.status).toBe("unknown");
    expect(coldRes.json.freshness).toBeDefined();
    expect(coldRes.json.freshness.stale).toBe(true);
    expect(coldRes.json.freshness.hardStale).toBe(true);

    // 2. Unconfigured provider -> status: "unsupported"
    const unsuppRes = await makeRequest(socketPath, "/v1/quota?provider=codex");
    expect(unsuppRes.status).toBe(200);
    expect(unsuppRes.json.status).toBe("unsupported");

    // 3. Provider with snapshot
    const nowMs = Date.now();
    const id = store.recordRaw({
      provider: "claude",
      scrapedAt: new Date(nowMs).toISOString(),
      rawOutput: "sample",
    });
    store.recordParsed(
      id,
      {
        provider: "claude",
        status: "available",
        scrapedAt: new Date(nowMs).toISOString(),
        limits: [{ kind: "session", label: "Session", percentLeft: 75 }],
      },
      {
        provider: "claude",
        status: "available",
        scrapedAt: new Date(nowMs).toISOString(),
        limits: [{ kind: "session", label: "Session", percentLeft: 75 }],
      }
    );

    const warmRes = await makeRequest(socketPath, "/v1/quota?provider=claude");
    expect(warmRes.status).toBe(200);
    expect(warmRes.json.status).toBe("available");
    expect(warmRes.json.provider).toBe("claude");
    expect(warmRes.json.limits[0].percentLeft).toBe(75);
  });

  // §5.5: GET /v1/history
  it("§5.5: GET /v1/history returns stored history records since requested timestamp", async () => {
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
    });
    await service.start();

    const nowMs = Date.now();
    const id = store.recordRaw({
      provider: "claude",
      scrapedAt: new Date(nowMs - 2000).toISOString(),
      rawOutput: "raw",
    });
    store.recordParsed(
      id,
      {
        provider: "claude",
        status: "available",
        scrapedAt: new Date(nowMs - 2000).toISOString(),
        limits: [{ kind: "session", label: "Session", percentLeft: 85 }],
      },
      {
        provider: "claude",
        status: "available",
        scrapedAt: new Date(nowMs - 2000).toISOString(),
        limits: [{ kind: "session", label: "Session", percentLeft: 85 }],
      }
    );
    store.configureController({ maxIntervalSeconds: 3600 });

    const since = new Date(nowMs - 5000).toISOString();
    const res = await makeRequest(
      socketPath,
      `/v1/history?provider=claude&since=${encodeURIComponent(since)}`
    );
    expect(res.status).toBe(200);
    expect(res.json.service.protocolMajor).toBe(COORDINATOR_PROTOCOL_MAJOR);
    expect(Array.isArray(res.json.records)).toBe(true);
    expect(res.json.records.length).toBeGreaterThan(0);
    expect(res.json.records[0].percentLeft).toBe(85);
  });

  // §5.5: GET /v1/healthz and GET /v1/readyz
  it("§5.5: healthz and readyz report readiness, schema version, and cold state honest to SQLite", async () => {
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
    });
    await service.start();

    // Healthz
    const healthRes = await makeRequest(socketPath, "/v1/healthz");
    expect(healthRes.status).toBe(200);
    expect(healthRes.json.ok).toBe(true);
    expect(healthRes.json.service.protocolMajor).toBe(COORDINATOR_PROTOCOL_MAJOR);

    // Readyz when cold
    const coldReadyRes = await makeRequest(socketPath, "/v1/readyz");
    expect(coldReadyRes.status).toBe(200);
    expect(coldReadyRes.json.ready).toBe(true);
    expect(coldReadyRes.json.cold).toBe(true);
    expect(coldReadyRes.json.schemaVersion).toBe(QUOTA_SCHEMA_VERSION);

    // Record observation to make it warm
    const nowMs = Date.now();
    const id = store.recordRaw({
      provider: "claude",
      scrapedAt: new Date(nowMs).toISOString(),
      rawOutput: "raw",
    });
    store.recordParsed(
      id,
      {
        provider: "claude",
        status: "available",
        scrapedAt: new Date(nowMs).toISOString(),
        limits: [{ kind: "session", label: "Session", percentLeft: 95 }],
      },
      {
        provider: "claude",
        status: "available",
        scrapedAt: new Date(nowMs).toISOString(),
        limits: [{ kind: "session", label: "Session", percentLeft: 95 }],
      }
    );

    const warmReadyRes = await makeRequest(socketPath, "/v1/readyz");
    expect(warmReadyRes.status).toBe(200);
    expect(warmReadyRes.json.ready).toBe(true);
    expect(warmReadyRes.json.cold).toBe(false);
    expect(warmReadyRes.json.scrapes.claude.status).toBe("ok");
  });
});
