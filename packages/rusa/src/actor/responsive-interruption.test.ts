import { describe, expect, it } from "vitest";
import {
  type JevDecisionClient,
  type JevDecisionRequest,
  SHADOW_INTERRUPT_EMOJI,
  SHADOW_QUEUE_EMOJI,
  ShadowResponsiveInterruptionClassifier,
  shadowReactionTarget,
  shadowVerdictEmoji,
} from "./responsive-interruption.js";
import {
  AMBIGUOUS_FIXTURE,
  CLEAR_MATCH_FIXTURE,
  type FixtureEntry,
  type ResponsiveInterruptionFixture,
  SCALE_FIXTURE,
} from "./responsive-interruption-fixtures.js";

/**
 * A client that answers from the fixture bodies rather than from ids, so a
 * passing test means the decision shape carried real reasoning through — not
 * that a stub recognised a name. It scores overlap of content words and is
 * confident only when one candidate leads the field.
 */
function fixtureClient(fixture: ResponsiveInterruptionFixture): JevDecisionClient {
  const byId = new Map<string, FixtureEntry>(
    [fixture.incoming, ...fixture.candidates].map((entry) => [entry.id, entry])
  );
  const words = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 3)
    );
  return {
    decide: async (request) => {
      const incoming = words(byId.get(request.input.incomingEntryId)?.body ?? "");
      const scored = request.input.candidateEntryIds
        .map((id) => {
          const candidate = words(byId.get(id)?.body ?? "");
          let shared = 0;
          for (const word of incoming) if (candidate.has(word)) shared++;
          return { id, score: shared };
        })
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      const best = scored[0];
      const runnerUp = scored[1];
      if (!best || best.score === 0) return { verdict: "queue", confidence: 0.95 };
      // A lead over the field is what makes a match a match. Without one the
      // client says so through its confidence rather than picking a winner.
      const lead = best.score - (runnerUp?.score ?? 0);
      const confidence = lead >= 2 ? 0.94 : 0.41;
      return {
        verdict: lead >= 2 ? "interrupt" : "queue",
        confidence,
        rationale: `overlap ${best.score}, lead ${lead}`,
        matchedCandidateIds: lead >= 2 ? [best.id] : [],
      };
    },
  };
}

const client = (decide: JevDecisionClient["decide"]): JevDecisionClient => ({ decide });

describe("ShadowResponsiveInterruptionClassifier", () => {
  it("asks one open-ended decision over the candidate ids and audits ids only", async () => {
    const asked: JevDecisionRequest[] = [];
    const classifier = new ShadowResponsiveInterruptionClassifier({
      threshold: 0.8,
      client: client(async (request) => {
        asked.push(request);
        return {
          verdict: "interrupt",
          confidence: 0.91,
          rationale: "the arriving item cancels selected-a",
          matchedCandidateIds: ["selected-a"],
        };
      }),
    });

    const decision = await classifier.evaluate({
      incomingEntryId: "incoming-z",
      selectedEntryIds: ["selected-a", "selected-b"],
      pendingEntryIds: ["pending-c"],
    });

    // One call, not a comparison round followed by a relation round.
    expect(asked).toHaveLength(1);
    expect(asked[0].input).toEqual({
      incomingEntryId: "incoming-z",
      candidateEntryIds: ["selected-a", "selected-b"],
      candidateSource: "selected",
    });
    expect(asked[0].question).toContain("should we interrupt");

    expect(decision).toEqual({
      outcome: "interrupt",
      verdict: "interrupt",
      confidence: 0.91,
      matchedCandidateIds: ["selected-a"],
      incomingEntryId: "incoming-z",
      candidateSource: "selected",
      threshold: 0.8,
      input: {
        incomingEntryId: "incoming-z",
        selectedEntryIds: ["selected-a", "selected-b"],
        pendingEntryIds: ["pending-c"],
      },
    });
  });

  it("keeps the model's prose out of the decision entirely", async () => {
    // The rationale is useful to a human reading a live response and is exactly
    // the field that could smuggle message text into a durable record. The
    // seam accepts it; the decision never carries it.
    const classifier = new ShadowResponsiveInterruptionClassifier({
      threshold: 0.8,
      client: client(async () => ({
        verdict: "interrupt",
        confidence: 0.99,
        rationale: "because the operator wrote 'cancel the payroll run for alice@example.com'",
        matchedCandidateIds: ["selected-a"],
      })),
    });

    const decision = await classifier.evaluate({
      incomingEntryId: "incoming-z",
      selectedEntryIds: ["selected-a"],
      pendingEntryIds: [],
    });

    expect(JSON.stringify(decision)).not.toContain("payroll");
    expect(JSON.stringify(decision)).not.toContain("example.com");
    expect(decision).not.toHaveProperty("rationale");
  });

  it("drops matched ids the client did not get offered", async () => {
    // A defective or future client must not be able to write arbitrary text
    // into the audit through the one free-form-looking field that survives.
    const classifier = new ShadowResponsiveInterruptionClassifier({
      threshold: 0.8,
      client: client(async () => ({
        verdict: "interrupt",
        confidence: 0.99,
        matchedCandidateIds: ["selected-a", "an entry that was never offered", "selected-a"],
      })),
    });

    const decision = await classifier.evaluate({
      incomingEntryId: "incoming-z",
      selectedEntryIds: ["selected-a", "selected-b"],
      pendingEntryIds: [],
    });

    expect(decision).toMatchObject({
      outcome: "interrupt",
      matchedCandidateIds: ["selected-a"],
    });
  });

  it("prefers selected work and falls back to pending only when nothing is selected", async () => {
    const asked: JevDecisionRequest[] = [];
    const classifier = new ShadowResponsiveInterruptionClassifier({
      threshold: 0.8,
      client: client(async (request) => {
        asked.push(request);
        return { verdict: "queue", confidence: 0.9 };
      }),
    });

    await classifier.evaluate({
      incomingEntryId: "incoming-z",
      selectedEntryIds: [],
      pendingEntryIds: ["pending-c", "pending-d"],
    });

    expect(asked[0].input).toEqual({
      incomingEntryId: "incoming-z",
      candidateEntryIds: ["pending-c", "pending-d"],
      candidateSource: "pending",
    });
  });

  it("never offers the arriving item as a candidate against itself", async () => {
    const asked: JevDecisionRequest[] = [];
    const classifier = new ShadowResponsiveInterruptionClassifier({
      threshold: 0.8,
      client: client(async (request) => {
        asked.push(request);
        return { verdict: "queue", confidence: 0.9 };
      }),
    });

    await classifier.evaluate({
      incomingEntryId: "incoming-z",
      selectedEntryIds: ["selected-a", "incoming-z", "selected-a"],
      pendingEntryIds: [],
    });

    expect(asked[0].input.candidateEntryIds).toEqual(["selected-a"]);
  });

  describe("fails closed to queue", () => {
    const cases: Array<{ what: string; response: unknown; reason: string }> = [
      {
        what: "an unrecognised verdict",
        response: { verdict: "maybe", confidence: 0.99 },
        reason: "invalid_verdict",
      },
      {
        what: "a confidence above one",
        response: { verdict: "interrupt", confidence: 1.4 },
        reason: "invalid_confidence",
      },
      {
        what: "a NaN confidence",
        response: { verdict: "interrupt", confidence: Number.NaN },
        reason: "invalid_confidence",
      },
    ];
    for (const { what, response, reason } of cases) {
      it(`queues on ${what}`, async () => {
        const classifier = new ShadowResponsiveInterruptionClassifier({
          threshold: 0.8,
          client: client(async () => response as never),
        });
        const decision = await classifier.evaluate({
          incomingEntryId: "incoming-z",
          selectedEntryIds: ["selected-a"],
          pendingEntryIds: [],
        });
        expect(decision).toMatchObject({ outcome: "queue", reason });
      });
    }

    it("queues when the client throws, without propagating", async () => {
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.8,
        client: client(async () => {
          throw new Error("socket hang up");
        }),
      });
      const decision = await classifier.evaluate({
        incomingEntryId: "incoming-z",
        selectedEntryIds: ["selected-a"],
        pendingEntryIds: [],
      });
      expect(decision).toMatchObject({ outcome: "queue", reason: "client_error" });
      // The failure text is the other route by which operational content could
      // reach the audit. It does not.
      expect(JSON.stringify(decision)).not.toContain("socket hang up");
    });

    it("queues when the client exceeds its deadline", async () => {
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.8,
        timeoutMs: 10,
        client: client(() => new Promise(() => {})),
      });
      const decision = await classifier.evaluate({
        incomingEntryId: "incoming-z",
        selectedEntryIds: ["selected-a"],
        pendingEntryIds: [],
      });
      expect(decision).toMatchObject({ outcome: "queue", reason: "timeout" });
    });

    it("queues an interrupt the client is not confident enough about, keeping the confidence", async () => {
      // A threshold cannot be tuned from records that discard the confidence
      // they rejected.
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.8,
        client: client(async () => ({
          verdict: "interrupt",
          confidence: 0.62,
          matchedCandidateIds: ["selected-a"],
        })),
      });
      const decision = await classifier.evaluate({
        incomingEntryId: "incoming-z",
        selectedEntryIds: ["selected-a"],
        pendingEntryIds: [],
      });
      expect(decision).toMatchObject({
        outcome: "queue",
        reason: "low_confidence",
        confidence: 0.62,
        matchedCandidateIds: ["selected-a"],
      });
    });

    it("queues with no client at all, and asks nothing", async () => {
      const classifier = new ShadowResponsiveInterruptionClassifier({ threshold: 0.8 });
      const decision = await classifier.evaluate({
        incomingEntryId: "incoming-z",
        selectedEntryIds: ["selected-a"],
        pendingEntryIds: [],
      });
      expect(decision).toMatchObject({ outcome: "queue", reason: "unavailable" });
    });

    it("queues without a round trip when there is nothing to compare against", async () => {
      let asked = 0;
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.8,
        client: client(async () => {
          asked++;
          return { verdict: "interrupt", confidence: 0.99 };
        }),
      });
      const decision = await classifier.evaluate({
        incomingEntryId: "incoming-z",
        selectedEntryIds: [],
        pendingEntryIds: [],
      });
      expect(decision).toMatchObject({ outcome: "queue", reason: "no_candidates" });
      expect(asked).toBe(0);
    });
  });

  describe("against the synthetic corpus", () => {
    const evaluate = (fixture: ResponsiveInterruptionFixture) =>
      new ShadowResponsiveInterruptionClassifier({
        threshold: 0.8,
        client: fixtureClient(fixture),
      }).evaluate({
        incomingEntryId: fixture.incoming.id,
        selectedEntryIds: fixture.candidates.map((entry) => entry.id),
        pendingEntryIds: [],
      });

    it(`interrupts on ${CLEAR_MATCH_FIXTURE.name}`, async () => {
      const decision = await evaluate(CLEAR_MATCH_FIXTURE);
      expect(decision).toMatchObject({
        outcome: "interrupt",
        matchedCandidateIds: CLEAR_MATCH_FIXTURE.trueMatchIds,
      });
    });

    it(`queues on ${AMBIGUOUS_FIXTURE.name} rather than guessing`, async () => {
      // The cost of being wrong here is a false preemption of real work, so
      // the right behaviour is an unconfident queue, not a plausible pick.
      const decision = await evaluate(AMBIGUOUS_FIXTURE);
      expect(decision).toMatchObject({ outcome: "queue" });
      expect(decision).not.toMatchObject({ outcome: "interrupt" });
    });

    it(`still finds the one match inside ${SCALE_FIXTURE.name}`, async () => {
      const decision = await evaluate(SCALE_FIXTURE);
      expect(decision).toMatchObject({
        outcome: "interrupt",
        matchedCandidateIds: SCALE_FIXTURE.trueMatchIds,
      });
    });

    it("offers every candidate at scale rather than a convenient first page", async () => {
      const asked: JevDecisionRequest[] = [];
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.8,
        client: client(async (request) => {
          asked.push(request);
          return { verdict: "queue", confidence: 0.9 };
        }),
      });
      await classifier.evaluate({
        incomingEntryId: SCALE_FIXTURE.incoming.id,
        selectedEntryIds: SCALE_FIXTURE.candidates.map((entry) => entry.id),
        pendingEntryIds: [],
      });
      expect(asked[0].input.candidateEntryIds).toHaveLength(SCALE_FIXTURE.candidates.length);
    });
  });
});

describe("shadowVerdictEmoji", () => {
  it("maps a would-interrupt to ✅ and a would-queue to ❌", () => {
    expect(shadowVerdictEmoji("interrupt")).toBe(SHADOW_INTERRUPT_EMOJI);
    expect(shadowVerdictEmoji("queue")).toBe(SHADOW_QUEUE_EMOJI);
    expect(SHADOW_INTERRUPT_EMOJI).toBe("✅");
    expect(SHADOW_QUEUE_EMOJI).toBe("❌");
  });
});

describe("shadowReactionTarget", () => {
  const gchat = (messageName: unknown) => ({ type: "gchat.message", messageName });

  it("reacts on the arriving chat message with the verdict's emoji", () => {
    expect(shadowReactionTarget(gchat("spaces/s/messages/m"), "interrupt")).toEqual({
      messageName: "spaces/s/messages/m",
      emoji: SHADOW_INTERRUPT_EMOJI,
    });
    expect(shadowReactionTarget(gchat("spaces/s/messages/m"), "queue")).toEqual({
      messageName: "spaces/s/messages/m",
      emoji: SHADOW_QUEUE_EMOJI,
    });
  });

  it("has nothing to react to for an arrival that did not come from chat", () => {
    // A GitHub or mesh arrival is classified just the same; it simply has no
    // chat message to carry the verdict, so the audit row is the only record.
    expect(shadowReactionTarget({ type: "issue_comment.created", commentId: 7 }, "interrupt")).toBe(
      null
    );
  });

  it("has nothing to react to when the chat pointer is missing or malformed", () => {
    expect(shadowReactionTarget(gchat(undefined), "interrupt")).toBe(null);
    expect(shadowReactionTarget(gchat(""), "interrupt")).toBe(null);
    expect(shadowReactionTarget(gchat(42), "interrupt")).toBe(null);
  });
});
