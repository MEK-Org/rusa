import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { QuotaScrape } from "../db/repositories/quota-scrape-repository.js";
import { BUSY_TIMEOUT_MS, widenToWal } from "../db/wal.js";
import type { ProviderQuotaSnapshot, QuotaWindowKind } from "../mcp/quota-mcp.js";
import {
  nullQuotaMetrics,
  QUOTA_SERVICE_METRICS,
  type QuotaMetrics,
  type QuotaObservationResult,
} from "./coordinator-metrics.js";
import { parseParsedState, serializeParsedState } from "./parsed-state.js";
import {
  assertQuotaSchemaVersion,
  QUOTA_SCHEMA_VERSION,
  SchemaVersionRefusalError,
} from "./schema-guard.js";
import { isProviderScopedWindow } from "./window-scope.js";

export { assertQuotaSchemaVersion, QUOTA_SCHEMA_VERSION, SchemaVersionRefusalError };
// Maintenance scripts consume this bundled shared-store artifact, so expose
// the one persistence decoder/writer rather than duplicating JSON handling.
export { parseParsedState, serializeParsedState } from "./parsed-state.js";

const SLOT_MS = 5 * 60 * 1000;
export const QUOTA_RAW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Observation retention window (30 days).
 *
 * Chosen deliberately:
 * 1. Overview tab history chart queries only 3 days (`HISTORY_WINDOW_MS`), and cold-start fallback
 *    queries only 24h. 30 days provides a generous 10x safety buffer that covers full monthly provider
 *    billing/quota reset cycles while strictly bounding table growth to ~50k-100k rows across all
 *    providers and slot intervals.
 * 2. Matches `QUOTA_RAW_RETENTION_MS` so raw telemetry and reasoned observation lifecycles stay in lockstep.
 */
export const QUOTA_OBSERVATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// The product requirement is a PID controller. These are deliberately fixed
// implementation constants rather than configuration that no caller uses.
export const QUOTA_KP_SECONDS_PER_POINT = 120;
export const QUOTA_KD_SECONDS_SQUARED_PER_POINT = 1800;
/**
 * Integral time: how long a standing error must persist before the integral
 * term contributes as much period as the proportional term already does. One
 * hour is deliberately conservative for routine observation loops (from
 * 5-minute ticks to 30-minute probe cadences) and is twice the existing
 * derivative filter's time constant.
 */
export const QUOTA_INTEGRAL_TIME_SECONDS = 3600;
export const QUOTA_KI_SECONDS_PER_POINT_SECOND =
  QUOTA_KP_SECONDS_PER_POINT / QUOTA_INTEGRAL_TIME_SECONDS;
/**
 * Largest elapsed interval the controller credits from one observation. This
 * is one normal 30-minute probe slot: it bounds stale input while letting one
 * on-cadence observation receive the same smoothing, slew, and integral credit
 * as its six five-minute reference steps.
 */
export const QUOTA_MAX_CREDITED_ELAPSED_SECONDS = 30 * 60; // 1800s (30 minutes)
export const QUOTA_DERIVATIVE_TAU_SECONDS = 1800;
/** The observation interval the original actuator constants were tuned for. */
export const QUOTA_ACTUATOR_REFERENCE_STEP_SECONDS = SLOT_MS / 1000;
export const QUOTA_ACTUATOR_SMOOTHING = 0.25;
/** Maximum slew over one five-minute reference observation. */
export const QUOTA_MAX_SLEW_SECONDS = 900;

function elapsedActuatorResponse(
  dtSeconds: number,
  hasPrevious: boolean
): { smoothing: number; slew: number } {
  const elapsedSeconds =
    hasPrevious && dtSeconds > 0
      ? Math.min(dtSeconds, QUOTA_MAX_CREDITED_ELAPSED_SECONDS)
      : QUOTA_ACTUATOR_REFERENCE_STEP_SECONDS;
  return {
    smoothing:
      1 -
      (1 - QUOTA_ACTUATOR_SMOOTHING) ** (elapsedSeconds / QUOTA_ACTUATOR_REFERENCE_STEP_SECONDS),
    slew: QUOTA_MAX_SLEW_SECONDS * (elapsedSeconds / QUOTA_ACTUATOR_REFERENCE_STEP_SECONDS),
  };
}
/**
 * A rise in remaining quota above this many points is read as a refill rather
 * than a measurement. Inside one window `percentLeft` only falls — consumption
 * is the only thing that moves it — so a genuine rise means the budget was
 * replenished under us.
 *
 * This is a noise floor, not a sensitivity knob. The reading is parsed from a
 * rendered percentage, so display rounding can move it by a point without any
 * underlying change; two points clears that with margin. Sensitivity is not the
 * binding constraint in the other direction, because a real refill moves tens
 * of points at once — a weekly window returns to ~100 from single digits.
 */
export const QUOTA_REFILL_EPSILON_POINTS = 2;

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

export interface CanonicalQuotaObservation {
  provider: string;
  kind: string;
  label: string;
  observedAt: string;
  percentLeft: number;
  resetAtIso: string | null;
  windowMs: number;
}

/** The coordinator's durable collection authority for one provider lane. */
export type QuotaReadingMode = "manual" | "scrape";

export interface QuotaReadingModeState {
  mode: QuotaReadingMode;
  /** Monotonically increases on each actual mode transition. */
  generation: number;
  updatedAt: string | null;
}

export interface ManualQuotaObservation {
  /** The snapshot shape emitted by the coordinator's normal scraper path. */
  snapshot: ProviderQuotaSnapshot;
  /** The mode generation returned by `set_quota_reading_mode`. */
  generation: number;
  idempotencyKey: string;
  acceptedAt: string;
}

export type ManualObservationResult =
  | { result: "accepted"; observedAt: string; generation: number }
  | { result: "duplicate"; observedAt: string; generation: number }
  | { result: "manual_mode_required" }
  | { result: "generation_mismatch"; generation: number }
  | { result: "stale_observation" }
  | { result: "idempotency_conflict" };

export interface QuotaControllerOptions {
  maxIntervalSeconds: number;
}

export interface QuotaControllerResetResult {
  provider: string;
  /**
   * Reasoned observations whose controller memory was cleared, counted as rows
   * across every window kind on the lane. Matched on `interval_seconds IS NOT
   * NULL`, which is every reasoned row: the reasoning step is the only writer
   * of the controller columns and writes all of them together, and rows
   * reasoned before `controller_integral` existed still carry their period.
   */
  clearedDecisions: number;
  /** Canonical observations still stored for the provider; the reset never removes one. */
  observations: number;
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
  controllerIntegral: number | null;
  percentLeft: number;
  observedAt: string;
}

interface StoredScrapeRow {
  id: string;
  provider: string;
  scraped_at: string;
  raw_output: string;
  parsed_state: string | null;
  parse_error: string | null;
}

interface ScrapePermit {
  provider: string;
  generation: number;
}

/**
 * Provenance marker stored as the `raw_output` of a manual `quota_scrapes` row.
 * There is no scraper text to keep, so the blob carries a version indicator
 * plus the request identity; the snapshot itself is in `parsed_state` like
 * every other row.
 */
interface ManualScrapeRawOutput {
  version: 1;
  source: "manual";
  idempotencyKey: string;
  generation: number;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Stable request identity; no caller-controlled serialization ambiguities. */
export function manualObservationFingerprint(snapshot: ProviderQuotaSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

/**
 * WAL-backed quota storage shared by every instance using the same provider
 * credentials. Raw evidence is retained for 30 days; compact canonical
 * observations and PID controller memory remain durable.
 */
export class SharedQuotaStore {
  readonly db: Database.Database;
  private controllerOptions: QuotaControllerOptions | null = null;
  private controllerUpdated: ((provider: string) => void) | null = null;
  /**
   * Collection is asynchronous, while its persistence boundary is synchronous.
   * The collector runs each probe inside {@link withScrapePermit}, which puts
   * the lane's mode generation in async context; `recordRaw`, `recordParsed`
   * and `recordParseError` read it back from the same context, so a result
   * that lands after a mode transition is discarded at the write boundary
   * without threading a token through the generic scrape-store interface that
   * `quota-mcp.ts` and the model catalog share. Nothing is keyed by scrape id,
   * so an abandoned probe leaves nothing behind.
   */
  private readonly scrapePermitContext = new AsyncLocalStorage<ScrapePermit>();
  /**
   * The parse, observation, and controller series are only observable here:
   * this is where a parse becomes a stored snapshot and where an observation
   * becomes a reasoned interval. Default is the discarding sink, so every
   * existing caller — tests and the instance-side store alike — keeps its
   * current behaviour and only the coordinator process opts in.
   */
  private metrics: QuotaMetrics = nullQuotaMetrics;

  constructor(readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    try {
      assertQuotaSchemaVersion(this.db, QUOTA_SCHEMA_VERSION);
      // The conversion runs its own budget, then hands the connection the
      // ordinary one it keeps for the rest of its life.
      widenToWal(this.db);
      this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      this.db.pragma("foreign_keys = ON");
      this.ensureSchema();
    } catch (err) {
      this.db.close();
      throw err;
    }
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

  /** Attach the coordinator's metric sink; `null` restores the discarding one. */
  setMetrics(metrics: QuotaMetrics | null): void {
    this.metrics = metrics ?? nullQuotaMetrics;
  }

  /**
   * Existing lanes are scrape-controlled until an operator deliberately
   * changes them. The implicit generation zero is important: it fences a
   * first manual transition without needing a backfill row for every provider.
   */
  getQuotaReadingMode(provider: string): QuotaReadingModeState {
    const row = this.db
      .prepare(
        `SELECT mode, generation, updated_at AS updatedAt
         FROM quota_provider_reading_modes WHERE provider = ?`
      )
      .get(provider) as
      | { mode: QuotaReadingMode; generation: number; updatedAt: string }
      | undefined;
    return row ?? { mode: "scrape", generation: 0, updatedAt: null };
  }

  /**
   * Switch collection authority atomically. Repeating the current mode is a
   * no-op; only an actual transition advances the fence generation.
   */
  setQuotaReadingMode(
    provider: string,
    mode: QuotaReadingMode,
    updatedAt = new Date().toISOString()
  ): QuotaReadingModeState {
    const change = this.db.transaction(() => {
      const current = this.getQuotaReadingMode(provider);
      if (current.mode === mode && current.updatedAt !== null) return current;
      const next: QuotaReadingModeState = {
        mode,
        generation: current.mode === mode ? current.generation : current.generation + 1,
        updatedAt,
      };
      this.db
        .prepare(
          `INSERT INTO quota_provider_reading_modes (provider, mode, generation, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET
             mode = excluded.mode,
             generation = excluded.generation,
             updated_at = excluded.updated_at`
        )
        .run(provider, next.mode, next.generation, next.updatedAt);
      return next;
    });
    return change.immediate();
  }

  /**
   * Run one service-owned scrape under the mode/generation observed when it
   * began, or return `undefined` without calling `collect` when the lane is
   * manual. The persistence methods recheck that permit, so a result that
   * crosses a mode transition cannot become a durable snapshot or observation.
   * A probe can only start in scrape mode, so the generation check matters for
   * one sequence: scrape → manual (reading accepted) → scrape again while the
   * probe is still in flight. A bare mode check would admit that result on top
   * of the newer manual reading; the generation captured at start does not.
   */
  async withScrapePermit<T>(provider: string, collect: () => Promise<T>): Promise<T | undefined> {
    const mode = this.getQuotaReadingMode(provider);
    if (mode.mode !== "scrape") return undefined;
    return this.scrapePermitContext.run({ provider, generation: mode.generation }, collect);
  }

  /**
   * True when the calling async context carries a scrape permit for `lane`
   * that no longer matches the lane's current mode generation. A permit fences
   * only its own lane; writes for another provider are not its business.
   */
  private fencedByScrapePermit(lane: string | undefined): boolean {
    const permit = this.scrapePermitContext.getStore();
    if (!permit || (lane !== undefined && permit.provider !== lane)) return false;
    const current = this.getQuotaReadingMode(permit.provider);
    return current.mode !== "scrape" || current.generation !== permit.generation;
  }

  private ensureSchema(): void {
    const migrate = this.db.transaction(() => {
      const rawVersion = this.db.pragma("user_version", { simple: true });
      const currentVersion = typeof rawVersion === "number" ? rawVersion : Number(rawVersion ?? 0);
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
      CREATE INDEX IF NOT EXISTS idx_shared_quota_scrapes_time
        ON quota_scrapes(scraped_at);

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
        controller_integral REAL,
        uncapped_interval_seconds REAL,
        interval_seconds REAL,
        PRIMARY KEY(provider, kind, observed_slot)
      );
      CREATE INDEX IF NOT EXISTS idx_quota_observations_provider_time
        ON quota_observations(provider, observed_at);
      CREATE INDEX IF NOT EXISTS idx_quota_observations_observed_at
        ON quota_observations(observed_at);
      CREATE INDEX IF NOT EXISTS idx_quota_observations_provider_kind_time
        ON quota_observations(provider, kind, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_quota_observations_reasoned
        ON quota_observations(provider, kind, observed_at DESC)
        WHERE interval_seconds IS NOT NULL;
      CREATE TABLE IF NOT EXISTS quota_provider_reading_modes (
        provider TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('manual', 'scrape')),
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_manual_observation_receipts (
        provider TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        generation INTEGER NOT NULL,
        request_fingerprint TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        PRIMARY KEY(provider, idempotency_key)
      );
    `);
      this.ensureColumnsInTransaction();
      if (currentVersion < QUOTA_SCHEMA_VERSION) {
        this.db.pragma(`user_version = ${QUOTA_SCHEMA_VERSION}`);
      }
    });
    migrate.immediate();
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` is a no-op against a database created before a
   * column existed, so widen those tables in place. The shared quota database is
   * opened directly by every instance rather than through the instance migration
   * runner, so its schema has to evolve here.
   */
  private ensureColumnsInTransaction(): void {
    const columns = new Set(
      (
        this.db.prepare("PRAGMA table_info(quota_observations)").all() as Array<{ name: string }>
      ).map((column) => column.name)
    );
    if (!columns.has("controller_integral")) {
      this.db.exec("ALTER TABLE quota_observations ADD COLUMN controller_integral REAL");
    }
  }

  /**
   * Raw evidence and the manual idempotency receipts share one retention
   * window: a receipt exists to make a retry of an accepted write a no-op, and
   * a retry arriving after its `quota_scrapes` row has been pruned is rejected
   * by ordering (`stale_observation`) rather than replayed anyway.
   */
  pruneRawScrapes(nowMs = Date.now()): number {
    if (!Number.isFinite(nowMs)) throw new Error(`nowMs must be finite, got ${nowMs}`);
    const cutoff = new Date(nowMs - QUOTA_RAW_RETENTION_MS).toISOString();
    return (
      this.db.prepare("DELETE FROM quota_scrapes WHERE scraped_at < ?").run(cutoff).changes +
      this.db
        .prepare("DELETE FROM quota_manual_observation_receipts WHERE accepted_at < ?")
        .run(cutoff).changes
    );
  }

  pruneObservations(nowMs = Date.now()): number {
    if (!Number.isFinite(nowMs)) throw new Error(`nowMs must be finite, got ${nowMs}`);
    const cutoff = new Date(nowMs - QUOTA_OBSERVATION_RETENTION_MS).toISOString();
    return this.db
      .prepare(
        `DELETE FROM quota_observations
         WHERE observed_at < ?
           AND rowid NOT IN (
             SELECT o.rowid
             FROM quota_observations o
             WHERE o.interval_seconds IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM quota_observations newer
                 WHERE newer.provider = o.provider AND newer.kind = o.kind
                   AND newer.interval_seconds IS NOT NULL
                   AND (newer.observed_at > o.observed_at OR
                        (newer.observed_at = o.observed_at AND newer.rowid > o.rowid))
               )
           )`
      )
      .run(cutoff).changes;
  }

  recordRaw(opts: { provider: string; scrapedAt: string; rawOutput: string }): string {
    const id = randomUUID();
    // A fenced result is a durable no-op: the id has no row, and the caller's
    // follow-up `recordParsed` / `recordParseError` runs under the same stale
    // permit (generations only grow), so it is discarded there too.
    if (this.fencedByScrapePermit(opts.provider)) return id;
    this.db.transaction(() => {
      this.pruneRawScrapes();
      this.pruneObservations();
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
    if (this.fencedByScrapePermit(scrape?.provider)) {
      // The lane left scrape mode between the raw write and the parse: the
      // raw row is withdrawn so neither `/v1/history` nor the observation
      // stream sees a reading the operator has already superseded.
      if (scrape) this.db.prepare("DELETE FROM quota_scrapes WHERE id = ?").run(id);
      return;
    }
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE quota_scrapes SET parsed_state = ?, parse_error = NULL WHERE id = ?")
        .run(serializeParsedState(inferredState), id);
      this.insertObservations(inferredParsed, scrape?.scraped_at, scrape?.provider);
    })();
    this.metrics.counter(QUOTA_SERVICE_METRICS.parsesTotal, {
      provider: scrape?.provider ?? inferredParsed.provider,
      outcome: "success",
    });
    if (this.controllerOptions) {
      this.advancePendingController(this.controllerOptions, inferredParsed.provider);
      this.controllerUpdated?.(inferredParsed.provider);
    }
  }

  recordParseError(id: string, error: unknown): void {
    const scrape = this.db.prepare("SELECT provider FROM quota_scrapes WHERE id = ?").get(id) as
      | { provider: string }
      | undefined;
    if (this.fencedByScrapePermit(scrape?.provider)) {
      if (scrape) this.db.prepare("DELETE FROM quota_scrapes WHERE id = ?").run(id);
      return;
    }
    this.db
      .prepare("UPDATE quota_scrapes SET parse_error = ? WHERE id = ?")
      .run(error instanceof Error ? (error.stack ?? error.message) : String(error), id);
    this.metrics.counter(QUOTA_SERVICE_METRICS.parsesTotal, {
      provider: scrape?.provider ?? "unknown",
      outcome: "failure",
    });
  }

  /**
   * Canonical manual ingestion. The service validates the public request
   * shape first; this transaction owns the race-sensitive parts, in this
   * order: current authority (mode, then generation), durable idempotency
   * (replay or conflict), ordering, and the write itself. Authority comes
   * before replay on purpose: a retry of an accepted key after the lane left
   * manual mode, or under a superseded generation, is answered with the same
   * rejection a first attempt would get, so `duplicate: true` never vouches
   * for an authority the caller no longer holds.
   *
   * The accepted reading is stored the way a scrape is: one `quota_scrapes`
   * row (provenance in `raw_output`, snapshot in `parsed_state`) plus the
   * canonical observation rows. That keeps
   * `/v1/quota`, `/v1/history`, boot hydration and 30-day pruning on their one
   * existing source; the receipt table holds only the idempotency fingerprint.
   */
  recordManualObservation(
    input: ManualQuotaObservation,
    controller?: QuotaControllerOptions
  ): ManualObservationResult {
    const provider = input.snapshot.provider.trim().toLocaleLowerCase("en-US");
    const observedAt = input.snapshot.scrapedAt;
    if (!observedAt) throw new Error("manual observation must have scrapedAt");
    const observedMs = Date.parse(observedAt);
    if (!Number.isFinite(observedMs)) throw new Error("manual observation scrapedAt is invalid");
    const acceptedMs = Date.parse(input.acceptedAt);
    if (!Number.isFinite(acceptedMs)) throw new Error("manual observation acceptedAt is invalid");
    for (const limit of input.snapshot.limits ?? []) {
      if (!Number.isFinite(limit.percentLeft) || limit.percentLeft < 0 || limit.percentLeft > 100) {
        throw new Error("manual observation percentLeft must be between 0 and 100");
      }
    }
    const fingerprint = manualObservationFingerprint(input.snapshot);
    const candidates = this.manualObservationSlots(input.snapshot, observedMs);
    if (candidates.length === 0)
      throw new Error("manual observation has no provider-scoped limits");

    const record = this.db.transaction((): ManualObservationResult => {
      const mode = this.getQuotaReadingMode(provider);
      if (mode.mode !== "manual") return { result: "manual_mode_required" };
      if (input.generation !== mode.generation) {
        return { result: "generation_mismatch", generation: mode.generation };
      }

      const existing = this.db
        .prepare(
          `SELECT generation, request_fingerprint AS requestFingerprint, observed_at AS observedAt
           FROM quota_manual_observation_receipts
           WHERE provider = ? AND idempotency_key = ?`
        )
        .get(provider, input.idempotencyKey) as
        | { generation: number; requestFingerprint: string; observedAt: string }
        | undefined;
      if (existing) {
        if (existing.requestFingerprint === fingerprint) {
          return {
            result: "duplicate",
            observedAt: existing.observedAt,
            generation: existing.generation,
          };
        }
        return { result: "idempotency_conflict" };
      }

      const latest = this.db
        .prepare(
          `SELECT observed_at AS observedAt FROM quota_observations
           WHERE provider = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1`
        )
        .get(provider) as { observedAt: string } | undefined;
      if (latest && observedMs <= Date.parse(latest.observedAt)) {
        return { result: "stale_observation" };
      }

      for (const candidate of candidates) {
        const occupied = this.db
          .prepare(
            `SELECT 1 FROM quota_observations
             WHERE provider = ? AND kind = ? AND observed_slot = ?`
          )
          .get(provider, candidate.kind, candidate.slot);
        if (occupied) return { result: "stale_observation" };
      }

      this.pruneRawScrapes(acceptedMs);
      this.pruneObservations(acceptedMs);
      const { raw: _raw, ...state } = input.snapshot;
      const rawOutput: ManualScrapeRawOutput = {
        version: 1,
        source: "manual",
        idempotencyKey: input.idempotencyKey,
        generation: input.generation,
      };
      this.insertObservations(state, observedAt, provider);
      this.db
        .prepare(
          `INSERT INTO quota_scrapes (id, provider, scraped_at, raw_output, parsed_state)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          provider,
          observedAt,
          canonicalJson(rawOutput),
          serializeParsedState({ ...state, provider })
        );
      this.db
        .prepare(
          `INSERT INTO quota_manual_observation_receipts
            (provider, idempotency_key, generation, request_fingerprint, observed_at, accepted_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          provider,
          input.idempotencyKey,
          input.generation,
          fingerprint,
          observedAt,
          input.acceptedAt
        );
      return { result: "accepted", observedAt, generation: input.generation };
    });

    const result = record.immediate();
    // A manual POST is an authoritative observation, not an instruction for a
    // later collector tick: the caller that owns pacing passes its controller
    // options so the accepted rows are reasoned before the response is sent.
    // The scrape path's end-of-tick cadence is untouched.
    const advance = controller ?? this.controllerOptions;
    if (result.result === "accepted" && advance) {
      this.advancePendingController(advance, provider);
      this.controllerUpdated?.(provider);
    }
    return result;
  }

  private manualObservationSlots(
    snapshot: ProviderQuotaSnapshot,
    observedMs: number
  ): Array<{ kind: QuotaWindowKind; slot: number }> {
    const seen = new Set<string>();
    const candidates: Array<{ kind: QuotaWindowKind; slot: number }> = [];
    for (const limit of snapshot.limits ?? []) {
      if (!isProviderScopedWindow(limit)) continue;
      const kind = normalizeKind(limit.kind);
      if (seen.has(kind)) continue;
      seen.add(kind);
      candidates.push({ kind, slot: Math.floor(observedMs / SLOT_MS) });
    }
    return candidates;
  }

  listSince(provider: string, sinceIso: string): QuotaScrape[] {
    const rows = this.db
      .prepare(
        `SELECT id, provider, scraped_at, raw_output, parsed_state, parse_error
         FROM quota_scrapes WHERE provider = ? AND scraped_at >= ?
         ORDER BY scraped_at ASC, rowid ASC`
      )
      .all(provider, sinceIso) as StoredScrapeRow[];
    return rows.map((row) => {
      const state = parseParsedState(row.parsed_state);
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

  getLatestSnapshot(provider: string): ProviderQuotaSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT parsed_state
         FROM quota_scrapes
         WHERE provider = ? AND parsed_state IS NOT NULL
         ORDER BY scraped_at DESC, rowid DESC
         LIMIT 1`
      )
      .get(provider) as { parsed_state: string } | undefined;
    if (!row) return null;
    return parseParsedState(row.parsed_state);
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
      this.metrics.counter(QUOTA_SERVICE_METRICS.controllerStepsTotal, {
        provider: observation.provider,
      });
      return;
    }

    const previous = this.db
      .prepare(
        `SELECT interval_seconds AS intervalSeconds,
                controller_error AS controllerError,
                controller_derivative AS controllerDerivative,
                controller_integral AS controllerIntegral,
                observed_at AS observedAt, reset_at_iso AS resetAtIso,
                percent_left AS percentLeft
         FROM quota_observations
         WHERE provider = ? AND kind = ? AND interval_seconds IS NOT NULL
         ORDER BY observed_at DESC, rowid DESC LIMIT 1`
      )
      .get(observation.provider, observation.kind) as
      | {
          intervalSeconds: number;
          controllerError: number;
          controllerDerivative: number;
          controllerIntegral: number | null;
          observedAt: string;
          resetAtIso: string | null;
          percentLeft: number;
        }
      | undefined;
    const timeRemainingPct = Math.min(
      100,
      Math.max(0, ((resetMs - observedMs) / observation.windowMs) * 100)
    );
    const error = timeRemainingPct - observation.percentLeft;
    // A cycle boundary is anything that makes the previous error incomparable
    // to this one, and there are two independent signals for it. Either is
    // sufficient:
    //
    //  1. the reset instant moved — we are budgeting against a different window;
    //  2. remaining quota rose — the budget refilled underneath us.
    //
    // (2) is not implied by (1). A refill whose `reset_at` did not move with it,
    // or one where the previous row carried no `reset_at` at all, leaves (1)
    // false. Error is `timeRemainingPct - percentLeft`, so the refill makes the
    // error fall sharply, and with (1) false that fall is read as genuine
    // progress rather than the discontinuity it is. It does not merely spike:
    // `QUOTA_KD_SECONDS_SQUARED_PER_POINT` and `QUOTA_DERIVATIVE_TAU_SECONDS`
    // share an 1800 s constant, so the misread relaxes the interval across
    // roughly half an hour of subsequent observations.
    const resetMoved =
      previous?.resetAtIso != null &&
      Math.abs(Date.parse(previous.resetAtIso) - resetMs) >
        Math.min(60 * 60 * 1000, observation.windowMs * 0.05);
    const quotaRefilled =
      previous != null &&
      observation.percentLeft - previous.percentLeft > QUOTA_REFILL_EPSILON_POINTS;
    const cycleChanged = resetMoved || quotaRefilled;
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
    const integralDtSeconds = cycleChanged
      ? 0
      : Math.min(dtSeconds, QUOTA_MAX_CREDITED_ELAPSED_SECONDS);
    const previousIntegral = cycleChanged ? 0 : (previous?.controllerIntegral ?? 0);
    const candidateIntegral = previousIntegral + error * integralDtSeconds;
    const rawWithoutIntegral =
      QUOTA_KP_SECONDS_PER_POINT * error + QUOTA_KD_SECONDS_SQUARED_PER_POINT * derivative;
    const rawInterval = (accumulated: number) =>
      rawWithoutIntegral + QUOTA_KI_SECONDS_PER_POINT_SECOND * accumulated;
    // Conditional-integration anti-windup. Accept the portion of this step that
    // reaches a raw actuator bound, but do not add area beyond it. If earlier
    // state is already beyond today's reachable bound, hold it rather than
    // fabricating opposite-signed area; a later reversing error can unwind it.
    const candidateRaw = rawInterval(candidateIntegral);
    let integral = candidateIntegral;
    if (error > 0 && candidateRaw > opts.maxIntervalSeconds) {
      const upperBound =
        (opts.maxIntervalSeconds - rawWithoutIntegral) / QUOTA_KI_SECONDS_PER_POINT_SECOND;
      integral = Math.min(candidateIntegral, Math.max(previousIntegral, upperBound));
    } else if (error < 0 && candidateRaw < 0) {
      const lowerBound = -rawWithoutIntegral / QUOTA_KI_SECONDS_PER_POINT_SECOND;
      integral = Math.max(candidateIntegral, Math.min(previousIntegral, lowerBound));
    }
    const uncappedCandidate = Math.max(0, rawInterval(integral));
    // A rollover resets the controller memory, not the actuator. This resumes
    // from the last reasoned period rather than treating the exhaustion wait as one.
    const previousInterval = previous?.intervalSeconds ?? 0;
    // Ingestion produces one durable observation per actual scrape/manual POST;
    // cache reads and collection ticks only see the already-persisted state, so
    // `dtSeconds` here is observation age rather than request cadence. Credit
    // at most one trusted 30-minute slot, consistently for smoothing, slew,
    // and integration; cached reads cannot create another response.
    const { smoothing, slew } = elapsedActuatorResponse(dtSeconds, previous != null);
    const smoothed = previousInterval + smoothing * (uncappedCandidate - previousInterval);
    const uncappedInterval = Math.max(
      0,
      Math.min(previousInterval + slew, Math.max(previousInterval - slew, smoothed))
    );
    const interval = Math.min(opts.maxIntervalSeconds, uncappedInterval);

    this.db
      .prepare(
        `UPDATE quota_observations
         SET processed = 1, controller_error = ?, controller_derivative = ?,
             controller_integral = ?, uncapped_interval_seconds = ?, interval_seconds = ?
         WHERE provider = ? AND kind = ? AND observed_slot = ?`
      )
      .run(
        error,
        derivative,
        integral,
        uncappedInterval,
        interval,
        observation.provider,
        observation.kind,
        observation.slot
      );
    this.metrics.counter(QUOTA_SERVICE_METRICS.controllerStepsTotal, {
      provider: observation.provider,
    });
  }

  private markProcessed(observation: Pick<StoredObservation, "provider" | "kind" | "slot">): void {
    this.db
      .prepare(
        `UPDATE quota_observations SET processed = 1
         WHERE provider = ? AND kind = ? AND observed_slot = ?`
      )
      .run(observation.provider, observation.kind, observation.slot);
  }

  /**
   * Operator hard reset of one provider's PID controller.
   *
   * The controller's only memory is the newest reasoned observation per
   * `(provider, kind)`: its derivative filter state, its integral area and the
   * period it commanded (the slew and smoothing baseline). Clearing those
   * columns on every reasoned row makes the provider's next observation reason
   * as a cold start — derivative and integral at zero, the period smoothed up
   * from zero — and drops the published period to zero until that observation
   * arrives. Nothing else moves: the observations stay (they are quota
   * evidence, not controller state), `controller_error` stays because it is a
   * pure function of its observation and is the proportional history the
   * dashboard charts, and other providers are untouched.
   *
   * This is a persisted row update, so it survives a coordinator restart and
   * is visible to every connection on the shared file; the process performing
   * it needs no controller of its own.
   *
   * ## Why every retained decision is cleared, not just the newest
   *
   * Clearing only the newest reasoned row per `(provider, kind)` is incorrect:
   * both the controller's prior-state lookup and {@link getProviderThrottle}
   * find their row by `interval_seconds IS NOT NULL ... ORDER BY observed_at
   * DESC LIMIT 1`, so blanking the newest simply promotes the one before it
   * and an older period silently becomes current again — the precise failure
   * the reset exists to prevent.
   *
   * `interval_seconds` *is* the lookup key, so hiding a row from the
   * controller and keeping its historical value are the same operation with
   * opposite requirements. Preserving history would take a reset marker or
   * cutoff the lookup could read past — a new column or table, i.e. a schema
   * migration. #521 itself asks only for the zeroing; the no-migration
   * boundary comes from its triage (issue comment 5702034188), which
   * commissioned this as a focused, no-schema change. Within that boundary
   * the nulling is forced, not preferred.
   *
   * The in-between variant — zero the newest reasoned row per kind in place
   * (`controller_integral = 0, controller_derivative = 0,
   * uncapped_interval_seconds = 0, interval_seconds = 0`) and leave older
   * rows alone — gives the same actuator baseline and the same published `0`
   * while keeping every earlier period, and was rejected for one reason:
   * `0` is a value the reasoning step legitimately writes (`Math.max(0, …)`
   * when a lane is ahead of pace). A zeroed row is therefore
   * indistinguishable, in `listHistorySince`, in the published buckets and to
   * the controller itself, from a decision the controller actually made at
   * that row's `observed_at` — it rewrites one real decision per kind to a
   * value that was never commanded, at an instant before the reset happened,
   * and a published status reading "governing bucket commanded 0" cannot be
   * told apart from "reset, awaiting its first observation". `NULL` is the one
   * value the reasoning step never writes, so it is the only unambiguous
   * "no decision" available without a schema change, and the published status
   * shows it as such (`governingBucketKey: null`, no buckets). The variant's
   * first step is also not quite a cold start — the gap since the zeroed row
   * feeds the integral (`error × min(dt, QUOTA_MAX_CREDITED_ELAPSED_SECONDS)`,
   * at most half of the proportional term (`(QUOTA_KP_SECONDS_PER_POINT / QUOTA_INTEGRAL_TIME_SECONDS) × QUOTA_MAX_CREDITED_ELAPSED_SECONDS = 120/3600 × 1800 = 60 s/pt`)) and its retained
   * `controller_error` feeds the raw derivative — but that is bounded and
   * would not on its own have disqualified it.
   *
   * The accepted cost is real and bounded: the provider's retained *actuator*
   * history goes null, so `listHistorySince` reports `intervalSeconds: null`
   * for its past points and dashboard period charts lose that provider's
   * pre-reset line — at most {@link QUOTA_OBSERVATION_RETENTION_MS} of a
   * series that ages out on that schedule anyway. What survives is the
   * evidence and the policy signal — every canonical observation (percent
   * left, reset instants) and every `controller_error`, which is a pure
   * function of its own observation and is the proportional history those
   * dashboards chart. Inserting a synthetic zero-period row to keep the series
   * contiguous was rejected for the same reason as zeroing in place: it would
   * record a controller decision that never happened. A future change that
   * does carry a migration can add the cutoff marker and keep both.
   *
   * ## Why the whole provider lane, across every window kind
   *
   * Pacing is applied per provider lane, and
   * {@link getProviderThrottle} elects the governing bucket as the widest
   * uncapped period across that provider's kinds. Resetting a single kind
   * would leave another kind's stale decision governing the lane, so the
   * reset would not be one. Provider-wide is the unit that matches the
   * actuator.
   *
   * ## What it deliberately does not touch
   *
   * An exhausted observation (`percent_left = 0` with a future reset instant)
   * stays, so {@link getExhaustedUntil} keeps gating the lane. This command
   * resets *pacing policy*; it does not assert that quota was replenished.
   * Only a fresh scrape is evidence of that.
   *
   * ## Against a live coordinator
   *
   * The write runs as `BEGIN IMMEDIATE` ({@link run.immediate}), taking the
   * RESERVED lock up front instead of upgrading mid-transaction, so it cannot
   * deadlock against the collection loop's own immediate transaction. In WAL
   * mode with the connection's `busy_timeout`, a writer that finds the lock
   * held waits it out rather than failing, so neither process sees
   * `SQLITE_BUSY` for ordinary contention.
   */
  resetController(provider: string): QuotaControllerResetResult {
    const run = this.db.transaction(() => {
      const clearedDecisions = this.db
        .prepare(
          `UPDATE quota_observations
           SET controller_derivative = NULL, controller_integral = NULL,
               uncapped_interval_seconds = NULL, interval_seconds = NULL
           WHERE provider = ? AND interval_seconds IS NOT NULL`
        )
        .run(provider).changes;
      const { n: observations } = this.db
        .prepare("SELECT count(*) AS n FROM quota_observations WHERE provider = ?")
        .get(provider) as { n: number };
      return { provider, clearedDecisions, observations };
    });
    return run.immediate();
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
                controller_integral AS controllerIntegral,
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
    const currentByKind = new Map(current.map((row) => [row.kind, row]));
    const updatedAt =
      current
        .map((row) => row.observedAt)
        .sort()
        .at(-1) ?? new Date(0).toISOString();
    // The governing bucket is elected from the kinds the newest scrape emitted
    // (§5.5). `insertObservations` stamps every row of one snapshot with the one
    // `scrapedAt` string, so same-scrape membership is exact equality with
    // `updatedAt`.
    const currentScrapeReasoned = reasoned.filter(
      (row) => (currentByKind.get(row.kind)?.observedAt ?? row.observedAt) === updatedAt
    );
    // The newest scrape can have no reasoned row: its rows are inserted in
    // `recordParsed` but only reasoned when the collection tick reaches
    // `advancePendingController` after the remaining providers' probes, so a
    // `/v1/throttle` read served in between sees `interval_seconds` NULL; and
    // `advanceObservation` marks a row processed without an interval when it has
    // no usable reset or no quota left. Fall back to the last reasoned bucket so
    // the lane keeps its last-good interval rather than publishing 0. Freshness
    // then ages the lane by that bucket (it is governing), which is the slower
    // direction (§5.7) and lasts until the controller reasons the newest rows or
    // the next scrape lands.
    const eligibleReasoned = currentScrapeReasoned.length > 0 ? currentScrapeReasoned : reasoned;
    eligibleReasoned.sort((a, b) => b.uncappedIntervalSeconds - a.uncappedIntervalSeconds);
    const governing = eligibleReasoned[0];
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

  private insertObservations(
    state: ProviderQuotaSnapshot,
    storedObservedAt?: string,
    storedProvider?: string
  ): void {
    const observedAt = state.scrapedAt ?? storedObservedAt;
    const observedMs = observedAt ? Date.parse(observedAt) : Number.NaN;
    if (!observedAt || !Number.isFinite(observedMs)) return;
    const provider = (storedProvider ?? state.provider).trim().toLocaleLowerCase("en-US");
    const observed = (result: QuotaObservationResult): void => {
      this.metrics.counter(QUOTA_SERVICE_METRICS.observationsTotal, { provider, result });
    };
    const seenKinds = new Set<string>();
    for (const limit of state.limits ?? []) {
      // A window this store will not reason about — model-scoped, or a percent
      // outside 0..100 — is counted as rejected rather than dropped silently,
      // because a parser regression shows up here as reads that produce
      // observations no controller ever sees.
      if (!isProviderScopedWindow(limit) || !Number.isFinite(limit.percentLeft)) {
        observed("rejected");
        continue;
      }
      if (limit.percentLeft < 0 || limit.percentLeft > 100) {
        observed("rejected");
        continue;
      }
      const kind = normalizeKind(limit.kind);
      if (seenKinds.has(kind)) {
        observed("superseded");
        continue;
      }
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
      if (existing?.processed === 1) {
        observed("superseded");
        continue;
      }
      const candidateWins =
        !existing ||
        (hasValidReset(candidate) && !hasValidReset(existing)) ||
        (hasValidReset(candidate) === hasValidReset(existing) &&
          Date.parse(candidate.observedAt) > Date.parse(existing.observedAt));
      if (!candidateWins) {
        observed("superseded");
        continue;
      }
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
      observed("recorded");
    }
  }
}
