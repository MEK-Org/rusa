import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { QuotaScrape } from "../db/repositories/quota-scrape-repository.js";
import type { ProviderQuotaSnapshot, QuotaWindowKind } from "../mcp/quota-mcp.js";

const SLOT_MS = 5 * 60 * 1000;
export const QUOTA_RAW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// The product requirement is a PD controller. These are deliberately fixed
// implementation constants rather than configuration that no caller uses.
export const QUOTA_KP_SECONDS_PER_POINT = 120;
export const QUOTA_KD_SECONDS_SQUARED_PER_POINT = 1800;
export const QUOTA_DERIVATIVE_TAU_SECONDS = 1800;
export const QUOTA_ACTUATOR_SMOOTHING = 0.25;
export const QUOTA_MAX_SLEW_SECONDS = 900;

export function resolveQuotaDatabasePath(configuredPath: string, rusaHome: string): string {
  const expanded =
    configuredPath === "~" || configuredPath.startsWith("~/")
      ? join(homedir(), configuredPath.slice(2))
      : configuredPath;
  return isAbsolute(expanded) ? expanded : resolve(rusaHome, expanded);
}

function quotaWindowMs(kind: string): number {
  return kind === "weekly" ? 7 * 24 * 60 * 60 * 1000 : 5 * 60 * 60 * 1000;
}

function normalizeKind(kind: QuotaWindowKind | undefined): QuotaWindowKind {
  return kind === "session" || kind === "five_hour" || kind === "weekly" ? kind : "other";
}

function hasValidReset(observation: Pick<CanonicalQuotaObservation, "observedAt" | "resetAtIso">) {
  if (!observation.resetAtIso) return false;
  const observed = Date.parse(observation.observedAt);
  const reset = Date.parse(observation.resetAtIso);
  return Number.isFinite(observed) && Number.isFinite(reset) && reset > observed;
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

export interface CanonicalQuotaObservation {
  scrapeId: string;
  provider: string;
  kind: string;
  label: string;
  observedAt: string;
  percentLeft: number;
  resetAtIso: string | null;
  windowMs: number;
  sourceInstance: string;
}

export interface QuotaImportReport {
  sourceInstance: string;
  sourceRows: number;
  insertedRows: number;
  duplicateRows: number;
  expiredRows: number;
  canonicalObservations: number;
}

export interface QuotaControllerOptions {
  maxIntervalSeconds: number;
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
  scope: "provider";
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

interface StoredObservation extends CanonicalQuotaObservation {
  slot: number;
  processed: number;
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

/**
 * WAL-backed quota storage shared by every instance using the same provider
 * credentials. Raw evidence is retained for 30 days; compact canonical
 * observations and controller memory remain durable.
 */
export class SharedQuotaStore {
  readonly db: Database.Database;
  private controllerOptions: QuotaControllerOptions | null = null;
  private controllerUpdated: ((provider: string) => void) | null = null;

  constructor(
    readonly databasePath: string,
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
        parse_error TEXT,
        UNIQUE(source_instance, source_scrape_id)
      );
      CREATE INDEX IF NOT EXISTS idx_shared_quota_scrapes_provider_time
        ON quota_scrapes(provider, scraped_at);

      CREATE TABLE IF NOT EXISTS quota_observations (
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        observed_slot INTEGER NOT NULL,
        scrape_id TEXT NOT NULL,
        label TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        percent_left REAL NOT NULL,
        reset_at_iso TEXT,
        window_ms INTEGER NOT NULL,
        source_instance TEXT NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0,
        controller_error REAL,
        interval_seconds REAL,
        PRIMARY KEY(provider, kind, observed_slot)
      );
      CREATE INDEX IF NOT EXISTS idx_quota_observations_provider_time
        ON quota_observations(provider, observed_at);

      CREATE TABLE IF NOT EXISTS quota_bucket_state (
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        reset_at_iso TEXT,
        interval_seconds REAL NOT NULL,
        uncapped_interval_seconds REAL NOT NULL,
        last_error REAL NOT NULL,
        filtered_derivative REAL NOT NULL,
        last_percent_left REAL NOT NULL,
        last_observed_at TEXT NOT NULL,
        PRIMARY KEY(provider, kind)
      );

      CREATE TABLE IF NOT EXISTS quota_provider_pacing (
        provider TEXT PRIMARY KEY,
        last_normal_start_at TEXT NOT NULL
      );
    `);
  }

  pruneRawScrapes(nowMs = Date.now()): number {
    if (!Number.isFinite(nowMs)) throw new Error(`nowMs must be finite, got ${nowMs}`);
    const cutoff = new Date(nowMs - QUOTA_RAW_RETENTION_MS).toISOString();
    return this.db.prepare("DELETE FROM quota_scrapes WHERE scraped_at < ?").run(cutoff).changes;
  }

  recordRaw(opts: { provider: string; scrapedAt: string; rawOutput: string }): string {
    const id = randomUUID();
    this.db.transaction(() => {
      this.pruneRawScrapes();
      this.db
        .prepare(
          `INSERT INTO quota_scrapes
            (id, source_instance, source_scrape_id, provider, scraped_at, raw_output)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, this.sourceInstance, id, opts.provider, opts.scrapedAt, opts.rawOutput);
    })();
    return id;
  }

  recordParsed(
    id: string,
    _rawParsed: ProviderQuotaSnapshot,
    inferredParsed: ProviderQuotaSnapshot
  ): void {
    const { raw: _raw, ...inferredState } = inferredParsed;
    const scrape = this.db
      .prepare("SELECT provider, scraped_at FROM quota_scrapes WHERE id = ?")
      .get(id) as { provider: string; scraped_at: string } | undefined;
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE quota_scrapes SET parsed_state = ?, parse_error = NULL WHERE id = ?")
        .run(JSON.stringify(inferredState), id);
      this.insertObservations(
        id,
        this.sourceInstance,
        inferredParsed,
        scrape?.scraped_at,
        scrape?.provider
      );
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
        `SELECT id, provider, scraped_at, raw_output, parsed_state, parse_error
         FROM quota_scrapes WHERE provider = ? AND scraped_at >= ?
         ORDER BY scraped_at ASC, rowid ASC`
      )
      .all(provider, sinceIso) as Array<Omit<LegacyScrapeRow, "inferred_parsed_state">>;
    return rows.map((row) => {
      const state = parsedSnapshot(row.parsed_state);
      return {
        id: row.id,
        provider: row.provider,
        scrapedAt: row.scraped_at,
        rawOutput: row.raw_output,
        parsedState: state,
        inferredParsedState: state,
        parseError: row.parse_error,
      };
    });
  }

  listCanonicalSince(provider: string, sinceIso: string): CanonicalQuotaObservation[] {
    return this.db
      .prepare(
        `SELECT scrape_id AS scrapeId, provider, kind, label,
                observed_at AS observedAt, percent_left AS percentLeft,
                reset_at_iso AS resetAtIso, window_ms AS windowMs,
                source_instance AS sourceInstance
         FROM quota_observations
         WHERE provider = ? AND observed_at >= ?
         ORDER BY observed_at ASC, rowid ASC`
      )
      .all(provider, sinceIso) as CanonicalQuotaObservation[];
  }

  listHistorySince(provider: string, sinceIso: string): QuotaHistoryRecord[] {
    return this.db
      .prepare(
        `SELECT 'provider' AS scope, kind, label, observed_at AS observedAt,
                percent_left AS percentLeft, reset_at_iso AS resetAtIso,
                controller_error AS controllerError, interval_seconds AS intervalSeconds
         FROM quota_observations
         WHERE provider = ? AND observed_at >= ?
         ORDER BY observed_at ASC, rowid ASC`
      )
      .all(provider, sinceIso) as QuotaHistoryRecord[];
  }

  /** Advance every unprocessed observation exactly once across all connections. */
  advancePendingController(opts: QuotaControllerOptions, provider?: string): void {
    const run = this.db.transaction(() => {
      const observations = this.db
        .prepare(
          `SELECT scrape_id AS scrapeId, provider, kind, label,
                  observed_at AS observedAt, observed_slot AS slot,
                  percent_left AS percentLeft, reset_at_iso AS resetAtIso,
                  window_ms AS windowMs, source_instance AS sourceInstance, processed
           FROM quota_observations
           WHERE processed = 0 AND (? IS NULL OR provider = ?)
           ORDER BY observed_at ASC, rowid ASC`
        )
        .all(provider ?? null, provider ?? null) as StoredObservation[];
      for (const observation of observations) this.advanceObservation(observation, opts);
    });
    run.immediate();
  }

  private advanceObservation(observation: StoredObservation, opts: QuotaControllerOptions): void {
    const observedMs = Date.parse(observation.observedAt);
    const resetMs = observation.resetAtIso ? Date.parse(observation.resetAtIso) : Number.NaN;
    if (
      !observation.resetAtIso ||
      !Number.isFinite(observedMs) ||
      !Number.isFinite(resetMs) ||
      resetMs <= observedMs ||
      observation.percentLeft <= 0
    ) {
      this.markProcessed(observation);
      return;
    }

    const previous = this.db
      .prepare(
        `SELECT interval_seconds, last_error, filtered_derivative,
                last_observed_at, reset_at_iso
         FROM quota_bucket_state WHERE provider = ? AND kind = ?`
      )
      .get(observation.provider, observation.kind) as
      | {
          interval_seconds: number;
          last_error: number;
          filtered_derivative: number;
          last_observed_at: string;
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
    const previousObservedMs = previous ? Date.parse(previous.last_observed_at) : Number.NaN;
    const dtSeconds = Number.isFinite(previousObservedMs)
      ? Math.max(1, (observedMs - previousObservedMs) / 1000)
      : 0;
    const rawDerivative =
      !cycleChanged && dtSeconds > 0 && previous ? (error - previous.last_error) / dtSeconds : 0;
    const derivativeAlpha =
      dtSeconds > 0 ? dtSeconds / (QUOTA_DERIVATIVE_TAU_SECONDS + dtSeconds) : 1;
    const previousDerivative = cycleChanged ? 0 : (previous?.filtered_derivative ?? 0);
    const derivative = previousDerivative + derivativeAlpha * (rawDerivative - previousDerivative);
    const uncappedCandidate = Math.max(
      0,
      QUOTA_KP_SECONDS_PER_POINT * error + QUOTA_KD_SECONDS_SQUARED_PER_POINT * derivative
    );
    // A rollover resets the derivative, not the actuator. This resumes from
    // the last reasoned period rather than treating the exhaustion wait as one.
    const previousInterval = previous?.interval_seconds ?? 0;
    const smoothed =
      previousInterval + QUOTA_ACTUATOR_SMOOTHING * (uncappedCandidate - previousInterval);
    const uncappedInterval = Math.max(
      0,
      Math.min(
        previousInterval + QUOTA_MAX_SLEW_SECONDS,
        Math.max(previousInterval - QUOTA_MAX_SLEW_SECONDS, smoothed)
      )
    );
    const interval = Math.min(opts.maxIntervalSeconds, uncappedInterval);

    this.db
      .prepare(
        `INSERT INTO quota_bucket_state
          (provider, kind, label, reset_at_iso, interval_seconds,
           uncapped_interval_seconds, last_error, filtered_derivative,
           last_percent_left, last_observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, kind) DO UPDATE SET
           label = excluded.label,
           reset_at_iso = excluded.reset_at_iso,
           interval_seconds = excluded.interval_seconds,
           uncapped_interval_seconds = excluded.uncapped_interval_seconds,
           last_error = excluded.last_error,
           filtered_derivative = excluded.filtered_derivative,
           last_percent_left = excluded.last_percent_left,
           last_observed_at = excluded.last_observed_at`
      )
      .run(
        observation.provider,
        observation.kind,
        observation.label,
        observation.resetAtIso,
        interval,
        uncappedInterval,
        error,
        derivative,
        observation.percentLeft,
        observation.observedAt
      );
    this.db
      .prepare(
        `UPDATE quota_observations
         SET processed = 1, controller_error = ?, interval_seconds = ?
         WHERE provider = ? AND kind = ? AND observed_slot = ?`
      )
      .run(error, interval, observation.provider, observation.kind, observation.slot);
  }

  private markProcessed(observation: Pick<StoredObservation, "provider" | "kind" | "slot">): void {
    this.db
      .prepare(
        `UPDATE quota_observations SET processed = 1
         WHERE provider = ? AND kind = ? AND observed_slot = ?`
      )
      .run(observation.provider, observation.kind, observation.slot);
  }

  /** Resolve the temporary exhaustion gate without persisting it as a period. */
  getExhaustedUntil(provider: string, nowMs = Date.now()): string | null {
    const rows = this.db
      .prepare(
        `SELECT o.percent_left, o.reset_at_iso
         FROM quota_observations o
         WHERE o.provider = ?
           AND NOT EXISTS (
             SELECT 1 FROM quota_observations newer
             WHERE newer.provider = o.provider AND newer.kind = o.kind
               AND (newer.observed_at > o.observed_at OR
                    (newer.observed_at = o.observed_at AND newer.rowid > o.rowid))
           )`
      )
      .all(provider) as Array<{ percent_left: number; reset_at_iso: string | null }>;
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
    const rows = this.db
      .prepare(
        `SELECT kind, label, reset_at_iso, interval_seconds,
                uncapped_interval_seconds, last_error, filtered_derivative,
                last_percent_left, last_observed_at
         FROM quota_bucket_state WHERE provider = ?`
      )
      .all(provider) as Array<{
      kind: string;
      label: string;
      reset_at_iso: string | null;
      interval_seconds: number;
      uncapped_interval_seconds: number;
      last_error: number;
      filtered_derivative: number;
      last_percent_left: number;
      last_observed_at: string;
    }>;
    if (rows.length === 0) return null;
    rows.sort((a, b) => b.uncapped_interval_seconds - a.uncapped_interval_seconds);
    const governing = rows[0];
    if (!governing) return null;
    const updatedAt =
      rows
        .map((row) => row.last_observed_at)
        .sort()
        .at(-1) ?? governing.last_observed_at;
    const now = Date.parse(updatedAt);
    const exhaustedUntil = this.getExhaustedUntil(provider);
    return {
      provider,
      intervalSeconds: governing.interval_seconds,
      uncappedIntervalSeconds: governing.uncapped_interval_seconds,
      governingBucketKey: `${provider}:${governing.kind}`,
      capped: governing.uncapped_interval_seconds > governing.interval_seconds,
      held: false,
      expired: exhaustedUntil !== null,
      exhaustedUntil,
      updatedAt,
      buckets: rows.map((row) => ({
        key: `${provider}:${row.kind}`,
        percentLeft: row.last_percent_left,
        timeRemainingPct:
          row.reset_at_iso && Number.isFinite(now)
            ? Math.min(
                100,
                Math.max(0, ((Date.parse(row.reset_at_iso) - now) / quotaWindowMs(row.kind)) * 100)
              )
            : 0,
        error: row.last_error,
        derivative: row.filtered_derivative,
        requiredIntervalSeconds: row.interval_seconds,
        resetAtIso: row.reset_at_iso,
        observedAt: row.last_observed_at,
      })),
    };
  }

  /** Atomically claim a normal start across every connection to this database. */
  claimNormalProviderStart(provider: string, startedAtMs = Date.now()): number | null {
    if (!Number.isFinite(startedAtMs) || startedAtMs < 0) {
      throw new Error(`startedAtMs must be a non-negative finite number, got ${startedAtMs}`);
    }
    const claim = this.db.transaction(() => {
      const intervalSeconds = this.getProviderThrottle(provider)?.intervalSeconds ?? 0;
      const previous = this.latestNormalStartMillis(provider);
      const exhaustedUntil = this.getExhaustedUntil(provider, startedAtMs);
      const exhaustedUntilMs = exhaustedUntil ? Date.parse(exhaustedUntil) : 0;
      const nextFromPacing = previous == null ? 0 : previous + Math.max(0, intervalSeconds) * 1000;
      const availableAt = Math.max(nextFromPacing, exhaustedUntilMs);
      if (startedAtMs < availableAt) return availableAt;
      this.db
        .prepare(
          `INSERT INTO quota_provider_pacing (provider, last_normal_start_at)
           VALUES (?, ?)
           ON CONFLICT(provider) DO UPDATE SET
             last_normal_start_at = excluded.last_normal_start_at`
        )
        .run(provider, new Date(startedAtMs).toISOString());
      return null;
    });
    return claim.immediate();
  }

  latestNormalStartMillis(provider: string): number | null {
    const row = this.db
      .prepare("SELECT last_normal_start_at FROM quota_provider_pacing WHERE provider = ?")
      .get(provider) as { last_normal_start_at: string } | undefined;
    if (!row) return null;
    const parsed = Date.parse(row.last_normal_start_at);
    return Number.isFinite(parsed) ? parsed : null;
  }

  importLegacyDatabase(sourcePath: string, sourceInstance: string): QuotaImportReport {
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      const columns = new Set(
        (source.prepare("PRAGMA table_info(quota_scrapes)").all() as Array<{ name: string }>).map(
          (column) => column.name
        )
      );
      const hasInferred = columns.has("inferred_parsed_state");
      const total = (
        source.prepare("SELECT count(*) AS n FROM quota_scrapes").get() as { n: number }
      ).n;
      const cutoff = new Date(Date.now() - QUOTA_RAW_RETENTION_MS).toISOString();
      const rows = source
        .prepare(
          `SELECT id, provider, scraped_at, raw_output, parsed_state,
                  ${hasInferred ? "inferred_parsed_state" : "NULL"} AS inferred_parsed_state,
                  parse_error
           FROM quota_scrapes WHERE scraped_at >= ?
           ORDER BY scraped_at ASC, rowid ASC`
        )
        .all(cutoff) as LegacyScrapeRow[];
      let insertedRows = 0;
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO quota_scrapes
          (id, source_instance, source_scrape_id, provider, scraped_at,
           raw_output, parsed_state, parse_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      this.db.transaction(() => {
        for (const row of rows) {
          const id = deterministicImportId(sourceInstance, row.id);
          const stateJson = row.inferred_parsed_state ?? row.parsed_state;
          const result = insert.run(
            id,
            sourceInstance,
            row.id,
            row.provider,
            row.scraped_at,
            row.raw_output,
            stateJson,
            row.parse_error
          );
          insertedRows += result.changes;
          const state = parsedSnapshot(stateJson);
          if (state) {
            this.insertObservations(id, sourceInstance, state, row.scraped_at, row.provider);
          }
        }
      })();
      const canonicalObservations = (
        this.db.prepare("SELECT count(*) AS n FROM quota_observations").get() as { n: number }
      ).n;
      return {
        sourceInstance,
        sourceRows: total,
        insertedRows,
        duplicateRows: rows.length - insertedRows,
        expiredRows: total - rows.length,
        canonicalObservations,
      };
    } finally {
      source.close();
    }
  }

  private insertObservations(
    scrapeId: string,
    sourceInstance: string,
    state: ProviderQuotaSnapshot,
    storedObservedAt?: string,
    storedProvider?: string
  ): void {
    const observedAt = state.scrapedAt ?? storedObservedAt;
    const observedMs = observedAt ? Date.parse(observedAt) : Number.NaN;
    if (!observedAt || !Number.isFinite(observedMs)) return;
    const provider = (storedProvider ?? state.provider).trim().toLocaleLowerCase("en-US");
    const seenKinds = new Set<string>();
    for (const limit of state.limits ?? []) {
      if (limit.scope === "model" || !Number.isFinite(limit.percentLeft)) continue;
      if (limit.percentLeft < 0 || limit.percentLeft > 100) continue;
      const kind = normalizeKind(limit.kind);
      if (seenKinds.has(kind)) continue;
      seenKinds.add(kind);
      const candidate: StoredObservation = {
        scrapeId,
        provider,
        kind,
        label: limit.label,
        observedAt,
        slot: Math.floor(observedMs / SLOT_MS),
        percentLeft: limit.percentLeft,
        resetAtIso: limit.resetAtIso ?? null,
        windowMs: quotaWindowMs(kind),
        sourceInstance,
        processed: 0,
      };
      const existing = this.db
        .prepare(
          `SELECT scrape_id AS scrapeId, provider, kind, label,
                  observed_at AS observedAt, observed_slot AS slot,
                  percent_left AS percentLeft, reset_at_iso AS resetAtIso,
                  window_ms AS windowMs, source_instance AS sourceInstance, processed
           FROM quota_observations
           WHERE provider = ? AND kind = ? AND observed_slot = ?`
        )
        .get(provider, kind, candidate.slot) as StoredObservation | undefined;
      if (existing?.processed === 1) continue;
      const candidateWins =
        !existing ||
        (hasValidReset(candidate) && !hasValidReset(existing)) ||
        (hasValidReset(candidate) === hasValidReset(existing) &&
          Date.parse(candidate.observedAt) > Date.parse(existing.observedAt));
      if (!candidateWins) continue;
      this.db
        .prepare(
          `INSERT INTO quota_observations
            (provider, kind, observed_slot, scrape_id, label, observed_at,
             percent_left, reset_at_iso, window_ms, source_instance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, kind, observed_slot) DO UPDATE SET
             scrape_id = excluded.scrape_id,
             label = excluded.label,
             observed_at = excluded.observed_at,
             percent_left = excluded.percent_left,
             reset_at_iso = excluded.reset_at_iso,
             window_ms = excluded.window_ms,
             source_instance = excluded.source_instance`
        )
        .run(
          provider,
          kind,
          candidate.slot,
          scrapeId,
          candidate.label,
          candidate.observedAt,
          candidate.percentLeft,
          candidate.resetAtIso,
          candidate.windowMs,
          sourceInstance
        );
    }
  }
}
