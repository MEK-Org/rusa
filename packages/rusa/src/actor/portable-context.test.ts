import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { type Obligation, parseExternalRef } from "../obligations/obligation.js";
import {
  assemblePortableContext,
  assemblePortableContextV2,
  composeHostContextIntoPrompt,
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
import { emptyPortableContextState, type PortableBrief } from "./portable-context-state.js";

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
  it("injects brief when provided and omits when null/undefined", () => {
    const brief: PortableBrief = {
      text: "WHAT: Build foo\nHOW: Using bar",
      generation: 2,
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const portable = assemblePortableContextV2({
      state: emptyPortableContextState("actor-a"),
      brief,
      messages: [{ id: "m1", ts: "2026-10-01T01:00:00.000Z", sender: "root", body: "Hello" }],
      runs: [],
    });
    expect(portable).not.toBeNull();
    expect(portable?.section).toContain("### Durable brief");
    expect(portable?.section).toContain("WHAT: Build foo");
    expect(portable?.section).toContain("HOW: Using bar");
  });

  it("omits durable brief section in tail mode (brief omitted)", () => {
    const portable = assemblePortableContextV2({
      state: emptyPortableContextState("actor-a"),
      messages: [{ id: "m1", ts: "2026-10-01T01:00:00.000Z", sender: "root", body: "Hello" }],
      runs: [],
    });
    expect(portable).not.toBeNull();
    expect(portable?.section).not.toContain("### Durable brief");
    expect(portable?.section).not.toContain("### Durable intent");
    expect(portable?.section).toContain("Hello");
  });

  it("returns null when no sections have content", () => {
    const portable = assemblePortableContextV2({
      state: emptyPortableContextState("actor-a"),
      messages: [],
      runs: [],
    });
    expect(portable).toBeNull();
  });

  it("keeps the combined v2 prompt under the existing byte ceiling", () => {
    const portable = assemblePortableContextV2({
      state: emptyPortableContextState("actor-a"),
      brief: { text: "b".repeat(10_000), generation: 1, updatedAt: "2026-10-01T00:00:00.000Z" },
      messages: [
        { id: "m1", ts: "2026-07-21T00:00:00.000Z", sender: "root", body: "m".repeat(20_000) },
      ],
      runs: [run("r1", "r".repeat(50_000))],
    });
    if (!portable) throw new Error("expected v2 portable context");
    expect(portable.record.bytes).toBeLessThanOrEqual(PORTABLE_CONTEXT_MAX_BYTES);
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
        const brief = {
          text: "s".repeat(16_000),
          generation: 1,
          updatedAt: "2026-10-01T00:00:00.000Z",
        };
        const newest = sized("run-newest", "2026-10-18T08:00:00.000Z", 6_000);
        const older = sized("run-older", "2026-10-18T07:00:00.000Z", 1_000);
        const leaderBuild = assemblePortableContextV2({
          state,
          brief,
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
