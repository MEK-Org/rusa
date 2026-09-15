import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as dbModule from "../db/index.js";
import { captureQuota } from "../harness/quota-capture.js";
import type { ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";
import * as quotaMcp from "../mcp/quota-mcp.js";
import { QuotaCoordinatorClient } from "../quota/coordinator-client.js";
import { COORDINATOR_PROTOCOL_MAJOR } from "../quota/coordinator-protocol.js";
import { coordinatorQuotaReader, QuotaRecorder, resolveAbQuotaSocketPath } from "./ab-context.js";
import { defaultQuotaCoordinatorSocketPath } from "./quota-coordinator.js";

/**
 * The rig is a CLIENT of the quota coordinator (design §8.5, criterion 14): it builds no
 * `QuotaService`, is given no `databasePath`, and takes no probe of its own. Both of its
 * readings are whatever the service last observed, so an unchanged `scrapedAt` across a
 * run means "no new observation" — NO MEASUREMENT — and never a burn of zero.
 */

const AT_LAUNCH = "2026-09-15T09:10:00.000Z";
const AT_EXIT = "2026-09-15T09:35:00.000Z";

function serviceEnvelope() {
  return {
    protocolMajor: COORDINATOR_PROTOCOL_MAJOR,
    protocolMinor: 0,
    serverVersion: "test",
    serverTime: AT_LAUNCH,
  };
}

function kimiSnapshot(scrapedAt: string, fiveHour: number, weekly: number): ProviderQuotaSnapshot {
  return {
    provider: "kimi",
    status: "available",
    scrapedAt,
    limits: [
      { label: "5h limit", kind: "five_hour", percentLeft: fiveHour },
      { label: "Weekly limit", kind: "weekly", percentLeft: weekly },
    ],
  };
}

interface FakeCoordinator {
  socketPath: string;
  /** Every path the rig actually asked the service for, in order. */
  requested: string[];
  close: () => Promise<void>;
}

/**
 * A coordinator answering on a unix socket, so the reader is exercised over the real
 * transport rather than a stub of it. `respond` answers one request at a time.
 */
async function startFakeCoordinator(
  respond: (n: number) => { status: number; body: unknown }
): Promise<FakeCoordinator> {
  const dir = mkdtempSync(join(tmpdir(), "rusa-ab-quota-"));
  const socketPath = join(dir, "coordinator.sock");
  const requested: string[] = [];
  let seen = 0;

  const server = http.createServer((req, res) => {
    requested.push(req.url ?? "");
    const { status, body } = respond(seen++);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  return {
    socketPath,
    requested,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const openCoordinators: FakeCoordinator[] = [];

afterEach(async () => {
  while (openCoordinators.length > 0) {
    await openCoordinators.pop()?.close();
  }
});

async function coordinator(
  respond: (n: number) => { status: number; body: unknown }
): Promise<FakeCoordinator> {
  const started = await startFakeCoordinator(respond);
  openCoordinators.push(started);
  return started;
}

describe("the rig reads quota from the coordinator, and from nothing else", () => {
  it("takes its reading from GET /v1/quota, carrying the service's own scrapedAt", async () => {
    const service = await coordinator(() => ({
      status: 200,
      body: { service: serviceEnvelope(), ...kimiSnapshot(AT_LAUNCH, 100, 46) },
    }));

    const snapshot = await coordinatorQuotaReader(service.socketPath)("kimi");

    // The evidence view, not the publication contract: /v1/throttle publishes a controller
    // decision and carries no canonical scrape stamp for the comparison to key on.
    expect(service.requested).toEqual(["/v1/quota?provider=kimi"]);
    expect(snapshot.scrapedAt).toBe(AT_LAUNCH);
    expect(snapshot.status).toBe("available");
    // The transport envelope is the service's, not the snapshot's; it must not leak into
    // the reading the harness records as provider evidence.
    expect(snapshot).not.toHaveProperty("service");
  });

  it("records a cold service as UNREADABLE rather than as a window of zero", async () => {
    const service = await coordinator(() => ({
      status: 200,
      body: {
        service: serviceEnvelope(),
        provider: "kimi",
        status: "unknown",
        limits: [],
        freshness: { ageMs: null, buckets: {}, stale: true, hardStale: true },
      },
    }));

    const capture = await captureQuota("launch", "kimi", {
      readQuota: coordinatorQuotaReader(service.socketPath),
      now: () => new Date(AT_LAUNCH),
    });

    expect(capture.outcome).toBe("unreadable");
    expect(capture.status).toBe("unknown");
    expect(capture.windows).toEqual([]);
  });

  it("records an unusable answer as a failed reading, never as an invented one", async () => {
    const service = await coordinator(() => ({
      status: 503,
      body: { code: "not_ready", message: "cold", retryable: true },
    }));

    const capture = await captureQuota("exit", "kimi", {
      readQuota: coordinatorQuotaReader(service.socketPath),
      now: () => new Date(AT_EXIT),
    });

    expect(capture.outcome).toBe("probe-failed");
    expect(capture.message).toContain("quota coordinator");
    expect(capture.windows).toEqual([]);
  });

  it("refuses a reading from a service speaking a different protocol major", async () => {
    const service = await coordinator(() => ({
      status: 200,
      body: {
        service: { ...serviceEnvelope(), protocolMajor: COORDINATOR_PROTOCOL_MAJOR + 1 },
        ...kimiSnapshot(AT_LAUNCH, 100, 46),
      },
    }));

    const capture = await captureQuota("launch", "kimi", {
      readQuota: coordinatorQuotaReader(service.socketPath),
      now: () => new Date(AT_LAUNCH),
    });

    // A window number read off an incompatible contract is worse than no number.
    expect(capture.outcome).toBe("probe-failed");
    expect(capture.windows).toEqual([]);
  });

  it("rejects a response whose provider does not match the requested provider", async () => {
    const service = await coordinator(() => ({
      status: 200,
      body: {
        service: serviceEnvelope(),
        provider: "claude",
        status: "available",
        scrapedAt: AT_LAUNCH,
        limits: [
          { label: "5h limit", kind: "five_hour", percentLeft: 100 },
          { label: "Weekly limit", kind: "weekly", percentLeft: 50 },
        ],
      },
    }));

    const capture = await captureQuota("launch", "kimi", {
      readQuota: coordinatorQuotaReader(service.socketPath),
      now: () => new Date(AT_LAUNCH),
    });

    expect(capture.outcome).toBe("probe-failed");
    expect(capture.message).toContain("quota coordinator");
    expect(capture.windows).toEqual([]);
  });

  it("rejects an available/exhausted response missing scrapedAt", async () => {
    const service = await coordinator(() => ({
      status: 200,
      body: {
        service: serviceEnvelope(),
        provider: "kimi",
        status: "available",
        limits: [
          { label: "5h limit", kind: "five_hour", percentLeft: 100 },
          { label: "Weekly limit", kind: "weekly", percentLeft: 50 },
        ],
      },
    }));

    const capture = await captureQuota("launch", "kimi", {
      readQuota: coordinatorQuotaReader(service.socketPath),
      now: () => new Date(AT_LAUNCH),
    });

    expect(capture.outcome).toBe("probe-failed");
    expect(capture.message).toContain("quota coordinator");
    expect(capture.windows).toEqual([]);
  });

  it("allows sparse unsupported responses as valid snapshots", async () => {
    const service = await coordinator(() => ({
      status: 200,
      body: {
        service: serviceEnvelope(),
        provider: "kimi",
        status: "unsupported",
      },
    }));

    const snapshot = await coordinatorQuotaReader(service.socketPath)("kimi");
    expect(snapshot.status).toBe("unsupported");
    expect(snapshot.provider).toBe("kimi");
  });

  it("bounds hangs with a request timeout and records failure rather than hanging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-ab-quota-hang-"));
    const socketPath = join(dir, "hang.sock");
    const server = http.createServer((_req, _res) => {
      // Intentionally do not reply — accept and hang
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    try {
      const client = new QuotaCoordinatorClient({
        socketPath,
        requestTimeoutMs: 100,
      });
      const reading = await client.getQuota("kimi");
      expect(reading).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("proves the harness path builds no QuotaService and opens no database", async () => {
    const service = await coordinator(() => ({
      status: 200,
      body: { service: serviceEnvelope(), ...kimiSnapshot(AT_LAUNCH, 100, 46) },
    }));

    const quotaSpy = vi.spyOn(quotaMcp, "createQuotaService").mockImplementation(() => {
      throw new Error("forbidden edge: createQuotaService called by harness");
    });
    const dbSpy = vi.spyOn(dbModule, "getRepositories").mockImplementation(() => {
      throw new Error("forbidden edge: getRepositories called by harness");
    });

    try {
      const outDir = mkdtempSync(join(tmpdir(), "rusa-ab-quota-spy-"));
      try {
        const recorder = new QuotaRecorder(coordinatorQuotaReader(service.socketPath));
        await recorder.start({ provider: "kimi", outDir });
        await recorder.finish();
        expect(quotaSpy).not.toHaveBeenCalled();
        expect(dbSpy).not.toHaveBeenCalled();
        expect(service.requested).toEqual(["/v1/quota?provider=kimi", "/v1/quota?provider=kimi"]);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    } finally {
      quotaSpy.mockRestore();
      dbSpy.mockRestore();
    }
  });
});

describe("both of the run's readings come from the service", () => {
  it("takes exactly two readings, both from the one injected source", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "rusa-ab-quota-out-"));
    const asked: string[] = [];
    const recorder = new QuotaRecorder(async (provider) => {
      asked.push(provider);
      return kimiSnapshot(asked.length === 1 ? AT_LAUNCH : AT_EXIT, 100, 46);
    });

    const launch = await recorder.start({ provider: "kimi", outDir });
    const evidence = await recorder.finish();

    expect(asked).toEqual(["kimi", "kimi"]);
    expect(launch.scrapedAt).toBe(AT_LAUNCH);
    expect(evidence?.launch?.scrapedAt).toBe(AT_LAUNCH);
    expect(evidence?.exit?.scrapedAt).toBe(AT_EXIT);

    const persisted = JSON.parse(readFileSync(join(outDir, "quota.json"), "utf8"));
    expect(persisted.exit.scrapedAt).toBe(AT_EXIT);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("surfaces observed scrape timestamps in the computed burn message", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "rusa-ab-quota-stamps-"));
    const asked: string[] = [];
    const recorder = new QuotaRecorder(async (provider) => {
      asked.push(provider);
      return kimiSnapshot(asked.length === 1 ? AT_LAUNCH : AT_EXIT, 100, 46);
    });

    await recorder.start({ provider: "kimi", outDir });
    const evidence = await recorder.finish();

    expect(evidence?.burn.computed).toBe(true);
    expect(evidence?.burn.message).toContain(`burn (observed ${AT_LAUNCH} → ${AT_EXIT})`);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("reports a run inside one service tick as NO MEASUREMENT, not as a zero delta", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "rusa-ab-quota-tick-"));
    // The run began and ended between two observations, so the service serves the same
    // reading twice — the equal-scrapedAt defence, kept intact against the new source.
    const recorder = new QuotaRecorder(async () => kimiSnapshot(AT_LAUNCH, 100, 46));

    await recorder.start({ provider: "kimi", outDir });
    const evidence = await recorder.finish();

    expect(evidence?.burn.computed).toBe(false);
    if (evidence?.burn.computed !== false) throw new Error("unreachable");
    expect(evidence.burn.reason).toContain("NO MEASUREMENT");
    expect(evidence.burn.reason).toContain(AT_LAUNCH);
    // Not a burn of zero: no window may carry a consumed number here.
    expect(evidence.burn.windows.every((w) => w.consumedPoints === null)).toBe(true);
    rmSync(outDir, { recursive: true, force: true });
  });
});

describe("resolveAbQuotaSocketPath", () => {
  it("falls back to default coordinator socket when base config is genuinely absent", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "rusa-ab-empty-"));
    try {
      const socket = resolveAbQuotaSocketPath({ baseConfigHome: emptyDir });
      expect(socket).toBe(defaultQuotaCoordinatorSocketPath());
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("fails loud when base config is present but malformed or invalid", () => {
    const brokenDir = mkdtempSync(join(tmpdir(), "rusa-ab-broken-"));
    try {
      writeFileSync(join(brokenDir, "config.yaml"), "invalid: [yaml: unclosed", "utf8");
      expect(() => resolveAbQuotaSocketPath({ baseConfigHome: brokenDir })).toThrow(
        /failed to load base config from/
      );
    } finally {
      rmSync(brokenDir, { recursive: true, force: true });
    }
  });

  it("resolves the socket configured in base config", () => {
    const configDir = mkdtempSync(join(tmpdir(), "rusa-ab-cfg-"));
    try {
      writeFileSync(
        join(configDir, "config.yaml"),
        "profile: quickstart\nproviders:\n  codex:\n    cliCommand: codex\nrootActor:\n  provider: codex\n  model: gpt-5.6-sol\nquota:\n  coordinator:\n    socketPath: /tmp/test-coordinator.sock\n",
        "utf8"
      );
      const socket = resolveAbQuotaSocketPath({ baseConfigHome: configDir });
      expect(socket).toBe("/tmp/test-coordinator.sock");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("honors RUSA_HOME when baseConfigHome is omitted", () => {
    const rusaHomeDir = mkdtempSync(join(tmpdir(), "rusa-home-"));
    const priorRusaHome = process.env.RUSA_HOME;
    try {
      process.env.RUSA_HOME = rusaHomeDir;
      writeFileSync(
        join(rusaHomeDir, "config.yaml"),
        "profile: quickstart\nproviders:\n  codex:\n    cliCommand: codex\nrootActor:\n  provider: codex\n  model: gpt-5.6-sol\nquota:\n  coordinator:\n    socketPath: /tmp/rusa-home.sock\n",
        "utf8"
      );
      const socket = resolveAbQuotaSocketPath({});
      expect(socket).toBe("/tmp/rusa-home.sock");
    } finally {
      if (priorRusaHome !== undefined) {
        process.env.RUSA_HOME = priorRusaHome;
      } else {
        delete process.env.RUSA_HOME;
      }
      rmSync(rusaHomeDir, { recursive: true, force: true });
    }
  });

  it("explicit quotaSocketPath override wins over base config", () => {
    const configDir = mkdtempSync(join(tmpdir(), "rusa-ab-override-"));
    try {
      writeFileSync(
        join(configDir, "config.yaml"),
        "profile: quickstart\nproviders:\n  codex:\n    cliCommand: codex\nrootActor:\n  provider: codex\n  model: gpt-5.6-sol\nquota:\n  coordinator:\n    socketPath: /tmp/base.sock\n",
        "utf8"
      );
      const socket = resolveAbQuotaSocketPath({
        baseConfigHome: configDir,
        quotaSocketPath: "/tmp/explicit.sock",
      });
      expect(socket).toBe("/tmp/explicit.sock");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
