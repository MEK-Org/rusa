import type Database from "better-sqlite3";

export interface RawInput {
  id: string;
  platform: string;
  providerEventId: string;
  repo: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  author: string;
  content: string;
  metadata: string | null;
  processedAt: string | null;
  createdAt: string;
}

interface RawInputRow {
  id: string;
  platform: string;
  provider_event_id: string;
  repo: string | null;
  issue_number: number | null;
  pr_number: number | null;
  author: string;
  content: string;
  metadata: string | null;
  processed_at: string | null;
  created_at: string;
}

/** Data access for raw distillation inputs. */
export class RawInputRepository {
  constructor(private readonly db: Database.Database) {}

  /** Insert a raw input idempotently on `(platform, provider_event_id)`. */
  insert(opts: {
    id: string;
    platform: string;
    providerEventId: string;
    repo: string | null;
    issueNumber: number | null;
    prNumber: number | null;
    author: string;
    content: string;
    metadata: string | null;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO raw_inputs (id, platform, provider_event_id, repo, issue_number, pr_number, author, content, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        opts.id,
        opts.platform,
        opts.providerEventId,
        opts.repo,
        opts.issueNumber,
        opts.prNumber,
        opts.author,
        opts.content,
        opts.metadata
      );
    return result.changes > 0;
  }

  /** All raw inputs that have not been processed yet. */
  getUnprocessed(): RawInput[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM raw_inputs WHERE processed_at IS NULL ORDER BY created_at ASC, id ASC`
      )
      .all() as RawInputRow[];
    return rows.map((row) => this.parseRow(row));
  }

  /** Raw inputs currently eligible for a distillation batch. */
  getPendingDistillation(limit = 50): RawInput[] {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.floor(limit), 1), 500)
      : 50;
    const rows = this.db
      .prepare(
        `SELECT * FROM raw_inputs WHERE processed_at IS NULL ORDER BY created_at ASC, id ASC LIMIT ?`
      )
      .all(normalizedLimit) as RawInputRow[];
    return rows.map((row) => this.parseRow(row));
  }

  countPendingDistillation(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM raw_inputs WHERE processed_at IS NULL`)
      .get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Reset distillation status for raw inputs, optionally since a specific time.
   */
  resetDistillation(since?: string): number {
    let changes = 0;
    this.db.transaction(() => {
      if (since) {
        const sqliteSince = this.toSqliteDatetime(since);
        if (!sqliteSince) {
          throw new Error(`Invalid 'since' timestamp: ${since}`);
        }
        const res = this.db
          .prepare(`UPDATE raw_inputs SET processed_at = NULL WHERE created_at >= ?`)
          .run(sqliteSince);
        changes += res.changes;
      } else {
        const res = this.db.prepare(`UPDATE raw_inputs SET processed_at = NULL`).run();
        changes += res.changes;
      }
    })();
    return changes;
  }

  markProcessed(rawInputIds: string[]): void {
    if (rawInputIds.length === 0) return;
    const placeholders = rawInputIds.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE raw_inputs
         SET processed_at = COALESCE(processed_at, datetime('now'))
         WHERE id IN (${placeholders})`
      )
      .run(...rawInputIds);
  }

  private parseRow(row: RawInputRow): RawInput {
    return {
      id: row.id,
      platform: row.platform,
      providerEventId: row.provider_event_id,
      repo: row.repo,
      issueNumber: row.issue_number,
      prNumber: row.pr_number,
      author: row.author,
      content: row.content,
      metadata: row.metadata,
      processedAt: row.processed_at,
      createdAt: row.created_at,
    };
  }

  private toSqliteDatetime(value: string | null | undefined): string | null {
    if (!value) return null;
    const timestamp = Date.parse(
      value.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`
    );
    if (!Number.isFinite(timestamp)) return null;
    return new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);
  }
}
