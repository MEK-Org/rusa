import type Database from "better-sqlite3";

export const RUN_PROMPT_MAX_BYTES = 256 * 1024;
export const RUN_PROMPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RetainedRunPrompt {
  prompt: string;
  promptBytes: number;
  truncated: boolean;
  provider: string;
  createdAt: string;
  /** Frozen, classified eligible viewers; null denotes unknown provenance; never returned by the HTTP API. */
  eligibleViewerIds: string[] | null;
}

/** Keep a UTF-8 head on a code point boundary, without inventing a replacement character. */
export function capturePrompt(prompt: string): { prompt: string; promptBytes: number } {
  const bytes = Buffer.from(prompt, "utf8");
  let end = Math.min(bytes.length, RUN_PROMPT_MAX_BYTES);
  if (end < bytes.length) {
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  }
  return { prompt: bytes.subarray(0, end).toString("utf8"), promptBytes: bytes.length };
}

export class RunPromptRepository {
  constructor(private readonly db: Database.Database) {}

  /** Each successful launch replaces the previous attempt, retaining the last one. */
  record(
    runId: string,
    prompt: string,
    provider: string,
    eligibleViewerIds: string[] | null,
    nowMs = Date.now()
  ): void {
    const captured = capturePrompt(prompt);
    this.db
      .prepare(`
      INSERT INTO run_prompts (run_id, prompt, prompt_bytes, provider, created_at, eligible_viewers)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET prompt=excluded.prompt, prompt_bytes=excluded.prompt_bytes,
        provider=excluded.provider, created_at=excluded.created_at, eligible_viewers=excluded.eligible_viewers
    `)
      .run(
        runId,
        captured.prompt,
        captured.promptBytes,
        provider,
        new Date(nowMs).toISOString(),
        eligibleViewerIds === null ? null : JSON.stringify(eligibleViewerIds)
      );
  }

  /** Unknown provenance stays private until a launch-time audience contract is established. */
  recordForActor(actorId: string, runId: string, prompt: string, provider: string): void {
    const run = this.db.prepare("SELECT actor_id FROM actor_runs WHERE id = ?").get(runId) as
      | { actor_id: string }
      | undefined;
    if (!run || run.actor_id !== actorId) return;
    this.record(runId, prompt, provider, null);
  }

  getById(runId: string, nowMs = Date.now()): RetainedRunPrompt | null {
    const row = this.db
      .prepare(`SELECT * FROM run_prompts WHERE run_id = ? AND created_at >= ?`)
      .get(runId, new Date(nowMs - RUN_PROMPT_RETENTION_MS).toISOString()) as
      | {
          prompt: string;
          prompt_bytes: number;
          provider: string;
          created_at: string;
          eligible_viewers: string | null;
        }
      | undefined;
    if (!row) return null;
    let eligibleViewerIds: unknown;
    try {
      eligibleViewerIds = row.eligible_viewers === null ? null : JSON.parse(row.eligible_viewers);
    } catch {
      return null;
    }
    if (
      eligibleViewerIds !== null &&
      (!Array.isArray(eligibleViewerIds) || eligibleViewerIds.some((id) => typeof id !== "string"))
    )
      return null;
    return {
      prompt: row.prompt,
      promptBytes: row.prompt_bytes,
      truncated: Buffer.byteLength(row.prompt, "utf8") < row.prompt_bytes,
      provider: row.provider,
      createdAt: row.created_at,
      eligibleViewerIds: eligibleViewerIds as string[] | null,
    };
  }

  prune(nowMs = Date.now()): number {
    return this.db
      .prepare(`DELETE FROM run_prompts WHERE created_at < ?`)
      .run(new Date(nowMs - RUN_PROMPT_RETENTION_MS).toISOString()).changes;
  }
}
