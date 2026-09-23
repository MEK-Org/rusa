import { describe, expect, it } from "vitest";
import {
  type JevChoiceClient,
  ShadowResponsiveInterruptionClassifier,
} from "./responsive-interruption.js";

describe("ShadowResponsiveInterruptionClassifier", () => {
  it("uses two closed choices over stable inbox ids and emits a redacted queue decision", async () => {
    const calls: Array<{ id: string; choices: readonly string[]; input: unknown }> = [];
    const client: JevChoiceClient = {
      choose: async (request) => {
        calls.push(request);
        if (request.id === "comparison") {
          return {
            choice: "selected-a",
            confidence: 0.96,
            probabilities: { "selected-a": 0.96 } as Record<string, number>,
          };
        }
        return {
          choice: "unrelated",
          confidence: 0.98,
          probabilities: { unrelated: 0.98 } as Record<string, number>,
        };
      },
    };
    const classifier = new ShadowResponsiveInterruptionClassifier({ client, threshold: 0.8 });

    const decision = await classifier.evaluate({
      incomingEntryId: "incoming-z",
      selectedEntryIds: ["selected-a", "selected-b"],
      pendingEntryIds: ["pending-c"],
    });

    expect(calls).toEqual([
      {
        id: "comparison",
        choices: ["selected-a", "selected-b", "none"],
        input: {
          incomingEntryId: "incoming-z",
          comparisonEntryIds: ["selected-a", "selected-b"],
          phase: "comparison",
        },
      },
      {
        id: "relation",
        choices: ["reversal", "refinement", "correction", "cancellation", "unrelated"],
        input: {
          incomingEntryId: "incoming-z",
          comparisonEntryId: "selected-a",
          phase: "relation",
        },
      },
    ]);
    expect(decision).toEqual({
      outcome: "queue",
      incomingEntryId: "incoming-z",
      comparisonEntryId: "selected-a",
      relation: "unrelated",
      threshold: 0.8,
      comparison: { choice: "selected-a", confidence: 0.96, probabilities: { "selected-a": 0.96 } },
      relationDecision: {
        choice: "unrelated",
        confidence: 0.98,
        probabilities: { unrelated: 0.98 },
      },
      input: {
        incomingEntryId: "incoming-z",
        selectedEntryIds: ["selected-a", "selected-b"],
        pendingEntryIds: ["pending-c"],
      },
    });
  });

  it("compares against unselected rows only when nothing is selected", async () => {
    const offered: Array<readonly string[]> = [];
    const client: JevChoiceClient = {
      choose: async (request) => {
        if (request.id === "comparison") {
          offered.push(request.choices);
          return { choice: "pending-c", confidence: 1 };
        }
        return { choice: "refinement", confidence: 1 };
      },
    };
    const classifier = new ShadowResponsiveInterruptionClassifier({ client, threshold: 0.8 });

    await expect(
      classifier.evaluate({
        incomingEntryId: "incoming-z",
        selectedEntryIds: [],
        pendingEntryIds: ["pending-c"],
      })
    ).resolves.toMatchObject({ outcome: "interrupt", comparisonEntryId: "pending-c" });
    expect(offered).toEqual([["pending-c", "none"]]);
  });

  it("reports an unavailable decision when no client is wired", async () => {
    const classifier = new ShadowResponsiveInterruptionClassifier({ threshold: 0.8 });

    await expect(
      classifier.evaluate({
        incomingEntryId: "incoming-z",
        selectedEntryIds: ["selected-a"],
        pendingEntryIds: ["pending-c"],
      })
    ).resolves.toEqual({
      outcome: "queue",
      reason: "unavailable",
      incomingEntryId: "incoming-z",
      comparisonEntryId: null,
      relation: null,
      threshold: 0.8,
      input: {
        incomingEntryId: "incoming-z",
        selectedEntryIds: ["selected-a"],
        pendingEntryIds: ["pending-c"],
      },
    });
  });

  it("queues without asking when nothing can be compared against", async () => {
    let asked = false;
    const classifier = new ShadowResponsiveInterruptionClassifier({
      client: {
        choose: async () => {
          asked = true;
          return { choice: "none", confidence: 1 };
        },
      },
      threshold: 0.8,
    });

    await expect(
      classifier.evaluate({
        incomingEntryId: "incoming-z",
        selectedEntryIds: [],
        pendingEntryIds: [],
      })
    ).resolves.toMatchObject({ outcome: "queue", reason: "no_comparison" });
    expect(asked).toBe(false);
  });

  it("distinguishes a malformed confidence from an out-of-set choice", async () => {
    const evaluate = (response: { choice: string; confidence: number }) =>
      new ShadowResponsiveInterruptionClassifier({
        client: { choose: async () => response },
        threshold: 0.8,
      }).evaluate({
        incomingEntryId: "incoming-z",
        selectedEntryIds: ["selected-a"],
        pendingEntryIds: [],
      });

    await expect(evaluate({ choice: "not-an-id", confidence: 1 })).resolves.toMatchObject({
      outcome: "queue",
      reason: "invalid_comparison_choice",
    });
    await expect(evaluate({ choice: "selected-a", confidence: Number.NaN })).resolves.toMatchObject(
      {
        outcome: "queue",
        reason: "invalid_comparison_confidence",
      }
    );
  });

  it("separates a failed client call from an absent one", async () => {
    const classifier = new ShadowResponsiveInterruptionClassifier({
      client: {
        choose: async () => {
          throw new Error("local fixture is down");
        },
      },
      threshold: 0.8,
    });

    await expect(
      classifier.evaluate({
        incomingEntryId: "incoming-z",
        selectedEntryIds: ["selected-a"],
        pendingEntryIds: [],
      })
    ).resolves.toMatchObject({ outcome: "queue", reason: "client_error" });
  });

  it("keeps only offered choices and real weights out of a defective probability map", async () => {
    const classifier = new ShadowResponsiveInterruptionClassifier({
      client: {
        choose: async (request) =>
          request.id === "comparison"
            ? {
                choice: "selected-a",
                confidence: 1,
                probabilities: {
                  "selected-a": 0.9,
                  "operator said: ship it now": 0.1,
                  none: Number.POSITIVE_INFINITY,
                } as Record<string, number>,
              }
            : {
                choice: "refinement",
                confidence: 1,
                probabilities: { refinement: 1, "leaked note": 2 } as Record<string, number>,
              },
      },
      threshold: 0.8,
    });

    const decision = await classifier.evaluate({
      incomingEntryId: "incoming-z",
      selectedEntryIds: ["selected-a"],
      pendingEntryIds: [],
    });

    expect(decision).toMatchObject({
      outcome: "interrupt",
      comparison: { probabilities: { "selected-a": 0.9 } },
      relationDecision: { probabilities: { refinement: 1 } },
    });
    expect(JSON.stringify(decision)).not.toContain("ship it now");
    expect(JSON.stringify(decision)).not.toContain("leaked note");
  });

  it("queues a deliberate none choice without asking for a relation", async () => {
    const calls: string[] = [];
    const classifier = new ShadowResponsiveInterruptionClassifier({
      client: {
        choose: async (request) => {
          calls.push(request.id);
          return { choice: "none", confidence: 1 };
        },
      },
      threshold: 0.8,
    });

    await expect(
      classifier.evaluate({
        incomingEntryId: "incoming-z",
        selectedEntryIds: [],
        pendingEntryIds: ["pending-c"],
      })
    ).resolves.toMatchObject({ outcome: "queue", reason: "no_comparison" });
    expect(calls).toEqual(["comparison"]);
  });
});
