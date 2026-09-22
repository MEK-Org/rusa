/**
 * The deliberately narrow local seam for #533. It models only the two closed
 * JEV Choice calls this policy needs; it is not a general provider abstraction.
 * Production wiring does not construct a client in the public/synthetic slice.
 */
export interface JevChoiceClient {
  choose(request: JevChoiceRequest): Promise<JevChoiceResponse>;
}

export interface JevChoiceRequest {
  id: "comparison" | "relation";
  choices: readonly string[];
  input: {
    incomingEntryId: string;
    comparisonEntryIds?: readonly string[];
    comparisonEntryId?: string;
    phase: "comparison" | "relation";
  };
}

export interface JevChoiceResponse {
  choice: string;
  confidence: number;
  probabilities?: Readonly<Record<string, number>>;
}

export type ResponsiveInterruptionRelation =
  | "reversal"
  | "refinement"
  | "correction"
  | "cancellation"
  | "unrelated";

export interface ResponsiveInterruptionInput {
  incomingEntryId: string;
  /** Current selected work takes precedence over every unselected inbox row. */
  selectedEntryIds: readonly string[];
  /** Unselected entries are a conservative fallback only when nothing is selected. */
  pendingEntryIds: readonly string[];
}

export interface RedactedChoiceDecision {
  choice: string;
  confidence: number;
  probabilities?: Readonly<Record<string, number>>;
}

interface DecisionBase {
  incomingEntryId: string;
  comparisonEntryId: string | null;
  relation: ResponsiveInterruptionRelation | null;
  threshold: number;
  /** IDs only: message bodies and other operational content never enter the audit. */
  input: ResponsiveInterruptionInput;
}

export type ResponsiveInterruptionDecision =
  | (DecisionBase & {
      outcome: "interrupt" | "queue";
      comparison: RedactedChoiceDecision;
      relationDecision: RedactedChoiceDecision;
    })
  | (DecisionBase & {
      outcome: "queue";
      reason:
        | "unavailable"
        | "no_comparison"
        | "invalid_comparison_choice"
        | "low_confidence_comparison"
        | "invalid_relation_choice"
        | "low_confidence_relation";
    });

const RELATIONS = [
  "reversal",
  "refinement",
  "correction",
  "cancellation",
  "unrelated",
] as const satisfies readonly ResponsiveInterruptionRelation[];

function isConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function redacted(response: JevChoiceResponse): RedactedChoiceDecision {
  return {
    choice: response.choice,
    confidence: response.confidence,
    ...(response.probabilities ? { probabilities: response.probabilities } : {}),
  };
}

/**
 * Evaluates an opt-in policy using only durable inbox identifiers. Callers keep
 * its result observational while mode is shadow, so a slow or failed decision
 * can never delay the existing responsive delivery or hard operator controls.
 */
export class ShadowResponsiveInterruptionClassifier {
  private readonly client: JevChoiceClient | undefined;
  private readonly threshold: number;

  constructor(options: { client?: JevChoiceClient; threshold: number }) {
    this.client = options.client;
    this.threshold = options.threshold;
  }

  async evaluate(input: ResponsiveInterruptionInput): Promise<ResponsiveInterruptionDecision> {
    const base: DecisionBase = {
      incomingEntryId: input.incomingEntryId,
      comparisonEntryId: null,
      relation: null,
      threshold: this.threshold,
      input: {
        incomingEntryId: input.incomingEntryId,
        selectedEntryIds: [...input.selectedEntryIds],
        pendingEntryIds: [...input.pendingEntryIds],
      },
    };
    // Selected work comes first. Unselected pending work is present as the
    // conservative fallback the policy is allowed to name, never inferred from
    // arbitrary message content or a racing "latest" row.
    const comparisonEntryIds = [
      ...new Set([...input.selectedEntryIds, ...input.pendingEntryIds]),
    ].filter((entryId) => entryId !== input.incomingEntryId);
    if (!this.client) return { ...base, outcome: "queue", reason: "unavailable" };
    let comparison: JevChoiceResponse;
    try {
      comparison = await this.client.choose({
        id: "comparison",
        choices: [...comparisonEntryIds, "none"],
        input: {
          incomingEntryId: input.incomingEntryId,
          comparisonEntryIds,
          phase: "comparison",
        },
      });
    } catch {
      return { ...base, outcome: "queue", reason: "unavailable" };
    }
    if (!isConfidence(comparison.confidence)) {
      return { ...base, outcome: "queue", reason: "invalid_comparison_choice" };
    }
    if (comparison.choice === "none") {
      return { ...base, outcome: "queue", reason: "no_comparison" };
    }
    if (!comparisonEntryIds.includes(comparison.choice)) {
      return { ...base, outcome: "queue", reason: "invalid_comparison_choice" };
    }
    if (comparison.confidence < this.threshold) {
      return { ...base, outcome: "queue", reason: "low_confidence_comparison" };
    }

    const comparisonEntryId = comparison.choice;
    let relationDecision: JevChoiceResponse;
    try {
      relationDecision = await this.client.choose({
        id: "relation",
        choices: RELATIONS,
        input: {
          incomingEntryId: input.incomingEntryId,
          comparisonEntryId,
          phase: "relation",
        },
      });
    } catch {
      return {
        ...base,
        comparisonEntryId,
        outcome: "queue",
        reason: "unavailable",
      };
    }
    if (
      !isConfidence(relationDecision.confidence) ||
      !RELATIONS.includes(relationDecision.choice as ResponsiveInterruptionRelation)
    ) {
      return {
        ...base,
        comparisonEntryId,
        outcome: "queue",
        reason: "invalid_relation_choice",
      };
    }
    if (relationDecision.confidence < this.threshold) {
      return {
        ...base,
        comparisonEntryId,
        relation: relationDecision.choice as ResponsiveInterruptionRelation,
        outcome: "queue",
        reason: "low_confidence_relation",
      };
    }

    const relation = relationDecision.choice as ResponsiveInterruptionRelation;
    return {
      ...base,
      comparisonEntryId,
      relation,
      outcome: relation === "unrelated" ? "queue" : "interrupt",
      comparison: redacted(comparison),
      relationDecision: redacted(relationDecision),
    };
  }
}
