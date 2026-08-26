import { randomUUID } from "node:crypto";
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

function parsedSnapshot(value: string | null): ProviderQuotaSnapshot | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ProviderQuotaSnapshot;
  } catch {
    return null;
  }
}

export interface CanonicalQuotaObservation {
  provider: string;
  kind: string;
  label: string;
  observedAt: string;
  percentLeft: number;
  resetAtIso: string | null;
  windowMs: number;
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

interface ReasonedObservation {
  provider: string;
  kind: string;
  label: string;
  resetAtIso: string | null;
  intervalSeconds: number;
  uncappedIntervalSeconds: number;
  controllerError: number;
  controllerDerivative: number;
  percentLeft: number;
  observedAt: string;
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

  constructor(readonly databasePath: string) {
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
        provider TEXT NOT NULL,
        scraped_at TEXT NOT NULL,
        raw_output TEXT NOT NULL,
        parsed_state TEXT,
        parse_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_shared_quota_scrapes_provider_time
        ON quota_scrapes(provider, scraped_at);

      CREATE TABLE IF NOT EXISTS quota_observations (
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
      CREATE INDEX IF NOT EXISTS idx_quota_observations_provider_time
        ON quota_observations(provider, observed_at);
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
            (id, provider, scraped_at, raw_output)
           VALUES (?, ?, ?, ?)`
        )
        .run(id, opts.provider, opts.scrapedAt, opts.rawOutput);
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
      this.insertObservations(inferredParsed, scrape?.scraped_at, scrape?.provider);
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
        `SELECT provider, kind, label,
                observed_at AS observedAt, percent_left AS percentLeft,
                reset_at_iso AS resetAtIso, window_ms AS windowMs
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
          `SELECT provider, kind, label,
                  observed_at AS observedAt, observed_slot AS slot,
                  percent_left AS percentLeft, reset_at_iso AS resetAtIso,
                  window_ms AS windowMs, processed
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
        `SELECT interval_seconds AS intervalSeconds,
                controller_error AS controllerError,
                controller_derivative AS controllerDerivative,
                observed_at AS observedAt, reset_at_iso AS resetAtIso
         FROM quota_observations
         WHERE provider = ? AND kind = ? AND interval_seconds IS NOT NULL
         ORDER BY observed_at DESC, rowid DESC LIMIT 1`
      )
      .get(observation.provider, observation.kind) as
      | {
          intervalSeconds: number;
          controllerError: number;
          controllerDerivative: number;
          observedAt: string;
          resetAtIso: string | null;
        }
      | undefined;
    const timeRemainingPct = Math.min(
      100,
      Math.max(0, ((resetMs - observedMs) / observation.windowMs) * 100)
    );
    const error = timeRemainingPct - observation.percentLeft;
    const cycleChanged =
      previous?.resetAtIso != null &&
      Math.abs(Date.parse(previous.resetAtIso) - resetMs) >
        Math.min(60 * 60 * 1000, observation.windowMs * 0.05);
    const previousObservedMs = previous ? Date.parse(previous.observedAt) : Number.NaN;
    const dtSeconds = Number.isFinite(previousObservedMs)
      ? Math.max(1, (observedMs - previousObservedMs) / 1000)
      : 0;
    const rawDerivative =
      !cycleChanged && dtSeconds > 0 && previous
        ? (error - previous.controllerError) / dtSeconds
        : 0;
    const derivativeAlpha =
      dtSeconds > 0 ? dtSeconds / (QUOTA_DERIVATIVE_TAU_SECONDS + dtSeconds) : 1;
    const previousDerivative = cycleChanged ? 0 : (previous?.controllerDerivative ?? 0);
    const derivative = previousDerivative + derivativeAlpha * (rawDerivative - previousDerivative);
    const uncappedCandidate = Math.max(
      0,
      QUOTA_KP_SECONDS_PER_POINT * error + QUOTA_KD_SECONDS_SQUARED_PER_POINT * derivative
    );
    // A rollover resets the derivative, not the actuator. This resumes from
    // the last reasoned period rather than treating the exhaustion wait as one.
    const previousInterval = previous?.intervalSeconds ?? 0;
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
        `UPDATE quota_observations
         SET processed = 1, controller_error = ?, controller_derivative = ?,
             uncapped_interval_seconds = ?, interval_seconds = ?
         WHERE provider = ? AND kind = ? AND observed_slot = ?`
      )
      .run(
        error,
        derivative,
        uncappedInterval,
        interval,
        observation.provider,
        observation.kind,
        observation.slot
      );
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
    const reasoned = this.db
      .prepare(
        `SELECT provider, kind, label, reset_at_iso AS resetAtIso,
                interval_seconds AS intervalSeconds,
                uncapped_interval_seconds AS uncappedIntervalSeconds,
                controller_error AS controllerError,
                controller_derivative AS controllerDerivative,
                percent_left AS percentLeft, observed_at AS observedAt
         FROM quota_observations o
         WHERE provider = ? AND interval_seconds IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM quota_observations newer
             WHERE newer.provider = o.provider AND newer.kind = o.kind
               AND newer.interval_seconds IS NOT NULL
               AND (newer.observed_at > o.observed_at OR
                    (newer.observed_at = o.observed_at AND newer.rowid > o.rowid))
           )`
      )
      .all(provider) as ReasonedObservation[];
    const current = this.db
      .prepare(
        `SELECT kind, label, reset_at_iso AS resetAtIso,
                percent_left AS percentLeft, observed_at AS observedAt
         FROM quota_observations o
         WHERE provider = ?
           AND NOT EXISTS (
             SELECT 1 FROM quota_observations newer
             WHERE newer.provider = o.provider AND newer.kind = o.kind
               AND (newer.observed_at > o.observed_at OR
                    (newer.observed_at = o.observed_at AND newer.rowid > o.rowid))
           )`
      )
      .all(provider) as Array<{
      kind: string;
      label: string;
      resetAtIso: string | null;
      percentLeft: number;
      observedAt: string;
    }>;
    if (current.length === 0) return null;
    reasoned.sort((a, b) => b.uncappedIntervalSeconds - a.uncappedIntervalSeconds);
    const governing = reasoned[0];
    const currentByKind = new Map(current.map((row) => [row.kind, row]));
    const updatedAt =
      current
        .map((row) => row.observedAt)
        .sort()
        .at(-1) ?? new Date(0).toISOString();
    const exhaustedUntil = this.getExhaustedUntil(provider);
    return {
      provider,
      intervalSeconds: governing?.intervalSeconds ?? 0,
      uncappedIntervalSeconds: governing?.uncappedIntervalSeconds ?? 0,
      governingBucketKey: governing ? `${provider}:${governing.kind}` : null,
      capped:
        governing !== undefined && governing.uncappedIntervalSeconds > governing.intervalSeconds,
      expired: exhaustedUntil !== null,
      exhaustedUntil,
      updatedAt,
      buckets: reasoned.map((row) => {
        const latest = currentByKind.get(row.kind) ?? row;
        const observedMs = Date.parse(latest.observedAt);
        return {
          key: `${provider}:${row.kind}`,
          percentLeft: latest.percentLeft,
          timeRemainingPct:
            latest.resetAtIso && Number.isFinite(observedMs)
              ? Math.min(
                  100,
                  Math.max(
                    0,
                    ((Date.parse(latest.resetAtIso) - observedMs) / quotaWindowMs(row.kind)) * 100
                  )
                )
              : 0,
          error: row.controllerError,
          derivative: row.controllerDerivative,
          requiredIntervalSeconds: row.intervalSeconds,
          resetAtIso: latest.resetAtIso,
          observedAt: latest.observedAt,
        };
      }),
    };
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
          (id, provider, scraped_at, raw_output, parsed_state, parse_error)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      this.db.transaction(() => {
        for (const row of rows) {
          const stateJson = row.inferred_parsed_state ?? row.parsed_state;
          const result = insert.run(
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
            this.insertObservations(state, row.scraped_at, row.provider);
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
        provider,
        kind,
        label: limit.label,
        observedAt,
        slot: Math.floor(observedMs / SLOT_MS),
        percentLeft: limit.percentLeft,
        resetAtIso: limit.resetAtIso ?? null,
        windowMs: quotaWindowMs(kind),
        processed: 0,
      };
      const existing = this.db
        .prepare(
          `SELECT provider, kind, label,
                  observed_at AS observedAt, observed_slot AS slot,
                  percent_left AS percentLeft, reset_at_iso AS resetAtIso,
                  window_ms AS windowMs, processed
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
            (provider, kind, observed_slot, label, observed_at,
             percent_left, reset_at_iso, window_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, kind, observed_slot) DO UPDATE SET
             label = excluded.label,
             observed_at = excluded.observed_at,
             percent_left = excluded.percent_left,
             reset_at_iso = excluded.reset_at_iso,
             window_ms = excluded.window_ms`
        )
        .run(
          provider,
          kind,
          candidate.slot,
          candidate.label,
          candidate.observedAt,
          candidate.percentLeft,
          candidate.resetAtIso,
          candidate.windowMs
        );
    }
  }
}
