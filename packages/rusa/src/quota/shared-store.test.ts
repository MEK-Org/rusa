import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderQuotaSnapshot, QuotaWindowKind } from "../mcp/quota-mcp.js";
import {
  QUOTA_OBSERVATION_RETENTION_MS,
  QUOTA_RAW_RETENTION_MS,
  SharedQuotaStore,
} from "./shared-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function legacyDb(
  root: string,
  rows: Array<{
    id: string;
    scrapedAt: string;
    sourceLabel: string;
    percentLeft: number;
    resetAtIso?: string;
  }>
): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, "legacy.db");
  const db = new Database(path);
  db.exec(`CREATE TABLE quota_scrapes (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, scraped_at TEXT NOT NULL,
    raw_output TEXT NOT NULL, parsed_state TEXT, inferred_parsed_state TEXT,
    parse_error TEXT
  )`);
  const insert = db.prepare(`INSERT INTO quota_scrapes VALUES (?, 'agy', ?, 'raw', ?, ?, NULL)`);
  for (const row of rows) {
    const state: ProviderQuotaSnapshot = {
      provider: "agy",
      status: "available",
      scrapedAt: row.scrapedAt,
      limits: [
        {
          label: row.sourceLabel,
          kind: "weekly",
          scope: "provider",
          percentLeft: row.percentLeft,
          resetAtIso: row.resetAtIso,
        },
      ],
    };
    insert.run(row.id, row.scrapedAt, JSON.stringify(state), JSON.stringify(state));
  }
  db.close();
  return path;
}

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

describe("SharedQuotaStore migration", () => {
  it("is idempotent and prefers the source with resolvable reset evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-"));
    roots.push(root);
    const at = "2026-08-25T12:00:00.000Z";
    const weak = legacyDb(join(root, "weak"), [
      {
        id: "weak-1",
        scrapedAt: at,
        sourceLabel: "Weekly Limit",
        percentLeft: 50,
      },
    ]);
    const strongRoot = join(root, "strong");
    const strong = legacyDb(strongRoot, [
      {
        id: "strong-1",
        scrapedAt: at,
        sourceLabel: "Weekly Limit Remaining",
        percentLeft: 50,
        resetAtIso: "2026-08-29T12:00:00.000Z",
      },
    ]);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.importLegacyDatabase(weak, "staging");
      store.importLegacyDatabase(strong, "production");
      expect(store.importLegacyDatabase(strong, "production").insertedRows).toBe(0);
      const selected = store.listCanonicalSince("agy", "2026-08-25T00:00:00.000Z");
      expect(selected).toHaveLength(1);
      expect(selected[0]?.resetAtIso).toBe("2026-08-29T12:00:00.000Z");
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
