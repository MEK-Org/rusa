import type Database from "better-sqlite3";
import {
  aggregateInboxMetricSamples,
  INBOX_METRIC_INTERVAL_MS,
  type InboxMetricActorSample,
  type InboxMetricPoint,
  type InboxMetricWindow,
  inboxMetricWindowBounds,
  minuteFloor,
} from "../../dashboard/inbox-metrics.js";
import { MetricRepository } from "./metric-repository.js";

export const INBOX_METRIC_NAMES = {
  actorCount: "actor_count",
  inboxSizeMedian: "inbox_size_median",
  inboxSizeMax: "inbox_size_max",
  oldestAgeSecondsMedian: "oldest_age_seconds_median",
  oldestAgeSecondsMax: "oldest_age_seconds_max",
} as const;

export const ALL_INBOX_METRIC_NAMES = [
  INBOX_METRIC_NAMES.actorCount,
  INBOX_METRIC_NAMES.inboxSizeMedian,
  INBOX_METRIC_NAMES.inboxSizeMax,
  INBOX_METRIC_NAMES.oldestAgeSecondsMedian,
  INBOX_METRIC_NAMES.oldestAgeSecondsMax,
] as const;

/** One unhandled inbox row, as the statistics classify it. */
export interface InboxMetricEntry {
  actorId: string;
  source: string;
  payload: unknown;
}

/** Per-minute inbox backlog summaries behind the Overview inbox charts (#1018). */
export class InboxMetricRepository {
  private readonly metrics: MetricRepository;

  /**
   * @param humanChatClassifier Returns, once per sample, the dashboard's #590
   *   classification against the shared scope: true for an entry no viewer but
   *   its own human may see. Such an entry is left out of every size and age
   *   before the sample is stored.
   */
  constructor(
    private readonly db: Database.Database,
    private readonly humanChatClassifier: () => (entry: InboxMetricEntry) => boolean,
    metrics?: MetricRepository
  ) {
    this.metrics = metrics ?? new MetricRepository(db);
  }

  /**
   * Records the current minute's sample unless one exists; a new sample also
   * prunes samples older than the window. Returns the new point, or null when
   * this minute was already sampled. The live population and every inbox are
   * read in one transaction, so the sample is one consistent instant.
   */
  sampleIfDue(nowMs = Date.now()): InboxMetricPoint | null {
    const minute = new Date(minuteFloor(nowMs)).toISOString();
    const observedAt = new Date(nowMs).toISOString();
    const point = this.db.transaction((): InboxMetricPoint | null => {
      if (this.metrics.hasSample(minute)) return null;

      // Every live actor, with its unhandled entries oldest first. An actor
      // with an empty inbox appears once, with no entry.
      const rows = this.db
        .prepare(`
          SELECT a.id AS actorId, e.source, e.delivered_at AS deliveredAt, e.payload_json AS payloadJson
          FROM actors a
          LEFT JOIN actor_inbox_entries e
            ON e.actor_id = a.id AND e.handled_at IS NULL AND e.delivered_at <= ?
          WHERE a.retired_at IS NULL OR a.retired_at > ?
          ORDER BY a.id, e.delivered_at, e.id
        `)
        .all(observedAt, observedAt) as Array<{
        actorId: string;
        source: string | null;
        deliveredAt: string | null;
        payloadJson: string | null;
      }>;
      const isHumanChat = this.humanChatClassifier();
      const byActor = new Map<string, InboxMetricActorSample>();
      for (const { actorId, source, deliveredAt, payloadJson } of rows) {
        let sample = byActor.get(actorId);
        if (!sample) {
          sample = { sharedCount: 0, oldestSharedDeliveredAt: null };
          byActor.set(actorId, sample);
        }
        if (source === null || deliveredAt === null || payloadJson === null) continue;
        if (isHumanChat({ actorId, source, payload: JSON.parse(payloadJson) })) continue;
        sample.sharedCount += 1;
        sample.oldestSharedDeliveredAt ??= deliveredAt;
      }
      const samples = [...byActor.values()];
      const next = { minute, observedAt, ...aggregateInboxMetricSamples(observedAt, samples) };

      this.metrics.recordMany([
        {
          metric: INBOX_METRIC_NAMES.actorCount,
          minute,
          value: next.actorCount,
          observedAt,
        },
        {
          metric: INBOX_METRIC_NAMES.inboxSizeMedian,
          minute,
          value: next.inboxSizeMedian,
          observedAt,
        },
        {
          metric: INBOX_METRIC_NAMES.inboxSizeMax,
          minute,
          value: next.inboxSizeMax,
          observedAt,
        },
        {
          metric: INBOX_METRIC_NAMES.oldestAgeSecondsMedian,
          minute,
          value: next.oldestAgeSecondsMedian,
          observedAt,
        },
        {
          metric: INBOX_METRIC_NAMES.oldestAgeSecondsMax,
          minute,
          value: next.oldestAgeSecondsMax,
          observedAt,
        },
      ]);
      return next;
    })();
    if (point) this.prune(nowMs);
    return point;
  }

  /** Deletes samples before the current window's first minute. */
  prune(nowMs = Date.now()): number {
    const { startMs } = inboxMetricWindowBounds(nowMs);
    return this.metrics.prune(new Date(startMs).toISOString());
  }

  /** The prior three days of samples, oldest first, ending at the current minute. */
  window(nowMs = Date.now()): InboxMetricWindow {
    const { startMs, endMs } = inboxMetricWindowBounds(nowMs);
    const windowStart = new Date(startMs).toISOString();
    const windowEnd = new Date(endMs).toISOString();
    const rows = this.metrics.readMany(ALL_INBOX_METRIC_NAMES, {
      startMinute: windowStart,
      endMinute: windowEnd,
    });

    const byMinute = new Map<string, InboxMetricPoint>();
    for (const row of rows) {
      let point = byMinute.get(row.minute);
      if (!point) {
        point = {
          minute: row.minute,
          observedAt: row.observedAt,
          actorCount: 0,
          inboxSizeMedian: null,
          inboxSizeMax: null,
          oldestAgeSecondsMedian: null,
          oldestAgeSecondsMax: null,
        };
        byMinute.set(row.minute, point);
      }
      switch (row.metric) {
        case INBOX_METRIC_NAMES.actorCount:
          point.actorCount = row.value !== null ? Math.round(row.value) : 0;
          break;
        case INBOX_METRIC_NAMES.inboxSizeMedian:
          point.inboxSizeMedian = row.value;
          break;
        case INBOX_METRIC_NAMES.inboxSizeMax:
          point.inboxSizeMax = row.value !== null ? Math.round(row.value) : null;
          break;
        case INBOX_METRIC_NAMES.oldestAgeSecondsMedian:
          point.oldestAgeSecondsMedian = row.value;
          break;
        case INBOX_METRIC_NAMES.oldestAgeSecondsMax:
          point.oldestAgeSecondsMax = row.value;
          break;
      }
    }

    return {
      generatedAt: new Date(nowMs).toISOString(),
      windowStart,
      windowEnd,
      intervalSeconds: INBOX_METRIC_INTERVAL_MS / 1000,
      points: [...byMinute.values()],
    };
  }
}
