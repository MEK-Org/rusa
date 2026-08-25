import { beforeEach, describe, expect, it, vi } from "vitest";

const gemini = vi.hoisted(() => ({
  generateContent: vi.fn(),
}));

vi.mock("./gemini-utils.js", () => ({
  getGeminiClient: () => ({ models: { generateContent: gemini.generateContent } }),
  extractGeminiText: async (response: { text?: string }) => response.text ?? "",
  withGeminiRetry: async <T>(fn: () => Promise<T>) => fn(),
}));

import {
  type CommitmentClaimInput,
  createCommitmentPolarityEvaluator,
  evaluateClaims,
} from "./commitment-polarity.js";

const THE_LEDGER_MISS: CommitmentClaimInput = {
  theme: "Commitment ledger unit",
  conclusion: "ISSUE_NUM ratifies a commitment ledger denominated in API-price-equivalent dollars.",
  sources: [
    {
      ref: "dummy-org/dummy-repoISSUE_NUM (comment 5071085149)",
      excerpt:
        "Money is tracked separately but is not the ledger unit (flat subscriptions, already internalized).",
    },
  ],
};

describe("commitment-claim polarity evaluator ", () => {
  beforeEach(() => {
    gemini.generateContent.mockReset();
  });

  it("is absent rather than lexical when no model key is configured", () => {
    // No fallback regex : a host without a key must report that the check
    // did not run, because a cheaper wrong polarity is worse than an admitted
    // absence .
    expect(createCommitmentPolarityEvaluator(undefined)).toBeUndefined();
    expect(createCommitmentPolarityEvaluator("   ")).toBeUndefined();
    expect(createCommitmentPolarityEvaluator("key")).toBeTypeOf("function");
  });

  it("reads a contradiction and carries the quoted sentence back", async () => {
    gemini.generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        assertsCommitment: "yes",
        sourcePolarity: "contradicts",
        quote: "Money is tracked separately but is not the ledger unit",
        ref: "dummy-org/dummy-repoISSUE_NUM (comment 5071085149)",
        detail: "the cited comment names money as explicitly not the unit",
      }),
    });
    const evaluate = createCommitmentPolarityEvaluator("key");

    const verdict = await evaluate?.(THE_LEDGER_MISS);

    expect(verdict).toMatchObject({
      assertsCommitment: "yes",
      sourcePolarity: "contradicts",
      quote: "Money is tracked separately but is not the ledger unit",
    });
  });

  it("sends the claim and its own cited excerpts, and asks the two questions apart", async () => {
    gemini.generateContent.mockResolvedValueOnce({
      text: '{"assertsCommitment":"yes","sourcePolarity":"silent"}',
    });
    const evaluate = createCommitmentPolarityEvaluator("key");

    await evaluate?.(THE_LEDGER_MISS);

    const sent = gemini.generateContent.mock.calls[0][0].contents as string;
    expect(sent).toContain("ISSUE_NUM ratifies a commitment ledger");
    expect(sent).toContain("is not the ledger unit");
    // "Is this a commitment?" and "what do its sources say?" are separate reads —
    // conflating them is how a declined proposal passes as a ratified one.
    expect(sent).toContain("assertsCommitment");
    expect(sent).toContain("sourcePolarity");
  });

  it("degrades a contradiction it cannot quote to unknown, never to a flag", async () => {
    // A flag a human cannot check against a sentence is the model's word alone.
    gemini.generateContent.mockResolvedValueOnce({
      text: '{"assertsCommitment":"yes","sourcePolarity":"contradicts"}',
    });
    const evaluate = createCommitmentPolarityEvaluator("key");

    const verdict = await evaluate?.(THE_LEDGER_MISS);

    expect(verdict?.sourcePolarity).toBe("unknown");
    expect(verdict?.detail).toContain("quoted no sentence");
  });

  it("returns unknown — not a polarity — when the model fails or answers junk", async () => {
    const evaluate = createCommitmentPolarityEvaluator("key");

    gemini.generateContent.mockRejectedValueOnce(new Error("429 rate limited"));
    const failed = await evaluate?.(THE_LEDGER_MISS);
    expect(failed).toMatchObject({ assertsCommitment: "unknown", sourcePolarity: "unknown" });
    expect(failed?.detail).toContain("429");

    gemini.generateContent.mockResolvedValueOnce({ text: "not json at all" });
    const garbled = await evaluate?.(THE_LEDGER_MISS);
    expect(garbled).toMatchObject({ assertsCommitment: "unknown", sourcePolarity: "unknown" });

    gemini.generateContent.mockResolvedValueOnce({ text: "" });
    const empty = await evaluate?.(THE_LEDGER_MISS);
    expect(empty).toMatchObject({ assertsCommitment: "unknown", sourcePolarity: "unknown" });

    // An off-enum answer is not silently coerced to a real polarity either.
    gemini.generateContent.mockResolvedValueOnce({
      text: '{"assertsCommitment":"probably","sourcePolarity":"kind of"}',
    });
    const offEnum = await evaluate?.(THE_LEDGER_MISS);
    expect(offEnum).toMatchObject({ assertsCommitment: "unknown", sourcePolarity: "unknown" });
  });
});

describe("evaluateClaims", () => {
  it("preserves input order regardless of completion order", async () => {
    // Verdicts are matched back to claims positionally, so an out-of-order
    // resolve would attach one claim's polarity to another claim's theme.
    const claims: CommitmentClaimInput[] = Array.from({ length: 9 }, (_, i) => ({
      theme: `T${i}`,
      conclusion: `C${i}`,
      sources: [],
    }));
    const delays = [30, 1, 20, 2, 25, 3, 15, 4, 10];

    const verdicts = await evaluateClaims(claims, async (claim) => {
      const i = Number(claim.theme.slice(1));
      await new Promise((resolve) => setTimeout(resolve, delays[i]));
      return { assertsCommitment: "yes", sourcePolarity: "silent", detail: claim.theme };
    });

    expect(verdicts.map((v) => v.detail)).toEqual(claims.map((c) => c.theme));
  });

  it("evaluates nothing when there is nothing to evaluate", async () => {
    const evaluate = vi.fn();
    expect(await evaluateClaims([], evaluate)).toEqual([]);
    expect(evaluate).not.toHaveBeenCalled();
  });
});
