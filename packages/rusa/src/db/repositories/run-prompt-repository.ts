import type Database from "better-sqlite3";
import {
  parseRunPromptProvenance,
  type RunPromptProvenance,
} from "../../dashboard/run-prompt-visibility.js";

export const RUN_PROMPT_MAX_BYTES = 256 * 1024;
export const RUN_PROMPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RetainedRunPrompt {
  prompt: string;
  promptBytes: number;
  truncated: boolean;
  provider: string;
  createdAt: string;
  /** Frozen source identities, classification and requirements; null means unproven; never returned by the API. */
  provenance: RunPromptProvenance | null;
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
    provenance: RunPromptProvenance | null,
    nowMs = Date.now()
  ): void {
    const captured = capturePrompt(prompt);
    this.db
      .prepare(`
      INSERT INTO run_prompts (run_id, prompt, prompt_bytes, provider, created_at, provenance)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET prompt=excluded.prompt, prompt_bytes=excluded.prompt_bytes,
        provider=excluded.provider, created_at=excluded.created_at, provenance=excluded.provenance
    `)
      .run(
        runId,
        captured.prompt,
        captured.promptBytes,
        provider,
        new Date(nowMs).toISOString(),
        provenance === null ? null : JSON.stringify(provenance)
      );
  }

  /** The existing production builders cannot prove complete provenance; retain it as unknown. */
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
          provenance: string | null;
        }
      | undefined;
    if (!row) return null;
    let provenance: RunPromptProvenance | null;
    try {
      provenance =
        row.provenance === null ? null : parseRunPromptProvenance(JSON.parse(row.provenance));
    } catch {
      return null;
    }
    return {
      prompt: row.prompt,
      promptBytes: row.prompt_bytes,
      truncated: Buffer.byteLength(row.prompt, "utf8") < row.prompt_bytes,
      provider: row.provider,
      createdAt: row.created_at,
      provenance,
    };
  }

  prune(nowMs = Date.now()): number {
    return this.db
      .prepare(`DELETE FROM run_prompts WHERE created_at < ?`)
      .run(new Date(nowMs - RUN_PROMPT_RETENTION_MS).toISOString()).changes;
  }
}
