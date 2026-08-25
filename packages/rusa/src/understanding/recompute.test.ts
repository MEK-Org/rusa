import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { closeDb, getDb, getRepositories, initDb } from "../db/index.js";
import { recomputeDistillation } from "./distill.js";

let mcHome = "";

beforeEach(() => {
  closeDb();
  mcHome = mkdtempSync(join(tmpdir(), "rusa-recompute-test-"));
  initDb(mcHome);
});

afterEach(() => {
  closeDb();
  if (mcHome) {
    rmSync(mcHome, { recursive: true, force: true });
    mcHome = "";
  }
});

it("resets all distillation state when no since parameter is provided", async () => {
  getRepositories().rawInputs.insert({
    id: "ri-1",
    platform: "github",
    providerEventId: "evt-1",
    repo: "repo-1",
    author: "user",
    content: "content 1",
    issueNumber: null,
    prNumber: null,
    metadata: null,
  });
  getRepositories().rawInputs.insert({
    id: "ri-2",
    platform: "github",
    providerEventId: "evt-2",
    repo: "repo-1",
    author: "user",
    content: "content 2",
    issueNumber: null,
    prNumber: null,
    metadata: null,
  });

  // Mark both as processed
  getDb()
    .prepare(`UPDATE raw_inputs SET processed_at = datetime('now') WHERE id IN ('ri-1', 'ri-2')`)
    .run();
  expect(getRepositories().rawInputs.getUnprocessed().length).toBe(0);

  // Recompute
  const count = recomputeDistillation();
  expect(count).toBe(2);

  // Verify inputs are now unprocessed
  const unprocessed = getRepositories().rawInputs.getUnprocessed();
  expect(unprocessed.length).toBe(2);
  expect(unprocessed.map((ri) => ri.id)).toContain("ri-1");
  expect(unprocessed.map((ri) => ri.id)).toContain("ri-2");

  // Verify a distiller task was queued. (The v2 orchestrator audit task that
  // createTask used to write from `reasoning` was removed with the orchestrator
  // in ISSUE_NUM; recompute now just enqueues the distiller task.)
  const task = getRepositories().maintenance.getNextQueuedTask();
  expect(task).not.toBeNull();
  expect(task?.not_before).toBeNull();
});

it("resets only inputs since a specific time", async () => {
  const d = getDb();

  d.prepare(`
    INSERT INTO raw_inputs (id, platform, provider_event_id, repo, author, content, created_at)
    VALUES ('ri-old', 'github', 'evt-old', 'repo', 'user', 'old content', '2020-01-01 00:00:00')
  `).run();

  d.prepare(`
    INSERT INTO raw_inputs (id, platform, provider_event_id, repo, author, content, created_at)
    VALUES ('ri-new', 'github', 'evt-new', 'repo', 'user', 'new content', '2026-01-01 00:00:00')
  `).run();

  // Mark both as processed
  d.prepare(`UPDATE raw_inputs SET processed_at = datetime('now')`).run();
  expect(getRepositories().rawInputs.getUnprocessed().length).toBe(0);

  // Recompute since 2025
  const count = recomputeDistillation("2025-01-01T00:00:00Z");
  expect(count).toBe(1);

  // Only the newer input is unprocessed
  const unprocessed = getRepositories().rawInputs.getUnprocessed();
  expect(unprocessed.length).toBe(1);
  expect(unprocessed[0].id).toBe("ri-new");
});
