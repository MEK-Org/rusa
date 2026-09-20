import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuotaCoordinatorClient } from "./coordinator-client.js";
import {
  COORDINATOR_PROTOCOL_MAJOR,
  COORDINATOR_PROTOCOL_MINOR,
  calculateFreshness,
  DEFAULT_MAX_INTERVAL_SECONDS,
  ProtocolMismatchError,
  publishedThrottle,
  validateProtocolMajor,
} from "./coordinator-protocol.js";
import { QuotaCoordinatorService, SERVED_ROUTES } from "./coordinator-service.js";
import { QUOTA_SCHEMA_VERSION, SchemaVersionRefusalError } from "./schema-guard.js";
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

    for (const baseRoute of SERVED_ROUTES) {
      for (const method of nonGetMethods) {
        const res = await makeRequest(
          socketPath,
          baseRoute,
          method,
          JSON.stringify({ mutate: true })
        );
        expect(res.status, `Expected 405 for ${method} on ${baseRoute}`).toBe(405);
        expect(res.headers.allow).toContain("GET");
      }

      // Assert GET with a body does not fail or mutate — body is ignored
      const route = baseRoute === "/v1/history" ? "/v1/history?provider=claude" : baseRoute;
      const getWithBody = await makeRequest(
        socketPath,
        route,
        "GET",
        JSON.stringify({ mutate: true })
      );
      expect([200, 503].includes(getWithBody.status)).toBe(true);
    }
  });

  it("holds a host-reported Kimi five-hour 403 against a lagging scrape until the panel's window rolls over", async () => {
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["kimi"],
    });
    await service.start();

    const scrapedAt = "2030-01-01T00:00:00.000Z";
    const resetAtIso = "2030-01-01T05:00:00.000Z";
    const available = {
      provider: "kimi",
      status: "available" as const,
      scrapedAt,
      limits: [
        {
          label: "5-hour",
          kind: "five_hour" as const,
          scope: "provider" as const,
          percentLeft: 100,
          resetAtIso,
        },
      ],
    };
    const id = store.recordRaw({ provider: "kimi", scrapedAt, rawOutput: "available panel" });
    store.recordParsed(id, available, available);

    const client = new QuotaCoordinatorClient({ socketPath });
    const exhausted = await client.recordKimiFiveHourLimit("2030-01-01T00:01:00.000Z");
    expect(exhausted).toMatchObject({
      provider: "kimi",
      expired: true,
      exhaustedUntil: resetAtIso,
    });

    // The same panel still reporting capacity for the same window is the
    // lagging reading the live 403 disproved; it must not re-admit Kimi.
    const lagging = {
      ...available,
      scrapedAt: "2030-01-01T00:02:00.000Z",
      limits: [{ ...available.limits[0], percentLeft: 80 }],
    };
    const laggingId = store.recordRaw({
      provider: "kimi",
      scrapedAt: lagging.scrapedAt,
      rawOutput: "lagging panel",
    });
    store.recordParsed(laggingId, lagging, lagging);
    expect(await client.getThrottle("kimi")).toMatchObject({
      expired: true,
      exhaustedUntil: resetAtIso,
    });

    const recovered = {
      ...available,
      scrapedAt: "2030-01-01T00:07:00.000Z",
      limits: [{ ...available.limits[0], resetAtIso: "2030-01-01T10:00:00.000Z" }],
    };
    const recoveryId = store.recordRaw({
      provider: "kimi",
      scrapedAt: recovered.scrapedAt,
      rawOutput: "next-window panel",
    });
    store.recordParsed(recoveryId, recovered, recovered);

    const throttle = await client.getThrottle("kimi");
    expect(throttle).toMatchObject({ expired: false, exhaustedUntil: null });
  });

  // Criterion 9: Protocol-major rejection is client-side and per-response.
  it("criterion 9: client-side per-response protocolMajor rejection keeps last interval and reports mismatch", () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const client = new QuotaCoordinatorClient({
      socketPath: "/dummy/sock",
      maxIntervalSeconds: 600,
      logger,
    });

    // Rule 0: client with no successful read starts at maxIntervalSeconds
    expect(client.getLastAppliedInterval("claude")).toBe(600);

    // Rule 0 with no configured ceiling falls back to DEFAULT_MAX_INTERVAL_SECONDS,
    // never to a "normal interval" default — degradation starts at the slow end.
    const bareClient = new QuotaCoordinatorClient({ socketPath: "/dummy/sock" });
    expect(bareClient.getLastAppliedInterval("claude")).toBe(DEFAULT_MAX_INTERVAL_SECONDS);

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

    // Rule 2: past hardStaleAfterMs, client widens to maxIntervalSeconds
    let now = Date.now();
    const staleClient = new QuotaCoordinatorClient({
      socketPath: "/dummy/sock",
      maxIntervalSeconds: 3600,
      hardStaleAfterMs: 1000,
      now: () => now,
    });
    staleClient.applyResponse("claude", validBody);
    expect(staleClient.getLastAppliedInterval("claude")).toBe(300);
    now += 2000; // advance past hardStaleAfterMs
    expect(staleClient.getLastAppliedInterval("claude")).toBe(3600);
  });

  it("criterion 9: client getThrottle performs protocol validation on live responses", async () => {
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
      version: "0.1.0",
    });
    await service.start();

    const client = new QuotaCoordinatorClient({ socketPath });
    const throttle = await client.getThrottle();
    expect(throttle).not.toBeNull();
    expect(throttle?.service.protocolMajor).toBe(COORDINATOR_PROTOCOL_MAJOR);
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

    const serviceOpts = {
      socketPath,
      store,
      configuredProviders: ["claude"],
      now: () => nowMs,
      maxIntervalSeconds: 3600,
      staleAfterMs: 900000,
      hardStaleAfterMs: 3600000,
    };
    service = new QuotaCoordinatorService(serviceOpts);
    await service.start();

    const res = await makeRequest(socketPath, "/v1/throttle?provider=claude");
    expect(res.status).toBe(200);
    expect(res.json.service.protocolMajor).toBe(COORDINATOR_PROTOCOL_MAJOR);

    const storedStatus = store.getProviderThrottle("claude");
    expect(storedStatus).not.toBeNull();
    if (!storedStatus) throw new Error("Expected storedStatus for claude");
    const expected = publishedThrottle(storedStatus, {
      nowMs,
      maxIntervalSeconds: serviceOpts.maxIntervalSeconds,
      staleAfterMs: serviceOpts.staleAfterMs,
      hardStaleAfterMs: serviceOpts.hardStaleAfterMs,
    });

    expect(res.json.provider).toBe(expected.provider);
    expect(res.json.intervalSeconds).toBe(expected.intervalSeconds);
    expect(res.json.uncappedIntervalSeconds).toBe(expected.uncappedIntervalSeconds);
    expect(res.json.governingBucketKey).toBe(expected.governingBucketKey);
    expect(res.json.capped).toBe(expected.capped);
    expect(res.json.expired).toBe(expected.expired);
    expect(res.json.exhaustedUntil).toBe(expected.exhaustedUntil);
    expect(res.json.updatedAt).toBe(expected.updatedAt);
    expect(res.json.buckets).toEqual(expected.buckets);
    expect(res.json.freshness).toEqual(expected.freshness);
  });

  it("criteria 5 and 5a: the governing bucket ages the lane even when a narrower bucket refreshes updatedAt", () => {
    const nowMs = Date.parse("2040-01-01T02:00:00.000Z");
    const status: PersistedQuotaProviderStatus = {
      provider: "claude",
      intervalSeconds: 300,
      uncappedIntervalSeconds: 300,
      governingBucketKey: "claude:weekly",
      capped: false,
      expired: false,
      exhaustedUntil: null,
      // The narrow session refresh is newest, but does not erase weekly age.
      updatedAt: new Date(nowMs - 60_000).toISOString(),
      buckets: [
        {
          key: "claude:weekly",
          percentLeft: 40,
          timeRemainingPct: 50,
          error: 0,
          derivative: 0,
          requiredIntervalSeconds: 300,
          resetAtIso: null,
          observedAt: new Date(nowMs - 30 * 60_000).toISOString(),
        },
        {
          key: "claude:session",
          percentLeft: 80,
          timeRemainingPct: 50,
          error: 0,
          derivative: 0,
          requiredIntervalSeconds: 300,
          resetAtIso: null,
          observedAt: new Date(nowMs - 60_000).toISOString(),
        },
      ],
    };

    expect(calculateFreshness(status, { nowMs, staleAfterMs: 15 * 60_000 })).toMatchObject({
      ageMs: 30 * 60_000,
      buckets: { "claude:weekly": 30 * 60_000, "claude:session": 60_000 },
      stale: true,
    });
  });

  it("criterion 5: a provider whose newest scrape carries only a weekly row while an older, still-unexpired five_hour row exists does not age the lane to hard-stale", () => {
    // Root's live #517 evidence: the newest native codex scrape emitted only a
    // weekly row, while shared-store assembly kept an older codex:five_hour row.
    // Lane freshness is keyed on the buckets present in the newest scrape, or
    // the governing bucket, rather than on every unexpired historical bucket (§5.5).
    const nowMs = Date.parse("2040-01-01T12:00:00.000Z");
    const weeklyObservedAt = new Date(nowMs - 2 * 60_000).toISOString();
    const olderUnexpiredFiveHour = {
      key: "codex:five_hour",
      percentLeft: 60,
      timeRemainingPct: 50,
      error: 0,
      derivative: 0,
      requiredIntervalSeconds: 120,
      // Reset instant is STILL IN THE FUTURE relative to nowMs, but this row was
      // last observed well before the newest (weekly-only) scrape.
      resetAtIso: new Date(nowMs + 60 * 60_000).toISOString(),
      observedAt: new Date(nowMs - 10 * 60 * 60_000).toISOString(),
    };
    const status: PersistedQuotaProviderStatus = {
      provider: "codex",
      intervalSeconds: 223,
      uncappedIntervalSeconds: 223,
      governingBucketKey: "codex:weekly",
      capped: false,
      expired: false,
      exhaustedUntil: null,
      updatedAt: weeklyObservedAt,
      buckets: [
        {
          key: "codex:weekly",
          percentLeft: 98,
          timeRemainingPct: 80,
          error: 0,
          derivative: 0,
          requiredIntervalSeconds: 223,
          resetAtIso: new Date(nowMs + 6 * 24 * 60 * 60_000).toISOString(),
          observedAt: weeklyObservedAt,
        },
        olderUnexpiredFiveHour,
      ],
    };
    const options = { nowMs, staleAfterMs: 15 * 60_000, hardStaleAfterMs: 60 * 60_000 };

    // The older unexpired, omitted bucket still shows its true age in the
    // per-bucket map, but it does not govern the provider's freshness.
    expect(calculateFreshness(status, options)).toEqual({
      ageMs: 2 * 60_000,
      buckets: { "codex:weekly": 2 * 60_000, "codex:five_hour": 10 * 60 * 60_000 },
      stale: false,
      hardStale: false,
    });
    expect(
      publishedThrottle(status, { ...options, maxIntervalSeconds: 36_000 }).intervalSeconds
    ).toBe(223);

    // If the older bucket WAS the governing bucket, it DOES age the lane (5a holds).
    const governingOlderStatus: PersistedQuotaProviderStatus = {
      ...status,
      governingBucketKey: "codex:five_hour",
      intervalSeconds: 120,
      uncappedIntervalSeconds: 120,
    };
    expect(calculateFreshness(governingOlderStatus, options)).toMatchObject({
      ageMs: 10 * 60 * 60_000,
      stale: true,
      hardStale: true,
    });
    expect(
      publishedThrottle(governingOlderStatus, { ...options, maxIntervalSeconds: 36_000 })
        .intervalSeconds
    ).toBe(36_000);

    // Same-scrape membership is exact: `insertObservations` stamps every row of
    // one snapshot with the single `scrapedAt` string, so a non-governing row
    // stamped even 1 ms before `updatedAt` came from an earlier scrape and does
    // not age the lane.
    const oneMsEarlierBucket = {
      ...olderUnexpiredFiveHour,
      observedAt: new Date(Date.parse(weeklyObservedAt) - 1).toISOString(),
    };
    expect(
      calculateFreshness({ ...status, buckets: [status.buckets[0], oneMsEarlierBucket] }, options)
    ).toMatchObject({
      ageMs: 2 * 60_000,
      buckets: { "codex:weekly": 2 * 60_000, "codex:five_hour": 2 * 60_000 + 1 },
      stale: false,
      hardStale: false,
    });
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
      // Kimi is configured but cold. It is still in the collection, carrying
      // the same 200 not_ready body its individual request returns (§5.5).
      configuredProviders: ["claude", "codex", "kimi"],
      now: () => nowMs,
    });
    await service.start();

    // Call collection form: every configured provider, cold lanes included
    const collRes = await makeRequest(socketPath, "/v1/throttle");
    expect(collRes.status).toBe(200);
    expect(collRes.json.providers).toBeDefined();
    expect(Object.keys(collRes.json.providers)).toEqual(["claude", "codex", "kimi"]);
    expect(collRes.json.providers.kimi.error.code).toBe("not_ready");

    const coldSingleRes = await makeRequest(socketPath, "/v1/throttle?provider=kimi");
    expect(coldSingleRes.status).toBe(200);
    expect(coldSingleRes.json.error.code).toBe("not_ready");

    for (const p of ["claude", "codex", "kimi"]) {
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
  it("criterion 9: no v1 response carries databasePath anywhere across populated responses", async () => {
    // Seed database with observations so responses are populated
    const nowMs = Date.now();
    const id = store.recordRaw({
      provider: "claude",
      scrapedAt: new Date(nowMs - 5000).toISOString(),
      rawOutput: "sample-raw-data",
    });
    store.recordParsed(
      id,
      {
        provider: "claude",
        status: "available",
        scrapedAt: new Date(nowMs - 5000).toISOString(),
        limits: [{ kind: "session", label: "Session", percentLeft: 80 }],
      },
      {
        provider: "claude",
        status: "available",
        scrapedAt: new Date(nowMs - 5000).toISOString(),
        limits: [{ kind: "session", label: "Session", percentLeft: 80 }],
      }
    );
    store.configureController({ maxIntervalSeconds: 3600 });

    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
    });
    await service.start();

    const populatedEndpoints = [
      "/v1/throttle?provider=claude",
      "/v1/throttle",
      "/v1/quota?provider=claude",
      "/v1/history?provider=claude",
      "/v1/healthz",
      "/v1/readyz",
    ];

    for (const route of populatedEndpoints) {
      const res = await makeRequest(socketPath, route);
      expect(res.status).toBe(200);
      expect(res.body).not.toContain("databasePath");
      expect(res.body).not.toContain(dbPath);
    }
  });

  // Criterion 9 & §7: Schema version refusal without mutating.
  it("criterion 9 & §7: service refuses to open database with PRAGMA user_version newer than supported without mutating", () => {
    // Create DB with user_version = 2
    const futureDbPath = join(tmpDir, "future.db");
    const db = new Database(futureDbPath);
    db.pragma("user_version = 2");
    db.close();

    // SharedQuotaStore constructor must throw SchemaVersionRefusalError before ensureSchema/widenToWal
    expect(() => {
      new SharedQuotaStore(futureDbPath);
    }).toThrow(SchemaVersionRefusalError);

    // Verify the database was left untouched
    const checkDb = new Database(futureDbPath, { readonly: true });
    const version = checkDb.pragma("user_version", { simple: true });
    expect(version).toBe(2);
    const tables = checkDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain("quota_scrapes");
    expect(tables.map((t) => t.name)).not.toContain("quota_observations");
    checkDb.close();
  });

  // §5.6: The two semantic endpoint codes are provider_unknown and not_ready.
  // not_ready is an application state served with 200; 503 is reserved for
  // genuine infrastructure failure.
  it("§5.6: returns provider_unknown (404) for unconfigured provider and not_ready (200) when cold", async () => {
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

    // 2. Configured provider with no observations -> not_ready (200, retryable)
    const coldRes = await makeRequest(socketPath, "/v1/throttle?provider=claude");
    expect(coldRes.status).toBe(200);
    expect(coldRes.json.error.code).toBe("not_ready");
    expect(coldRes.json.error.retryable).toBe(true);
    expect(coldRes.json.service.protocolMajor).toBe(COORDINATOR_PROTOCOL_MAJOR);
  });

  // §5.6: An unrouted path is a routing typo, not a provider misconfiguration —
  // it must never wear provider_unknown's "refuse as configuration error" code.
  // The typed response keeps its service block, but HTTP 404 is the complete
  // path-mismatch signal; v1 does not add a third semantic endpoint code.
  it("§5.6: unknown paths return a typed 404 without provider_unknown or a new endpoint error code", async () => {
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
    });
    await service.start();

    for (const badPath of ["/v1/nope", "/v1/throttle/extra", "/nope"]) {
      const res = await makeRequest(socketPath, badPath);
      expect(res.status, `Expected 404 for ${badPath}`).toBe(404);
      expect(res.json.error.code).toBeUndefined();
      expect(res.json.error.message).toBe(`Path ${badPath} not found`);
      expect(res.json.error.retryable).toBe(false);
      expect(res.json.service.protocolMajor).toBe(COORDINATOR_PROTOCOL_MAJOR);
      expect(res.body).not.toContain("provider_unknown");
    }
  });

  // Provider normalization: case-insensitive matching, antigravity -> agy alias,
  // single alias table shared with providerThrottleKey (providers/registry.ts).
  it("provider input normalization: mixed case and antigravity alias resolve on every provider endpoint", async () => {
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude", "agy"],
    });
    await service.start();

    // Mixed-case alias on throttle: normalizes to the agy lane, which is
    // configured but cold -> not_ready (200). A miss would be provider_unknown (404).
    for (const spelling of ["Antigravity", "ANTIGRAVITY", "antigravity"]) {
      const res = await makeRequest(socketPath, `/v1/throttle?provider=${spelling}`);
      expect(res.status, `Expected 200 not_ready for ${spelling}`).toBe(200);
      expect(res.json.error.code).toBe("not_ready");
    }

    // Mixed-case plain provider also matches case-insensitively
    const claudeRes = await makeRequest(socketPath, "/v1/throttle?provider=CLAUDE");
    expect(claudeRes.status).toBe(200);
    expect(claudeRes.json.error.code).toBe("not_ready");

    // quota: normalized alias resolves to the configured agy lane ("unknown",
    // not "unsupported"), and the canonical lane name is echoed back
    const quotaRes = await makeRequest(socketPath, "/v1/quota?provider=Antigravity");
    expect(quotaRes.status).toBe(200);
    expect(quotaRes.json.provider).toBe("agy");
    expect(quotaRes.json.status).toBe("unknown");

    // history: normalized alias is accepted (200), not provider_unknown (404)
    const historyRes = await makeRequest(socketPath, "/v1/history?provider=ANTIGRAVITY");
    expect(historyRes.status).toBe(200);
    expect(historyRes.json.provider).toBe("agy");

    // Present-but-empty ?provider= remains a client bug: 404 provider_unknown,
    // distinct from the absent-param collection form.
    const emptyRes = await makeRequest(socketPath, "/v1/throttle?provider=");
    expect(emptyRes.status).toBe(404);
    expect(emptyRes.json.error.code).toBe("provider_unknown");
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
        limits: [
          {
            kind: "session",
            label: "Session",
            percentLeft: 75,
            scope: { provider: "claude" },
          },
          {
            kind: "weekly",
            label: "Current Week (Fable)",
            percentLeft: 80,
            scope: { provider: "claude", models: ["claude-fable"] },
          },
        ],
      },
      {
        provider: "claude",
        status: "available",
        scrapedAt: new Date(nowMs).toISOString(),
        limits: [
          {
            kind: "session",
            label: "Session",
            percentLeft: 75,
            scope: { provider: "claude" },
          },
          {
            kind: "weekly",
            label: "Current Week (Fable)",
            percentLeft: 80,
            scope: { provider: "claude", models: ["claude-fable"] },
          },
        ],
      }
    );

    const warmRes = await makeRequest(socketPath, "/v1/quota?provider=claude");
    expect(warmRes.status).toBe(200);
    expect(warmRes.json.status).toBe("available");
    expect(warmRes.json.provider).toBe("claude");
    expect(warmRes.json.limits[0].percentLeft).toBe(75);
    expect(warmRes.json.limits[1].scope).toEqual({
      provider: "claude",
      models: ["claude-fable"],
    });
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
    // records is emitted once, not duplicated under history
    expect(res.json.history).toBeUndefined();
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

  // §5.1: Socket collision refusal
  it("§5.1: refuses to start if another coordinator is already listening on socketPath", async () => {
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
    });
    await service.start();

    const competingService = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
    });

    await expect(competingService.start()).rejects.toThrow(/already listening/);
  });

  // §5.7: Degradation on unparseable timestamp
  it("§5.7: unparseable timestamp degrades toward slower (infinite age / hard-stale)", () => {
    const corruptStatus: PersistedQuotaProviderStatus = {
      provider: "claude",
      intervalSeconds: 300,
      uncappedIntervalSeconds: 300,
      governingBucketKey: "claude:session",
      capped: false,
      expired: false,
      exhaustedUntil: null,
      updatedAt: "invalid-timestamp",
      buckets: [
        {
          key: "claude:session",
          percentLeft: 50,
          timeRemainingPct: 50,
          error: 0,
          derivative: 0,
          requiredIntervalSeconds: 300,
          resetAtIso: null,
          observedAt: "not-a-date",
        },
      ],
    };

    const published = publishedThrottle(corruptStatus, { maxIntervalSeconds: 3600 });
    expect(published.freshness.stale).toBe(true);
    expect(published.freshness.hardStale).toBe(true);
    expect(published.intervalSeconds).toBe(3600);
  });
});
