import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compactPortableContext, readUnfoldedLedgerSources } from "../commands/start.js";
import * as dbIdx from "../db/index.js";
import { runMigrations } from "../db/migrations/runner.js";
import { createActorRunModelConfig } from "../db/repositories/actor-run-model-config.js";
import {
  ActorRunRepository,
  type PortableLedgerSource,
} from "../db/repositories/actor-run-repository.js";
import { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import { DbPortableContextStore } from "../db/repositories/portable-context-repository.js";
import { SqliteActorRepository } from "../db/repositories/sqlite-actor-repository.js";
import type { PortableContextCompactor } from "./portable-context-compactor.js";
import { selectDeltaJournal } from "./portable-context-delta.js";
import { InMemoryPortableContextStore } from "./portable-context-state.js";

vi.mock("../db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/index.js")>();
  return { ...actual, getRepositories: vi.fn() };
});

/**
 * Durability of the fold cursor under the conditions #1062 names: repeated
 * interruptions (folds deferred, delta accumulating), a compactor failure, a
 * restart, and the experiment being switched off and on. The compactor is a
 * fake that records every batch it was handed, so "folded exactly once" is a
 * direct count of source ids across calls.
 */
describe("fold cursor durability under deferral (#1062)", () => {
  const ACTOR = "actor-a";
  let db: Database.Database;
  let actorRuns: ActorRunRepository;
  let meshChat: MeshChatRepository;
  let sequence: number;

  const nextTimestamp = (): string =>
    new Date(Date.UTC(2026, 9, 14, 0, 0, sequence++)).toISOString();
  const recordInbound = (body: string): string =>
    meshChat.record({ ts: nextTimestamp(), senderId: "root", recipientId: ACTOR, body });
  const recordYield = (body: string): string => {
    const ts = nextTimestamp();
    const id = actorRuns.start({
      actorId: ACTOR,
      startedAt: ts,
      modelConfig: createActorRunModelConfig({ provider: "fake", model: "test-model" }),
    });
    actorRuns.recordYield(id, "complete", body, ts);
    actorRuns.complete(id, { endedAt: ts, success: true, exitCode: 0, output: body });
    return id;
  };

  /** A compactor that advances the cursor like the real one, or fails on demand. */
  function fakeCompactor(): PortableContextCompactor & {
    batches: PortableLedgerSource[][];
    failNext: boolean;
  } {
    const batches: PortableLedgerSource[][] = [];
    const compactor = {
      batches,
      failNext: false,
      async compact({ state, messages, now }: Parameters<PortableContextCompactor["compact"]>[0]) {
        if (compactor.failNext) {
          compactor.failNext = false;
          throw new Error("compactor unavailable");
        }
        batches.push(messages);
        return {
          state: {
            ...state,
            generation: state.generation + 1,
            updatedAt: now,
            lastFoldedSourceId: messages.at(-1)?.id ?? state.lastFoldedSourceId,
          },
          quarantined: [],
          operations: 0,
        };
      },
    };
    return compactor;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    actorRuns = new ActorRunRepository(db);
    meshChat = new MeshChatRepository(db);
    sequence = 0;
    // biome-ignore lint/suspicious/noExplicitAny: partial test mock
    vi.mocked(dbIdx.getRepositories).mockReturnValue({ actorRuns } as any);
  });

  it("accumulates the delta across repeated deferred folds and folds it exactly once", async () => {
    const store = new InMemoryPortableContextStore();
    const compactor = fakeCompactor();

    const m1 = recordInbound("first instruction");
    expect((await compactPortableContext({ actorId: ACTOR, store, compactor }))?.folded).toBe(1);
    const cursor = store.load(ACTOR).lastFoldedSourceId;
    expect(cursor).toBe(m1);

    // Three interrupted runs in a row: each would have folded, none does.
    // Nothing is called, so the delta is exactly what the prompt can still read.
    const m2 = recordInbound("second instruction (run 2 interrupted)");
    const y2 = recordYield("partial note from run 2");
    const m3 = recordInbound("third instruction (run 3 interrupted)");
    const m4 = recordInbound("fourth instruction (run 4 interrupted)");
    const unfolded = readUnfoldedLedgerSources(ACTOR, cursor);
    expect(unfolded.truncated).toBe(false);
    expect(unfolded.sources.map((source) => source.id)).toEqual([m2, y2, m3, m4]);
    const journal = selectDeltaJournal({
      unfolded: unfolded.sources,
      recentRuns: [{ id: y2, ts: "t", body: "partial note from run 2" }],
      maxMessages: 10,
    });
    expect(journal.messages.map((message) => message.id)).toEqual([m4, m3, m2]);
    expect(store.load(ACTOR).lastFoldedSourceId).toBe(cursor);

    // The next ordinary run end folds the accumulated delta in one pass.
    const summary = await compactPortableContext({ actorId: ACTOR, store, compactor });
    expect(summary?.folded).toBe(4);
    expect(summary?.foldedSelf).toBe(1);
    expect(store.load(ACTOR).lastFoldedSourceId).toBe(m4);
    expect(store.load(ACTOR).generation).toBe(2);

    // Exactly once: every source id appears in exactly one batch, and a further
    // pass has nothing to fold.
    const seen = compactor.batches.flat().map((source) => source.id);
    expect(seen).toEqual([m1, m2, y2, m3, m4]);
    expect(await compactPortableContext({ actorId: ACTOR, store, compactor })).toBeNull();
    expect(readUnfoldedLedgerSources(ACTOR, m4).sources).toEqual([]);
  });

  it("keeps the cursor and the delta when the compactor fails, then folds them once", async () => {
    const store = new InMemoryPortableContextStore();
    const compactor = fakeCompactor();
    const m1 = recordInbound("folded before the failure");
    await compactPortableContext({ actorId: ACTOR, store, compactor });
    const before = store.load(ACTOR);

    const m2 = recordInbound("arrives, then the compactor fails");
    compactor.failNext = true;
    await expect(compactPortableContext({ actorId: ACTOR, store, compactor })).rejects.toThrow(
      "compactor unavailable"
    );
    // No commit, no cursor movement: the snapshot is byte-identical.
    expect(store.load(ACTOR)).toEqual(before);
    expect(
      readUnfoldedLedgerSources(ACTOR, before.lastFoldedSourceId).sources.map((s) => s.id)
    ).toEqual([m2]);

    const retry = await compactPortableContext({ actorId: ACTOR, store, compactor });
    expect(retry?.folded).toBe(1);
    expect(compactor.batches.flat().map((source) => source.id)).toEqual([m1, m2]);
  });

  it("survives a restart: a fresh store over the same database resumes from the committed cursor", async () => {
    // The durable snapshot row references the actor row (0048), unlike the
    // in-memory store the other cases use.
    new SqliteActorRepository(db).upsert({
      id: ACTOR,
      charter: "durability subject",
      parentId: null,
      status: "active",
      createdAt: nextTimestamp(),
    });
    const compactor = fakeCompactor();
    const m1 = recordInbound("before restart");
    const m2 = recordInbound("also before restart");
    const firstProcess = new DbPortableContextStore(db);
    const summary = await compactPortableContext({
      actorId: ACTOR,
      store: firstProcess,
      compactor,
    });
    expect(summary?.folded).toBe(2);

    // The process dies after two interrupted runs left their sources unfolded.
    const m3 = recordInbound("interrupted before fold");
    const y3 = recordYield("interrupted run's note");

    const secondProcess = new DbPortableContextStore(db);
    expect(secondProcess.load(ACTOR).lastFoldedSourceId).toBe(m2);
    const resumed = await compactPortableContext({
      actorId: ACTOR,
      store: secondProcess,
      compactor,
    });
    expect(resumed?.folded).toBe(2);
    expect(compactor.batches.map((batch) => batch.map((source) => source.id))).toEqual([
      [m1, m2],
      [m3, y3],
    ]);
    expect(secondProcess.load(ACTOR).lastFoldedSourceId).toBe(y3);
  });

  it("advances the cursor page by page, so a failure mid-fold loses only the uncommitted page", async () => {
    const store = new InMemoryPortableContextStore();
    const compactor = fakeCompactor();
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(recordInbound(`message ${i}`));

    // Page one (50) commits; page two fails before commit.
    let calls = 0;
    const original = compactor.compact.bind(compactor);
    compactor.compact = async (input) => {
      calls += 1;
      if (calls === 2) throw new Error("page two failed");
      return original(input);
    };
    await expect(compactPortableContext({ actorId: ACTOR, store, compactor })).rejects.toThrow(
      "page two failed"
    );
    expect(store.load(ACTOR).lastFoldedSourceId).toBe(ids[49]);
    expect(readUnfoldedLedgerSources(ACTOR, ids[49] ?? null).sources).toHaveLength(10);

    const rest = await compactPortableContext({ actorId: ACTOR, store, compactor });
    expect(rest?.folded).toBe(10);
    expect(compactor.batches.flat().map((source) => source.id)).toEqual(ids);
  });

  it("reports truncation when the unfolded tail runs past the page ceiling, without moving the cursor", () => {
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) ids.push(recordInbound(`message ${i}`));
    const read = readUnfoldedLedgerSources(ACTOR, null, 2);
    expect(read.truncated).toBe(true);
    expect(read.sources).toHaveLength(100);
    expect(read.sources[0]?.id).toBe(ids[0]);
    const full = readUnfoldedLedgerSources(ACTOR, null);
    expect(full.truncated).toBe(false);
    expect(full.sources).toHaveLength(120);
  });
});
