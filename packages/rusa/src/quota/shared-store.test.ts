import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";
import { canonicalQuotaBucketIdentity } from "./bucket-key.js";
import { SharedQuotaStore } from "./shared-store.js";

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
  resetAtIso: string
): void {
  const state: ProviderQuotaSnapshot = {
    provider,
    status: percentLeft <= 0 ? "exhausted" : "available",
    scrapedAt,
    limits: [
      {
        label: "Weekly limit",
        kind: "weekly",
        scope: "provider",
        percentLeft,
        resetAtIso,
      },
    ],
  };
  const id = store.recordRaw({ provider, scrapedAt, rawOutput: "raw" });
  store.recordParsed(id, state, state);
}

describe("canonicalQuotaBucketIdentity", () => {
  it("does not let presentation label drift split a bucket", () => {
    const a = canonicalQuotaBucketIdentity("shared", "agy", {
      kind: "weekly",
      scope: "provider",
    });
    const b = canonicalQuotaBucketIdentity("shared", "AGY", {
      kind: "weekly",
      scope: "provider",
    });
    expect(a.key).toBe(b.key);
    expect(a.key).toBe("shared:agy:provider:weekly");
  });

  it("repairs legacy missing scopes without splitting keys by model labels", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-legacy-scope-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"), "shared", "test");
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
    const store = new SharedQuotaStore(join(root, "shared.db"), "shared", "test");
    try {
      store.importLegacyDatabase(weak, "staging");
      store.importLegacyDatabase(strong, "production");
      expect(store.importLegacyDatabase(strong, "production").insertedRows).toBe(0);
      const selected = store.listCanonicalSince("agy", "2026-08-25T00:00:00.000Z");
      expect(selected).toHaveLength(1);
      expect(selected[0]?.sourceInstance).toBe("production");
      expect(selected[0]?.resetAtIso).toBe("2026-08-29T12:00:00.000Z");
    } finally {
      store.close();
    }
  });

  it("retains but rejects an isolated 0 to 100 to 0 percent-left spike", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-spike-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const source = legacyDb(sourceRoot, [
      { id: "a", scrapedAt: "2026-08-25T12:00:00.000Z", sourceLabel: "Weekly", percentLeft: 0 },
      { id: "b", scrapedAt: "2026-08-25T12:05:00.000Z", sourceLabel: "Weekly", percentLeft: 100 },
      { id: "c", scrapedAt: "2026-08-25T12:10:00.000Z", sourceLabel: "Weekly", percentLeft: 0 },
    ]);
    const store = new SharedQuotaStore(join(root, "shared.db"), "shared", "test");
    try {
      const report = store.importLegacyDatabase(source, "production");
      expect(report.rejectedAnomalies).toBe(1);
      expect(
        store.listCanonicalSince("agy", "2026-08-25T00:00:00.000Z").map((x) => x.percentLeft)
      ).toEqual([0, 0]);
      expect(
        (store.db.prepare("SELECT count(*) n FROM quota_observations").get() as { n: number }).n
      ).toBe(3);
    } finally {
      store.close();
    }
  });
});

describe("SharedQuotaStore persisted controller", () => {
  it("keeps exhaustion out of throttle decisions and resumes from the prior period", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-controller-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"), "shared", "test");
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
        (store.db.prepare("SELECT count(*) n FROM quota_throttle_decisions").get() as { n: number })
          .n
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
      const decisions = store.listPersistedHistorySince("claude", "2030-01-01T00:00:00.000Z");
      expect(decisions.find((point) => point.percentLeft === 0)?.intervalSeconds).toBeNull();
    } finally {
      store.close();
    }
  });

  it("persists one shared controller and atomically spaces starts across connections", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-connections-"));
    roots.push(root);
    const path = join(root, "shared.db");
    const first = new SharedQuotaStore(path, "shared", "production");
    const second = new SharedQuotaStore(path, "shared", "staging");
    try {
      first.configureController({ maxIntervalSeconds: 3600 });
      recordObservation(first, "agy", "2030-01-01T00:00:00.000Z", 50, "2030-01-08T00:00:00.000Z");
      const intervalMs = (second.getProviderThrottle("agy")?.intervalSeconds ?? 0) * 1000;
      expect(intervalMs).toBeGreaterThan(0);
      const startedAt = Date.parse("2030-01-01T00:01:00.000Z");
      expect(first.claimNormalProviderStart("agy", startedAt)).toBeNull();
      expect(second.claimNormalProviderStart("agy", startedAt)).toBe(startedAt + intervalMs);
    } finally {
      second.close();
      first.close();
    }
  });
});
