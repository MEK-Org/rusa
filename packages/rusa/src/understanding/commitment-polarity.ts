import { Type } from "@google/genai";
import { extractGeminiText, getGeminiClient, withGeminiRetry } from "./gemini-utils.js";

/** Cheap, fast model — this is a per-claim yes/no/unknown read, not a distillation. */
const POLARITY_MODEL = "gemini-3.5-flash-lite";

/** Upper bound on one cited excerpt handed to the evaluator. */
const EXCERPT_LEN = 1200;

/** How many claims are evaluated at once. */
const CONCURRENCY = 4;

export interface CommitmentClaimSource {
  ref: string;
  excerpt: string;
}

export interface CommitmentClaimInput {
  theme: string;
  conclusion: string;
  /** The claim's OWN cited sources, already filtered to those carrying an excerpt. */
  sources: CommitmentClaimSource[];
}

/**
 * What the evaluator read. Every field is three-state on purpose: `unknown` is a
 * first-class answer, and the one thing the evaluator must never do is guess a
 * polarity it cannot see (ISSUE_NUM/ISSUE_NUM).
 */
export interface CommitmentPolarityVerdict {
  /** Does the claim assert that something was *settled*, rather than proposed? */
  assertsCommitment: "yes" | "no" | "unknown";
  /**
   * What the claim's own cited excerpts say about it. `silent` means they neither
   * support nor contradict; `unknown` means the evaluator could not tell, which is
   * NOT `silent`.
   */
  sourcePolarity: "contradicts" | "supports" | "silent" | "unknown";
  /** The sentence from the cited source that decided `contradicts`, verbatim. */
  quote?: string;
  /** Which cited source the quote came from. */
  ref?: string;
  /** One line a human can act on. */
  detail?: string;
}

export type CommitmentPolarityEvaluator = (
  claim: CommitmentClaimInput
) => Promise<CommitmentPolarityVerdict>;

const PROMPT_PREAMBLE = `You are checking one claim written by an automated knowledge distiller against the sources it cited.

The failure this check exists to catch: the distiller read a PROPOSAL and recorded it as a DECISION, at high confidence, while the sentence declining that very proposal sat in a source it had itself cited. A declined option and a ratified one share nearly all their vocabulary, so read for polarity, not for topic overlap.

Answer two separate questions.

1. assertsCommitment — does the CLAIM assert that something was settled, agreed, ratified, adopted, approved, blessed, mandated, or otherwise decided? "yes" if it states a settled outcome. "no" if it merely reports a proposal, an option, a discussion, an observation, a plan under consideration, or a factual description with no decision in it. "unknown" if you genuinely cannot tell.

2. sourcePolarity — considering ONLY the cited excerpts below:
   - "contradicts" if an excerpt declines, rejects, defers, reverses, or otherwise says the opposite of what the claim asserts was settled. Quote that sentence verbatim in "quote" and name its source in "ref".
   - "supports" if an excerpt states the same settled outcome the claim asserts.
   - "silent" if the excerpts are on-topic but simply do not speak to whether it was settled.
   - "unknown" if you cannot tell, or if no excerpt was supplied.

Do not resolve the claim yourself, do not judge whether the decision was a good one, and never report a polarity you cannot point at a sentence for. If you are unsure, answer "unknown" — a wrong polarity is far more costly here than an admitted one.`;

function renderClaim(claim: CommitmentClaimInput): string {
  const sources =
    claim.sources.length === 0
      ? "(the claim cited no source carrying a quoted excerpt)"
      : claim.sources
          .map((s, i) => `[${i + 1}] ref=${s.ref}\n${s.excerpt.slice(0, EXCERPT_LEN)}`)
          .join("\n\n");
  return `${PROMPT_PREAMBLE}

CLAIM THEME:
${claim.theme}

CLAIM CONCLUSION:
${claim.conclusion}

CITED EXCERPTS:
${sources}`;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    assertsCommitment: {
      type: Type.STRING,
      enum: ["yes", "no", "unknown"],
      description: "Whether the claim asserts a settled outcome rather than a proposal.",
    },
    sourcePolarity: {
      type: Type.STRING,
      enum: ["contradicts", "supports", "silent", "unknown"],
      description: "What the claim's own cited excerpts say about the asserted outcome.",
    },
    quote: {
      type: Type.STRING,
      description:
        "The verbatim sentence from a cited excerpt that decided a 'contradicts' verdict; empty otherwise.",
    },
    ref: {
      type: Type.STRING,
      description: "The ref of the excerpt the quote came from; empty otherwise.",
    },
    detail: {
      type: Type.STRING,
      description: "One sentence a human can act on.",
    },
  },
  required: ["assertsCommitment", "sourcePolarity"],
};

const UNKNOWN: CommitmentPolarityVerdict = {
  assertsCommitment: "unknown",
  sourcePolarity: "unknown",
};

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The ISSUE_NUM commitment-claim polarity check, as a cheap semantic read .
 *
 * This replaced a lexical implementation: a verb list to decide "is this a
 * commitment", a negation-token list, and a 12-word proximity window. That could
 * only ever approximate the question — it fired on "adopted" inside a quoted
 * proposal and missed a refusal phrased without any of its tokens — and Operator's
 * LLM-first ruling covers exactly this class. There is deliberately no lexical
 * fallback: without an evaluator the check reports that it did not run, because a
 * cheaper wrong answer here is worse than an admitted absence .
 */
export function createCommitmentPolarityEvaluator(
  apiKey: string | undefined
): CommitmentPolarityEvaluator | undefined {
  const key = apiKey?.trim();
  if (!key) return undefined;
  return async (claim) => {
    try {
      const client = getGeminiClient(key);
      const response = await withGeminiRetry(() =>
        client.models.generateContent({
          model: POLARITY_MODEL,
          contents: renderClaim(claim),
          config: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
        })
      );
      const text = await extractGeminiText(response);
      if (!text.trim()) return UNKNOWN;
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const verdict: CommitmentPolarityVerdict = {
        assertsCommitment: asEnum(
          parsed.assertsCommitment,
          ["yes", "no", "unknown"] as const,
          "unknown"
        ),
        sourcePolarity: asEnum(
          parsed.sourcePolarity,
          ["contradicts", "supports", "silent", "unknown"] as const,
          "unknown"
        ),
      };
      const quote = nonEmpty(parsed.quote);
      const ref = nonEmpty(parsed.ref);
      const detail = nonEmpty(parsed.detail);
      // A `contradicts` with nothing to point at is not actionable and cannot be
      // checked by the human who reads the report, so it degrades to unknown
      // rather than standing as a flag on the model's word alone.
      if (verdict.sourcePolarity === "contradicts" && !quote) {
        return {
          assertsCommitment: verdict.assertsCommitment,
          sourcePolarity: "unknown",
          detail: "evaluator reported a contradiction but quoted no sentence to support it",
        };
      }
      return {
        ...verdict,
        ...(quote ? { quote } : {}),
        ...(ref ? { ref } : {}),
        ...(detail ? { detail } : {}),
      };
    } catch (err) {
      return {
        ...UNKNOWN,
        detail: `evaluator failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

/** Evaluate claims with a small concurrency cap, preserving input order. */
export async function evaluateClaims(
  claims: CommitmentClaimInput[],
  evaluate: CommitmentPolarityEvaluator
): Promise<CommitmentPolarityVerdict[]> {
  const out: CommitmentPolarityVerdict[] = new Array(claims.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= claims.length) return;
      out[i] = await evaluate(claims[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, claims.length) }, () => worker()));
  return out;
}
