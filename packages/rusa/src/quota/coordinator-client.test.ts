import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderPacer, selectPoolLane } from "../actor/provider-pacer.js";
import {
  applyThrottleStatusToPacer,
  initialPacerIntervalSeconds,
  QuotaCoordinatorClient,
  reconcileProviderPacersFromClient,
} from "./coordinator-client.js";
import {
  COORDINATOR_PROTOCOL_MAJOR,
  COORDINATOR_PROTOCOL_MINOR,
  HISTORY_WINDOW_MS,
  type PublishedHistoryRecord,
  type PublishedThrottleCollectionResponse,
  type PublishedThrottleResponse,
  weeklyAdmissionObservation,
} from "./coordinator-protocol.js";

function serviceInfo(protocolMajor: number = COORDINATOR_PROTOCOL_MAJOR) {
  return {
    protocolMajor,
    protocolMinor: COORDINATOR_PROTOCOL_MINOR,
    serverVersion: "test",
    serverTime: new Date(0).toISOString(),
  };
}

function providerStatus(intervalSeconds: number, provider = "claude") {
  return {
    provider,
    intervalSeconds,
    uncappedIntervalSeconds: intervalSeconds,
    governingBucketKey: `${provider}:weekly`,
    capped: false,
    expired: false,
    exhaustedUntil: null,
    updatedAt: new Date(0).toISOString(),
    buckets: [],
    freshness: { ageMs: 0, buckets: {}, stale: false, hardStale: false },
  };
}

describe("QuotaCoordinatorClient unavailability (#359, design §5.7/§6.3–6.4, criterion 6)", () => {
  let root: string | undefined;
  let server: http.Server | undefined;

  async function listen(socketPath: string, handler: http.RequestListener): Promise<void> {
    server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(socketPath, resolve);
    });
  }

  async function stopServer(): Promise<void> {
    const running = server;
    server = undefined;
    if (!running?.listening) return;
    running.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      running.close((err) => (err ? reject(err) : resolve()));
    });
  }

  afterEach(async () => {
    vi.useRealTimers();
    await stopServer();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("backs off reconnects while the socket is absent and resumes once it answers", async () => {
    root = mkdtempSync(join(tmpdir(), "quota-client-unavailable-"));
    const socketPath = join(root, "coordinator.sock");
    let nowMs = 0;
    const client = new QuotaCoordinatorClient({
      socketPath,
      maxIntervalSeconds: 3600,
      now: () => nowMs,
    });

    // No listener yet: a degraded read, never a rejection a caller could turn
    // into a launch gate.
    await expect(client.getThrottle("claude")).resolves.toBeNull();
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 0 });

    let requests = 0;
    await listen(socketPath, (_req, res) => {
      requests++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ service: serviceInfo(), ...providerStatus(300) }));
    });

    // The failed read scheduled a one-second retry, so a tick inside that
    // window opens no socket at all.
    nowMs = 999;
    await expect(client.getThrottle("claude")).resolves.toBeNull();
    expect(requests).toBe(0);

    nowMs = 1_000;
    await expect(client.getThrottle("claude")).resolves.toMatchObject({ intervalSeconds: 300 });
    expect(requests).toBe(1);
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 1 });
    expect(client.getLastAppliedInterval("claude")).toBe(300);

    // A success resets the backoff, so the next outage starts at one second
    // again rather than at the width it had grown to.
    await stopServer();
    await expect(client.getThrottle("claude")).resolves.toBeNull();
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 0 });
    nowMs = 1_500;
    await expect(client.getThrottle("claude")).resolves.toBeNull();
    nowMs = 2_000;
    await expect(client.getThrottle("claude")).resolves.toBeNull();
    // Two consecutive failures doubled the window: 2s then 4s.
    nowMs = 3_999;
    await expect(client.getThrottle("claude")).resolves.toBeNull();
    nowMs = 6_000;
    await expect(client.getThrottle("claude")).resolves.toBeNull();
    expect(client.getLastAppliedInterval("claude")).toBe(300);
  });

  it("abandons a socket that accepts and never answers instead of leaving the read outstanding", async () => {
    root = mkdtempSync(join(tmpdir(), "quota-client-hung-"));
    const socketPath = join(root, "coordinator.sock");
    await listen(socketPath, () => {
      // Deliberately never respond.
    });

    const client = new QuotaCoordinatorClient({
      socketPath,
      maxIntervalSeconds: 3600,
      requestTimeoutMs: 50,
    });

    await expect(client.getThrottle("claude")).resolves.toBeNull();
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 0 });
  });

  it("abandons a socket that trickles slowly and exceeds the wall-clock deadline", async () => {
    root = mkdtempSync(join(tmpdir(), "quota-client-trickle-"));
    const socketPath = join(root, "coordinator.sock");
    await listen(socketPath, (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.write('{"ser');
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(timer);
          return;
        }
        res.write('vice":');
      }, 30);
      res.on("close", () => clearInterval(timer));
    });

    const client = new QuotaCoordinatorClient({
      socketPath,
      maxIntervalSeconds: 3600,
      requestTimeoutMs: 80,
    });

    await expect(client.getThrottle("claude")).resolves.toBeNull();
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 0 });
  });

  it("retains the last applied interval until its own clock is hard-stale, then widens to maxIntervalSeconds", async () => {
    root = mkdtempSync(join(tmpdir(), "quota-client-hardstale-"));
    const socketPath = join(root, "coordinator.sock");
    let nowMs = 0;
    const client = new QuotaCoordinatorClient({
      socketPath,
      maxIntervalSeconds: 3600,
      hardStaleAfterMs: 1_000,
      now: () => nowMs,
    });

    await listen(socketPath, (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ service: serviceInfo(), ...providerStatus(300) }));
    });
    await expect(client.getThrottle("claude")).resolves.toMatchObject({ intervalSeconds: 300 });
    await stopServer();

    await expect(client.getThrottle("claude")).resolves.toBeNull();
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 0 });

    // The measurement is the client's own clock against its own last
    // successful read, not a server instant (§5.4).
    nowMs = 1_000;
    expect(client.getLastAppliedInterval("claude")).toBe(300);
    nowMs = 1_001;
    expect(client.getLastAppliedInterval("claude")).toBe(3600);

    // The widening takes the wider of the two, so a ceiling edited below an
    // already-applied interval never makes a hard-stale client launch faster.
    const narrowCeiling = new QuotaCoordinatorClient({
      socketPath,
      maxIntervalSeconds: 60,
      hardStaleAfterMs: 1_000,
      now: () => nowMs,
    });
    nowMs = 0;
    expect(
      narrowCeiling.applyResponse("claude", { service: serviceInfo(), ...providerStatus(600) })
    ).toBe(true);
    nowMs = 5_000;
    expect(narrowCeiling.getLastAppliedInterval("claude")).toBe(600);
  });

  it("imports no store, SQLite, scraper, or subprocess dependencies (criterion 6 zero writes)", () => {
    const source = readFileSync("src/quota/coordinator-client.ts", "utf8");
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line))
      .join("\n");

    for (const forbidden of [
      "better-sqlite3",
      "shared-store",
      "child_process",
      "scraper",
      "observation",
    ]) {
      expect(importLines).not.toContain(forbidden);
    }
  });

  it("treats a 200 response with missing throttle payload as unusable and backs off", async () => {
    root = mkdtempSync(join(tmpdir(), "quota-client-shape-"));
    const socketPath = join(root, "coordinator.sock");
    let nowMs = 0;
    const client = new QuotaCoordinatorClient({
      socketPath,
      maxIntervalSeconds: 3600,
      now: () => nowMs,
    });

    let requests = 0;
    await listen(socketPath, (_req, res) => {
      requests++;
      res.setHeader("content-type", "application/json");
      // Responds with 200 and a valid service envelope, but no throttle payload.
      res.end(JSON.stringify({ service: serviceInfo() }));
    });

    await expect(client.getThrottle("claude")).resolves.toBeNull();
    expect(requests).toBe(1);
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 0 });
    // Backoff is scheduled: tick inside the 1s window opens no socket.
    nowMs = 500;
    await expect(client.getThrottle("claude")).resolves.toBeNull();
    expect(requests).toBe(1);
    expect(client.getLastAppliedInterval("claude")).toBe(3600);
  });

  it("marks reachable on 503 not_ready while yielding null interval", async () => {
    root = mkdtempSync(join(tmpdir(), "quota-client-notready-503-"));
    const socketPath = join(root, "coordinator.sock");
    await listen(socketPath, (_req, res) => {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          service: serviceInfo(),
          error: { code: "not_ready", message: "Cold coordinator", retryable: true },
        })
      );
    });

    const client = new QuotaCoordinatorClient({ socketPath, maxIntervalSeconds: 3600 });
    await expect(client.getThrottle("kimi")).resolves.toBeNull();
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 1 });
    // Rule 0 ceiling: cold coordinator has no interval to apply
    expect(client.getLastAppliedInterval("kimi")).toBe(3600);
  });

  it("marks reachable on 200 not_ready while returning cold envelope without modifying interval (#480)", async () => {
    root = mkdtempSync(join(tmpdir(), "quota-client-notready-200-"));
    const socketPath = join(root, "coordinator.sock");
    await listen(socketPath, (_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          service: serviceInfo(),
          error: { code: "not_ready", message: "Cold lane", retryable: true },
        })
      );
    });

    const client = new QuotaCoordinatorClient({ socketPath, maxIntervalSeconds: 3600 });
    const res = await client.getThrottle("kimi");
    expect(res).toMatchObject({
      service: expect.any(Object),
      error: { code: "not_ready", retryable: true },
    });
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 1 });
    // A cold response carries no intervalSeconds, so last applied is unchanged (starts at ceiling)
    expect(client.getLastAppliedInterval("kimi")).toBe(3600);
  });

  it("applyResponse marks reachable on cold not_ready envelope without modifying interval", () => {
    const client = new QuotaCoordinatorClient({
      socketPath: "/tmp/absent.sock",
      maxIntervalSeconds: 3600,
    });
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 0 });
    const applied = client.applyResponse("kimi", {
      service: serviceInfo(),
      error: { code: "not_ready", message: "Cold lane", retryable: true },
    });
    expect(applied).toBe(false);
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 1 });
    expect(client.getLastAppliedInterval("kimi")).toBe(3600);
  });

  it("treats a protocolMajor mismatch as the same unavailability by another route", async () => {
    root = mkdtempSync(join(tmpdir(), "quota-client-protocol-"));
    const socketPath = join(root, "coordinator.sock");
    let nowMs = 0;
    const logger = { warn: vi.fn(), error: vi.fn() };
    const client = new QuotaCoordinatorClient({
      socketPath,
      maxIntervalSeconds: 3600,
      hardStaleAfterMs: 1_000,
      now: () => nowMs,
      logger,
    });

    let protocolMajor = COORDINATOR_PROTOCOL_MAJOR;
    await listen(socketPath, (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ service: serviceInfo(protocolMajor), ...providerStatus(300) }));
    });

    await expect(client.getThrottle("claude")).resolves.toMatchObject({ intervalSeconds: 300 });
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 1 });

    protocolMajor = COORDINATOR_PROTOCOL_MAJOR + 1;
    await expect(client.getThrottle("claude")).resolves.toBeNull();
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 0 });
    expect(logger.warn).toHaveBeenCalled();
    expect(client.getLastAppliedInterval("claude")).toBe(300);

    nowMs = 1_001;
    expect(client.getLastAppliedInterval("claude")).toBe(3600);
  });

  it("applies every provider of a collection read, whose entries carry no service envelope", async () => {
    root = mkdtempSync(join(tmpdir(), "quota-client-collection-"));
    const socketPath = join(root, "coordinator.sock");
    const client = new QuotaCoordinatorClient({ socketPath, maxIntervalSeconds: 3600 });

    await listen(socketPath, (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          service: serviceInfo(),
          providers: {
            claude: providerStatus(300),
            codex: providerStatus(450, "codex"),
          },
        })
      );
    });

    await expect(client.getThrottle()).resolves.toMatchObject({ providers: expect.any(Object) });
    expect(client.getLastAppliedInterval("claude")).toBe(300);
    expect(client.getLastAppliedInterval("codex")).toBe(450);
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 1 });
  });

  it("rejects a collection whose warm body disagrees with its provider key", async () => {
    root = mkdtempSync(join(tmpdir(), "quota-client-collection-provider-key-"));
    const socketPath = join(root, "coordinator.sock");
    const client = new QuotaCoordinatorClient({ socketPath, maxIntervalSeconds: 3600 });

    await listen(socketPath, (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          service: serviceInfo(),
          providers: { codex: providerStatus(450, "claude") },
        })
      );
    });

    await expect(client.getThrottle()).resolves.toBeNull();
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 0 });
    expect(client.getLastAppliedInterval("codex")).toBe(3600);
  });

  it("applies warm intervals and skips cold entries in a mixed collection read (#480)", async () => {
    root = mkdtempSync(join(tmpdir(), "quota-client-collection-mixed-"));
    const socketPath = join(root, "coordinator.sock");
    const client = new QuotaCoordinatorClient({ socketPath, maxIntervalSeconds: 3600 });

    await listen(socketPath, (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          service: serviceInfo(),
          providers: {
            claude: providerStatus(300),
            kimi: { error: { code: "not_ready", message: "Cold provider", retryable: true } },
            codex: providerStatus(450, "codex"),
          },
        })
      );
    });

    const res = await client.getThrottle();
    expect(res).toMatchObject({
      service: expect.any(Object),
      providers: expect.any(Object),
    });
    expect(client.getLastAppliedInterval("claude")).toBe(300);
    expect(client.getLastAppliedInterval("codex")).toBe(450);
    // Cold provider has no interval applied; retains rule 0 ceiling
    expect(client.getLastAppliedInterval("kimi")).toBe(3600);
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 1 });
  });

  it("treats a collection containing an invalid status shape as unusable and backs off", async () => {
    root = mkdtempSync(join(tmpdir(), "quota-client-collection-invalid-"));
    const socketPath = join(root, "coordinator.sock");
    let nowMs = 0;
    let requests = 0;
    const client = new QuotaCoordinatorClient({
      socketPath,
      maxIntervalSeconds: 3600,
      now: () => nowMs,
    });

    await listen(socketPath, (_req, res) => {
      requests++;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          service: serviceInfo(),
          providers: {
            claude: providerStatus(300),
            broken: { invalid: true },
          },
        })
      );
    });

    await expect(client.getThrottle()).resolves.toBeNull();
    expect(requests).toBe(1);
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 0 });
    // Claude was not applied because the response as a whole was unusable
    expect(client.getLastAppliedInterval("claude")).toBe(3600);

    // Backoff was scheduled (1000ms), so an attempt at 500ms opens no socket
    nowMs = 500;
    await expect(client.getThrottle()).resolves.toBeNull();
    expect(requests).toBe(1);
  });

  it("resolves null during outage and falls back to configured ceiling without gating", async () => {
    root = mkdtempSync(join(tmpdir(), "quota-client-outage-contract-"));
    const client = new QuotaCoordinatorClient({
      socketPath: join(root, "absent.sock"),
      maxIntervalSeconds: 3600,
    });

    // Cold start under outage (§5.7 rule 0): resolves null without throwing,
    // disconnected health surfaced, and returns configured max interval.
    await expect(client.getThrottle("claude")).resolves.toBeNull();
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 0 });
    const intervalSeconds = client.getLastAppliedInterval("claude");
    expect(intervalSeconds).toBe(3600);
    expect(Number.isFinite(intervalSeconds)).toBe(true);
  });

  it("holds no local pacing formula, probing, or pool-size configuration", () => {
    const source = readFileSync("src/quota/coordinator-client.ts", "utf8");
    const body = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
      .join("\n");

    // §6.4: there is no safe local degraded pacer under a partial outage, so
    // the client derives no interval of its own — it retains what the service
    // last published and widens to the configured ceiling, nothing else.
    for (const forbidden of [
      /\bprobe/i,
      /\bobservation/i,
      /\bpoolSize\b/,
      /\bpool_size\b/,
      /\bcontroller\b/i,
      /\bderivative\b/i,
      /\bintegral\b/i,
      /\bpercentLeft\b/i,
      /SharedQuotaStore|better-sqlite3|child_process|execFile|spawn/,
    ]) {
      expect(body, `coordinator client must not reference ${forbidden}`).not.toMatch(forbidden);
    }
  });
});

describe("Issue #355: Quota coordinator client read mode in instance", () => {
  let root: string | undefined;
  let server: http.Server | undefined;

  async function listen(socketPath: string, handler: http.RequestListener): Promise<void> {
    server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(socketPath, resolve);
    });
  }

  async function stopServer(): Promise<void> {
    const running = server;
    server = undefined;
    if (!running?.listening) return;
    running.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      running.close((err) => (err ? reject(err) : resolve()));
    });
  }

  afterEach(async () => {
    vi.useRealTimers();
    await stopServer();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  describe("Acceptance Criterion 3: client applies published interval and exhaustedUntil", () => {
    it("applies intervalSeconds to ProviderPacer and sets deferUntil from exhaustedUntil via production apply function", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-crit3-"));
      const socketPath = join(root, "coordinator.sock");
      const nowMs = 1773619200000;
      const exhaustedUntilIso = new Date(nowMs + 3_600_000).toISOString();
      const exhaustedUntilMs = Date.parse(exhaustedUntilIso);

      const publishedStatus: PublishedThrottleResponse = {
        service: serviceInfo(),
        provider: "claude",
        intervalSeconds: 450,
        uncappedIntervalSeconds: 450,
        governingBucketKey: "claude:session",
        capped: false,
        expired: true,
        exhaustedUntil: exhaustedUntilIso,
        updatedAt: new Date(nowMs).toISOString(),
        buckets: [
          {
            key: "claude:session",
            percentLeft: 0,
            timeRemainingPct: 50,
            error: -50,
            derivative: 0,
            requiredIntervalSeconds: 450,
            resetAtIso: exhaustedUntilIso,
            observedAt: new Date(nowMs).toISOString(),
          },
        ],
        freshness: { ageMs: 0, buckets: {}, stale: false, hardStale: false },
      };

      await listen(socketPath, (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(publishedStatus));
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        maxIntervalSeconds: 3600,
        now: () => nowMs,
      });
      const pacer = new ProviderPacer(3600 * 1000, () => nowMs);

      const response = await client.getThrottle("claude");
      expect(response).not.toBeNull();
      if (response && "intervalSeconds" in response) {
        applyThrottleStatusToPacer(pacer, response);
      }

      expect(pacer.interval).toBe(450 * 1000);
      expect(pacer.quote(nowMs)).toBe(exhaustedUntilMs);

      const published = client.getLastPublishedStatus("claude");
      expect(published).toBeDefined();
      expect(published?.governingBucketKey).toBe("claude:session");
    });

    it("applies collection response items via production apply function and tracks status", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-crit3-col-"));
      const socketPath = join(root, "coordinator.sock");

      const collectionBody: PublishedThrottleCollectionResponse = {
        service: serviceInfo(),
        providers: {
          claude: {
            provider: "claude",
            intervalSeconds: 500,
            uncappedIntervalSeconds: 500,
            governingBucketKey: "claude:session",
            capped: false,
            expired: false,
            exhaustedUntil: null,
            updatedAt: new Date().toISOString(),
            buckets: [],
            freshness: { ageMs: 0, buckets: {}, stale: false, hardStale: false },
          },
        },
      };

      await listen(socketPath, (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(collectionBody));
      });

      const client = new QuotaCoordinatorClient({ socketPath });
      const pacer = new ProviderPacer(3600 * 1000);

      const response = await client.getThrottle();
      expect(response).not.toBeNull();

      const status = client.getLastPublishedStatus("claude");
      expect(status).toBeDefined();
      if (status) {
        applyThrottleStatusToPacer(pacer, status);
      }

      expect(pacer.interval).toBe(500 * 1000);
    });
  });

  describe("#367: cached weekly admission buckets", () => {
    const weeklyStatus = (
      provider: string,
      percentLeft: number,
      observedAt: string,
      resetAtIso: string
    ) => ({
      ...providerStatus(300, provider),
      buckets: [
        {
          key: `${provider}:weekly`,
          percentLeft,
          timeRemainingPct: 50,
          error: 0,
          derivative: 0,
          requiredIntervalSeconds: 300,
          observedAt,
          resetAtIso,
        },
      ],
    });

    const selectFromClient = (
      client: QuotaCoordinatorClient,
      nowMs: number,
      names: readonly string[] = ["claude", "codex"]
    ) => {
      const candidates = names.map((name) => ({
        config: name,
        lane: name,
        pacer: new ProviderPacer(0, () => nowMs),
        // The same projection start.ts composes into weeklyQuotaFor.
        weeklyQuota: weeklyAdmissionObservation(client.getLastPublishedStatus(name)),
      }));
      return selectPoolLane(candidates, nowMs)?.config;
    };

    const warmedClient = (nowMs: number) => {
      const client = new QuotaCoordinatorClient({ socketPath: "/not-opened/coordinator.sock" });
      const observedAt = new Date(nowMs).toISOString();
      const resetAtIso = new Date(nowMs + 4 * 24 * 60 * 60 * 1_000).toISOString();
      expect(
        client.applyResponse("claude", {
          service: serviceInfo(),
          ...weeklyStatus("claude", 20, observedAt, resetAtIso),
        })
      ).toBe(true);
      expect(
        client.applyResponse("codex", {
          service: serviceInfo(),
          ...weeklyStatus("codex", 80, observedAt, resetAtIso),
        })
      ).toBe(true);
      return client;
    };

    it("uses the existing cached weekly bucket to choose greater headroom without a quota read", () => {
      const nowMs = Date.parse("2040-01-01T00:00:00.000Z");
      const client = warmedClient(nowMs);

      expect(selectFromClient(client, nowMs)).toBe("codex");
      expect(client.getHealth()).toEqual({ quota_client_service_connected: 1 });
    });

    // These four outcomes are decided by selectPoolLane at the merge base (the
    // 30-minute age guard and its finite/tied checks); they document #349
    // semantics surviving the coordinator adapter, not cache retention.
    it("retains declared order for missing, stale, invalid, and tied buckets", () => {
      const nowMs = Date.parse("2040-01-01T00:00:00.000Z");
      const fresh = new Date(nowMs).toISOString();
      const resetAtIso = new Date(nowMs + 4 * 24 * 60 * 60 * 1_000).toISOString();
      const client = new QuotaCoordinatorClient({ socketPath: "/not-opened/coordinator.sock" });
      const apply = (provider: string, status: object) =>
        client.applyResponse(provider, {
          service: serviceInfo(),
          ...status,
        });

      apply("claude", weeklyStatus("claude", 40, fresh, resetAtIso));
      apply("codex", providerStatus(300, "codex"));
      expect(selectFromClient(client, nowMs)).toBe("claude"); // missing

      apply(
        "codex",
        weeklyStatus("codex", 90, new Date(nowMs - 30 * 60 * 1_000 - 1).toISOString(), resetAtIso)
      );
      expect(selectFromClient(client, nowMs)).toBe("claude"); // stale

      apply("codex", weeklyStatus("codex", Number.NaN, fresh, resetAtIso));
      expect(selectFromClient(client, nowMs)).toBe("claude"); // invalid

      apply("codex", weeklyStatus("codex", 40, fresh, resetAtIso));
      expect(selectFromClient(client, nowMs)).toBe("claude"); // tied
    });

    it("retains a fresh winning cache through cold, unavailable, and incompatible responses, then falls back once it is stale", async () => {
      const nowMs = Date.parse("2040-01-01T00:00:00.000Z");
      const staleNowMs = nowMs + 30 * 60 * 1_000 + 1;

      const coldClient = warmedClient(nowMs);
      expect(
        coldClient.applyResponse("codex", {
          service: serviceInfo(),
          error: { code: "not_ready" },
        })
      ).toBe(false);
      expect(coldClient.getLastPublishedStatus("codex")).toBeDefined();
      expect(selectFromClient(coldClient, nowMs)).toBe("codex");
      expect(selectFromClient(coldClient, staleNowMs)).toBe("claude");

      const unavailableClient = warmedClient(nowMs);
      await expect(unavailableClient.getThrottle()).resolves.toBeNull();
      expect(unavailableClient.getHealth()).toEqual({ quota_client_service_connected: 0 });
      expect(unavailableClient.getLastPublishedStatus("codex")).toBeDefined();
      expect(selectFromClient(unavailableClient, nowMs)).toBe("codex");
      expect(selectFromClient(unavailableClient, staleNowMs)).toBe("claude");

      const incompatibleClient = warmedClient(nowMs);
      expect(
        incompatibleClient.applyResponse("codex", {
          service: serviceInfo(COORDINATOR_PROTOCOL_MAJOR + 1),
          ...providerStatus(300, "codex"),
        })
      ).toBe(false);
      expect(incompatibleClient.getHealth()).toEqual({ quota_client_service_connected: 0 });
      expect(incompatibleClient.getLastPublishedStatus("codex")).toBeDefined();
      expect(selectFromClient(incompatibleClient, nowMs)).toBe("codex");
      expect(selectFromClient(incompatibleClient, staleNowMs)).toBe("claude");
    });
  });

  describe("Acceptance Criterion 6 restart case: cold absent and incompatible service", () => {
    it("launches at maxIntervalSeconds when restarted with absent socket", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-restart-absent-"));
      const absentSocketPath = join(root, "absent-coordinator.sock");
      const maxIntervalSeconds = 1800;

      const client = new QuotaCoordinatorClient({
        socketPath: absentSocketPath,
        maxIntervalSeconds,
      });

      const initialInterval = client.getLastAppliedInterval("claude");
      const pacer = new ProviderPacer(initialInterval * 1000);

      expect(pacer.interval).toBe(maxIntervalSeconds * 1000);
      expect(pacer.interval).not.toBe(0);

      const result = await client.getThrottle();
      expect(result).toBeNull();
      expect(pacer.interval).toBe(maxIntervalSeconds * 1000);
    });

    it("launches at maxIntervalSeconds when service answers with protocolMajor mismatch", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-restart-mismatch-"));
      const socketPath = join(root, "coordinator.sock");
      const maxIntervalSeconds = 2400;
      const warnLogs: string[] = [];
      const logger = {
        warn: (msg: unknown) => warnLogs.push(String(msg)),
        error: vi.fn(),
      };

      await listen(socketPath, (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            service: serviceInfo(COORDINATOR_PROTOCOL_MAJOR + 1),
            providers: {
              claude: providerStatus(120),
            },
          })
        );
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        maxIntervalSeconds,
        logger,
      });

      const initialInterval = client.getLastAppliedInterval("claude");
      const pacer = new ProviderPacer(initialInterval * 1000);
      expect(pacer.interval).toBe(maxIntervalSeconds * 1000);

      const response = await client.getThrottle();
      expect(response).toBeNull();
      expect(client.getLastAppliedInterval("claude")).toBe(maxIntervalSeconds);
      expect(pacer.interval).toBe(maxIntervalSeconds * 1000);
      expect(warnLogs.some((l) => /protocol/i.test(l))).toBe(true);
    });
  });

  describe("Production wiring: unpaced when throttle disabled via initialPacerIntervalSeconds", () => {
    it("returns unpaced (0) when throttling is disabled even if coordinator socket client is configured", () => {
      const client = new QuotaCoordinatorClient({
        socketPath: "/tmp/any.sock",
        maxIntervalSeconds: 3600,
      });

      expect(initialPacerIntervalSeconds(false, client, "claude")).toBe(0);
      expect(initialPacerIntervalSeconds(false, null, "claude")).toBe(0);
    });

    it("returns client lastAppliedInterval on cold start when throttling is enabled", () => {
      const client = new QuotaCoordinatorClient({
        socketPath: "/tmp/any.sock",
        maxIntervalSeconds: 1800,
      });

      expect(initialPacerIntervalSeconds(true, client, "claude")).toBe(1800);
      expect(initialPacerIntervalSeconds(true, null, "claude", 2400)).toBe(2400);
    });
  });

  describe("Dashboard history bridge", () => {
    it("fetches /v1/history bounded by the history window and caches records for synchronous getCachedHistory reads", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-history-"));
      const socketPath = join(root, "coordinator.sock");
      let requestedUrl = "";

      const historyRecords: PublishedHistoryRecord[] = [
        {
          scope: "provider",
          kind: "session",
          label: "Claude session",
          observedAt: "2026-09-15T20:00:00.000Z",
          percentLeft: 85,
          resetAtIso: "2026-09-15T23:00:00.000Z",
          controllerError: -5,
          intervalSeconds: 300,
        },
        {
          scope: "provider",
          kind: "weekly",
          label: "Claude weekly",
          observedAt: "2026-09-15T20:00:00.000Z",
          percentLeft: 70,
          resetAtIso: "2026-09-22T00:00:00.000Z",
          controllerError: -10,
          intervalSeconds: 600,
        },
      ];

      await listen(socketPath, (req, res) => {
        requestedUrl = req.url ?? "";
        if (req.url?.startsWith("/v1/history")) {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              service: serviceInfo(),
              provider: "claude",
              since: "2026-09-12T20:00:00.000Z",
              records: historyRecords,
            })
          );
        } else {
          res.statusCode = 404;
          res.end();
        }
      });

      const nowMs = 1773619200000;
      const client = new QuotaCoordinatorClient({
        socketPath,
        now: () => nowMs,
      });

      expect(client.getCachedHistory("claude")).toEqual([]);

      const records = await client.getHistory("claude");
      expect(records).not.toBeNull();
      expect(records).toHaveLength(2);

      // Verify bounded by HISTORY_WINDOW_MS in the default query
      const expectedSince = new Date(nowMs - HISTORY_WINDOW_MS).toISOString();
      expect(requestedUrl).toContain(encodeURIComponent(expectedSince));

      const cached = client.getCachedHistory("claude");
      expect(cached).toHaveLength(2);
      expect(cached[0].kind).toBe("session");

      const filtered = client.getCachedHistory("claude", "2026-09-15T20:30:00.000Z");
      expect(filtered).toHaveLength(0);
    });

    it("treats history failures as null without replacing existing cache on error, timeout, HTTP failure, protocol mismatch, identity mismatch, or bad shape", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-history-failures-"));
      const socketPath = join(root, "coordinator.sock");
      let handlerMode:
        | "valid"
        | "500"
        | "protocol_mismatch"
        | "wrong_provider"
        | "bad_shape"
        | "empty" = "valid";

      const validRecord: PublishedHistoryRecord = {
        scope: "provider",
        kind: "session",
        label: "Claude session",
        observedAt: "2026-09-15T20:00:00.000Z",
        percentLeft: 80,
        resetAtIso: null,
        controllerError: null,
        intervalSeconds: 300,
      };

      await listen(socketPath, (_req, res) => {
        res.setHeader("content-type", "application/json");
        if (handlerMode === "valid") {
          res.end(
            JSON.stringify({
              service: serviceInfo(),
              provider: "claude",
              since: "2026-09-15T00:00:00.000Z",
              records: [validRecord],
            })
          );
        } else if (handlerMode === "500") {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "internal error" }));
        } else if (handlerMode === "protocol_mismatch") {
          res.end(
            JSON.stringify({
              service: serviceInfo(COORDINATOR_PROTOCOL_MAJOR + 1),
              provider: "claude",
              since: "2026-09-15T00:00:00.000Z",
              records: [],
            })
          );
        } else if (handlerMode === "wrong_provider") {
          res.end(
            JSON.stringify({
              service: serviceInfo(),
              provider: "codex", // mismatched provider
              since: "2026-09-15T00:00:00.000Z",
              records: [],
            })
          );
        } else if (handlerMode === "bad_shape") {
          res.end(
            JSON.stringify({
              service: serviceInfo(),
              provider: "claude",
              since: "2026-09-15T00:00:00.000Z",
              records: [{ invalid: "not a history record" }],
            })
          );
        } else if (handlerMode === "empty") {
          res.end(
            JSON.stringify({
              service: serviceInfo(),
              provider: "claude",
              since: "2026-09-15T00:00:00.000Z",
              records: [],
            })
          );
        }
      });

      const client = new QuotaCoordinatorClient({ socketPath });

      // 1. Valid fetch populates cache
      handlerMode = "valid";
      const initial = await client.getHistory("claude");
      expect(initial).toHaveLength(1);
      expect(client.getCachedHistory("claude")).toHaveLength(1);

      // 2. HTTP 500 failure returns null and preserves cache
      handlerMode = "500";
      expect(await client.getHistory("claude")).toBeNull();
      expect(client.getCachedHistory("claude")).toHaveLength(1);

      // 3. Protocol mismatch returns null and preserves cache
      handlerMode = "protocol_mismatch";
      expect(await client.getHistory("claude")).toBeNull();
      expect(client.getCachedHistory("claude")).toHaveLength(1);

      // 4. Provider identity mismatch returns null and preserves cache
      handlerMode = "wrong_provider";
      expect(await client.getHistory("claude")).toBeNull();
      expect(client.getCachedHistory("claude")).toHaveLength(1);

      // 5. Bad shape returns null and preserves cache
      handlerMode = "bad_shape";
      expect(await client.getHistory("claude")).toBeNull();
      expect(client.getCachedHistory("claude")).toHaveLength(1);

      // 6. Valid empty response replaces cache with []
      handlerMode = "empty";
      const emptyResult = await client.getHistory("claude");
      expect(emptyResult).toEqual([]);
      expect(client.getCachedHistory("claude")).toEqual([]);
    });

    it("times out coordinator history request when socket hangs", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-history-hung-"));
      const socketPath = join(root, "coordinator.sock");
      await listen(socketPath, () => {
        // Deliberately never respond
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        requestTimeoutMs: 50,
      });

      const result = await client.getHistory("claude");
      expect(result).toBeNull();
    });

    it("populates history cache independently per provider when concurrent requests have partial success", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-history-partial-"));
      const socketPath = join(root, "coordinator.sock");

      const agyRecord: PublishedHistoryRecord = {
        scope: "provider",
        kind: "5h",
        label: "Antigravity 5h",
        observedAt: "2026-09-16T20:00:00.000Z",
        percentLeft: 60,
        resetAtIso: null,
        controllerError: null,
        intervalSeconds: 300,
      };

      await listen(socketPath, (req, res) => {
        res.setHeader("content-type", "application/json");
        const url = new URL(req.url ?? "", "http://localhost");
        const provider = url.searchParams.get("provider");

        if (provider === "agy") {
          res.end(
            JSON.stringify({
              service: serviceInfo(),
              provider: "agy",
              since: "2026-09-15T00:00:00.000Z",
              records: [agyRecord],
            })
          );
        } else if (provider === "claude") {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "coordinator internal error" }));
        } else {
          res.statusCode = 404;
          res.end();
        }
      });

      const client = new QuotaCoordinatorClient({ socketPath });

      // Simulate refreshQuotaHistory: Promise.allSettled across multiple configured providers
      const sinceIso = new Date(Date.now() - HISTORY_WINDOW_MS).toISOString();
      const results = await Promise.allSettled([
        client.getHistory("agy", sinceIso),
        client.getHistory("claude", sinceIso),
      ]);

      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("fulfilled");

      // Successful provider's history cache is populated independently
      expect(client.getCachedHistory("agy")).toEqual([agyRecord]);

      // Failed provider resolves null and its cache remains empty without affecting the successful provider
      expect(client.getCachedHistory("claude")).toEqual([]);
    });

    it("cleans up in-flight coordinator history request on timeout and allows clean server teardown without hanging", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-history-cleanup-"));
      const socketPath = join(root, "coordinator.sock");
      let releaseResponse: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      let requestSeen: (() => void) | undefined;
      const requestSeenPromise = new Promise<void>((resolve) => {
        requestSeen = resolve;
      });

      await listen(socketPath, async (_req, res) => {
        requestSeen?.();
        await gate;
        if (!res.writableEnded) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ service: serviceInfo(), provider: "claude", records: [] }));
        }
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        requestTimeoutMs: 100,
      });

      const historyPromise = client.getHistory("claude");
      await requestSeenPromise;

      // Timeout fires while handler is waiting on gate
      const result = await historyPromise;
      expect(result).toBeNull();

      // Deterministic cleanup: release gate and stop server cleanly without hanging
      releaseResponse?.();
    });
  });

  describe("Production tick reconciliation: warm → outage/cold → hard-stale", () => {
    it("reconciles pacers from client across warm -> outage -> hard-stale progression", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-reconcile-"));
      const socketPath = join(root, "coordinator.sock");
      let nowMs = 10000;
      let handlerMode: "warm" | "outage" | "cold" = "warm";
      const maxIntervalSeconds = 3600;
      const hardStaleAfterMs = 5000;

      await listen(socketPath, (_req, res) => {
        if (handlerMode === "warm") {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              service: serviceInfo(),
              providers: {
                claude: providerStatus(120, "claude"),
                codex: providerStatus(180, "codex"),
              },
            })
          );
        } else if (handlerMode === "cold") {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              service: serviceInfo(),
              providers: {
                claude: {
                  error: { code: "not_ready", retryable: true, message: "cold lane" },
                },
              },
            })
          );
        } else {
          res.statusCode = 500;
          res.end("internal error");
        }
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        maxIntervalSeconds,
        hardStaleAfterMs,
        now: () => nowMs,
      });

      const pacers = new Map([
        ["claude", new ProviderPacer(maxIntervalSeconds * 1000, () => nowMs)],
        ["codex", new ProviderPacer(maxIntervalSeconds * 1000, () => nowMs)],
      ]);
      const pacerFor = (p: string) => {
        const pacer = pacers.get(p);
        if (!pacer) throw new Error(`missing pacer for ${p}`);
        return pacer;
      };
      const configuredProviders = ["claude", "codex"] as const;

      // 0. Cold start: both pacers start at maxIntervalSeconds
      reconcileProviderPacersFromClient(pacerFor, configuredProviders, client);
      expect(pacerFor("claude").interval).toBe(maxIntervalSeconds * 1000);
      expect(pacerFor("codex").interval).toBe(maxIntervalSeconds * 1000);

      // 1. Warm tick: both lanes receive published intervals
      const warmResp = await client.getThrottle();
      expect(warmResp).not.toBeNull();
      reconcileProviderPacersFromClient(pacerFor, configuredProviders, client);
      expect(pacerFor("claude").interval).toBe(120 * 1000);
      expect(pacerFor("codex").interval).toBe(180 * 1000);

      const claudePublished = client.getLastPublishedStatus("claude");
      expect(claudePublished?.intervalSeconds).toBe(120);

      // 2. Outage tick within hardStaleAfterMs (nowMs + 3000ms < hardStaleAfterMs 5000ms)
      nowMs += 3000;
      handlerMode = "outage";
      const outageResp = await client.getThrottle();
      expect(outageResp).toBeNull();
      reconcileProviderPacersFromClient(pacerFor, configuredProviders, client);
      // Retains previous warm interval
      expect(pacerFor("claude").interval).toBe(120 * 1000);
      expect(pacerFor("codex").interval).toBe(180 * 1000);
      // Published status details preserved intact
      expect(client.getLastPublishedStatus("claude")?.intervalSeconds).toBe(120);

      // 3. Cold lane response within hardStaleAfterMs (nowMs + 1000ms, total 4000ms < 5000ms)
      nowMs += 1000;
      handlerMode = "cold";
      const coldResp = await client.getThrottle();
      expect(coldResp).not.toBeNull();
      reconcileProviderPacersFromClient(pacerFor, configuredProviders, client);
      // Still within hard-stale window -> retained
      expect(pacerFor("claude").interval).toBe(120 * 1000);
      expect(pacerFor("codex").interval).toBe(180 * 1000);

      // 4. Hard-stale widening past hardStaleAfterMs (nowMs + 2000ms, total 6000ms > 5000ms)
      nowMs += 2000;
      await client.getThrottle();
      reconcileProviderPacersFromClient(pacerFor, configuredProviders, client);
      // Both pacers widen to maxIntervalSeconds on client clock
      expect(pacerFor("claude").interval).toBe(maxIntervalSeconds * 1000);
      expect(pacerFor("codex").interval).toBe(maxIntervalSeconds * 1000);
      // Published status details remain preserved
      expect(client.getLastPublishedStatus("claude")?.intervalSeconds).toBe(120);

      // 5. Recovery tick: service answers with fresh warm interval
      nowMs += 1000;
      handlerMode = "warm";
      await client.getThrottle();
      reconcileProviderPacersFromClient(pacerFor, configuredProviders, client);
      expect(pacerFor("claude").interval).toBe(120 * 1000);
      expect(pacerFor("codex").interval).toBe(180 * 1000);
    });

    it("reconciles omitted lane in collection response to hard-stale while present lane remains warm", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-omitted-"));
      const socketPath = join(root, "coordinator.sock");
      let nowMs = 10000;
      let omitCodex = false;
      const maxIntervalSeconds = 3600;
      const hardStaleAfterMs = 5000;

      await listen(socketPath, (_req, res) => {
        res.setHeader("content-type", "application/json");
        const providers: Record<string, unknown> = {
          claude: providerStatus(100, "claude"),
        };
        if (!omitCodex) {
          providers.codex = providerStatus(200, "codex");
        }
        res.end(
          JSON.stringify({
            service: serviceInfo(),
            providers,
          })
        );
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        maxIntervalSeconds,
        hardStaleAfterMs,
        now: () => nowMs,
      });

      const pacers = new Map([
        ["claude", new ProviderPacer(maxIntervalSeconds * 1000, () => nowMs)],
        ["codex", new ProviderPacer(maxIntervalSeconds * 1000, () => nowMs)],
      ]);
      const pacerFor = (p: string) => {
        const pacer = pacers.get(p);
        if (!pacer) throw new Error(`missing pacer for ${p}`);
        return pacer;
      };
      const configuredProviders = ["claude", "codex"] as const;

      // Tick 1: both warm
      await client.getThrottle();
      reconcileProviderPacersFromClient(pacerFor, configuredProviders, client);
      expect(pacerFor("claude").interval).toBe(100 * 1000);
      expect(pacerFor("codex").interval).toBe(200 * 1000);

      // Tick 2: codex omitted and time advanced past hardStaleAfterMs
      nowMs += 6000;
      omitCodex = true;
      await client.getThrottle();
      reconcileProviderPacersFromClient(pacerFor, configuredProviders, client);

      // claude updated with fresh warm interval (100s)
      expect(pacerFor("claude").interval).toBe(100 * 1000);
      // codex was omitted; past hard-stale window -> widened to maxIntervalSeconds
      expect(pacerFor("codex").interval).toBe(maxIntervalSeconds * 1000);
    });

    it("preserves deferUntil(exhaustedUntil) across reconciliation on an active pacer with started run", async () => {
      const nowMs = 10000;
      const pacer = new ProviderPacer(0, () => nowMs);

      // 1. Submit and start one run on the pacer so lastStartedAt is populated
      const run = pacer.submit(async () => "run-1", {
        enqueueNormal: (fn) => ({
          result: fn(),
          started: true,
          promote: () => {},
          cancel: () => true,
        }),
      });
      await run.result;
      expect(run.started).toBe(true);

      // 2. Apply an expired status with exhaustedUntil via applyThrottleStatusToPacer
      const exhaustedUntilMs = nowMs + 3_600_000;
      const publishedStatus: PublishedThrottleResponse = {
        service: serviceInfo(),
        provider: "claude",
        intervalSeconds: 60,
        uncappedIntervalSeconds: 60,
        governingBucketKey: "claude:session",
        capped: false,
        expired: true,
        exhaustedUntil: new Date(exhaustedUntilMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
        buckets: [],
        freshness: { ageMs: 0, buckets: {}, stale: false, hardStale: false },
      };

      applyThrottleStatusToPacer(pacer, publishedStatus);
      expect(pacer.interval).toBe(60 * 1000);
      expect(pacer.quote(nowMs)).toBe(exhaustedUntilMs);

      // 3. Call reconcileProviderPacersFromClient with client reporting same target interval
      const mockClient = {
        getLastAppliedInterval: vi.fn().mockReturnValue(60),
      };
      const pacerFor = (_provider: string) => pacer;
      reconcileProviderPacersFromClient(pacerFor, ["claude"], mockClient);

      // 4. Assert the pacer's next availability still honors exhaustedUntil
      expect(pacer.interval).toBe(60 * 1000);
      expect(pacer.quote(nowMs)).toBe(exhaustedUntilMs);
    });

    it("preserves deferUntil(exhaustedUntil) across live socket tick reconciliation after a run starts", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-defer-survive-"));
      const socketPath = join(root, "coordinator.sock");
      const nowMs = 10000;
      const exhaustedUntilMs = nowMs + 3_600_000;
      const exhaustedUntilIso = new Date(exhaustedUntilMs).toISOString();

      await listen(socketPath, (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            service: serviceInfo(),
            providers: {
              claude: {
                ...providerStatus(60, "claude"),
                expired: true,
                exhaustedUntil: exhaustedUntilIso,
              },
            },
          })
        );
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        maxIntervalSeconds: 3600,
        now: () => nowMs,
      });

      const pacer = new ProviderPacer(0, () => nowMs);
      const pacerFor = (_provider: string) => pacer;

      // 1. Submit and start one run so lastStartedAt is populated
      const run = pacer.submit(async () => "run-1", {
        enqueueNormal: (fn) => ({
          result: fn(),
          started: true,
          promote: () => {},
          cancel: () => true,
        }),
      });
      await run.result;
      expect(run.started).toBe(true);

      // 2. Fetch throttle and apply status to pacer
      const response = await client.getThrottle();
      expect(response).not.toBeNull();
      const status = client.getLastPublishedStatus("claude");
      expect(status).toBeDefined();
      if (status) {
        applyThrottleStatusToPacer(pacer, status);
      }
      expect(pacer.interval).toBe(60 * 1000);
      expect(pacer.quote(nowMs)).toBe(exhaustedUntilMs);

      // 3. Reconcile pacer from client (simulating tick finally)
      reconcileProviderPacersFromClient(pacerFor, ["claude"], client);

      // 4. Assert deferUntil is preserved and availability still equals exhaustedUntil
      expect(pacer.interval).toBe(60 * 1000);
      expect(pacer.quote(nowMs)).toBe(exhaustedUntilMs);
    });

    it("preserves deferUntil(exhaustedUntil) across hard-stale interval widening when exhaustedUntil is later than lastStartedAt + maxIntervalSeconds", async () => {
      let nowMs = 10000;
      const maxIntervalSeconds = 3600;
      const hardStaleAfterMs = 5000;

      const client = new QuotaCoordinatorClient({
        socketPath: "/tmp/any.sock",
        maxIntervalSeconds,
        hardStaleAfterMs,
        now: () => nowMs,
      });

      const pacer = new ProviderPacer(0, () => nowMs);

      // 1. Submit and start one run on the pacer so lastStartedAt is populated (10000)
      const run = pacer.submit(async () => "run-1", {
        enqueueNormal: (fn) => ({
          result: fn(),
          started: true,
          promote: () => {},
          cancel: () => true,
        }),
      });
      await run.result;
      expect(run.started).toBe(true);

      // 2. Apply an expired status with exhaustedUntil 5 hours out (18010000)
      const exhaustedUntilMs = nowMs + 5 * 3600_000;
      const publishedStatus: PublishedThrottleResponse = {
        service: serviceInfo(),
        provider: "claude",
        intervalSeconds: 60,
        uncappedIntervalSeconds: 60,
        governingBucketKey: "claude:session",
        capped: false,
        expired: true,
        exhaustedUntil: new Date(exhaustedUntilMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
        buckets: [],
        freshness: { ageMs: 0, buckets: {}, stale: false, hardStale: false },
      };

      client.applyResponse("claude", publishedStatus);
      applyThrottleStatusToPacer(pacer, publishedStatus);

      expect(pacer.interval).toBe(60 * 1000);
      expect(pacer.quote(nowMs)).toBe(exhaustedUntilMs);

      // 3. Advance clock past hardStaleAfterMs (e.g. 1 hour later)
      nowMs += 3600_000;
      expect(client.getLastAppliedInterval("claude")).toBe(maxIntervalSeconds);
      // Verify lastStartedAt + maxIntervalSeconds * 1000 (3610000) is earlier than exhaustedUntilMs (18010000)
      expect(10000 + maxIntervalSeconds * 1000).toBeLessThan(exhaustedUntilMs);

      // 4. Reconcile pacer from client where target interval changes from 60s to 3600s
      const pacerFor = (_provider: string) => pacer;
      reconcileProviderPacersFromClient(pacerFor, ["claude"], client);

      // 5. Assert pacer interval widened to maxIntervalSeconds AND quote still honors exhaustedUntilMs
      expect(pacer.interval).toBe(maxIntervalSeconds * 1000);
      expect(pacer.quote(nowMs)).toBe(exhaustedUntilMs);
    });

    it("preserves deferUntil(exhaustedUntil) across live outage past hard-stale widening when exhaustedUntil is later than lastStartedAt + maxIntervalSeconds", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-defer-hardstale-"));
      const socketPath = join(root, "coordinator.sock");
      let nowMs = 10000;
      const maxIntervalSeconds = 3600;
      const hardStaleAfterMs = 5000;
      const exhaustedUntilMs = nowMs + 5 * 3600_000; // 5 hours out
      const exhaustedUntilIso = new Date(exhaustedUntilMs).toISOString();

      await listen(socketPath, (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            service: serviceInfo(),
            providers: {
              claude: {
                ...providerStatus(60, "claude"),
                expired: true,
                exhaustedUntil: exhaustedUntilIso,
              },
            },
          })
        );
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        maxIntervalSeconds,
        hardStaleAfterMs,
        now: () => nowMs,
      });

      const pacer = new ProviderPacer(0, () => nowMs);
      const pacerFor = (_provider: string) => pacer;

      // 1. Submit and start one run so lastStartedAt is populated (10000)
      const run = pacer.submit(async () => "run-1", {
        enqueueNormal: (fn) => ({
          result: fn(),
          started: true,
          promote: () => {},
          cancel: () => true,
        }),
      });
      await run.result;
      expect(run.started).toBe(true);

      // 2. Fetch warm throttle and apply status to pacer
      const response = await client.getThrottle();
      expect(response).not.toBeNull();
      const status = client.getLastPublishedStatus("claude");
      expect(status).toBeDefined();
      if (status) {
        applyThrottleStatusToPacer(pacer, status);
      }
      expect(pacer.interval).toBe(60 * 1000);
      expect(pacer.quote(nowMs)).toBe(exhaustedUntilMs);

      // 3. Reconcile on warm tick (no-op)
      reconcileProviderPacersFromClient(pacerFor, ["claude"], client);
      expect(pacer.interval).toBe(60 * 1000);
      expect(pacer.quote(nowMs)).toBe(exhaustedUntilMs);

      // 4. Coordinator goes down (outage) and clock advances past hard-stale window (1 hour later)
      await stopServer();
      nowMs += 3600_000; // nowMs = 3610000
      expect(10000 + maxIntervalSeconds * 1000).toBeLessThan(exhaustedUntilMs);

      const outageResp = await client.getThrottle();
      expect(outageResp).toBeNull();
      expect(client.getLastAppliedInterval("claude")).toBe(maxIntervalSeconds);

      // 5. Reconcile pacer (simulating tick finally during hard-stale outage)
      reconcileProviderPacersFromClient(pacerFor, ["claude"], client);

      // 6. Assert pacer interval widened to maxIntervalSeconds AND quote still honors exhaustedUntilMs
      expect(pacer.interval).toBe(maxIntervalSeconds * 1000);
      expect(pacer.quote(nowMs)).toBe(exhaustedUntilMs);
    });
  });

  describe("Acceptance Criterion 15: get_quota reads through the service (#356, design §10 criterion 15, §12 item 4)", () => {
    it("answers from GET /v1/quota with socket present and triggers zero probes", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-crit15-warm-"));
      const socketPath = join(root, "coordinator.sock");
      let getQuotaRequested = false;

      const warmResponse = {
        service: serviceInfo(),
        provider: "claude",
        status: "available",
        limits: [
          {
            kind: "session",
            label: "Session",
            percentLeft: 85,
            scope: { provider: "claude" },
          },
        ],
        scrapedAt: new Date(0).toISOString(),
      };

      await listen(socketPath, (req, res) => {
        if (req.url?.startsWith("/v1/quota")) {
          getQuotaRequested = true;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(warmResponse));
          return;
        }
        res.statusCode = 404;
        res.end();
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        configuredProviders: ["claude"],
      });

      const result = await client.getQuotaWithFallback("claude");
      expect(getQuotaRequested).toBe(true);
      expect(result.status).toBe("available");
      expect(result.provider).toBe("claude");
      expect(result.limits?.[0].percentLeft).toBe(85);
      expect(client.getHealth().quota_client_service_connected).toBe(1);
    });

    it("returns unknown shape with freshness block when service is cold and triggers zero probes", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-crit15-cold-"));
      const socketPath = join(root, "coordinator.sock");
      let getQuotaRequested = false;

      const coldResponse = {
        service: serviceInfo(),
        provider: "claude",
        status: "unknown",
        limits: [],
        freshness: {
          ageMs: null,
          buckets: {},
          stale: true,
          hardStale: true,
        },
      };

      await listen(socketPath, (req, res) => {
        if (req.url?.startsWith("/v1/quota")) {
          getQuotaRequested = true;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(coldResponse));
          return;
        }
        res.statusCode = 404;
        res.end();
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        configuredProviders: ["claude"],
      });

      const result = await client.getQuotaWithFallback("claude");
      expect(getQuotaRequested).toBe(true);
      expect(result.status).toBe("unknown");
      expect(result.provider).toBe("claude");
      expect(result.limits).toEqual([]);
      expect(result.freshness).toBeDefined();
      expect(result.freshness?.stale).toBe(true);
      expect(result.freshness?.hardStale).toBe(true);
    });

    it("returns unknown shape with freshness block on cold path (socket absent) and triggers zero probes", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-crit15-absent-"));
      const socketPath = join(root, "nonexistent-coordinator.sock");

      const client = new QuotaCoordinatorClient({
        socketPath,
        configuredProviders: ["claude"],
      });

      const result = await client.getQuotaWithFallback("claude");
      expect(result.status).toBe("unknown");
      expect(result.provider).toBe("claude");
      expect(result.limits).toEqual([]);
      expect(result.freshness).toBeDefined();
      expect(result.freshness?.stale).toBe(true);
      expect(result.freshness?.hardStale).toBe(true);
      expect(client.getHealth().quota_client_service_connected).toBe(0);
    });

    it("returns status unsupported and not an error for unconfigured provider with socket present", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-crit15-unsupp-socket-"));
      const socketPath = join(root, "coordinator.sock");
      let getQuotaRequested = false;

      const unsupportedResponse = {
        service: serviceInfo(),
        provider: "codex",
        status: "unsupported",
        limits: [],
      };

      await listen(socketPath, (req, res) => {
        if (req.url?.startsWith("/v1/quota")) {
          getQuotaRequested = true;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(unsupportedResponse));
          return;
        }
        res.statusCode = 404;
        res.end();
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
      });

      const result = await client.getQuotaWithFallback("codex");
      expect(getQuotaRequested).toBe(true);
      expect(result.status).toBe("unsupported");
      expect(result.provider).toBe("codex");
    });

    it("returns status unsupported and not an error for unconfigured provider on cold path (socket absent)", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-crit15-unsupp-cold-"));
      const socketPath = join(root, "nonexistent-coordinator.sock");

      const client = new QuotaCoordinatorClient({
        socketPath,
        configuredProviders: ["claude"],
      });

      const result = await client.getQuotaWithFallback("codex");
      expect(result.status).toBe("unsupported");
      expect(result.provider).toBe("codex");
    });

    it("answers unsupported for an unconfigured provider without touching the socket even when warm", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-crit15-unsupp-nosock-"));
      const socketPath = join(root, "coordinator.sock");
      let requests = 0;

      await listen(socketPath, (_req, res) => {
        requests += 1;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            service: serviceInfo(),
            provider: "codex",
            status: "available",
            limits: [],
          })
        );
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        configuredProviders: ["claude"],
      });

      const result = await client.getQuotaWithFallback("codex");
      expect(requests).toBe(0);
      expect(result.status).toBe("unsupported");
      expect(result.provider).toBe("codex");
      expect(result.message).toContain("is not configured");
    });

    it("treats a non-200 answer as unavailability: cold unknown fallback and service disconnected", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-crit15-non200-"));
      const socketPath = join(root, "coordinator.sock");

      await listen(socketPath, (_req, res) => {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            service: serviceInfo(),
            error: { code: "internal_error", message: "boom", retryable: true },
          })
        );
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        configuredProviders: ["claude"],
      });

      const result = await client.getQuotaWithFallback("claude");
      expect(result.status).toBe("unknown");
      expect(result.freshness).toEqual({ ageMs: null, buckets: {}, stale: true, hardStale: true });
      expect(client.getHealth().quota_client_service_connected).toBe(0);
    });

    it.each([
      ["limits is not an array", { limits: { label: "Weekly", percentLeft: 50 } }],
      ["a limit lacks percentLeft", { limits: [{ label: "Weekly" }] }],
      [
        "a limit has a non-numeric percentLeft",
        { limits: [{ label: "Weekly", percentLeft: "50" }] },
      ],
      [
        "a limit carries an unknown kind",
        { limits: [{ label: "Weekly", percentLeft: 50, kind: "monthly" }] },
      ],
      [
        "a limit scope is malformed",
        { limits: [{ label: "Weekly", percentLeft: 50, scope: { models: ["x"] } }] },
      ],
      ["freshness is malformed", { limits: [], freshness: { stale: "yes" } }],
      ["message is not a string", { limits: [], message: 42 }],
    ])("rejects a matching-major 200 body whose nested fields are malformed (%s) as cold unknown", async (_label, overrides) => {
      root = mkdtempSync(join(tmpdir(), "quota-client-crit15-malformed-"));
      const socketPath = join(root, "coordinator.sock");

      await listen(socketPath, (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            service: serviceInfo(),
            provider: "claude",
            status: "available",
            ...overrides,
          })
        );
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        configuredProviders: ["claude"],
      });

      const result = await client.getQuotaWithFallback("claude");
      expect(result.status).toBe("unknown");
      expect(result.limits).toEqual([]);
      expect(result.freshness?.hardStale).toBe(true);
      expect(client.getHealth().quota_client_service_connected).toBe(0);
    });

    it("passes a well-formed 200 body through with nested limits, scope, and freshness intact", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-crit15-wellformed-"));
      const socketPath = join(root, "coordinator.sock");

      const body = {
        service: serviceInfo(),
        provider: "claude",
        status: "exhausted",
        limits: [
          {
            label: "Session",
            kind: "session",
            percentLeft: 0,
            resetAtIso: "2026-01-01T00:00:00.000Z",
          },
          {
            label: "Opus",
            kind: "weekly",
            percentLeft: 12,
            scope: { provider: "claude", models: ["opus"] },
          },
          { label: "Legacy", percentLeft: 3, scope: "provider" },
        ],
        freshness: { ageMs: 1234, buckets: { weekly: 1234 }, stale: false, hardStale: false },
        message: "banner",
        scrapedAt: "2026-01-01T00:00:00.000Z",
      };

      await listen(socketPath, (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        configuredProviders: ["claude"],
      });

      const result = await client.getQuotaWithFallback("claude");
      expect(result.status).toBe("exhausted");
      expect(result.limits).toEqual(body.limits);
      expect(result.freshness).toEqual(body.freshness);
      expect(result.message).toBe("banner");
      expect(client.getHealth().quota_client_service_connected).toBe(1);
    });

    it("refuses protocolMajor mismatch by returning cold unknown fallback and marking service disconnected", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-crit15-mismatch-"));
      const socketPath = join(root, "coordinator.sock");

      await listen(socketPath, (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            service: serviceInfo(COORDINATOR_PROTOCOL_MAJOR + 1),
            provider: "claude",
            status: "available",
            limits: [],
          })
        );
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        configuredProviders: ["claude"],
      });

      const result = await client.getQuotaWithFallback("claude");
      expect(result.status).toBe("unknown");
      expect(result.freshness?.stale).toBe(true);
      expect(client.getHealth().quota_client_service_connected).toBe(0);
    });

    it("#690: getLastAppliedInterval reachability fail-safe uses client hardStaleAfterMs independently of service published threshold", async () => {
      root = mkdtempSync(join(tmpdir(), "quota-client-690-hardstale-"));
      const socketPath = join(root, "coordinator.sock");
      let nowMs = 1_000_000;

      await listen(socketPath, (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            service: serviceInfo(),
            provider: "claude",
            intervalSeconds: 300,
            uncappedIntervalSeconds: 300,
            governingBucketKey: "claude:weekly",
            capped: false,
            expired: false,
            exhaustedUntil: null,
            updatedAt: new Date(nowMs).toISOString(),
            buckets: [],
            freshness: {
              ageMs: 0,
              buckets: {},
              stale: false,
              hardStale: false,
              mode: "manual",
              staleAfterMs: 3_600_000,
              hardStaleAfterMs: 7_200_000, // 120m from service
              resetWaiting: false,
            },
          })
        );
      });

      const client = new QuotaCoordinatorClient({
        socketPath,
        configuredProviders: ["claude"],
        maxIntervalSeconds: 36000,
        hardStaleAfterMs: 3_600_000, // client default is 60m
        now: () => nowMs,
      });

      await client.getThrottle("claude");
      expect(client.getLastAppliedInterval("claude")).toBe(300);

      // Advance clock by 30 minutes (within client 60m reachability threshold)
      nowMs += 1_800_000;
      expect(client.getLastAppliedInterval("claude")).toBe(300);

      // Advance clock past client 60 minutes reachability threshold (total 70m elapsed)
      nowMs += 2_400_000;
      expect(client.getLastAppliedInterval("claude")).toBe(36000); // capped to maxIntervalSeconds
    });
  });
});
