import { describe, expect, it, vi } from "vitest";
import type { PortableLedgerSource } from "../db/repositories/actor-run-repository.js";
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
}

function cycleHarness(options: CycleHarnessOptions) {
  const store = new InMemoryPortableContextStore();
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
      return id;
    },
    isAttentionHandled: (id) => handledAttention.has(id),
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
    // "and more prose" is not a bracketed citation, so the line keeps it in the
    // statement — which is fine for the parser; validation catches state text.
    expect(parseBriefDocument(trailingProse).errors).toEqual([]);
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
    expect(errors.join("\n")).toContain("dropped without equally cited human/ancestor");
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
    expect(errors.join("\n")).toContain("previous HOW line(s) dropped");
  });

  it("allows at most one changed DOMAIN line for a milestone delta", () => {
    const previous = `${seed}Existing domain principle. [mesh:messages/old]\n`;
    const candidate =
      `${previous}First new principle. [mesh:messages/milestone]\n` +
      `Second new principle. [mesh:messages/milestone]\n`;
    const errors = validateBriefText({
      text: candidate,
      previousText: previous,
      authorityCitations: new Set(),
      milestone: true,
    }).errors;
    expect(errors.join("\n")).toContain("milestone delta changed 2 DOMAIN lines");
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
      currentText: SEED_TEXT,
      delta: [],
      validatorErrors: ["WHAT line changed without a cited human/ancestor supersession"],
    });
    expect(repair).toContain("Validator errors to correct");
    expect(repair).toContain("repair retry");
  });

  it("bounds repair diagnostics in UTF-8 bytes", () => {
    const repair = buildBriefRewritePrompt({
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
    expect(h.store.load(ACTOR).brief?.cursor).toBeNull();
    expect(h.store.load(ACTOR).brief?.frozen).toBe(true);
    expect(h.attention).toHaveLength(1);
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
        resolvedRefs: [`mesh:actors/${ACTOR}/charter`],
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
