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
  MANUAL_QUOTA_OBSERVATION_PATH,
  ProtocolMismatchError,
  publishedThrottle,
  QUOTA_READING_MODE_PATH,
  validateProtocolMajor,
} from "./coordinator-protocol.js";
import { QuotaCoordinatorService, SERVED_ROUTES, WRITE_ROUTES } from "./coordinator-service.js";
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
  body?: string,
  headers?: http.OutgoingHttpHeaders
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: {
          ...(body
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
            : {}),
          ...headers,
        },
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

    // The operator writes are ordinary `/v1/` paths that are POST-only: the 405
    // rule is per path, not "every v1 path is a GET" (design §5.2, criterion 7).
    // Enumerate them the same way, and hold the two sets apart, so a later
    // mutating endpoint has to be declared rather than smuggled onto a read path.
    expect([...WRITE_ROUTES]).toEqual([QUOTA_READING_MODE_PATH, MANUAL_QUOTA_OBSERVATION_PATH]);
    for (const writeRoute of WRITE_ROUTES) {
      expect((SERVED_ROUTES as readonly string[]).includes(writeRoute)).toBe(false);
    }

    for (const writeRoute of WRITE_ROUTES) {
      expect(writeRoute.startsWith("/v1/")).toBe(true);
      for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
        const res = await makeRequest(socketPath, writeRoute, method);
        expect(res.status, `Expected 405 for ${method} on ${writeRoute}`).toBe(405);
        expect(res.headers.allow).toBe("POST");
      }
    }
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

  it("persists manual mode, ingests one idempotent observation onto the pacing path, and preserves truthful age on stale writes", async () => {
    const nowMs = Date.parse("2030-01-01T00:10:00.000Z");
    const manualObservedAt = "2030-01-01T00:05:00.000Z";
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
      now: () => nowMs,
      hardStaleAfterMs: 60 * 60_000,
    });
    await service.start();

    const switchedManual = await makeRequest(
      socketPath,
      QUOTA_READING_MODE_PATH,
      "POST",
      JSON.stringify({ provider: "claude", mode: "manual" })
    );
    expect(switchedManual.status).toBe(200);
    expect(switchedManual.json).toMatchObject({
      provider: "claude",
      mode: "manual",
      generation: 1,
    });

    const observation = {
      provider: "claude",
      status: "available",
      scrapedAt: manualObservedAt,
      limits: [
        {
          label: "Weekly",
          kind: "weekly",
          percentLeft: 25,
          resetAtIso: "2030-01-08T00:00:00.000Z",
          scope: { provider: "claude" },
        },
      ],
    };
    const accepted = await makeRequest(
      socketPath,
      MANUAL_QUOTA_OBSERVATION_PATH,
      "POST",
      JSON.stringify({ provider: "claude", generation: 1, observation }),
      { "Idempotency-Key": "manual-reading-1" }
    );
    expect(accepted.status).toBe(200);
    expect(accepted.json).toMatchObject({
      observedAt: manualObservedAt,
      generation: 1,
      duplicate: false,
    });
    expect(store.getLatestSnapshot("claude")).toMatchObject({
      provider: "claude",
      scrapedAt: manualObservedAt,
      limits: [expect.objectContaining({ percentLeft: 25 })],
    });
    // The reading is one ordinary evidence row, so history and latest agree.
    const history = await makeRequest(
      socketPath,
      "/v1/history?provider=claude&since=2030-01-01T00:00:00.000Z"
    );
    expect(history.status).toBe(200);
    expect(history.json.records).toEqual([
      expect.objectContaining({ kind: "weekly", observedAt: manualObservedAt, percentLeft: 25 }),
    ]);
    expect(store.listSince("claude", "2030-01-01T00:00:00.000Z")).toEqual([
      expect.objectContaining({ provider: "claude", scrapedAt: manualObservedAt }),
    ]);
    expect(
      store.db
        .prepare("SELECT raw_output AS rawOutput FROM quota_scrapes WHERE provider = 'claude'")
        .all()
    ).toEqual([
      {
        rawOutput: JSON.stringify({
          generation: 1,
          idempotencyKey: "manual-reading-1",
          source: "manual",
          version: 1,
        }),
      },
    ]);
    const ready = await makeRequest(socketPath, "/v1/readyz");
    expect(ready.json.scrapes.claude.readingMode).toEqual({ mode: "manual", generation: 1 });
    const paced = await makeRequest(socketPath, "/v1/throttle?provider=claude");
    expect(paced.status).toBe(200);
    expect(paced.json).toMatchObject({ updatedAt: manualObservedAt, provider: "claude" });
    expect(paced.json.intervalSeconds).toBeGreaterThan(0);
    expect(paced.json.freshness.ageMs).toBe(5 * 60_000);

    const duplicate = await makeRequest(
      socketPath,
      MANUAL_QUOTA_OBSERVATION_PATH,
      "POST",
      JSON.stringify({ provider: "claude", generation: 1, observation }),
      { "Idempotency-Key": "manual-reading-1" }
    );
    expect(duplicate.status).toBe(200);
    expect(duplicate.json.duplicate).toBe(true);
    expect(
      store.db.prepare("SELECT count(*) AS n FROM quota_manual_observation_receipts").get()
    ).toEqual({ n: 1 });

    const changedDuplicate = await makeRequest(
      socketPath,
      MANUAL_QUOTA_OBSERVATION_PATH,
      "POST",
      JSON.stringify({
        provider: "claude",
        generation: 1,
        observation: { ...observation, limits: [{ ...observation.limits[0], percentLeft: 20 }] },
      }),
      { "Idempotency-Key": "manual-reading-1" }
    );
    expect(changedDuplicate.status).toBe(409);
    expect(changedDuplicate.json.error.code).toBe("idempotency_conflict");

    const stale = await makeRequest(
      socketPath,
      MANUAL_QUOTA_OBSERVATION_PATH,
      "POST",
      JSON.stringify({
        provider: "claude",
        generation: 1,
        observation: { ...observation, scrapedAt: "2030-01-01T00:00:00.000Z" },
      }),
      { "Idempotency-Key": "manual-reading-stale" }
    );
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("stale_observation");
    const afterStale = await makeRequest(socketPath, "/v1/throttle?provider=claude");
    expect(afterStale.json).toMatchObject({ updatedAt: manualObservedAt });
    expect(afterStale.json.freshness.ageMs).toBe(5 * 60_000);

    const switchedScrape = await makeRequest(
      socketPath,
      QUOTA_READING_MODE_PATH,
      "POST",
      JSON.stringify({ provider: "claude", mode: "scrape" })
    );
    expect(switchedScrape.json).toMatchObject({ mode: "scrape", generation: 2 });
    const rejectedInScrapeMode = await makeRequest(
      socketPath,
      MANUAL_QUOTA_OBSERVATION_PATH,
      "POST",
      JSON.stringify({ provider: "claude", generation: 1, observation }),
      { "Idempotency-Key": "manual-reading-after-scrape" }
    );
    expect(rejectedInScrapeMode.status).toBe(409);
    expect(rejectedInScrapeMode.json.error.code).toBe("manual_mode_required");
    // Replay of an accepted key does not outrank current authority.
    const replayInScrapeMode = await makeRequest(
      socketPath,
      MANUAL_QUOTA_OBSERVATION_PATH,
      "POST",
      JSON.stringify({ provider: "claude", generation: 1, observation }),
      { "Idempotency-Key": "manual-reading-1" }
    );
    expect(replayInScrapeMode.status).toBe(409);
    expect(replayInScrapeMode.json.error.code).toBe("manual_mode_required");
    const readyInScrapeMode = await makeRequest(socketPath, "/v1/readyz");
    expect(readyInScrapeMode.json.scrapes.claude.readingMode).toEqual({
      mode: "scrape",
      generation: 2,
    });

    const manualAgain = await makeRequest(
      socketPath,
      QUOTA_READING_MODE_PATH,
      "POST",
      JSON.stringify({ provider: "claude", mode: "manual" })
    );
    expect(manualAgain.json).toMatchObject({ mode: "manual", generation: 3 });
    const delayedGeneration = await makeRequest(
      socketPath,
      MANUAL_QUOTA_OBSERVATION_PATH,
      "POST",
      JSON.stringify({
        provider: "claude",
        generation: 1,
        observation: { ...observation, scrapedAt: "2030-01-01T00:06:00.000Z" },
      }),
      { "Idempotency-Key": "manual-reading-old-generation" }
    );
    expect(delayedGeneration.status).toBe(409);
    expect(delayedGeneration.json.error.code).toBe("mode_generation_mismatch");
    const replayOldGeneration = await makeRequest(
      socketPath,
      MANUAL_QUOTA_OBSERVATION_PATH,
      "POST",
      JSON.stringify({ provider: "claude", generation: 1, observation }),
      { "Idempotency-Key": "manual-reading-1" }
    );
    expect(replayOldGeneration.status).toBe(409);
    expect(replayOldGeneration.json.error.code).toBe("mode_generation_mismatch");

    // A hand-typed request is told which field failed; a reset that already
    // passed is not a validation failure (the scrapers report those too).
    const badPercent = await makeRequest(
      socketPath,
      MANUAL_QUOTA_OBSERVATION_PATH,
      "POST",
      JSON.stringify({
        provider: "claude",
        generation: 3,
        observation: { ...observation, limits: [{ ...observation.limits[0], percentLeft: 101 }] },
      }),
      { "Idempotency-Key": "manual-reading-bad-percent" }
    );
    expect(badPercent.status).toBe(400);
    expect(badPercent.json.error.message).toBe(
      "observation.limits[0].percentLeft must be between 0 and 100"
    );
    const passedReset = await makeRequest(
      socketPath,
      MANUAL_QUOTA_OBSERVATION_PATH,
      "POST",
      JSON.stringify({
        provider: "claude",
        generation: 3,
        observation: {
          ...observation,
          scrapedAt: "2030-01-01T00:11:00.000Z",
          limits: [{ ...observation.limits[0], resetAtIso: "2030-01-01T00:06:00.000Z" }],
        },
      }),
      { "Idempotency-Key": "manual-reading-passed-reset" }
    );
    expect(passedReset.status).toBe(200);
    expect(passedReset.json.duplicate).toBe(false);

    await service.stop();
    store.close();
    store = new SharedQuotaStore(dbPath);
    expect(store.getQuotaReadingMode("claude")).toEqual({
      mode: "manual",
      generation: 3,
      updatedAt: new Date(nowMs).toISOString(),
    });
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
      mode: "scrape",
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
    expect(calculateFreshness(status, options)).toMatchObject({
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
    // Create DB with a schema newer than this binary supports.
    const futureDbPath = join(tmpDir, "future.db");
    const db = new Database(futureDbPath);
    db.pragma(`user_version = ${QUOTA_SCHEMA_VERSION + 1}`);
    db.close();

    // SharedQuotaStore constructor must throw SchemaVersionRefusalError before ensureSchema/widenToWal
    expect(() => {
      new SharedQuotaStore(futureDbPath);
    }).toThrow(SchemaVersionRefusalError);

    // Verify the database was left untouched
    const checkDb = new Database(futureDbPath, { readonly: true });
    const version = checkDb.pragma("user_version", { simple: true });
    expect(version).toBe(QUOTA_SCHEMA_VERSION + 1);
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

  it("#690: /v1/throttle exposes freshness mode, thresholds, and resetWaiting", async () => {
    store.configureController({ maxIntervalSeconds: 3600 });
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["kimi", "claude"],
    });
    await service.start();

    // Default scrape mode for kimi
    const nowMs = Date.now();
    const idKimi = store.recordRaw({
      provider: "kimi",
      scrapedAt: new Date(nowMs - 10_000).toISOString(),
      rawOutput: "raw",
    });
    store.recordParsed(
      idKimi,
      {
        provider: "kimi",
        status: "available",
        scrapedAt: new Date(nowMs - 10_000).toISOString(),
        limits: [
          {
            kind: "session",
            label: "5h",
            percentLeft: 90,
            resetAtIso: new Date(nowMs + 3600_000).toISOString(),
          },
        ],
      },
      {
        provider: "kimi",
        status: "available",
        scrapedAt: new Date(nowMs - 10_000).toISOString(),
        limits: [
          {
            kind: "session",
            label: "5h",
            percentLeft: 90,
            resetAtIso: new Date(nowMs + 3600_000).toISOString(),
          },
        ],
      }
    );

    const scrapeRes = await makeRequest(socketPath, "/v1/throttle?provider=kimi");
    expect(scrapeRes.status).toBe(200);
    expect(scrapeRes.json.freshness).toMatchObject({
      mode: "scrape",
      stale: false,
      hardStale: false,
      resetWaiting: false,
    });
    expect(scrapeRes.json.freshness.staleAfterMs).toBeGreaterThan(0);
    expect(scrapeRes.json.freshness.hardStaleAfterMs).toBeGreaterThanOrEqual(
      scrapeRes.json.freshness.staleAfterMs
    );

    // Switch claude to manual mode and record an observation
    const switchRes = await makeRequest(
      socketPath,
      QUOTA_READING_MODE_PATH,
      "POST",
      JSON.stringify({ provider: "claude", mode: "manual" })
    );
    expect(switchRes.status).toBe(200);

    const manualObservedAt = new Date(nowMs - 70 * 60 * 1000).toISOString(); // 70m ago (> 60m soft, < 120m hard)
    const idClaude = store.recordRaw({
      provider: "claude",
      scrapedAt: manualObservedAt,
      rawOutput: "manual",
    });
    store.recordParsed(
      idClaude,
      {
        provider: "claude",
        status: "available",
        scrapedAt: manualObservedAt,
        limits: [
          {
            kind: "session",
            label: "Session",
            percentLeft: 80,
            resetAtIso: new Date(nowMs + 3600_000).toISOString(),
          },
        ],
      },
      {
        provider: "claude",
        status: "available",
        scrapedAt: manualObservedAt,
        limits: [
          {
            kind: "session",
            label: "Session",
            percentLeft: 80,
            resetAtIso: new Date(nowMs + 3600_000).toISOString(),
          },
        ],
      }
    );

    const manualRes = await makeRequest(socketPath, "/v1/throttle?provider=claude");
    expect(manualRes.status).toBe(200);
    expect(manualRes.json.freshness).toMatchObject({
      mode: "manual",
      staleAfterMs: 3_600_000, // 60m default
      hardStaleAfterMs: 7_200_000, // 120m default
      stale: true, // 70m > 60m
      hardStale: false, // 70m < 120m
      resetWaiting: false,
    });

    // Collection route carries the same freshness fields
    const collRes = await makeRequest(socketPath, "/v1/throttle");
    expect(collRes.status).toBe(200);
    expect(collRes.json.providers.claude.freshness).toMatchObject({
      mode: "manual",
      stale: true,
      hardStale: false,
    });
    expect(collRes.json.providers.kimi.freshness.mode).toBe("scrape");
  });

  it("#690: /v1/throttle detects resetWaiting when window resetAt has passed without fresh reading", async () => {
    store.configureController({ maxIntervalSeconds: 3600 });
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["kimi"],
    });
    await service.start();

    const nowMs = Date.now();
    const observedAt = new Date(nowMs - 20 * 60 * 1000).toISOString(); // 20m ago
    const resetAt = new Date(nowMs - 5 * 60 * 1000).toISOString(); // reset 5m ago, observed 20m ago => resetWaiting: true
    const id = store.recordRaw({
      provider: "kimi",
      scrapedAt: observedAt,
      rawOutput: "raw",
    });
    store.recordParsed(
      id,
      {
        provider: "kimi",
        status: "available",
        scrapedAt: observedAt,
        limits: [{ kind: "session", label: "5h", percentLeft: 10, resetAtIso: resetAt }],
      },
      {
        provider: "kimi",
        status: "available",
        scrapedAt: observedAt,
        limits: [{ kind: "session", label: "5h", percentLeft: 10, resetAtIso: resetAt }],
      }
    );

    const res = await makeRequest(socketPath, "/v1/throttle?provider=kimi");
    expect(res.status).toBe(200);
    expect(res.json.freshness.resetWaiting).toBe(true);
  });
});
