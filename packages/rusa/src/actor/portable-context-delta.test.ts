import { describe, expect, it } from "vitest";
import type { PortableLedgerSource } from "../db/repositories/actor-run-repository.js";
import { assemblePortableContextV2, type PriorMessage, type PriorRun } from "./portable-context.js";
import { selectDeltaJournal } from "./portable-context-delta.js";
import {
  emptyPortableContextState,
  type PortableContextState,
  type PortableMemoryItem,
} from "./portable-context-state.js";

const ts = (n: number): string => new Date(Date.UTC(2026, 9, 14, 0, 0, n)).toISOString();

function inbound(id: string, n: number, body: string, from = "root"): PortableLedgerSource {
  return {
    id,
    ts: ts(n),
    kind: "message_received",
    actorId: "actor-a",
    detail: null,
    body,
    payload: JSON.stringify({ messageId: id, from }),
    success: null,
  };
}

function yielded(id: string, n: number, body: string): PortableLedgerSource {
  return {
    id,
    ts: ts(n),
    kind: "run_yielded",
    actorId: "actor-a",
    detail: "complete",
    body,
    payload: null,
    success: null,
  };
}

const run = (id: string, n: number, body: string): PriorRun => ({ id, ts: ts(n), body });

describe("selectDeltaJournal (#1062)", () => {
  it("keeps only the unfolded inbound messages, newest first, with the sender from the payload", () => {
    const journal = selectDeltaJournal({
      unfolded: [
        inbound("m3", 3, "third", "operator"),
        yielded("r3", 4, "yield three"),
        inbound("m4", 5, "fourth"),
      ],
      recentRuns: [run("r3", 4, "out three"), run("r2", 2, "out two"), run("r1", 1, "out one")],
      maxMessages: 10,
    });
    expect(journal.messages.map((m) => m.id)).toEqual(["m4", "m3"]);
    expect(journal.messages.map((m) => m.sender)).toEqual(["root", "operator"]);
    expect(journal.unfoldedSources).toBe(3);
    expect(journal.unfoldedMessages).toBe(2);
    expect(journal.unfoldedYields).toBe(1);
  });

  it("shows unfolded yields' runs plus the latest run, and drops folded runs", () => {
    const journal = selectDeltaJournal({
      unfolded: [yielded("r2", 2, "yield two")],
      recentRuns: [run("r4", 4, "out four"), run("r3", 3, "out three"), run("r2", 2, "out two")],
      maxMessages: 10,
    });
    // r4 is the latest run (always kept); r2's yield is unfolded; r3 was folded.
    expect(journal.runs.map((r) => r.id)).toEqual(["r4", "r2"]);
  });

  it("is empty apart from the latest run when everything is folded", () => {
    const journal = selectDeltaJournal({
      unfolded: [],
      recentRuns: [run("r9", 9, "latest"), run("r8", 8, "older")],
      maxMessages: 10,
    });
    expect(journal.messages).toEqual([]);
    expect(journal.runs.map((r) => r.id)).toEqual(["r9"]);
    expect(journal.unfoldedSources).toBe(0);
  });

  it("applies the message count cap to the newest unfolded messages", () => {
    const unfolded = Array.from({ length: 5 }, (_, i) => inbound(`m${i}`, i, `body ${i}`));
    const journal = selectDeltaJournal({ unfolded, recentRuns: [], maxMessages: 2 });
    expect(journal.messages.map((m) => m.id)).toEqual(["m4", "m3"]);
    expect(journal.unfoldedMessages).toBe(5);
  });

  it("falls back to an unknown sender when the payload is absent or malformed", () => {
    const journal = selectDeltaJournal({
      unfolded: [
        { ...inbound("m1", 1, "a"), payload: null },
        { ...inbound("m2", 2, "b"), payload: "{not json" },
      ],
      recentRuns: [],
      maxMessages: 10,
    });
    expect(journal.messages.map((m) => m.sender)).toEqual(["unknown", "unknown"]);
  });
});

/**
 * The acceptance measurement for #1062: the same durable fixture assembled both
 * ways. Nothing here is a production savings claim — that needs the production
 * measurement root owns — but it is the before/after on identical input.
 */
describe("compacted memory plus delta on an identical fixture (#1062)", () => {
  const FOLDED_MESSAGES = 8;
  const UNFOLDED_MESSAGES = 2;
  const RUNS = 10;

  function fixture(): {
    state: PortableContextState;
    windowMessages: PriorMessage[];
    unfolded: PortableLedgerSource[];
    runs: PriorRun[];
  } {
    const messages: PortableLedgerSource[] = [];
    for (let i = 0; i < FOLDED_MESSAGES + UNFOLDED_MESSAGES; i++) {
      messages.push(
        inbound(
          `msg-${i}`,
          i,
          `Instruction ${i}: ${"keep the review gate and the schema gate. ".repeat(8)}`
        )
      );
    }
    const runs: PriorRun[] = [];
    for (let i = 0; i < RUNS; i++) {
      runs.push(
        run(
          `run-${i}`,
          100 + i,
          `Run ${i} outcome: ${"checked CI, posted the receipt. ".repeat(12)}`
        )
      );
    }
    const items: PortableMemoryItem[] = messages.slice(0, FOLDED_MESSAGES).map((source, i) => ({
      id: `mem-${i}`,
      kind: "decision",
      priority: "should",
      status: "active",
      statement: `Decision ${i} distilled from instruction ${i}.`,
      evidence: [{ eventId: source.id, sender: "root", ts: source.ts, quote: `Instruction ${i}:` }],
      updatedAt: source.ts,
    }));
    const state: PortableContextState = {
      ...emptyPortableContextState("actor-a"),
      generation: FOLDED_MESSAGES,
      lastFoldedSourceId: `msg-${FOLDED_MESSAGES - 1}`,
      items,
    };
    const newestFirst = [...messages].reverse();
    return {
      state,
      windowMessages: newestFirst.map((m) => ({
        id: m.id,
        ts: m.ts,
        sender: "root",
        body: m.body,
      })),
      unfolded: messages.slice(FOLDED_MESSAGES),
      runs: [...runs].reverse(),
    };
  }

  it("builds a smaller prompt from the same ledger, messages and runs", () => {
    const { state, windowMessages, unfolded, runs } = fixture();
    const window = assemblePortableContextV2({ state, messages: windowMessages, runs });
    const delta = selectDeltaJournal({ unfolded, recentRuns: runs, maxMessages: 10 });
    const after = assemblePortableContextV2({
      state,
      messages: delta.messages,
      runs: delta.runs,
      journal: {
        mode: "delta",
        foldCursor: state.lastFoldedSourceId,
        unfoldedSources: delta.unfoldedSources,
        unfoldedMessages: delta.unfoldedMessages,
        unfoldedYields: delta.unfoldedYields,
        truncated: false,
      },
    });
    if (!window || !after) throw new Error("expected both assemblies");

    // Same compacted memory on both sides: the ledger section is byte-identical.
    expect(after.record.sections?.ledger).toBe(window.record.sections?.ledger);
    expect(after.record.stateHash).toBe(window.record.stateHash);
    // The window re-sent every message the ledger already absorbed; the delta sends two.
    expect(window.record.sourceMessageEventIds).toHaveLength(FOLDED_MESSAGES + UNFOLDED_MESSAGES);
    expect(after.record.sourceMessageEventIds).toEqual(["msg-8", "msg-9"]);
    expect(after.record.sourceEventIds).toEqual(["run-9"]);
    expect(after.record.bytes).toBeLessThan(window.record.bytes);
    expect(after.record.journal).toMatchObject({ mode: "delta", unfoldedMessages: 2 });
    expect(window.record.journal).toBeUndefined();
    // Reported, not asserted to a number: the ratio depends on the fixture.
    process.stdout.write(
      `[#1062 measurement] window=${window.record.bytes}B (ledger ${window.record.sections?.ledger}, messages ${window.record.sections?.messages}, runs ${window.record.sections?.runs}) delta=${after.record.bytes}B (ledger ${after.record.sections?.ledger}, messages ${after.record.sections?.messages}, runs ${after.record.sections?.runs})\n`
    );
  });

  it("retains every ledger decision and the source refs for provenance", () => {
    const { state, unfolded, runs } = fixture();
    const delta = selectDeltaJournal({ unfolded, recentRuns: runs, maxMessages: 10 });
    const after = assemblePortableContextV2({ state, messages: delta.messages, runs: delta.runs });
    if (!after) throw new Error("expected assembly");
    for (let i = 0; i < FOLDED_MESSAGES; i++) {
      expect(after.section).toContain(`Decision ${i} distilled from instruction ${i}.`);
      expect(after.section).toContain(`Source root at ${ts(i)}`);
    }
    // The unfolded instructions are still verbatim, so nothing is lost before the fold.
    expect(after.section).toContain("Instruction 8:");
    expect(after.section).toContain("Instruction 9:");
    // Folded instruction 7 is represented by its ledger item and source ref,
    // not re-sent verbatim.
    expect(after.section).not.toContain(`Message from root at ${ts(7)}`);
  });
});
