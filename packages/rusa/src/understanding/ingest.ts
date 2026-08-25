import { randomUUID } from "node:crypto";
import { getRepositories } from "../db/index.js";
import { scheduleDistillationIfNeeded } from "./distill.js";

/**
 * Capture a piece of information as a raw input for the integrated understanding.
 * Used for markdown-file seeding (see seed.ts); GitHub events and chat are sourced
 * directly from mesh_events and GitHub by the mesh-era distiller, not through here.
 */
export function captureRawInput(opts: {
  providerEventId: string;
  platform: string;
  repo: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  author: string;
  content: string;
  metadata?: Record<string, unknown>;
}): void {
  try {
    const inserted = getRepositories().rawInputs.insert({
      id: randomUUID(),
      platform: opts.platform,
      providerEventId: opts.providerEventId,
      repo: opts.repo,
      issueNumber: opts.issueNumber,
      prNumber: opts.prNumber,
      author: opts.author,
      content: opts.content,
      metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
    });

    if (inserted) {
      // Schedule distillation if not already scheduled
      const taskId = scheduleDistillationIfNeeded();
      if (taskId) {
        console.log(
          `[ingest] Scheduled distillation task ${taskId.slice(0, 8)} in response to new input`
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ingest] Failed to capture raw input: ${msg}`);
  }
}
