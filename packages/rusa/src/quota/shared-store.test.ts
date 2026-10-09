import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inferQuotaState,
  type ProviderQuotaSnapshot,
  type QuotaService,
  type QuotaWindowKind,
} from "../mcp/quota-mcp.js";
import { nullLogger } from "../observability/logger.js";
import { QuotaCoordinatorClient } from "./coordinator-client.js";
import { QuotaCollectionLoop } from "./coordinator-collection.js";
import { QuotaCoordinatorService } from "./coordinator-service.js";
import { BUILT_IN_QUOTA_PARSER_WORDING, quotaParserWordingRevisionId } from "./parser-wording.js";
import {
  QUOTA_ACTUATOR_SMOOTHING,
  QUOTA_DERIVATIVE_TAU_SECONDS,
  QUOTA_INTEGRAL_TIME_SECONDS,
  QUOTA_KD_SECONDS_SQUARED_PER_POINT,
  QUOTA_KI_SECONDS_PER_POINT_SECOND,
  QUOTA_KP_SECONDS_PER_POINT,
  QUOTA_MAX_CREDITED_ELAPSED_SECONDS,
  QUOTA_MAX_SLEW_SECONDS,
  QUOTA_OBSERVATION_RETENTION_MS,
  QUOTA_RAW_RETENTION_MS,
  QUOTA_SCHEMA_VERSION,
  SharedQuotaStore,
  serializeParsedState,
} from "./shared-store.js";
import { isModelScopedWindow, isProviderScopedWindow } from "./window-scope.js";

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
        "_migrations",
        "quota_manual_observation_receipts",
        "quota_observations",
        "quota_parser_wording_revisions",
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

describe("SharedQuotaStore parser wording attribution (#536)", () => {
  function snapshot(percentLeft: number): ProviderQuotaSnapshot {
    return {
      provider: "claude",
      status: "available",
      limits: [
        {
          label: "weekly limit",
          kind: "weekly",
          scope: "provider",
          percentLeft,
          resetAtIso: "2030-01-05T00:00:00.000Z",
        },
      ],
    };
  }

  function openStore(): { store: SharedQuotaStore; path: string } {
    const root = mkdtempSync(join(tmpdir(), "rusa-quota-wording-"));
    roots.push(root);
    const path = join(root, "quota.db");
    return { store: new SharedQuotaStore(path), path };
  }

  it("upgrades a pre-attribution database in place without bumping user_version", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-quota-wording-upgrade-"));
    roots.push(root);
    const path = join(root, "quota.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE quota_scrapes (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, scraped_at TEXT NOT NULL,
        raw_output TEXT NOT NULL, parsed_state TEXT, parse_error TEXT
      );
      INSERT INTO quota_scrapes (id, provider, scraped_at, raw_output, parse_error)
      VALUES ('existing', 'claude', '2030-01-01T00:00:00.000Z', 'synthetic', 'synthetic failure');
    `);
    legacy.pragma(`user_version = ${QUOTA_SCHEMA_VERSION}`);
    legacy.close();

    const store = new SharedQuotaStore(path);
    try {
      expect(store.db.pragma("user_version", { simple: true })).toBe(QUOTA_SCHEMA_VERSION);
      expect(
        store.db
          .prepare(
            "SELECT id, parse_error, parser_wording_revision_id AS revision FROM quota_scrapes"
          )
          .all()
      ).toEqual([{ id: "existing", parse_error: "synthetic failure", revision: null }]);
    } finally {
      store.close();
    }
  });

  it("seeds each provider's built-in wording during database open, keyed by content hash", () => {
    const { store } = openStore();
    try {
      const first = store.resolveParserWording("codex");
      const again = store.resolveParserWording("codex");
      const expectedId = quotaParserWordingRevisionId("codex", BUILT_IN_QUOTA_PARSER_WORDING.codex);
      expect(first).toEqual({ revisionId: expectedId });
      expect(again).toEqual(first);
      expect(store.db.prepare("SELECT * FROM quota_parser_wording_revisions").all()).toEqual(
        (["claude", "codex", "agy", "kimi"] as const).map((provider) => ({
          id: quotaParserWordingRevisionId(provider, BUILT_IN_QUOTA_PARSER_WORDING[provider]),
          provider,
          wording: BUILT_IN_QUOTA_PARSER_WORDING[provider],
        }))
      );
    } finally {
      store.close();
    }
  });

  it("still opens and degrades to unattributed parsing when the revision table rejects the seeds", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-quota-wording-broken-"));
    roots.push(root);
    const path = join(root, "quota.db");
    // A control table that exists but cannot take the seed rows: the schema's
    // `CREATE TABLE IF NOT EXISTS` leaves it alone and registration fails.
    const broken = new Database(path);
    broken.exec("CREATE TABLE quota_parser_wording_revisions (id TEXT PRIMARY KEY)");
    broken.close();
    const warn = vi.fn();

    const store = new SharedQuotaStore(path, { ...nullLogger, warn });
    try {
      expect(warn).toHaveBeenCalledWith("parser_wording_registration_failed", {
        error: expect.stringContaining("provider"),
      });
      expect(store.resolveParserWording("claude")).toEqual({
        revisionId: null,
      });
      const scrape = store.recordRaw({
        provider: "claude",
        scrapedAt: "2030-01-01T00:00:00.000Z",
        rawOutput: "synthetic",
      });
      store.recordParsed(scrape, snapshot(50), snapshot(50), null);
      expect(store.getLatestSnapshot("claude")?.limits?.[0]?.percentLeft).toBe(50);
    } finally {
      store.close();
    }
  });

  it("degrades to unattributed parsing when an expected revision id holds other wording", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-quota-wording-mismatch-"));
    roots.push(root);
    const path = join(root, "quota.db");
    // `INSERT OR IGNORE` succeeds against an existing id whatever its content,
    // so registration must check the rows it relies on.
    const damaged = new Database(path);
    damaged.exec(
      "CREATE TABLE quota_parser_wording_revisions (id TEXT PRIMARY KEY, provider TEXT NOT NULL, wording TEXT NOT NULL)"
    );
    damaged
      .prepare(
        "INSERT INTO quota_parser_wording_revisions (id, provider, wording) VALUES (?, ?, ?)"
      )
      .run(
        quotaParserWordingRevisionId("codex", BUILT_IN_QUOTA_PARSER_WORDING.codex),
        "codex",
        "other wording"
      );
    damaged.close();
    const warn = vi.fn();

    const store = new SharedQuotaStore(path, { ...nullLogger, warn });
    try {
      expect(warn).toHaveBeenCalledWith("parser_wording_registration_failed", {
        error: expect.stringContaining("codex"),
      });
      expect(store.resolveParserWording("claude")).toEqual({ revisionId: null });
    } finally {
      store.close();
    }
  });

  it("writes the revision with the parse and keeps pre-change writes readable", () => {
    const { store, path } = openStore();
    try {
      const { revisionId } = store.resolveParserWording("claude");
      const parsed = store.recordRaw({
        provider: "claude",
        scrapedAt: "2030-01-01T00:00:00.000Z",
        rawOutput: "synthetic",
      });
      store.recordParsed(parsed, snapshot(50), snapshot(50), revisionId);
      const failed = store.recordRaw({
        provider: "claude",
        scrapedAt: "2030-01-01T00:05:00.000Z",
        rawOutput: "synthetic",
      });
      store.recordParseError(failed, new Error("synthetic"), revisionId);

      // The statements a pre-change coordinator issues name their columns, so
      // the new nullable column is simply left null on that binary's rows.
      const old = new Database(path);
      old
        .prepare(
          `INSERT INTO quota_scrapes (id, provider, scraped_at, raw_output)
           VALUES ('pre-change', 'claude', '2030-01-01T00:10:00.000Z', 'synthetic')`
        )
        .run();
      old
        .prepare("UPDATE quota_scrapes SET parsed_state = ?, parse_error = NULL WHERE id = ?")
        .run(serializeParsedState(snapshot(40)), "pre-change");
      old.close();

      expect(
        store.db
          .prepare(
            "SELECT id, parser_wording_revision_id AS revision FROM quota_scrapes ORDER BY scraped_at"
          )
          .all()
      ).toEqual([
        { id: parsed, revision: revisionId },
        { id: failed, revision: revisionId },
        { id: "pre-change", revision: null },
      ]);
      expect(store.getLatestSnapshot("claude")?.limits?.[0]?.percentLeft).toBe(40);
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
        droppedWindows: [],
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
        "_migrations",
        "quota_manual_observation_receipts",
        "quota_observations",
        "quota_parser_wording_revisions",
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

  it("keeps a carried model window at its original observation time", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-carried-model-age-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    const originalModelObservedAt = "2030-01-01T00:00:00.000Z";
    const currentScrapeAt = "2030-01-01T00:30:00.000Z";
    const state: ProviderQuotaSnapshot = {
      provider: "claude",
      status: "available",
      scrapedAt: currentScrapeAt,
      limits: [
        {
          label: "Current week (all models)",
          kind: "weekly",
          percentLeft: 80,
          resetAtIso: "2030-01-08T00:00:00.000Z",
          scope: { provider: "claude" },
        },
        {
          label: "Current week (Fable)",
          kind: "weekly",
          percentLeft: 75,
          resetAtIso: "2030-01-08T00:00:00.000Z",
          scope: { provider: "claude", models: ["claude-fable"] },
          // This is evidence carried across a failed extraction, not a fresh
          // Fable observation from the scrape recorded above.
          scrapedAt: originalModelObservedAt,
        },
      ],
    };
    try {
      const id = store.recordRaw({
        provider: "claude",
        scrapedAt: currentScrapeAt,
        rawOutput: "synthetic current scrape",
      });
      store.recordParsed(id, state, state);

      expect(
        store.db
          .prepare("SELECT label, observed_at AS observedAt FROM quota_observations ORDER BY label")
          .all()
      ).toEqual([
        { label: "Current week (Fable)", observedAt: originalModelObservedAt },
        { label: "Current week (all models)", observedAt: currentScrapeAt },
      ]);
    } finally {
      store.close();
    }
  });

  it("records no new-slot observation for a carried provider window", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-carried-provider-age-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    const originalObservedAt = "2030-01-01T00:00:00.000Z";
    const carriedScrapeAt = "2030-01-01T00:30:00.000Z";
    const providerWindow = {
      label: "Current week (all models)",
      kind: "weekly" as const,
      percentLeft: 80,
      resetAtIso: "2030-01-08T00:00:00.000Z",
      scope: { provider: "claude" },
    };
    const fresh: ProviderQuotaSnapshot = {
      provider: "claude",
      status: "available",
      scrapedAt: originalObservedAt,
      limits: [providerWindow],
    };
    // The next scrape's extraction failed; the provider window is carried
    // across it and is not a second reading showing no consumption.
    const carried: ProviderQuotaSnapshot = {
      provider: "claude",
      status: "available",
      scrapedAt: carriedScrapeAt,
      limits: [{ ...providerWindow, scrapedAt: originalObservedAt }],
    };
    try {
      const firstId = store.recordRaw({
        provider: "claude",
        scrapedAt: originalObservedAt,
        rawOutput: "synthetic fresh scrape",
      });
      store.recordParsed(firstId, fresh, fresh);
      const secondId = store.recordRaw({
        provider: "claude",
        scrapedAt: carriedScrapeAt,
        rawOutput: "synthetic failed extraction",
      });
      store.recordParsed(secondId, carried, carried);

      expect(
        store.db
          .prepare(
            "SELECT observed_at AS observedAt, percent_left AS percentLeft FROM quota_observations"
          )
          .all()
      ).toEqual([{ observedAt: originalObservedAt, percentLeft: 80 }]);
    } finally {
      store.close();
    }
  });

  it("records another provider's window at the scrape time even with a per-limit scrapedAt", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-codex-limit-time-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    const perLimitAt = "2030-01-01T00:00:00.000Z";
    const scrapeAt = "2030-01-01T00:30:00.000Z";
    const state: ProviderQuotaSnapshot = {
      provider: "codex",
      status: "available",
      scrapedAt: scrapeAt,
      limits: [
        {
          label: "Weekly",
          kind: "weekly",
          percentLeft: 80,
          resetAtIso: "2030-01-08T00:00:00.000Z",
          scope: "provider",
          scrapedAt: perLimitAt,
        },
      ],
    };
    try {
      const id = store.recordRaw({
        provider: "codex",
        scrapedAt: scrapeAt,
        rawOutput: "synthetic scrape",
      });
      store.recordParsed(id, state, state);

      expect(
        store.db.prepare("SELECT observed_at AS observedAt FROM quota_observations").all()
      ).toEqual([{ observedAt: scrapeAt }]);
    } finally {
      store.close();
    }
  });

  it("still records another provider's carried window at the bad read's time", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-carried-codex-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    const originalObservedAt = "2030-01-01T00:00:00.000Z";
    const badReadAt = "2030-01-01T00:30:00.000Z";
    const fresh: ProviderQuotaSnapshot = {
      provider: "codex",
      status: "available",
      scrapedAt: originalObservedAt,
      limits: [
        {
          label: "Weekly",
          kind: "weekly",
          percentLeft: 80,
          resetAtIso: "2030-01-08T00:00:00.000Z",
          scope: "provider",
        },
      ],
    };
    const badRead: ProviderQuotaSnapshot = {
      provider: "codex",
      status: "unknown",
      scrapedAt: badReadAt,
      limits: [],
    };
    const carried = inferQuotaState(badRead, fresh, badReadAt);
    try {
      const firstId = store.recordRaw({
        provider: "codex",
        scrapedAt: originalObservedAt,
        rawOutput: "synthetic fresh scrape",
      });
      store.recordParsed(firstId, fresh, fresh);
      const secondId = store.recordRaw({
        provider: "codex",
        scrapedAt: badReadAt,
        rawOutput: "synthetic failed extraction",
      });
      store.recordParsed(secondId, badRead, carried);

      expect(
        store.db
          .prepare(
            "SELECT observed_at AS observedAt, percent_left AS percentLeft FROM quota_observations ORDER BY observed_at"
          )
          .all()
      ).toEqual([
        { observedAt: originalObservedAt, percentLeft: 80 },
        { observedAt: badReadAt, percentLeft: 80 },
      ]);
    } finally {
      store.close();
    }
  });
});

describe("SharedQuotaStore persisted controller", () => {
  it("derives stored window lengths from reset ends, cold-start evidence, and jitter", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-window-length-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      const hour = 60 * 60 * 1000;
      const firstObserved = Date.parse("2030-01-01T00:00:00.000Z");
      const firstEnd = firstObserved + 6 * 24 * hour;
      // No prior end: use the lane's earliest reading, not the old 7d default.
      recordObservation(
        store,
        "claude",
        new Date(firstObserved).toISOString(),
        80,
        new Date(firstEnd).toISOString()
      );
      // A sub-hour reset correction is one cycle, so it preserves the stored 6d length.
      recordObservation(
        store,
        "claude",
        new Date(firstObserved + hour).toISOString(),
        75,
        new Date(firstEnd + 30 * 60 * 1000).toISOString()
      );
      // Once the corrected prior end has passed, the next end defines the
      // actual 24h window.
      const correctedEnd = firstEnd + 30 * 60 * 1000;
      const nextObserved = correctedEnd + 5 * 60 * 1000;
      const nextEnd = correctedEnd + 24 * hour;
      recordObservation(
        store,
        "claude",
        new Date(nextObserved).toISOString(),
        99,
        new Date(nextEnd).toISOString()
      );

      const windows = store
        .listCanonicalSince("claude", "2030-01-01T00:00:00.000Z")
        .map((row) => row.windowMs);
      expect(windows).toEqual([6 * 24 * hour, 6 * 24 * hour, 24 * hour]);

      // The established seven-day and five-hour shapes are unchanged when
      // their own reset evidence says so.
      const weekEnd = firstObserved + 7 * 24 * hour;
      recordObservation(
        store,
        "codex",
        new Date(firstObserved).toISOString(),
        90,
        new Date(weekEnd).toISOString()
      );
      recordObservation(
        store,
        "codex",
        new Date(firstObserved + hour).toISOString(),
        80,
        new Date(weekEnd).toISOString()
      );
      const fiveHourEnd = firstObserved + 5 * hour;
      recordObservation(
        store,
        "agy",
        new Date(firstObserved).toISOString(),
        90,
        new Date(fiveHourEnd).toISOString(),
        "session"
      );
      recordObservation(
        store,
        "agy",
        new Date(firstObserved + hour).toISOString(),
        80,
        new Date(fiveHourEnd).toISOString(),
        "session"
      );
      expect(
        store.listCanonicalSince("codex", "2030-01-01T00:00:00.000Z").map((row) => row.windowMs)
      ).toEqual([7 * 24 * hour, 7 * 24 * hour]);
      expect(
        store.listCanonicalSince("agy", "2030-01-01T00:00:00.000Z").map((row) => row.windowMs)
      ).toEqual([5 * hour, 5 * hour]);

      store.advancePendingController({ maxIntervalSeconds: 3600 }, "claude");
      expect(store.getProviderThrottle("claude")?.buckets[0]?.timeRemainingPct).toBeCloseTo(
        ((nextEnd - nextObserved) / (24 * hour)) * 100,
        8
      );
    } finally {
      store.close();
    }
  });

  it("derives manual readings at the same insertion seam", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-manual-window-length-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      const hour = 60 * 60 * 1000;
      const firstObserved = Date.parse("2030-01-01T00:00:00.000Z");
      const firstEnd = firstObserved + 6 * 24 * hour;
      const mode = store.setQuotaReadingMode(
        "claude",
        "manual",
        new Date(firstObserved).toISOString()
      );
      const submit = (observedMs: number, resetMs: number, idempotencyKey: string) =>
        store.recordManualObservation({
          snapshot: {
            provider: "claude",
            status: "available",
            scrapedAt: new Date(observedMs).toISOString(),
            limits: [
              {
                label: "Weekly",
                kind: "weekly",
                scope: "provider",
                percentLeft: 90,
                resetAtIso: new Date(resetMs).toISOString(),
              },
            ],
          },
          generation: mode.generation,
          idempotencyKey,
          acceptedAt: new Date(observedMs).toISOString(),
        });
      expect(submit(firstObserved, firstEnd, "first")).toMatchObject({ result: "accepted" });
      const nextObserved = firstEnd + 5 * 60 * 1000;
      expect(submit(nextObserved, firstEnd + 24 * hour, "next")).toMatchObject({
        result: "accepted",
      });
      expect(
        store.listCanonicalSince("claude", "2030-01-01T00:00:00.000Z").map((row) => row.windowMs)
      ).toEqual([6 * 24 * hour, 24 * hour]);
    } finally {
      store.close();
    }
  });

  it("keeps five-hour lanes at 5h across an idle gap between sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-session-gap-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      const hour = 60 * 60 * 1000;
      const firstObserved = Date.parse("2030-01-01T05:00:00.000Z");
      const firstEnd = firstObserved + 5 * hour;
      const iso = (ms: number) => new Date(ms).toISOString();
      recordObservation(store, "agy", iso(firstObserved), 90, iso(firstEnd), "session");
      // The account idles for 8h after that reset; the next session starts on
      // first use, so its end is 13h after the previous one.
      const nextObserved = firstEnd + 8 * hour;
      recordObservation(
        store,
        "agy",
        iso(nextObserved),
        99,
        iso(nextObserved + 5 * hour),
        "session"
      );
      expect(
        store.listCanonicalSince("agy", "2030-01-01T00:00:00.000Z").map((row) => row.windowMs)
      ).toEqual([5 * hour, 5 * hour]);
    } finally {
      store.close();
    }
  });

  it("ends the previous window no later than the reading that shows a new one", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-early-reset-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      const hour = 60 * 60 * 1000;
      const day = 24 * hour;
      const iso = (ms: number) => new Date(ms).toISOString();
      const start = Date.parse("2030-01-01T00:00:00.000Z");
      const firstEnd = start + 7 * day;
      recordObservation(store, "codex", iso(start), 90, iso(firstEnd));
      // The provider resets two days early: the new end is seven days from
      // the reading, not fourteen days from the last end that had passed.
      const earlyObserved = firstEnd - 2 * day;
      const earlyEnd = earlyObserved + 7 * day;
      recordObservation(store, "codex", iso(earlyObserved), 100, iso(earlyEnd));
      // A reading whose clock trails the stored end by 20s still measures from
      // that end's neighbourhood rather than an older cycle.
      const skewedObserved = earlyEnd - 20 * 1000;
      recordObservation(store, "codex", iso(skewedObserved), 100, iso(earlyEnd + day));
      expect(
        store.listCanonicalSince("codex", "2030-01-01T00:00:00.000Z").map((row) => row.windowMs)
      ).toEqual([7 * day, 7 * day, day + 20 * 1000]);
    } finally {
      store.close();
    }
  });

  it("does not fabricate pacing for a lane with no usable reading", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-no-reading-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 3600 });
      expect(store.getProviderThrottle("claude")).toBeNull();
    } finally {
      store.close();
    }
  });

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
        "_migrations",
        "quota_manual_observation_receipts",
        "quota_observations",
        "quota_parser_wording_revisions",
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

      expect(indices).toContain("idx_quota_observations_scope_kind_time");
      expect(indices).toContain("idx_quota_observations_scope_reasoned");
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
           WHERE provider = ? AND model_scope = ? AND kind = ? AND interval_seconds IS NOT NULL
           ORDER BY observed_at DESC LIMIT 1`
        )
        .all("claude", "", "weekly") as Array<{ detail: string }>;

      expect(
        previousPlan.some((step) => step.detail.includes("idx_quota_observations_scope_reasoned"))
      ).toBe(true);

      // Query plan for current observations in getProviderThrottle
      const currentPlan = store.db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT kind, label, reset_at_iso, percent_left, observed_at
           FROM quota_observations o
           WHERE provider = ? AND model_scope = ?
             AND NOT EXISTS (
               SELECT 1 FROM quota_observations newer
               WHERE newer.provider = o.provider AND newer.model_scope = o.model_scope
                 AND newer.kind = o.kind
                 AND (newer.observed_at > o.observed_at OR
                      (newer.observed_at = o.observed_at AND newer.rowid > o.rowid))
             )`
        )
        .all("claude", "") as Array<{ detail: string }>;

      expect(
        currentPlan.some((step) => step.detail.includes("idx_quota_observations_scope_kind_time"))
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
      expect(QUOTA_MAX_CREDITED_ELAPSED_SECONDS).toBe(30 * 60);

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
      const startedMs = Date.parse("2030-01-04T12:00:00.000Z");
      const reset = new Date(startedMs + 4 * 24 * 60 * 60 * 1000).toISOString();
      const resetMs = Date.parse(reset);
      const percentLeftForError = (observedMs: number, error: number) =>
        ((resetMs - observedMs) / (7 * 24 * 60 * 60 * 1000)) * 100 - error;

      // The window began three days before this fixture's first controller
      // sample, so the lane has explicit 7d evidence instead of relying on a
      // nominal fallback.
      const windowStartMs = resetMs - 7 * 24 * 60 * 60 * 1000;
      recordObservation(
        store,
        "claude",
        new Date(windowStartMs).toISOString(),
        percentLeftForError(windowStartMs, 10),
        reset
      );
      // The seed supplies only the persisted cycle boundary. The controller
      // series under test begins at `startedMs`, as it did before this fixture
      // made that boundary explicit.
      store.db
        .prepare(
          `UPDATE quota_observations
           SET controller_error = NULL, controller_derivative = NULL,
               controller_integral = NULL, uncapped_interval_seconds = NULL,
               interval_seconds = NULL
           WHERE provider = 'claude' AND observed_at = ?`
        )
        .run(new Date(windowStartMs).toISOString());

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

      recordObservation(store, "codex", new Date(windowStartMs).toISOString(), 100, reset);
      store.db
        .prepare(
          `UPDATE quota_observations
           SET controller_error = NULL, controller_derivative = NULL,
               controller_integral = NULL, uncapped_interval_seconds = NULL,
               interval_seconds = NULL
           WHERE provider = 'codex' AND observed_at = ?`
        )
        .run(new Date(windowStartMs).toISOString());
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
      expect(gapped.integral).toBeCloseTo(gapped.error * QUOTA_MAX_CREDITED_ELAPSED_SECONDS, 6);
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
    } finally {
      store5m.close();
      store30m.close();
    }
  });

  it("does not slow a routine 30m step below its six-5m reference response (#690)", () => {
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
      // One 30m observation must not be slower than the six 5m reference
      // updates over the same wall-clock period, and is no longer constrained
      // to the prior two-step (1800s) slew cap. This deterministic fixture has
      // no sampling jitter or rounding allowance to absorb.
      expect(thirtyMinuteStep.interval).toBeGreaterThanOrEqual(fiveMinuteStep.interval);
      expect(thirtyMinuteStep.interval).toBeLessThan(fiveMinuteStep.interval * 1.2);
      expect(thirtyMinuteStep.interval).toBeGreaterThan(2 * QUOTA_MAX_SLEW_SECONDS);
    } finally {
      fiveMinute.close();
      thirtyMinute.close();
    }
  });

  it("moves a late observation no further than an on-cadence 30m one (#690)", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-delayed-actuator-"));
    roots.push(root);
    const onCadence = new SharedQuotaStore(join(root, "on-cadence.db"));
    const delayed = new SharedQuotaStore(join(root, "delayed.db"));
    try {
      onCadence.configureController({ maxIntervalSeconds: 36000 });
      delayed.configureController({ maxIntervalSeconds: 36000 });
      const startMs = Date.parse("2030-01-01T00:00:00.000Z");
      const reset = "2030-01-08T00:00:00.000Z";
      const weeklyMs = 7 * 24 * 60 * 60 * 1000;
      const recordError = (store: SharedQuotaStore, offsetMinutes: number, error: number) => {
        const observedMs = startMs + offsetMinutes * 60 * 1000;
        recordObservation(
          store,
          "claude",
          new Date(observedMs).toISOString(),
          ((Date.parse(reset) - observedMs) / weeklyMs) * 100 - error,
          reset
        );
      };

      for (const store of [onCadence, delayed]) {
        recordError(store, 0, 0);
        recordError(store, 30, 20);
      }
      const before = reasonedRows(delayed, "claude").at(-1) as ReasonedRow;
      recordError(onCadence, 60, 20);
      recordError(delayed, 5 * 60, 20);
      const next = reasonedRows(onCadence, "claude").at(-1) as ReasonedRow;
      const late = reasonedRows(delayed, "claude").at(-1) as ReasonedRow;

      // The 5h-late reading is credited as one 30m slot, so it moves the
      // interval as far as the on-cadence reading does; only the derivative
      // filter, which decays over the real gap, separates them (~0.2%). Without
      // the 1800s credit cap, the late step is ~21% larger.
      const lateStep = late.interval - before.interval;
      const onCadenceStep = next.interval - before.interval;
      expect(lateStep).toBeGreaterThan(0);
      expect(Math.abs(lateStep - onCadenceStep)).toBeLessThan(0.01 * onCadenceStep);
    } finally {
      onCadence.close();
      delayed.close();
    }
  });

  it("limits a noisy five-minute follow-up to one reference slew (#690)", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-noisy-actuator-"));
    roots.push(root);
    const store = new SharedQuotaStore(join(root, "shared.db"));
    try {
      store.configureController({ maxIntervalSeconds: 36000 });
      const startMs = Date.parse("2030-01-01T00:00:00.000Z");
      const reset = "2030-01-08T00:00:00.000Z";
      const weeklyMs = 7 * 24 * 60 * 60 * 1000;
      const recordError = (offsetMinutes: number, error: number) => {
        const observedMs = startMs + offsetMinutes * 60 * 1000;
        recordObservation(
          store,
          "claude",
          new Date(observedMs).toISOString(),
          ((Date.parse(reset) - observedMs) / weeklyMs) * 100 - error,
          reset
        );
      };

      recordError(0, 0);
      recordError(30, 20);
      const beforeNoise = reasonedRows(store, "claude").at(-1) as ReasonedRow;
      recordError(35, 19);
      const noisy = reasonedRows(store, "claude").at(-1) as ReasonedRow;

      expect(Math.abs(noisy.interval - beforeNoise.interval)).toBeLessThanOrEqual(900);
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
      expect(next.integral).toBeCloseTo(next.error * QUOTA_MAX_CREDITED_ELAPSED_SECONDS, 6);
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

  describe("SharedQuotaStore projectPacerState (#336)", () => {
    it("ensures getLatestSnapshot returns raw unprojected parsed_state to keep hydrate clean", () => {
      const root = mkdtempSync(join(tmpdir(), "rusa-quota-raw-hydrate-"));
      roots.push(root);
      const store = new SharedQuotaStore(join(root, "quota.db"));
      try {
        store.configureController({ maxIntervalSeconds: 36000 });
        const nowMs = Date.parse("2030-01-01T12:00:00.000Z");
        const scrapedAt = new Date(nowMs).toISOString();
        const resetAtIso = new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString();

        recordObservation(store, "claude", scrapedAt, 10, resetAtIso);
        store.advancePendingController({ maxIntervalSeconds: 36000 }, "claude");

        // getLatestSnapshot returns the raw snapshot from parsed_state with no controller projection
        const raw = store.getLatestSnapshot("claude");
        expect(raw).not.toBeNull();
        if (!raw) throw new Error("expected raw snapshot");
        expect(raw.limits?.[0].throttleSeconds).toBeUndefined();
        expect(raw.limits?.[0].paceError).toBeUndefined();

        // Calling projectPacerState explicitly decorates the limits
        const projected = store.projectPacerState("claude", raw);
        expect(projected.limits?.[0].throttleSeconds).toBeGreaterThan(0);
        expect(projected.limits?.[0].paceError).toBeGreaterThan(0);
      } finally {
        store.close();
      }
    });

    it("projects throttleSeconds and paceError for live throttled and unthrottled lanes", () => {
      const root = mkdtempSync(join(tmpdir(), "rusa-quota-pacer-proj-"));
      roots.push(root);
      const store = new SharedQuotaStore(join(root, "quota.db"));
      try {
        const nowMs = Date.parse("2030-01-01T12:00:00.000Z");
        const scrapedAt = new Date(nowMs).toISOString();
        const resetAtIso = new Date(nowMs + 6 * 24 * 3600 * 1000).toISOString();

        // 1. Lane with unreasoned observation (interval_seconds is null before controller runs) -> returns null fields
        const emptyState: ProviderQuotaSnapshot = {
          provider: "agy",
          status: "available",
          scrapedAt,
          limits: [
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 50,
              resetAtIso,
              scope: "provider",
            },
          ],
        };
        const id = store.recordRaw({ provider: "agy", scrapedAt, rawOutput: "raw" });
        store.recordParsed(id, emptyState, emptyState);

        const unreasonedRaw = store.getLatestSnapshot("agy");
        expect(unreasonedRaw).not.toBeNull();
        if (!unreasonedRaw) throw new Error("expected unreasoned raw snapshot");
        const unreasonedSnapshot = store.projectPacerState("agy", unreasonedRaw);
        expect(unreasonedSnapshot.limits).toHaveLength(1);
        const unreasonedLimit = unreasonedSnapshot.limits?.[0];
        if (!unreasonedLimit) throw new Error("expected unreasoned limit");
        expect(unreasonedLimit.throttleSeconds).toBeNull();
        expect(unreasonedLimit.paceError).toBeNull();

        // Configure controller
        store.configureController({ maxIntervalSeconds: 36000 });

        // 2. Throttled lane (burning faster than linear pace -> positive pace error, interval_seconds > 0)
        // Remaining time is 100%, percentLeft is 10% -> error is +90% (throttled)
        recordObservation(store, "claude", scrapedAt, 10, resetAtIso);
        store.advancePendingController({ maxIntervalSeconds: 36000 }, "claude");

        const throttledRaw = store.getLatestSnapshot("claude");
        expect(throttledRaw).not.toBeNull();
        if (!throttledRaw) throw new Error("expected throttled raw snapshot");
        const throttledSnapshot = store.projectPacerState("claude", throttledRaw);
        expect(throttledSnapshot.limits).toHaveLength(1);
        const throttledLimit = throttledSnapshot.limits?.[0];
        if (!throttledLimit) throw new Error("expected throttled limit");
        expect(throttledLimit.throttleSeconds).toBeGreaterThan(0);
        expect(throttledLimit.paceError).toBeGreaterThan(0);

        // 3. Unthrottled lane (plenty of quota -> negative pace error, interval_seconds = 0)
        const unthrottledScrapedAt = new Date(nowMs).toISOString();
        const unthrottledReset = new Date(nowMs + 1 * 24 * 3600 * 1000).toISOString();
        // Its prior observation establishes this as a 7d window; the current
        // read is therefore at ~14.3% remaining, not a new one-day window.
        recordObservation(
          store,
          "codex",
          new Date(nowMs - 6 * 24 * 3600 * 1000).toISOString(),
          100,
          unthrottledReset
        );
        // Remaining time is ~14.3%, percentLeft is 90% -> error is ~-75.7% (unthrottled)
        recordObservation(store, "codex", unthrottledScrapedAt, 90, unthrottledReset);
        store.advancePendingController({ maxIntervalSeconds: 36000 }, "codex");

        const unthrottledRaw = store.getLatestSnapshot("codex");
        expect(unthrottledRaw).not.toBeNull();
        if (!unthrottledRaw) throw new Error("expected unthrottled raw snapshot");
        const unthrottledSnapshot = store.projectPacerState("codex", unthrottledRaw);
        expect(unthrottledSnapshot.limits).toHaveLength(1);
        const unthrottledLimit = unthrottledSnapshot.limits?.[0];
        if (!unthrottledLimit) throw new Error("expected unthrottled limit");
        expect(unthrottledLimit.throttleSeconds).toBe(0);
        expect(unthrottledLimit.paceError).toBeLessThan(0);
      } finally {
        store.close();
      }
    });

    it("projects model-scoped pacer observation onto model-scoped limit and provider observation onto provider limit", () => {
      const root = mkdtempSync(join(tmpdir(), "rusa-quota-pacer-model-scoped-"));
      roots.push(root);
      const store = new SharedQuotaStore(join(root, "quota.db"));
      try {
        store.configureController({ maxIntervalSeconds: 36000 });
        const nowMs = Date.parse("2030-01-01T12:00:00.000Z");
        const scrapedAt = new Date(nowMs).toISOString();
        const resetAtIso = new Date(nowMs + 6 * 24 * 3600 * 1000).toISOString();

        const prior: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt: new Date(nowMs - 24 * 3600 * 1000).toISOString(),
          limits: [
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 100,
              resetAtIso,
              scope: { provider: "claude" },
            },
            {
              label: "Current week (Fable)",
              kind: "weekly",
              percentLeft: 100,
              resetAtIso,
              scope: { provider: "claude", models: ["fable"] },
            },
          ],
        };

        const multiLimitSnapshot: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt,
          limits: [
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 95, // provider lane: timeRemaining is ~85.7% -> error is ~-9.3% -> unthrottled (0)
              resetAtIso,
              scope: { provider: "claude" },
            },
            {
              label: "Current week (Fable)",
              kind: "weekly",
              percentLeft: 10, // model lane: timeRemaining is ~85.7% -> error is ~+75.7% -> throttled (>0)
              resetAtIso,
              scope: { provider: "claude", models: ["fable"] },
            },
          ],
        };
        const priorId = store.recordRaw({
          provider: "claude",
          scrapedAt: prior.scrapedAt as string,
          rawOutput: "prior",
        });
        store.recordParsed(priorId, prior, prior);
        const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "raw" });
        store.recordParsed(id, multiLimitSnapshot, multiLimitSnapshot);
        store.advancePendingController({ maxIntervalSeconds: 36000 }, "claude");

        const raw = store.getLatestSnapshot("claude");
        expect(raw).not.toBeNull();
        if (!raw) throw new Error("expected raw snapshot");
        const snapshot = store.projectPacerState("claude", raw);
        expect(snapshot.limits).toHaveLength(2);

        const limits = snapshot.limits ?? [];
        const providerLimit = limits.find((l) => isProviderScopedWindow(l));
        const modelLimit = limits.find((l) => isModelScopedWindow(l));

        expect(providerLimit).toBeDefined();
        expect(providerLimit?.throttleSeconds).toBe(0);
        expect(providerLimit?.paceError).toBeLessThan(0);

        expect(modelLimit).toBeDefined();
        expect(modelLimit?.throttleSeconds).toBeGreaterThan(0);
        expect(modelLimit?.paceError).toBeGreaterThan(0);
      } finally {
        store.close();
      }
    });

    it("pins exact latest-row selection over older decisions and ignores later unreasoned observations", () => {
      const root = mkdtempSync(join(tmpdir(), "rusa-quota-pacer-exact-"));
      roots.push(root);
      const store = new SharedQuotaStore(join(root, "quota.db"));
      try {
        store.configureController({ maxIntervalSeconds: 36000 });
        const t1Ms = Date.parse("2030-01-01T12:00:00.000Z");
        const t1Scraped = new Date(t1Ms).toISOString();
        const resetAtIso = new Date(t1Ms + 6 * 24 * 3600 * 1000).toISOString();

        // 1. First observation (older reasoned row)
        recordObservation(store, "claude", t1Scraped, 50, resetAtIso);
        store.advancePendingController({ maxIntervalSeconds: 36000 }, "claude");

        const row1 = store.db
          .prepare(
            `SELECT interval_seconds AS intervalSeconds, controller_error AS controllerError
             FROM quota_observations
             WHERE provider = 'claude' AND model_scope = '' AND kind = 'weekly'
             ORDER BY rowid DESC LIMIT 1`
          )
          .get() as { intervalSeconds: number; controllerError: number };
        expect(row1.intervalSeconds).toBeDefined();

        const raw1 = store.getLatestSnapshot("claude");
        expect(raw1).not.toBeNull();
        if (!raw1) throw new Error("expected raw1");
        const snap1 = store.projectPacerState("claude", raw1);
        expect(snap1?.limits?.[0].throttleSeconds).toBe(row1.intervalSeconds);
        expect(snap1?.limits?.[0].paceError).toBe(row1.controllerError);

        // 2. Second observation at t2 (newer reasoned row with different percentLeft)
        const t2Ms = t1Ms + 3600 * 1000;
        const t2Scraped = new Date(t2Ms).toISOString();
        recordObservation(store, "claude", t2Scraped, 10, resetAtIso);
        store.advancePendingController({ maxIntervalSeconds: 36000 }, "claude");

        const row2 = store.db
          .prepare(
            `SELECT interval_seconds AS intervalSeconds, controller_error AS controllerError
             FROM quota_observations
             WHERE provider = 'claude' AND model_scope = '' AND kind = 'weekly'
             ORDER BY rowid DESC LIMIT 1`
          )
          .get() as { intervalSeconds: number; controllerError: number };
        expect(row2.intervalSeconds).not.toBe(row1.intervalSeconds);

        const raw2 = store.getLatestSnapshot("claude");
        expect(raw2).not.toBeNull();
        if (!raw2) throw new Error("expected raw2");
        const snap2 = store.projectPacerState("claude", raw2);
        // Pins exact latest-row selection over older decision:
        expect(snap2?.limits?.[0].throttleSeconds).toBe(row2.intervalSeconds);
        expect(snap2?.limits?.[0].paceError).toBe(row2.controllerError);

        // 3. Third observation at t3 (later unreasoned observation recorded via separate unconfigured connection)
        const t3Ms = t2Ms + 3600 * 1000;
        const t3Scraped = new Date(t3Ms).toISOString();
        const unreasonedState: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt: t3Scraped,
          limits: [
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 8,
              resetAtIso,
              scope: "provider",
            },
          ],
        };
        const unconfiguredStore = new SharedQuotaStore(join(root, "quota.db"));
        try {
          const rawId3 = unconfiguredStore.recordRaw({
            provider: "claude",
            scrapedAt: t3Scraped,
            rawOutput: "raw",
          });
          unconfiguredStore.recordParsed(rawId3, unreasonedState, unreasonedState);
        } finally {
          unconfiguredStore.close();
        }

        const raw3 = store.getLatestSnapshot("claude");
        expect(raw3).not.toBeNull();
        if (!raw3) throw new Error("expected raw3");
        expect(raw3.scrapedAt).toBe(t3Scraped);
        const snap3 = store.projectPacerState("claude", raw3);
        // Latest reasoned row (row2) is retained and NOT overwritten by the unreasoned t3 reading:
        expect(snap3?.limits?.[0].throttleSeconds).toBe(row2.intervalSeconds);
        expect(snap3?.limits?.[0].paceError).toBe(row2.controllerError);
      } finally {
        store.close();
      }
    });
  });
});
