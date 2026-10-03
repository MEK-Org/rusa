import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { createActorRunModelConfig } from "./actor-run-model-config.js";
import { ActorRunRepository } from "./actor-run-repository.js";
import { RUN_PROMPT_RETENTION_MS, RunPromptRepository } from "./run-prompt-repository.js";

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
  it("retains the last launch input including provider", () => {
    prompts.record(runId, "first", "claude", now);
    prompts.record(runId, "second ✓", "antigravity", now);
    expect(prompts.getById(runId, now)).toMatchObject({
      prompt: "second ✓",
      provider: "antigravity",
    });
    expect(db.prepare("SELECT count(*) n FROM run_prompts").get()).toEqual({ n: 1 });
  });
  it("retains complete text beyond the former cap without reformatting", () => {
    const text = `${"a".repeat(300_000)}😀tail\n\n  indented\r\n`;
    prompts.record(runId, text, "claude", now);
    expect(prompts.getById(runId, now)?.prompt).toBe(text);
  });
  it("invalidates failed replacement durably only after DELETE succeeds", () => {
    prompts.record(runId, "first", "claude", now);
    db.exec(
      "CREATE TRIGGER deny_prompt BEFORE INSERT ON run_prompts BEGIN SELECT RAISE(ABORT, 'receipt denied'); END"
    );
    expect(() => prompts.record(runId, "second", "kimi", now)).toThrow("receipt denied");
    expect(prompts.getById(runId, now)).toBeNull();
    expect(new RunPromptRepository(db).getById(runId, now)).toBeNull();
    db.exec("DROP TRIGGER deny_prompt");
    prompts.record(runId, "third", "codex", now);
    expect(prompts.getById(runId, now)?.prompt).toBe("third");
    db.exec(
      "CREATE TRIGGER deny_delete BEFORE DELETE ON run_prompts BEGIN SELECT RAISE(ABORT, 'delete denied'); END"
    );
    expect(() => prompts.record(runId, "fourth", "kimi", now)).toThrow("delete denied");
    expect(prompts.getById(runId, now)).toBeNull();
    // Suppression is process-local when the database refused invalidation.
    expect(new RunPromptRepository(db).getById(runId, now)?.prompt).toBe("third");
    db.exec("DROP TRIGGER deny_delete");
    prompts.record(runId, "fifth", "claude", now);
    expect(prompts.getById(runId, now)?.prompt).toBe("fifth");
  });
  it("expires reads immediately and prunes after 30 days with an injected clock", () => {
    prompts.record(runId, "fixture", "claude", now);
    expect(prompts.getById(runId, now + RUN_PROMPT_RETENTION_MS)).not.toBeNull();
    expect(prompts.getById(runId, now + RUN_PROMPT_RETENTION_MS + 1)).toBeNull();
    expect(prompts.prune(now + RUN_PROMPT_RETENTION_MS)).toBe(0);
    expect(prompts.prune(now + RUN_PROMPT_RETENTION_MS + 1)).toBe(1);
    expect(new ActorRunRepository(db).getById(runId)).not.toBeNull();
  });
  it("cascades a deleted run without changing event rows", () => {
    prompts.record(runId, "fixture", "claude", now);
    db.prepare("DELETE FROM actor_runs WHERE id = ?").run(runId);
    expect(prompts.getById(runId, now)).toBeNull();
  });
  it("accepts production actor run receipts while rejecting mismatched run identity", () => {
    prompts.recordForActor("other-actor", runId, "wrong", "claude");
    expect(prompts.getById(runId)).toBeNull();
    prompts.recordForActor("actor", runId, "complete fixture", "claude");
    expect(prompts.getById(runId)?.prompt).toBe("complete fixture");
  });
});
