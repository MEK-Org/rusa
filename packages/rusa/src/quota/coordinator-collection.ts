import type { QuotaLlmProvider, QuotaProbeOutcome, QuotaService } from "../mcp/quota-mcp.js";
import {
  nullQuotaMetrics,
  QUOTA_SERVICE_METRICS,
  type QuotaMetrics,
} from "./coordinator-metrics.js";
import {
  DEFAULT_HARD_STALE_AFTER_MS,
  DEFAULT_MAX_INTERVAL_SECONDS,
  DEFAULT_STALE_AFTER_MS,
  publishedThrottle,
} from "./coordinator-protocol.js";
import type { SharedQuotaStore } from "./shared-store.js";

export const DEFAULT_COLLECTION_TICK_MS = 300_000; // quota.throttle.tickSeconds default (300s)

/**
 * Per-provider collection stats. Both counters concern actual probes started
 * by this loop: cache hits and joins on another in-flight probe do not move
 * them. `failures` records a rejected probe or an unknown result from a real
 * probe, never a cached unknown reading.
 */
export interface QuotaCollectionStats {
  attempts: number;
  failures: number;
  lastOutcome: "ok" | "failure" | null;
  lastScrapedAt: string | null;
  /**
   * When the last probe was *started*, as distinct from `lastScrapedAt`, which
   * only moves on a reading that survived parsing. The gap between the two is
   * the entire signal for "the service is up and its probes are broken": a
   * probe that fails before it can persist a scrape row leaves no trace in the
   * database, so readiness has to read it from the loop.
   */
  lastAttemptAt: string | null;
  /** The last probe failure message, retained until a probe succeeds. */
  lastError: string | null;
}

export interface QuotaCollectionLoopOptions {
  store: SharedQuotaStore;
  /** The service-owned probe/parse/infer path; its per-provider TTL is the probe floor. */
  quotaService: QuotaService;
  providers: readonly string[];
  /** Service tick cadence. Defaults to 300s (quota.throttle.tickSeconds). */
  tickMs?: number;
  maxIntervalSeconds?: number;
  /**
   * Freshness thresholds, matching the service's. The loop only needs them to
   * publish the same numbers the service would serve; they do not affect what
   * it collects.
   */
  staleAfterMs?: number;
  hardStaleAfterMs?: number;
  /** Metric sink; defaults to the discarding one. */
  metrics?: QuotaMetrics;
  /** Timer seams for tests. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  onError?: (provider: string, error: unknown) => void;
}

/**
 * The coordinator-side collection loop (#354, design §12 item 2): it owns
 * probing, parsing, inference, controller advancement, and pacing policy
 * inside the coordinator process.
 *
 * This is the approved temporary stage-1 collection path, not yet the pool's
 * sole collector: the instance client-read migration removes the legacy tick
 * in the later §12 item 3 / #355 rollout step.
 *
 * Every tick, per configured provider, the loop asks the single service-owned
 * `QuotaService` for the current state. The probe layer's TTL cache makes the
 * provider TTL a floor on probe cadence, and its in-flight dedupe collapses
 * concurrent ticks — within this coordinator process, exactly one probe and
 * one parse per provider per cadence no matter how many clients are connected
 * (criterion 1). After the probe batch the loop advances its pending
 * controller observations.
 *
 * Boot hydration seeds the single `prevState` per provider from the latest
 * persisted `quota_scrapes.parsed_state`, so a service restart continues an
 * in-flight `carried_forward_bad_read` chain instead of starting a fresh one
 * (design §6.3, criterion 13).
 */
/** A probe failure as readiness reports it: a message, never a stack. */
function describeProbeError(error: unknown): string {
  if (error === undefined || error === null) return "probe returned an unknown reading";
  return error instanceof Error ? error.message : String(error);
}

/**
 * The failure message for a probe that returned rather than threw. The probe
 * path reports scrape and parse failures as data — an `unknown` snapshot whose
 * `message` names the cause — so reading only `outcome.error` reduced every one
 * of them to the bare "probe returned an unknown reading" (#517). A codex lane
 * failing every probe for hours then looked identical whether the TUI never
 * launched or the panel failed to parse, which is the one thing readiness most
 * needs to tell apart.
 */
function describeProbeFailure(outcome: QuotaProbeOutcome): string {
  if (outcome.error !== undefined && outcome.error !== null) {
    return describeProbeError(outcome.error);
  }
  const message = outcome.state?.message?.trim();
  return message || describeProbeError(undefined);
}

export class QuotaCollectionLoop {
  private readonly tickMs: number;
  private readonly maxIntervalSeconds: number;
  private readonly staleAfterMs: number;
  private readonly hardStaleAfterMs: number;
  private readonly metrics: QuotaMetrics;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private timer: unknown = null;
  private tickInFlight: Promise<void> | null = null;
  private readonly stats = new Map<string, QuotaCollectionStats>();

  constructor(readonly options: QuotaCollectionLoopOptions) {
    this.tickMs = options.tickMs ?? DEFAULT_COLLECTION_TICK_MS;
    this.maxIntervalSeconds = options.maxIntervalSeconds ?? DEFAULT_MAX_INTERVAL_SECONDS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.hardStaleAfterMs = options.hardStaleAfterMs ?? DEFAULT_HARD_STALE_AFTER_MS;
    this.metrics = options.metrics ?? nullQuotaMetrics;
    this.setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn =
      options.clearIntervalFn ??
      ((handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]));
  }

  private stat(provider: string): QuotaCollectionStats {
    let entry = this.stats.get(provider);
    if (!entry) {
      entry = {
        attempts: 0,
        failures: 0,
        lastOutcome: null,
        lastScrapedAt: null,
        lastAttemptAt: null,
        lastError: null,
      };
      this.stats.set(provider, entry);
    }
    return entry;
  }

  getStats(provider: string): Readonly<QuotaCollectionStats> {
    return { ...this.stat(provider) };
  }

  /**
   * Every provider this loop collects, including ones that have not yet
   * produced a stat entry, so a provider whose first probe has not returned is
   * visible as "no attempt yet" rather than missing from readiness entirely.
   */
  getAllStats(): Record<string, Readonly<QuotaCollectionStats>> {
    const all: Record<string, Readonly<QuotaCollectionStats>> = {};
    for (const provider of this.options.providers) all[provider] = this.getStats(provider);
    return all;
  }

  /**
   * Boot hydration (design §6.3): for each provider, seed the probe layer's
   * single prevState from the newest persisted parsed snapshot. The store
   * validates the versioned blob; a malformed or unsupported row reads as
   * absent and the provider starts cold rather than from a half-trusted shape.
   */
  hydrate(): void {
    for (const provider of this.options.providers) {
      const snapshot = this.options.store.getLatestSnapshot(provider);
      if (snapshot) this.options.quotaService.hydrate(provider as QuotaLlmProvider, snapshot);
    }
  }

  start(): void {
    this.hydrate();
    void this.runTick();
    this.timer = this.setIntervalFn(() => void this.runTick(), this.tickMs);
  }

  stop(): void {
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }

  /** Run one collection tick now (test seam and the interval body). */
  tick(): Promise<void> {
    return this.runTick();
  }

  private runTick(): Promise<void> {
    // One coordinator tick at a time: a tick that is still probing when the
    // next cadence fires joins the in-flight tick instead of queueing a second
    // probe batch.
    if (!this.tickInFlight) {
      this.tickInFlight = this.doTick().finally(() => {
        this.tickInFlight = null;
      });
    }
    return this.tickInFlight;
  }

  private async doTick(): Promise<void> {
    for (const provider of this.options.providers) {
      const stat = this.stat(provider);
      const startedMs = Date.now();
      try {
        const outcome = await this.options.quotaService.getQuotaProbeOutcome(
          provider as QuotaLlmProvider
        );
        if (!outcome.didProbe) continue;
        stat.attempts += 1;
        stat.lastAttemptAt = new Date(startedMs).toISOString();
        this.metrics.histogram(
          QUOTA_SERVICE_METRICS.scrapeSeconds,
          (Date.now() - startedMs) / 1000,
          { provider }
        );
        if (outcome.error || outcome.state?.status === "unknown") {
          stat.failures += 1;
          stat.lastOutcome = "failure";
          stat.lastError = describeProbeFailure(outcome);
          this.metrics.counter(QUOTA_SERVICE_METRICS.scrapesTotal, {
            provider,
            outcome: "failure",
          });
        } else {
          stat.lastOutcome = "ok";
          stat.lastScrapedAt = outcome.state?.scrapedAt ?? stat.lastScrapedAt;
          stat.lastError = null;
          this.metrics.counter(QUOTA_SERVICE_METRICS.scrapesTotal, {
            provider,
            outcome: "success",
          });
        }
        if (outcome.error) this.options.onError?.(provider, outcome.error);
      } catch (error) {
        // getQuotaProbeOutcome currently reports probe errors as data. Retain
        // this guard for a programming failure without misreporting it as a
        // scrape attempt whose start we cannot prove.
        stat.lastError = describeProbeError(error);
        this.options.onError?.(provider, error);
      }
    }
    // This coordinator path owns its controller advancement. The later client
    // migration removes the legacy instance tick before this becomes the
    // pool-wide advancement path.
    this.options.store.advancePendingController({ maxIntervalSeconds: this.maxIntervalSeconds });
    this.publishThrottleMetrics();
  }

  /**
   * The two published-value gauges, emitted once per provider per tick —
   * where the value changes, not where it is read.
   *
   * Sampling them in the service's `/v1/throttle` handler instead would make
   * the series a function of how often clients happened to ask: a pool of
   * twenty instances reading every thirty seconds would emit the same interval
   * forty times a minute, and a pool that went quiet would emit nothing while
   * the controller kept moving. Here the series is one value per controller
   * step per provider, which is the shape a gauge is supposed to have, and it
   * lines up one-for-one against the instance-side applied-interval gauge. How
   * often clients read is `quota_reads_total`, which is a counter and already
   * carries that rate.
   */
  private publishThrottleMetrics(): void {
    const nowMs = Date.now();
    for (const provider of this.options.providers) {
      const stored = this.options.store.getProviderThrottle(provider);
      if (!stored) continue;
      const published = publishedThrottle(stored, {
        maxIntervalSeconds: this.maxIntervalSeconds,
        staleAfterMs: this.staleAfterMs,
        hardStaleAfterMs: this.hardStaleAfterMs,
        nowMs,
      });
      this.metrics.gauge(
        QUOTA_SERVICE_METRICS.publishedIntervalSeconds,
        published.intervalSeconds,
        {
          provider: published.provider,
        }
      );
      if (published.freshness.ageMs !== null && Number.isFinite(published.freshness.ageMs)) {
        this.metrics.gauge(
          QUOTA_SERVICE_METRICS.snapshotAgeSeconds,
          published.freshness.ageMs / 1000,
          { provider: published.provider }
        );
      }
    }
  }
}
