import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { actorInbox } from "../db/migrations/0003_actor_inbox.js";
import { actorInboxSeen } from "../db/migrations/0012_actor_inbox_seen.js";
import { actorInboxHandledNote } from "../db/migrations/0015_actor_inbox_handled_note.js";
import type { PortableLedgerSource } from "../db/repositories/actor-run-repository.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import * as geminiUtils from "../understanding/gemini-utils.js";
import { assemblePortableContextV2 } from "./portable-context.js";
import {
  BRIEF_ACCEPTED_CITATION_FORMS,
  BRIEF_REWRITE_SYSTEM_INSTRUCTION,
  type BriefAttemptTelemetry,
  type BriefCycleDeps,
  type BriefReferenceResolution,
  buildBriefRewritePrompt,
  citationForLedgerSource,
  classifyBriefSender,
  findBriefStateExclusion,
  GeminiBriefRewriter,
  isBriefAttentionHandled,
  PORTABLE_CONTEXT_BRIEF_MAX_BYTES,
  PORTABLE_CONTEXT_BRIEF_MAX_CONSECUTIVE_FAILURES,
  parseBriefDocument,
  runPortableContextBriefCycle,
  seedBriefText,
  selectBriefSlice,
  validateBriefText,
} from "./portable-context-brief.js";
import {
  type BriefCursor,
  emptyPortableContextState,
  InMemoryPortableContextStore,
  type PortableBrief,
  type PortableBriefSupersession,
  type PortableContextState,
} from "./portable-context-state.js";

const ACTOR = "actor-under-test";

function chatSource(id: string, ts: string, from: string, body: string): PortableLedgerSource {
  return {
    id,
    ts,
    kind: "message_received",
    actorId: ACTOR,
    detail: null,
    body,
    payload: JSON.stringify({ messageId: id, from }),
    success: null,
  };
}

function yieldSource(id: string, ts: string, body: string): PortableLedgerSource {
  return {
    id,
    ts,
    kind: "run_yielded",
    actorId: ACTOR,
    detail: "completed",
    body,
    payload: null,
    success: null,
  };
}

const cursorOf = (source: PortableLedgerSource): BriefCursor => ({
  ts: source.ts,
  sourceOrder: source.kind === "run_yielded" ? 1 : 0,
  id: source.id,
});

const SEED_TEXT = seedBriefText(ACTOR);

interface CycleHarnessOptions {
  sources: PortableLedgerSource[];
  rewriterText: string | string[];
  resolveRef?: (ref: string) => Promise<BriefReferenceResolution>;
  classify?: BriefCycleDeps["classify"];
  now?: string;
  seedPosition?: BriefCursor | null;
  store?: InMemoryPortableContextStore;
}

function cycleHarness(options: CycleHarnessOptions) {
  const store = options.store ?? new InMemoryPortableContextStore();
  if (!options.store) {
    const state = emptyPortableContextState(ACTOR);
    // The pre-brief ledger content proves the cycle never touches ledger fields.
    state.items = [
      {
        id: "mem-legacy",
        kind: "decision",
        priority: "must",
        status: "active",
        statement: "Legacy ledger item that brief mode must keep intact",
        evidence: [{ eventId: "evt-1", sender: "root", ts: "2026-01-01T00:00:00Z", quote: "q" }],
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    state.generation = 41;
    state.lastFoldedSourceId = "legacy-source";
    store.save(state);
  }

  const attempts: BriefAttemptTelemetry[] = [];
  const attention: Array<{ id: string; actorId: string; reason: string }> = [];
  const handledAttention = new Set<string>();
  const resolveCalls: string[] = [];
  const outputs = Array.isArray(options.rewriterText)
    ? [...options.rewriterText]
    : [options.rewriterText];
  const rewriter = {
    model: "gemini-3.8-flash",
    rewrite: vi.fn(async (_contents: string) => {
      const next = outputs.shift();
      if (next === undefined)
        throw new Error("rewriter exhausted: test gave fewer texts than calls");
      return next;
    }),
  };
  const deps: BriefCycleDeps = {
    actorId: ACTOR,
    charter: "Create abstract SVG art within the assigned project.",
    store,
    rewriter,
    resolveRef: options.resolveRef ?? (async () => ({ outcome: "resolved" })),
    classify:
      options.classify ??
      ((senderId: string) =>
        senderId === "human:operator" || senderId.startsWith("human:") || senderId === "user-1"
          ? "human"
          : senderId === "root" || senderId === "steward"
            ? "ancestor"
            : "descendant"),
    listSources: (position, _limit) => ({
      sources: options.sources.filter((source) => {
        if (position === null) return true;
        const c = cursorOf(source);
        return (
          c.ts > position.ts ||
          (c.ts === position.ts && c.sourceOrder > position.sourceOrder) ||
          (c.ts === position.ts && c.sourceOrder === position.sourceOrder && c.id > position.id)
        );
      }),
      hasMore: false,
    }),
    latestPosition: () =>
      options.seedPosition !== undefined
        ? options.seedPosition
        : options.sources.length > 0 && options.rewriterText.length === 0
          ? cursorOf(options.sources[options.sources.length - 1])
          : null,
    now: () => options.now ?? "2026-10-07T20:00:00.000Z",
    recordAttempt: (attempt) => attempts.push(attempt),
    raiseAttention: (input) => {
      const id = `attention-${attention.length + 1}`;
      attention.push({ id, ...input });
      return { ownerId: "parent-of-actor", entryId: id };
    },
    isAttentionHandled: ({ entryId }) => handledAttention.has(entryId),
  };
  const resolveRefTracked = async (ref: string): Promise<BriefReferenceResolution> => {
    resolveCalls.push(ref);
    return deps.resolveRef(ref);
  };
  return {
    store,
    attempts,
    attention,
    markAttentionHandled: (id: string) => handledAttention.add(id),
    resolveCalls,
    rewriter,
    deps: { ...deps, resolveRef: resolveRefTracked },
  };
}

describe("classifyBriefSender", () => {
  const tree = new Map<string, string | null | undefined>([
    ["root", null],
    ["steward", "root"],
    ["worker", "steward"],
    ["sibling", "steward"],
    ["grandchild", "worker"],
  ]);
  const deps = {
    parentOf: (id: string) => tree.get(id),
    isHumanPrincipal: (id: string) => id === "human:operator" || id === "user-1",
  };

  it("classes operator and user principals as human", () => {
    expect(classifyBriefSender("human:operator", "worker", deps)).toBe("human");
    expect(classifyBriefSender("user-1", "worker", deps)).toBe("human");
  });

  it("classes the parent chain as ancestor", () => {
    expect(classifyBriefSender("steward", "worker", deps)).toBe("ancestor");
    expect(classifyBriefSender("root", "worker", deps)).toBe("ancestor");
  });

  it("classes children and own messages as descendant", () => {
    expect(classifyBriefSender("grandchild", "worker", deps)).toBe("descendant");
    expect(classifyBriefSender("worker", "worker", deps)).toBe("descendant");
  });

  it("classes same-parent actors as peer", () => {
    expect(classifyBriefSender("sibling", "worker", deps)).toBe("peer");
    expect(classifyBriefSender("unrelated", "worker", deps)).toBe("peer");
  });

  it("does not hang on a corrupt parent cycle", () => {
    const cyclic = {
      parentOf: (id: string): string | null | undefined =>
        id === "a" ? "b" : id === "b" ? "a" : null,
      isHumanPrincipal: () => false,
    };
    expect(classifyBriefSender("a", "worker", cyclic)).toBe("peer");
  });
});

describe("citationForLedgerSource", () => {
  it("cites chat messages and yield notes on their existing ref forms", () => {
    expect(citationForLedgerSource(chatSource("m-1", "t", "root", "b"))).toBe("mesh:messages/m-1");
    expect(citationForLedgerSource(yieldSource("r-1", "t", "b"))).toBe(
      `mesh:actors/${ACTOR}/runs/r-1`
    );
  });
});

describe("findBriefStateExclusion", () => {
  it("rejects head SHAs but not the ordinary word 'defaced'", () => {
    expect(findBriefStateExclusion("waiting on head 96800f2 to clear")).toContain("commit SHA");
    expect(findBriefStateExclusion("the facade was defaced today")).toBeNull();
  });

  it("rejects run/message ids, review ids, gate tallies and bare issue numbers", () => {
    expect(
      findBriefStateExclusion("run 714e7bff-4b08-43a8-a0b9-02806cb41714 failed before launch")
    ).toContain("run/message id");
    expect(findBriefStateExclusion("review 5448063297 is outstanding")).toContain("review id");
    expect(findBriefStateExclusion("see pullrequestreview-5448063297")).toContain("review id");
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

describe("validateBriefText", () => {
  const seed = SEED_TEXT;
  const authority = new Set(["mesh:messages/auth-1"]);

  it("rejects output over the 16 KB cap", () => {
    const big = `## WHAT\n${"x".repeat(PORTABLE_CONTEXT_BRIEF_MAX_BYTES)}\n\n## HOW\n\n## DOMAIN\n`;
    expect(
      validateBriefText({
        text: big,
        previousText: seed,
        authorityCitations: authority,
      }).errors.join("\n")
    ).toContain("over the");
  });

  it("enforces root's guard: a reworded WHAT line needs a cited human/ancestor supersession", () => {
    const reworded = seed.replace(
      "The charter is in force; it is rendered in the prompt.",
      "The charter governs everything the actor does."
    );
    const errors = validateBriefText({
      text: reworded,
      previousText: seed,
      authorityCitations: new Set(),
    }).errors;
    expect(errors.join("\n")).toContain("changed without a cited human/ancestor supersession");

    const withAuthority = validateBriefText({
      text: reworded.replace(
        `[mesh:actors/${ACTOR}/charter]`,
        `[mesh:actors/${ACTOR}/charter] [mesh:messages/auth-1]`
      ),
      previousText: seed,
      authorityCitations: authority,
      citationAuthorities: new Map([
        [`mesh:actors/${ACTOR}/charter`, { sourceClass: "human" as const, observedAt: "seed" }],
        ["mesh:messages/auth-1", { sourceClass: "human" as const, observedAt: "new" }],
      ]),
      supersessions: [
        {
          previous: {
            section: "WHAT",
            line: `The charter is in force; it is rendered in the prompt. [mesh:actors/${ACTOR}/charter]`,
            occurrence: 1,
          },
          source: "mesh:messages/auth-1",
          replacement: {
            section: "WHAT",
            line: `The charter governs everything the actor does. [mesh:actors/${ACTOR}/charter] [mesh:messages/auth-1]`,
          },
        },
      ],
    }).errors;
    expect(withAuthority).toEqual([]);
  });

  it("rejects dropping WHAT/HOW lines without any human/ancestor message in the delta", () => {
    const emptied = seed.replace(
      `The charter is in force; it is rendered in the prompt. [mesh:actors/${ACTOR}/charter]\n`,
      ""
    );
    const errors = validateBriefText({
      text: emptied,
      previousText: seed,
      authorityCitations: new Set(),
    }).errors;
    expect(errors.join("\n")).toContain("missing exactly one supersession record");
  });

  it("rejects a WHAT/HOW deletion when an unrelated authority message is present", () => {
    const previous = seed.replace(
      "## HOW\n\n",
      "## HOW\nKeep validation deterministic. [mesh:messages/old-rule]\n\n"
    );
    const candidate = `${seed}A status note. [mesh:messages/new-authority]\n`;
    const errors = validateBriefText({
      text: candidate,
      previousText: previous,
      authorityCitations: new Set(["mesh:messages/new-authority"]),
    }).errors;
    expect(errors.join("\n")).toContain("missing exactly one supersession record");
  });

  it("a milestone yields no new lines and at most one refined DOMAIN line", () => {
    const previous = `${seed}Existing domain principle. [mesh:messages/old]\n`;
    const milestoneCitations = new Set(["mesh:messages/milestone"]);
    const check = (text: string, milestoneOnly = true) =>
      validateBriefText({
        text,
        previousText: previous,
        authorityCitations: new Set(),
        milestoneCitations,
        milestoneOnly,
      }).errors.join("\n");

    // One appended line, every old line retained: a new line, rejected.
    expect(check(`${previous}A new principle. [mesh:messages/milestone]\n`)).toContain(
      "added a new DOMAIN line"
    );
    // Same, but citing only a carried ref: the milestone-only bound still catches it.
    expect(check(`${previous}A new principle. [mesh:messages/old]\n`)).toContain(
      "milestone-only delta added 1 new DOMAIN line"
    );
    // Two refinements.
    const twoPrevious = `${previous}Second principle. [mesh:messages/old]\n`;
    expect(
      validateBriefText({
        text:
          `${seed}Refined one. [mesh:messages/milestone]\n` +
          `Refined two. [mesh:messages/milestone]\n`,
        previousText: twoPrevious,
        authorityCitations: new Set(),
        milestoneCitations,
        milestoneOnly: true,
      }).errors.join("\n")
    ).toContain("changed 2 DOMAIN lines");
    // Exactly one refinement of an existing DOMAIN line is accepted.
    expect(
      check(
        previous.replace(
          "Existing domain principle. [mesh:messages/old]",
          "Existing domain principle, refined. [mesh:messages/old] [mesh:messages/milestone]"
        )
      )
    ).toBe("");
  });

  it("an ancestor milestone cannot add WHAT/HOW, even in a mixed delta", () => {
    const candidate = seed.replace(
      "## HOW\n\n",
      "## HOW\nShip only through staging. [mesh:messages/milestone]\n\n"
    );
    const errors = validateBriefText({
      text: candidate,
      previousText: seed,
      // The cycle excludes milestone refs from authority; a mixed delta still
      // carries a genuine human authority ref alongside.
      authorityCitations: new Set(["mesh:messages/human-rule"]),
      milestoneCitations: new Set(["mesh:messages/milestone"]),
      milestoneOnly: false,
    }).errors.join("\n");
    expect(errors).toContain("milestone message cannot add or change a HOW line");
    expect(errors).toContain("changed without a cited human/ancestor supersession");
  });

  it("a mixed delta keeps non-milestone DOMAIN additions legal", () => {
    const candidate = `${seed}Humans set direction. [mesh:messages/human-rule]\n`;
    expect(
      validateBriefText({
        text: candidate,
        previousText: seed,
        authorityCitations: new Set(["mesh:messages/human-rule"]),
        milestoneCitations: new Set(["mesh:messages/milestone"]),
        milestoneOnly: false,
      }).errors
    ).toEqual([]);
  });

  it("same-section supersession: a dropped HOW line needs a same-section authority-cited replacement", () => {
    const previous = seed.replace(
      "## HOW\n\n",
      "## HOW\nKeep validation deterministic. [mesh:messages/old-rule]\n\n"
    );
    const replaced = (ref: string) =>
      seed.replace("## HOW\n\n", `## HOW\nPrefer reproducible checks. [${ref}]\n\n`);
    // Descendant/peer-cited same-section replacement: rejected twice over.
    const descendant = validateBriefText({
      text: replaced("mesh:messages/child-note"),
      previousText: previous,
      authorityCitations: new Set(["mesh:messages/new-authority"]),
    }).errors.join("\n");
    expect(descendant).toContain("HOW line changed without a cited human/ancestor supersession");
    expect(descendant).toContain("missing exactly one supersession record");
    // Human/ancestor-cited same-section replacement from this delta: accepted.
    // Which old line it supersedes is the model's judgment under the normative
    // instruction; the deterministic guard proves only the cited, one-for-one,
    // same-section authority shape.
    expect(
      validateBriefText({
        text: replaced("mesh:messages/new-authority"),
        previousText: previous,
        authorityCitations: new Set(["mesh:messages/new-authority"]),
        citationAuthorities: new Map([
          ["mesh:messages/old-rule", { sourceClass: "ancestor" as const, observedAt: "old" }],
          ["mesh:messages/new-authority", { sourceClass: "ancestor" as const, observedAt: "new" }],
        ]),
        supersessions: [
          {
            previous: {
              section: "HOW",
              line: "Keep validation deterministic. [mesh:messages/old-rule]",
              occurrence: 1,
            },
            source: "mesh:messages/new-authority",
            replacement: {
              section: "HOW",
              line: "Prefer reproducible checks. [mesh:messages/new-authority]",
            },
          },
        ],
      }).errors
    ).toEqual([]);
    // One authority line cannot pay for two dropped lines.
    const twoPrevious = previous.replace(
      "Keep validation deterministic. [mesh:messages/old-rule]\n",
      "Keep validation deterministic. [mesh:messages/old-rule]\nPin every tool. [mesh:messages/old-rule]\n"
    );
    expect(
      validateBriefText({
        text: replaced("mesh:messages/new-authority"),
        previousText: twoPrevious,
        authorityCitations: new Set(["mesh:messages/new-authority"]),
      }).errors.join("\n")
    ).toContain("missing exactly one supersession record");
  });

  it("accepts bounded per-line 3→1 consolidation and 1→0 deletion", () => {
    const previous =
      "## WHAT\n" +
      "Rule A. [mesh:messages/old-a]\n" +
      "Rule B. [mesh:messages/old-b]\n" +
      "Rule C. [mesh:messages/old-c]\n\n" +
      "## HOW\nRetire this method. [mesh:messages/old-how]\n\n## DOMAIN\n";
    const consolidated =
      "## WHAT\nOne replacement rule. [mesh:messages/new-human]\n\n## HOW\n\n## DOMAIN\n";
    const authorities = new Map([
      ["mesh:messages/old-a", { sourceClass: "ancestor" as const, observedAt: "old" }],
      ["mesh:messages/old-b", { sourceClass: "ancestor" as const, observedAt: "old" }],
      ["mesh:messages/old-c", { sourceClass: "ancestor" as const, observedAt: "old" }],
      ["mesh:messages/old-how", { sourceClass: "ancestor" as const, observedAt: "old" }],
      ["mesh:messages/new-human", { sourceClass: "human" as const, observedAt: "new" }],
    ]);
    const records: PortableBriefSupersession[] = ["Rule A.", "Rule B.", "Rule C."].map(
      (statement, index) => ({
        previous: {
          section: "WHAT" as const,
          line: `${statement} [mesh:messages/old-${String.fromCharCode(97 + index)}]`,
          occurrence: 1,
        },
        source: "mesh:messages/new-human",
        replacement: {
          section: "WHAT" as const,
          line: "One replacement rule. [mesh:messages/new-human]",
        },
      })
    );
    records.push({
      previous: {
        section: "HOW" as const,
        line: "Retire this method. [mesh:messages/old-how]",
        occurrence: 1,
      },
      source: "mesh:messages/new-human",
    });
    expect(
      validateBriefText({
        text: consolidated,
        previousText: previous,
        authorityCitations: new Set(["mesh:messages/new-human"]),
        citationAuthorities: authorities,
        supersessions: records,
      }).errors
    ).toEqual([]);
  });

  it("rejects missing, stale, lower-authority, descendant/peer, and cross-section accounting", () => {
    const previous = "## WHAT\nOld purpose. [mesh:messages/old-human]\n\n## HOW\n\n## DOMAIN\n";
    const replacement =
      "## WHAT\nNew purpose. [mesh:messages/new-ancestor]\n\n## HOW\n\n## DOMAIN\n";
    const base = {
      text: replacement,
      previousText: previous,
      authorityCitations: new Set(["mesh:messages/new-ancestor"]),
      citationAuthorities: new Map([
        ["mesh:messages/old-human", { sourceClass: "human" as const, observedAt: "old" }],
        ["mesh:messages/new-ancestor", { sourceClass: "ancestor" as const, observedAt: "new" }],
        ["mesh:messages/child", { sourceClass: "ancestor" as const, observedAt: "new" }],
      ]),
    };
    const record = (
      source: string,
      replacementLine = "New purpose. [mesh:messages/new-ancestor]",
      replacementSection: "WHAT" | "HOW" = "WHAT"
    ): PortableBriefSupersession => ({
      previous: {
        section: "WHAT" as const,
        line: "Old purpose. [mesh:messages/old-human]",
        occurrence: 1,
      },
      source,
      replacement: { section: replacementSection, line: replacementLine },
    });
    expect(validateBriefText(base).errors.join("\n")).toContain("missing exactly one");
    expect(
      validateBriefText({
        ...base,
        supersessions: [record("mesh:messages/old-human")],
      }).errors.join("\n")
    ).toContain("not a newer eligible");
    expect(
      validateBriefText({ ...base, supersessions: [record("mesh:messages/child")] }).errors.join(
        "\n"
      )
    ).toContain("not a newer eligible");
    expect(
      validateBriefText({
        ...base,
        supersessions: [record("mesh:messages/new-ancestor")],
      }).errors.join("\n")
    ).toContain("lower authority");
    expect(
      validateBriefText({
        ...base,
        supersessions: [
          record(
            "mesh:messages/new-ancestor",
            "A HOW replacement. [mesh:messages/new-ancestor]",
            "HOW"
          ),
        ],
      }).errors.join("\n")
    ).toContain("crosses sections");
  });

  it("rejects state material in DOMAIN while the citation tail stays valid", () => {
    const badDomain = `${seed}The queue is at gate 1/2 for head 96800f2. [mesh:messages/m-9]\n`;
    const errors = validateBriefText({
      text: badDomain,
      previousText: seed,
      authorityCitations: new Set(),
    }).errors;
    expect(errors.join("\n")).toContain("commit SHA");
    expect(errors.join("\n")).toContain("gate tally");
  });

  it("keeps DOMAIN additions from descendant-only sources legal", () => {
    const domainLine =
      seed +
      `Steward milestones are checkpoint material, never brief material. [mesh:messages/m-9]\n`;
    expect(
      validateBriefText({
        text: domainLine,
        previousText: seed,
        authorityCitations: new Set(),
      }).errors
    ).toEqual([]);
  });
});

describe("buildBriefRewritePrompt", () => {
  it("carries the delta with ready-made citations, class labels, and the accepted forms", () => {
    const prompt = buildBriefRewritePrompt({
      charter: "Create abstract SVG art within the assigned project.",
      currentText: SEED_TEXT,
      delta: [
        {
          citation: "mesh:messages/m-1",
          sourceClass: "human",
          ts: "2026-10-07T00:00:00Z",
          sender: "human:operator",
          body: "Keep the brief small.",
        },
      ],
    });
    expect(prompt).toContain("[class: human] [mesh:messages/m-1]");
    expect(prompt).toContain("Keep the brief small.");
    for (const form of BRIEF_ACCEPTED_CITATION_FORMS) expect(prompt).toContain(form);
    expect(prompt).not.toContain("Validator errors");
  });

  it("adds bounded validator errors only on the repair retry", () => {
    const repair = buildBriefRewritePrompt({
      charter: "Create abstract SVG art within the assigned project.",
      currentText: SEED_TEXT,
      delta: [],
      validatorErrors: ["WHAT line changed without a cited human/ancestor supersession"],
    });
    expect(repair).toContain("Validator errors to correct");
    expect(repair).toContain("repair retry");
  });

  it("bounds repair diagnostics in UTF-8 bytes", () => {
    const repair = buildBriefRewritePrompt({
      charter: "Create abstract SVG art within the assigned project.",
      currentText: SEED_TEXT,
      delta: [],
      validatorErrors: ["界".repeat(2_000)],
    });
    const diagnostics = repair.split("Validator errors to correct")[1];
    expect(Buffer.byteLength(diagnostics, "utf8")).toBeLessThanOrEqual(4_300);
  });

  it("system instruction carries the normative rules", () => {
    expect(BRIEF_REWRITE_SYSTEM_INSTRUCTION).toContain("WHAT (purpose and standing commitments)");
    expect(BRIEF_REWRITE_SYSTEM_INSTRUCTION).toContain("never per-resource state");
    expect(BRIEF_REWRITE_SYSTEM_INSTRUCTION).toContain("mesh:actors/<id>/charter");
  });

  it("sends the normative instruction through the Gemini request boundary", async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: "rewritten" });
    const client = { models: { generateContent } };
    const clientSpy = vi
      .spyOn(geminiUtils, "getGeminiClient")
      .mockReturnValue(client as unknown as ReturnType<typeof geminiUtils.getGeminiClient>);
    try {
      await new GeminiBriefRewriter("test-key").rewrite("dynamic prompt");
    } finally {
      clientSpy.mockRestore();
    }
    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: "dynamic prompt",
        config: expect.objectContaining({ systemInstruction: BRIEF_REWRITE_SYSTEM_INSTRUCTION }),
      })
    );
  });
});

describe("selectBriefSlice", () => {
  const sources = [
    chatSource("m-1", "2026-10-07T00:00:01Z", "root", "a".repeat(100)),
    chatSource("m-2", "2026-10-07T00:00:02Z", "root", "b".repeat(100)),
    chatSource("m-3", "2026-10-07T00:00:03Z", "root", "c".repeat(100)),
  ];

  it("stops at the count bound", () => {
    expect(selectBriefSlice({ sources, hasMore: true }, 2, 1_000_000)).toHaveLength(2);
  });

  it("stops at the byte bound and leaves an oversized first message for explicit attention", () => {
    expect(selectBriefSlice({ sources, hasMore: true }, 50, 250)).toHaveLength(2);
    const alone = selectBriefSlice({ sources, hasMore: true }, 50, 50);
    expect(alone).toHaveLength(0);
  });
});

describe("runPortableContextBriefCycle", () => {
  const humanMsg = chatSource(
    "m-auth",
    "2026-10-07T00:00:01Z",
    "human:operator",
    "Rule from Matt."
  );

  it("seeds on first sight with the switch position and the charter ref", async () => {
    const h = cycleHarness({ sources: [humanMsg], rewriterText: [] });
    const outcome = await runPortableContextBriefCycle(h.deps);
    expect(outcome).toEqual({ outcome: "seeded" });
    const brief = h.store.load(ACTOR).brief;
    expect(brief).toMatchObject({
      generation: 0,
      model: null,
      cursor: cursorOf(humanMsg),
      consecutiveFailures: 0,
      frozen: false,
      resolvedRefs: [`mesh:actors/${ACTOR}/charter`],
    });
    expect(brief?.text).toContain(`[mesh:actors/${ACTOR}/charter]`);
  });

  it("skips when no new message arrived past the cursor", async () => {
    const h = cycleHarness({ sources: [], rewriterText: [] });
    await runPortableContextBriefCycle(h.deps); // seed with empty stream
    const outcome = await runPortableContextBriefCycle(h.deps);
    expect(outcome).toEqual({ outcome: "skipped" });
    expect(h.rewriter.rewrite).not.toHaveBeenCalled();
  });

  it("supplies the current charter to both attempts and retains guidance requiring clarification", async () => {
    const source = chatSource(
      "m-charter-clarification",
      "2026-10-07T00:00:01Z",
      "human:operator",
      "Make abstract SVG art and administer the external project account."
    );
    const rewritten = SEED_TEXT.replace(
      "## HOW\n",
      "## HOW\n" +
        "Make abstract SVG art and administer the external project account. " +
        "[mesh:messages/m-charter-clarification]\n"
    );
    const h = cycleHarness({
      sources: [source],
      rewriterText: ["invalid brief", rewritten],
    });
    await runPortableContextBriefCycle(h.deps);
    h.deps.charter =
      "Create abstract SVG art. External account administration is outside the remit.";
    expect(await runPortableContextBriefCycle(h.deps)).toMatchObject({
      outcome: "accepted",
      attempts: 2,
    });
    for (const [index, [contents]] of h.rewriter.rewrite.mock.calls.entries()) {
      expect(contents.indexOf(h.deps.charter)).toBeLessThan(contents.indexOf("Current brief:"));
      expect(contents).not.toContain("Create abstract SVG art within the assigned project.");
      expect(contents).toContain("[class: human] [mesh:messages/m-charter-clarification]");
      expect(contents.includes("Validator errors to correct")).toBe(index === 1);
      expect(h.attempts[index].inputBytes).toBe(Buffer.byteLength(contents, "utf8"));
    }
    expect(h.store.load(ACTOR).brief?.text).toBe(rewritten);
    expect(h.store.load(ACTOR).brief?.cursor).toEqual(cursorOf(source));
  });

  it("accepts a valid rewrite: cursor advances past the slice, generation bumps, ledger fields untouched", async () => {
    const rewritten =
      `## WHAT\n` +
      `The charter is in force; it is rendered in the prompt. [mesh:actors/${ACTOR}/charter]\n` +
      `\n## HOW\n\n## DOMAIN\n` +
      `Matt wants a small brief. [mesh:messages/m-auth]\n`;
    const h = cycleHarness({ sources: [humanMsg], rewriterText: rewritten });
    await runPortableContextBriefCycle(h.deps); // seed
    const outcome = await runPortableContextBriefCycle(h.deps);
    expect(outcome).toMatchObject({ outcome: "accepted", attempts: 1 });
    const state = h.store.load(ACTOR);
    expect(state.brief).toMatchObject({
      text: rewritten,
      generation: 1,
      model: "gemini-3.8-flash",
      cursor: cursorOf(humanMsg),
      consecutiveFailures: 0,
    });
    // Switch-back contract: ledger content is byte-identical to before.
    expect(state.generation).toBe(41);
    expect(state.lastFoldedSourceId).toBe("legacy-source");
    expect(state.items.map((i) => i.statement)).toEqual([
      "Legacy ledger item that brief mode must keep intact",
    ]);
    expect(h.attempts).toHaveLength(1);
    expect(h.attempts[0]).toMatchObject({
      attempt: "initial",
      outcome: "accepted",
      generation: 1,
      model: "gemini-3.8-flash",
      reason: null,
    });
    expect(h.attempts[0].inputBytes).toBeGreaterThan(0);
    expect(h.attempts[0].outputBytes).toBeGreaterThan(0);
  });

  it("persists accepted per-line supersession accounting beside the rendered brief", async () => {
    const previous =
      `## WHAT\nThe charter is in force; it is rendered in the prompt. [mesh:actors/${ACTOR}/charter]\n\n` +
      "## HOW\nOld method. [mesh:messages/old-method]\n\n## DOMAIN\n";
    const candidate =
      `## WHAT\nThe charter is in force; it is rendered in the prompt. [mesh:actors/${ACTOR}/charter]\n\n` +
      "## HOW\nNew method. [mesh:messages/m-auth]\n\n## DOMAIN\n";
    const response =
      `<brief>\n${candidate}</brief>\n<supersessions>\n` +
      `${JSON.stringify({
        previous: {
          section: "HOW",
          line: "Old method. [mesh:messages/old-method]",
          occurrence: 1,
        },
        source: "mesh:messages/m-auth",
        replacement: { section: "HOW", line: "New method. [mesh:messages/m-auth]" },
      })}\n</supersessions>`;
    const h = cycleHarness({ sources: [humanMsg], rewriterText: response });
    await runPortableContextBriefCycle(h.deps); // seed
    const seeded = h.store.load(ACTOR);
    const seededBrief = seeded.brief;
    if (!seededBrief) throw new Error("expected seeded brief");
    h.store.save({
      ...seeded,
      brief: {
        ...seededBrief,
        text: previous,
        cursor: null,
        citationAuthorities: {
          [`mesh:actors/${ACTOR}/charter`]: { sourceClass: "human", observedAt: "seed" },
          "mesh:messages/old-method": { sourceClass: "ancestor", observedAt: "old" },
        },
      },
    });
    expect(await runPortableContextBriefCycle(h.deps)).toMatchObject({ outcome: "accepted" });
    const brief = h.store.load(ACTOR).brief;
    if (!brief) throw new Error("expected accepted brief");
    expect(brief.text).toBe(candidate.trimEnd());
    expect(brief.supersessions).toEqual([
      {
        previous: {
          section: "HOW",
          line: "Old method. [mesh:messages/old-method]",
          occurrence: 1,
        },
        source: "mesh:messages/m-auth",
        replacement: { section: "HOW", line: "New method. [mesh:messages/m-auth]" },
      },
    ]);
    expect(brief.citationAuthorities["mesh:messages/m-auth"]).toMatchObject({
      sourceClass: "human",
    });
  });

  it("rejects a descendant-authored WHAT change, repairs once, and keeps text and cursor on failure", async () => {
    const selfSourced =
      `## WHAT\n` +
      `I decided my own new purpose. [mesh:messages/m-self]\n` +
      `\n## HOW\n\n## DOMAIN\n`;
    const peerMsg = chatSource("m-self", "2026-10-07T00:00:01Z", "peer-a", "whatever");
    const h = cycleHarness({ sources: [peerMsg], rewriterText: [selfSourced, selfSourced] });
    await runPortableContextBriefCycle(h.deps); // seed
    const outcome = await runPortableContextBriefCycle(h.deps);
    expect(outcome).toMatchObject({ outcome: "rejected", attempts: 2 });
    const brief = h.store.load(ACTOR).brief;
    expect(brief?.text).toBe(SEED_TEXT);
    expect(brief?.cursor).toBeNull(); // seed captured the only message; nothing advanced
    expect(brief?.consecutiveFailures).toBe(1);
    expect(h.attempts.map((a) => a.attempt)).toEqual(["initial", "repair"]);
    expect(h.attempts.every((a) => a.outcome === "rejected")).toBe(true);
    expect(h.attempts[0].reason).toContain("human/ancestor supersession");
  });

  it("an ancestor milestone cannot authorize HOW; a human message about reviews still can", async () => {
    const withHow = (ref: string) =>
      SEED_TEXT.replace("## HOW\n\n", `## HOW\nShip only through staging. [${ref}]\n\n`);
    const milestone = chatSource(
      "m-ms",
      "2026-10-07T00:00:01Z",
      "steward",
      "PR merged to staging; checks green."
    );
    const blocked = cycleHarness({
      sources: [milestone],
      rewriterText: [withHow("mesh:messages/m-ms"), withHow("mesh:messages/m-ms")],
    });
    await runPortableContextBriefCycle(blocked.deps); // seed
    expect(await runPortableContextBriefCycle(blocked.deps)).toMatchObject({
      outcome: "rejected",
    });
    expect(blocked.attempts[0].reason).toContain(
      "milestone message cannot add or change a HOW line"
    );
    expect(blocked.attempts[0].reason).toContain("human/ancestor supersession");

    const human = chatSource(
      "m-hu",
      "2026-10-07T00:00:01Z",
      "human:operator",
      "Before any merge, ship only through staging after review."
    );
    const allowed = cycleHarness({
      sources: [human],
      rewriterText: [withHow("mesh:messages/m-hu")],
    });
    await runPortableContextBriefCycle(allowed.deps); // seed
    expect(await runPortableContextBriefCycle(allowed.deps)).toMatchObject({
      outcome: "accepted",
    });
  });

  it("keeps ancestor procedural direction authoritative when it merely mentions reviews and checks", async () => {
    const procedure = chatSource(
      "m-procedure",
      "2026-10-07T00:00:01Z",
      "steward",
      "Review the diff, verify checks succeed, and post questions before a verdict."
    );
    const rewritten = SEED_TEXT.replace(
      "## HOW\n\n",
      "## HOW\nRead evidence before a verdict. [mesh:messages/m-procedure]\n\n"
    );
    const h = cycleHarness({ sources: [procedure], rewriterText: rewritten });
    await runPortableContextBriefCycle(h.deps); // seed
    expect(await runPortableContextBriefCycle(h.deps)).toMatchObject({ outcome: "accepted" });
  });

  it("rejects unresolvable citations and resolves a ref only on its first appearance", async () => {
    const withNewRef =
      `## WHAT\nThe charter is in force; it is rendered in the prompt. [mesh:actors/${ACTOR}/charter]\n` +
      `\n## HOW\n\n## DOMAIN\n` +
      `A durable fact from chat. [mesh:messages/m-new]\n`;
    const msg = chatSource("m-new", "2026-10-07T00:00:01Z", "human:operator", "Rule from Matt.");
    const h = cycleHarness({
      sources: [msg],
      rewriterText: [withNewRef, withNewRef],
      resolveRef: async (ref) =>
        ref === `mesh:actors/${ACTOR}/charter`
          ? { outcome: "resolved" }
          : { outcome: "unresolved", reason: "missing" },
    });
    await runPortableContextBriefCycle(h.deps); // seed
    const outcome = await runPortableContextBriefCycle(h.deps);
    expect(outcome).toMatchObject({ outcome: "rejected" });
    expect(h.attempts[0].reason).toContain("citation does not resolve");
    expect(h.resolveCalls).toEqual(["mesh:messages/m-new"]); // charter ref came from the cache
  });

  it("rejects an invented ref before resolving it, even when that ref would resolve", async () => {
    const invented =
      `## WHAT\nThe charter is in force; it is rendered in the prompt. [mesh:actors/${ACTOR}/charter]\n` +
      `\n## HOW\n\n## DOMAIN\n` +
      `Invented outside resource. [mesh:messages/not-in-delta]\n`;
    const h = cycleHarness({ sources: [humanMsg], rewriterText: [invented, invented] });
    await runPortableContextBriefCycle(h.deps);
    const outcome = await runPortableContextBriefCycle(h.deps);
    expect(outcome).toMatchObject({ outcome: "rejected" });
    expect(h.attempts[0].reason).toContain("citation was not supplied");
    expect(h.resolveCalls).toEqual([]);
  });

  it("keeps an accepted carried ref in the persistent cache without another resolver call", async () => {
    const first = chatSource("m-1", "2026-10-07T00:00:01Z", "human:operator", "First rule.");
    const second = chatSource("m-2", "2026-10-07T00:00:02Z", "root", "PR milestone status.");
    const firstText =
      `## WHAT\nThe charter is in force; it is rendered in the prompt. [mesh:actors/${ACTOR}/charter]\n` +
      `\n## HOW\n\n## DOMAIN\n` +
      `A durable fact. [mesh:messages/m-1]\n`;
    const secondText =
      `## WHAT\nThe charter is in force; it is rendered in the prompt. [mesh:actors/${ACTOR}/charter]\n` +
      `\n## HOW\n\n## DOMAIN\n` +
      `A clarified durable fact. [mesh:messages/m-1]\n`;
    const h = cycleHarness({ sources: [first], rewriterText: [firstText] });
    await runPortableContextBriefCycle(h.deps);
    await runPortableContextBriefCycle(h.deps);
    h.deps.listSources = (position) => ({
      sources: position ? [second] : [first, second],
      hasMore: false,
    });
    h.rewriter.rewrite.mockResolvedValueOnce(secondText);
    expect(await runPortableContextBriefCycle(h.deps)).toMatchObject({ outcome: "accepted" });
    expect(h.resolveCalls).toEqual(["mesh:messages/m-1"]);
  });

  it("does not count transient citation resolution against the freeze budget", async () => {
    const h = cycleHarness({
      sources: [humanMsg],
      rewriterText:
        `## WHAT\nThe charter is in force; it is rendered in the prompt. [mesh:actors/${ACTOR}/charter]\n` +
        `\n## HOW\n\n## DOMAIN\nA durable fact. [mesh:messages/m-auth]\n`,
      resolveRef: async (ref) =>
        ref === "mesh:messages/m-auth"
          ? { outcome: "unavailable", reason: "GitHub 429 rate limit" }
          : { outcome: "resolved" },
    });
    await runPortableContextBriefCycle(h.deps);
    expect(await runPortableContextBriefCycle(h.deps)).toMatchObject({ outcome: "unavailable" });
    expect(h.store.load(ACTOR).brief?.consecutiveFailures).toBe(0);
    expect(h.attempts[0]).toMatchObject({ outcome: "unavailable" });
  });

  it("accepts on the repair retry after a malformed first output and records one event per attempt", async () => {
    const msg = chatSource("m-auth", "2026-10-07T00:00:01Z", "human:operator", "Rule from Matt.");
    const valid =
      `## WHAT\nThe charter is in force; it is rendered in the prompt. [mesh:actors/${ACTOR}/charter]\n` +
      `\n## HOW\n\n## DOMAIN\n` +
      `A durable fact from chat. [mesh:messages/m-auth]\n`;
    const h = cycleHarness({ sources: [msg], rewriterText: ["not a brief at all", valid] });
    await runPortableContextBriefCycle(h.deps); // seed
    const outcome = await runPortableContextBriefCycle(h.deps);
    expect(outcome).toMatchObject({ outcome: "accepted", attempts: 2 });
    expect(h.attempts.map((a) => [a.attempt, a.outcome])).toEqual([
      ["initial", "rejected"],
      ["repair", "accepted"],
    ]);
    expect(h.store.load(ACTOR).brief?.text).toBe(valid);
  });

  it("freezes after three consecutive failures, raises attention once, and ignores further rewrites", async () => {
    const msg = chatSource("m-auth", "2026-10-07T00:00:01Z", "human:operator", "Rule from Matt.");
    const bad = "garbage output";
    const h = cycleHarness({
      sources: [msg],
      rewriterText: [bad, bad, bad, bad, bad, bad],
      resolveRef: async () => ({ outcome: "unresolved", reason: "missing" }),
      classify: () => "descendant",
    });
    await runPortableContextBriefCycle(h.deps); // seed
    for (let i = 1; i <= 3; i++) {
      const outcome = await runPortableContextBriefCycle(h.deps);
      expect(outcome).toMatchObject({ outcome: "rejected" });
    }
    const brief = h.store.load(ACTOR).brief;
    expect(brief?.frozen).toBe(true);
    expect(brief?.consecutiveFailures).toBe(PORTABLE_CONTEXT_BRIEF_MAX_CONSECUTIVE_FAILURES);
    expect(h.attention).toHaveLength(1);
    expect(h.attention[0].actorId).toBe(ACTOR);
    expect(h.attention[0].reason).toContain("3 consecutive cycles");

    const whileFrozen = await runPortableContextBriefCycle(h.deps);
    expect(whileFrozen).toEqual({ outcome: "frozen" });
    expect(h.attention).toHaveLength(1); // no repeat alerts
  });

  it("releases the freeze only after its durable attention item is handled", async () => {
    const first = chatSource("m-1", "2026-10-07T00:00:01Z", "root", "ancestor note");
    const humanReply = chatSource(
      "m-2",
      "2026-10-07T00:00:02Z",
      "human:operator",
      "Handled; fix it."
    );
    const valid =
      `## WHAT\nThe charter is in force; it is rendered in the prompt. [mesh:actors/${ACTOR}/charter]\n` +
      `\n## HOW\n\n## DOMAIN\n` +
      `Recovery note. [mesh:messages/m-2]\n`;
    const h = cycleHarness({
      sources: [first, humanReply],
      rewriterText: ["bad", "bad", "bad", "bad", "bad", "bad", valid],
      resolveRef: async (ref) =>
        ref.endsWith("/charter") || ref === "mesh:messages/m-2"
          ? { outcome: "resolved" }
          : { outcome: "unresolved", reason: "missing" },
    });
    await runPortableContextBriefCycle(h.deps); // seed at m-2's position (latestPosition)
    // Seed captured the newest position, so move the cursor back to before m-1
    // to simulate a mid-stream backlog.
    const seeded = h.store.load(ACTOR);
    if (!seeded.brief) throw new Error("expected seeded brief");
    h.store.save({
      ...seeded,
      brief: { ...seeded.brief, cursor: null },
    });
    for (let i = 0; i < 3; i++) {
      await runPortableContextBriefCycle(h.deps); // all fail (resolveRef false + "bad")
    }
    expect(h.store.load(ACTOR).brief?.frozen).toBe(true);

    // An ancestor reply already present in the failed slice cannot release it.
    expect(await runPortableContextBriefCycle(h.deps)).toEqual({ outcome: "frozen" });
    h.markAttentionHandled(h.attention[0].id);
    const outcome = await runPortableContextBriefCycle(h.deps);
    expect(outcome).toMatchObject({ outcome: "accepted", released: true });
    expect(h.store.load(ACTOR).brief?.frozen).toBe(false);
    expect(h.store.load(ACTOR).brief?.consecutiveFailures).toBe(0);
  });

  it("handled-state predicate distinguishes absent, unhandled and handled exact entries", () => {
    const db = new Database(":memory:");
    actorInbox.up(db);
    actorInboxSeen.up(db);
    actorInboxHandledNote.up(db);
    const inbox = new SqliteInboxRepository(db);
    const [entry] = inbox.append([
      {
        actorId: "parent-a",
        source: `portable_context_brief:${ACTOR}`,
        payload: { type: "portable_context_brief.needs_attention", actorId: ACTOR, reason: "r" },
      },
    ]);
    const handled = isBriefAttentionHandled(inbox);
    // Absent: unknown id, and the right id looked up under another (e.g. new) parent.
    expect(handled({ ownerId: "parent-a", entryId: "no-such-entry" })).toBe(false);
    expect(handled({ ownerId: "parent-b", entryId: entry.id })).toBe(false);
    // Present but unhandled.
    expect(handled({ ownerId: "parent-a", entryId: entry.id })).toBe(false);
    inbox.markHandled("parent-a", [entry.id], undefined, "looked at the brief freeze");
    expect(handled({ ownerId: "parent-a", entryId: entry.id })).toBe(true);
    db.close();
  });

  it("keeps the freeze when its attention entry is absent, and looks it up under the raising owner", async () => {
    const msg = chatSource("m-1", "2026-10-07T00:00:01Z", "root", "ancestor note");
    const h = cycleHarness({ sources: [msg], rewriterText: Array(7).fill("bad") });
    const lookups: Array<{ ownerId: string; entryId: string }> = [];
    const deps: BriefCycleDeps = {
      ...h.deps,
      isAttentionHandled: (attention) => {
        lookups.push(attention);
        return false; // the inbox has no handled row for it
      },
    };
    await runPortableContextBriefCycle(deps); // seed
    const seeded = h.store.load(ACTOR);
    if (!seeded.brief) throw new Error("expected seeded brief");
    h.store.save({ ...seeded, brief: { ...seeded.brief, cursor: null } });
    for (let i = 0; i < 3; i++) await runPortableContextBriefCycle(deps);
    const frozen = h.store.load(ACTOR).brief;
    expect(frozen).toMatchObject({
      frozen: true,
      freezeAttentionId: "attention-1",
      freezeAttentionOwnerId: "parent-of-actor",
    });
    expect(await runPortableContextBriefCycle(deps)).toEqual({ outcome: "frozen" });
    expect(lookups).toEqual([{ ownerId: "parent-of-actor", entryId: "attention-1" }]);
  });

  it("a failed streak does not grow the input: identical slice, identical input bytes", async () => {
    const sources = [
      chatSource("m-1", "2026-10-07T00:00:01Z", "root", "one"),
      chatSource("m-2", "2026-10-07T00:00:02Z", "root", "two"),
      chatSource("m-3", "2026-10-07T00:00:03Z", "root", "three"),
    ];
    const h = cycleHarness({ sources, rewriterText: ["bad", "bad", "bad", "bad", "bad", "bad"] });
    await runPortableContextBriefCycle(h.deps); // seed
    await runPortableContextBriefCycle(h.deps);
    const secondInputs = h.attempts.map((a) => a.inputBytes);
    await runPortableContextBriefCycle(h.deps);
    const thirdInputs = h.attempts.slice(secondInputs.length).map((a) => a.inputBytes);
    expect(thirdInputs).toEqual(secondInputs);
  });

  it("retains an oversized source outside the model request and freezes through explicit attention", async () => {
    const big = "x".repeat(100 * 1024);
    const sources = [
      chatSource("m-1", "2026-10-07T00:00:01Z", "root", big),
      chatSource("m-2", "2026-10-07T00:00:02Z", "human:operator", "small"),
    ];
    const h = cycleHarness({ sources, rewriterText: [], seedPosition: null });
    await runPortableContextBriefCycle(h.deps); // seed
    for (let i = 0; i < 3; i++) {
      expect(await runPortableContextBriefCycle(h.deps)).toMatchObject({ outcome: "rejected" });
    }
    expect(h.rewriter.rewrite).not.toHaveBeenCalled();
    expect(h.attempts.every((attempt) => attempt.inputBytes === 0)).toBe(true);
    const brief = h.store.load(ACTOR).brief;
    expect(brief?.cursor).toBeNull();
    expect(brief?.generation).toBe(0);
    expect(brief?.text).toBe(SEED_TEXT);
    expect(brief?.frozen).toBe(true);
    expect(brief?.oversizedBlock).toMatchObject({
      sourceRef: "mesh:messages/m-1",
      sourcePosition: { ts: "2026-10-07T00:00:01Z", sourceOrder: 0, id: "m-1" },
      byteSize: 100 * 1024,
      byteLimit: 96 * 1024,
    });
    expect(h.attention).toHaveLength(1);
  });

  it("handled attention acknowledges an oversized block without releasing it, making zero model calls and no duplicate attention", async () => {
    const big = "x".repeat(100 * 1024);
    const sources = [chatSource("m-1", "2026-10-07T00:00:01Z", "root", big)];
    let handled = false;
    const h = cycleHarness({ sources, rewriterText: [], seedPosition: null });
    const deps: BriefCycleDeps = {
      ...h.deps,
      isAttentionHandled: () => handled,
    };
    await runPortableContextBriefCycle(deps); // seed
    for (let i = 0; i < 3; i++) {
      await runPortableContextBriefCycle(deps);
    }
    const stateBefore = h.store.load(ACTOR);
    expect(stateBefore.brief?.frozen).toBe(true);
    expect(stateBefore.brief?.oversizedBlock).not.toBeNull();
    expect(h.attention).toHaveLength(1);

    // Operator/parent handles the attention entry
    handled = true;
    const outcome = await runPortableContextBriefCycle(deps);
    expect(outcome).toEqual({ outcome: "frozen" });

    // Zero model calls made
    expect(h.rewriter.rewrite).not.toHaveBeenCalled();
    // No duplicate attention raised
    expect(h.attention).toHaveLength(1);

    // State preserved: text, cursor, generation, oversizedBlock remain exact
    const stateAfter = h.store.load(ACTOR);
    expect(stateAfter.brief?.frozen).toBe(true);
    expect(stateAfter.brief?.text).toBe(stateBefore.brief?.text);
    expect(stateAfter.brief?.cursor).toEqual(stateBefore.brief?.cursor);
    expect(stateAfter.brief?.generation).toBe(stateBefore.brief?.generation);
    expect(stateAfter.brief?.oversizedBlock).toEqual(stateBefore.brief?.oversizedBlock);
  });

  it("process restart retains the exact oversized block across runs with zero model calls", async () => {
    const big = "x".repeat(100 * 1024);
    const sources = [chatSource("m-1", "2026-10-07T00:00:01Z", "root", big)];
    const h = cycleHarness({ sources, rewriterText: [], seedPosition: null });
    await runPortableContextBriefCycle(h.deps); // seed
    for (let i = 0; i < 3; i++) {
      await runPortableContextBriefCycle(h.deps);
    }
    const savedState = h.store.load(ACTOR);
    expect(savedState.brief?.oversizedBlock).not.toBeNull();

    // Fresh process / cycle deps reusing only the persistent store
    const restartedH = cycleHarness({
      sources,
      rewriterText: [],
      store: h.store,
      seedPosition: null,
    });
    const restartedOutcome = await runPortableContextBriefCycle(restartedH.deps);
    expect(restartedOutcome).toEqual({ outcome: "frozen" });
    expect(restartedH.rewriter.rewrite).not.toHaveBeenCalled();
    expect(restartedH.attention).toHaveLength(0); // no duplicate attention in fresh process

    const loadedAfterRestart = h.store.load(ACTOR);
    expect(loadedAfterRestart.brief).toEqual(savedState.brief);
  });

  it("ordinary retry recovery still releases on handled attention when oversizedBlock is null", async () => {
    const msg = chatSource("m-1", "2026-10-07T00:00:01Z", "root", "ancestor note");
    let handled = false;
    const validReplacement =
      `## WHAT\nThe charter is in force; it is rendered in the prompt. [mesh:actors/${ACTOR}/charter]\n` +
      `Updated purpose. [mesh:messages/m-1]\n\n## HOW\n\n## DOMAIN\n`;
    const h = cycleHarness({
      sources: [msg],
      rewriterText: ["bad", "bad", "bad", "bad", "bad", "bad", validReplacement],
      seedPosition: null,
    });
    const deps: BriefCycleDeps = {
      ...h.deps,
      isAttentionHandled: () => handled,
    };
    await runPortableContextBriefCycle(deps); // seed
    for (let i = 0; i < 3; i++) {
      await runPortableContextBriefCycle(deps);
    }
    const frozenState = h.store.load(ACTOR).brief;
    expect(frozenState?.frozen).toBe(true);
    expect(frozenState?.oversizedBlock).toBeNull();
    expect(frozenState?.consecutiveFailures).toBe(3);

    // Unhandled: stays frozen
    expect(await runPortableContextBriefCycle(deps)).toEqual({ outcome: "frozen" });

    // Handled: releases freeze and retries, accepting the valid rewrite
    handled = true;
    const acceptedOutcome = await runPortableContextBriefCycle(deps);
    expect(acceptedOutcome).toMatchObject({ outcome: "accepted", released: true });
    const recoveredBrief = h.store.load(ACTOR).brief;
    expect(recoveredBrief?.frozen).toBe(false);
    expect(recoveredBrief?.consecutiveFailures).toBe(0);
    expect(recoveredBrief?.oversizedBlock).toBeNull();
  });

  it("switching to ledger mode and back preserves the blocked brief snapshot byte-identically", () => {
    const blockedBrief: PortableBrief = {
      text: SEED_TEXT,
      cursor: null,
      generation: 2,
      model: "gemini-3.8-flash",
      updatedAt: "2026-10-08T09:00:00Z",
      consecutiveFailures: 3,
      frozen: true,
      freezeAttentionId: "attention-oversized-1",
      freezeAttentionOwnerId: "parent-actor",
      oversizedBlock: {
        sourceRef: "mesh:messages/m-blocked",
        sourcePosition: { ts: "2026-10-08T09:00:01Z", sourceOrder: 0, id: "m-blocked" },
        byteSize: 150 * 1024,
        byteLimit: 96 * 1024,
        observedAt: "2026-10-08T09:00:00Z",
      },
      resolvedRefs: [`mesh:actors/${ACTOR}/charter`],
      supersessions: [],
      citationAuthorities: {},
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
      brief: blockedBrief,
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

    // The snapshot document still retains the blocked brief completely untouched
    expect(state.brief).toEqual(blockedBrief);

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
    expect(state.brief).toEqual(blockedBrief);
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
      brief: {
        text: SEED_TEXT,
        cursor: { ts: "2026-10-07T00:00:00Z", sourceOrder: 0, id: "m-1" },
        generation: 7,
        model: "gemini-3.8-flash",
        updatedAt: "2026-10-07T01:00:00Z",
        consecutiveFailures: 0,
        frozen: false,
        freezeAttentionId: null,
        freezeAttentionOwnerId: null,
        oversizedBlock: null,
        resolvedRefs: [`mesh:actors/${ACTOR}/charter`],
        supersessions: [],
        citationAuthorities: {},
      },
    };
    const portable = assemblePortableContextV2({
      state,
      messages: [{ id: "m-1", ts: "2026-10-07T00:00:00Z", sender: "root", body: "hello" }],
      runs: [],
      brief: state.brief,
    });
    expect(portable).not.toBeNull();
    expect(portable?.section).toContain("### Durable brief (mode: brief, generation 7");
    expect(portable?.section).toContain(`cursor 2026-10-07T00:00:00Z#0/m-1`);
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
