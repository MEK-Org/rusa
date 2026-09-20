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
  it("suppresses automated collection for manual lanes, including Kimi", async () => {
    const root = makeRoot();
    const store = new SharedQuotaStore(join(root, "quota.db"));
    try {
      store.setQuotaReadingMode("kimi", "manual", "2030-01-01T00:00:00.000Z");
      const getQuotaProbeOutcome = vi.fn();
      const loop = new QuotaCollectionLoop({
        store,
        quotaService: { getQuotaProbeOutcome, hydrate: vi.fn() } as unknown as QuotaService,
        providers: ["kimi"],
      });

      await loop.tick();

      expect(getQuotaProbeOutcome).not.toHaveBeenCalled();
      expect(loop.getStats("kimi")).toMatchObject({ attempts: 0, failures: 0 });
      expect(store.db.prepare("SELECT count(*) AS n FROM quota_scrapes").get()).toEqual({ n: 0 });
    } finally {
      store.close();
    }
  });

  it("fences a scrape result that completes after a switch to manual", async () => {
    const root = makeRoot();
    const store = new SharedQuotaStore(join(root, "quota.db"));
    try {
      let releaseProbe: (() => void) | undefined;
      const getQuotaProbeOutcome = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseProbe = resolve;
        });
        const scrapedAt = "2030-01-01T00:05:00.000Z";
        const snapshot: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt,
          limits: [
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 80,
              resetAtIso: "2030-01-08T00:00:00.000Z",
              scope: { provider: "claude" },
            },
          ],
        };
        const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "late scrape" });
        store.recordParsed(id, snapshot, snapshot);
        return { state: snapshot, didProbe: true };
      });
      const loop = new QuotaCollectionLoop({
        store,
        quotaService: { getQuotaProbeOutcome, hydrate: vi.fn() } as unknown as QuotaService,
        providers: ["claude"],
      });

      const tick = loop.tick();
      await vi.waitFor(() => expect(getQuotaProbeOutcome).toHaveBeenCalledTimes(1));
      store.setQuotaReadingMode("claude", "manual", "2030-01-01T00:01:00.000Z");
      releaseProbe?.();
      await tick;

      expect(store.getLatestSnapshot("claude")).toBeNull();
      expect(store.db.prepare("SELECT count(*) AS n FROM quota_scrapes").get()).toEqual({ n: 0 });
      expect(store.db.prepare("SELECT count(*) AS n FROM quota_observations").get()).toEqual({
        n: 0,
      });
    } finally {
      store.close();
    }
  });

  it("discards a scrape that spans a manual reading even after the lane returns to scrape mode", async () => {
    const root = makeRoot();
    const store = new SharedQuotaStore(join(root, "quota.db"));
    try {
      let releaseProbe: (() => void) | undefined;
      const getQuotaProbeOutcome = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseProbe = resolve;
        });
        const scrapedAt = "2030-01-01T00:00:00.000Z";
        const snapshot: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt,
          limits: [
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 80,
              resetAtIso: "2030-01-08T00:00:00.000Z",
              scope: { provider: "claude" },
            },
          ],
        };
        const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "late scrape" });
        store.recordParsed(id, snapshot, snapshot);
        return { state: snapshot, didProbe: true };
      });
      const loop = new QuotaCollectionLoop({
        store,
        quotaService: { getQuotaProbeOutcome, hydrate: vi.fn() } as unknown as QuotaService,
        providers: ["claude"],
      });

      const tick = loop.tick();
      await vi.waitFor(() => expect(getQuotaProbeOutcome).toHaveBeenCalledTimes(1));
      const manual = store.setQuotaReadingMode("claude", "manual", "2030-01-01T00:01:00.000Z");
      const manualObservedAt = "2030-01-01T00:06:00.000Z";
      expect(
        store.recordManualObservation({
          snapshot: {
            provider: "claude",
            status: "available",
            scrapedAt: manualObservedAt,
            limits: [
              {
                label: "Weekly",
                kind: "weekly",
                percentLeft: 40,
                resetAtIso: "2030-01-08T00:00:00.000Z",
                scope: { provider: "claude" },
              },
            ],
          },
          generation: manual.generation,
          idempotencyKey: "during-probe",
          acceptedAt: manualObservedAt,
        })
      ).toMatchObject({ result: "accepted" });
      // Back in scrape mode before the old probe lands: a bare mode check would
      // admit it; the generation captured when the probe began does not.
      expect(store.setQuotaReadingMode("claude", "scrape", "2030-01-01T00:07:00.000Z")).toEqual({
        mode: "scrape",
        generation: 2,
        updatedAt: "2030-01-01T00:07:00.000Z",
      });
      releaseProbe?.();
      await tick;

      expect(store.getLatestSnapshot("claude")).toMatchObject({
        scrapedAt: manualObservedAt,
        limits: [expect.objectContaining({ percentLeft: 40 })],
      });
      expect(store.db.prepare("SELECT count(*) AS n FROM quota_scrapes").get()).toEqual({ n: 1 });
      expect(observationRows(store)).toEqual([
        expect.objectContaining({ observedAt: manualObservedAt, percentLeft: 40 }),
      ]);
    } finally {
      store.close();
    }
  });

  it("fences the real QuotaService persistence path and persists normally once scrape mode returns", async () => {
    const root = makeRoot();
    const store = new SharedQuotaStore(join(root, "quota.db"));
    let nowMs = Date.parse("2040-01-01T00:01:00.000Z");
    let releaseRun: (() => void) | undefined;
    const run = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      return { success: true, output: "synthetic Claude /usage panel", exitCode: 0 };
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
      maxIntervalSeconds: 3600,
    });
    try {
      // The lane goes manual while the CLI probe is still running: the probe's
      // own recordRaw/recordParsed calls inherit the stale permit and write
      // nothing, and the loop counts the attempt as a probe, not a failure.
      const firstTick = loop.tick();
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      store.setQuotaReadingMode("claude", "manual", new Date(nowMs).toISOString());
      releaseRun?.();
      await firstTick;
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(store.db.prepare("SELECT count(*) AS n FROM quota_scrapes").get()).toEqual({ n: 0 });
      expect(observationRows(store)).toEqual([]);
      expect(loop.getStats("claude")).toMatchObject({ attempts: 1, failures: 0 });

      // Manual lane: no probe at all.
      nowMs += 10_000;
      await loop.tick();
      expect(run).toHaveBeenCalledTimes(1);

      // Back to scrape under a new generation: the next probe persists as usual.
      nowMs += 10_000;
      store.setQuotaReadingMode("claude", "scrape", new Date(nowMs).toISOString());
      const thirdTick = loop.tick();
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      releaseRun?.();
      await thirdTick;
      expect(store.db.prepare("SELECT count(*) AS n FROM quota_scrapes").get()).toEqual({ n: 1 });
      expect(observationRows(store)).toEqual([
        expect.objectContaining({ provider: "claude", kind: "weekly", percentLeft: 50 }),
      ]);
      expect(store.getLatestSnapshot("claude")).toMatchObject({
        scrapedAt: new Date(nowMs).toISOString(),
      });
    } finally {
      store.close();
    }
  });

  it("dedupes concurrent ticks to one service-owned probe and one controller advance", async () => {
    const store = storeWithReading();
    try {
      let resolveProbe:
        | ((outcome: { state: ProviderQuotaSnapshot; didProbe: boolean }) => void)
        | undefined;
      const getQuotaProbeOutcome = vi.fn(
        () =>
          new Promise<{ state: ProviderQuotaSnapshot; didProbe: boolean }>((resolve) => {
            resolveProbe = resolve;
          })
      );
      const advance = vi.spyOn(store, "advancePendingController");
      const loop = new QuotaCollectionLoop({
        store,
        quotaService: { getQuotaProbeOutcome, hydrate: vi.fn() } as unknown as QuotaService,
        providers: ["claude"],
      });

      const first = loop.tick();
      const second = loop.tick();
      expect(getQuotaProbeOutcome).toHaveBeenCalledTimes(1);
      resolveProbe?.({ state: { provider: "claude", status: "available" }, didProbe: true });
      await Promise.all([first, second]);
      expect(getQuotaProbeOutcome).toHaveBeenCalledTimes(1);
      expect(advance).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("leaves the published interval unchanged and counts a real failed probe, not a cached unknown", async () => {
    const store = storeWithReading();
    try {
      const before = store.getProviderThrottle("claude");
      const loop = new QuotaCollectionLoop({
        store,
        quotaService: {
          getQuotaProbeOutcome: vi
            .fn()
            .mockResolvedValueOnce({
              state: { provider: "claude", status: "unknown" },
              didProbe: true,
            })
            .mockResolvedValue({
              state: { provider: "claude", status: "unknown" },
              didProbe: false,
            }),
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
      await loop.tick();
      expect(loop.getStats("claude")).toMatchObject({ attempts: 1, failures: 1 });
    } finally {
      store.close();
    }
  });

  it("hydrates the coordinator probe prevState from the latest validated snapshot", () => {
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
      expect(loop.getStats("claude")).toMatchObject({ attempts: 1, failures: 0 });
      // The coordinator cadence can be shorter than a provider TTL. A cache
      // hit returns the prior reading but must not inflate probe/failure stats.
      await loop.tick();
      expect(run).toHaveBeenCalledTimes(1);
      expect(loop.getStats("claude")).toMatchObject({ attempts: 1, failures: 0 });
      // Move beyond the probe TTL: the second concurrent tick pool must still
      // share one live probe rather than one probe per caller.
      nowMs += 2;
      await Promise.all([loop.tick(), loop.tick()]);
      expect(run).toHaveBeenCalledTimes(2);
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(loop.getStats("claude")).toMatchObject({ attempts: 2, failures: 0 });
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
    let firstStoreClosed = false;
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
    let restartedStore: SharedQuotaStore | undefined;
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

      // A process restart must rebuild the SQLite connection as well as the
      // service objects; otherwise same-connection caches can mask a missing
      // durable-state hydration path.
      store.close();
      firstStoreClosed = true;
      restartedStore = new SharedQuotaStore(join(root, "quota.db"));

      const secondService = configuredClaudeService({
        root,
        store: restartedStore,
        now: () => nowMs,
        run,
        ttlMs: 1,
      });
      const secondLoop = new QuotaCollectionLoop({
        store: restartedStore,
        quotaService: secondService,
        providers: ["claude"],
        maxIntervalSeconds: 3600,
      });
      secondLoop.hydrate();
      const secondSocketPath = join(root, "coordinator-second.sock");
      secondCoordinator = new QuotaCoordinatorService({
        socketPath: secondSocketPath,
        store: restartedStore,
        configuredProviders: ["claude"],
        now: () => nowMs,
      });
      await secondCoordinator.start();
      const firstPostRestartPublication = await request(
        secondSocketPath,
        "/v1/quota?provider=claude"
      );
      expect(firstPostRestartPublication).toEqual(preRestartPublication);

      const observationBeforeSecondBadRead = observationRows(restartedStore);
      const changesBeforeSecondBadRead = (
        restartedStore.db.prepare("SELECT total_changes() AS changes").get() as { changes: number }
      ).changes;
      nowMs += 2;
      await Promise.all([secondLoop.tick(), secondLoop.tick()]);
      expect(run).toHaveBeenCalledTimes(3);
      expect(observationRows(restartedStore)).toEqual(observationBeforeSecondBadRead);
      // The only writes are the fresh raw scrape and its parsed-state update;
      // an observation upsert would add a third change and violate criterion 13.
      expect(
        (
          restartedStore.db.prepare("SELECT total_changes() AS changes").get() as {
            changes: number;
          }
        ).changes - changesBeforeSecondBadRead
      ).toBe(2);
      expect(restartedStore.getLatestSnapshot("claude")?.explanations).toEqual([
        expect.objectContaining({ rule: "carried_forward_bad_read" }),
      ]);
    } finally {
      await secondCoordinator?.stop();
      await firstCoordinator.stop();
      restartedStore?.close();
      if (!firstStoreClosed) store.close();
    }
  });
});
