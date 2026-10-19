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

interface SnapshotRow {
  minute: string;
  observed_at: string;
  actor_count: number;
  inbox_size_median: number | null;
  inbox_size_max: number | null;
  oldest_age_seconds_median: number | null;
  oldest_age_seconds_max: number | null;
}

function toPoint(row: SnapshotRow): InboxMetricPoint {
  return {
    minute: row.minute,
    observedAt: row.observed_at,
    actorCount: row.actor_count,
    inboxSizeMedian: row.inbox_size_median,
    inboxSizeMax: row.inbox_size_max,
    oldestAgeSecondsMedian: row.oldest_age_seconds_median,
    oldestAgeSecondsMax: row.oldest_age_seconds_max,
  };
}

/** Per-minute inbox backlog summaries behind the Overview inbox charts (#1018). */
export class InboxMetricRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Records the current minute's sample unless one exists, then prunes
   * samples older than the window. Returns the new point, or null when this
   * minute was already sampled. The live population and every inbox are read
   * in one statement, so the sample is one consistent instant.
   */
  sampleIfDue(nowMs = Date.now()): InboxMetricPoint | null {
    const minute = new Date(minuteFloor(nowMs)).toISOString();
    const observedAt = new Date(nowMs).toISOString();
    const point = this.db.transaction((): InboxMetricPoint | null => {
      const existing = this.db
        .prepare("SELECT 1 FROM inbox_metric_snapshots WHERE minute = ?")
        .get(minute);
      if (existing) return null;
      const samples = this.db
        .prepare(`
          SELECT count(e.id) AS unhandledCount, min(e.delivered_at) AS oldestDeliveredAt
          FROM actors a
          LEFT JOIN actor_inbox_entries e
            ON e.actor_id = a.id AND e.handled_at IS NULL AND e.delivered_at <= ?
          WHERE a.retired_at IS NULL OR a.retired_at > ?
          GROUP BY a.id
        `)
        .all(observedAt, observedAt) as InboxMetricActorSample[];
      const next = { minute, observedAt, ...aggregateInboxMetricSamples(observedAt, samples) };
      this.db
        .prepare(`
          INSERT INTO inbox_metric_snapshots (
            minute, observed_at, actor_count, inbox_size_median, inbox_size_max,
            oldest_age_seconds_median, oldest_age_seconds_max
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          next.minute,
          next.observedAt,
          next.actorCount,
          next.inboxSizeMedian,
          next.inboxSizeMax,
          next.oldestAgeSecondsMedian,
          next.oldestAgeSecondsMax
        );
      return next;
    })();
    this.prune(nowMs);
    return point;
  }

  /** Deletes samples before the current window's first minute. */
  prune(nowMs = Date.now()): number {
    const { startMs } = inboxMetricWindowBounds(nowMs);
    return this.db
      .prepare("DELETE FROM inbox_metric_snapshots WHERE minute < ?")
      .run(new Date(startMs).toISOString()).changes;
  }

  /** The prior three days of samples, oldest first, ending at the current minute. */
  window(nowMs = Date.now()): InboxMetricWindow {
    const { startMs, endMs } = inboxMetricWindowBounds(nowMs);
    const windowStart = new Date(startMs).toISOString();
    const windowEnd = new Date(endMs).toISOString();
    const rows = this.db
      .prepare(
        "SELECT * FROM inbox_metric_snapshots WHERE minute >= ? AND minute <= ? ORDER BY minute"
      )
      .all(windowStart, windowEnd) as SnapshotRow[];
    return {
      generatedAt: new Date(nowMs).toISOString(),
      windowStart,
      windowEnd,
      intervalSeconds: INBOX_METRIC_INTERVAL_MS / 1000,
      points: rows.map(toPoint),
    };
  }
}
