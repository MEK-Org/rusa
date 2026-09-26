import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaSnapshot, QuotaService, QuotaWindowKind } from "../mcp/quota-mcp.js";
import { QuotaCoordinatorClient } from "./coordinator-client.js";
import { QuotaCollectionLoop } from "./coordinator-collection.js";
import { QuotaCoordinatorService } from "./coordinator-service.js";
import {
  actuatorSlewForElapsedSeconds,
  actuatorSmoothingForElapsedSeconds,
  QUOTA_ACTUATOR_MAX_ELAPSED_SECONDS,
  QUOTA_ACTUATOR_REFERENCE_STEP_SECONDS,
  QUOTA_ACTUATOR_SMOOTHING,
  QUOTA_DERIVATIVE_TAU_SECONDS,
  QUOTA_INTEGRAL_MAX_STEP_SECONDS,
  QUOTA_INTEGRAL_TIME_SECONDS,
  QUOTA_KD_SECONDS_SQUARED_PER_POINT,
  QUOTA_KI_SECONDS_PER_POINT_SECOND,
  QUOTA_KP_SECONDS_PER_POINT,
  QUOTA_MAX_SCALED_SLEW_SECONDS,
  QUOTA_OBSERVATION_RETENTION_MS,
  QUOTA_RAW_RETENTION_MS,
  QUOTA_SCHEMA_VERSION,
  SharedQuotaStore,
} from "./shared-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function recordObservation(
  store: SharedQuotaStore,
  provider: string,
  scrapedAt: string,
  percentLeft: number,
  resetAtIso: string,
  kind: QuotaWindowKind = "weekly",
  label = `${kind} limit`
): void {
  const state: ProviderQuotaSnapshot = {
    provider,
    status: percentLeft <= 0 ? "exhausted" : "available",
    scrapedAt,
    limits: [
      {
        label,
        kind,
        scope: "provider",
        percentLeft,
        resetAtIso,
      },
    ],
  };
  const id = store.recordRaw({ provider, scrapedAt, rawOutput: "raw" });
  store.recordParsed(id, state, state);
}

describe("SharedQuotaStore schema v2 migration", () => {
  it("creates the mode and receipt tables in a fresh coordinator database", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-quota-schema-fresh-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "quota.db"));
    try {
      expect(store.db.pragma("user_version", { simple: true })).toBe(QUOTA_SCHEMA_VERSION);
      expect(
        (
          store.db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all() as Array<{ name: string }>
        ).map((row) => row.name)
      ).toEqual([
        "quota_manual_observation_receipts",
        "quota_observations",
        "quota_provider_reading_modes",
        "quota_scrapes",
      ]);
    } finally {
      store.close();
    }
  });

  it("upgrades a user_version 1 coordinator database without copying existing quota rows", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-quota-schema-v1-"));
    roots.push(root);
    const path = join(root, "quota.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE quota_scrapes (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, scraped_at TEXT NOT NULL,
        raw_output TEXT NOT NULL, parsed_state TEXT, parse_error TEXT
      );
      CREATE TABLE quota_observations (
        provider TEXT NOT NULL, kind TEXT NOT NULL, observed_slot INTEGER NOT NULL,
        label TEXT NOT NULL, observed_at TEXT NOT NULL, percent_left REAL NOT NULL,
        reset_at_iso TEXT, window_ms INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
        controller_error REAL, controller_derivative REAL, uncapped_interval_seconds REAL,
        interval_seconds REAL, PRIMARY KEY(provider, kind, observed_slot)
      );
    `);
    legacy
      .prepare(
        `INSERT INTO quota_observations
          (provider, kind, observed_slot, label, observed_at, percent_left, window_ms)
         VALUES ('claude', 'weekly', 1, 'Weekly', '2030-01-01T00:00:00.000Z', 50, 604800000)`
      )
      .run();
    legacy.pragma("user_version = 1");
    legacy.close();

    const store = new SharedQuotaStore(path);
    try {
      expect(store.db.pragma("user_version", { simple: true })).toBe(QUOTA_SCHEMA_VERSION);
      expect(
        store.db
          .prepare("SELECT provider, percent_left AS percentLeft FROM quota_observations")
          .all()
      ).toEqual([{ provider: "claude", percentLeft: 50 }]);
      expect(
        (
          store.db.prepare("PRAGMA table_info(quota_manual_observation_receipts)").all() as Array<{
            name: string;
          }>
        ).map((column) => column.name)
      ).toEqual([
        "provider",
        "idempotency_key",
        "generation",
        "request_fingerprint",
        "observed_at",
        "accepted_at",
      ]);
      expect(
        (
          store.db.prepare("PRAGMA table_info(quota_provider_reading_modes)").all() as Array<{
            name: string;
          }>
        ).map((column) => column.name)
      ).toEqual(["provider", "mode", "generation", "updated_at"]);
    } finally {
      store.close();
    }
  });
});

describe("SharedQuotaStore canonical observations", () => {
  it("stores a manual reading as ordinary evidence with a fingerprint-only receipt that ages out with raw retention", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-manual-receipt-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      const mode = store.setQuotaReadingMode("claude", "manual", "2030-01-01T00:00:00.000Z");
      const snapshot = (percentLeft: number) => ({
        provider: "claude" as const,
        status: "available" as const,
        scrapedAt: "2030-01-01T00:05:00.000Z",
        limits: [
          {
            label: "Weekly",
            kind: "weekly" as const,
            scope: "provider" as const,
            percentLeft,
            resetAtIso: "2030-01-08T00:00:00.000Z",
          },
        ],
      });
      const submit = (percentLeft: number, key = "reading-1") =>
        store.recordManualObservation({
          snapshot: snapshot(percentLeft),
          generation: mode.generation,
          idempotencyKey: key,
          acceptedAt: "2030-01-01T00:05:30.000Z",
        });

      expect(submit(25)).toEqual({
        result: "accepted",
        observedAt: "2030-01-01T00:05:00.000Z",
        generation: 1,
      });

      // The reading is one quota_scrapes row like any scrape (#572 precedent),
      // so latest/history/hydration/pruning need no manual-specific branch.
      const scrape = store.db
        .prepare("SELECT provider, scraped_at, raw_output FROM quota_scrapes")
        .all() as Array<{ provider: string; scraped_at: string; raw_output: string }>;
      expect(scrape).toEqual([
        {
          provider: "claude",
          scraped_at: "2030-01-01T00:05:00.000Z",
          raw_output: JSON.stringify({
            generation: 1,
            idempotencyKey: "reading-1",
            source: "manual",
            version: 1,
          }),
        },
      ]);
      expect(store.getLatestSnapshot("claude")).toMatchObject({
        scrapedAt: "2030-01-01T00:05:00.000Z",
        limits: [expect.objectContaining({ percentLeft: 25 })],
      });

      // The receipt carries only a sha256 fingerprint of the request, never the body.
      const receipts = store.db
        .prepare(
          "SELECT provider, idempotency_key, generation, request_fingerprint, observed_at, accepted_at FROM quota_manual_observation_receipts"
        )
        .all() as Array<Record<string, unknown>>;
      expect(receipts).toEqual([
        {
          provider: "claude",
          idempotency_key: "reading-1",
          generation: 1,
          request_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          observed_at: "2030-01-01T00:05:00.000Z",
          accepted_at: "2030-01-01T00:05:30.000Z",
        },
      ]);
      expect(receipts[0]?.request_fingerprint).not.toContain("25");

      // Same key + same body replays; same key + different body conflicts.
      expect(submit(25)).toEqual({
        result: "duplicate",
        observedAt: "2030-01-01T00:05:00.000Z",
        generation: 1,
      });
      expect(submit(30)).toEqual({ result: "idempotency_conflict" });
      expect(store.db.prepare("SELECT count(*) AS n FROM quota_scrapes").get()).toEqual({ n: 1 });

      // Receipts share the 30-day raw-evidence retention. A retry after that
      // window is still refused: it is older than the latest accepted reading.
      const later = Date.parse("2030-01-01T00:05:30.000Z") + QUOTA_RAW_RETENTION_MS + 1;
      expect(store.pruneRawScrapes(later)).toBe(2);
      expect(
        store.db.prepare("SELECT count(*) AS n FROM quota_manual_observation_receipts").get()
      ).toEqual({ n: 0 });
      expect(submit(25)).toEqual({ result: "stale_observation" });
    } finally {
      store.close();
    }
  });

  it("rejects direct manual observation with invalid percentLeft with a truthful error", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-manual-invalid-percent-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      const mode = store.setQuotaReadingMode("claude", "manual", "2030-01-01T00:00:00.000Z");
      expect(() =>
        store.recordManualObservation({
          snapshot: {
            provider: "claude",
            status: "available",
            scrapedAt: "2030-01-01T00:05:00.000Z",
            limits: [
              {
                label: "Weekly",
                kind: "weekly",
                percentLeft: 120,
                resetAtIso: "2030-01-08T00:00:00.000Z",
                scope: "provider",
              },
            ],
          },
          generation: mode.generation,
          idempotencyKey: "bad-percent-high",
          acceptedAt: "2030-01-01T00:05:30.000Z",
        })
      ).toThrow("manual observation percentLeft must be between 0 and 100");

      expect(() =>
        store.recordManualObservation({
          snapshot: {
            provider: "claude",
            status: "available",
            scrapedAt: "2030-01-01T00:05:00.000Z",
            limits: [
              {
                label: "Weekly",
                kind: "weekly",
                percentLeft: -5,
                resetAtIso: "2030-01-08T00:00:00.000Z",
                scope: "provider",
              },
            ],
          },
          generation: mode.generation,
          idempotencyKey: "bad-percent-neg",
          acceptedAt: "2030-01-01T00:05:30.000Z",
        })
      ).toThrow("manual observation percentLeft must be between 0 and 100");

      expect(() =>
        store.recordManualObservation({
          snapshot: {
            provider: "claude",
            status: "available",
            scrapedAt: "2030-01-01T00:05:00.000Z",
            limits: [
              {
                label: "Weekly",
                kind: "weekly",
                percentLeft: Number.NaN,
                resetAtIso: "2030-01-08T00:00:00.000Z",
                scope: "provider",
              },
            ],
          },
          generation: mode.generation,
          idempotencyKey: "bad-percent-nan",
          acceptedAt: "2030-01-01T00:05:30.000Z",
        })
      ).toThrow("manual observation percentLeft must be between 0 and 100");
    } finally {
      store.close();
    }
  });

  it("hydrates a validated legacy bare parsed_state without a schema migration", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-legacy-state-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      const scrapedAt = "2030-01-01T00:00:00.000Z";
      const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "raw" });
      store.db.prepare("UPDATE quota_scrapes SET parsed_state = ? WHERE id = ?").run(
        JSON.stringify({
          provider: "claude",
          status: "available",
          scrapedAt,
          limits: [
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 80,
              resetAtIso: "2030-01-08T00:00:00.000Z",
              scope: "provider",
            },
          ],
        }),
        id
      );

      expect(store.getLatestSnapshot("claude")).toMatchObject({
        provider: "claude",
        limits: [expect.objectContaining({ scope: { provider: "claude" } })],
      });
    } finally {
      store.close();
    }
  });

  it("uses the compact schema and prunes raw scrape payloads after 30 days", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-retention-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    const now = Date.now();
    try {
      const expiredId = store.recordRaw({
        provider: "claude",
        scrapedAt: new Date(now - QUOTA_RAW_RETENTION_MS - 1).toISOString(),
        rawOutput: "expired raw PTY output",
      });
      const expiredState: ProviderQuotaSnapshot = {
        provider: "claude",
        status: "available",
        scrapedAt: new Date(now - QUOTA_RAW_RETENTION_MS - 1).toISOString(),
        limits: [
          {
            label: "Weekly",
            kind: "weekly",
            scope: "provider",
            percentLeft: 50,
            resetAtIso: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
      };
      store.recordParsed(expiredId, expiredState, expiredState);
      const currentId = store.recordRaw({
        provider: "claude",
        scrapedAt: new Date(now).toISOString(),
        rawOutput: "current raw PTY output",
      });
      const currentState: ProviderQuotaSnapshot = {
        provider: "claude",
        status: "available",
        scrapedAt: new Date(now).toISOString(),
        limits: [
          {
            label: "Weekly",
            kind: "weekly",
            scope: "provider",
            percentLeft: 60,
            resetAtIso: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
      };
      store.recordParsed(currentId, currentState, currentState);
      expect(
        (store.db.prepare("SELECT count(*) AS n FROM quota_scrapes").get() as { n: number }).n
      ).toBe(1);
      expect(store.listCanonicalSince("claude", "2000-01-01T00:00:00.000Z")).toMatchObject([
        { label: "Weekly", percentLeft: 60 },
      ]);
      expect(
        (store.db.prepare("PRAGMA table_info(quota_scrapes)").all() as Array<{ name: string }>).map(
          (column) => column.name
        )
      ).not.toContain("inferred_parsed_state");
      expect(
        (store.db.prepare("PRAGMA table_info(quota_scrapes)").all() as Array<{ name: string }>).map(
          (column) => column.name
        )
      ).not.toContain("source_instance");
      expect(
        (
          store.db.prepare("PRAGMA table_info(quota_observations)").all() as Array<{ name: string }>
        ).map((column) => column.name)
      ).not.toContain("source_instance");
      expect(
        (
          store.db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all() as Array<{ name: string }>
        ).map((row) => row.name)
      ).toEqual([
        "quota_manual_observation_receipts",
        "quota_observations",
        "quota_provider_reading_modes",
        "quota_scrapes",
      ]);
    } finally {
      store.close();
    }
  });

  it("repairs legacy missing scopes without splitting keys by model labels", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-legacy-scope-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    const state: ProviderQuotaSnapshot = {
      provider: "claude",
      status: "available",
      limits: [
        {
          label: "Current week (all models)",
          kind: "weekly",
          percentLeft: 80,
          resetAtIso: "2030-01-08T00:00:00.000Z",
        },
        {
          label: "Current week (Fable)",
          kind: "weekly",
          percentLeft: 90,
          resetAtIso: "2030-01-08T00:00:00.000Z",
        },
      ],
    };
    try {
      const id = store.recordRaw({
        provider: "claude",
        scrapedAt: "2030-01-01T00:00:00.000Z",
        rawOutput: "raw",
      });
      store.recordParsed(id, state, state);
      expect(store.listCanonicalSince("claude", "2029-01-01T00:00:00.000Z")).toMatchObject([
        { label: "Current week (all models)", percentLeft: 80 },
      ]);
    } finally {
      store.close();
    }
  });
});

describe("SharedQuotaStore persisted controller", () => {
  it("keeps exhaustion out of throttle decisions and resumes from the prior period", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-controller-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 3600 });
      recordObservation(
        store,
        "claude",
        "2030-01-01T00:00:00.000Z",
        50,
        "2030-01-08T00:00:00.000Z"
      );
      recordObservation(
        store,
        "claude",
        "2030-01-01T01:00:00.000Z",
        100,
        "2030-01-08T00:00:00.000Z"
      );
      const beforeExhaustion = store.getProviderThrottle("claude");
      expect(beforeExhaustion?.intervalSeconds).toBeGreaterThan(0);

      recordObservation(store, "claude", "2030-01-07T23:00:00.000Z", 0, "2030-01-08T00:00:00.000Z");
      const exhausted = store.getProviderThrottle("claude");
      expect(exhausted?.intervalSeconds).toBe(beforeExhaustion?.intervalSeconds);
      expect(store.getExhaustedUntil("claude", Date.parse("2030-01-07T23:30:00.000Z"))).toBe(
        "2030-01-08T00:00:00.000Z"
      );
      expect(
        (
          store.db
            .prepare("SELECT count(*) n FROM quota_observations WHERE interval_seconds IS NOT NULL")
            .get() as { n: number }
        ).n
      ).toBe(2);

      recordObservation(
        store,
        "claude",
        "2030-01-08T00:05:00.000Z",
        100,
        "2030-01-15T00:00:00.000Z"
      );
      const rolledOver = store.getProviderThrottle("claude");
      expect(rolledOver?.intervalSeconds).toBeGreaterThan(0);
      expect(rolledOver?.intervalSeconds).toBeLessThan(beforeExhaustion?.intervalSeconds ?? 0);
      const decisions = store.listHistorySince("claude", "2030-01-01T00:00:00.000Z");
      expect(decisions.find((point) => point.percentLeft === 0)?.intervalSeconds).toBeNull();
    } finally {
      store.close();
    }
  });

  it("shares learned controller state across connections without storing launch timing", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-connections-"));
    roots.push(root);
    const path = join(root, "shared.db");
    const first = new SharedQuotaStore(path);
    const second = new SharedQuotaStore(path);
    try {
      first.configureController({ maxIntervalSeconds: 3600 });
      recordObservation(first, "agy", "2030-01-01T00:00:00.000Z", 50, "2030-01-08T00:00:00.000Z");
      expect(second.getProviderThrottle("agy")?.intervalSeconds).toBeGreaterThan(0);
      expect(
        (
          first.db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all() as Array<{ name: string }>
        ).map((row) => row.name)
      ).toEqual([
        "quota_manual_observation_receipts",
        "quota_observations",
        "quota_provider_reading_modes",
        "quota_scrapes",
      ]);
    } finally {
      second.close();
      first.close();
    }
  });
});

describe("SharedQuotaStore retention and indexing", () => {
  it("prunes observations older than 30 days while protecting the latest reasoned row per (provider, kind)", () => {
    expect(QUOTA_OBSERVATION_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-pruning-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    const baseTime = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    try {
      store.configureController({ maxIntervalSeconds: 3600 });

      // Claude weekly: 3 reasoned observations (10d, 5d, 2d ago relative to baseTime)
      recordObservation(
        store,
        "claude",
        new Date(baseTime - 10 * dayMs).toISOString(),
        70,
        new Date(baseTime - 3 * dayMs).toISOString(),
        "weekly"
      );
      recordObservation(
        store,
        "claude",
        new Date(baseTime - 5 * dayMs).toISOString(),
        60,
        new Date(baseTime + 2 * dayMs).toISOString(),
        "weekly"
      );
      recordObservation(
        store,
        "claude",
        new Date(baseTime - 2 * dayMs).toISOString(),
        50,
        new Date(baseTime + 5 * dayMs).toISOString(),
        "weekly"
      );

      // Claude five_hour: 2 non-reasoned observations (10d, 5d ago relative to baseTime, percentLeft <= 0 produces no reasoned row)
      recordObservation(
        store,
        "claude",
        new Date(baseTime - 10 * dayMs).toISOString(),
        0,
        new Date(baseTime - 10 * dayMs + 5 * 3600 * 1000).toISOString(),
        "five_hour"
      );
      recordObservation(
        store,
        "claude",
        new Date(baseTime - 5 * dayMs).toISOString(),
        0,
        new Date(baseTime - 5 * dayMs + 5 * 3600 * 1000).toISOString(),
        "five_hour"
      );

      // Codex weekly: 1 older observation (5d ago) + 1 current observation at evalTime (baseTime + 30d)
      recordObservation(
        store,
        "codex",
        new Date(baseTime - 5 * dayMs).toISOString(),
        80,
        new Date(baseTime + 2 * dayMs).toISOString(),
        "weekly"
      );
      recordObservation(
        store,
        "codex",
        new Date(baseTime + 30 * dayMs).toISOString(),
        60,
        new Date(baseTime + 37 * dayMs).toISOString(),
        "weekly"
      );

      // Verify initial observation counts
      const beforeObservations = store.db
        .prepare("SELECT count(*) AS n FROM quota_observations")
        .get() as { n: number };
      expect(beforeObservations.n).toBe(7);

      // Prune observations at evaluation time (baseTime + 30 days) -> cutoff is baseTime
      const evalTime = baseTime + 30 * dayMs;
      const deleted = store.pruneObservations(evalTime);
      expect(deleted).toBe(5); // 2 claude:weekly older + 2 claude:five_hour unreasoned + 1 codex:weekly older = 5 deleted

      const surviving = store.db
        .prepare(
          "SELECT provider, kind, observed_at AS observedAt, interval_seconds AS intervalSeconds FROM quota_observations ORDER BY observed_at ASC"
        )
        .all() as Array<{
        provider: string;
        kind: string;
        observedAt: string;
        intervalSeconds: number | null;
      }>;

      expect(surviving).toHaveLength(2);
      // Claude weekly latest reasoned row survived as controller memory despite being older than cutoff
      expect(surviving[0]).toMatchObject({
        provider: "claude",
        kind: "weekly",
        observedAt: new Date(baseTime - 2 * dayMs).toISOString(),
      });
      expect(surviving[0]?.intervalSeconds).toBeGreaterThan(0);

      // Codex weekly current observation survived
      expect(surviving[1]).toMatchObject({
        provider: "codex",
        kind: "weekly",
        observedAt: new Date(baseTime + 30 * dayMs).toISOString(),
      });

      // Surviving claude controller memory allows continuing controller iterations
      const claudeThrottle = store.getProviderThrottle("claude");
      expect(claudeThrottle?.intervalSeconds).toBeGreaterThan(0);
      expect(claudeThrottle?.governingBucketKey).toBe("claude:weekly");

      // Adding a fresh observation at `evalTime` computes derivative against the preserved controller memory
      recordObservation(
        store,
        "claude",
        new Date(evalTime).toISOString(),
        40,
        new Date(evalTime + 7 * dayMs).toISOString(),
        "weekly"
      );
      const freshClaudeThrottle = store.getProviderThrottle("claude");
      expect(freshClaudeThrottle?.intervalSeconds).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("creates covering index and partial reasoned index for fast throttle and exhaustion lookups", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-indices-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      const indices = (
        store.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map((row) => row.name);

      expect(indices).toContain("idx_quota_observations_provider_kind_time");
      expect(indices).toContain("idx_quota_observations_reasoned");
      expect(indices).toContain("idx_quota_observations_observed_at");
      expect(indices).toContain("idx_shared_quota_scrapes_time");

      store.configureController({ maxIntervalSeconds: 3600 });
      const now = Date.parse("2026-08-25T12:00:00.000Z");
      for (let i = 0; i < 20; i++) {
        recordObservation(
          store,
          "claude",
          new Date(now + i * 300000).toISOString(),
          80 - i,
          new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString()
        );
      }

      // Query plan for observation prune deletion
      const prunePlan = store.db
        .prepare(
          `EXPLAIN QUERY PLAN
           DELETE FROM quota_observations
           WHERE observed_at < ?`
        )
        .all("2026-07-25T00:00:00.000Z") as Array<{ detail: string }>;

      expect(
        prunePlan.some((step) => step.detail.includes("idx_quota_observations_observed_at"))
      ).toBe(true);

      // Query plan for previous reasoned lookup
      const previousPlan = store.db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT interval_seconds, controller_error, controller_derivative, observed_at, reset_at_iso
           FROM quota_observations
           WHERE provider = ? AND kind = ? AND interval_seconds IS NOT NULL
           ORDER BY observed_at DESC LIMIT 1`
        )
        .all("claude", "weekly") as Array<{ detail: string }>;

      expect(
        previousPlan.some((step) => step.detail.includes("idx_quota_observations_reasoned"))
      ).toBe(true);

      // Query plan for current observations in getProviderThrottle
      const currentPlan = store.db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT kind, label, reset_at_iso, percent_left, observed_at
           FROM quota_observations o
           WHERE provider = ?
             AND NOT EXISTS (
               SELECT 1 FROM quota_observations newer
               WHERE newer.provider = o.provider AND newer.kind = o.kind
                 AND (newer.observed_at > o.observed_at OR
                      (newer.observed_at = o.observed_at AND newer.rowid > o.rowid))
             )`
        )
        .all("claude") as Array<{ detail: string }>;

      expect(
        currentPlan.some((step) =>
          step.detail.includes("idx_quota_observations_provider_kind_time")
        )
      ).toBe(true);
    } finally {
      store.close();
    }
  });
});

interface ReasonedRow {
  observedAt: string;
  error: number;
  integral: number;
  derivative: number;
  uncapped: number;
  interval: number;
}

function reasonedRows(store: SharedQuotaStore, provider: string, kind = "weekly"): ReasonedRow[] {
  return store.db
    .prepare(
      `SELECT observed_at AS observedAt, controller_error AS error,
              controller_integral AS integral, controller_derivative AS derivative,
              uncapped_interval_seconds AS uncapped, interval_seconds AS interval
       FROM quota_observations
       WHERE provider = ? AND kind = ? AND interval_seconds IS NOT NULL
       ORDER BY observed_at ASC, rowid ASC`
    )
    .all(provider, kind) as ReasonedRow[];
}

interface ConcurrentOpener {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  completed: Promise<void>;
  output: () => string;
}

function startConcurrentOpener(
  moduleUrl: string,
  databasePath: string,
  client?: { moduleUrl: string; socketPath: string }
): ConcurrentOpener {
  // TypeScript writes intra-package imports with a `.js` extension naming a
  // `.ts` file. Vitest's resolver follows that; plain node's does not, and this
  // opener is plain node — so the store's own imports have to be mapped here or
  // the child dies at load with ERR_MODULE_NOT_FOUND. Only relative specifiers
  // are touched, and only when the `.ts` file is really there.
  const resolveTsSources = `
    import { existsSync } from "node:fs";
    import { fileURLToPath } from "node:url";
    export async function resolve(specifier, context, next) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        const asTs = await next(specifier.slice(0, -3) + ".ts", context).catch(() => null);
        if (asTs && existsSync(fileURLToPath(asTs.url))) return asTs;
      }
      return next(specifier, context);
    }
  `;
  const script = `
    import { register } from "node:module";
    register("data:text/javascript," + encodeURIComponent(${JSON.stringify(resolveTsSources)}));
    const { SharedQuotaStore } = await import(${JSON.stringify(moduleUrl)});
    const clientModuleUrl = ${JSON.stringify(client?.moduleUrl)};
    const socketPath = ${JSON.stringify(client?.socketPath)};
    const { QuotaCoordinatorClient } = clientModuleUrl
      ? await import(clientModuleUrl)
      : {};
    process.stdout.write("ready\\n");
    process.stdin.once("data", async () => {
      try {
        if (QuotaCoordinatorClient && socketPath) {
          const coordinator = new QuotaCoordinatorClient({
            socketPath,
            configuredProviders: ["claude"],
          });
          await coordinator.getThrottle();
          process.stdout.write("applied=" + coordinator.getLastAppliedInterval("claude") + "\\n");
        } else {
          const store = new SharedQuotaStore(process.argv[1]);
          store.close();
        }
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  `;
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-transform-types",
      "--input-type=module",
      "-e",
      script,
      databasePath,
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let output = "";
  let errorOutput = "";
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      readyReject?.(error);
      reject(error);
    });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        const error = new Error(`concurrent opener exited ${code}: ${errorOutput || output}`);
        readyReject?.(error);
        reject(error);
      }
    });
  });
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes("ready\n")) readyResolve?.();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errorOutput += chunk.toString();
  });
  return { child, ready, completed, output: () => output };
}

describe("Quota coordinator multi-process reads", () => {
  it("criterion 12b: two clients apply one published interval after the pool performs one scrape", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-quota-coordinator-e2e-"));
    roots.push(root);
    const databasePath = join(root, "quota.db");
    const socketPath = join(root, "coordinator.sock");
    const store = new SharedQuotaStore(databasePath);
    const scrapedAt = new Date().toISOString();
    const resetAtIso = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    try {
      store.configureController({ maxIntervalSeconds: 3600 });
      // The pool begins cold. The observation below is owned by the one
      // service probe; the collection tick advances it into the value both
      // independently-running clients receive.
      expect(store.getProviderThrottle("claude")).toBeNull();
      const scrape = vi.fn().mockImplementation(async () => {
        recordObservation(store, "claude", scrapedAt, 50, resetAtIso);
        return {
          state: store.getLatestSnapshot("claude"),
          didProbe: true,
        };
      });
      const collection = new QuotaCollectionLoop({
        store,
        quotaService: {
          getQuotaProbeOutcome: scrape,
          hydrate: vi.fn(),
        } as unknown as QuotaService,
        providers: ["claude"],
      });
      const coordinator = new QuotaCoordinatorService({
        socketPath,
        store,
        configuredProviders: ["claude"],
      });
      await coordinator.start();
      try {
        await collection.tick();
        expect(scrape).toHaveBeenCalledTimes(1);
        const publishedInterval = store.getProviderThrottle("claude")?.intervalSeconds;
        if (publishedInterval === undefined)
          throw new Error("expected a published claude interval");

        const localClient = new QuotaCoordinatorClient({
          socketPath,
          configuredProviders: ["claude"],
        });
        const child = startConcurrentOpener(
          pathToFileURL(join(process.cwd(), "src/quota/shared-store.ts")).href,
          databasePath,
          {
            moduleUrl: pathToFileURL(join(process.cwd(), "src/quota/coordinator-client.ts")).href,
            socketPath,
          }
        );
        await child.ready;
        await localClient.getThrottle();
        child.child.stdin.end("read\\n");
        await child.completed;

        expect(localClient.getLastAppliedInterval("claude")).toBe(publishedInterval);
        expect(child.output()).toContain(`applied=${publishedInterval}`);
        expect(scrape).toHaveBeenCalledTimes(1);

        // This is deliberately not a spacing test. These are client reads, not
        // shared launch reservations: no union of start timestamps is asserted
        // against the interval (§1.5; deferred to §11/v2).
      } finally {
        await coordinator.stop();
      }
    } finally {
      store.close();
    }
  }, 15_000);
});

describe("SharedQuotaStore PID integral term", () => {
  it("accumulates standing error so one integral time doubles the proportional response", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-integral-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 36000 });
      const reset = "2030-01-08T00:00:00.000Z";
      const startedMs = Date.parse("2030-01-01T00:00:00.000Z");
      const resetMs = Date.parse(reset);
      const standingError = 10;
      for (let slot = 0; slot <= 12; slot += 1) {
        const observedMs = startedMs + slot * 5 * 60 * 1000;
        const timeRemainingPct = ((resetMs - observedMs) / (7 * 24 * 60 * 60 * 1000)) * 100;
        recordObservation(
          store,
          "claude",
          new Date(observedMs).toISOString(),
          timeRemainingPct - standingError,
          reset
        );
      }

      const rows = reasonedRows(store, "claude");
      expect(rows).toHaveLength(13);
      expect(QUOTA_INTEGRAL_TIME_SECONDS).toBe(2 * QUOTA_DERIVATIVE_TAU_SECONDS);
      expect(QUOTA_INTEGRAL_MAX_STEP_SECONDS).toBe(30 * 60);

      // A cold start has no elapsed time to integrate over, so the first
      // decision is the pure proportional one a PD controller would have made.
      expect(rows[0]?.integral).toBe(0);
      expect(rows[0]?.error).toBeCloseTo(10, 9);

      // One integral time of standing error later, the accumulated area asks
      // for exactly as much period as the proportional term already does.
      const final = rows.at(-1) as ReasonedRow;
      expect(final.integral).toBeCloseTo(final.error * QUOTA_INTEGRAL_TIME_SECONDS, 6);
      const proportional = QUOTA_KP_SECONDS_PER_POINT * final.error;
      const integralTerm = QUOTA_KI_SECONDS_PER_POINT_SECOND * final.integral;
      expect(integralTerm).toBeCloseTo(proportional, 6);

      // The persisted period is the actuator command, so the doubled controller
      // output reaches it through the smoothing filter.
      const commanded =
        proportional + integralTerm + QUOTA_KD_SECONDS_SQUARED_PER_POINT * final.derivative;
      const held = rows.at(-2)?.interval as number;
      expect(final.uncapped).toBeCloseTo(held + QUOTA_ACTUATOR_SMOOTHING * (commanded - held), 6);
    } finally {
      store.close();
    }
  });

  it("fills the reachable upper range, unwinds on reversal, and does not wind below zero", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-antiwindup-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    const maxIntervalSeconds = 1450;
    try {
      store.configureController({ maxIntervalSeconds });
      const reset = "2030-01-08T00:00:00.000Z";
      const startedMs = Date.parse("2030-01-04T12:00:00.000Z");
      const resetMs = Date.parse(reset);
      const percentLeftForError = (observedMs: number, error: number) =>
        ((resetMs - observedMs) / (7 * 24 * 60 * 60 * 1000)) * 100 - error;

      for (let slot = 0; slot <= 3; slot += 1) {
        const observedMs = startedMs + slot * 5 * 60 * 1000;
        recordObservation(
          store,
          "claude",
          new Date(observedMs).toISOString(),
          percentLeftForError(observedMs, 10),
          reset
        );
      }
      const upperRows = reasonedRows(store, "claude");
      const beforeBound = upperRows.at(-2) as ReasonedRow;
      const atBound = upperRows.at(-1) as ReasonedRow;
      expect(atBound.integral).toBeGreaterThan(beforeBound.integral);
      expect(
        QUOTA_KP_SECONDS_PER_POINT * atBound.error +
          QUOTA_KI_SECONDS_PER_POINT_SECOND * atBound.integral +
          QUOTA_KD_SECONDS_SQUARED_PER_POINT * atBound.derivative
      ).toBeCloseTo(maxIntervalSeconds, 6);

      const reversalMs = startedMs + 4 * 5 * 60 * 1000;
      recordObservation(
        store,
        "claude",
        new Date(reversalMs).toISOString(),
        percentLeftForError(reversalMs, -1),
        reset
      );
      const released = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(released.error).toBeLessThan(0);
      expect(released.integral).toBeLessThan(atBound.integral);
      expect(released.interval).toBeLessThan(maxIntervalSeconds);

      recordObservation(
        store,
        "codex",
        new Date(startedMs).toISOString(),
        percentLeftForError(startedMs, -10),
        reset
      );
      recordObservation(
        store,
        "codex",
        new Date(startedMs + 5 * 60 * 1000).toISOString(),
        percentLeftForError(startedMs + 5 * 60 * 1000, -10),
        reset
      );
      for (const row of reasonedRows(store, "codex")) {
        expect(row.integral).toBe(0);
        expect(row.interval).toBe(0);
      }
    } finally {
      store.close();
    }
  });

  it("resets the accumulator on window rollover instead of carrying the old cycle", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-integral-rollover-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 36000 });
      recordObservation(
        store,
        "claude",
        "2030-01-01T00:00:00.000Z",
        90,
        "2030-01-08T00:00:00.000Z"
      );
      recordObservation(
        store,
        "claude",
        "2030-01-01T01:00:00.000Z",
        80,
        "2030-01-08T00:00:00.000Z"
      );
      const carried = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(carried.integral).toBeGreaterThan(0);

      recordObservation(
        store,
        "claude",
        "2030-01-08T00:05:00.000Z",
        99,
        "2030-01-15T00:00:00.000Z"
      );
      const rolledOver = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      // The first observation establishes the new cycle's error without
      // importing elapsed time from the prior cycle.
      expect(rolledOver.integral).toBe(0);
      expect(rolledOver.integral).toBeLessThan(carried.integral);
    } finally {
      store.close();
    }
  });

  it("treats a refill as a cycle boundary even when the reset instant did not move", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-refill-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 36000 });
      const reset = "2030-01-08T00:00:00.000Z";
      recordObservation(store, "claude", "2030-01-01T00:00:00.000Z", 90, reset);
      recordObservation(store, "claude", "2030-01-01T01:00:00.000Z", 80, reset);
      const carried = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(carried.integral).toBeGreaterThan(0);
      expect(carried.derivative).not.toBe(0);

      // Remaining quota jumps 80 -> 99 while `reset_at` stays exactly where it
      // was, so the reset-instant test alone cannot see this. Without the
      // refill test the error's sharp fall reads as genuine progress and
      // relaxes the interval for the next half hour.
      recordObservation(store, "claude", "2030-01-01T02:00:00.000Z", 99, reset);
      const refilled = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(refilled.derivative).toBe(0);
      expect(refilled.integral).toBe(0);
    } finally {
      store.close();
    }
  });

  it("keeps controller memory when remaining quota only wobbles within the noise floor", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-refill-epsilon-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 36000 });
      const reset = "2030-01-08T00:00:00.000Z";
      recordObservation(store, "claude", "2030-01-01T00:00:00.000Z", 90, reset);
      recordObservation(store, "claude", "2030-01-01T01:00:00.000Z", 80, reset);
      const carried = reasonedRows(store, "claude").at(-1) as ReasonedRow;

      // A one-point rise is display rounding, not a refill. The other half of
      // the threshold: were any rise treated as a boundary, rounding alone
      // would wipe the accumulator and the derivative filter repeatedly.
      recordObservation(store, "claude", "2030-01-01T02:00:00.000Z", 81, reset);
      const wobbled = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(wobbled.derivative).not.toBe(0);
      expect(wobbled.integral).toBeGreaterThan(carried.integral);
    } finally {
      store.close();
    }
  });

  it("clamps the integrated step so a long observation gap cannot dump days of area", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-integral-gap-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 36000 });
      const reset = "2030-03-01T00:00:00.000Z";
      recordObservation(store, "claude", "2030-01-01T00:00:00.000Z", 90, reset);
      // A month-long gap: the real elapsed time is ~2.6M seconds.
      recordObservation(store, "claude", "2030-02-01T00:00:00.000Z", 40, reset);

      const gapped = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(gapped.integral).toBeCloseTo(gapped.error * QUOTA_INTEGRAL_MAX_STEP_SECONDS, 6);
      expect(gapped.integral).toBeLessThan(gapped.error * 24 * 60 * 60);
    } finally {
      store.close();
    }
  });

  it("accumulates the same integral area for six 5m observations vs one 30m observation under stable error (#690)", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-integral-step-compare-"));
    roots.push(root);
    const store5m = new SharedQuotaStore(join(root, "store5m.db"));
    const store30m = new SharedQuotaStore(join(root, "store30m.db"));
    try {
      store5m.configureController({ maxIntervalSeconds: 36000 });
      store30m.configureController({ maxIntervalSeconds: 36000 });

      const startMs = Date.parse("2030-01-01T00:00:00.000Z");
      const reset = "2030-01-08T00:00:00.000Z";
      const weeklyMs = 7 * 24 * 60 * 60 * 1000;
      const standingError = 10;

      // In store5m, record 7 observations (t=0, 5m, 10m, 15m, 20m, 25m, 30m) with constant error
      for (let i = 0; i <= 6; i++) {
        const obsMs = startMs + i * 5 * 60 * 1000;
        const timeRemainingPct = ((Date.parse(reset) - obsMs) / weeklyMs) * 100;
        recordObservation(
          store5m,
          "claude",
          new Date(obsMs).toISOString(),
          timeRemainingPct - standingError,
          reset
        );
      }

      // In store30m, record 2 observations (t=0 and t=30m) with the same constant error
      const t0 = startMs;
      const t30 = startMs + 30 * 60 * 1000;
      const timeRemainingPct0 = ((Date.parse(reset) - t0) / weeklyMs) * 100;
      const timeRemainingPct30 = ((Date.parse(reset) - t30) / weeklyMs) * 100;
      recordObservation(
        store30m,
        "claude",
        new Date(t0).toISOString(),
        timeRemainingPct0 - standingError,
        reset
      );
      recordObservation(
        store30m,
        "claude",
        new Date(t30).toISOString(),
        timeRemainingPct30 - standingError,
        reset
      );

      const rows5m = reasonedRows(store5m, "claude");
      const rows30m = reasonedRows(store30m, "claude");

      expect(rows5m).toHaveLength(7);
      expect(rows30m).toHaveLength(2);

      const final5m = rows5m.at(-1) as ReasonedRow;
      const final30m = rows30m.at(-1) as ReasonedRow;

      // Both should have integrated standingError * 1800s
      expect(final5m.integral).toBeCloseTo(standingError * 1800, 4);
      expect(final30m.integral).toBeCloseTo(standingError * 1800, 4);
      expect(final30m.integral).toBeCloseTo(final5m.integral, 4);
      // The elapsed-time smoothing keeps a sparse 30m lane close to the 5m
      // lane's wall-clock response instead of applying only one 25% step.
      expect(final30m.interval).toBeGreaterThan(final5m.interval * 0.9);
      expect(final30m.interval).toBeLessThan(final5m.interval * 1.2);
      expect(actuatorSmoothingForElapsedSeconds(QUOTA_ACTUATOR_REFERENCE_STEP_SECONDS)).toBe(
        QUOTA_ACTUATOR_SMOOTHING
      );
      expect(actuatorSmoothingForElapsedSeconds(QUOTA_ACTUATOR_MAX_ELAPSED_SECONDS)).toBeCloseTo(
        1 - (1 - QUOTA_ACTUATOR_SMOOTHING) ** 6,
        12
      );
    } finally {
      store5m.close();
      store30m.close();
    }
  });

  it("scales actual-observation actuator steps while bounding delayed, noisy, and reset readings (#690)", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-elapsed-actuator-"));
    roots.push(root);
    const fiveMinute = new SharedQuotaStore(join(root, "five-minute.db"));
    const thirtyMinute = new SharedQuotaStore(join(root, "thirty-minute.db"));
    try {
      fiveMinute.configureController({ maxIntervalSeconds: 36000 });
      thirtyMinute.configureController({ maxIntervalSeconds: 36000 });
      const startMs = Date.parse("2030-01-01T00:00:00.000Z");
      const reset = "2030-01-08T00:00:00.000Z";
      const weeklyMs = 7 * 24 * 60 * 60 * 1000;
      const recordError = (
        store: SharedQuotaStore,
        provider: string,
        offsetMinutes: number,
        error: number,
        resetAtIso = reset
      ) => {
        const observedMs = startMs + offsetMinutes * 60 * 1000;
        const timeRemainingPct = ((Date.parse(resetAtIso) - observedMs) / weeklyMs) * 100;
        recordObservation(
          store,
          provider,
          new Date(observedMs).toISOString(),
          timeRemainingPct - error,
          resetAtIso
        );
      };

      // The same step lands once at 30m or six times at 5m. The sparse lane
      // receives elapsed-time smoothing/slew rather than one old 5m step.
      recordError(fiveMinute, "claude", 0, 0);
      recordError(thirtyMinute, "claude", 0, 0);
      for (let minute = 5; minute <= 30; minute += 5) recordError(fiveMinute, "claude", minute, 20);
      recordError(thirtyMinute, "claude", 30, 20);
      const fiveMinuteStep = reasonedRows(fiveMinute, "claude").at(-1) as ReasonedRow;
      const thirtyMinuteStep = reasonedRows(thirtyMinute, "claude").at(-1) as ReasonedRow;
      expect(actuatorSlewForElapsedSeconds(QUOTA_ACTUATOR_MAX_ELAPSED_SECONDS)).toBe(
        QUOTA_MAX_SCALED_SLEW_SECONDS
      );
      expect(actuatorSlewForElapsedSeconds(10 * 60 * 60)).toBe(QUOTA_MAX_SCALED_SLEW_SECONDS);
      expect(thirtyMinuteStep.interval).toBe(QUOTA_MAX_SCALED_SLEW_SECONDS);
      expect(thirtyMinuteStep.interval).toBeGreaterThan(fiveMinuteStep.interval * 0.6);
      expect(thirtyMinuteStep.interval).toBeLessThan(fiveMinuteStep.interval * 0.8);

      // A 5m collection tick or cached probe read has no new durable
      // observation to reason from, so it cannot add controller area or move
      // the applied interval.
      const beforeRepeatedTicks = reasonedRows(thirtyMinute, "claude");
      for (let i = 0; i < 6; i += 1) {
        thirtyMinute.advancePendingController({ maxIntervalSeconds: 36000 });
      }
      expect(reasonedRows(thirtyMinute, "claude")).toEqual(beforeRepeatedTicks);

      // A delayed sample has real observation age, but can move the actuator
      // by no more than the sparse-step cap. A one-point noisy follow-up gets
      // the ordinary 5m cap, not a fabricated long elapsed interval.
      recordError(thirtyMinute, "claude", 5 * 60, 20);
      const delayed = reasonedRows(thirtyMinute, "claude").at(-1) as ReasonedRow;
      recordError(thirtyMinute, "claude", 5 * 60 + 5, 19);
      const noisy = reasonedRows(thirtyMinute, "claude").at(-1) as ReasonedRow;

      // A rollover clears controller memory but still bounds the command from
      // the last applied interval; it must not turn a reset into a huge jump.
      const nextReset = "2030-01-15T00:00:00.000Z";
      recordError(thirtyMinute, "claude", 7 * 24 * 60 + 5, 0, nextReset);
      const resetRow = reasonedRows(thirtyMinute, "claude").at(-1) as ReasonedRow;

      expect(delayed.interval - thirtyMinuteStep.interval).toBe(QUOTA_MAX_SCALED_SLEW_SECONDS);
      expect(Math.abs(noisy.interval - delayed.interval)).toBeLessThanOrEqual(900);
      expect(resetRow.integral).toBe(0);
      expect(resetRow.derivative).toBe(0);
      expect(Math.abs(resetRow.interval - noisy.interval)).toBeLessThanOrEqual(
        QUOTA_MAX_SCALED_SLEW_SECONDS
      );
    } finally {
      fiveMinute.close();
      thirtyMinute.close();
    }
  });

  it("bounds long gaps to 30m step and resets anti-windup on window reset / refill (#690)", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-integral-antiwindup-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 36000 });
      const reset1 = "2030-01-08T00:00:00.000Z";

      // Initial observation at t=0
      recordObservation(store, "kimi", "2030-01-01T00:00:00.000Z", 90, reset1);
      // Long gap of 2 hours (7200s): must be clamped to 1800s (30m)
      recordObservation(store, "kimi", "2030-01-01T02:00:00.000Z", 80, reset1);

      const afterLongGap = reasonedRows(store, "kimi").at(-1) as ReasonedRow;
      // Integrated dt must be bounded by 1800s, not 7200s
      expect(afterLongGap.integral).toBeCloseTo(afterLongGap.error * 1800, 4);

      // A 10h outage adds at most one 1800s slot of area as well.
      recordObservation(store, "kimi", "2030-01-01T12:00:00.000Z", 70, reset1);
      const afterOutage = reasonedRows(store, "kimi").at(-1) as ReasonedRow;
      expect(afterOutage.integral).toBeCloseTo(afterLongGap.integral + afterOutage.error * 1800, 4);

      // Now simulate a window reset / refill: resetMoves or quotaRefilled
      const reset2 = "2030-01-15T00:00:00.000Z";
      recordObservation(store, "kimi", "2030-01-08T00:05:00.000Z", 98, reset2);

      const afterReset = reasonedRows(store, "kimi").at(-1) as ReasonedRow;
      // Cycle changed zeroes integralDtSeconds and previousIntegral
      expect(afterReset.integral).toBe(0);
    } finally {
      store.close();
    }
  });

  it("widens a legacy database safely when several processes open it together", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-integral-schema-"));
    roots.push(root);
    const path = join(root, "shared.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE quota_observations (
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        observed_slot INTEGER NOT NULL,
        label TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        percent_left REAL NOT NULL,
        reset_at_iso TEXT,
        window_ms INTEGER NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0,
        controller_error REAL,
        controller_derivative REAL,
        uncapped_interval_seconds REAL,
        interval_seconds REAL,
        PRIMARY KEY(provider, kind, observed_slot)
      );
    `);
    legacy
      .prepare(
        `INSERT INTO quota_observations
          (provider, kind, observed_slot, label, observed_at, percent_left,
           reset_at_iso, window_ms, processed, controller_error,
           controller_derivative, uncapped_interval_seconds, interval_seconds)
         VALUES ('claude', 'weekly', 1, 'Weekly', '2030-01-01T00:00:00.000Z', 90,
                 '2030-01-08T00:00:00.000Z', 604800000, 1, 10, 0, 1200, 300)`
      )
      .run();
    legacy.close();

    const moduleUrl = pathToFileURL(join(process.cwd(), "src/quota/shared-store.ts")).href;
    const openers = Array.from({ length: 6 }, () => startConcurrentOpener(moduleUrl, path));
    await Promise.all(openers.map((opener) => opener.ready));
    for (const opener of openers) opener.child.stdin.end("open\n");
    await Promise.all(openers.map((opener) => opener.completed));

    const store = new SharedQuotaStore(path);
    try {
      expect(
        (
          store.db.prepare("PRAGMA table_info(quota_observations)").all() as Array<{ name: string }>
        ).map((column) => column.name)
      ).toContain("controller_integral");

      // The pre-existing reasoned row reads back a null accumulator and is
      // treated as an empty one, so the controller keeps running on it.
      store.configureController({ maxIntervalSeconds: 3600 });
      recordObservation(
        store,
        "claude",
        "2030-01-01T01:00:00.000Z",
        89,
        "2030-01-08T00:00:00.000Z"
      );
      const next = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(next.integral).toBeCloseTo(next.error * QUOTA_INTEGRAL_MAX_STEP_SECONDS, 6);
    } finally {
      store.close();
    }
  }, 15_000);

  it("elects the governing bucket from the newest scrape, preventing an older omitted bucket from governing", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-governing-bucket-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 3600 });
      const t1 = "2030-01-01T00:00:00.000Z";
      const t2 = "2030-01-01T03:00:00.000Z";

      // At t1, an older scrape produced a five_hour observation with high throttle.
      recordObservation(store, "codex", t1, 50, "2030-01-01T05:00:00.000Z", "five_hour");

      // At t2, the newest scrape emitted ONLY weekly with lower throttle.
      recordObservation(store, "codex", t2, 95, "2030-01-08T00:00:00.000Z", "weekly");

      const throttle = store.getProviderThrottle("codex");
      expect(throttle).not.toBeNull();
      // Governing bucket must be elected from the newest scrape (weekly), not the omitted five_hour bucket
      expect(throttle?.governingBucketKey).toBe("codex:weekly");
      expect(throttle?.updatedAt).toBe(t2);
      // Both buckets remain visible in the per-bucket map
      expect(throttle?.buckets.map((b) => b.key).sort()).toEqual([
        "codex:five_hour",
        "codex:weekly",
      ]);
    } finally {
      store.close();
    }
  });

  it("stamps every row of one snapshot with the single scrapedAt, so same-scrape membership is exact equality", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-same-scrape-stamp-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 3600 });
      const scrapedAt = "2030-01-01T00:00:00.000Z";
      const state: ProviderQuotaSnapshot = {
        provider: "claude",
        status: "available",
        scrapedAt,
        limits: [
          {
            label: "session",
            kind: "session",
            scope: "provider",
            percentLeft: 80,
            resetAtIso: "2030-01-01T05:00:00.000Z",
          },
          {
            label: "weekly",
            kind: "weekly",
            scope: "provider",
            percentLeft: 40,
            resetAtIso: "2030-01-08T00:00:00.000Z",
          },
        ],
      };
      const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "raw" });
      store.recordParsed(id, state, state);

      const throttle = store.getProviderThrottle("claude");
      expect(throttle?.updatedAt).toBe(scrapedAt);
      // Both rows carry the exact `scrapedAt` string: no per-row clock, no skew.
      expect(throttle?.buckets.map((b) => b.observedAt)).toEqual([scrapedAt, scrapedAt]);
      // The widest required interval governs, as before, from within that scrape.
      expect(throttle?.governingBucketKey).toBe("claude:weekly");
    } finally {
      store.close();
    }
  });

  it("keeps the last reasoned bucket governing when the newest scrape's rows are not yet reasoned", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-unreasoned-newest-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      const t1 = "2030-01-01T00:00:00.000Z";
      const t2 = "2030-01-01T00:05:00.000Z";
      // A reasoned five_hour row from the previous tick.
      recordObservation(store, "codex", t1, 50, "2030-01-01T05:00:00.000Z", "five_hour");
      store.advancePendingController({ maxIntervalSeconds: 3600 });
      const reasoned = store.getProviderThrottle("codex");
      expect(reasoned?.governingBucketKey).toBe("codex:five_hour");
      expect(reasoned?.intervalSeconds).toBeGreaterThan(0);

      // The newest scrape's weekly row is inserted but the collection tick has
      // not yet reached advancePendingController: interval_seconds is NULL.
      recordObservation(store, "codex", t2, 95, "2030-01-08T00:00:00.000Z", "weekly");
      const between = store.getProviderThrottle("codex");
      expect(between?.updatedAt).toBe(t2);
      // Last-good pacing is kept rather than publishing a null governing / 0 s.
      expect(between?.governingBucketKey).toBe("codex:five_hour");
      expect(between?.intervalSeconds).toBe(reasoned?.intervalSeconds);

      // Once reasoned, the newest scrape's bucket governs.
      store.advancePendingController({ maxIntervalSeconds: 3600 });
      expect(store.getProviderThrottle("codex")?.governingBucketKey).toBe("codex:weekly");
    } finally {
      store.close();
    }
  });
});

describe("SharedQuotaStore operator pacing reset", () => {
  const reset = "2030-01-08T00:00:00.000Z";
  const startedMs = Date.parse("2030-01-01T00:00:00.000Z");
  const resetMs = Date.parse(reset);
  const weeklyMs = 7 * 24 * 60 * 60 * 1000;

  /** Record `slots` five-minute observations holding a standing error. */
  function recordStandingError(
    store: SharedQuotaStore,
    provider: string,
    slots: number,
    standingError: number,
    fromSlot = 0
  ): void {
    for (let slot = fromSlot; slot < fromSlot + slots; slot += 1) {
      const observedMs = startedMs + slot * 5 * 60 * 1000;
      const timeRemainingPct = ((resetMs - observedMs) / weeklyMs) * 100;
      recordObservation(
        store,
        provider,
        new Date(observedMs).toISOString(),
        timeRemainingPct - standingError,
        reset
      );
    }
  }

  it("zeroes integral, derivative and the current period, keeps observations and errors, then paces forward from zero", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-reset-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 36000 });
      recordStandingError(store, "claude", 13, 10);
      recordStandingError(store, "codex", 13, 10);

      const before = reasonedRows(store, "claude");
      expect(before).toHaveLength(13);
      const carried = before.at(-1) as ReasonedRow;
      expect(carried.integral).toBeGreaterThan(0);
      expect(carried.interval).toBeGreaterThan(0);
      const codexBefore = store.getProviderThrottle("codex");
      const observationsBefore = store.listCanonicalSince("claude", "2000-01-01T00:00:00.000Z");
      const errorsBefore = store
        .listHistorySince("claude", "2000-01-01T00:00:00.000Z")
        .map((point) => point.controllerError);

      const result = store.resetController("claude");
      expect(result).toEqual({ provider: "claude", clearedDecisions: 13, observations: 13 });

      // The current pacing setting is zeroed immediately: nothing governs the lane.
      const throttle = store.getProviderThrottle("claude");
      expect(throttle?.intervalSeconds).toBe(0);
      expect(throttle?.uncappedIntervalSeconds).toBe(0);
      expect(throttle?.governingBucketKey).toBeNull();
      expect(throttle?.buckets).toEqual([]);
      expect(reasonedRows(store, "claude")).toEqual([]);

      // Observations and the proportional signal they imply are untouched; only
      // controller memory is gone.
      expect(store.listCanonicalSince("claude", "2000-01-01T00:00:00.000Z")).toEqual(
        observationsBefore
      );
      const history = store.listHistorySince("claude", "2000-01-01T00:00:00.000Z");
      expect(history.map((point) => point.controllerError)).toEqual(errorsBefore);
      expect(history.every((point) => point.intervalSeconds === null)).toBe(true);
      expect(
        store.db
          .prepare(
            `SELECT count(*) AS n FROM quota_observations
             WHERE provider = 'claude' AND processed = 1
               AND controller_integral IS NULL AND controller_derivative IS NULL
               AND uncapped_interval_seconds IS NULL AND interval_seconds IS NULL`
          )
          .get()
      ).toEqual({ n: 13 });

      // Another provider's learned state is not part of the reset.
      expect(store.getProviderThrottle("codex")).toEqual(codexBefore);
      expect(reasonedRows(store, "codex")).toHaveLength(13);

      // The next observation is reasoned as a cold start: the proportional
      // term stands alone and the period is smoothed up from zero, not from
      // the pre-reset period.
      recordStandingError(store, "claude", 1, 10, 13);
      const fresh = reasonedRows(store, "claude");
      expect(fresh).toHaveLength(1);
      const first = fresh[0] as ReasonedRow;
      expect(first.integral).toBe(0);
      expect(first.derivative).toBe(0);
      expect(first.error).toBeCloseTo(10, 9);
      expect(first.uncapped).toBeCloseTo(
        QUOTA_ACTUATOR_SMOOTHING * QUOTA_KP_SECONDS_PER_POINT * first.error,
        6
      );
      expect(first.interval).toBeLessThan(carried.interval);
      expect(store.getProviderThrottle("claude")?.intervalSeconds).toBeCloseTo(first.interval, 9);
    } finally {
      store.close();
    }
  });

  it("is durable: a restarted controller on a fresh connection sees the reset, not the old memory", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-reset-restart-"));
    roots.push(root);
    const path = join(root, "shared.db");
    const first = new SharedQuotaStore(path);
    try {
      first.configureController({ maxIntervalSeconds: 36000 });
      recordStandingError(first, "agy", 13, 10);
      expect(first.getProviderThrottle("agy")?.intervalSeconds).toBeGreaterThan(0);
    } finally {
      first.close();
    }

    // The operator command runs in its own process without a controller.
    const operator = new SharedQuotaStore(path);
    try {
      expect(operator.resetController("agy").clearedDecisions).toBe(13);
    } finally {
      operator.close();
    }

    const restarted = new SharedQuotaStore(path);
    try {
      restarted.configureController({ maxIntervalSeconds: 36000 });
      expect(restarted.getProviderThrottle("agy")?.intervalSeconds).toBe(0);
      recordStandingError(restarted, "agy", 1, 10, 13);
      const fresh = reasonedRows(restarted, "agy");
      expect(fresh).toHaveLength(1);
      expect(fresh[0]?.integral).toBe(0);
      expect(fresh[0]?.derivative).toBe(0);
    } finally {
      restarted.close();
    }
  });

  it("resets every window kind on the lane, because the widest one governs it", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-reset-kinds-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 36000 });
      // A five-hourly window alongside the weekly one, each carrying its own
      // standing error and so its own retained decision.
      const fiveHourReset = "2030-01-01T05:00:00.000Z";
      for (let slot = 0; slot < 13; slot += 1) {
        const observedMs = startedMs + slot * 5 * 60 * 1000;
        const weeklyRemaining = ((resetMs - observedMs) / weeklyMs) * 100;
        recordObservation(
          store,
          "claude",
          new Date(observedMs).toISOString(),
          weeklyRemaining - 10,
          reset
        );
        const fiveHourRemaining =
          ((Date.parse(fiveHourReset) - observedMs) / (5 * 60 * 60 * 1000)) * 100;
        recordObservation(
          store,
          "claude",
          new Date(observedMs).toISOString(),
          fiveHourRemaining - 20,
          fiveHourReset,
          "five_hour"
        );
      }
      expect(reasonedRows(store, "claude", "weekly")).toHaveLength(13);
      expect(reasonedRows(store, "claude", "five_hour")).toHaveLength(13);
      expect(store.getProviderThrottle("claude")?.intervalSeconds).toBeGreaterThan(0);

      const result = store.resetController("claude");
      expect(result).toEqual({ provider: "claude", clearedDecisions: 26, observations: 26 });

      // Neither kind is left holding a decision that could govern the lane.
      expect(reasonedRows(store, "claude", "weekly")).toEqual([]);
      expect(reasonedRows(store, "claude", "five_hour")).toEqual([]);
      const throttle = store.getProviderThrottle("claude");
      expect(throttle?.intervalSeconds).toBe(0);
      expect(throttle?.governingBucketKey).toBeNull();

      // Both windows' observations are still evidence and are still there.
      expect(store.listCanonicalSince("claude", "2000-01-01T00:00:00.000Z")).toHaveLength(26);
    } finally {
      store.close();
    }
  });

  it("keeps an exhausted lane gated: it resets pacing policy, it does not claim quota came back", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-reset-exhausted-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 36000 });
      recordStandingError(store, "claude", 13, 10);
      // The lane then reads as exhausted, with the window's reset still ahead.
      const exhaustedAt = new Date(startedMs + 13 * 5 * 60 * 1000).toISOString();
      recordObservation(store, "claude", exhaustedAt, 0, reset);
      expect(store.getExhaustedUntil("claude")).toBe(reset);

      store.resetController("claude");

      // The period is gone, but the exhaustion gate is untouched: `percent_left`
      // and `reset_at_iso` are observations, and only a fresh scrape can say
      // the budget refilled.
      const throttle = store.getProviderThrottle("claude");
      expect(throttle?.intervalSeconds).toBe(0);
      expect(throttle?.expired).toBe(true);
      expect(throttle?.exhaustedUntil).toBe(reset);
      expect(store.getExhaustedUntil("claude")).toBe(reset);

      // A fresh scrape showing real headroom is what releases it.
      recordObservation(
        store,
        "claude",
        new Date(startedMs + 14 * 5 * 60 * 1000).toISOString(),
        80,
        reset
      );
      expect(store.getExhaustedUntil("claude")).toBeNull();
      expect(store.getProviderThrottle("claude")?.expired).toBe(false);
    } finally {
      store.close();
    }
  });

  it("reports nothing cleared for a provider without controller memory", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-reset-empty-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      expect(store.resetController("kimi")).toEqual({
        provider: "kimi",
        clearedDecisions: 0,
        observations: 0,
      });
      expect(store.getProviderThrottle("kimi")).toBeNull();
    } finally {
      store.close();
    }
  });
});
