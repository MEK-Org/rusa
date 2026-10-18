import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { type Obligation, parseExternalRef } from "../obligations/obligation.js";
import {
  assemblePortableContext,
  assemblePortableContextV2,
  composeHostContextIntoPrompt,
  PORTABLE_CONTEXT_LEDGER_MAX_BYTES,
  PORTABLE_CONTEXT_MAX_BYTES,
  PORTABLE_CONTEXT_MAX_MESSAGES,
  PORTABLE_CONTEXT_MAX_RUNS,
  PORTABLE_CONTEXT_OBLIGATIONS_MAX_BYTES,
  type PortableContext,
  type PriorRun,
  portableContextMaxMessages,
  portableContextMaxRuns,
  portableReadWindow,
} from "./portable-context.js";
import { emptyPortableContextState } from "./portable-context-state.js";

const run = (id: string, body: string | null, ts = "2026-07-08T00:00:00.000Z"): PriorRun => ({
  id,
  ts,
  body,
});

/** Assemble and assert non-null (biome forbids `!` assertions in this repo). */
function assemble(runs: PriorRun[]): PortableContext {
  const portable = assemblePortableContext(runs);
  if (!portable) throw new Error("expected portable context, got null");
  return portable;
}

describe("assemblePortableContext", () => {
  it("returns null when there are no runs", () => {
    expect(assemblePortableContext([])).toBeNull();
  });

  it("returns null when every run body is empty/whitespace", () => {
    expect(assemblePortableContext([run("a", ""), run("b", "   \n "), run("c", null)])).toBeNull();
  });

  it("renders newest-first input oldest→newest in the section", () => {
    // listEventsByActors returns newest-first; the section must read oldest-first.
    const { section, record } = assemble([run("r2", "second run"), run("r1", "first run")]);
    expect(section).toContain("## Recent activity");
    expect(section.indexOf("first run")).toBeLessThan(section.indexOf("second run"));
    // sourceEventIds mirror the rendered order (oldest→newest).
    expect(record.sourceEventIds).toEqual(["r1", "r2"]);
    expect(record.runCount).toBe(2);
  });

  it("reports a byte count and content hash consistent with the section", () => {
    const portable = assemble([run("r1", "hello world")]);
    expect(portable.record.bytes).toBe(Buffer.byteLength(portable.section, "utf8"));
    expect(portable.record.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — identical input yields an identical hash", () => {
    const input = [run("r2", "b"), run("r1", "a")];
    expect(assemble(input).record.hash).toBe(assemble(input).record.hash);
    // Different content → different hash.
    const other = assemble([run("r2", "b"), run("r1", "DIFFERENT")]);
    expect(other.record.hash).not.toBe(assemble(input).record.hash);
  });

  it("drops the oldest runs to stay under the byte cap", () => {
    const big = "x".repeat(10_000);
    // 6 * 10K bodies (~60K) exceed the 32K cap; only the newest few survive.
    const runs = Array.from({ length: 6 }, (_, i) => run(`r${i}`, big));
    const portable = assemble(runs);
    expect(portable.record.bytes).toBeLessThanOrEqual(PORTABLE_CONTEXT_MAX_BYTES);
    expect(portable.record.runCount).toBeLessThan(6);
    // The survivors are the most-recent runs (input is newest-first → r0, r1…).
    expect(portable.record.sourceEventIds).toContain("r0");
    expect(portable.record.sourceEventIds).not.toContain("r5");
  });

  it("includes a single oversized run, tail-truncated", () => {
    const huge = `HEAD-MARKER${"y".repeat(50_000)}TAIL-MARKER`;
    const portable = assemble([run("only", huge)]);
    expect(portable.record.runCount).toBe(1);
    expect(portable.record.bytes).toBeLessThanOrEqual(PORTABLE_CONTEXT_MAX_BYTES);
    // The tail (result/summary) is kept; the head is dropped.
    expect(portable.section).toContain("TAIL-MARKER");
    expect(portable.section).not.toContain("HEAD-MARKER");
    expect(portable.section).toContain("earlier output truncated");
  });
});

describe("portableContextMaxRuns (G2-v2 window override)", () => {
  const original = process.env.PORTABLE_CONTEXT_MAX_RUNS;
  afterEach(() => {
    if (original === undefined) delete process.env.PORTABLE_CONTEXT_MAX_RUNS;
    else process.env.PORTABLE_CONTEXT_MAX_RUNS = original;
  });

  it("defaults to PORTABLE_CONTEXT_MAX_RUNS when the env var is unset", () => {
    delete process.env.PORTABLE_CONTEXT_MAX_RUNS;
    expect(portableContextMaxRuns()).toBe(PORTABLE_CONTEXT_MAX_RUNS);
  });

  it("honors a positive integer override (the shrunk short-run window)", () => {
    process.env.PORTABLE_CONTEXT_MAX_RUNS = "2";
    expect(portableContextMaxRuns()).toBe(2);
  });

  it("falls back to the default on empty, zero, negative, or non-numeric values", () => {
    for (const bad of ["", "0", "-3", "abc", "2.5"]) {
      process.env.PORTABLE_CONTEXT_MAX_RUNS = bad;
      expect(portableContextMaxRuns()).toBe(PORTABLE_CONTEXT_MAX_RUNS);
    }
  });
});

describe("portableContextMaxMessages", () => {
  const original = process.env.PORTABLE_CONTEXT_MAX_MESSAGES;
  afterEach(() => {
    if (original === undefined) delete process.env.PORTABLE_CONTEXT_MAX_MESSAGES;
    else process.env.PORTABLE_CONTEXT_MAX_MESSAGES = original;
  });

  it("defaults to PORTABLE_CONTEXT_MAX_MESSAGES when the env var is unset", () => {
    delete process.env.PORTABLE_CONTEXT_MAX_MESSAGES;
    expect(portableContextMaxMessages()).toBe(PORTABLE_CONTEXT_MAX_MESSAGES);
  });

  it("honors a positive integer override", () => {
    process.env.PORTABLE_CONTEXT_MAX_MESSAGES = "1";
    expect(portableContextMaxMessages()).toBe(1);
  });

  it("falls back to the default for invalid values", () => {
    for (const bad of ["", "0", "-3", "abc", "2.5"]) {
      process.env.PORTABLE_CONTEXT_MAX_MESSAGES = bad;
      expect(portableContextMaxMessages()).toBe(PORTABLE_CONTEXT_MAX_MESSAGES);
    }
  });
});

describe("assemblePortableContextV2", () => {
  it("injects durable intent even when its source message and run have aged out", () => {
    const state = emptyPortableContextState("actor-a");
    state.generation = 3;
    state.items = [
      {
        id: "mem-airgap",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: "Run air-gapped with no new dependencies.",
        evidence: [
          {
            eventId: "old-message",
            sender: "root",
            ts: "2026-07-01T00:00:00.000Z",
            quote: "air-gapped with no new dependencies",
          },
        ],
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ];
    const portable = assemblePortableContextV2({
      state,
      messages: [
        {
          id: "new-message",
          ts: "2026-07-21T00:00:00.000Z",
          sender: "root",
          body: "Add fuzzy search.",
        },
      ],
      runs: [run("new-run", "Added a health endpoint.")],
    });
    if (!portable) throw new Error("expected v2 portable context");
    expect(portable.section).toContain("air-gapped with no new dependencies");
    expect(portable.record.stateGeneration).toBe(3);
    expect(portable.record.sourceMessageEventIds).toEqual(["new-message"]);
    expect(portable.record.sourceEventIds).toEqual(["new-run"]);
  });

  it("does not inject superseded durable items", () => {
    const state = emptyPortableContextState("actor-a");
    state.items = [
      {
        id: "old",
        kind: "constraint",
        priority: "must",
        status: "superseded",
        statement: "Never use dependencies.",
        evidence: [
          {
            eventId: "m1",
            sender: "root",
            ts: "2026-07-01T00:00:00.000Z",
            quote: "Never use dependencies",
          },
        ],
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    ];
    const portable = assemblePortableContextV2({ state, messages: [], runs: [] });
    expect(portable).toBeNull();
  });

  it("does not inject active items of a retired kind, but still injects active authorable ones (ISSUE_NUM leg 3)", () => {
    // Both items are `active`, so status is not what separates them — the kind
    // filter is. This is what retirement actually means for the prompt: the
    // retired item stays on disk and stays loadable, it just stops carrying
    // authority. Deleting it, or narrowing the persisted enum so it cannot be
    // read back, is the thing this design exists to avoid.
    const state = emptyPortableContextState("actor-a");
    const evidence = [
      { eventId: "m1", sender: "root", ts: "2026-07-01T00:00:00.000Z", quote: "either way" },
    ];
    state.items = [
      {
        id: "mem-commitment",
        kind: "commitment",
        priority: "must",
        status: "active",
        statement: "RETIRED-KIND-STATEMENT",
        evidence,
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "mem-question",
        kind: "open_question",
        priority: "must",
        status: "active",
        statement: "RETIRED-QUESTION-STATEMENT",
        evidence,
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "mem-constraint",
        kind: "constraint",
        priority: "should",
        status: "active",
        statement: "AUTHORABLE-KIND-STATEMENT",
        evidence,
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ];

    const portable = assemblePortableContextV2({ state, messages: [], runs: [] });
    if (!portable) throw new Error("expected v2 portable context");
    expect(portable.section).toContain("AUTHORABLE-KIND-STATEMENT");
    expect(portable.section).not.toContain("RETIRED-KIND-STATEMENT");
    expect(portable.section).not.toContain("RETIRED-QUESTION-STATEMENT");
    // The retired items are still in the loaded state that produced this
    // section — they were filtered out of the render, not absent from the data.
    expect(state.items).toHaveLength(3);
  });

  it("emits no durable-intent section at all when every active item is a retired kind (ISSUE_NUM leg 3)", () => {
    // The largest live exposure is an actor whose active items are almost all
    // retired kinds. It must degrade to "no ledger section", not to an empty
    // heading with nothing under it and not to a throw.
    const state = emptyPortableContextState("actor-a");
    state.items = [
      {
        id: "mem-commitment",
        kind: "commitment",
        priority: "must",
        status: "active",
        statement: "Ship the thing.",
        evidence: [
          { eventId: "m1", sender: "root", ts: "2026-07-01T00:00:00.000Z", quote: "Ship the" },
        ],
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ];

    expect(assemblePortableContextV2({ state, messages: [], runs: [] })).toBeNull();

    // Counter-assertion: the actor is not silenced, only its retired items are.
    // A live message alongside them still assembles a section, with no stray
    // heading for the ledger that rendered nothing.
    const withMessage = assemblePortableContextV2({
      state,
      messages: [
        { id: "m2", ts: "2026-07-21T00:00:00.000Z", sender: "root", body: "Add fuzzy search." },
      ],
      runs: [],
    });
    if (!withMessage) throw new Error("expected v2 portable context");
    expect(withMessage.section).toContain("Add fuzzy search.");
    expect(withMessage.section).not.toContain("Durable intent");
  });

  it("bounds the whole rendered ledger line, not just the statement inside it", () => {
    // The evidence quote is appended after the statement by `renderItem` and has
    // no length cap of its own — it only has to be a verbatim substring of a mesh
    // event body. Truncating the statement to a fixed `budget - 200` reserve
    // therefore bounds nothing here: the section overruns, and at this size it
    // takes the whole prompt past PORTABLE_CONTEXT_MAX_BYTES, which
    // `assemblePortableContextV2` raises as a throw inside `buildPrompt` — the
    // owning actor cannot start. Same shape as ISSUE_NUM, one renderer over.
    const state = emptyPortableContextState("actor-a");
    state.items = [
      {
        id: "mem-1",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: "s".repeat(PORTABLE_CONTEXT_LEDGER_MAX_BYTES),
        evidence: [
          {
            eventId: "m1",
            sender: "root",
            ts: "2026-07-01T00:00:00.000Z",
            quote: "q".repeat(PORTABLE_CONTEXT_MAX_BYTES + 5_000),
          },
        ],
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ];

    const portable = assemblePortableContextV2({ state, messages: [], runs: [] });
    if (!portable) throw new Error("expected v2 portable context");
    const start = portable.section.indexOf("### Durable intent");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(Buffer.byteLength(portable.section.slice(start), "utf8")).toBeLessThanOrEqual(
      PORTABLE_CONTEXT_LEDGER_MAX_BYTES
    );
    // Bounding the assembled line keeps the cut visible: `headToBytes` appends
    // its marker after cutting, so the actor can still tell its memory was
    // truncated rather than quietly rewritten.
    expect(portable.section).toContain("[MUST] [constraint]");
  });

  it("keeps the combined v2 prompt under the existing byte ceiling", () => {
    const portable = assemblePortableContextV2({
      state: emptyPortableContextState("actor-a"),
      messages: [
        { id: "m1", ts: "2026-07-21T00:00:00.000Z", sender: "root", body: "m".repeat(20_000) },
      ],
      runs: [run("r1", "r".repeat(50_000))],
    });
    if (!portable) throw new Error("expected v2 portable context");
    expect(portable.record.bytes).toBeLessThanOrEqual(PORTABLE_CONTEXT_MAX_BYTES);
  });

  it("degrades gracefully rather than throwing when active ledger exceeds 16,000B ceiling ", () => {
    const state = emptyPortableContextState("actor-a");
    // Create items exceeding 16,000 bytes
    state.items = [
      {
        id: "c-must",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: "M".repeat(5_000),
        evidence: [
          { eventId: "m1", sender: "root", ts: "2026-08-01T00:00:00.000Z", quote: "quote" },
        ],
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "c-should",
        kind: "constraint",
        priority: "should",
        status: "active",
        statement: "S".repeat(7_000),
        evidence: [
          { eventId: "m2", sender: "root", ts: "2026-08-01T00:00:00.000Z", quote: "quote" },
        ],
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "c-background",
        kind: "constraint",
        priority: "background",
        status: "active",
        statement: "B".repeat(8_000),
        evidence: [
          { eventId: "m3", sender: "root", ts: "2026-08-01T00:00:00.000Z", quote: "quote" },
        ],
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ];

    // Previously this would throw: `portable context durable ledger exceeds 16000 bytes`
    // Now it should degrade gracefully by dropping lowest-priority items to fit.
    const portable = assemblePortableContextV2({ state, messages: [], runs: [] });
    expect(portable).not.toBeNull();
    if (!portable) throw new Error("expected portable context");
    expect(portable.record.sections?.ledger).toBeLessThanOrEqual(16_000);
    expect(portable.section).toContain("M".repeat(5_000));
    expect(portable.section).not.toContain("B".repeat(8_000));
  });

  it("retains newest-first rulings when an overflowing must tier exceeds the byte budget (#328)", () => {
    const state = emptyPortableContextState("actor-a");
    // Create several active must items dated across time that together exceed 16,000 bytes.
    // The oldest item was recorded earlier; the newest item is recorded recently.
    state.items = [
      {
        id: "must-old-1",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: `Old ruling 1 from August: ${"1".repeat(6_000)}`,
        evidence: [
          { eventId: "e1", sender: "root", ts: "2026-08-25T10:00:00.000Z", quote: "old 1" },
        ],
        updatedAt: "2026-08-25T10:00:00.000Z",
      },
      {
        id: "must-old-2",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: `Old ruling 2 from August: ${"2".repeat(6_000)}`,
        evidence: [
          { eventId: "e2", sender: "root", ts: "2026-08-26T10:00:00.000Z", quote: "old 2" },
        ],
        updatedAt: "2026-08-26T10:00:00.000Z",
      },
      {
        id: "must-recent-3",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: `Recent ruling 3 from September: ${"3".repeat(6_000)}`,
        evidence: [
          { eventId: "e3", sender: "root", ts: "2026-09-07T12:00:00.000Z", quote: "recent 3" },
        ],
        updatedAt: "2026-09-07T12:00:00.000Z",
      },
    ];

    const portable = assemblePortableContextV2({ state, messages: [], runs: [] });
    expect(portable).not.toBeNull();
    if (!portable) throw new Error("expected portable context");

    // Under #328, newest-first within the must tier ensures the September ruling is retained,
    // and older rulings that overflow the 16KB budget are dropped.
    // The pre-fix bug keeps a fixed slab of the oldest items (must-old-1 and must-old-2), dropping must-recent-3.
    expect(portable.section).toContain("Recent ruling 3 from September");
    expect(portable.section).not.toContain("Old ruling 1 from August");

    // Omission marker and overflow metrics are observable via canonical record.ledger
    expect(portable.section).toContain("… [1 active item omitted due to budget]");
    const metrics = portable.record.ledger;
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("expected ledger metrics");

    expect(metrics.active).toBe(3);
    expect(metrics.selected).toBe(2);
    expect(metrics.dropped).toBe(1);
    expect(metrics.droppedByPriority).toEqual({ must: 1, should: 0, background: 0 });
    expect(metrics.minSelectedEvidenceTs).toBe("2026-08-26T10:00:00.000Z");
    expect(metrics.maxSelectedEvidenceTs).toBe("2026-09-07T12:00:00.000Z");
    expect(metrics.minDroppedEvidenceTs).toBe("2026-08-25T10:00:00.000Z");
    expect(metrics.maxDroppedEvidenceTs).toBe("2026-08-25T10:00:00.000Z");
  });

  it("preserves priority tier dominance so older must items precede newer should items (#328)", () => {
    const state = emptyPortableContextState("actor-a");
    state.items = [
      {
        id: "must-old",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: `Old must item from August: ${"M".repeat(9_000)}`,
        evidence: [
          { eventId: "e1", sender: "root", ts: "2026-08-01T10:00:00.000Z", quote: "must" },
        ],
        updatedAt: "2026-08-01T10:00:00.000Z",
      },
      {
        id: "should-recent",
        kind: "constraint",
        priority: "should",
        status: "active",
        statement: `Recent should item from September: ${"S".repeat(9_000)}`,
        evidence: [
          { eventId: "e2", sender: "root", ts: "2026-09-15T10:00:00.000Z", quote: "should" },
        ],
        updatedAt: "2026-09-15T10:00:00.000Z",
      },
    ];

    const portable = assemblePortableContextV2({ state, messages: [], runs: [] });
    expect(portable).not.toBeNull();
    if (!portable) throw new Error("expected portable context");

    // Priority tier dominance: 'must' > 'should' regardless of timestamp
    expect(portable.section).toContain("Old must item from August");
    expect(portable.section).not.toContain("Recent should item from September");
    expect(portable.section).toContain("… [1 active item omitted due to budget]");

    const metrics = portable.record.ledger;
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("expected ledger metrics");

    expect(metrics.active).toBe(2);
    expect(metrics.selected).toBe(1);
    expect(metrics.dropped).toBe(1);
    expect(metrics.droppedByPriority).toEqual({ must: 0, should: 1, background: 0 });
    expect(metrics.minSelectedEvidenceTs).toBe("2026-08-01T10:00:00.000Z");
    expect(metrics.maxSelectedEvidenceTs).toBe("2026-08-01T10:00:00.000Z");
    expect(metrics.minDroppedEvidenceTs).toBe("2026-09-15T10:00:00.000Z");
    expect(metrics.maxDroppedEvidenceTs).toBe("2026-09-15T10:00:00.000Z");
  });

  it("evaluates recency using newest evidence timestamp when item is re-evidenced (#328)", () => {
    const state = emptyPortableContextState("actor-a");
    // Item A was created early August, but re-evidenced in late September.
    // Item B was created late August with no newer evidence.
    state.items = [
      {
        id: "item-a-re-evidenced",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: `Item A re-evidenced: ${"A".repeat(8_500)}`,
        evidence: [
          { eventId: "e1", sender: "root", ts: "2026-08-01T10:00:00.000Z", quote: "orig" },
          { eventId: "e3", sender: "root", ts: "2026-09-25T10:00:00.000Z", quote: "re-affirmed" },
        ],
        updatedAt: "2026-08-01T10:00:00.000Z",
      },
      {
        id: "item-b-intermediate",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: `Item B intermediate: ${"B".repeat(8_500)}`,
        evidence: [
          { eventId: "e2", sender: "root", ts: "2026-08-20T10:00:00.000Z", quote: "intermediate" },
        ],
        updatedAt: "2026-08-20T10:00:00.000Z",
      },
    ];

    const portable = assemblePortableContextV2({ state, messages: [], runs: [] });
    expect(portable).not.toBeNull();
    if (!portable) throw new Error("expected portable context");

    // Item A's newest evidence timestamp (2026-09-25) is newer than Item B (2026-08-20)
    expect(portable.section).toContain("Item A re-evidenced");
    expect(portable.section).not.toContain("Item B intermediate");
    expect(portable.section).toContain("… [1 active item omitted due to budget]");
  });

  it("breaks recency ties deterministically using original index descending (#328)", () => {
    const state = emptyPortableContextState("actor-a");
    // Both items have identical evidence timestamps and same priority
    state.items = [
      {
        id: "item-first",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: `Item first in array: ${"1".repeat(9_000)}`,
        evidence: [{ eventId: "e1", sender: "root", ts: "2026-09-01T12:00:00.000Z", quote: "q" }],
        updatedAt: "2026-09-01T12:00:00.000Z",
      },
      {
        id: "item-second",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: `Item second in array: ${"2".repeat(9_000)}`,
        evidence: [{ eventId: "e2", sender: "root", ts: "2026-09-01T12:00:00.000Z", quote: "q" }],
        updatedAt: "2026-09-01T12:00:00.000Z",
      },
    ];

    const portable = assemblePortableContextV2({ state, messages: [], runs: [] });
    expect(portable).not.toBeNull();
    if (!portable) throw new Error("expected portable context");

    // On tie, later originalIndex (item-second) is selected first
    expect(portable.section).toContain("Item second in array");
    expect(portable.section).not.toContain("Item first in array");
  });

  it("ignores non-ISO 8601 evidence timestamps and falls back to valid updatedAt (#328)", () => {
    const state = emptyPortableContextState("actor-a");
    // Item 1 has a non-ISO date string ("09/01/2026") in evidence that Date.parse would loosely parse as Sept 1,
    // but strict ISO 8601 rejects it, falling back to updatedAt: Aug 10.
    // Item 2 has a valid ISO 8601 timestamp in evidence: Aug 20.
    state.items = [
      {
        id: "item-non-iso",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: `Item non-ISO: ${"1".repeat(9_000)}`,
        evidence: [{ eventId: "e1", sender: "root", ts: "09/01/2026", quote: "loose" }],
        updatedAt: "2026-08-10T12:00:00.000Z",
      },
      {
        id: "item-valid-iso",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: `Item valid-ISO: ${"2".repeat(9_000)}`,
        evidence: [
          { eventId: "e2", sender: "root", ts: "2026-08-20T12:00:00.000Z", quote: "strict" },
        ],
        updatedAt: "2026-08-20T12:00:00.000Z",
      },
    ];

    const portable = assemblePortableContextV2({ state, messages: [], runs: [] });
    expect(portable).not.toBeNull();
    if (!portable) throw new Error("expected portable context");

    // Because "09/01/2026" is rejected as non-ISO, item-non-iso uses updatedAt (Aug 10),
    // and item-valid-iso (Aug 20) is correctly selected as the newer ruling.
    expect(portable.section).toContain("Item valid-ISO");
    expect(portable.section).not.toContain("Item non-ISO");
  });

  it("strictly enforces 16,000B ledger limit with omission marker and renders stable original order (#328)", () => {
    const state = emptyPortableContextState("actor-a");
    // 20 items of ~1,000 bytes each (total ~20KB) across various dates
    state.items = Array.from({ length: 20 }, (_, idx) => ({
      id: `item-${idx}`,
      kind: "constraint" as const,
      priority: "must" as const,
      status: "active" as const,
      statement: `Ruling index ${idx} with content: ${"x".repeat(900)}`,
      evidence: [
        {
          eventId: `e-${idx}`,
          sender: "root",
          ts: `2026-08-${String(idx + 1).padStart(2, "0")}T00:00:00.000Z`,
          quote: `q-${idx}`,
        },
      ],
      updatedAt: `2026-08-${String(idx + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));

    const portable = assemblePortableContextV2({ state, messages: [], runs: [] });
    expect(portable).not.toBeNull();
    if (!portable) throw new Error("expected portable context");

    const ledgerBytes = portable.record.sections?.ledger;
    expect(ledgerBytes).toBeDefined();
    expect(ledgerBytes).toBeLessThanOrEqual(PORTABLE_CONTEXT_LEDGER_MAX_BYTES);

    const metrics = portable.record.ledger;
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("expected ledger metrics");

    // Invariants
    expect(metrics.active).toBe(20);
    expect(metrics.selected + metrics.dropped).toBe(metrics.active);
    expect(
      metrics.droppedByPriority.must +
        metrics.droppedByPriority.should +
        metrics.droppedByPriority.background
    ).toBe(metrics.dropped);
    expect(metrics.dropped).toBeGreaterThan(0);

    // Omission marker matches dropped count exactly
    expect(portable.section).toContain(`… [${metrics.dropped} active items omitted due to budget]`);

    // Selected items are observed directly in their rendered order in section
    const lines = portable.section.split("\n");
    const indicesInOutput = lines
      .map((line) => {
        const match = line.match(/Ruling index (\d+) with content/);
        return match ? Number(match[1]) : null;
      })
      .filter((n): n is number => n !== null);

    expect(indicesInOutput.length).toBe(metrics.selected);
    const sortedIndices = [...indicesInOutput].sort((a, b) => a - b);
    expect(indicesInOutput).toEqual(sortedIndices);
  });

  it("bounds multibyte oversized truncation and omission marker within 16,000 bytes (#328)", () => {
    const state = emptyPortableContextState("actor-a");
    // One oversized item with multibyte characters (>16KB alone) plus a second active item
    state.items = [
      {
        id: "must-multibyte-oversized",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: `Oversized ruling: ${"🚀".repeat(5_000)}`,
        evidence: [{ eventId: "e1", sender: "root", ts: "2026-09-01T00:00:00.000Z", quote: "🚀" }],
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "must-dropped",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: "Second ruling dropped",
        evidence: [
          { eventId: "e2", sender: "root", ts: "2026-08-01T00:00:00.000Z", quote: "drop" },
        ],
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ];

    const portable = assemblePortableContextV2({ state, messages: [], runs: [] });
    expect(portable).not.toBeNull();
    if (!portable) throw new Error("expected portable context");

    const ledgerBytes = portable.record.sections?.ledger;
    expect(ledgerBytes).toBeDefined();
    expect(ledgerBytes).toBeLessThanOrEqual(PORTABLE_CONTEXT_LEDGER_MAX_BYTES);

    const metrics = portable.record.ledger;
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("expected ledger metrics");

    expect(metrics.active).toBe(2);
    expect(metrics.selected).toBe(1);
    expect(metrics.dropped).toBe(1);
    expect(portable.section).toContain("… [1 active item omitted due to budget]");
  });

  it("reports zero dropped metrics and null dropped evidence timestamps when ledger fits budget (#328)", () => {
    const state = emptyPortableContextState("actor-a");
    state.items = [
      {
        id: "small-1",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: "Small ruling 1",
        evidence: [{ eventId: "e1", sender: "root", ts: "2026-09-01T00:00:00.000Z", quote: "q1" }],
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "small-2",
        kind: "constraint",
        priority: "should",
        status: "active",
        statement: "Small ruling 2",
        evidence: [{ eventId: "e2", sender: "root", ts: "2026-09-02T00:00:00.000Z", quote: "q2" }],
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
    ];

    const portable = assemblePortableContextV2({ state, messages: [], runs: [] });
    expect(portable).not.toBeNull();
    if (!portable) throw new Error("expected portable context");

    const metrics = portable.record.ledger;
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("expected ledger metrics");

    expect(metrics.active).toBe(2);
    expect(metrics.selected).toBe(2);
    expect(metrics.dropped).toBe(0);
    expect(metrics.droppedByPriority).toEqual({ must: 0, should: 0, background: 0 });
    expect(metrics.minSelectedEvidenceTs).toBe("2026-09-01T00:00:00.000Z");
    expect(metrics.maxSelectedEvidenceTs).toBe("2026-09-02T00:00:00.000Z");
    expect(metrics.minDroppedEvidenceTs).toBeNull();
    expect(metrics.maxDroppedEvidenceTs).toBeNull();
    expect(portable.section).not.toContain("omitted due to budget");
  });

  it("renders originating evidence (evidence[0]) as Source so re-evidencing does not misattribute issuer (§4 / ISSUE_NUM)", () => {
    const state = emptyPortableContextState("actor-a");
    state.items = [
      {
        id: "c1",
        kind: "constraint",
        priority: "must",
        status: "active",
        statement: "Must operate in read-only mode.",
        evidence: [
          {
            eventId: "m1",
            sender: "root-authority",
            ts: "2026-08-01T00:00:00.000Z",
            quote: "Must operate in read-only mode",
          },
          {
            eventId: "y1",
            sender: "actor-a",
            ts: "2026-08-01T01:00:00.000Z",
            quote: "read-only mode observed",
          },
        ],
        updatedAt: "2026-08-01T01:00:00.000Z",
      },
    ];

    const portable = assemblePortableContextV2({ state, messages: [], runs: [] });
    if (!portable) throw new Error("expected portable context");
    expect(portable.section).toContain("Source root-authority at 2026-08-01T00:00:00.000Z");
    expect(portable.section).not.toContain("Source actor-a");
  });
});

describe("obligation projection (ISSUE_NUM, ratified in ISSUE_NUM comment 5369843998)", () => {
  const obligation = (
    id: string,
    status: "ready" | "waiting" | "scheduled",
    intent: string,
    priority = 1,
    externalRef: Obligation["externalRef"] = null,
    nextReadyAt: string | null = null,
    checkpoint: string | null = null
  ): Obligation => ({
    id,
    parentId: null,
    ownerId: "actor-a",
    title: intent,
    intent,
    externalRef,
    status,
    priority,
    effectivePriority: priority,
    prioritySourceId: id,
    responsive: null,
    effectiveResponsive: false,
    readyCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    creatorId: "actor-a",
    terminalNote: null,
    resolutionRef: null,
    recurrencePolicy: status === "scheduled" ? "cron" : null,
    recurrenceCron: status === "scheduled" ? "0 * * * *" : null,
    recurrenceIntervalSeconds: null,
    nextReadyAt: status === "scheduled" ? (nextReadyAt ?? "2026-08-02T00:00:00.000Z") : null,
    snoozedUntil: null,
    checkpoint,
    checkpointAt: checkpoint == null ? null : "2026-09-07T12:00:00.000Z",
    checkpointBy: checkpoint == null ? null : "actor-a",
    completionMatcher: null,
    hasCompletionHistory: false,
  });

  const OBLIGATIONS_HEADING = "### Your obligations (system of record)";

  /** Bytes of the obligations section alone — the budget this ceiling governs. */
  const obligationsSectionBytes = (section: string): number => {
    const start = section.indexOf(OBLIGATIONS_HEADING);
    expect(start).toBeGreaterThanOrEqual(0);
    return Buffer.byteLength(section.slice(start), "utf8");
  };

  /** Store queue order: ready before waiting, then ascending effective priority. */
  const project = (obligations: Obligation[]): string =>
    assemblePortableContextV2({
      state: emptyPortableContextState("actor-a"),
      messages: [],
      runs: [],
      obligations,
    })?.section ?? "";

  it("renders ready obligations first, in the store's priority order", () => {
    const section = project([
      obligation("ob-first", "ready", "Highest priority work", 1),
      obligation("ob-second", "ready", "Lower priority work", 2),
      obligation("ob-waiting", "waiting", "Blocked work", 3),
    ]);
    expect(section.indexOf("ob-first")).toBeLessThan(section.indexOf("ob-second"));
    expect(section.indexOf("ob-second")).toBeLessThan(section.indexOf("ob-waiting"));
    // A waiting obligation is a reference, not a work item: it carries no intent,
    // so it cannot be mistaken for something to pick up.
    expect(section).toContain("[WAITING] ob-waiting");
    expect(section).not.toContain("Blocked work");
    expect(section).toContain("[READY] ob-first");
  });

  it("marks snoozed obligations so a wake reads them as deliberately deferred (#722)", () => {
    const until = "2026-10-05T09:00:00.000Z";
    const section = project([
      obligation("ob-now", "ready", "Actionable work", 1),
      { ...obligation("ob-later", "ready", "Deferred work", 2), snoozedUntil: until },
      { ...obligation("ob-gate", "waiting", "Blocked work", 3), snoozedUntil: until },
      { ...obligation("ob-cycle", "scheduled", "Recurring work", 4), snoozedUntil: until },
    ]);
    expect(section).toContain("[READY] ob-now: Actionable work");
    expect(section).toContain(`[READY] ob-later [snoozed until ${until}]: Deferred work`);
    expect(section).toContain(`[WAITING] ob-gate [snoozed until ${until}]`);
    expect(section).toContain(
      `[SCHEDULED] ob-cycle returns at 2026-08-02T00:00:00.000Z [snoozed until ${until}]`
    );
  });

  it("puts a ready obligation's current standing into its automatic wake context", () => {
    const section = project([
      obligation(
        "ob-checkpoint",
        "ready",
        "Finish the checkpoint implementation",
        1,
        null,
        null,
        "head 0f8372e; skeptic review in flight; next: answer inline questions"
      ),
    ]);

    expect(section).toContain("[READY] ob-checkpoint");
    expect(section).toContain(
      "Current standing: head 0f8372e; skeptic review in flight; next: answer inline questions"
    );
  });

  it("cuts ready obligations by priority and never skips ahead to a smaller one", () => {
    // Big enough that two fit and three do not, with the last one small enough
    // that a naive best-fit packer would seat it in the leftover room.
    // ~60% of the budget each: ob-1 fits, ob-2 does not, and the room ob-2
    // leaves behind is more than enough for ob-3.
    const filler = "x".repeat(Math.floor(PORTABLE_CONTEXT_OBLIGATIONS_MAX_BYTES * 0.6));
    const section = project([
      obligation("ob-1", "ready", filler, 1),
      obligation("ob-2", "ready", filler, 2),
      obligation("ob-3", "ready", "tiny", 3),
    ]);

    expect(section).toContain("ob-1");
    // ob-2 is cut: it is genuinely too big for the room left.
    expect(section).not.toContain("ob-2");
    // The inversion this guards: ob-3 *would* fit in what ob-2 left behind, but
    // seating it would put lower-priority work in the prompt while the
    // higher-priority ob-2 is absent. Selection stops at the cut.
    expect(section).not.toContain("ob-3");
  });

  it("omits waiting references entirely when any ready obligation was cut", () => {
    const filler = "x".repeat(PORTABLE_CONTEXT_OBLIGATIONS_MAX_BYTES - 500);
    const section = project([
      obligation("ob-big", "ready", filler, 1),
      obligation("ob-cut", "ready", "x".repeat(2_000), 2),
      obligation("ob-waiting", "waiting", "Blocked", 3),
    ]);

    expect(section).toContain("ob-big");
    expect(section).not.toContain("ob-cut");
    // Room remains — a waiting ref is ~40 bytes — but it is only there because a
    // ready obligation was cut, so it is not room the rule allows spending.
    expect(section).not.toContain("ob-waiting");
  });

  it("includes waiting references once every ready obligation fits", () => {
    // Counter-assertion to the test above: the waiting section is reachable, so
    // "no waiting refs" is a decision the rule made and not a dead branch.
    const section = project([
      obligation("ob-1", "ready", "Small ready item", 1),
      obligation("ob-waiting-a", "waiting", "Blocked A", 2),
      obligation("ob-waiting-b", "waiting", "Blocked B", 3),
    ]);
    expect(section).toContain("[READY] ob-1");
    expect(section).toContain("[WAITING] ob-waiting-a");
    expect(section).toContain("[WAITING] ob-waiting-b");
  });

  it("truncates a single oversized ready obligation rather than dropping it", () => {
    const section = project([
      obligation("ob-huge", "ready", "y".repeat(PORTABLE_CONTEXT_OBLIGATIONS_MAX_BYTES * 2), 1),
    ]);
    // The actor's most urgent work must not be invisible because it is verbose.
    expect(section).toContain("ob-huge");
    expect(section).toContain("[message truncated after byte budget]");
  });

  it("stays within its own byte ceiling and does not starve the rest of the prompt", () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      obligation(`ob-${index}`, "ready", `Work item ${index} `.repeat(20), index + 1)
    );
    expect(obligationsSectionBytes(project(many))).toBeLessThanOrEqual(
      PORTABLE_CONTEXT_OBLIGATIONS_MAX_BYTES
    );
  });

  // The truncation fallback is where the ceiling is easiest to lose, because the
  // part it shortens (the intent) is not the only part that can be long. Both
  // fixtures below are built through `parseExternalRef`, so they are refs the
  // obligation store would actually accept and persist — not shapes only a test
  // can make.
  it("bounds the whole line, not just the intent (max-size GitHub ref)", () => {
    // GitHub's own maxima: 39-character owner, 100-character repository.
    const ref = parseExternalRef(`github:${"o".repeat(39)}/${"r".repeat(100)}/issues/1`);
    const section = project([
      obligation(
        "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
        "ready",
        "z".repeat(PORTABLE_CONTEXT_OBLIGATIONS_MAX_BYTES * 2),
        1,
        ref
      ),
    ]);
    expect(section).toContain("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(obligationsSectionBytes(section)).toBeLessThanOrEqual(
      PORTABLE_CONTEXT_OBLIGATIONS_MAX_BYTES
    );
  });

  it("bounds a ref larger than the whole section instead of throwing the prompt assert", () => {
    // Defense in depth: `parseExternalRef` rejects owner > 39 and repo > 100, but if
    // an oversized ref were ever held in memory past the whole 32KB fixed-section ceiling,
    // the prompt assembler must still bound the line and not throw.
    const vastOwner = "o".repeat(PORTABLE_CONTEXT_MAX_BYTES + 1_000);
    const ref: Obligation["externalRef"] = {
      scheme: "github",
      segments: [vastOwner, "repo", "pulls", "7"],
      key: `github:${vastOwner}/repo/pulls/7`,
    };
    const section = project([obligation("ob-vast-ref", "ready", "Work", 1, ref)]);
    expect(obligationsSectionBytes(section)).toBeLessThanOrEqual(
      PORTABLE_CONTEXT_OBLIGATIONS_MAX_BYTES
    );
    // Counter-assertion: the whole prompt still assembles, rather than the
    // section being silently dropped to keep the ceiling.
    expect(section).toContain(OBLIGATIONS_HEADING);
  });

  it("renders nothing when the actor holds no obligations", () => {
    expect(
      assemblePortableContextV2({
        state: emptyPortableContextState("actor-a"),
        messages: [],
        runs: [],
        obligations: [],
      })
    ).toBeNull();
  });

  describe("scheduled obligations", () => {
    it("renders scheduled obligations after ready and waiting, with their next-ready time", () => {
      const section = project([
        obligation("ob-ready", "ready", "Active work", 1),
        obligation("ob-waiting", "waiting", "Blocked work", 2),
        obligation(
          "ob-scheduled",
          "scheduled",
          "Recurring work",
          3,
          null,
          "2026-09-05T12:00:00.000Z"
        ),
      ]);
      expect(section.indexOf("ob-ready")).toBeLessThan(section.indexOf("ob-waiting"));
      expect(section.indexOf("ob-waiting")).toBeLessThan(section.indexOf("ob-scheduled"));
      expect(section).toContain("[SCHEDULED] ob-scheduled");
      expect(section).toContain("returns at 2026-09-05T12:00:00.000Z");
    });

    it("never shows a scheduled obligation's intent — it must not look actionable", () => {
      const section = project([
        obligation("ob-scheduled", "scheduled", "Do not surface this as work", 1),
      ]);
      expect(section).toContain("[SCHEDULED] ob-scheduled");
      expect(section).not.toContain("Do not surface this as work");
    });

    it("omits scheduled references entirely when any ready obligation was cut", () => {
      const filler = "x".repeat(PORTABLE_CONTEXT_OBLIGATIONS_MAX_BYTES - 500);
      const section = project([
        obligation("ob-big", "ready", filler, 1),
        obligation("ob-cut", "ready", "x".repeat(2_000), 2),
        obligation("ob-scheduled", "scheduled", "Recurring", 3),
      ]);
      expect(section).toContain("ob-big");
      expect(section).not.toContain("ob-cut");
      expect(section).not.toContain("ob-scheduled");
    });

    it("includes scheduled references once every ready obligation fits", () => {
      const section = project([
        obligation("ob-1", "ready", "Small ready item", 1),
        obligation("ob-scheduled", "scheduled", "Recurring", 2),
      ]);
      expect(section).toContain("[READY] ob-1");
      expect(section).toContain("[SCHEDULED] ob-scheduled");
    });

    it("stays within its own byte ceiling with many scheduled references", () => {
      const many = Array.from({ length: 200 }, (_, index) =>
        obligation(`ob-${index}`, "scheduled", `Work item ${index} `.repeat(20), index + 1)
      );
      expect(obligationsSectionBytes(project(many))).toBeLessThanOrEqual(
        PORTABLE_CONTEXT_OBLIGATIONS_MAX_BYTES
      );
    });
  });

  describe("composeHostContextIntoPrompt", () => {
    /** A leader prompt in the worker layout: instructions, charter, its own section, trailer. */
    const leaderPrompt = (charter: string, leaderSection?: string) =>
      [
        "# Leader instructions and tools",
        "",
        "---",
        "## Your charter",
        "",
        charter,
        ...(leaderSection ? ["", "---", leaderSection.trim()] : []),
        "",
        "Begin by listing work from the durable inbox.",
      ].join("\n");
    const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

    it("returns the leader prompt unchanged when every host run is already represented", () => {
      const basePrompt = leaderPrompt("Do work.");
      expect(
        composeHostContextIntoPrompt({ basePrompt, localRuns: [], leaderReadRunIds: [] })
      ).toEqual({ prompt: basePrompt, portable: null });
      expect(
        composeHostContextIntoPrompt({
          basePrompt,
          localRuns: [run("run-1", "Run 1 output")],
          leaderReadRunIds: ["run-1"],
        })
      ).toEqual({ prompt: basePrompt, portable: null });
    });

    it("does not re-add a run the leader rendered truncated, identified by run id (#1024)", () => {
      // The leader's own assembler tail-truncates a run larger than the budget;
      // its inject record still names the run, before and independent of that.
      const large = run(
        "run-large",
        `Opening analysis ${"x".repeat(PORTABLE_CONTEXT_MAX_BYTES)} closing summary`,
        "2026-10-18T08:00:00.000Z"
      );
      const leader = assemble([large]);
      expect(leader.record.sourceEventIds).toEqual(["run-large"]);
      const basePrompt = leaderPrompt("Do work.", leader.section);
      expect(basePrompt).not.toContain(large.body ?? "");

      const res = composeHostContextIntoPrompt({
        basePrompt,
        localRuns: [large],
        leaderReadRunIds: portableReadWindow([large]),
      });

      expect(res).toEqual({ prompt: basePrompt, portable: null });
      expect(count(res.prompt, "### Run 2026-10-18T08:00:00.000Z")).toBe(1);
    });

    it("adds a genuinely local prior run exactly once, within the portable budget (#1024)", () => {
      const shared = run(
        "run-shared",
        "Run executed here and admitted by the leader",
        "2026-10-18T07:00:00.000Z"
      );
      const local = run(
        "run-local",
        "Run whose terminal has not reached the leader",
        "2026-10-18T08:00:00.000Z"
      );
      const leader = assemble([shared]);
      const basePrompt = leaderPrompt("Do work.", leader.section);

      const res = composeHostContextIntoPrompt({
        basePrompt,
        // Newest first, as listRecentCompleted returns them.
        localRuns: [local, shared],
        leaderReadRunIds: portableReadWindow([shared]),
      });
      if (!res.portable) throw new Error("expected a host contribution");

      expect(res.prompt.startsWith(basePrompt)).toBe(true);
      expect(res.prompt.slice(basePrompt.length)).toBe(`\n\n---\n${res.portable.section}`);
      expect(count(res.prompt, shared.body ?? "")).toBe(1);
      expect(count(res.prompt, local.body ?? "")).toBe(1);
      expect(res.portable.record.sourceEventIds).toEqual(["run-local"]);
      expect(res.portable.record.bytes).toBe(Buffer.byteLength(res.portable.section, "utf8"));

      // Many large host runs stay inside the same bound.
      const many = Array.from({ length: 30 }, (_, index) =>
        run(
          `run-${index}`,
          `Host run ${index} ${"漢".repeat(4_000)}`,
          `2026-10-18T0${index % 10}:00:00.000Z`
        )
      );
      const bounded = composeHostContextIntoPrompt({
        basePrompt,
        localRuns: many,
        leaderReadRunIds: [],
      });
      if (!bounded.portable) throw new Error("expected a host contribution");
      expect(bounded.portable.record.bytes).toBeLessThanOrEqual(PORTABLE_CONTEXT_MAX_BYTES);
      expect(bounded.portable.record.hash).toBe(
        createHash("sha256").update(bounded.portable.section, "utf8").digest("hex")
      );
    });

    it("composes identically whatever the charter or leader run text says (#1024)", () => {
      const local = run("run-local", "Local findings to keep", "2026-10-18T08:00:00.000Z");
      // A leader run body with its own markdown structure, as real run outputs have.
      const leaderRun = run(
        "run-leader",
        "Summary\n\n## Findings\n\n---\n\n# Next action\nShip it.",
        "2026-10-18T07:00:00.000Z"
      );
      const leader = assemble([leaderRun]);
      const charters = [
        "Work on tasks.",
        // Reworded, with headings, rules, the trailer phrase and the local run's text.
        "## Mission\n\n---\nLocal findings to keep\n## Recent activity\nBegin by listing work from the durable inbox.",
      ];
      const results = charters.map((charter) => {
        const basePrompt = leaderPrompt(charter, leader.section);
        const res = composeHostContextIntoPrompt({
          basePrompt,
          localRuns: [local],
          leaderReadRunIds: portableReadWindow([leaderRun]),
        });
        if (!res.portable) throw new Error("expected a host contribution");
        // The leader prompt, including its whole section, is the untouched prefix.
        expect(res.prompt.startsWith(basePrompt)).toBe(true);
        expect(res.prompt).toContain(leader.section.trim());
        return { suffix: res.prompt.slice(basePrompt.length), record: res.portable.record };
      });
      expect(results[1]).toEqual(results[0]);
    });

    describe("host runs the leader read but did not render (#1024)", () => {
      /**
       * The follower's composition, called as actor-runtime's buildPrompt calls
       * it: `leaderRead` is the newest-first list the leader assembled from.
       */
      const followerCompose = (
        leaderRead: PriorRun[],
        leader: PortableContext | null,
        hostRuns: PriorRun[]
      ) => {
        const basePrompt = leaderPrompt("Do work.", leader?.section);
        return {
          basePrompt,
          ...composeHostContextIntoPrompt({
            basePrompt,
            localRuns: hostRuns,
            leaderReadRunIds: portableReadWindow(leaderRead),
          }),
        };
      };
      /** A run whose closing token survives tail truncation. */
      const sized = (id: string, ts: string, bytes: number) =>
        run(id, `${id} opening ${"x".repeat(bytes)} END-${id}`, ts);

      it("appends a genuinely local run once and not a run the leader dropped for budget", () => {
        const rendered = sized("run-rendered", "2026-10-18T08:00:00.000Z", 20_000);
        const dropped = sized("run-dropped", "2026-10-18T07:00:00.000Z", 20_000);
        const local = run("run-local", "END-run-local", "2026-10-18T09:00:00.000Z");
        // The leader read both of its runs and its budget kept only the newer one.
        const leader = assemble([rendered, dropped]);
        expect(leader.record.sourceEventIds).toEqual(["run-rendered"]);
        expect(leader.section).not.toContain("END-run-dropped");

        // The follower's window: its own unreported run, then the two the leader read.
        const res = followerCompose([rendered, dropped], leader, [local, rendered, dropped]);

        expect(res.prompt.startsWith(res.basePrompt)).toBe(true);
        expect(count(res.prompt, "END-run-local")).toBe(1);
        expect(count(res.prompt, "END-run-rendered")).toBe(1);
        expect(count(res.prompt, "END-run-dropped")).toBe(0);
        expect(res.portable?.record.sourceEventIds).toEqual(["run-local"]);
      });

      it("appends nothing when the leader's fixed sections leave its run tail little room", () => {
        const state = emptyPortableContextState("actor-a");
        state.items = [
          {
            id: "mem-1",
            kind: "constraint",
            priority: "must",
            status: "active",
            statement: "s".repeat(PORTABLE_CONTEXT_LEDGER_MAX_BYTES),
            evidence: [
              { eventId: "m0", sender: "root", ts: "2026-10-01T00:00:00.000Z", quote: "s" },
            ],
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        ];
        const newest = sized("run-newest", "2026-10-18T08:00:00.000Z", 6_000);
        const older = sized("run-older", "2026-10-18T07:00:00.000Z", 1_000);
        const leaderBuild = assemblePortableContextV2({
          state,
          messages: [
            { id: "m1", ts: "2026-10-18T06:00:00.000Z", sender: "root", body: "m".repeat(20_000) },
          ],
          runs: [newest, older],
          obligations: [
            obligation("ob-big", "ready", "o".repeat(PORTABLE_CONTEXT_OBLIGATIONS_MAX_BYTES), 1),
          ],
        });
        if (!leaderBuild) throw new Error("expected v2 portable context");
        // With history in its read window the leader still names its newest run,
        // tail-truncated to whatever room remains; every older run is dropped.
        expect(leaderBuild.record.sourceEventIds).toEqual(["run-newest"]);
        expect(leaderBuild.section).not.toContain("END-run-older");

        // Every host run is one the leader read, so the leader prompt is complete.
        const res = followerCompose([newest, older], leaderBuild, [newest, older]);

        expect(count(res.prompt, "END-run-older")).toBe(0);
        expect(res).toMatchObject({ prompt: res.basePrompt, portable: null });
      });

      it("separates local from leader-dropped runs when the leader rendered only another host's run", () => {
        const otherHost = sized("run-other-host", "2026-10-18T08:00:00.000Z", 20_000);
        const dropped = sized("run-dropped", "2026-10-18T07:00:00.000Z", 20_000);
        const local = run("run-local", "END-run-local", "2026-10-18T09:00:00.000Z");
        const leader = assemble([otherHost, dropped]);
        expect(leader.record.sourceEventIds).toEqual(["run-other-host"]);

        // The other host's run never executed here, so no represented id is in
        // this follower's window to anchor "newer than represented".
        const res = followerCompose([otherHost, dropped], leader, [local, dropped]);

        expect(count(res.prompt, "END-run-local")).toBe(1);
        expect(count(res.prompt, "END-run-other-host")).toBe(1);
        expect(count(res.prompt, "END-run-dropped")).toBe(0);
        expect(res.portable?.record.sourceEventIds).toEqual(["run-local"]);
      });
    });
  });
});
