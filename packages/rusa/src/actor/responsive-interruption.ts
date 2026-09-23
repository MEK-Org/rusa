/**
 * The deliberately narrow local seam for #533. It models only the two closed
 * JEV Choice calls this policy needs; it is not a general provider abstraction.
 *
 * The request carries durable inbox identifiers and nothing else. A client that
 * needs the text behind an id has to resolve it itself, and the data-access and
 * retention boundary for doing so is not settled yet — so no client ships in
 * this slice, and no production wiring constructs one. What lands here is the
 * classifier and its seam, tested against fixtures; the operator-facing knob
 * belongs with the change that first makes it observable.
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
  /** The primary comparison set. Whenever it is non-empty it is the only set. */
  selectedEntryIds: readonly string[];
  /** Unselected rows, compared against only when nothing is selected. */
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

/**
 * Why a decision produced no interrupt. These stay distinct on purpose: the
 * feature exists to measure, and "we never asked", "the client broke" and "the
 * client answered out of its own closed set" are different data.
 */
export type ResponsiveInterruptionQueueReason =
  | "unavailable"
  | "client_error"
  | "no_comparison"
  | "invalid_comparison_choice"
  | "invalid_comparison_confidence"
  | "low_confidence_comparison"
  | "invalid_relation_choice"
  | "invalid_relation_confidence"
  | "low_confidence_relation";

export type ResponsiveInterruptionDecision =
  | (DecisionBase & {
      outcome: "interrupt" | "queue";
      comparison: RedactedChoiceDecision;
      relationDecision: RedactedChoiceDecision;
    })
  | (DecisionBase & {
      outcome: "queue";
      reason: ResponsiveInterruptionQueueReason;
      /**
       * What was learned before the decision was rejected, on the arms where
       * anything was. A threshold cannot be tuned from records that discard
       * the confidence it rejected, so the below-threshold arms carry the
       * same redacted projection the accepted path does; the arms that never
       * got a well-formed answer carry nothing.
       */
      comparison?: RedactedChoiceDecision;
      relationDecision?: RedactedChoiceDecision;
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

/**
 * Projects a response onto the closed set it was offered. `choice` is checked
 * by the caller; this drops any probability key the client invented and any
 * weight that is not a real number in 0..1, so the audit cannot carry arbitrary
 * text in from a defective or future client.
 */
function redacted(
  response: JevChoiceResponse,
  offeredChoices: readonly string[]
): RedactedChoiceDecision {
  const probabilities: Record<string, number> = {};
  for (const choice of offeredChoices) {
    const weight = response.probabilities?.[choice];
    if (weight !== undefined && isConfidence(weight)) probabilities[choice] = weight;
  }
  return {
    choice: response.choice,
    confidence: response.confidence,
    ...(Object.keys(probabilities).length > 0 ? { probabilities } : {}),
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
    const queue = (reason: ResponsiveInterruptionQueueReason): ResponsiveInterruptionDecision => ({
      ...base,
      outcome: "queue",
      reason,
    });
    // Selected work is the comparison set whenever there is any. Unselected
    // rows are the fallback for an actor holding no selection, never a rival
    // to a selection — a pending row winning over selected work is precisely
    // the false pivot this policy exists to avoid predicting.
    const primary =
      input.selectedEntryIds.length > 0 ? input.selectedEntryIds : input.pendingEntryIds;
    const comparisonEntryIds = [...new Set(primary)].filter(
      (entryId) => entryId !== input.incomingEntryId
    );
    if (!this.client) return queue("unavailable");
    // A closed choice with one legal answer decides nothing; skip the round trip.
    if (comparisonEntryIds.length === 0) return queue("no_comparison");

    const comparisonChoices = [...comparisonEntryIds, "none"];
    let comparison: JevChoiceResponse;
    try {
      comparison = await this.client.choose({
        id: "comparison",
        choices: comparisonChoices,
        input: {
          incomingEntryId: input.incomingEntryId,
          comparisonEntryIds,
          phase: "comparison",
        },
      });
    } catch {
      return queue("client_error");
    }
    if (!isConfidence(comparison.confidence)) return queue("invalid_comparison_confidence");
    if (comparison.choice === "none") return queue("no_comparison");
    if (!comparisonEntryIds.includes(comparison.choice)) return queue("invalid_comparison_choice");
    if (comparison.confidence < this.threshold) {
      return {
        ...base,
        comparisonEntryId: comparison.choice,
        outcome: "queue",
        reason: "low_confidence_comparison",
        comparison: redacted(comparison, comparisonChoices),
      };
    }

    const comparisonEntryId = comparison.choice;
    const withComparison = { ...base, comparisonEntryId };
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
      return { ...withComparison, outcome: "queue", reason: "client_error" };
    }
    if (!isConfidence(relationDecision.confidence)) {
      return { ...withComparison, outcome: "queue", reason: "invalid_relation_confidence" };
    }
    if (!RELATIONS.includes(relationDecision.choice as ResponsiveInterruptionRelation)) {
      return { ...withComparison, outcome: "queue", reason: "invalid_relation_choice" };
    }
    const relation = relationDecision.choice as ResponsiveInterruptionRelation;
    if (relationDecision.confidence < this.threshold) {
      return {
        ...withComparison,
        relation,
        outcome: "queue",
        reason: "low_confidence_relation",
        comparison: redacted(comparison, comparisonChoices),
        relationDecision: redacted(relationDecision, RELATIONS),
      };
    }

    return {
      ...withComparison,
      relation,
      outcome: relation === "unrelated" ? "queue" : "interrupt",
      comparison: redacted(comparison, comparisonChoices),
      relationDecision: redacted(relationDecision, RELATIONS),
    };
  }
}
