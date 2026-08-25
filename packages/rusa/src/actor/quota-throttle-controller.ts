import type { RunStartEvent } from "../db/repositories/mesh-event-repository.js";
import type { ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_SECONDS = 0;
const DEFAULT_MAX_INTERVAL_SECONDS = 60 * 60;
const MIN_INTERVAL_SECONDS = 0;

export const KP_INTERVAL = 12; // 12 seconds per 1% change in error
export const KI_INTERVAL = 0.05; // 0.05 seconds added to interval per second per 1% squared error
export const MIN_DERIVATIVE_DT_SECONDS = 60; // 1 minute minimum dt

export interface QuotaThrottleOptions {
  intervalSeconds?: number;
  maxIntervalSeconds?: number;
  now?: () => number;
}

export interface QuotaBucketReading {
  key: string;
  percentLeft: number;
  resetAtIso: string;
  windowMs: number;
  /** Timestamp of the real PTY scrape that produced this reading. */
  observedAtIso: string;
}

export type RunStartReading = Pick<RunStartEvent, "ts" | "payload">;

export interface QuotaBucketError {
  key: string;
  percentLeft: number;
  timeRemainingPct: number;
  error: number;
  requiredIntervalSeconds?: number;
  stale?: boolean;
}

export interface QuotaThrottleTick {
  intervalSeconds: number;
  held: boolean;
  expired: boolean;
  capped: boolean;
  learning: boolean;
  buckets: QuotaBucketError[];
  uncappedIntervalSeconds: number;
}

export interface QuotaThrottleStatus extends QuotaThrottleTick {
  updatedAt: string;
}

export function quotaBucketsFromState(state: ProviderQuotaSnapshot): QuotaBucketReading[] {
  if (!state.scrapedAt) return [];
  const readings: QuotaBucketReading[] = [];
  for (const limit of state.limits ?? []) {
    if (limit.scope !== "provider") continue;
    const reading = toReading(
      `${state.provider}:${limit.kind ?? "other"}:${limit.label}`,
      limit.percentLeft,
      limit.resetAtIso,
      limit.kind === "weekly" ? WEEK_MS : FIVE_HOUR_MS,
      state.scrapedAt
    );
    if (reading) readings.push(reading);
  }
  return readings;
}

function toReading(
  key: string,
  percentLeft: number | undefined,
  resetAtIso: string | undefined,
  windowMs: number,
  observedAtIso: string
): QuotaBucketReading | null {
  if (
    percentLeft == null ||
    !Number.isFinite(percentLeft) ||
    percentLeft < 0 ||
    percentLeft > 100 ||
    !resetAtIso ||
    Number.isNaN(Date.parse(resetAtIso)) ||
    Number.isNaN(Date.parse(observedAtIso))
  ) {
    return null;
  }
  return { key, percentLeft, resetAtIso, windowMs, observedAtIso };
}

/**
 * Stateless look-back estimator. It learns percentage-points consumed per
 * actual provider start from immutable scrape and run_start facts, then chooses
 * the normal start interval that would spend the remaining quota at a steady
 * rate through reset. Re-running it over the same facts returns the same answer.
 */
export class QuotaThrottleController {
  private readonly configuredIntervalSeconds: number;
  private readonly maxIntervalSeconds: number;
  private readonly now: () => number;
  private currentIntervalSeconds: number;

  constructor(opts: QuotaThrottleOptions = {}) {
    this.configuredIntervalSeconds = opts.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
    this.maxIntervalSeconds = opts.maxIntervalSeconds ?? DEFAULT_MAX_INTERVAL_SECONDS;
    this.now = opts.now ?? Date.now;
    if (!Number.isFinite(this.configuredIntervalSeconds) || this.configuredIntervalSeconds < 0) {
      throw new Error(`intervalSeconds must be >= 0, got ${this.configuredIntervalSeconds}`);
    }
    if (
      !Number.isFinite(this.maxIntervalSeconds) ||
      this.maxIntervalSeconds <= 0 ||
      this.maxIntervalSeconds < this.configuredIntervalSeconds
    ) {
      throw new Error(
        `maxIntervalSeconds must be >= intervalSeconds, got ${this.maxIntervalSeconds}`
      );
    }
    this.currentIntervalSeconds = this.configuredIntervalSeconds;
  }

  get intervalSeconds(): number {
    return this.currentIntervalSeconds;
  }

  update(history: QuotaBucketReading[]): QuotaThrottleTick {
    try {
      const now = this.now();
      const latestByKey = new Map<string, QuotaBucketReading[]>();
      for (const reading of history) {
        if (Date.parse(reading.observedAtIso) > now) continue;
        const entries = latestByKey.get(reading.key) ?? [];
        entries.push(reading);
        latestByKey.set(reading.key, entries);
      }

      const buckets: QuotaBucketError[] = [];
      let pacingRequired = MIN_INTERVAL_SECONDS;
      let exhaustedRequired = MIN_INTERVAL_SECONDS;
      let learned = false;
      let exhausted = false;
      let uncapped = MIN_INTERVAL_SECONDS;

      for (const [key, all] of latestByKey) {
        all.sort((a, b) => Date.parse(a.observedAtIso) - Date.parse(b.observedAtIso));
        const latest = all[all.length - 1];
        // Relative reset strings are normalized independently per scrape and may
        // drift by their display rounding. Treat nearby reset instants as one
        // cycle, while keeping the tolerance far below a full window rollover.
        const resetToleranceMs = Math.min(60 * 60 * 1000, latest.windowMs * 0.05);
        const latestResetMs = Date.parse(latest.resetAtIso);
        const sameWindow = all.filter(
          (entry) => Math.abs(Date.parse(entry.resetAtIso) - latestResetMs) <= resetToleranceMs
        );
        const first = sameWindow[0];
        const startMs = Date.parse(first.observedAtIso);
        const endMs = Date.parse(latest.observedAtIso);
        const resetMs = Date.parse(latest.resetAtIso);
        const timeRemainingSeconds = Math.max(0, (resetMs - now) / 1000);
        const timeRemainingPct = Math.min(
          100,
          Math.max(0, ((resetMs - now) / latest.windowMs) * 100)
        );
        const bucket: QuotaBucketError = {
          key,
          percentLeft: latest.percentLeft,
          timeRemainingPct,
          error: timeRemainingPct - latest.percentLeft,
        };

        if (timeRemainingSeconds <= 0 && latest.percentLeft > 0) {
          // Stale bucket: reset time is in the past, but quota is not 0
          bucket.stale = true;
          const bucketRequired = this.configuredIntervalSeconds;
          bucket.requiredIntervalSeconds = bucketRequired;
          uncapped = Math.max(uncapped, bucketRequired);
          pacingRequired = Math.max(pacingRequired, bucketRequired);
          learned = true; // Use the fallback interval loudly
        } else if (latest.percentLeft <= 0) {
          exhausted = true;
          const bucketRequired = timeRemainingSeconds;
          bucket.requiredIntervalSeconds = bucketRequired;
          uncapped = Math.max(uncapped, bucketRequired);
          exhaustedRequired = Math.max(exhaustedRequired, bucketRequired);
        } else if (sameWindow.length >= 2 && endMs > startMs) {
          let bucketInterval = 0;
          let prevMs = Date.parse(sameWindow[0].observedAtIso);
          const initialTimeRemainingPct = Math.min(
            100,
            Math.max(0, ((resetMs - prevMs) / latest.windowMs) * 100)
          );
          let prevError = initialTimeRemainingPct - sameWindow[0].percentLeft;

          for (let i = 1; i < sameWindow.length; i++) {
            const entry = sameWindow[i];
            const ms = Date.parse(entry.observedAtIso);
            const dtSeconds = (ms - prevMs) / 1000;

            if (dtSeconds >= MIN_DERIVATIVE_DT_SECONDS) {
              const currTimeRemainingPct = Math.min(
                100,
                Math.max(0, ((resetMs - ms) / latest.windowMs) * 100)
              );
              const error = currTimeRemainingPct - entry.percentLeft;

              const deltaError = error - prevError;
              const pTerm = KP_INTERVAL * deltaError;
              const iTerm = KI_INTERVAL * error * Math.abs(error) * dtSeconds;

              bucketInterval = Math.max(0, bucketInterval + pTerm + iTerm);

              prevMs = ms;
              prevError = error;
            }
          }

          if (Number.isFinite(bucketInterval)) {
            bucket.requiredIntervalSeconds = bucketInterval;
          }
          uncapped = Math.max(uncapped, bucketInterval);
          pacingRequired = Math.max(pacingRequired, bucketInterval);
          learned = true;
        }
        buckets.push(bucket);
      }

      const effectivePacing = learned
        ? Math.max(MIN_INTERVAL_SECONDS, Math.min(this.maxIntervalSeconds, pacingRequired))
        : this.configuredIntervalSeconds;

      if (exhausted) {
        this.currentIntervalSeconds = Math.max(
          MIN_INTERVAL_SECONDS,
          Math.max(exhaustedRequired, effectivePacing)
        );
        return {
          intervalSeconds: this.currentIntervalSeconds,
          held: false,
          expired: true,
          capped: false,
          learning: false,
          buckets,
          uncappedIntervalSeconds: uncapped,
        };
      }

      if (!learned) {
        uncapped = this.configuredIntervalSeconds;
      }
      const capped = learned && uncapped > this.maxIntervalSeconds;
      this.currentIntervalSeconds = effectivePacing;
      return {
        intervalSeconds: this.currentIntervalSeconds,
        held: !learned,
        expired: false,
        capped,
        learning: !learned,
        buckets,
        uncappedIntervalSeconds: uncapped,
      };
    } catch (err) {
      console.warn(
        `[quota-throttle] controller update failed: ${err instanceof Error ? err.message : String(err)}`
      );
      this.currentIntervalSeconds = this.configuredIntervalSeconds;
      return {
        intervalSeconds: this.configuredIntervalSeconds,
        held: true,
        expired: false,
        capped: false,
        learning: true,
        buckets: [],
        uncappedIntervalSeconds: this.configuredIntervalSeconds,
      };
    }
  }
}
