import { afterEach, describe, expect, it } from "vitest";
import { type Obligation, parseExternalRef } from "../obligations/obligation.js";
import {
  assemblePortableContext,
  assemblePortableContextV2,
  PORTABLE_CONTEXT_LEDGER_MAX_BYTES,
  PORTABLE_CONTEXT_MAX_BYTES,
  PORTABLE_CONTEXT_MAX_MESSAGES,
  PORTABLE_CONTEXT_MAX_RUNS,
  PORTABLE_CONTEXT_OBLIGATIONS_MAX_BYTES,
  type PortableContext,
  type PriorRun,
  portableContextMaxMessages,
  portableContextMaxRuns,
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
    status: "ready" | "waiting",
    intent: string,
    priority = 1,
    externalRef: Obligation["externalRef"] = null
  ): Obligation => ({
    id,
    parentId: null,
    owner: { kind: "actor", id: "actor-a" },
    intent,
    externalRef,
    status,
    priority,
    effectivePriority: priority,
    prioritySourceId: id,
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
    const ref = parseExternalRef(`github_issue:${"o".repeat(39)}/${"r".repeat(100)}#1`);
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
    const ref: Obligation["externalRef"] = {
      kind: "github_pr",
      owner: "o".repeat(PORTABLE_CONTEXT_MAX_BYTES + 1_000),
      repo: "repo",
      number: 7,
      key: `github_pr:${"o".repeat(PORTABLE_CONTEXT_MAX_BYTES + 1_000)}/repo#7`,
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
});
