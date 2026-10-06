import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import {
  INBOX_INTERRUPTION_JOIN,
  ROOM_HUMAN_ENTRY_PAYLOAD_TYPE,
  ROOM_HUMAN_ENTRY_VERSION,
} from "../repositories/inbox-interruption.js";
import type { InboxAppendInput, InboxEntry } from "../repositories/inbox-repository.js";
import { ROOM_ENTRY_COOLDOWN_MS, ROOM_ENTRY_SOURCE, RoomEntryService } from "./room-entry.js";

describe("RoomEntryService", () => {
  let appends: InboxAppendInput[];
  let clock: number;

  beforeEach(() => {
    appends = [];
    clock = 1_000_000;
  });

  const createService = (opts?: {
    roster?: () => readonly string[];
    cooldownMs?: number;
    log?: (msg: string) => void;
  }) => {
    return new RoomEntryService({
      inbox: {
        append: (entries: InboxAppendInput[]) => {
          appends.push(...entries);
          return entries as unknown as InboxEntry[];
        },
      },
      roster: opts?.roster ?? (() => ["actor-1", "actor-2"]),
      cooldownMs: opts?.cooldownMs,
      now: () => clock,
      log: opts?.log,
    });
  };

  it("sends noninterrupting inbox notices to all roster participants on first enter", () => {
    const service = createService();
    const result = service.enter({ principalId: "human-matt" });

    if (result.status !== "entered" || !result.notified) throw new Error("expected notified entry");
    expect(result.notified).toBe(true);
    expect(result.episodeId).toMatch(/^[0-9a-f-]{36}$/);

    expect(appends).toHaveLength(2);
    expect(appends.map((a) => a.actorId)).toEqual(["actor-1", "actor-2"]);
    for (const append of appends) {
      expect(append.source).toBe(ROOM_ENTRY_SOURCE);
      expect(append.id).toBe(`room-entry:${result.episodeId}:${append.actorId}`);
      expect(append.payload).toEqual({
        type: ROOM_HUMAN_ENTRY_PAYLOAD_TYPE,
        version: ROOM_HUMAN_ENTRY_VERSION,
        priority: "responsive",
        interruption: INBOX_INTERRUPTION_JOIN,
        episodeId: result.episodeId,
        principalId: "human-matt",
        enteredAt: new Date(1_000_000).toISOString(),
      });
    }
  });

  it.each([
    {
      name: "suppresses the same principal during the cooldown",
      advanceMs: 60_000,
      principalId: "human-matt",
      expected: {
        status: "entered",
        notified: false,
        reason: "cooldown",
        remainingMs: ROOM_ENTRY_COOLDOWN_MS - 60_000,
      },
      appendCount: 2,
    },
    {
      name: "keeps another principal independent",
      advanceMs: 10_000,
      principalId: "human-alice",
      expected: { status: "entered", notified: true },
      appendCount: 4,
    },
    {
      name: "allows the same principal after cooldown expiry",
      advanceMs: ROOM_ENTRY_COOLDOWN_MS,
      principalId: "human-matt",
      expected: { status: "entered", notified: true },
      appendCount: 4,
    },
  ])("$name", ({ advanceMs, principalId, expected, appendCount }) => {
    const service = createService();
    const first = service.enter({ principalId: "human-matt" });
    if (first.status !== "entered" || !first.notified) throw new Error("expected notified entry");
    expect(first.notified).toBe(true);
    expect(appends).toHaveLength(2);

    clock += advanceMs;
    expect(service.enter({ principalId })).toMatchObject(expected);
    expect(appends).toHaveLength(appendCount);
  });

  it("handles empty roster without creating appends", () => {
    const service = createService({ roster: () => [] });
    const result = service.enter({ principalId: "human-matt" });
    if (result.status !== "entered" || !result.notified) throw new Error("expected notified entry");
    expect(result.notified).toBe(true);
    expect(appends).toHaveLength(0);
  });

  it("returns unavailable after an append error and permits a retry before the cooldown", () => {
    const log = vi.fn();
    let failAppend = true;
    const service = new RoomEntryService({
      inbox: {
        append: () => {
          if (failAppend) throw new Error("disk full");
          return [];
        },
      },
      roster: () => ["actor-1"],
      now: () => clock,
      log,
    });

    const result = service.enter({ principalId: "human-matt" });
    expect(result).toEqual({ status: "unavailable", reason: "notice delivery failed" });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("failed to append room entry notices: Error: disk full")
    );

    failAppend = false;
    expect(service.enter({ principalId: "human-matt" })).toMatchObject({
      status: "entered",
      notified: true,
    });
  });

  it("integrates with real SqliteInboxRepository and enforces noninterrupting payload validation", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const inbox = new SqliteInboxRepository(db);

    const service = new RoomEntryService({
      inbox,
      roster: () => ["root"],
    });

    const result = service.enter({ principalId: "human-operator" });
    if (result.status !== "entered" || !result.notified) throw new Error("expected notified entry");
    expect(result.notified).toBe(true);

    const entries = inbox.list("root", { status: "all" }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe(ROOM_ENTRY_SOURCE);
    expect(entries[0].payload.interruption).toBe(INBOX_INTERRUPTION_JOIN);
    expect(entries[0].payload.priority).toBe("responsive");
    expect(entries[0].payload.principalId).toBe("human-operator");

    db.close();
  });
});
