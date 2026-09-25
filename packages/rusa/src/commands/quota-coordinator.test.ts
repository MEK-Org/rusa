import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RusaConfig } from "../config/types.js";
import type { ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";
import { createLogger } from "../observability/logger.js";
import { QuotaCollectionLoop } from "../quota/coordinator-collection.js";
import { QUOTA_METRIC_EVENT, QUOTA_SERVICE_METRICS } from "../quota/coordinator-metrics.js";
import { QuotaCoordinatorService } from "../quota/coordinator-service.js";
import { DEFAULT_OLD_QUOTA_DB_NAME, DEFAULT_RELOCATED_QUOTA_DB_NAME } from "../quota/relocate.js";
import { SharedQuotaStore } from "../quota/shared-store.js";
import { coordinatorProviderLanes, runQuotaCoordinator } from "./quota-coordinator.js";

const testDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function request(socketPath: string, path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, json: JSON.parse(body) as unknown });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function seedQuotaSnapshot(databasePath: string): void {
  const store = new SharedQuotaStore(databasePath);
  try {
    const scrapedAt = new Date().toISOString();
    const state: ProviderQuotaSnapshot = {
      provider: "claude",
      status: "available",
      scrapedAt,
      limits: [
        {
          label: "Weekly",
          kind: "weekly",
          scope: "provider",
          percentLeft: 60,
          resetAtIso: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    };
    const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "seeded" });
    store.recordParsed(id, state, state);
    store.advancePendingController({ maxIntervalSeconds: 3600 });
  } finally {
    store.close();
  }
}

describe("coordinatorProviderLanes", () => {
  it("preserves configured read lanes while collecting only supported probes", () => {
    const config = {
      providers: {
        claude: { cliCommand: "claude" },
        experimental: { cliCommand: "experimental" },
      },
    } as unknown as RusaConfig;

    expect(coordinatorProviderLanes(config)).toEqual({
      configuredProviders: ["claude", "experimental"],
      collectionProviders: ["claude"],
    });
  });

  it("keeps the established all-provider default when no provider is configured", () => {
    expect(coordinatorProviderLanes({ providers: {} } as unknown as RusaConfig)).toEqual({
      configuredProviders: undefined,
      collectionProviders: ["claude", "codex", "agy", "kimi"],
    });
  });
});

describe("runQuotaCoordinator startup relocation", () => {
  it("requires the explicit stage-3 flag before relocating quota.db", async () => {
    const home = join(
      tmpdir(),
      `rusa-coord-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(join(home, "data"), { recursive: true });
    testDirs.push(home);

    const oldDbPath = join(home, "data", DEFAULT_OLD_QUOTA_DB_NAME);
    const newDbPath = join(home, "data", DEFAULT_RELOCATED_QUOTA_DB_NAME);

    // Create legacy database at old path
    const db = new Database(oldDbPath);
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY);");
    db.close();

    expect(existsSync(oldDbPath)).toBe(true);
    expect(statSync(oldDbPath).isFile()).toBe(true);

    // Write minimal config
    writeFileSync(
      join(home, "config.yaml"),
      `
github:
  account: mock-bot
rootActor:
  provider: claude
  model: claude-3-5-sonnet
providers:
  claude:
    cliCommand: claude
quota:
  databasePath: ${oldDbPath}
`
    );

    await expect(runQuotaCoordinator({ home })).rejects.toThrow(/pre-service database/);
    expect(statSync(oldDbPath).isFile()).toBe(true);
    expect(existsSync(newDbPath)).toBe(false);

    // A service-owned target is supplied only for the explicit flip.
    writeFileSync(
      join(home, "config.yaml"),
      `
github:
  account: mock-bot
rootActor:
  provider: claude
  model: claude-3-5-sonnet
providers:
  claude:
    cliCommand: claude
quota:
  databasePath: ${oldDbPath}
  coordinator:
    socketPath: ${join(home, "coordinator.sock")}
    databasePath: ${newDbPath}
`
    );

    // Intercept service startup to avoid running a listener while characterizing
    // the pre-flip path selection.
    vi.spyOn(QuotaCoordinatorService.prototype, "start").mockImplementation(async () => {
      throw new Error("test-abort-after-startup");
    });

    await expect(
      runQuotaCoordinator({
        home,
        relocate: true,
      })
    ).rejects.toThrow("test-abort-after-startup");

    // Relocation occurred:
    expect(existsSync(newDbPath)).toBe(true);
    expect(statSync(newDbPath).isFile()).toBe(true);
    expect(existsSync(oldDbPath)).toBe(true);
    expect(statSync(oldDbPath).isDirectory()).toBe(true);
  });

  it("fences the configured custom legacy path, never a quota.db sibling", async () => {
    const home = join(
      tmpdir(),
      `rusa-coord-relocate-flag-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(join(home, "data"), { recursive: true });
    testDirs.push(home);

    const oldDbPath = join(home, "data", "legacy-shared.sqlite");
    const newDbPath = join(home, "data", "custom-relocated.db");
    const unrelatedDefaultPath = join(home, "data", DEFAULT_OLD_QUOTA_DB_NAME);

    const db = new Database(oldDbPath);
    db.exec("CREATE TABLE custom (val TEXT);");
    db.close();

    writeFileSync(
      join(home, "config.yaml"),
      `
github:
  account: mock-bot
rootActor:
  provider: claude
  model: claude-3-5-sonnet
providers:
  claude:
    cliCommand: claude
quota:
  databasePath: ${oldDbPath}
  coordinator:
    socketPath: ${join(home, "coordinator.sock")}
    databasePath: ${newDbPath}
`
    );

    vi.spyOn(QuotaCoordinatorService.prototype, "start").mockImplementation(async () => {
      throw new Error("test-abort-flag");
    });

    await expect(
      runQuotaCoordinator({
        home,
        relocate: true,
      })
    ).rejects.toThrow("test-abort-flag");

    expect(existsSync(newDbPath)).toBe(true);
    expect(statSync(newDbPath).isFile()).toBe(true);
    expect(statSync(oldDbPath).isDirectory()).toBe(true);
    expect(existsSync(unrelatedDefaultPath)).toBe(false);
  });
});

describe("probe-off rollout mode", () => {
  it("starts the real read and operations service on seeded data without probes or controller writes", async () => {
    const home = join(
      tmpdir(),
      `rusa-coord-probe-off-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const databasePath = join(home, "data", "quota-coordinator.db");
    const socketPath = join(home, "coordinator.sock");
    const backupDir = join(home, "backups");
    mkdirSync(join(home, "data"), { recursive: true });
    testDirs.push(home);
    seedQuotaSnapshot(databasePath);
    writeFileSync(
      join(home, "config.yaml"),
      `
github:
  account: mock-bot
rootActor:
  provider: claude
  model: claude-3-5-sonnet
providers:
  claude:
    cliCommand: claude
quota:
  coordinator:
    socketPath: ${socketPath}
    databasePath: ${databasePath}
    backupDir: ${backupDir}
`
    );

    // Snapshot pre-startup seeded raw/parsed/controller rows directly from SQLite.
    const dbBefore = new Database(databasePath, { readonly: true });
    const scrapesBefore = dbBefore.prepare("SELECT * FROM quota_scrapes ORDER BY id").all();
    const observationsBefore = dbBefore
      .prepare("SELECT * FROM quota_observations ORDER BY provider, kind, observed_slot")
      .all();
    dbBefore.close();

    // A regression cannot reach a provider CLI during this test: the command
    // name is deliberately absent from this temporary PATH.
    vi.stubEnv("PATH", join(home, "empty-path"));
    const collectionStart = vi.spyOn(QuotaCollectionLoop.prototype, "start");
    const controllerAdvance = vi.spyOn(SharedQuotaStore.prototype, "advancePendingController");
    const recordRaw = vi.spyOn(SharedQuotaStore.prototype, "recordRaw");
    const recordParsed = vi.spyOn(SharedQuotaStore.prototype, "recordParsed");

    // Capture emitted quota metrics across the entire service run.
    const emittedMetrics: Array<{
      metric: string;
      type: string;
      value: number;
      [key: string]: unknown;
    }> = [];
    const testLogger = createLogger({ context: { component: "quota-coordinator" } });
    vi.spyOn(testLogger, "info").mockImplementation(
      (event: string, context?: Record<string, unknown>) => {
        if (event === QUOTA_METRIC_EVENT && context) {
          emittedMetrics.push(context as { metric: string; type: string; value: number });
        }
      }
    );

    const abortController = new AbortController();
    let ready: () => void;
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const runner = runQuotaCoordinator({
      home,
      probeOff: true,
      signal: abortController.signal,
      onReady: () => ready(),
      logger: testLogger,
    });

    await isReady;
    try {
      await expect(request(socketPath, "/v1/healthz")).resolves.toMatchObject({ status: 200 });
      await expect(request(socketPath, "/v1/readyz")).resolves.toMatchObject({ status: 200 });
      await expect(request(socketPath, "/v1/throttle?provider=claude")).resolves.toMatchObject({
        status: 200,
      });
      await expect(request(socketPath, "/v1/quota?provider=claude")).resolves.toMatchObject({
        status: 200,
        json: expect.objectContaining({ status: "available" }),
      });
      expect(readdirSync(backupDir).some((name) => /^quota-.*\.db$/.test(name))).toBe(true);

      // Verify zero probes or controller writes occurred
      expect(collectionStart).not.toHaveBeenCalled();
      expect(controllerAdvance).not.toHaveBeenCalled();
      expect(recordRaw).not.toHaveBeenCalled();
      expect(recordParsed).not.toHaveBeenCalled();

      // Verify durable seeded database content was not modified in any way
      const dbAfter = new Database(databasePath, { readonly: true });
      const scrapesAfter = dbAfter.prepare("SELECT * FROM quota_scrapes ORDER BY id").all();
      const observationsAfter = dbAfter
        .prepare("SELECT * FROM quota_observations ORDER BY provider, kind, observed_slot")
        .all();
      dbAfter.close();
      expect(scrapesAfter).toEqual(scrapesBefore);
      expect(observationsAfter).toEqual(observationsBefore);

      // Verify read metrics were emitted for each request
      const readMetrics = emittedMetrics.filter(
        (m) => m.metric === QUOTA_SERVICE_METRICS.readsTotal
      );
      expect(readMetrics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            metric: QUOTA_SERVICE_METRICS.readsTotal,
            path: "/v1/healthz",
            status: 200,
          }),
          expect.objectContaining({
            metric: QUOTA_SERVICE_METRICS.readsTotal,
            path: "/v1/readyz",
            status: 200,
          }),
          expect.objectContaining({
            metric: QUOTA_SERVICE_METRICS.readsTotal,
            path: "/v1/throttle",
            status: 200,
          }),
          expect.objectContaining({
            metric: QUOTA_SERVICE_METRICS.readsTotal,
            path: "/v1/quota",
            status: 200,
          }),
        ])
      );

      // Verify no scrape, parse, observation, or controller metrics were emitted
      const nonReadMetrics = emittedMetrics.filter(
        (m) => m.metric !== QUOTA_SERVICE_METRICS.readsTotal
      );
      expect(nonReadMetrics).toHaveLength(0);
    } finally {
      abortController.abort();
      await runner;
    }
  });

  it("keeps probe collection on when the switch is absent", async () => {
    const home = join(
      tmpdir(),
      `rusa-coord-probe-on-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const databasePath = join(home, "data", "quota-coordinator.db");
    mkdirSync(join(home, "data"), { recursive: true });
    testDirs.push(home);
    seedQuotaSnapshot(databasePath);
    writeFileSync(
      join(home, "config.yaml"),
      `
github:
  account: mock-bot
rootActor:
  provider: claude
  model: claude-3-5-sonnet
providers:
  claude:
    cliCommand: claude
quota:
  coordinator:
    socketPath: ${join(home, "coordinator.sock")}
    databasePath: ${databasePath}
`
    );

    vi.stubEnv("RUSA_QUOTA_COORDINATOR_PROBE_OFF", "0");
    const collectionStart = vi
      .spyOn(QuotaCollectionLoop.prototype, "start")
      .mockImplementation(() => {});
    const abortController = new AbortController();
    let ready: () => void;
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const runner = runQuotaCoordinator({
      home,
      signal: abortController.signal,
      onReady: () => ready(),
    });

    await isReady;
    try {
      expect(collectionStart).toHaveBeenCalledOnce();
    } finally {
      abortController.abort();
      await runner;
    }
  });

  it("disables probe collection from the operator drop-in environment variable alone", async () => {
    const home = join(
      tmpdir(),
      `rusa-coord-probe-off-env-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const databasePath = join(home, "data", "quota-coordinator.db");
    mkdirSync(join(home, "data"), { recursive: true });
    testDirs.push(home);
    seedQuotaSnapshot(databasePath);
    writeFileSync(
      join(home, "config.yaml"),
      `
github:
  account: mock-bot
rootActor:
  provider: claude
  model: claude-3-5-sonnet
providers:
  claude:
    cliCommand: claude
quota:
  coordinator:
    socketPath: ${join(home, "coordinator.sock")}
    databasePath: ${databasePath}
`
    );

    // The runbook's control is the drop-in variable, not the flag: exercise it
    // with no `probeOff` option, so a wrong name or accepted value here fails
    // here rather than as a healthy-looking process that probes in production.
    vi.stubEnv("RUSA_QUOTA_COORDINATOR_PROBE_OFF", "1");
    const collectionStart = vi
      .spyOn(QuotaCollectionLoop.prototype, "start")
      .mockImplementation(() => {});
    const abortController = new AbortController();
    let ready: () => void;
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const runner = runQuotaCoordinator({
      home,
      signal: abortController.signal,
      onReady: () => ready(),
    });

    await isReady;
    try {
      expect(collectionStart).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      await runner;
    }
  });
});

describe("freshness thresholds (#690)", () => {
  it("keeps manual thresholds independent of the scrape ones the command always passes", async () => {
    const home = join(
      tmpdir(),
      `rusa-coord-freshness-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(join(home, "data"), { recursive: true });
    testDirs.push(home);
    writeFileSync(
      join(home, "config.yaml"),
      `
github:
  account: mock-bot
rootActor:
  provider: claude
  model: claude-3-5-sonnet
providers:
  claude:
    cliCommand: claude
quota:
  throttle:
    tickSeconds: 300
    manualHardStaleSeconds: 5400
  coordinator:
    socketPath: ${join(home, "coordinator.sock")}
    databasePath: ${join(home, "data", "quota-coordinator.db")}
`
    );

    let captured: QuotaCoordinatorService["options"] | undefined;
    vi.spyOn(QuotaCoordinatorService.prototype, "start").mockImplementation(async function (
      this: QuotaCoordinatorService
    ) {
      captured = this.options;
      throw new Error("test-abort-freshness");
    });

    await expect(runQuotaCoordinator({ home, probeOff: true })).rejects.toThrow(
      "test-abort-freshness"
    );

    // Scrape soft stale is anchored to the 30m probe TTL, and the manual
    // override reaches the service without the scrape value shadowing it.
    expect(captured).toMatchObject({
      staleAfterMs: 45 * 60_000,
      manualHardStaleAfterMs: 5_400_000,
    });
    expect(captured?.hardStaleAfterMs).toBeUndefined();
  });
});
