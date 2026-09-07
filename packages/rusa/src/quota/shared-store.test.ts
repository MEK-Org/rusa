import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderQuotaSnapshot, QuotaWindowKind } from "../mcp/quota-mcp.js";
import {
  getObservationProjection,
  QUOTA_ACTUATOR_SMOOTHING,
  QUOTA_DERIVATIVE_TAU_SECONDS,
  QUOTA_INTEGRAL_MAX_STEP_SECONDS,
  QUOTA_INTEGRAL_TIME_SECONDS,
  QUOTA_KD_SECONDS_SQUARED_PER_POINT,
  QUOTA_KI_SECONDS_PER_POINT_SECOND,
  QUOTA_KP_SECONDS_PER_POINT,
  QUOTA_MAX_SLEW_SECONDS,
  QUOTA_OBSERVATION_RETENTION_MS,
  QUOTA_RAW_RETENTION_MS,
  QUOTA_RECOVERY_CONFIRMATIONS,
  QUOTA_RECOVERY_HALF_LIFE_SECONDS,
  QUOTA_RECOVERY_MAX_ELAPSED_SECONDS,
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
  commandedInterval: number | null;
  commandedUncapped: number | null;
  credit: number | null;
}

function reasonedRows(store: SharedQuotaStore, provider: string, kind = "weekly"): ReasonedRow[] {
  return store.db
    .prepare(
      `SELECT observed_at AS observedAt, controller_error AS error,
              controller_integral AS integral, controller_derivative AS derivative,
              uncapped_interval_seconds AS uncapped, interval_seconds AS interval,
              commanded_interval_seconds AS commandedInterval,
              commanded_uncapped_interval_seconds AS commandedUncapped,
              recovery_credit_seconds AS credit
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
}

function startConcurrentOpener(moduleUrl: string, databasePath: string): ConcurrentOpener {
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
    process.stdout.write("ready\\n");
    process.stdin.once("data", () => {
      try {
        const store = new SharedQuotaStore(process.argv[1]);
        store.close();
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
  return { child, ready, completed };
}

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
      expect(QUOTA_INTEGRAL_MAX_STEP_SECONDS).toBe(5 * 60);

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
      const columns = (
        store.db.prepare("PRAGMA table_info(quota_observations)").all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(columns).toContain("controller_integral");
      expect(columns).toContain("commanded_interval_seconds");
      expect(columns).toContain("commanded_uncapped_interval_seconds");
      expect(columns).toContain("recovery_credit_seconds");
      expect(columns).not.toContain("consecutive_negative_errors");
      expect(columns).not.toContain("shadow_interval_seconds");

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
});

function seedObservation(
  store: SharedQuotaStore,
  provider: string,
  observedAt: string,
  percentLeft: number,
  resetAtIso: string,
  opts: {
    integral?: number;
    interval?: number;
    commandedInterval?: number | null;
    commandedUncapped?: number | null;
    credit?: number | null;
    error?: number;
  } = {}
): void {
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  const observedMs = Date.parse(observedAt);
  const slot = Math.floor(observedMs / (5 * 60 * 1000));
  const timePct = Math.min(
    100,
    Math.max(0, ((Date.parse(resetAtIso) - observedMs) / windowMs) * 100)
  );
  const error = opts.error ?? timePct - percentLeft;
  const integral = opts.integral ?? 0;
  const interval = opts.interval ?? 0;
  const commandedInterval = opts.commandedInterval ?? null;
  const commandedUncapped = opts.commandedUncapped ?? null;
  const credit = opts.credit ?? null;

  store.db
    .prepare(
      `INSERT INTO quota_observations
        (provider, kind, observed_slot, label, observed_at, percent_left, reset_at_iso, window_ms,
         processed, controller_error, controller_derivative, controller_integral,
         uncapped_interval_seconds, interval_seconds,
         commanded_interval_seconds, commanded_uncapped_interval_seconds, recovery_credit_seconds)
       VALUES (?, 'weekly', ?, 'weekly limit', ?, ?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      provider,
      slot,
      observedAt,
      percentLeft,
      resetAtIso,
      windowMs,
      error,
      integral,
      interval,
      interval,
      commandedInterval,
      commandedUncapped,
      credit
    );
}

describe("SharedQuotaStore PID recovery output credit overlay", () => {
  const TRACE: Array<[string, number, number, number]> = [
    ["06:05:47", -0.254, 1077731.0, 35928],
    ["06:15:46", -0.353, 1077625.0, 35915],
    ["06:25:47", -0.452, 1077489.3, 35902],
    ["06:35:47", -0.552, 1077323.8, 35887],
    ["06:45:46", -0.651, 1077128.6, 35872],
    ["06:55:46", -0.75, 1076903.6, 35856],
    ["07:05:46", -0.849, 1076648.8, 35838],
    ["07:15:46", -0.948, 1076364.3, 35820],
    ["07:25:46", -1.048, 1076050.0, 35800],
    ["07:35:47", -1.147, 1075706.0, 35780],
    ["07:45:46", -1.246, 1075332.2, 35759],
    ["07:55:46", -1.345, 1074928.6, 35736],
    ["08:05:47", -1.444, 1074495.3, 35713],
    ["08:15:47", -1.544, 1074032.2, 35689],
    ["08:22:57", -1.613, 1073548.2, 35664],
    ["08:25:47", -1.643, 1073268.8, 35643],
    ["08:31:52", -1.702, 1072758.1, 35621],
    ["08:35:46", -1.742, 1072351.1, 35599],
    ["08:41:53", -1.802, 1071810.7, 35577],
    ["08:45:47", -1.841, 1071379.7, 35556],
    ["08:51:52", -1.901, 1070809.5, 35533],
    ["08:55:46", -1.94, 1070353.9, 35511],
    ["09:00:12", -1.98, 1069827.6, 35489],
    ["09:06:55", -2.05, 1069212.7, 35465],
    ["09:16:56", -2.149, 1068568.1, 35439],
    ["09:26:55", -2.248, 1067893.7, 35411],
    ["09:36:59", -2.347, 1067189.5, 35381],
    ["09:43:55", -2.417, 1066464.5, 35350],
    ["09:47:34", -2.446, 1065927.9, 35322],
    ["09:51:55", -2.496, 1065275.4, 35294],
    ["09:57:38", -2.546, 1064511.7, 35265],
    ["10:01:29", -2.585, 1063913.9, 35237],
    ["10:07:10", -2.645, 1063120.5, 35208],
    ["10:15:51", -2.734, 1062300.2, 35176],
    ["10:21:16", -2.784, 1061465.1, 35144],
    ["10:26:39", -2.833, 1060615.1, 35111],
    ["10:31:57", -2.893, 1059747.3, 35078],
    ["10:35:37", -2.923, 1059103.7, 35047],
    ["10:43:17", -3.002, 1058203.1, 35013],
    ["10:45:35", -3.022, 1057784.7, 34984],
    ["10:50:16", -3.062, 1056923.7, 34954],
    ["10:55:36", -3.121, 1055987.4, 34922],
    ["11:01:58", -3.19, 1055030.3, 34887],
    ["11:05:12", -3.22, 1054407.4, 34856],
    ["11:11:24", -3.28, 1053423.5, 34822],
    ["11:15:41", -3.319, 1052569.7, 34788],
    ["11:25:14", -3.419, 1051544.1, 34751],
    ["11:34:51", -3.518, 1050488.7, 34712],
    ["11:35:39", -3.518, 1050320.4, 34681],
    ["11:40:00", -3.567, 1049389.8, 34649],
    ["11:45:14", -3.617, 1048304.6, 34614],
    ["11:55:20", -3.716, 1047189.8, 34575],
    ["12:04:29", -3.806, 1046048.1, 34534],
    ["12:08:41", -3.845, 1045077.7, 34494],
    ["12:10:13", -3.865, 1044723.1, 34461],
  ];

  it("reproduces frozen rows within rounding tolerance, recovers <=5000s, and restores shadow output on non-negative reversal", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-recovery-trace-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    const maxIntervalSeconds = 36_000;
    store.configureController({ maxIntervalSeconds });

    const baseDate = "2026-09-07";
    const reset = "2026-09-14T00:00:00.000Z";
    const windowMs = 7 * 24 * 60 * 60 * 1000;

    try {
      // Seed row 0 with public reported state and assumed -0.0002 derivative
      const seedTime = `${baseDate}T${TRACE[0][0]}.000Z`;
      const seedMs = Date.parse(seedTime);
      const seedTimePct = ((Date.parse(reset) - seedMs) / windowMs) * 100;
      const seedError = TRACE[0][1];
      const seedPercentLeft = seedTimePct - seedError;
      const seedIntegral = TRACE[0][2];
      const seedInterval = TRACE[0][3];
      const seedSlot = Math.floor(seedMs / (5 * 60 * 1000));

      store.db
        .prepare(
          `INSERT INTO quota_observations
            (provider, kind, observed_slot, label, observed_at, percent_left, reset_at_iso, window_ms,
             processed, controller_error, controller_derivative, controller_integral,
             uncapped_interval_seconds, interval_seconds,
             commanded_interval_seconds, commanded_uncapped_interval_seconds, recovery_credit_seconds)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
        )
        .run(
          "kimi",
          "weekly",
          seedSlot,
          "weekly limit",
          seedTime,
          seedPercentLeft,
          reset,
          windowMs,
          seedError,
          -0.0002,
          seedIntegral,
          seedInterval,
          seedInterval
        );

      // Record subsequent 54 observations
      for (let index = 1; index < TRACE.length; index += 1) {
        const [time, error] = TRACE[index];
        const observedAt = `${baseDate}T${time}.000Z`;
        const observedMs = Date.parse(observedAt);
        const timePct = ((Date.parse(reset) - observedMs) / windowMs) * 100;
        const percentLeft = timePct - error;
        recordObservation(store, "kimi", observedAt, percentLeft, reset, "weekly");
      }

      const rows = reasonedRows(store, "kimi");
      expect(rows).toHaveLength(55);

      let maxIntegralDelta = 0;
      let maxIntervalDelta = 0;

      for (let i = 1; i < TRACE.length; i += 1) {
        const row = rows[i];
        const [, , expectedObservedIntegral, expectedObservedInterval] = TRACE[i];
        const integralDelta = Math.abs(row.integral - expectedObservedIntegral);
        const intervalDelta = Math.abs(row.interval - expectedObservedInterval);
        maxIntegralDelta = Math.max(maxIntegralDelta, integralDelta);
        maxIntervalDelta = Math.max(maxIntervalDelta, intervalDelta);
      }

      // Published acceptance case: within 5.7 integral units and 0.6 seconds
      expect(Number(maxIntegralDelta.toFixed(1))).toBeLessThanOrEqual(5.7);
      expect(Number(maxIntervalDelta.toFixed(1))).toBeLessThanOrEqual(0.6);

      // Row 1 (06:15:46) is the 2nd negative observation: credit not active yet
      expect(rows[1].credit).toBeNull();
      expect(rows[1].commandedInterval).toBeNull();

      // Row 2 (06:25:47) is the 3rd negative observation: credit activates
      expect(rows[2].credit).toBeGreaterThan(0);
      expect(rows[2].commandedInterval).toBeLessThan(rows[2].interval);

      // Final row (12:10:13): <= 5,000 seconds
      const finalRow = rows[54];
      expect(finalRow.commandedInterval).toBeLessThanOrEqual(5000);
      expect(finalRow.commandedInterval).toBeCloseTo(4105.1, 0);
      expect(finalRow.interval).toBeCloseTo(34460.9, 0);
      expect(finalRow.credit).toBeCloseTo(30778.3, 0);

      // First non-negative observation (+10 error reversal) restores shadow actuator in that same update
      const lastTraceTime = TRACE.at(-1)?.[0] ?? "12:10:13";
      const reversalTime = new Date(
        Date.parse(`${baseDate}T${lastTraceTime}.000Z`) + 300_000
      ).toISOString();
      const reversalMs = Date.parse(reversalTime);
      const reversalTimePct = ((Date.parse(reset) - reversalMs) / windowMs) * 100;
      recordObservation(store, "kimi", reversalTime, reversalTimePct - 10, reset, "weekly");

      const reversalRow = reasonedRows(store, "kimi").at(-1) as ReasonedRow;
      expect(reversalRow.error).toBeCloseTo(10, 4);
      expect(reversalRow.credit).toBeNull();
      expect(reversalRow.commandedInterval).toBeNull();
      // Reversal immediately restores the shadow output (34,854.6 s) bypassing upward smoothing/slew
      expect(reversalRow.interval).toBeCloseTo(34854.6, 0);
      expect(store.getProviderThrottle("kimi")?.intervalSeconds).toBeCloseTo(34854.6, 0);

      // Continuous +10 overspend for 24 hours sustains near cap and ends at 36,000s
      let lastTimeMs = reversalMs;
      for (let step = 2; step <= 24 * 12; step += 1) {
        lastTimeMs += 300_000;
        const stepTime = new Date(lastTimeMs).toISOString();
        const stepTimePct = ((Date.parse(reset) - lastTimeMs) / windowMs) * 100;
        recordObservation(store, "kimi", stepTime, stepTimePct - 10, reset, "weekly");
      }

      const allRows = reasonedRows(store, "kimi");
      const postReversalRows = allRows.slice(55);
      const nearCapCount = postReversalRows.filter(
        (r) => r.interval >= 0.9 * maxIntervalSeconds
      ).length;
      expect(nearCapCount / 12).toBeCloseTo(24.0, 1);
      const lastKimiRow = allRows.at(-1) as ReasonedRow;
      expect(lastKimiRow.interval).toBe(maxIntervalSeconds);
    } finally {
      store.close();
    }
  });

  it("applies no behavior difference outside recovery and enforces the deliberate cap", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-recovery-outside-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    const maxIntervalSeconds = 36_000;
    store.configureController({ maxIntervalSeconds });

    const baseMs = Date.parse("2030-01-04T12:00:00.000Z");
    const reset = "2030-01-08T00:00:00.000Z";
    const windowMs = 7 * 24 * 60 * 60 * 1000;

    try {
      // Steady overspend (+10 error): credit never activates, commandedInterval is null
      for (let slot = 0; slot < 10; slot += 1) {
        const observedMs = baseMs + slot * 300_000;
        const timePct = ((Date.parse(reset) - observedMs) / windowMs) * 100;
        recordObservation(store, "claude", new Date(observedMs).toISOString(), timePct - 10, reset);
      }

      const rows = reasonedRows(store, "claude");
      expect(rows).toHaveLength(10);
      for (const row of rows) {
        expect(row.credit).toBeNull();
        expect(row.commandedInterval).toBeNull();
        expect(row.interval).toBeLessThanOrEqual(maxIntervalSeconds);
      }

      // Transient negative observations that don't reach confirmation count (e.g. 2 negative samples then positive)
      const t1Ms = baseMs + 10 * 300_000;
      const t1Pct = ((Date.parse(reset) - t1Ms) / windowMs) * 100;
      recordObservation(store, "claude", new Date(t1Ms).toISOString(), t1Pct - -2, reset); // neg 1

      const t2Ms = baseMs + 11 * 300_000;
      const t2Pct = ((Date.parse(reset) - t2Ms) / windowMs) * 100;
      recordObservation(store, "claude", new Date(t2Ms).toISOString(), t2Pct - -3, reset); // neg 2

      const t3Ms = baseMs + 12 * 300_000;
      const t3Pct = ((Date.parse(reset) - t3Ms) / windowMs) * 100;
      recordObservation(store, "claude", new Date(t3Ms).toISOString(), t3Pct - 1, reset); // pos error

      const laterRows = reasonedRows(store, "claude");
      expect(laterRows[10].credit).toBeNull();
      expect(laterRows[10].commandedInterval).toBeNull();
      expect(laterRows[11].credit).toBeNull();
      expect(laterRows[11].commandedInterval).toBeNull();
      expect(laterRows[12].credit).toBeNull();
      expect(laterRows[12].commandedInterval).toBeNull();
    } finally {
      store.close();
    }
  });

  it("gates credit on exactly three consecutive negative errors and resets gate on non-negative observation", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-recovery-gate-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    store.configureController({ maxIntervalSeconds: 36_000 });

    const baseMs = Date.parse("2030-01-04T12:00:00.000Z");
    const reset = "2030-01-08T00:00:00.000Z";
    const windowMs = 7 * 24 * 60 * 60 * 1000;

    try {
      expect(QUOTA_RECOVERY_CONFIRMATIONS).toBe(3);

      // Seed initial positive accumulated integral (100,000) and zero credit
      seedObservation(store, "claude", new Date(baseMs).toISOString(), 50, reset, {
        integral: 100_000,
        interval: 3000,
        error: 0,
      });

      // 1st negative observation (-0.5 error, percentLeft increases smoothly by 0.5 points)
      const s1 = baseMs + 300_000;
      const s1Pct = ((Date.parse(reset) - s1) / windowMs) * 100;
      recordObservation(store, "claude", new Date(s1).toISOString(), s1Pct - -0.5, reset);
      let rows = reasonedRows(store, "claude");
      expect(rows.at(-1)?.credit).toBeNull();

      // 2nd negative observation (-0.5 error)
      const s2 = baseMs + 2 * 300_000;
      const s2Pct = ((Date.parse(reset) - s2) / windowMs) * 100;
      recordObservation(store, "claude", new Date(s2).toISOString(), s2Pct - -0.5, reset);
      rows = reasonedRows(store, "claude");
      expect(rows.at(-1)?.credit).toBeNull();

      // Interrupt with non-negative observation (zero error)
      const s3 = baseMs + 3 * 300_000;
      const s3Pct = ((Date.parse(reset) - s3) / windowMs) * 100;
      recordObservation(store, "claude", new Date(s3).toISOString(), s3Pct, reset);
      rows = reasonedRows(store, "claude");
      expect(rows.at(-1)?.credit).toBeNull();

      // Start fresh sequence: negative 1, negative 2, negative 3
      const s4 = baseMs + 4 * 300_000;
      const s4Pct = ((Date.parse(reset) - s4) / windowMs) * 100;
      recordObservation(store, "claude", new Date(s4).toISOString(), s4Pct - -0.5, reset);
      expect(reasonedRows(store, "claude").at(-1)?.credit).toBeNull();

      const s5 = baseMs + 5 * 300_000;
      const s5Pct = ((Date.parse(reset) - s5) / windowMs) * 100;
      recordObservation(store, "claude", new Date(s5).toISOString(), s5Pct - -0.5, reset);
      expect(reasonedRows(store, "claude").at(-1)?.credit).toBeNull();

      const s6 = baseMs + 6 * 300_000;
      const s6Pct = ((Date.parse(reset) - s6) / windowMs) * 100;
      recordObservation(store, "claude", new Date(s6).toISOString(), s6Pct - -0.5, reset);
      const row6 = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(row6.credit).toBeGreaterThan(0);
      expect(row6.commandedInterval).toBeLessThan(row6.interval);
    } finally {
      store.close();
    }
  });

  it("reconstructs controller and recovery credit state identically across store restart", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-recovery-restart-"));
    roots.push(root);
    const dbPath = join(root, "shared.db");
    const store = new SharedQuotaStore(dbPath);
    store.configureController({ maxIntervalSeconds: 36_000 });

    const baseMs = Date.parse("2030-01-04T12:00:00.000Z");
    const reset = "2030-01-08T00:00:00.000Z";
    const windowMs = 7 * 24 * 60 * 60 * 1000;

    try {
      // Seed high positive integral
      seedObservation(store, "claude", new Date(baseMs).toISOString(), 50, reset, {
        integral: 100_000,
        interval: 3000,
        error: 0,
      });

      // Advance into recovery with consecutive negative errors
      for (let i = 1; i <= 5; i += 1) {
        const t = baseMs + i * 300_000;
        const timePct = ((Date.parse(reset) - t) / windowMs) * 100;
        recordObservation(store, "claude", new Date(t).toISOString(), timePct - -0.5, reset);
      }

      const beforeClose = reasonedRows(store, "claude");
      const lastBeforeClose = beforeClose.at(-1) as ReasonedRow;
      expect(lastBeforeClose.credit).toBeGreaterThan(0);
      expect(lastBeforeClose.commandedInterval).toBeLessThan(lastBeforeClose.interval);

      // Close store to simulate process termination
      store.close();

      // Open new store on the same database
      const reopened = new SharedQuotaStore(dbPath);
      reopened.configureController({ maxIntervalSeconds: 36_000 });

      // Check provider throttle reads back persisted commanded interval
      const throttle = reopened.getProviderThrottle("claude");
      expect(lastBeforeClose.commandedInterval).toBeTypeOf("number");
      expect(throttle?.intervalSeconds).toBeCloseTo(lastBeforeClose.commandedInterval ?? 0, 6);

      // Advance one more negative observation after restart
      const nextNegativeMs = baseMs + 6 * 300_000;
      const nextNegativePct = ((Date.parse(reset) - nextNegativeMs) / windowMs) * 100;
      recordObservation(
        reopened,
        "claude",
        new Date(nextNegativeMs).toISOString(),
        nextNegativePct - -0.5,
        reset
      );

      const afterRestartRows = reasonedRows(reopened, "claude");
      const nextRow = afterRestartRows.at(-1) as ReasonedRow;
      expect(nextRow.credit).toBeGreaterThan(lastBeforeClose.credit ?? 0);
      expect(nextRow.commandedInterval).toBeLessThan(nextRow.interval);

      // Advance a non-negative observation (+1 error reversal) after restart
      const reversalMs = baseMs + 7 * 300_000;
      const reversalPct = ((Date.parse(reset) - reversalMs) / windowMs) * 100;
      recordObservation(
        reopened,
        "claude",
        new Date(reversalMs).toISOString(),
        reversalPct - 1,
        reset
      );

      const reversalRow = reasonedRows(reopened, "claude").at(-1) as ReasonedRow;
      expect(reversalRow.credit).toBeNull();
      expect(reversalRow.commandedInterval).toBeNull();
      expect(nextRow.commandedInterval).toBeTypeOf("number");
      expect(reversalRow.interval).toBeGreaterThan(nextRow.commandedInterval ?? 0);
      expect(reopened.getProviderThrottle("claude")?.intervalSeconds).toBeCloseTo(
        reversalRow.interval,
        6
      );

      reopened.close();
    } finally {
      // Nothing needed as reopened is closed above
    }
  });

  it("resets recovery credit and gate on quota rollover or refill boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-recovery-rollover-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    store.configureController({ maxIntervalSeconds: 36_000 });

    const baseMs = Date.parse("2030-01-04T12:00:00.000Z");
    const reset1 = "2030-01-08T00:00:00.000Z";
    const windowMs = 7 * 24 * 60 * 60 * 1000;

    try {
      // Seed with active recovery credit
      seedObservation(store, "claude", new Date(baseMs).toISOString(), 50, reset1, {
        integral: 100_000,
        interval: 3000,
        error: -0.5,
      });
      seedObservation(store, "claude", new Date(baseMs + 300_000).toISOString(), 50, reset1, {
        integral: 100_000,
        interval: 3000,
        error: -0.5,
      });
      seedObservation(store, "claude", new Date(baseMs + 600_000).toISOString(), 50, reset1, {
        integral: 100_000,
        interval: 3000,
        commandedInterval: 2000,
        commandedUncapped: 2000,
        credit: 1000,
        error: -0.5,
      });

      const beforeRollover = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(beforeRollover.credit).toBeGreaterThan(0);

      // Window rollover: reset instant moves to next week
      const rolloverTime = "2030-01-11T12:00:00.000Z";
      const reset2 = "2030-01-15T00:00:00.000Z";
      recordObservation(store, "claude", rolloverTime, 50, reset2);

      const rolloverRow = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(rolloverRow.integral).toBe(0);
      expect(rolloverRow.derivative).toBe(0);
      expect(rolloverRow.credit).toBeNull();
      expect(rolloverRow.commandedInterval).toBeNull();

      // Seed recovery state in cycle 2
      const cycle2Time = Date.parse(rolloverTime) + 300_000;
      seedObservation(store, "claude", new Date(cycle2Time).toISOString(), 20, reset2, {
        integral: 100_000,
        interval: 3000,
        error: -0.5,
      });
      seedObservation(store, "claude", new Date(cycle2Time + 300_000).toISOString(), 20, reset2, {
        integral: 100_000,
        interval: 3000,
        error: -0.5,
      });
      seedObservation(store, "claude", new Date(cycle2Time + 600_000).toISOString(), 20, reset2, {
        integral: 100_000,
        interval: 3000,
        commandedInterval: 2000,
        commandedUncapped: 2000,
        credit: 1000,
        error: -0.5,
      });
      const beforeRefill = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(beforeRefill.credit).toBeGreaterThan(0);

      // Refill boundary: quota jumps sharply (+15 points) without reset moving, error > 0
      const refillTime = new Date(cycle2Time + 900_000).toISOString();
      const refillMs = Date.parse(refillTime);
      const refillTimePct = ((Date.parse(reset2) - refillMs) / windowMs) * 100;
      recordObservation(store, "claude", refillTime, refillTimePct - 5, reset2);
      const refillRow = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(refillRow.integral).toBe(0);
      expect(refillRow.credit).toBeNull();
      expect(refillRow.commandedInterval).toBeNull();
    } finally {
      store.close();
    }
  });

  it("bounds single-step credit growth across large observation gaps to one hour", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-recovery-gap-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    store.configureController({ maxIntervalSeconds: 36_000 });

    const baseMs = Date.parse("2030-01-04T12:00:00.000Z");
    const reset = "2030-01-08T00:00:00.000Z";
    const windowMs = 7 * 24 * 60 * 60 * 1000;

    try {
      // Seed with 2 consecutive negative errors and positive integral
      seedObservation(store, "claude", new Date(baseMs).toISOString(), 50, reset, {
        integral: 100_000,
        interval: 3000,
        error: -0.5,
      });
      seedObservation(store, "claude", new Date(baseMs + 300_000).toISOString(), 50, reset, {
        integral: 100_000,
        interval: 3000,
        error: -0.5,
      });

      // 3rd negative observation: credit activates
      const step1Ms = baseMs + 600_000;
      const step1Pct = ((Date.parse(reset) - step1Ms) / windowMs) * 100;
      recordObservation(store, "claude", new Date(step1Ms).toISOString(), step1Pct - -0.5, reset);

      const rowsBeforeGap = reasonedRows(store, "claude");
      const beforeGap = rowsBeforeGap.at(-1) as ReasonedRow;
      expect(beforeGap.credit).toBeGreaterThan(0);

      // Now introduce a 24-hour observation gap (86,400 seconds)
      const gapMs = 24 * 60 * 60 * 1000;
      const afterGapMs = step1Ms + gapMs;
      const afterGapTime = new Date(afterGapMs).toISOString();
      const afterGapTimePct = ((Date.parse(reset) - afterGapMs) / windowMs) * 100;
      // error is still negative (-0.5), percentLeft is afterGapTimePct - (-0.5)
      recordObservation(store, "claude", afterGapTime, afterGapTimePct - -0.5, reset);

      const afterGapRow = reasonedRows(store, "claude").at(-1) as ReasonedRow;

      // Credit alpha must be capped to 1 hour (3600 seconds), NOT 24 hours
      const expectedAlpha =
        1 - 2 ** (-QUOTA_RECOVERY_MAX_ELAPSED_SECONDS / QUOTA_RECOVERY_HALF_LIFE_SECONDS);
      expect(expectedAlpha).toBeCloseTo(1 - 2 ** -0.5, 6);

      const uncappedAlpha = 1 - 2 ** (-86_400 / QUOTA_RECOVERY_HALF_LIFE_SECONDS);
      // Uncapped alpha would have been ~0.99975, while expected capped alpha is ~0.29289
      expect(expectedAlpha).toBeLessThan(0.3);
      expect(uncappedAlpha).toBeGreaterThan(0.99);

      const targetCredit = (120 / 3600) * afterGapRow.integral;
      const expectedCredit =
        (beforeGap.credit ?? 0) + expectedAlpha * (targetCredit - (beforeGap.credit ?? 0));
      expect(afterGapRow.credit).toBeCloseTo(expectedCredit, 4);
    } finally {
      store.close();
    }
  });

  it("derives the 3-sample gate across restart and resets gate when refill or rollover occurs", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-recovery-gate-restart-"));
    roots.push(root);
    const dbPath = join(root, "shared.db");
    const store = new SharedQuotaStore(dbPath);
    store.configureController({ maxIntervalSeconds: 36_000 });

    const baseMs = Date.parse("2030-01-04T12:00:00.000Z");
    const reset = "2030-01-08T00:00:00.000Z";
    const windowMs = 7 * 24 * 60 * 60 * 1000;

    try {
      // Seed high positive integral
      seedObservation(store, "claude", new Date(baseMs).toISOString(), 50, reset, {
        integral: 100_000,
        interval: 3000,
        error: 0,
      });

      // Sample 1: negative error
      const s1 = baseMs + 300_000;
      const s1Pct = ((Date.parse(reset) - s1) / windowMs) * 100;
      recordObservation(store, "claude", new Date(s1).toISOString(), s1Pct - -0.5, reset);
      expect(reasonedRows(store, "claude").at(-1)?.credit).toBeNull();

      // Sample 2: negative error
      const s2 = baseMs + 600_000;
      const s2Pct = ((Date.parse(reset) - s2) / windowMs) * 100;
      recordObservation(store, "claude", new Date(s2).toISOString(), s2Pct - -0.5, reset);
      expect(reasonedRows(store, "claude").at(-1)?.credit).toBeNull();

      // Restart process between sample 2 and sample 3
      store.close();
      const reopened = new SharedQuotaStore(dbPath);
      reopened.configureController({ maxIntervalSeconds: 36_000 });

      // Sample 3 after restart: 3rd negative observation in same cycle activates credit!
      const s3 = baseMs + 900_000;
      const s3Pct = ((Date.parse(reset) - s3) / windowMs) * 100;
      recordObservation(reopened, "claude", new Date(s3).toISOString(), s3Pct - -0.5, reset);
      const row3 = reasonedRows(reopened, "claude").at(-1) as ReasonedRow;
      expect(row3.credit).toBeGreaterThan(0);
      expect(row3.commandedInterval).toBeLessThan(row3.interval);

      // Now test refill boundary occurring after 2 negative samples:
      // Sample 4: refill (+10 points jump in quota), error still negative (-0.5)
      const s4 = baseMs + 1200_000;
      const s4Pct = ((Date.parse(reset) - s4) / windowMs) * 100;
      recordObservation(reopened, "claude", new Date(s4).toISOString(), s4Pct - -0.5 + 10, reset);
      const row4 = reasonedRows(reopened, "claude").at(-1) as ReasonedRow;
      // Refill reset cycle, so credit must be null
      expect(row4.credit).toBeNull();

      // In the new cycle, seed positive integral so credit has an accumulator to offset
      const s5 = baseMs + 1500_000;
      const s5Pct = ((Date.parse(reset) - s5) / windowMs) * 100;
      seedObservation(reopened, "claude", new Date(s5).toISOString(), s5Pct - -0.5 + 10, reset, {
        integral: 100_000,
        interval: 3000,
        error: -0.5,
      });
      // Sample 1 of negative error run in new cycle: gate not met
      expect(reasonedRows(reopened, "claude").at(-1)?.credit).toBeNull();

      // Sample 3: negative error (3rd consecutive sample in this new cycle) -> gate triggers!
      const s6 = baseMs + 1800_000;
      const s6Pct = ((Date.parse(reset) - s6) / windowMs) * 100;
      recordObservation(reopened, "claude", new Date(s6).toISOString(), s6Pct - -0.5 + 10, reset);
      const row6 = reasonedRows(reopened, "claude").at(-1) as ReasonedRow;
      expect(row6.credit).toBeGreaterThan(0);
      expect(row6.commandedInterval).toBeLessThan(row6.interval);

      reopened.close();
    } finally {
      // closed above
    }
  });

  it("preserves protective shadow state for legacy writers and falls back safely when additive columns are NULL", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-legacy-fallback-"));
    roots.push(root);
    const dbPath = join(root, "shared.db");
    const store = new SharedQuotaStore(dbPath);
    store.configureController({ maxIntervalSeconds: 36_000 });

    const baseMs = Date.parse("2030-01-04T12:00:00.000Z");
    const reset = "2030-01-08T00:00:00.000Z";
    const windowMs = 7 * 24 * 60 * 60 * 1000;

    try {
      // 1. Simulate a legacy / pre-upgrade row with NULL additive command columns
      const s1 = baseMs;
      const s1Slot = Math.floor(s1 / (5 * 60 * 1000));
      const s1Pct = ((Date.parse(reset) - s1) / windowMs) * 100;
      store.db
        .prepare(
          `INSERT INTO quota_observations
            (provider, kind, observed_slot, label, observed_at, percent_left, reset_at_iso, window_ms,
             processed, controller_error, controller_derivative, controller_integral,
             uncapped_interval_seconds, interval_seconds,
             commanded_interval_seconds, commanded_uncapped_interval_seconds, recovery_credit_seconds)
            VALUES ('claude', 'weekly', ?, 'weekly limit', ?, ?, ?, ?, 1, 0, 0, 1100000, 38000, 36000, NULL, NULL, NULL)`
        )
        .run(s1Slot, new Date(s1).toISOString(), s1Pct - -0.5, reset, windowMs);

      // Verify getProviderThrottle correctly falls back to interval_seconds and uncapped_interval_seconds
      const throttle = store.getProviderThrottle("claude");
      expect(throttle?.intervalSeconds).toBe(36000);
      expect(throttle?.uncappedIntervalSeconds).toBe(38000);
      expect(throttle?.capped).toBe(true);
      expect(throttle?.buckets[0].requiredIntervalSeconds).toBe(36000);

      // 2. New code processes an observation following the legacy row
      // It must safely resume from the protective interval_seconds (36000)
      const s2 = baseMs + 300_000;
      const s2Pct = ((Date.parse(reset) - s2) / windowMs) * 100;
      recordObservation(store, "claude", new Date(s2).toISOString(), s2Pct - -0.5, reset);

      const rows = reasonedRows(store, "claude");
      expect(rows).toHaveLength(2);
      const row2 = rows[1];
      expect(row2.credit).toBeNull();
      expect(row2.commandedInterval).toBeNull();
      expect(row2.interval).toBeGreaterThanOrEqual(36000 - QUOTA_MAX_SLEW_SECONDS);

      // 3. Advance to credit activation
      const s3 = baseMs + 600_000;
      const s3Pct = ((Date.parse(reset) - s3) / windowMs) * 100;
      recordObservation(store, "claude", new Date(s3).toISOString(), s3Pct - -0.5, reset);
      const s4 = baseMs + 900_000;
      const s4Pct = ((Date.parse(reset) - s4) / windowMs) * 100;
      recordObservation(store, "claude", new Date(s4).toISOString(), s4Pct - -0.5, reset);

      const row4 = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(row4.credit).toBeGreaterThan(0);
      expect(row4.commandedInterval).toBeLessThan(row4.interval);

      // 4. Simulate an old shared writer (or rollback) writing the next row:
      // The old writer sets interval_seconds and uncapped_interval_seconds, leaving commanded columns NULL
      const s5 = baseMs + 1200_000;
      const s5Slot = Math.floor(s5 / (5 * 60 * 1000));
      const s5Pct = ((Date.parse(reset) - s5) / windowMs) * 100;
      store.db
        .prepare(
          `INSERT INTO quota_observations
            (provider, kind, observed_slot, label, observed_at, percent_left, reset_at_iso, window_ms,
             processed, controller_error, controller_derivative, controller_integral,
             uncapped_interval_seconds, interval_seconds,
             commanded_interval_seconds, commanded_uncapped_interval_seconds, recovery_credit_seconds)
            VALUES ('claude', 'weekly', ?, 'weekly limit', ?, ?, ?, ?, 1, -0.5, 0, 1100000, 35000, 35000, NULL, NULL, NULL)`
        )
        .run(s5Slot, new Date(s5).toISOString(), s5Pct - -0.5, reset, windowMs);

      // When new code runs on the next sample (s6), it reads the old writer's row:
      // It falls back safely to the old writer's protective interval (35000) and resumes safely
      const s6 = baseMs + 1500_000;
      const s6Pct = ((Date.parse(reset) - s6) / windowMs) * 100;
      recordObservation(store, "claude", new Date(s6).toISOString(), s6Pct - -0.5, reset);

      const row6 = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      expect(Math.abs(row6.interval - 35000)).toBeLessThanOrEqual(QUOTA_MAX_SLEW_SECONDS);
      expect(row6.commandedInterval).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("replays metadata against a pre-upgrade schema snapshot with dynamic projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-replay-legacy-"));
    roots.push(root);
    const dbPath = join(root, "legacy-quota.db");

    // Create legacy DB with pre-upgrade schema (no commanded or credit columns)
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE quota_scrapes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        scraped_at TEXT NOT NULL,
        parsed_state TEXT NOT NULL
      );
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
        controller_integral REAL,
        uncapped_interval_seconds REAL,
        interval_seconds REAL,
        PRIMARY KEY(provider, kind, observed_slot)
      );
    `);
    db.prepare(
      `INSERT INTO quota_scrapes (provider, scraped_at, parsed_state)
       VALUES ('codex', '2026-09-07T12:00:00.000Z', ?)`
    ).run(
      JSON.stringify({
        provider: "codex",
        status: "available",
        scrapedAt: "2026-09-07T12:00:00.000Z",
        limits: [{ scope: "provider", percentLeft: 85 }],
      })
    );
    db.prepare(
      `INSERT INTO quota_observations
        (provider, kind, observed_slot, label, observed_at, percent_left, reset_at_iso, window_ms,
         processed, controller_error, controller_derivative, controller_integral,
         uncapped_interval_seconds, interval_seconds)
       VALUES ('codex', 'weekly', 100, 'Weekly', '2026-09-07T12:00:00.000Z', 85,
               '2026-09-14T00:00:00.000Z', 604800000, 1, -1, 0, 1000, 500, 500)`
    ).run();
    db.close();

    // Query pre-upgrade database using dynamic observation projection helper
    const dbRead = new Database(dbPath, { readonly: true });
    try {
      const projection = getObservationProjection(dbRead);
      expect(projection).toContain("NULL AS commanded_interval_seconds");
      expect(projection).toContain("NULL AS commanded_uncapped_interval_seconds");
      expect(projection).toContain("NULL AS recovery_credit_seconds");
      expect(projection).toContain("interval_seconds");

      const observations = dbRead
        .prepare(
          `SELECT ${projection}
           FROM quota_observations
           WHERE provider = 'codex' AND observed_at >= ?
           ORDER BY observed_at ASC, rowid ASC`
        )
        .all("2026-09-07T00:00:00.000Z") as Array<{
        interval_seconds: number;
        commanded_interval_seconds: number | null;
        recovery_credit_seconds: number | null;
      }>;
      expect(observations).toHaveLength(1);
      const obs = observations[0];
      expect(obs.interval_seconds).toBe(500);
      expect(obs.commanded_interval_seconds).toBeNull();
      expect(obs.recovery_credit_seconds).toBeNull();
    } finally {
      dbRead.close();
    }

    // Verify SharedQuotaStore widens the pre-upgrade DB seamlessly
    const store = new SharedQuotaStore(dbPath);
    try {
      const dbWidened = new Database(dbPath, { readonly: true });
      try {
        const widenedProjection = getObservationProjection(dbWidened);
        expect(widenedProjection).not.toContain("NULL AS commanded_interval_seconds");
        expect(widenedProjection).not.toContain("NULL AS recovery_credit_seconds");
        const widenedObs = dbWidened
          .prepare(
            `SELECT ${widenedProjection}
             FROM quota_observations
             WHERE provider = 'codex' AND observed_at >= ?
             ORDER BY observed_at ASC, rowid ASC`
          )
          .all("2026-09-07T00:00:00.000Z") as Array<{
          interval_seconds: number;
          commanded_interval_seconds: number | null;
          recovery_credit_seconds: number | null;
        }>;
        expect(widenedObs).toHaveLength(1);
        expect(widenedObs[0].interval_seconds).toBe(500);
        expect(widenedObs[0].commanded_interval_seconds).toBeNull();
      } finally {
        dbWidened.close();
      }
    } finally {
      store.close();
    }
  });
});
