import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderQuotaSnapshot, QuotaLimit } from "../mcp/quota-mcp.js";
import { QuotaCoordinatorClient } from "./coordinator-client.js";
import {
  modelLanePacing,
  type PublishedThrottleProviderStatus,
  publishedThrottle,
} from "./coordinator-protocol.js";
import { QuotaCoordinatorService } from "./coordinator-service.js";
import { modelScopeKey, parseModelScopeKey, SharedQuotaStore } from "./shared-store.js";

// #588: a provider-wide Claude window and a Fable-only window are paced as
// independent lanes that a Fable candidate must both honour.

const FABLE = "claude-fable-5-1";
const SONNET = "claude-sonnet-5";
const RESET = "2030-01-08T00:00:00.000Z";
const STARTED_MS = Date.parse("2030-01-01T00:00:00.000Z");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDb(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return join(root, "quota.db");
}

function providerLimit(percentLeft: number): QuotaLimit {
  return { label: "Weekly", kind: "weekly", scope: "provider", percentLeft, resetAtIso: RESET };
}

function fableLimit(percentLeft: number, scope: QuotaLimit["scope"] = fableScope()): QuotaLimit {
  return { label: "Fable weekly", kind: "weekly", scope, percentLeft, resetAtIso: RESET };
}

function fableScope(): QuotaLimit["scope"] {
  return { provider: "claude", models: [FABLE] };
}

function recordScrape(store: SharedQuotaStore, scrapedAt: string, limits: QuotaLimit[]): void {
  const state: ProviderQuotaSnapshot = {
    provider: "claude",
    status: "available",
    scrapedAt,
    limits,
  };
  const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "raw" });
  store.recordParsed(id, state, state);
}

/**
 * Five-minute scrapes holding a standing error on each lane: the provider
 * window runs `providerError` points ahead of the calendar, Fable
 * `fableError` points, so their controllers must diverge.
 */
function recordStandingErrors(
  store: SharedQuotaStore,
  fromSlot: number,
  slots: number,
  providerError: number,
  fableError: number
): void {
  for (let slot = fromSlot; slot < fromSlot + slots; slot += 1) {
    const observedMs = STARTED_MS + slot * 5 * 60 * 1000;
    const timeRemainingPct = ((Date.parse(RESET) - observedMs) / WEEK_MS) * 100;
    recordScrape(store, new Date(observedMs).toISOString(), [
      providerLimit(timeRemainingPct - providerError),
      fableLimit(timeRemainingPct - fableError),
    ]);
  }
}

interface ScopedRow {
  modelScope: string;
  observedAt: string;
  error: number;
  integral: number;
  interval: number;
}

function reasonedRows(store: SharedQuotaStore): ScopedRow[] {
  return store.db
    .prepare(
      `SELECT model_scope AS modelScope, observed_at AS observedAt, controller_error AS error,
              controller_integral AS integral, interval_seconds AS interval
       FROM quota_observations
       WHERE provider = 'claude' AND interval_seconds IS NOT NULL
       ORDER BY model_scope, observed_at, rowid`
    )
    .all() as ScopedRow[];
}

describe("model-scoped quota lanes: store (#588)", () => {
  it("keeps provider and Fable controller histories distinct with stable identities across a restart", () => {
    const path = tempDb("rusa-588-restart-");
    const store = new SharedQuotaStore(path);
    store.configureController({ maxIntervalSeconds: 36000 });
    recordStandingErrors(store, 0, 6, 2, 12);
    const before = store.getProviderThrottle("claude");
    store.close();

    // Same scrapes fed to a store that never restarts: the controller the
    // reopened store resumes from must be the same one, lane for lane.
    const control = new SharedQuotaStore(tempDb("rusa-588-control-"));
    control.configureController({ maxIntervalSeconds: 36000 });
    recordStandingErrors(control, 0, 12, 2, 12);

    const reopened = new SharedQuotaStore(path);
    try {
      reopened.configureController({ maxIntervalSeconds: 36000 });
      expect(reopened.getProviderThrottle("claude")).toEqual(before);
      recordStandingErrors(reopened, 6, 6, 2, 12);

      const rows = reasonedRows(reopened);
      expect(rows).toEqual(reasonedRows(control));
      const scopes = [...new Set(rows.map((row) => row.modelScope))];
      expect(scopes).toEqual(["", modelScopeKey([FABLE])]);
      expect(parseModelScopeKey(scopes[1] as string)).toEqual([FABLE]);
      const provider = rows.filter((row) => row.modelScope === "");
      const fable = rows.filter((row) => row.modelScope !== "");
      expect(provider).toHaveLength(12);
      expect(fable).toHaveLength(12);
      // A shared controller would carry one integral across both windows.
      expect((fable.at(-1) as ScopedRow).integral).toBeGreaterThan(
        (provider.at(-1) as ScopedRow).integral
      );
      expect((fable.at(-1) as ScopedRow).interval).toBeGreaterThan(
        (provider.at(-1) as ScopedRow).interval
      );

      const status = reopened.getProviderThrottle("claude");
      expect(status?.governingBucketKey).toBe("claude:weekly");
      expect(status?.buckets.map((bucket) => bucket.key)).toEqual(["claude:weekly"]);
      expect(status?.modelLanes).toHaveLength(1);
      expect(status?.modelLanes?.[0]).toMatchObject({
        models: [FABLE],
        governingBucketKey: `claude[${FABLE}]:weekly`,
        intervalSeconds: (fable.at(-1) as ScopedRow).interval,
      });
      expect(status?.intervalSeconds).toBe((provider.at(-1) as ScopedRow).interval);

      const history = reopened.listHistorySince("claude", "2000-01-01T00:00:00.000Z");
      expect(history.filter((point) => point.scope === "provider")).toHaveLength(12);
      expect(
        history.filter((point) => point.scope === "model").every((p) => p.models?.[0] === FABLE)
      ).toBe(true);
      // Canonical (provider-only) readers never see a model row.
      expect(reopened.listCanonicalSince("claude", "2000-01-01T00:00:00.000Z")).toHaveLength(12);
    } finally {
      reopened.close();
      control.close();
    }
  });

  it("gives one allocation one identity whatever order its models arrive in", () => {
    expect(modelScopeKey(["b", "a", "a"])).toBe(modelScopeKey(["a", "b"]));
    expect(parseModelScopeKey(modelScopeKey(["b", "a"]))).toEqual(["a", "b"]);
    expect(parseModelScopeKey("")).toEqual([]);
    // Non-canonical or unversioned blobs are unusable, never provider-wide.
    expect(parseModelScopeKey('{"models":["a"]}')).toBeNull();
    expect(parseModelScopeKey('{"models":["b","a"],"version":1}')).toBeNull();
    expect(parseModelScopeKey('{"models":[],"version":1}')).toBeNull();
    expect(parseModelScopeKey("not json")).toBeNull();
  });

  it("rejects unknown or ambiguous model scope so it reaches no lane", () => {
    const store = new SharedQuotaStore(tempDb("rusa-588-reject-"));
    try {
      store.configureController({ maxIntervalSeconds: 36000 });
      recordScrape(store, "2030-01-01T00:00:00.000Z", [
        providerLimit(80),
        // Legacy bare scope: names no model.
        fableLimit(1, "model"),
        // Another provider's allocation.
        fableLimit(1, { provider: "codex", models: [FABLE] }),
        // A blank model identity.
        fableLimit(1, { provider: "claude", models: [" "] }),
      ]);
      const rows = store.db
        .prepare(
          "SELECT model_scope AS modelScope, percent_left AS percentLeft FROM quota_observations"
        )
        .all();
      expect(rows).toEqual([{ modelScope: "", percentLeft: 80 }]);
      expect(store.getProviderThrottle("claude")?.modelLanes).toBeUndefined();

      // A manual reading is not catalog-validated, so its model windows are
      // dropped rather than trusted.
      const mode = store.setQuotaReadingMode("claude", "manual", "2030-01-01T00:01:00.000Z");
      const result = store.recordManualObservation({
        snapshot: {
          provider: "claude",
          status: "available",
          scrapedAt: "2030-01-01T00:05:00.000Z",
          limits: [providerLimit(79), fableLimit(1)],
        },
        generation: mode.generation,
        idempotencyKey: "reading-1",
        acceptedAt: "2030-01-01T00:05:30.000Z",
      });
      expect(result.result).toBe("accepted");
      expect(
        store.db
          .prepare("SELECT count(*) AS n FROM quota_observations WHERE model_scope <> ''")
          .get()
      ).toEqual({ n: 0 });

      // A stored blob that no longer decodes is skipped by every reader.
      store.db
        .prepare(
          `INSERT INTO quota_observations
            (provider, model_scope, kind, observed_slot, label, observed_at, percent_left,
             reset_at_iso, window_ms, processed, interval_seconds)
           VALUES ('claude', '{"models":["x"]}', 'weekly', 1, 'x', '2030-01-01T00:06:00.000Z',
                   1, ?, 604800000, 1, 999)`
        )
        .run(RESET);
      expect(store.getProviderThrottle("claude")?.modelLanes).toBeUndefined();
      expect(
        store
          .listHistorySince("claude", "2000-01-01T00:00:00.000Z")
          .every((point) => point.scope === "provider")
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  it("reports exhaustion per scope and resets model lanes with the provider", () => {
    const store = new SharedQuotaStore(tempDb("rusa-588-exhaust-"));
    try {
      store.configureController({ maxIntervalSeconds: 36000 });
      recordStandingErrors(store, 0, 3, 2, 12);
      recordScrape(store, "2030-01-01T00:20:00.000Z", [providerLimit(70), fableLimit(0)]);
      const nowMs = Date.parse("2030-01-01T00:30:00.000Z");
      expect(store.getExhaustedUntil("claude", nowMs)).toBeNull();
      expect(store.getExhaustedUntil("claude", nowMs, modelScopeKey([FABLE]))).toBe(RESET);
      expect(store.getProviderThrottle("claude")?.modelLanes?.[0]).toMatchObject({
        expired: true,
        exhaustedUntil: RESET,
      });
      expect(store.getProviderThrottle("claude")?.expired).toBe(false);

      const reset = store.resetController("claude");
      // Four provider decisions and three Fable ones: exhaustion is a gate,
      // never a reasoned period.
      expect(reset.clearedDecisions).toBe(7);
      expect(reasonedRows(store)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("migrates a v2 database by keeping every row, reasoned state included, as provider-wide", () => {
    const path = tempDb("rusa-588-v2-");
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
        controller_error REAL, controller_derivative REAL, controller_integral REAL,
        uncapped_interval_seconds REAL, interval_seconds REAL,
        PRIMARY KEY(provider, kind, observed_slot)
      );
      CREATE INDEX idx_quota_observations_provider_kind_time
        ON quota_observations(provider, kind, observed_at DESC);
      CREATE INDEX idx_quota_observations_reasoned
        ON quota_observations(provider, kind, observed_at DESC) WHERE interval_seconds IS NOT NULL;
    `);
    legacy
      .prepare(
        `INSERT INTO quota_observations
          (provider, kind, observed_slot, label, observed_at, percent_left, reset_at_iso,
           window_ms, processed, controller_error, controller_derivative, controller_integral,
           uncapped_interval_seconds, interval_seconds)
         VALUES ('claude', 'weekly', 1, 'Weekly', '2030-01-01T00:00:00.000Z', 50, ?,
                 604800000, 1, 3, 0.5, 120, 40, 40)`
      )
      .run(RESET);
    // Equal timestamps use rowid as the deterministic latest-reading tie
    // break. The migration must preserve that order as it rebuilds the table.
    legacy
      .prepare(
        `INSERT INTO quota_observations
          (provider, kind, observed_slot, label, observed_at, percent_left, reset_at_iso,
           window_ms, processed, controller_error, controller_derivative, controller_integral,
           uncapped_interval_seconds, interval_seconds)
         VALUES ('claude', 'weekly', 2, 'Weekly', '2030-01-01T00:00:00.000Z', 0, ?,
                 604800000, 1, 3, 0.5, 120, 40, 40)`
      )
      .run(RESET);
    legacy.pragma("user_version = 2");
    legacy.close();

    const store = new SharedQuotaStore(path);
    try {
      expect(store.db.pragma("user_version", { simple: true })).toBe(3);
      expect(
        store.db
          .prepare(
            `SELECT rowid, model_scope AS modelScope, percent_left AS percentLeft,
                    controller_integral AS integral, interval_seconds AS interval
             FROM quota_observations ORDER BY rowid`
          )
          .all()
      ).toEqual([
        { rowid: 1, modelScope: "", percentLeft: 50, integral: 120, interval: 40 },
        { rowid: 2, modelScope: "", percentLeft: 0, integral: 120, interval: 40 },
      ]);
      const indices = (
        store.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'quota_observations' ORDER BY name"
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(indices).toContain("idx_quota_observations_scope_kind_time");
      expect(indices).not.toContain("idx_quota_observations_provider_kind_time");
      expect(store.getProviderThrottle("claude")).toMatchObject({ intervalSeconds: 40 });
      expect(store.getProviderThrottle("claude")).toMatchObject({
        expired: true,
        exhaustedUntil: RESET,
      });
      expect(store.getProviderThrottle("claude")?.modelLanes).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

function laneStatus(
  overrides: Partial<PublishedThrottleProviderStatus> & { models?: string[] } = {}
): PublishedThrottleProviderStatus & { models: string[] } {
  return {
    provider: "claude",
    intervalSeconds: 10,
    uncappedIntervalSeconds: 10,
    governingBucketKey: null,
    capped: false,
    expired: false,
    exhaustedUntil: null,
    updatedAt: "2030-01-01T00:00:00.000Z",
    buckets: [],
    freshness: { ageMs: 0, buckets: {}, stale: false, hardStale: false },
    models: [FABLE],
    ...overrides,
  };
}

describe("model-scoped quota lanes: protocol (#588)", () => {
  it("combines only the lanes naming the candidate model, most restrictive first, in any order", () => {
    const status = {
      modelLanes: [
        laneStatus({ intervalSeconds: 30 }),
        laneStatus({ intervalSeconds: 90, models: [FABLE, "claude-fable-mini"] }),
        laneStatus({ intervalSeconds: 600, models: ["claude-other"] }),
      ],
    };
    const reversed = { modelLanes: [...status.modelLanes].reverse() };
    expect(modelLanePacing(status, FABLE)).toEqual({
      intervalSeconds: 90,
      deferUntil: null,
      exhaustedUntil: null,
    });
    expect(modelLanePacing(reversed, FABLE)).toEqual(modelLanePacing(status, FABLE));
    // A different Claude model ignores Fable-only windows entirely.
    expect(modelLanePacing(status, SONNET)).toBeUndefined();
    expect(modelLanePacing(status, undefined)).toBeUndefined();
    // An older coordinator publishes no model lanes: provider-only pacing.
    expect(modelLanePacing({}, FABLE)).toBeUndefined();
  });

  it("takes the latest exhaustion, and only fresh evidence as an absolute gate", () => {
    const early = "2030-01-02T00:00:00.000Z";
    const late = "2030-01-03T00:00:00.000Z";
    const pacing = modelLanePacing(
      {
        modelLanes: [
          laneStatus({ expired: true, exhaustedUntil: early }),
          laneStatus({
            expired: true,
            exhaustedUntil: late,
            freshness: { ageMs: 1, buckets: {}, stale: true, hardStale: false },
          }),
        ],
      },
      FABLE
    );
    expect(pacing).toEqual({ intervalSeconds: 10, deferUntil: late, exhaustedUntil: early });
  });

  it("ignores malformed lanes so they cannot pace any model", () => {
    const malformed = [
      { ...laneStatus(), models: [] },
      { ...laneStatus(), models: [""] },
      { ...laneStatus(), intervalSeconds: Number.NaN },
      { ...laneStatus(), intervalSeconds: -1 },
      { ...laneStatus(), freshness: undefined },
      "not a lane",
    ];
    expect(
      modelLanePacing(
        { modelLanes: malformed as unknown as PublishedThrottleProviderStatus["modelLanes"] },
        FABLE
      )
    ).toBeUndefined();
  });

  it("stale-widens a model lane on its own freshness and retires one the provider outlived", () => {
    const nowMs = Date.parse("2030-01-01T02:00:00.000Z");
    const options = {
      maxIntervalSeconds: 3600,
      staleAfterMs: 600_000,
      hardStaleAfterMs: 3_600_000,
      nowMs,
    };
    const provider = {
      provider: "claude",
      intervalSeconds: 5,
      uncappedIntervalSeconds: 5,
      governingBucketKey: "claude:weekly",
      capped: false,
      expired: false,
      exhaustedUntil: null,
      updatedAt: "2030-01-01T01:59:00.000Z",
      buckets: [],
    };
    const lane = (updatedAt: string, models: string[]) => ({
      ...provider,
      governingBucketKey: `claude[${models.join(",")}]:weekly`,
      intervalSeconds: 20,
      uncappedIntervalSeconds: 20,
      updatedAt,
      models,
    });
    const published = publishedThrottle(
      {
        ...provider,
        modelLanes: [
          lane("2030-01-01T01:58:00.000Z", [FABLE]),
          // Last seen more than the hard-stale horizon before the provider's
          // latest reading: the window is gone, not merely late.
          lane("2030-01-01T00:30:00.000Z", ["claude-retired"]),
        ],
      },
      options
    );
    expect(published.intervalSeconds).toBe(5);
    expect(published.modelLanes?.map((l) => [l.models, l.intervalSeconds])).toEqual([
      [[FABLE], 20],
    ]);

    // A coordinator that stops collecting ages both lanes together: each
    // widens to the ceiling on its own freshness instead of retiring.
    const outage = publishedThrottle(
      { ...provider, modelLanes: [lane("2030-01-01T01:58:00.000Z", [FABLE])] },
      { ...options, nowMs: nowMs + 2 * 3_600_000 }
    );
    expect(outage.intervalSeconds).toBe(3600);
    expect(outage.modelLanes?.[0]).toMatchObject({
      intervalSeconds: 3600,
      freshness: expect.objectContaining({ hardStale: true }),
    });
  });

  it("preserves scope identity from store to client over the coordinator socket", async () => {
    const path = tempDb("rusa-588-e2e-");
    const socketPath = join(path, "..", "coordinator.sock");
    const store = new SharedQuotaStore(path);
    const coordinator = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["claude"],
    });
    try {
      store.configureController({ maxIntervalSeconds: 36000 });
      const nowMs = Date.now();
      const resetAtIso = new Date(nowMs + 3 * 24 * 60 * 60 * 1000).toISOString();
      const state: ProviderQuotaSnapshot = {
        provider: "claude",
        status: "available",
        scrapedAt: new Date(nowMs).toISOString(),
        limits: [
          { ...providerLimit(60), resetAtIso },
          { ...fableLimit(5), resetAtIso },
        ],
      };
      const id = store.recordRaw({
        provider: "claude",
        scrapedAt: state.scrapedAt ?? "",
        rawOutput: "raw",
      });
      store.recordParsed(id, state, state);
      await coordinator.start();
      const client = new QuotaCoordinatorClient({ socketPath, configuredProviders: ["claude"] });

      await client.getThrottle();
      const published = client.getLastPublishedStatus("claude");
      expect(published?.governingBucketKey).toBe("claude:weekly");
      expect(published?.modelLanes).toEqual([
        expect.objectContaining({
          models: [FABLE],
          governingBucketKey: `claude[${FABLE}]:weekly`,
          intervalSeconds: store.getProviderThrottle("claude")?.modelLanes?.[0]?.intervalSeconds,
        }),
      ]);
      // The provider interval is the provider window's alone.
      expect(client.getLastAppliedInterval("claude")).toBe(
        store.getProviderThrottle("claude")?.intervalSeconds
      );

      const history = await client.getHistory("claude", new Date(nowMs - 60_000).toISOString());
      expect(history?.map((record) => record.models ?? null)).toEqual(
        expect.arrayContaining([null, [FABLE]])
      );
    } finally {
      await coordinator.stop();
      store.close();
    }
  }, 15_000);
});
