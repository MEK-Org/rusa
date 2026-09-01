import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { ACTOR_RUN_OUTPUT_MAX_CHARS, ActorRunRepository } from "./actor-run-repository.js";
import { MeshChatRepository } from "./mesh-chat-repository.js";

describe("ActorRunRepository", () => {
  let db: Database.Database;
  let runs: ActorRunRepository;
  let chat: MeshChatRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    runs = new ActorRunRepository(db);
    chat = new MeshChatRepository(db);
  });

  it("owns a run from start through yield and completion", () => {
    const id = runs.start({
      id: "run-1",
      actorId: "actor-a",
      startedAt: "2026-08-30T00:00:01.000Z",
      provider: "codex",
    });
    runs.recordYield(id, "complete", "shipped", "2026-08-30T00:00:02.000Z");
    runs.complete(id, {
      endedAt: "2026-08-30T00:00:03.000Z",
      success: true,
      exitCode: 0,
      output: "final output",
      model: "gpt-5.5",
    });

    expect(runs.getById(id)).toMatchObject({
      outcome: "completed",
      success: true,
      output: "final output",
      yieldStatus: "complete",
      yieldNote: "shipped",
      provider: "codex",
      model: "gpt-5.5",
    });
  });

  it("interleaves durable inbound chat and yield notes with a stable source cursor", () => {
    chat.record({
      id: "message-1",
      ts: "2026-08-30T00:00:01.000Z",
      senderId: "root",
      recipientId: "actor-a",
      body: "first",
    });
    const runId = runs.start({
      id: "run-1",
      actorId: "actor-a",
      startedAt: "2026-08-30T00:00:02.000Z",
    });
    runs.recordYield(runId, "blocked", "second", "2026-08-30T00:00:02.000Z");
    runs.complete(runId, {
      endedAt: "2026-08-30T00:00:03.000Z",
      success: true,
      exitCode: 0,
      output: "run output",
    });
    chat.record({
      id: "message-2",
      ts: "2026-08-30T00:00:04.000Z",
      senderId: "root",
      recipientId: "actor-a",
      body: "third",
    });

    const first = runs.listLedgerSourcesAfter("actor-a", null, 2);
    expect(first.sources.map((source) => [source.kind, source.body])).toEqual([
      ["message_received", "first"],
      ["run_yielded", "second"],
    ]);
    expect(first.hasMore).toBe(true);
    expect(
      runs.listLedgerSourcesAfter("actor-a", runId).sources.map((source) => source.body)
    ).toEqual(["third"]);
  });

  it("keeps the useful tail of oversized output", () => {
    const id = runs.start({ actorId: "actor-a" });
    runs.complete(id, {
      success: true,
      exitCode: 0,
      output: `${"x".repeat(ACTOR_RUN_OUTPUT_MAX_CHARS + 50)}TAIL`,
    });
    const output = runs.getById(id)?.output ?? "";
    expect(output).toContain("earlier chars truncated");
    expect(output.endsWith("TAIL")).toBe(true);
  });
});
