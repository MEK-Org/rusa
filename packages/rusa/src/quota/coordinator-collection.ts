import type { QuotaLlmProvider, QuotaService } from "../mcp/quota-mcp.js";
import { DEFAULT_MAX_INTERVAL_SECONDS } from "./coordinator-protocol.js";
import type { SharedQuotaStore } from "./shared-store.js";

export const DEFAULT_COLLECTION_TICK_MS = 300_000; // quota.throttle.tickSeconds default (300s)

/**
 * Per-provider collection stats. `attempts` counts collection ticks that
 * asked the probe layer for a provider (a cache hit inside the probe layer's
 * TTL floor still counts as an attempt, not a probe); `failures` counts ticks
 * that produced no usable provider-wide reading — the scrape-failure counter
 * design §6.2 and criterion 4 name. Exact probe/parse counts are asserted at
 * the probe/parse seams in tests, because slot dedupe would hide a second
 * probe behind an identical row.
 */
export interface QuotaCollectionStats {
  attempts: number;
  failures: number;
  lastOutcome: "ok" | "failure" | null;
  lastScrapedAt: string | null;
}

export interface QuotaCollectionLoopOptions {
  store: SharedQuotaStore;
  /** The service-owned probe/parse/infer path; its per-provider TTL is the probe floor. */
  quotaService: QuotaService;
  providers: readonly string[];
  /** Service tick cadence. Defaults to 300s (quota.throttle.tickSeconds). */
  tickMs?: number;
  maxIntervalSeconds?: number;
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
export class QuotaCollectionLoop {
  private readonly tickMs: number;
  private readonly maxIntervalSeconds: number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private timer: unknown = null;
  private tickInFlight: Promise<void> | null = null;
  private readonly stats = new Map<string, QuotaCollectionStats>();

  constructor(readonly options: QuotaCollectionLoopOptions) {
    this.tickMs = options.tickMs ?? DEFAULT_COLLECTION_TICK_MS;
    this.maxIntervalSeconds = options.maxIntervalSeconds ?? DEFAULT_MAX_INTERVAL_SECONDS;
    this.setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn =
      options.clearIntervalFn ??
      ((handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]));
  }

  private stat(provider: string): QuotaCollectionStats {
    let entry = this.stats.get(provider);
    if (!entry) {
      entry = { attempts: 0, failures: 0, lastOutcome: null, lastScrapedAt: null };
      this.stats.set(provider, entry);
    }
    return entry;
  }

  getStats(provider: string): Readonly<QuotaCollectionStats> {
    return { ...this.stat(provider) };
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
      stat.attempts += 1;
      try {
        const snapshot = await this.options.quotaService.getQuota(provider as QuotaLlmProvider);
        if (snapshot.status === "unknown") {
          stat.failures += 1;
          stat.lastOutcome = "failure";
        } else {
          stat.lastOutcome = "ok";
          stat.lastScrapedAt = snapshot.scrapedAt ?? stat.lastScrapedAt;
        }
      } catch (error) {
        stat.failures += 1;
        stat.lastOutcome = "failure";
        this.options.onError?.(provider, error);
      }
    }
    // This coordinator path owns its controller advancement. The later client
    // migration removes the legacy instance tick before this becomes the
    // pool-wide advancement path.
    this.options.store.advancePendingController({ maxIntervalSeconds: this.maxIntervalSeconds });
  }
}
