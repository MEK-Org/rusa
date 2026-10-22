import type Database from "better-sqlite3";

export interface MetricSample {
  metric: string;
  minute: string;
  value: number | null;
  observedAt: string;
}

export interface MetricQueryRange {
  startMinute: string;
  endMinute: string;
}

/**
 * Generic metric sample repository behind time-series metric storage.
 * Keyed by (metric, minute). Value is nullable to distinguish an
 * observed zero from a sampled-but-empty population (null) and an
 * unsampled missing minute (no row).
 */
export class MetricRepository {
  constructor(private readonly db: Database.Database) {}

  /** Records one metric sample. */
  record(sample: MetricSample): void {
    this.db
      .prepare(
        `INSERT INTO metric_samples (metric, minute, value, observed_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(sample.metric, sample.minute, sample.value, sample.observedAt);
  }

  /** Records multiple metric samples in one transaction. */
  recordMany(samples: readonly MetricSample[]): void {
    if (samples.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO metric_samples (metric, minute, value, observed_at)
       VALUES (?, ?, ?, ?)`
    );
    const tx = this.db.transaction((items: readonly MetricSample[]) => {
      for (const item of items) {
        stmt.run(item.metric, item.minute, item.value, item.observedAt);
      }
    });
    tx(samples);
  }

  /** Reads samples for a single metric within an inclusive UTC minute range, oldest first. */
  read(metric: string, range: MetricQueryRange): MetricSample[] {
    const rows = this.db
      .prepare(
        `SELECT metric, minute, value, observed_at AS observedAt
         FROM metric_samples
         WHERE metric = ? AND minute >= ? AND minute <= ?
         ORDER BY minute ASC`
      )
      .all(metric, range.startMinute, range.endMinute) as Array<{
      metric: string;
      minute: string;
      value: number | null;
      observedAt: string;
    }>;
    return rows;
  }

  /** Reads samples for multiple metrics within an inclusive UTC minute range, oldest first. */
  readMany(metrics: readonly string[], range: MetricQueryRange): MetricSample[] {
    if (metrics.length === 0) return [];
    const placeholders = metrics.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT metric, minute, value, observed_at AS observedAt
         FROM metric_samples
         WHERE metric IN (${placeholders}) AND minute >= ? AND minute <= ?
         ORDER BY minute ASC, metric ASC`
      )
      .all(...metrics, range.startMinute, range.endMinute) as Array<{
      metric: string;
      minute: string;
      value: number | null;
      observedAt: string;
    }>;
    return rows;
  }

  /** Returns true if any sample (or a specific metric's sample) exists for this minute. */
  hasSample(minute: string, metric?: string): boolean {
    if (metric !== undefined) {
      return Boolean(
        this.db
          .prepare(`SELECT 1 FROM metric_samples WHERE metric = ? AND minute = ? LIMIT 1`)
          .get(metric, minute)
      );
    }
    return Boolean(
      this.db.prepare(`SELECT 1 FROM metric_samples WHERE minute = ? LIMIT 1`).get(minute)
    );
  }

  /** Deletes samples before the given minute. Returns the number of pruned rows. */
  prune(beforeMinute: string, metric?: string): number {
    if (metric !== undefined) {
      return this.db
        .prepare(`DELETE FROM metric_samples WHERE metric = ? AND minute < ?`)
        .run(metric, beforeMinute).changes;
    }
    return this.db.prepare(`DELETE FROM metric_samples WHERE minute < ?`).run(beforeMinute).changes;
  }
}
