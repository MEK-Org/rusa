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
        choices: ["selected-a", "selected-b", "pending-c", "none"],
        input: {
          incomingEntryId: "incoming-z",
          comparisonEntryIds: ["selected-a", "selected-b", "pending-c"],
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

  it("fails safely to queue when Choice output is invalid", async () => {
    const classifier = new ShadowResponsiveInterruptionClassifier({
      client: { choose: async () => ({ choice: "not-an-id", confidence: 1 }) },
      threshold: 0.8,
    });

    await expect(
      classifier.evaluate({
        incomingEntryId: "incoming-z",
        selectedEntryIds: [],
        pendingEntryIds: ["pending-c"],
      })
    ).resolves.toEqual({
      outcome: "queue",
      incomingEntryId: "incoming-z",
      comparisonEntryId: null,
      relation: null,
      threshold: 0.8,
      reason: "invalid_comparison_choice",
      input: {
        incomingEntryId: "incoming-z",
        selectedEntryIds: [],
        pendingEntryIds: ["pending-c"],
      },
    });
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
