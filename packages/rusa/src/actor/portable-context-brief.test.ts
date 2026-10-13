import { describe, expect, it } from "vitest";
import { assemblePortableContextV2 } from "./portable-context.js";
import {
  findBriefStateExclusion,
  PORTABLE_CONTEXT_BRIEF_MAX_BYTES,
  PORTABLE_CONTEXT_BRIEF_MAX_EXPLANATION_BYTES,
  parseBriefDocument,
  seedBriefText,
  seedPortableBriefState,
  validateActorBriefUpdate,
} from "./portable-context-brief.js";
import {
  emptyPortableContextState,
  type PortableBrief,
  type PortableContextState,
} from "./portable-context-state.js";

const ACTOR = "actor-under-test";
const SEED_TEXT = seedBriefText(ACTOR);

const VALID =
  `## WHAT\n` +
  `Draw abstract SVG art for the assigned project. [mesh:actors/${ACTOR}/charter]\n` +
  `\n` +
  `## HOW\n` +
  `Prefer one representative citation per principle. [mesh:messages/m-1]\n` +
  `\n` +
  `## DOMAIN\n` +
  `The gallery renders at 1:1 pixel density. [github:MEK-Org/rusa/issues/954]\n`;

describe("findBriefStateExclusion", () => {
  it("rejects head SHAs but not the ordinary word 'defaced'", () => {
    expect(findBriefStateExclusion("waiting on head 96800f2 to clear")).toContain("commit SHA");
    expect(findBriefStateExclusion("the facade was defaced today")).toBeNull();
  });

  it("rejects run/message ids, review ids, gate tallies and bare issue numbers", () => {
    expect(
      findBriefStateExclusion("run 12345678-aaaa-4bbb-8ccc-123456789abc failed before launch")
    ).toContain("run/message id");
    expect(findBriefStateExclusion("review 1234567890 is outstanding")).toContain("review id");
    expect(findBriefStateExclusion("see pullrequestreview-1234567890")).toContain("review id");
    expect(findBriefStateExclusion("the gate stands at 1/2")).toContain("gate tally");
    expect(findBriefStateExclusion("carry on with #954 as commissioned")).toContain(
      "bare issue number"
    );
  });

  it("allows owner/repo-qualified issue refs", () => {
    expect(findBriefStateExclusion("carry on with MEK-Org/rusa#954")).toBeNull();
    expect(findBriefStateExclusion("carry on with rusa#954")).toBeNull();
  });
});

describe("parseBriefDocument", () => {
  it("parses the seed document", () => {
    const { parsed, errors } = parseBriefDocument(SEED_TEXT);
    expect(errors).toEqual([]);
    expect(parsed?.lines).toHaveLength(1);
    expect(parsed?.lines[0]).toMatchObject({
      section: "WHAT",
      refs: [`mesh:actors/${ACTOR}/charter`],
    });
  });

  it("collects shape problems: missing/out-of-order/duplicate sections, no citation, stray heading", () => {
    const text =
      `preamble without a section\n` +
      `## DOMAIN\n` +
      `Domain statement without a citation\n` +
      `## WHAT\n` +
      `## WHAT\n` +
      `A fine line. [mesh:messages/m-1]\n` +
      `### stray subheading\n`;
    const { errors } = parseBriefDocument(text);
    expect(errors.join("\n")).toContain("content before the first section");
    expect(errors.join("\n")).toContain("out of order");
    expect(errors.join("\n")).toContain("duplicate section WHAT");
    expect(errors.join("\n")).toContain("no structured citation");
    expect(errors.join("\n")).toContain("unexpected heading line");
  });

  it("flags a line that is only a citation and trailing prose after citations", () => {
    const onlyCitation = `## WHAT\n\n[mesh:messages/m-1]\n\n## HOW\n\n## DOMAIN\n`;
    expect(parseBriefDocument(onlyCitation).errors.join("\n")).toContain("only a citation");

    const trailingProse = `## WHAT\nStatement here. [mesh:messages/m-1] and more prose\n\n## HOW\n\n## DOMAIN\n`;
    expect(parseBriefDocument(trailingProse).errors.join("\n")).toContain(
      "must end with its citations"
    );
    const embedded = `## WHAT\nStatement [mesh:messages/m-1] continues here. [mesh:messages/m-2]\n\n## HOW\n\n## DOMAIN\n`;
    expect(parseBriefDocument(embedded).errors.join("\n")).toContain("must end with its citations");
    const nonRefInTail = `## WHAT\nStatement here. [mesh:messages/m-1] [see above]\n\n## HOW\n\n## DOMAIN\n`;
    expect(parseBriefDocument(nonRefInTail).errors.join("\n")).toContain(
      "must end with its citations"
    );
  });

  it("splits at the first citation and keeps a non-reference bracket in the statement", () => {
    const text = `## WHAT\nKeep the quoted [sic] wording. [mesh:messages/m-1]  [mesh:messages/m-2]\n\n## HOW\n\n## DOMAIN\n`;
    const { parsed, errors } = parseBriefDocument(text);
    expect(errors).toEqual([]);
    expect(parsed?.lines).toEqual([
      expect.objectContaining({
        section: "WHAT",
        statement: "Keep the quoted [sic] wording.",
        refs: ["mesh:messages/m-1", "mesh:messages/m-2"],
      }),
    ]);
  });
});

describe("validateActorBriefUpdate", () => {
  it("accepts a well-formed, cited, state-free brief and normalizes its trailing newline", () => {
    expect(validateActorBriefUpdate({ text: `${VALID}\n\n`, previousText: SEED_TEXT })).toEqual({
      outcome: "accepted",
      text: VALID,
      // The seed already cites the charter, so only the other two are new.
      newCitations: ["mesh:messages/m-1", "github:MEK-Org/rusa/issues/954"],
    });
  });

  it("treats the stored text, modulo trailing whitespace, as a no-op whatever the explanation", () => {
    expect(
      validateActorBriefUpdate({
        text: `${VALID.trimEnd()}   \n\n`,
        previousText: VALID,
        explanation: "restating the same guidance",
      })
    ).toEqual({ outcome: "noop" });
  });

  it("lets consolidation, rewording and citation rotation through with no supersession bookkeeping", () => {
    const consolidated =
      `## WHAT\n` +
      `Draw abstract SVG art; keep the brief small. [mesh:messages/m-9]\n` +
      `\n## HOW\n\n## DOMAIN\n`;
    expect(validateActorBriefUpdate({ text: consolidated, previousText: VALID })).toMatchObject({
      outcome: "accepted",
      newCitations: ["mesh:messages/m-9"],
    });
  });

  it("names only the citations a write introduces, ignoring non-reference brackets", () => {
    const rotated = VALID.replace(
      "[mesh:messages/m-1]",
      "[mesh:messages/m-1] [mesh:messages/m-2]"
    ).replace("Draw abstract SVG art", "Draw abstract SVG art [sic]");
    expect(validateActorBriefUpdate({ text: rotated, previousText: VALID })).toMatchObject({
      outcome: "accepted",
      newCitations: ["mesh:messages/m-2"],
    });
  });

  it("refuses an oversized brief and an oversized explanation", () => {
    const line = "Keep the palette restrained. [mesh:messages/m-1]\n";
    const oversized = `## WHAT\n${line.repeat(Math.ceil(PORTABLE_CONTEXT_BRIEF_MAX_BYTES / line.length) + 1)}\n## HOW\n\n## DOMAIN\n`;
    const big = validateActorBriefUpdate({ text: oversized, previousText: SEED_TEXT });
    expect(big.outcome).toBe("invalid");
    expect(big.outcome === "invalid" && big.errors.join("\n")).toContain("-byte cap");

    const chatty = validateActorBriefUpdate({
      text: VALID,
      previousText: SEED_TEXT,
      explanation: "x".repeat(PORTABLE_CONTEXT_BRIEF_MAX_EXPLANATION_BYTES + 1),
    });
    expect(chatty.outcome === "invalid" && chatty.errors.join("\n")).toContain("explanation is");
  });

  it("refuses uncited lines, broken structure, and per-resource state in any section", () => {
    const uncited = VALID.replace(" [mesh:messages/m-1]", "");
    expect(validateActorBriefUpdate({ text: uncited, previousText: SEED_TEXT })).toMatchObject({
      outcome: "invalid",
      errors: [expect.stringContaining("no structured citation")],
    });
    const noDomain = VALID.slice(0, VALID.indexOf("## DOMAIN"));
    expect(
      validateActorBriefUpdate({ text: noDomain, previousText: SEED_TEXT }).outcome === "invalid"
    ).toBe(true);
    const stateful = VALID.replace(
      "The gallery renders at 1:1 pixel density.",
      "Waiting on head 96800f2 at gate 1/2."
    );
    const result = validateActorBriefUpdate({ text: stateful, previousText: SEED_TEXT });
    expect(result.outcome === "invalid" && result.errors.join("\n")).toMatch(
      /DOMAIN line names a commit SHA.*gate tally/
    );
  });

  it("trims the explanation and drops a blank one", () => {
    expect(
      validateActorBriefUpdate({ text: VALID, previousText: SEED_TEXT, explanation: "  why  " })
    ).toEqual({
      outcome: "accepted",
      text: VALID,
      explanation: "why",
      newCitations: ["mesh:messages/m-1", "github:MEK-Org/rusa/issues/954"],
    });
    expect(
      validateActorBriefUpdate({ text: VALID, previousText: SEED_TEXT, explanation: "  " })
    ).toEqual({
      outcome: "accepted",
      text: VALID,
      newCitations: ["mesh:messages/m-1", "github:MEK-Org/rusa/issues/954"],
    });
  });
});

describe("seedPortableBriefState", () => {
  it("seeds generation 0 with the charter line and leaves the ledger fields alone", () => {
    const state: PortableContextState = {
      ...emptyPortableContextState(ACTOR),
      generation: 41,
      lastFoldedSourceId: "legacy-source",
    };
    const seeded = seedPortableBriefState(state, ACTOR, "2026-10-10T00:00:00.000Z");
    expect(seeded).toEqual({
      ...state,
      brief: { text: SEED_TEXT, generation: 0, updatedAt: "2026-10-10T00:00:00.000Z" },
    });
    expect(validateActorBriefUpdate({ text: SEED_TEXT, previousText: "" }).outcome).toBe(
      "accepted"
    );
  });
});

describe("brief mode switch", () => {
  it("switching to ledger mode and back preserves the brief snapshot byte-identically", () => {
    const keptBrief: PortableBrief = {
      text: SEED_TEXT,
      generation: 2,
      updatedAt: "2026-10-08T09:00:00Z",
    };

    const state: PortableContextState = {
      ...emptyPortableContextState(ACTOR),
      items: [
        {
          id: "mem-ledger-1",
          kind: "decision",
          priority: "must",
          status: "active",
          statement: "Active ledger decision",
          evidence: [{ eventId: "e1", sender: "root", ts: "2026-10-01T00:00:00Z", quote: "q" }],
          updatedAt: "2026-10-01T00:00:00Z",
        },
      ],
      brief: keptBrief,
    };

    // Mode switched to ledger: brief is omitted from assembly
    const ledgerContext = assemblePortableContextV2({
      state,
      messages: [{ id: "m-1", ts: "2026-10-08T09:00:00Z", sender: "root", body: "hello" }],
      runs: [],
      brief: null,
    });
    expect(ledgerContext).not.toBeNull();
    expect(ledgerContext?.section).toContain("Active ledger decision");
    expect(ledgerContext?.section).not.toContain("Durable brief (mode: brief");

    // The snapshot document still retains the brief untouched
    expect(state.brief).toEqual(keptBrief);

    // Mode switched back to brief: brief is passed to assembly
    const briefContext = assemblePortableContextV2({
      state,
      messages: [{ id: "m-1", ts: "2026-10-08T09:00:00Z", sender: "root", body: "hello" }],
      runs: [],
      brief: state.brief,
    });
    expect(briefContext).not.toBeNull();
    expect(briefContext?.section).toContain("### Durable brief (mode: brief, generation 2");
    expect(briefContext?.section).not.toContain("Active ledger decision");

    // State brief object remains byte-identical
    expect(state.brief).toEqual(keptBrief);
  });
});

describe("brief render", () => {
  it("replaces the ledger section with the brief and never emits a budget-omission line", () => {
    const state: PortableContextState = {
      ...emptyPortableContextState(ACTOR),
      items: [
        {
          id: "mem-1",
          kind: "decision",
          priority: "must",
          status: "active",
          statement: "A ledger statement that must NOT render in brief mode",
          evidence: [{ eventId: "e", sender: "root", ts: "2026-01-01T00:00:00Z", quote: "q" }],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      brief: { text: SEED_TEXT, generation: 7, updatedAt: "2026-10-07T01:00:00Z" },
    };
    const portable = assemblePortableContextV2({
      state,
      messages: [{ id: "m-1", ts: "2026-10-07T00:00:00Z", sender: "root", body: "hello" }],
      runs: [],
      brief: state.brief,
    });
    expect(portable).not.toBeNull();
    expect(portable?.section).toContain("### Durable brief (mode: brief, generation 7");
    expect(portable?.section).toContain("updated 2026-10-07T01:00:00Z)");
    expect(portable?.section).toContain("read it and replace it with the `brief` MCP tools");
    expect(portable?.section).toContain("The charter is in force");
    expect(portable?.section).not.toContain("A ledger statement that must NOT render");
    expect(portable?.section).not.toContain("omitted due to budget");
    expect(portable?.section).toContain("### Recent messages (verbatim)");
  });

  it("ledger mode render is unchanged by the brief field's presence", () => {
    const state = emptyPortableContextState(ACTOR);
    const without = assemblePortableContextV2({
      state,
      messages: [{ id: "m-1", ts: "2026-10-07T00:00:00Z", sender: "root", body: "hello" }],
      runs: [],
    });
    const withBriefField = assemblePortableContextV2({
      state: { ...state, brief: null },
      messages: [{ id: "m-1", ts: "2026-10-07T00:00:00Z", sender: "root", body: "hello" }],
      runs: [],
      brief: null,
    });
    expect(withBriefField?.section).toBe(without?.section);
    expect(withBriefField?.record.sections).toEqual(without?.record.sections);
  });
});
