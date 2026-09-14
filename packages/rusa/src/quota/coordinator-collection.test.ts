import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { type ProviderQuotaSnapshot, QuotaService } from "../mcp/quota-mcp.js";
import type { CodingProvider } from "../providers/types.js";
import { QuotaCollectionLoop } from "./coordinator-collection.js";
import { QuotaCoordinatorService } from "./coordinator-service.js";
import { SharedQuotaStore } from "./shared-store.js";

const mockGenerateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: (args: unknown) => mockGenerateContent(args) };
  },
  Type: {
    OBJECT: "OBJECT",
    STRING: "STRING",
    ARRAY: "ARRAY",
    BOOLEAN: "BOOLEAN",
    NUMBER: "NUMBER",
  },
}));

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storeWithReading(): SharedQuotaStore {
  const root = mkdtempSync(join(tmpdir(), "rusa-quota-collection-"));
  roots.push(root);
  const store = new SharedQuotaStore(join(root, "quota.db"));
  store.configureController({ maxIntervalSeconds: 3600 });
  const scrapedAt = "2030-01-01T00:00:00.000Z";
  const state: ProviderQuotaSnapshot = {
    provider: "claude",
    status: "available",
    scrapedAt,
    limits: [
      {
        label: "Weekly",
        kind: "weekly",
        percentLeft: 50,
        resetAtIso: "2030-01-08T00:00:00.000Z",
        scope: { provider: "claude" },
      },
    ],
  };
  const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "fixture" });
  store.recordParsed(id, state, state);
  return store;
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rusa-quota-collection-"));
  roots.push(root);
  return root;
}

function availableParse(resetAtIso: string) {
  return {
    text: () =>
      JSON.stringify({
        status: "available",
        windows: [
          {
            label: "Weekly",
            kind: "weekly",
            usedPercent: 50,
            resetAtIso,
          },
        ],
      }),
  };
}

function malformedParse() {
  return {
    text: () =>
      JSON.stringify({
        status: "available",
        windows: [{ label: "Weekly", kind: "weekly", usedPercent: "not-a-number" }],
      }),
  };
}

function configuredClaudeService(opts: {
  root: string;
  store: SharedQuotaStore;
  now: () => number;
  run: ReturnType<typeof vi.fn>;
  ttlMs?: number;
}): QuotaService {
  const provider: CodingProvider = {
    name: "claude",
    providerName: "claude",
    run: opts.run,
  } as unknown as CodingProvider;
  const config = {
    geminiApiKey: "test-gemini-key",
    providers: { claude: { cliCommand: "claude" } },
  } as unknown as RusaConfig;
  return new QuotaService({
    config,
    workersDir: join(opts.root, "workers"),
    resolveProvider: () => provider,
    scrapeStore: opts.store,
    now: opts.now,
    ttlMs: opts.ttlMs,
  });
}

function request(socketPath: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`expected 200 from ${path}, received ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function observationRows(store: SharedQuotaStore) {
  return store.db
    .prepare(
      `SELECT rowid, provider, kind, observed_at AS observedAt,
              percent_left AS percentLeft, reset_at_iso AS resetAtIso,
              processed, interval_seconds AS intervalSeconds
       FROM quota_observations ORDER BY rowid`
    )
    .all();
}

describe("QuotaCollectionLoop", () => {
  it("dedupes concurrent ticks to one service-owned probe and one controller advance", async () => {
    const store = storeWithReading();
    try {
      let resolveProbe: ((state: ProviderQuotaSnapshot) => void) | undefined;
      const getQuota = vi.fn(
        () =>
          new Promise<ProviderQuotaSnapshot>((resolve) => {
            resolveProbe = resolve;
          })
      );
      const advance = vi.spyOn(store, "advancePendingController");
      const loop = new QuotaCollectionLoop({
        store,
        quotaService: { getQuota, hydrate: vi.fn() } as unknown as QuotaService,
        providers: ["claude"],
      });

      const first = loop.tick();
      const second = loop.tick();
      expect(getQuota).toHaveBeenCalledTimes(1);
      resolveProbe?.({ provider: "claude", status: "available" });
      await Promise.all([first, second]);
      expect(getQuota).toHaveBeenCalledTimes(1);
      expect(advance).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("leaves the published interval unchanged and counts a failed probe", async () => {
    const store = storeWithReading();
    try {
      const before = store.getProviderThrottle("claude");
      const loop = new QuotaCollectionLoop({
        store,
        quotaService: {
          getQuota: vi.fn().mockResolvedValue({ provider: "claude", status: "unknown" }),
          hydrate: vi.fn(),
        } as unknown as QuotaService,
        providers: ["claude"],
      });

      await loop.tick();
      expect(store.getProviderThrottle("claude")).toEqual(before);
      expect(loop.getStats("claude")).toMatchObject({
        attempts: 1,
        failures: 1,
        lastOutcome: "failure",
      });
    } finally {
      store.close();
    }
  });

  it("hydrates the sole probe prevState from the latest validated snapshot", () => {
    const store = storeWithReading();
    try {
      const hydrate = vi.fn();
      const loop = new QuotaCollectionLoop({
        store,
        quotaService: { getQuota: vi.fn(), hydrate } as unknown as QuotaService,
        providers: ["claude"],
      });
      loop.hydrate();
      expect(hydrate).toHaveBeenCalledWith(
        "claude",
        expect.objectContaining({
          provider: "claude",
          limits: [expect.objectContaining({ scope: { provider: "claude" } })],
        })
      );
    } finally {
      store.close();
    }
  });

  it("criterion 1: two concurrent collection ticks after TTL expiry perform one real probe and one LLM parse", async () => {
    const root = makeRoot();
    const store = new SharedQuotaStore(join(root, "quota.db"));
    let nowMs = Date.parse("2040-01-01T00:01:00.000Z");
    const hydratedAt = new Date(nowMs - 2).toISOString();
    const hydratedState: ProviderQuotaSnapshot = {
      provider: "claude",
      status: "available",
      scrapedAt: hydratedAt,
      limits: [
        {
          label: "Weekly",
          kind: "weekly",
          percentLeft: 50,
          resetAtIso: "2040-01-08T00:00:00.000Z",
          scope: { provider: "claude" },
        },
      ],
    };
    const hydratedId = store.recordRaw({
      provider: "claude",
      scrapedAt: hydratedAt,
      rawOutput: "pre-restart fixture",
    });
    store.recordParsed(hydratedId, hydratedState, hydratedState);
    const run = vi.fn().mockResolvedValue({
      success: true,
      output: "synthetic Claude /usage panel",
      exitCode: 0,
    });
    mockGenerateContent.mockReset();
    mockGenerateContent.mockResolvedValue(availableParse("2040-01-08T00:00:00.000Z"));
    const quotaService = configuredClaudeService({
      root,
      store,
      now: () => nowMs,
      run,
      ttlMs: 1,
    });
    const loop = new QuotaCollectionLoop({
      store,
      quotaService,
      providers: ["claude"],
    });
    loop.hydrate();
    const socketPath = join(root, "coordinator.sock");
    const coordinator = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
      now: () => nowMs,
    });

    try {
      await coordinator.start();
      // Two read clients see the hydrated state. Collection is not request-driven:
      // only the service tick can consume the expired probe TTL.
      await Promise.all([
        request(socketPath, "/v1/quota?provider=claude"),
        request(socketPath, "/v1/quota?provider=claude"),
      ]);
      expect(run).not.toHaveBeenCalled();
      await Promise.all([loop.tick(), loop.tick()]);

      expect(run).toHaveBeenCalledTimes(1);
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(store.db.prepare("SELECT count(*) AS count FROM quota_scrapes").get()).toEqual({
        count: 2,
      });
      expect(observationRows(store)).toHaveLength(1);
      // Move beyond the probe TTL: the second concurrent tick pool must still
      // share one live probe rather than one probe per caller.
      nowMs += 2;
      await Promise.all([loop.tick(), loop.tick()]);
      expect(run).toHaveBeenCalledTimes(2);
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    } finally {
      await coordinator.stop();
      store.close();
    }
  });

  it("criterion 4: a real failed probe preserves the stored interval while its HTTP publication becomes stale", async () => {
    const root = makeRoot();
    const store = new SharedQuotaStore(join(root, "quota.db"));
    const nowMs = Date.parse("2040-01-01T00:20:00.000Z");
    const scrapedAt = new Date(nowMs - 20 * 60_000).toISOString();
    const seed: ProviderQuotaSnapshot = {
      provider: "claude",
      status: "available",
      scrapedAt,
      limits: [
        {
          label: "Weekly",
          kind: "weekly",
          percentLeft: 50,
          resetAtIso: "2040-01-08T00:00:00.000Z",
          scope: { provider: "claude" },
        },
      ],
    };
    const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "seed" });
    store.recordParsed(id, seed, seed);
    store.advancePendingController({ maxIntervalSeconds: 3600 });
    const before = store.getProviderThrottle("claude");
    const quotaService = configuredClaudeService({
      root,
      store,
      now: () => nowMs,
      run: vi.fn().mockRejectedValue(new Error("probe unavailable")),
      ttlMs: 1,
    });
    const loop = new QuotaCollectionLoop({
      store,
      quotaService,
      providers: ["claude"],
      maxIntervalSeconds: 3600,
    });
    loop.hydrate();
    const socketPath = join(root, "coordinator.sock");
    const coordinator = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
      maxIntervalSeconds: 3600,
      staleAfterMs: 1_000,
      hardStaleAfterMs: 60 * 60_000,
      now: () => nowMs,
    });

    try {
      await coordinator.start();
      await loop.tick();
      const published = (await request(socketPath, "/v1/throttle?provider=claude")) as {
        intervalSeconds: number;
        freshness: { stale: boolean; hardStale: boolean };
      };

      expect(store.getProviderThrottle("claude")).toEqual(before);
      expect(published.intervalSeconds).toBe(before?.intervalSeconds);
      expect(published.freshness).toMatchObject({ stale: true, hardStale: false });
      expect(loop.getStats("claude")).toMatchObject({ attempts: 1, failures: 1 });
    } finally {
      await coordinator.stop();
      store.close();
    }
  });

  it("criteria 11 and 13: carried-forward state survives restart without rewriting the observation", async () => {
    const root = makeRoot();
    const store = new SharedQuotaStore(join(root, "quota.db"));
    let nowMs = Date.parse("2040-01-01T00:00:00.000Z");
    const run = vi.fn().mockResolvedValue({
      success: true,
      output: "synthetic Claude /usage panel",
      exitCode: 0,
    });
    mockGenerateContent.mockReset();
    mockGenerateContent
      .mockResolvedValueOnce(availableParse("2040-01-08T00:00:00.000Z"))
      .mockResolvedValue(malformedParse());
    const quotaService = configuredClaudeService({
      root,
      store,
      now: () => nowMs,
      run,
      ttlMs: 1,
    });
    const firstLoop = new QuotaCollectionLoop({
      store,
      quotaService,
      providers: ["claude"],
      maxIntervalSeconds: 3600,
    });
    const firstSocketPath = join(root, "coordinator-first.sock");
    const firstCoordinator = new QuotaCoordinatorService({
      socketPath: firstSocketPath,
      store,
      configuredProviders: ["claude"],
      now: () => nowMs,
    });

    let secondCoordinator: QuotaCoordinatorService | undefined;
    try {
      await Promise.all([firstLoop.tick(), firstLoop.tick()]);
      nowMs += 2;
      await Promise.all([firstLoop.tick(), firstLoop.tick()]);

      expect(run).toHaveBeenCalledTimes(2);
      expect(observationRows(store)).toHaveLength(1);
      const carriedBeforeRestart = store.getLatestSnapshot("claude");
      expect(carriedBeforeRestart?.explanations).toEqual([
        expect.objectContaining({ rule: "carried_forward_bad_read" }),
      ]);

      await firstCoordinator.start();
      const preRestartPublication = await request(firstSocketPath, "/v1/quota?provider=claude");
      await firstCoordinator.stop();

      const secondService = configuredClaudeService({
        root,
        store,
        now: () => nowMs,
        run,
        ttlMs: 1,
      });
      const secondLoop = new QuotaCollectionLoop({
        store,
        quotaService: secondService,
        providers: ["claude"],
        maxIntervalSeconds: 3600,
      });
      secondLoop.hydrate();
      const secondSocketPath = join(root, "coordinator-second.sock");
      secondCoordinator = new QuotaCoordinatorService({
        socketPath: secondSocketPath,
        store,
        configuredProviders: ["claude"],
        now: () => nowMs,
      });
      await secondCoordinator.start();
      const firstPostRestartPublication = await request(
        secondSocketPath,
        "/v1/quota?provider=claude"
      );
      expect(firstPostRestartPublication).toEqual(preRestartPublication);

      const observationBeforeSecondBadRead = observationRows(store);
      const changesBeforeSecondBadRead = (
        store.db.prepare("SELECT total_changes() AS changes").get() as { changes: number }
      ).changes;
      nowMs += 2;
      await Promise.all([secondLoop.tick(), secondLoop.tick()]);
      expect(run).toHaveBeenCalledTimes(3);
      expect(observationRows(store)).toEqual(observationBeforeSecondBadRead);
      // The only writes are the fresh raw scrape and its parsed-state update;
      // an observation upsert would add a third change and violate criterion 13.
      expect(
        (store.db.prepare("SELECT total_changes() AS changes").get() as { changes: number })
          .changes - changesBeforeSecondBadRead
      ).toBe(2);
      expect(store.getLatestSnapshot("claude")?.explanations).toEqual([
        expect.objectContaining({ rule: "carried_forward_bad_read" }),
      ]);
    } finally {
      await secondCoordinator?.stop();
      await firstCoordinator.stop();
      store.close();
    }
  });
});
