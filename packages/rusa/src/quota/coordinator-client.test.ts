import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuotaCoordinatorClient } from "./coordinator-client.js";
import { COORDINATOR_PROTOCOL_MAJOR, COORDINATOR_PROTOCOL_MINOR } from "./coordinator-protocol.js";

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
    await expect(client.getThrottle("claude")).resolves.toBeNull();
    expect(client.getHealth()).toEqual({ quota_client_service_connected: 1 });
    expect(client.getLastAppliedInterval("claude")).toBe(3600);
  });

  it("marks reachable on 200 not_ready cold single provider while retaining interval (#480)", async () => {
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
      /\bscrape/i,
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
