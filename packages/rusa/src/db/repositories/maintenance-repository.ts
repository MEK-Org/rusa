import type Database from "better-sqlite3";
import type { TaskRow } from "../index.js";

/** Data access for knowledge-maintenance/distillation task scheduling. */
export class MaintenanceRepository {
  constructor(private readonly db: Database.Database) {}

  hasPendingDistillationTask(): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM tasks
         WHERE persona = 'distiller' AND status IN ('queued', 'in_progress')`
      )
      .get() as { cnt: number };
    return row.cnt > 0;
  }

  getNextQueuedTask(): TaskRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE persona = 'distiller' AND status = 'queued'
         ORDER BY
           CASE WHEN not_before IS NULL THEN 0 ELSE 1 END ASC,
           COALESCE(not_before, created_at) ASC,
           created_at ASC
         LIMIT 1`
      )
      .get() as TaskRow | undefined;
    return row ?? null;
  }

  getRecentTasks(limit = 20): TaskRow[] {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.floor(limit), 1), 100)
      : 20;
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE persona = 'distiller'
           AND status IN ('done', 'failed', 'blocked')
         ORDER BY updated_at DESC, created_at DESC, id DESC
         LIMIT ?`
      )
      .all(normalizedLimit) as TaskRow[];
  }
}
