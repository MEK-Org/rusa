import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderQuotaSnapshot, QuotaWindowKind } from "../mcp/quota-mcp.js";
import {
  QUOTA_ACTUATOR_SMOOTHING,
  QUOTA_INTEGRAL_MAX_STEP_SECONDS,
  QUOTA_INTEGRAL_TIME_SECONDS,
  QUOTA_KD_SECONDS_SQUARED_PER_POINT,
  QUOTA_KI_SECONDS_PER_POINT_SECOND,
  QUOTA_KP_SECONDS_PER_POINT,
  QUOTA_OBSERVATION_RETENTION_MS,
  QUOTA_RAW_RETENTION_MS,
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

describe("SharedQuotaStore canonical observations", () => {
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
      ).toEqual(["quota_observations", "quota_scrapes"]);
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
      ).toEqual(["quota_observations", "quota_scrapes"]);
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

describe("SharedQuotaStore PID integral term", () => {
  it("accumulates standing error so one integral time doubles the proportional response", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-integral-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 3600 });
      const reset = "2030-01-08T00:00:00.000Z";
      recordObservation(store, "claude", "2030-01-01T00:00:00.000Z", 90, reset);
      recordObservation(store, "claude", "2030-01-01T01:00:00.000Z", 89, reset);

      const rows = reasonedRows(store, "claude");
      expect(rows).toHaveLength(2);

      // A cold start has no elapsed time to integrate over, so the first
      // decision is the pure proportional one a PD controller would have made.
      expect(rows[0]?.integral).toBe(0);
      expect(rows[0]?.error).toBeCloseTo(10, 9);

      // One integral time of standing error later, the accumulated area asks
      // for exactly as much period as the proportional term already does.
      const second = rows[1] as ReasonedRow;
      expect(second.integral).toBeCloseTo(second.error * QUOTA_INTEGRAL_TIME_SECONDS, 6);
      const proportional = QUOTA_KP_SECONDS_PER_POINT * second.error;
      const integralTerm = QUOTA_KI_SECONDS_PER_POINT_SECOND * second.integral;
      expect(integralTerm).toBeCloseTo(proportional, 6);

      // The persisted period is the actuator command, so the doubled controller
      // output reaches it through the smoothing filter.
      const commanded =
        proportional + integralTerm + QUOTA_KD_SECONDS_SQUARED_PER_POINT * second.derivative;
      const held = rows[0]?.interval as number;
      expect(second.uncapped).toBeCloseTo(held + QUOTA_ACTUATOR_SMOOTHING * (commanded - held), 6);
    } finally {
      store.close();
    }
  });

  it("holds the accumulator against the cap so the period falls as soon as error reverses", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-antiwindup-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    const maxIntervalSeconds = 60;
    try {
      store.configureController({ maxIntervalSeconds });
      const reset = "2030-01-08T00:00:00.000Z";
      // Burn far ahead of pace for hours; every decision saturates the cap.
      recordObservation(store, "claude", "2030-01-01T00:00:00.000Z", 50, reset);
      recordObservation(store, "claude", "2030-01-01T01:00:00.000Z", 40, reset);
      recordObservation(store, "claude", "2030-01-01T02:00:00.000Z", 30, reset);
      recordObservation(store, "claude", "2030-01-01T03:00:00.000Z", 20, reset);

      const saturated = reasonedRows(store, "claude");
      expect(saturated).toHaveLength(4);
      for (const row of saturated) {
        expect(row.error).toBeGreaterThan(0);
        expect(row.uncapped).toBeGreaterThan(maxIntervalSeconds);
        expect(row.interval).toBe(maxIntervalSeconds);
        // Conditional integration refuses to bank area while pinned at the cap.
        expect(row.integral).toBe(0);
      }

      // Quota is replenished and consumption falls behind pace. A wound-up
      // integrator would keep the actuator pinned while it drained; this one
      // comes off the cap on the very next decision.
      recordObservation(store, "claude", "2030-01-01T04:00:00.000Z", 99, reset);
      const released = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(released.error).toBeLessThan(0);
      expect(released.interval).toBeLessThan(maxIntervalSeconds);
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
      // The new cycle integrates one clamped step of its own error, with nothing
      // inherited from the exhausted window.
      expect(rolledOver.integral).toBeCloseTo(
        rolledOver.error * QUOTA_INTEGRAL_MAX_STEP_SECONDS,
        6
      );
      expect(rolledOver.integral).toBeLessThan(carried.integral);
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

  it("widens a database created before the accumulator column existed", () => {
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
      expect(next.integral).toBeCloseTo(next.error * QUOTA_INTEGRAL_TIME_SECONDS, 6);
      expect(store.getProviderThrottle("claude")?.buckets[0]?.integral).toBeCloseTo(
        next.integral,
        6
      );
    } finally {
      store.close();
    }
  });
});
