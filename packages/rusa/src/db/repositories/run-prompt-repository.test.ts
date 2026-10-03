import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { createActorRunModelConfig } from "./actor-run-model-config.js";
import { ActorRunRepository } from "./actor-run-repository.js";
import {
  RUN_PROMPT_MAX_BYTES,
  RUN_PROMPT_RETENTION_MS,
  RunPromptRepository,
} from "./run-prompt-repository.js";

describe("#866 retained launch prompts", () => {
  let db: Database.Database;
  let prompts: RunPromptRepository;
  let runId: string;
  const now = Date.parse("2026-10-03T16:00:00.000Z");
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    prompts = new RunPromptRepository(db);
    runId = new ActorRunRepository(db).start({
      actorId: "actor",
      startedAt: new Date(now).toISOString(),
      modelConfig: createActorRunModelConfig({ provider: "claude", model: "fixture" }),
    });
  });
  afterEach(() => db.close());
  it("retains the last launched fallback including provider and original byte count", () => {
    prompts.record(runId, "first", "claude", null, now);
    prompts.record(runId, "second ✓", "antigravity", null, now);
    expect(prompts.getById(runId, now)).toMatchObject({
      prompt: "second ✓",
      promptBytes: 10,
      provider: "antigravity",
      truncated: false,
    });
    expect(db.prepare("SELECT count(*) n FROM run_prompts").get()).toEqual({ n: 1 });
  });
  it("caps the UTF-8 head on a code point boundary", () => {
    const text = "a".repeat(RUN_PROMPT_MAX_BYTES - 1) + "😀tail";
    prompts.record(runId, text, "claude", null, now);
    const retained = prompts.getById(runId, now);
    if (!retained) throw new Error("missing retained prompt");
    expect(retained.prompt).toBe("a".repeat(RUN_PROMPT_MAX_BYTES - 1));
    expect(retained.promptBytes).toBe(Buffer.byteLength(text));
    expect(retained.truncated).toBe(true);
  });
  it("expires reads immediately and prunes after 30 days with an injected clock", () => {
    prompts.record(runId, "fixture", "claude", null, now);
    expect(prompts.getById(runId, now + RUN_PROMPT_RETENTION_MS)).not.toBeNull();
    expect(prompts.getById(runId, now + RUN_PROMPT_RETENTION_MS + 1)).toBeNull();
    expect(prompts.prune(now + RUN_PROMPT_RETENTION_MS)).toBe(0);
    expect(prompts.prune(now + RUN_PROMPT_RETENTION_MS + 1)).toBe(1);
    expect(new ActorRunRepository(db).getById(runId)).not.toBeNull();
  });
  it("cascades a deleted run without changing event rows", () => {
    prompts.record(runId, "fixture", "claude", null, now);
    db.prepare("DELETE FROM actor_runs WHERE id = ?").run(runId);
    expect(prompts.getById(runId, now)).toBeNull();
  });
  it("retains unknown launch provenance as ineligible rather than inventing shared visibility", () => {
    prompts.recordForActor("actor", runId, "fixture", "claude");
    expect(prompts.getById(runId)?.provenance).toBeNull();
  });
});
