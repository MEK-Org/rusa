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

  /** Reads samples for multiple metrics within an inclusive UTC minute range, oldest first. */
  readMany(metrics: readonly string[], range: MetricQueryRange): MetricSample[] {
    if (metrics.length === 0) return [];
    const placeholders = metrics.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT metric, minute, value, observed_at AS observedAt
         FROM metric_samples
         WHERE metric IN (${placeholders}) AND minute >= ? AND minute <= ?
         ORDER BY minute ASC`
      )
      .all(...metrics, range.startMinute, range.endMinute) as Array<{
      metric: string;
      minute: string;
      value: number | null;
      observedAt: string;
    }>;
    return rows;
  }

  /** Returns true if a sample exists for the given metric and minute. */
  hasSample(minute: string, metric: string): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM metric_samples WHERE metric = ? AND minute = ? LIMIT 1`)
        .get(metric, minute)
    );
  }

  /** Deletes samples for the given metrics before the given minute. Returns the number of pruned rows. */
  prune(beforeMinute: string, metrics: readonly string[]): number {
    if (metrics.length === 0) return 0;
    const placeholders = metrics.map(() => "?").join(", ");
    return this.db
      .prepare(`DELETE FROM metric_samples WHERE metric IN (${placeholders}) AND minute < ?`)
      .run(...metrics, beforeMinute).changes;
  }
}
