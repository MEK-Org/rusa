import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { QuotaScrape } from "../db/repositories/quota-scrape-repository.js";
import type { ProviderQuotaSnapshot, QuotaLimit } from "../mcp/quota-mcp.js";
import { canonicalQuotaBucketIdentity, quotaWindowMs } from "./bucket-key.js";

const SLOT_MS = 5 * 60 * 1000;
const SPIKE_DELTA_PERCENT = 80;
const SPIKE_NEIGHBOR_TOLERANCE_PERCENT = 10;
export const QUOTA_CONTROLLER_VERSION = 2;
export const DEFAULT_QUOTA_KP_SECONDS_PER_POINT = 120;
export const DEFAULT_QUOTA_KD_SECONDS_SQUARED_PER_POINT = 1800;
export const DEFAULT_QUOTA_DERIVATIVE_TAU_SECONDS = 1800;
export const DEFAULT_QUOTA_ACTUATOR_SMOOTHING = 0.25;
export const DEFAULT_QUOTA_MAX_SLEW_SECONDS = 900;

export function resolveQuotaDatabasePath(configuredPath: string, rusaHome: string): string {
  const expanded =
    configuredPath === "~" || configuredPath.startsWith("~/")
      ? join(homedir(), configuredPath.slice(2))
      : configuredPath;
  return isAbsolute(expanded) ? expanded : resolve(rusaHome, expanded);
}

export interface CanonicalQuotaObservation {
  scrapeId: string;
  bucketKey: string;
  poolId: string;
  provider: string;
  scope: "provider" | "model";
  kind: string;
  label: string;
  observedAt: string;
  percentLeft: number;
  resetAtIso: string | null;
  windowMs: number;
  sourceInstance: string;
  qualityScore: number;
}

export interface QuotaImportReport {
  sourceInstance: string;
  sourceRows: number;
  insertedRows: number;
  duplicateRows: number;
  canonicalObservations: number;
  rejectedAnomalies: number;
}

export interface QuotaControllerOptions {
  maxIntervalSeconds: number;
  kpSecondsPerPoint?: number;
  kdSecondsSquaredPerPoint?: number;
  derivativeTauSeconds?: number;
  actuatorSmoothing?: number;
  maxSlewSeconds?: number;
}

export interface PersistedQuotaBucketStatus {
  key: string;
  percentLeft: number;
  timeRemainingPct: number;
  error: number;
  derivative: number;
  requiredIntervalSeconds: number;
  resetAtIso: string | null;
  observedAt: string;
}

export interface PersistedQuotaProviderStatus {
  provider: string;
  intervalSeconds: number;
  uncappedIntervalSeconds: number;
  governingBucketKey: string | null;
  capped: boolean;
  held: boolean;
  expired: boolean;
  /** Runtime gate derived from quota evidence; never stored as a throttle period. */
  exhaustedUntil: string | null;
  updatedAt: string;
  buckets: PersistedQuotaBucketStatus[];
}

export interface QuotaHistoryRecord {
  bucketKey: string;
  scope: "provider" | "model";
  kind: string;
  label: string;
  observedAt: string;
  percentLeft: number;
  resetAtIso: string | null;
  /** Positive means quota is being consumed faster than even pacing. */
  controllerError: number | null;
  /** Null when the observation did not produce a reasoned control decision. */
  intervalSeconds: number | null;
}

interface ObservationCandidate extends CanonicalQuotaObservation {
  slot: number;
  carriedForward: boolean;
  anomaly: boolean;
  selected: boolean;
}

interface LegacyScrapeRow {
  id: string;
  provider: string;
  scraped_at: string;
  raw_output: string;
  parsed_state: string | null;
  inferred_parsed_state: string | null;
  parse_error: string | null;
}

function deterministicImportId(sourceInstance: string, sourceId: string): string {
  return createHash("sha256").update(`${sourceInstance}\0${sourceId}`).digest("hex");
}

function parsedSnapshot(value: string | null): ProviderQuotaSnapshot | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ProviderQuotaSnapshot;
  } catch {
    return null;
  }
}

function hasValidReset(observation: Pick<CanonicalQuotaObservation, "observedAt" | "resetAtIso">) {
  if (!observation.resetAtIso) return false;
  const observed = Date.parse(observation.observedAt);
  const reset = Date.parse(observation.resetAtIso);
  return Number.isFinite(observed) && Number.isFinite(reset) && reset > observed;
}

function carriedForward(state: ProviderQuotaSnapshot, limit: QuotaLimit): boolean {
  return (
    state.carriedForward === true ||
    limit.carriedForward === true ||
    state.explanations?.some(
      (explanation) =>
        explanation.window === limit.label && explanation.rule === "carried_forward_bad_read"
    ) === true
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

/**
 * Dedicated WAL-backed quota database. It retains every raw scrape while exposing a
 * separately marked canonical observation stream for control and dashboard reads.
 */
export class SharedQuotaStore {
  readonly db: Database.Database;
  private controllerOptions: QuotaControllerOptions | null = null;
  private controllerUpdated: ((provider: string) => void) | null = null;

  constructor(
    readonly databasePath: string,
    readonly poolId = "default",
    readonly sourceInstance = "unknown"
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 10000");
    this.ensureSchema();
  }

  close(): void {
    this.db.close();
  }

  configureController(options: QuotaControllerOptions): void {
    this.controllerOptions = options;
    this.advancePendingController(options);
  }

  setControllerUpdatedListener(listener: ((provider: string) => void) | null): void {
    this.controllerUpdated = listener;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quota_scrapes (
        id TEXT PRIMARY KEY,
        source_instance TEXT NOT NULL,
        source_scrape_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        scraped_at TEXT NOT NULL,
        raw_output TEXT NOT NULL,
        parsed_state TEXT,
        inferred_parsed_state TEXT,
        parse_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source_instance, source_scrape_id)
      );
      CREATE INDEX IF NOT EXISTS idx_shared_quota_scrapes_provider_time
        ON quota_scrapes(provider, scraped_at);

      CREATE TABLE IF NOT EXISTS quota_observations (
        scrape_id TEXT NOT NULL REFERENCES quota_scrapes(id) ON DELETE CASCADE,
        bucket_key TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        slot INTEGER NOT NULL,
        percent_left REAL NOT NULL,
        reset_at_iso TEXT,
        window_ms INTEGER NOT NULL,
        source_instance TEXT NOT NULL,
        carried_forward INTEGER NOT NULL DEFAULT 0,
        anomaly INTEGER NOT NULL DEFAULT 0,
        selected INTEGER NOT NULL DEFAULT 0,
        quality_score REAL NOT NULL DEFAULT 0,
        controller_disposition TEXT,
        controller_version INTEGER,
        PRIMARY KEY(scrape_id, bucket_key)
      );
      CREATE INDEX IF NOT EXISTS idx_quota_observations_canonical
        ON quota_observations(bucket_key, selected, observed_at);

      CREATE TABLE IF NOT EXISTS quota_bucket_state (
        bucket_key TEXT PRIMARY KEY,
        pool_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        reset_at_iso TEXT,
        interval_seconds REAL NOT NULL DEFAULT 0,
        uncapped_interval_seconds REAL NOT NULL DEFAULT 0,
        last_error REAL,
        filtered_derivative REAL,
        last_percent_left REAL,
        last_observed_at TEXT,
        last_scrape_id TEXT,
        controller_version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS quota_provider_state (
        pool_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        interval_seconds REAL NOT NULL DEFAULT 0,
        uncapped_interval_seconds REAL NOT NULL DEFAULT 0,
        governing_bucket_key TEXT,
        capped INTEGER NOT NULL DEFAULT 0,
        held INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(pool_id, provider)
      );

      CREATE TABLE IF NOT EXISTS quota_provider_starts (
        id TEXT PRIMARY KEY,
        pool_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        source_instance TEXT NOT NULL,
        started_at TEXT NOT NULL,
        responsive INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quota_provider_starts_lookup
        ON quota_provider_starts(pool_id, provider, responsive, started_at);

      CREATE TABLE IF NOT EXISTS quota_throttle_decisions (
        scrape_id TEXT NOT NULL,
        bucket_key TEXT NOT NULL,
        observed_slot INTEGER NOT NULL,
        provider TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        percent_left REAL NOT NULL,
        time_remaining_pct REAL NOT NULL,
        error REAL NOT NULL,
        derivative REAL NOT NULL,
        interval_seconds REAL NOT NULL,
        uncapped_interval_seconds REAL NOT NULL,
        selected INTEGER NOT NULL DEFAULT 1,
        controller_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(scrape_id, bucket_key),
        UNIQUE(bucket_key, observed_slot)
      );
    `);
    const observationColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(quota_observations)").all() as Array<{ name: string }>
      ).map((column) => column.name)
    );
    if (!observationColumns.has("controller_disposition")) {
      this.db.exec("ALTER TABLE quota_observations ADD COLUMN controller_disposition TEXT");
    }
    if (!observationColumns.has("controller_version")) {
      this.db.exec("ALTER TABLE quota_observations ADD COLUMN controller_version INTEGER");
    }
  }

  recordRaw(opts: { provider: string; scrapedAt: string; rawOutput: string }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO quota_scrapes
          (id, source_instance, source_scrape_id, provider, scraped_at, raw_output)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, this.sourceInstance, id, opts.provider, opts.scrapedAt, opts.rawOutput);
    return id;
  }

  recordParsed(
    id: string,
    rawParsed: ProviderQuotaSnapshot,
    inferredParsed: ProviderQuotaSnapshot
  ): void {
    const { raw: _raw1, ...rawState } = rawParsed;
    const { raw: _raw2, ...inferredState } = inferredParsed;
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE quota_scrapes
           SET parsed_state = ?, inferred_parsed_state = ?, parse_error = NULL
           WHERE id = ?`
        )
        .run(JSON.stringify(rawState), JSON.stringify(inferredState), id);
      this.rebuildCanonicalObservations(inferredParsed.provider);
    })();
    if (this.controllerOptions) {
      this.advancePendingController(this.controllerOptions, inferredParsed.provider);
      this.controllerUpdated?.(inferredParsed.provider);
    }
  }

  recordParseError(id: string, error: unknown): void {
    this.db
      .prepare("UPDATE quota_scrapes SET parse_error = ? WHERE id = ?")
      .run(error instanceof Error ? (error.stack ?? error.message) : String(error), id);
  }

  listSince(provider: string, sinceIso: string): QuotaScrape[] {
    const rows = this.db
      .prepare(
        `SELECT id, provider, scraped_at, raw_output, parsed_state,
                inferred_parsed_state, parse_error
         FROM quota_scrapes WHERE provider = ? AND scraped_at >= ?
         ORDER BY scraped_at ASC, rowid ASC`
      )
      .all(provider, sinceIso) as LegacyScrapeRow[];
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      scrapedAt: row.scraped_at,
      rawOutput: row.raw_output,
      parsedState: parsedSnapshot(row.parsed_state),
      inferredParsedState: parsedSnapshot(row.inferred_parsed_state),
      parseError: row.parse_error,
    }));
  }

  listCanonicalSince(provider: string, sinceIso: string): CanonicalQuotaObservation[] {
    return this.db
      .prepare(
        `SELECT scrape_id AS scrapeId, bucket_key AS bucketKey, pool_id AS poolId,
                provider, scope, kind, label, observed_at AS observedAt,
                percent_left AS percentLeft, reset_at_iso AS resetAtIso,
                window_ms AS windowMs, source_instance AS sourceInstance,
                quality_score AS qualityScore
         FROM quota_observations
         WHERE provider = ? AND observed_at >= ? AND selected = 1
         ORDER BY observed_at ASC, rowid ASC`
      )
      .all(provider, sinceIso) as CanonicalQuotaObservation[];
  }

  listHistorySince(provider: string, sinceIso: string): QuotaHistoryRecord[] {
    return this.db
      .prepare(
        `SELECT o.bucket_key AS bucketKey, o.scope, o.kind, o.label,
                o.observed_at AS observedAt, o.percent_left AS percentLeft,
                o.reset_at_iso AS resetAtIso, d.error AS controllerError,
                d.interval_seconds AS intervalSeconds
         FROM quota_observations o
         LEFT JOIN quota_throttle_decisions d
           ON d.bucket_key = o.bucket_key AND d.observed_slot = o.slot
         WHERE o.pool_id = ? AND o.provider = ? AND o.selected = 1
           AND o.observed_at >= ?
         ORDER BY o.observed_at ASC, o.rowid ASC`
      )
      .all(this.poolId, provider, sinceIso) as QuotaHistoryRecord[];
  }

  /**
   * Advance every unprocessed canonical observation exactly once. The IMMEDIATE
   * transaction serializes two rusa instances sharing this database.
   */
  advancePendingController(opts: QuotaControllerOptions, provider?: string): void {
    const run = this.db.transaction(() => {
      const observations = this.db
        .prepare(
          `SELECT scrape_id AS scrapeId, bucket_key AS bucketKey, pool_id AS poolId,
                  provider, scope, kind, label, observed_at AS observedAt,
                  percent_left AS percentLeft, reset_at_iso AS resetAtIso,
                  window_ms AS windowMs, source_instance AS sourceInstance,
                  quality_score AS qualityScore, slot
           FROM quota_observations o
           WHERE selected = 1
             AND controller_disposition IS NULL
             AND (? IS NULL OR provider = ?)
             AND NOT EXISTS (
               SELECT 1 FROM quota_throttle_decisions d
               WHERE d.bucket_key = o.bucket_key AND d.observed_slot = o.slot
             )
           ORDER BY observed_at ASC, rowid ASC`
        )
        .all(provider ?? null, provider ?? null) as Array<
        CanonicalQuotaObservation & { slot: number }
      >;
      for (const observation of observations) this.advanceObservation(observation, opts);
      const providers = provider
        ? [provider]
        : (
            this.db
              .prepare("SELECT DISTINCT provider FROM quota_bucket_state WHERE pool_id = ?")
              .all(this.poolId) as Array<{ provider: string }>
          ).map((row) => row.provider);
      for (const providerName of providers) this.refreshProviderState(providerName, opts);
    });
    run.immediate();
  }

  private advanceObservation(
    observation: CanonicalQuotaObservation & { slot: number },
    opts: QuotaControllerOptions
  ): void {
    if (!observation.resetAtIso) {
      this.markControllerInput(observation, "missing_reset");
      return;
    }
    const observedMs = Date.parse(observation.observedAt);
    const resetMs = Date.parse(observation.resetAtIso);
    if (!Number.isFinite(observedMs) || !Number.isFinite(resetMs)) {
      this.markControllerInput(observation, "invalid_timestamp");
      return;
    }
    if (resetMs <= observedMs) {
      this.markControllerInput(observation, "stale_reset");
      return;
    }
    // Exhaustion is an operational interlock, not a control output. Keep the
    // observation, mark it consumed, and leave every controller state value
    // untouched. The launch gate derives its temporary block from the latest
    // observation and reset timestamp.
    if (observation.percentLeft <= 0) {
      this.markControllerInput(observation, "exhausted");
      return;
    }
    const previous = this.db
      .prepare("SELECT * FROM quota_bucket_state WHERE bucket_key = ?")
      .get(observation.bucketKey) as
      | {
          interval_seconds: number;
          last_error: number | null;
          filtered_derivative: number | null;
          last_observed_at: string | null;
          reset_at_iso: string | null;
        }
      | undefined;
    const timeRemainingPct = Math.min(
      100,
      Math.max(0, ((resetMs - observedMs) / observation.windowMs) * 100)
    );
    const error = timeRemainingPct - observation.percentLeft;
    const cycleChanged =
      previous?.reset_at_iso != null &&
      Math.abs(Date.parse(previous.reset_at_iso) - resetMs) >
        Math.min(60 * 60 * 1000, observation.windowMs * 0.05);
    const previousObservedMs = previous?.last_observed_at
      ? Date.parse(previous.last_observed_at)
      : Number.NaN;
    const dtSeconds = Number.isFinite(previousObservedMs)
      ? Math.max(1, (observedMs - previousObservedMs) / 1000)
      : 0;
    const rawDerivative =
      !cycleChanged && dtSeconds > 0 && previous?.last_error != null
        ? (error - previous.last_error) / dtSeconds
        : 0;
    const derivativeTau = opts.derivativeTauSeconds ?? DEFAULT_QUOTA_DERIVATIVE_TAU_SECONDS;
    const derivativeAlpha = dtSeconds > 0 ? dtSeconds / (derivativeTau + dtSeconds) : 1;
    const previousDerivative = cycleChanged ? 0 : (previous?.filtered_derivative ?? 0);
    const derivative = previousDerivative + derivativeAlpha * (rawDerivative - previousDerivative);
    const kp = opts.kpSecondsPerPoint ?? DEFAULT_QUOTA_KP_SECONDS_PER_POINT;
    const kd = opts.kdSecondsSquaredPerPoint ?? DEFAULT_QUOTA_KD_SECONDS_SQUARED_PER_POINT;
    const uncappedCandidate = Math.max(0, kp * error + kd * derivative);
    // A new quota cycle resets the derivative, but not the actuator. Starting
    // from the last reasoned period avoids a zero-period restart after rollover.
    const previousInterval = previous?.interval_seconds ?? 0;
    const smoothing = opts.actuatorSmoothing ?? DEFAULT_QUOTA_ACTUATOR_SMOOTHING;
    const smoothed = previousInterval + smoothing * (uncappedCandidate - previousInterval);
    const maxSlew = opts.maxSlewSeconds ?? DEFAULT_QUOTA_MAX_SLEW_SECONDS;
    const uncappedInterval = Math.max(
      0,
      Math.min(previousInterval + maxSlew, Math.max(previousInterval - maxSlew, smoothed))
    );
    const interval = Math.min(opts.maxIntervalSeconds, uncappedInterval);

    this.db
      .prepare(
        `INSERT INTO quota_bucket_state
          (bucket_key, pool_id, provider, scope, kind, label, reset_at_iso,
           interval_seconds, uncapped_interval_seconds, last_error,
           filtered_derivative, last_percent_left, last_observed_at, last_scrape_id,
           controller_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bucket_key) DO UPDATE SET
           label = excluded.label, reset_at_iso = excluded.reset_at_iso,
           interval_seconds = excluded.interval_seconds,
           uncapped_interval_seconds = excluded.uncapped_interval_seconds,
           last_error = excluded.last_error,
           filtered_derivative = excluded.filtered_derivative,
           last_percent_left = excluded.last_percent_left,
           last_observed_at = excluded.last_observed_at,
           last_scrape_id = excluded.last_scrape_id,
           controller_version = excluded.controller_version,
           updated_at = excluded.updated_at`
      )
      .run(
        observation.bucketKey,
        observation.poolId,
        observation.provider,
        observation.scope,
        observation.kind,
        observation.label,
        observation.resetAtIso,
        interval,
        uncappedInterval,
        error,
        derivative,
        observation.percentLeft,
        observation.observedAt,
        observation.scrapeId,
        QUOTA_CONTROLLER_VERSION,
        observation.observedAt
      );
    this.db
      .prepare(
        `INSERT OR IGNORE INTO quota_throttle_decisions
          (scrape_id, bucket_key, observed_slot, provider, observed_at, percent_left,
           time_remaining_pct, error, derivative, interval_seconds,
           uncapped_interval_seconds, controller_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        observation.scrapeId,
        observation.bucketKey,
        observation.slot,
        observation.provider,
        observation.observedAt,
        observation.percentLeft,
        timeRemainingPct,
        error,
        derivative,
        interval,
        uncappedInterval,
        QUOTA_CONTROLLER_VERSION
      );
    this.markControllerInput(observation, "applied");
  }

  private markControllerInput(
    observation: Pick<CanonicalQuotaObservation, "scrapeId" | "bucketKey">,
    disposition: "applied" | "exhausted" | "missing_reset" | "invalid_timestamp" | "stale_reset"
  ): void {
    this.db
      .prepare(
        `UPDATE quota_observations
         SET controller_disposition = ?, controller_version = ?
         WHERE scrape_id = ? AND bucket_key = ?`
      )
      .run(disposition, QUOTA_CONTROLLER_VERSION, observation.scrapeId, observation.bucketKey);
  }

  private refreshProviderState(provider: string, opts: QuotaControllerOptions): void {
    const buckets = this.db
      .prepare(
        `SELECT bucket_key, interval_seconds, uncapped_interval_seconds,
                last_percent_left, reset_at_iso, last_observed_at
         FROM quota_bucket_state WHERE pool_id = ? AND provider = ?`
      )
      .all(this.poolId, provider) as Array<{
      bucket_key: string;
      interval_seconds: number;
      uncapped_interval_seconds: number;
      last_percent_left: number | null;
      reset_at_iso: string | null;
      last_observed_at: string | null;
    }>;
    if (buckets.length === 0) return;
    buckets.sort((a, b) => b.uncapped_interval_seconds - a.uncapped_interval_seconds);
    const governing = buckets[0];
    if (!governing) return;
    const uncapped = governing.uncapped_interval_seconds;
    const interval = Math.min(opts.maxIntervalSeconds, uncapped);
    const updatedAt =
      buckets
        .map((bucket) => bucket.last_observed_at)
        .filter((value): value is string => value != null)
        .sort()
        .at(-1) ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO quota_provider_state
          (pool_id, provider, interval_seconds, uncapped_interval_seconds,
           governing_bucket_key, capped, held, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(pool_id, provider) DO UPDATE SET
           interval_seconds = excluded.interval_seconds,
           uncapped_interval_seconds = excluded.uncapped_interval_seconds,
           governing_bucket_key = excluded.governing_bucket_key,
           capped = excluded.capped, held = excluded.held,
           updated_at = excluded.updated_at`
      )
      .run(
        this.poolId,
        provider,
        interval,
        uncapped,
        governing.bucket_key,
        uncapped > opts.maxIntervalSeconds ? 1 : 0,
        updatedAt
      );
  }

  /**
   * Resolve the temporary exhaustion gate from canonical quota evidence. This
   * value is deliberately not written into controller/provider throttle state.
   */
  getExhaustedUntil(provider: string, nowMs = Date.now()): string | null {
    const rows = this.db
      .prepare(
        `SELECT o.percent_left, o.reset_at_iso
         FROM quota_observations o
         WHERE o.pool_id = ? AND o.provider = ? AND o.selected = 1
           AND NOT EXISTS (
             SELECT 1 FROM quota_observations newer
             WHERE newer.bucket_key = o.bucket_key AND newer.selected = 1
               AND (newer.observed_at > o.observed_at OR
                    (newer.observed_at = o.observed_at AND newer.rowid > o.rowid))
           )`
      )
      .all(this.poolId, provider) as Array<{
      percent_left: number;
      reset_at_iso: string | null;
    }>;
    let latestResetMs = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
      if (row.percent_left > 0 || !row.reset_at_iso) continue;
      const resetMs = Date.parse(row.reset_at_iso);
      if (Number.isFinite(resetMs) && resetMs > nowMs)
        latestResetMs = Math.max(latestResetMs, resetMs);
    }
    return Number.isFinite(latestResetMs) ? new Date(latestResetMs).toISOString() : null;
  }

  getProviderThrottle(provider: string): PersistedQuotaProviderStatus | null {
    const state = this.db
      .prepare("SELECT * FROM quota_provider_state WHERE pool_id = ? AND provider = ?")
      .get(this.poolId, provider) as
      | {
          provider: string;
          interval_seconds: number;
          uncapped_interval_seconds: number;
          governing_bucket_key: string | null;
          capped: number;
          held: number;
          updated_at: string;
        }
      | undefined;
    if (!state) return null;
    const buckets = this.db
      .prepare(
        `SELECT bucket_key AS key, last_percent_left AS percentLeft,
                last_error AS error, filtered_derivative AS derivative,
                interval_seconds AS requiredIntervalSeconds,
                reset_at_iso AS resetAtIso, last_observed_at AS observedAt,
                kind
         FROM quota_bucket_state WHERE pool_id = ? AND provider = ?`
      )
      .all(this.poolId, provider) as Array<
      Omit<PersistedQuotaBucketStatus, "timeRemainingPct"> & { kind: string }
    >;
    const now = Date.parse(state.updated_at);
    const exhaustedUntil = this.getExhaustedUntil(provider);
    return {
      provider: state.provider,
      intervalSeconds: state.interval_seconds,
      uncappedIntervalSeconds: state.uncapped_interval_seconds,
      governingBucketKey: state.governing_bucket_key,
      capped: state.capped === 1,
      held: state.held === 1,
      expired: exhaustedUntil !== null,
      exhaustedUntil,
      updatedAt: state.updated_at,
      buckets: buckets.map(({ kind, ...bucket }) => ({
        ...bucket,
        timeRemainingPct:
          bucket.resetAtIso && Number.isFinite(now)
            ? Math.min(
                100,
                Math.max(
                  0,
                  ((Date.parse(bucket.resetAtIso) - now) /
                    quotaWindowMs(kind as "session" | "five_hour" | "weekly" | "other")) *
                    100
                )
              )
            : 0,
      })),
    };
  }

  recordProviderStart(provider: string, startedAt: string, responsive: boolean): void {
    this.db
      .prepare(
        `INSERT INTO quota_provider_starts
          (id, pool_id, provider, source_instance, started_at, responsive)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), this.poolId, provider, this.sourceInstance, startedAt, responsive ? 1 : 0);
  }

  /**
   * Atomically claim a normal provider start across every instance sharing the
   * account. A future timestamp means the caller must wait and retry; null
   * means the start was durably claimed.
   */
  claimNormalProviderStart(provider: string, startedAtMs = Date.now()): number | null {
    if (!Number.isFinite(startedAtMs) || startedAtMs < 0) {
      throw new Error(`startedAtMs must be a non-negative finite number, got ${startedAtMs}`);
    }
    const claim = this.db.transaction(() => {
      const throttle = this.db
        .prepare(
          `SELECT interval_seconds FROM quota_provider_state
           WHERE pool_id = ? AND provider = ?`
        )
        .get(this.poolId, provider) as { interval_seconds: number } | undefined;
      const previous = this.latestNormalStartMillis(provider);
      const exhaustedUntil = this.getExhaustedUntil(provider, startedAtMs);
      const exhaustedUntilMs = exhaustedUntil ? Date.parse(exhaustedUntil) : 0;
      const nextFromPacing =
        previous == null ? 0 : previous + Math.max(0, throttle?.interval_seconds ?? 0) * 1000;
      const availableAt = Math.max(nextFromPacing, exhaustedUntilMs);
      if (startedAtMs < availableAt) return availableAt;
      this.recordProviderStart(provider, new Date(startedAtMs).toISOString(), false);
      return null;
    });
    return claim.immediate();
  }

  latestNormalStartMillis(provider: string): number | null {
    const row = this.db
      .prepare(
        `SELECT started_at FROM quota_provider_starts
         WHERE pool_id = ? AND provider = ? AND responsive = 0
         ORDER BY started_at DESC, rowid DESC LIMIT 1`
      )
      .get(this.poolId, provider) as { started_at: string } | undefined;
    if (!row) return null;
    const parsed = Date.parse(row.started_at);
    return Number.isFinite(parsed) ? parsed : null;
  }

  importLegacyDatabase(sourcePath: string, sourceInstance: string): QuotaImportReport {
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      const hasInferred = (
        source.prepare("PRAGMA table_info(quota_scrapes)").all() as Array<{ name: string }>
      ).some((column) => column.name === "inferred_parsed_state");
      const rows = source
        .prepare(
          `SELECT id, provider, scraped_at, raw_output, parsed_state,
                  ${hasInferred ? "inferred_parsed_state" : "NULL"} AS inferred_parsed_state,
                  parse_error
           FROM quota_scrapes ORDER BY scraped_at ASC, rowid ASC`
        )
        .all() as LegacyScrapeRow[];
      let insertedRows = 0;
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO quota_scrapes
          (id, source_instance, source_scrape_id, provider, scraped_at, raw_output,
           parsed_state, inferred_parsed_state, parse_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      this.db.transaction(() => {
        for (const row of rows) {
          const result = insert.run(
            deterministicImportId(sourceInstance, row.id),
            sourceInstance,
            row.id,
            row.provider,
            row.scraped_at,
            row.raw_output,
            row.parsed_state,
            row.inferred_parsed_state ?? row.parsed_state,
            row.parse_error
          );
          insertedRows += result.changes;
        }
        this.rebuildCanonicalObservations();
      })();
      const summary = this.db
        .prepare(
          `SELECT count(*) observations,
                  sum(CASE WHEN selected = 1 THEN 1 ELSE 0 END) canonical,
                  sum(CASE WHEN anomaly = 1 THEN 1 ELSE 0 END) anomalies
           FROM quota_observations`
        )
        .get() as { observations: number; canonical: number | null; anomalies: number | null };
      return {
        sourceInstance,
        sourceRows: rows.length,
        insertedRows,
        duplicateRows: rows.length - insertedRows,
        canonicalObservations: summary.canonical ?? 0,
        rejectedAnomalies: summary.anomalies ?? 0,
      };
    } finally {
      source.close();
    }
  }

  /** Rebuild derived evidence; raw scrapes remain immutable and complete. */
  rebuildCanonicalObservations(provider?: string): void {
    const rows = this.db
      .prepare(
        `SELECT id, source_instance, provider, scraped_at, inferred_parsed_state
         FROM quota_scrapes
         WHERE inferred_parsed_state IS NOT NULL
           AND (? IS NULL OR provider = ?)
         ORDER BY scraped_at ASC, rowid ASC`
      )
      .all(provider ?? null, provider ?? null) as Array<{
      id: string;
      source_instance: string;
      provider: string;
      scraped_at: string;
      inferred_parsed_state: string;
    }>;
    const candidates: ObservationCandidate[] = [];
    for (const row of rows) {
      const state = parsedSnapshot(row.inferred_parsed_state);
      if (!state) continue;
      const observedMs = Date.parse(row.scraped_at);
      if (!Number.isFinite(observedMs)) continue;
      // One provider-wide control bucket exists per normalized window kind.
      // Older parsers sometimes omitted scope on an additional model-specific
      // row; retaining only the first provider candidate repairs that legacy
      // ambiguity without putting free-text labels into durable keys. The full
      // original snapshot remains in quota_scrapes as evidence.
      const seenProviderBuckets = new Set<string>();
      for (const limit of state.limits ?? []) {
        if (limit.scope === "model" || !Number.isFinite(limit.percentLeft)) continue;
        if (limit.percentLeft < 0 || limit.percentLeft > 100) continue;
        const identity = canonicalQuotaBucketIdentity(this.poolId, row.provider, limit);
        if (seenProviderBuckets.has(identity.key)) continue;
        seenProviderBuckets.add(identity.key);
        candidates.push({
          scrapeId: row.id,
          bucketKey: identity.key,
          poolId: identity.poolId,
          provider: identity.provider,
          scope: identity.scope,
          kind: identity.kind,
          label: limit.label,
          observedAt: row.scraped_at,
          slot: Math.floor(observedMs / SLOT_MS),
          percentLeft: limit.percentLeft,
          resetAtIso: limit.resetAtIso ?? null,
          windowMs: quotaWindowMs(identity.kind),
          sourceInstance: row.source_instance,
          carriedForward: carriedForward(state, limit),
          anomaly: false,
          selected: false,
          qualityScore: 0,
        });
      }
    }

    const byBucket = new Map<string, ObservationCandidate[]>();
    for (const candidate of candidates) {
      const list = byBucket.get(candidate.bucketKey) ?? [];
      list.push(candidate);
      byBucket.set(candidate.bucketKey, list);
    }

    for (const bucket of byBucket.values()) {
      const bySlot = new Map<number, ObservationCandidate[]>();
      for (const candidate of bucket) {
        const list = bySlot.get(candidate.slot) ?? [];
        list.push(candidate);
        bySlot.set(candidate.slot, list);
      }
      const slots = [...bySlot.entries()].sort(([a], [b]) => a - b);
      const slotMedians = slots.map(([, values]) =>
        median(values.map((value) => value.percentLeft))
      );
      for (let index = 1; index < slots.length - 1; index++) {
        const previous = slotMedians[index - 1] ?? 0;
        const current = slotMedians[index] ?? 0;
        const next = slotMedians[index + 1] ?? 0;
        const isolatedSpike =
          current - previous >= SPIKE_DELTA_PERCENT &&
          current - next >= SPIKE_DELTA_PERCENT &&
          Math.abs(next - previous) <= SPIKE_NEIGHBOR_TOLERANCE_PERCENT;
        if (isolatedSpike) {
          for (const candidate of slots[index]?.[1] ?? []) candidate.anomaly = true;
        }
      }

      const reliability = new Map<string, number>();
      for (const source of new Set(bucket.map((candidate) => candidate.sourceInstance))) {
        const sourceValues = bucket.filter((candidate) => candidate.sourceInstance === source);
        reliability.set(
          source,
          sourceValues.length === 0
            ? 0
            : sourceValues.filter((candidate) => hasValidReset(candidate)).length /
                sourceValues.length
        );
      }

      for (const [, values] of slots) {
        const slotMedian = median(values.map((value) => value.percentLeft));
        for (const candidate of values) {
          candidate.qualityScore =
            (hasValidReset(candidate) ? 40 : 0) +
            (candidate.carriedForward ? -10 : 10) +
            (reliability.get(candidate.sourceInstance) ?? 0) * 20 +
            Math.max(0, 10 - Math.abs(candidate.percentLeft - slotMedian)) +
            (candidate.anomaly ? -100 : 0);
        }
        values.sort(
          (a, b) =>
            b.qualityScore - a.qualityScore ||
            Date.parse(b.observedAt) - Date.parse(a.observedAt) ||
            a.sourceInstance.localeCompare(b.sourceInstance)
        );
        const winner = values.find((candidate) => !candidate.anomaly);
        if (winner) winner.selected = true;
      }
    }

    const replace = this.db.transaction(() => {
      if (provider) {
        this.db
          .prepare("DELETE FROM quota_observations WHERE pool_id = ? AND provider = ?")
          .run(this.poolId, provider);
      } else {
        this.db.prepare("DELETE FROM quota_observations WHERE pool_id = ?").run(this.poolId);
      }
      const insert = this.db.prepare(
        `INSERT INTO quota_observations
          (scrape_id, bucket_key, pool_id, provider, scope, kind, label, observed_at,
           slot, percent_left, reset_at_iso, window_ms, source_instance,
           carried_forward, anomaly, selected, quality_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const candidate of candidates) {
        insert.run(
          candidate.scrapeId,
          candidate.bucketKey,
          candidate.poolId,
          candidate.provider,
          candidate.scope,
          candidate.kind,
          candidate.label,
          candidate.observedAt,
          candidate.slot,
          candidate.percentLeft,
          candidate.resetAtIso,
          candidate.windowMs,
          candidate.sourceInstance,
          candidate.carriedForward ? 1 : 0,
          candidate.anomaly ? 1 : 0,
          candidate.selected ? 1 : 0,
          candidate.qualityScore
        );
      }
    });
    replace();
    this.reconcileControllerWithCanonicalEvidence();
  }

  /** Relearn deterministically when later evidence invalidates an earlier winner. */
  private reconcileControllerWithCanonicalEvidence(): void {
    const stale = this.db
      .prepare(
        `SELECT 1
         FROM quota_throttle_decisions d
         WHERE d.bucket_key IN (
           SELECT DISTINCT bucket_key FROM quota_observations WHERE pool_id = ?
         )
           AND NOT EXISTS (
             SELECT 1 FROM quota_observations o
             WHERE o.scrape_id = d.scrape_id AND o.bucket_key = d.bucket_key
               AND o.selected = 1
           )
         LIMIT 1`
      )
      .get(this.poolId);
    if (!stale) return;
    this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM quota_throttle_decisions
           WHERE bucket_key IN (
             SELECT DISTINCT bucket_key FROM quota_observations WHERE pool_id = ?
           )`
        )
        .run(this.poolId);
      this.db.prepare("DELETE FROM quota_bucket_state WHERE pool_id = ?").run(this.poolId);
      this.db.prepare("DELETE FROM quota_provider_state WHERE pool_id = ?").run(this.poolId);
      this.db
        .prepare(
          `UPDATE quota_observations
           SET controller_disposition = NULL, controller_version = NULL
           WHERE pool_id = ?`
        )
        .run(this.poolId);
    })();
  }
}
