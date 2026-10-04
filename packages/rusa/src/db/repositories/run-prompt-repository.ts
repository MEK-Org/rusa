import type Database from "better-sqlite3";

export const RUN_PROMPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RetainedRunPrompt {
  prompt: string;
  createdAt: string;
}

export class RunPromptRepository {
  private readonly failedWrites = new Set<string>();
  constructor(private readonly db: Database.Database) {}

  /** Replace the previous attempt with the complete prompt supplied to this launch. */
  record(runId: string, prompt: string, nowMs = Date.now()): void {
    // Suppress stale reads in this repository if DELETE fails. After a successful
    // DELETE, INSERT failure leaves no row even across restart. DELETE failure
    // cannot durably invalidate storage that refused the write.
    this.failedWrites.add(runId);
    this.db.prepare("DELETE FROM run_prompts WHERE run_id = ?").run(runId);
    this.db
      .prepare(`
      INSERT INTO run_prompts (run_id, prompt, created_at)
      VALUES (?, ?, ?)
    `)
      .run(runId, prompt, new Date(nowMs).toISOString());
    this.failedWrites.delete(runId);
  }

  recordForActor(actorId: string, runId: string, prompt: string): void {
    const run = this.db.prepare("SELECT actor_id FROM actor_runs WHERE id = ?").get(runId) as
      | { actor_id: string }
      | undefined;
    if (!run || run.actor_id !== actorId) return;
    this.record(runId, prompt);
  }

  getById(runId: string, nowMs = Date.now()): RetainedRunPrompt | null {
    if (this.failedWrites.has(runId)) return null;
    const row = this.db
      .prepare(`
      SELECT prompt, created_at FROM run_prompts WHERE run_id = ? AND created_at >= ?
    `)
      .get(runId, new Date(nowMs - RUN_PROMPT_RETENTION_MS).toISOString()) as
      | { prompt: string; created_at: string }
      | undefined;
    return row ? { prompt: row.prompt, createdAt: row.created_at } : null;
  }

  prune(nowMs = Date.now()): number {
    const deleted = this.db
      .prepare(`DELETE FROM run_prompts WHERE created_at < ?`)
      .run(new Date(nowMs - RUN_PROMPT_RETENTION_MS).toISOString()).changes;
    for (const runId of this.failedWrites) {
      const row = this.db
        .prepare("SELECT created_at FROM run_prompts WHERE run_id = ?")
        .get(runId) as { created_at: string } | undefined;
      if (!row || Date.parse(row.created_at) < nowMs - RUN_PROMPT_RETENTION_MS)
        this.failedWrites.delete(runId);
    }
    return deleted;
  }
}
