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

/** One unhandled inbox row, as the statistics classify it. */
export interface InboxMetricEntry {
  actorId: string;
  source: string;
  payload: unknown;
}

/** Per-minute inbox backlog summaries behind the Overview inbox charts (#1018). */
export class InboxMetricRepository {
  /**
   * @param humanChatClassifier Returns, once per sample, the dashboard's #590
   *   classification against the shared scope: true for an entry no viewer but
   *   its own human may see. Such an entry is left out of every size and age
   *   before the sample is stored.
   */
  constructor(
    private readonly db: Database.Database,
    private readonly humanChatClassifier: () => (entry: InboxMetricEntry) => boolean
  ) {}

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
      const existing = this.db
        .prepare("SELECT 1 FROM inbox_metric_snapshots WHERE minute = ?")
        .get(minute);
      if (existing) return null;
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
    if (point) this.prune(nowMs);
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
