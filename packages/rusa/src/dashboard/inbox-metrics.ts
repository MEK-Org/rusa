export const INBOX_METRIC_INTERVAL_MS = 60 * 1000;
/** Matches the Overview's prior-three-day quota range. */
export const INBOX_METRIC_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** Minute positions in one window, both endpoints included. */
export const INBOX_METRIC_MAX_POINTS = INBOX_METRIC_WINDOW_MS / INBOX_METRIC_INTERVAL_MS + 1;

/**
 * One live actor's durable inbox at the sampling instant, leaving out messages
 * from human chats, which every viewer but their own human is shown nothing of
 * (#590). Only the remaining shared entries are counted or aged.
 */
export interface InboxMetricActorSample {
  sharedCount: number;
  /** Delivery of the oldest shared entry; null exactly when there is none. */
  oldestSharedDeliveredAt: string | null;
}

/** Cross-actor statistics for one sampled minute. */
export interface InboxMetricAggregate {
  actorCount: number;
  /**
   * Sizes and ages cover shared entries only. Null only when no live actor
   * existed: there is no population to summarize.
   */
  inboxSizeMedian: number | null;
  inboxSizeMax: number | null;
  oldestAgeSecondsMedian: number | null;
  oldestAgeSecondsMax: number | null;
}

export interface InboxMetricPoint extends InboxMetricAggregate {
  /** UTC minute this sample stands for; one sample per minute at most. */
  minute: string;
  /** Instant the inboxes were read; ages are measured from here. */
  observedAt: string;
}

export interface InboxMetricWindow {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  intervalSeconds: number;
  /** Ascending, sparse: a minute without a sample is absent, never zero. */
  points: InboxMetricPoint[];
}

export function minuteFloor(ms: number): number {
  return Math.floor(ms / INBOX_METRIC_INTERVAL_MS) * INBOX_METRIC_INTERVAL_MS;
}

/** First and last minute positions of the window ending in the minute of `nowMs`. */
export function inboxMetricWindowBounds(nowMs: number): { startMs: number; endMs: number } {
  const endMs = minuteFloor(nowMs);
  return { startMs: endMs - INBOX_METRIC_WINDOW_MS, endMs };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + upper) / 2 : upper;
}

/**
 * Computes one minute's cross-actor inbox statistics. An actor with no shared
 * entry, whether its inbox is empty or holds only human-chat messages, is an
 * observed zero size and zero age, so adding, changing or handling such a
 * message never moves either statistic. These are statistics across actors at
 * one instant, not over every inbox entry or over time.
 */
export function aggregateInboxMetricSamples(
  observedAt: string,
  samples: readonly InboxMetricActorSample[]
): InboxMetricAggregate {
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(observedAtMs)) throw new Error("observedAt must be an ISO timestamp");

  const counts: number[] = [];
  const ages: number[] = [];
  for (const sample of samples) {
    if (!Number.isInteger(sample.sharedCount) || sample.sharedCount < 0) {
      throw new Error("sharedCount must be a non-negative integer");
    }
    if (sample.sharedCount === 0) {
      if (sample.oldestSharedDeliveredAt !== null) {
        throw new Error("oldestSharedDeliveredAt must be null without a shared entry");
      }
      counts.push(0);
      ages.push(0);
      continue;
    }
    if (sample.oldestSharedDeliveredAt === null) {
      throw new Error("oldestSharedDeliveredAt is required with a shared entry");
    }
    const oldestMs = Date.parse(sample.oldestSharedDeliveredAt);
    if (!Number.isFinite(oldestMs) || oldestMs > observedAtMs) {
      throw new Error("oldestSharedDeliveredAt must be at or before observedAt");
    }
    counts.push(sample.sharedCount);
    ages.push((observedAtMs - oldestMs) / 1000);
  }

  const populated = samples.length > 0;
  return {
    actorCount: samples.length,
    inboxSizeMedian: populated ? median(counts) : null,
    inboxSizeMax: populated ? Math.max(...counts) : null,
    oldestAgeSecondsMedian: populated ? median(ages) : null,
    oldestAgeSecondsMax: populated ? Math.max(...ages) : null,
  };
}
