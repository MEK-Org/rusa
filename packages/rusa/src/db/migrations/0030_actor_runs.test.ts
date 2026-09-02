import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ActorRunRepository } from "../repositories/actor-run-repository.js";
import { actorRuns } from "./0030_actor_runs.js";

describe("0030_actor_runs", () => {
  it("backfills run/yield state and keeps legacy cursors resolvable after events are truncated", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE mesh_events (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        actor_id TEXT,
        detail TEXT,
        body TEXT,
        payload TEXT,
        success INTEGER
      );
      CREATE TABLE mesh_chat (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        body TEXT NOT NULL,
        session_id TEXT
      );
      INSERT INTO mesh_chat VALUES
        ('chat-1', '2026-08-30T00:00:02.000Z', 'root', 'actor-a', 'keep this', NULL);
      INSERT INTO mesh_events VALUES
        ('start-1', '2026-08-30T00:00:01.000Z', 'run_start', 'actor-a', NULL, NULL,
          '{"provider":"codex"}', NULL),
        ('message-event', '2026-08-30T00:00:02.000Z', 'message_received', 'actor-a', NULL, NULL,
          '{"messageId":"chat-1","from":"root"}', NULL),
        ('yield-event', '2026-08-30T00:00:03.000Z', 'run_yielded', 'actor-a', 'blocked',
          'waiting on review', NULL, NULL),
        ('end-1', '2026-08-30T00:00:04.000Z', 'run_end', 'actor-a', 'exit 0',
          'durable output', '{"yieldStatus":"blocked","model":"gpt-5.5"}', 1),
        ('start-2', '2026-08-30T00:00:05.000Z', 'run_start', 'actor-b', NULL, NULL,
          '{"provider":"claude"}', NULL),
        ('yield-abandoned', '2026-08-30T00:00:06.000Z', 'run_yielded', 'actor-b', 'blocked',
          'durable abandoned yield', NULL, NULL),
        ('abandoned-2', '2026-08-30T00:00:07.000Z', 'run_abandoned', 'actor-b', 'unreported',
          NULL, '{"started":true}', NULL),
        ('start-3', '2026-08-30T00:00:08.000Z', 'run_start', 'actor-c', NULL, NULL,
          '{"provider":"kimi"}', NULL),
        ('yield-unterminated', '2026-08-30T00:00:09.000Z', 'run_yielded', 'actor-c', 'complete',
          'durable unterminated yield', NULL, NULL);
    `);

    actorRuns.up(db);
    const repository = new ActorRunRepository(db);
    expect(repository.getById("end-1")).toMatchObject({
      actorId: "actor-a",
      startedAt: "2026-08-30T00:00:01.000Z",
      endedAt: "2026-08-30T00:00:04.000Z",
      outcome: "completed",
      success: true,
      exitCode: 0,
      output: "durable output",
      yieldStatus: "blocked",
      yieldNote: "waiting on review",
      provider: "codex",
      model: "gpt-5.5",
    });

    db.exec("DELETE FROM mesh_events");
    expect(
      repository
        .listLedgerSourcesAfter("actor-a", "message-event")
        .sources.map((source) => [source.kind, source.body])
    ).toEqual([["run_yielded", "waiting on review"]]);
    expect(repository.listLedgerSourcesAfter("actor-a", "yield-event").sources).toEqual([]);
    expect(repository.listRecentCompleted("actor-a", 10)[0]?.output).toBe("durable output");
    expect(repository.getById("abandoned-2")).toMatchObject({
      outcome: "abandoned",
      yieldNote: "durable abandoned yield",
    });
    expect(repository.listLedgerSourcesAfter("actor-b", "yield-abandoned").sources).toEqual([]);
    expect(repository.getById("start-3")).toMatchObject({
      outcome: "abandoned",
      yieldNote: "durable unterminated yield",
      abandonReason: "legacy run ended without a terminal event",
    });
    expect(repository.listLedgerSourcesAfter("actor-c", "yield-unterminated").sources).toEqual([]);
  });
});
