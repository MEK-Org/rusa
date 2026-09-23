/**
 * The deliberately narrow local seam for #533. It models one open-ended JEV
 * decision — "given this information, should we interrupt?" — and nothing
 * else; it is not a general provider abstraction.
 *
 * The request carries durable inbox identifiers and nothing else. A client
 * that needs the text behind an id resolves it itself, which is where the
 * data-access and retention boundary lives. No client ships in this slice and
 * no production wiring constructs one: what lands here is the classifier and
 * its seam, tested against synthetic fixtures.
 *
 * ## Why an open question rather than a taxonomy
 *
 * The first shape of this asked two closed questions: which pending item does
 * this bear on, then what is the relation, chosen from a fixed list
 * (reversal / refinement / correction / cancellation / unrelated). That forced
 * every arrival through a relationship vocabulary picked in advance, so an
 * arrival whose bearing was real but unlisted had to be squeezed into the
 * nearest label or dropped as `unrelated` — and the audit then recorded a
 * taxonomy artefact rather than a judgement.
 *
 * Asking the decision directly keeps the judgement open while the *answer*
 * stays closed: a two-valued verdict plus a confidence is exactly as
 * machine-readable as a taxonomy, so scheduling and audit remain
 * deterministic. The thing that was narrowed is the question, not the record.
 */

/** A live client sees ids; resolving them to text is its own concern. */
export interface JevDecisionClient {
  decide(request: JevDecisionRequest): Promise<JevDecisionResponse>;
}

export interface JevDecisionRequest {
  /** The open-ended decision put to the model, verbatim. */
  question: string;
  input: {
    incomingEntryId: string;
    /** Every candidate, in durable order — never a convenient first page. */
    candidateEntryIds: readonly string[];
    /** Which set the candidates came from, so an audit can tell them apart. */
    candidateSource: ResponsiveInterruptionCandidateSource;
  };
}

export interface JevDecisionResponse {
  /** Expected to be `interrupt` or `queue`; anything else fails closed. */
  verdict: string;
  confidence: number;
  /**
   * Free prose for a human reading a live response. It is accepted here and
   * deliberately dropped before the decision is returned — this is the single
   * field through which message text could otherwise reach a durable record.
   */
  rationale?: string;
  /** The candidates the verdict rests on, filtered to what was offered. */
  matchedCandidateIds?: readonly string[];
}

export type ResponsiveInterruptionVerdict = "interrupt" | "queue";
export type ResponsiveInterruptionCandidateSource = "selected" | "pending";

const VERDICTS = ["interrupt", "queue"] as const satisfies readonly ResponsiveInterruptionVerdict[];

/**
 * The question itself, exported because it is the policy — the thing a review
 * argues about — and because a test can then assert the seam asks it rather
 * than something adjacent.
 */
export const RESPONSIVE_INTERRUPTION_QUESTION =
  "The actor is working on the listed items. A new responsive item has just" +
  " arrived. Given this information, should we interrupt the current run to" +
  " handle it, or should it wait in the queue? Answer 'interrupt' only if the" +
  " arriving item bears on the listed work clearly enough that continuing" +
  " would waste or spoil it; otherwise answer 'queue'.";

/** What a would-interrupt looks like on the arriving Google Chat message. */
export const SHADOW_INTERRUPT_EMOJI = "✅";
/** What a would-queue looks like on the arriving Google Chat message. */
export const SHADOW_QUEUE_EMOJI = "❌";

/**
 * The reaction that surfaces a shadow verdict in place. Shadow mode changes no
 * scheduling, so this is the only way an operator sees a prediction where the
 * message actually lives; the audit event remains the durable record.
 */
export function shadowVerdictEmoji(outcome: ResponsiveInterruptionVerdict): string {
  return outcome === "interrupt" ? SHADOW_INTERRUPT_EMOJI : SHADOW_QUEUE_EMOJI;
}

/**
 * The Google Chat message a shadow verdict belongs on, or `null` when the
 * arrival did not come from chat and there is nothing to react to.
 *
 * Shadow mode changes no scheduling, so without this the operator's only view
 * of a prediction is an audit row they have to go looking for. Reacting where
 * the message already is puts the decision in front of the person best placed
 * to say it is wrong — which is the entire point of a shadow rollout. The
 * reaction is the *prediction*; the scheduler's own behaviour is unchanged and
 * the audit event stays the durable record.
 */
export function shadowReactionTarget(
  payload: Readonly<Record<string, unknown>>,
  outcome: ResponsiveInterruptionVerdict
): { messageName: string; emoji: string } | null {
  if (payload.type !== "gchat.message") return null;
  const messageName = payload.messageName;
  if (typeof messageName !== "string" || messageName.length === 0) return null;
  return { messageName, emoji: shadowVerdictEmoji(outcome) };
}

export interface ResponsiveInterruptionInput {
  incomingEntryId: string;
  /** The primary candidate set. Whenever it is non-empty it is the only set. */
  selectedEntryIds: readonly string[];
  /** Unselected rows, offered only when nothing is selected. */
  pendingEntryIds: readonly string[];
}

interface DecisionBase {
  incomingEntryId: string;
  candidateSource: ResponsiveInterruptionCandidateSource;
  threshold: number;
  /** IDs only: message bodies and other operational content never enter the audit. */
  input: ResponsiveInterruptionInput;
}

/**
 * Why a decision produced no interrupt. These stay distinct on purpose: the
 * feature exists to measure, and "we never asked", "the client broke", "it ran
 * long" and "it answered but not confidently" are different data.
 */
export type ResponsiveInterruptionQueueReason =
  | "unavailable"
  | "client_error"
  | "timeout"
  | "no_candidates"
  | "invalid_verdict"
  | "invalid_confidence"
  | "low_confidence";

export type ResponsiveInterruptionDecision =
  | (DecisionBase & {
      outcome: ResponsiveInterruptionVerdict;
      verdict: ResponsiveInterruptionVerdict;
      confidence: number;
      matchedCandidateIds: readonly string[];
    })
  | (DecisionBase & {
      outcome: "queue";
      reason: ResponsiveInterruptionQueueReason;
      /**
       * What was learned before the decision was rejected, when anything was.
       * A threshold cannot be tuned from records that discard the confidence
       * it rejected, so the below-threshold arm carries the same projection
       * the accepted path does; arms that never got a well-formed answer
       * carry nothing.
       */
      confidence?: number;
      matchedCandidateIds?: readonly string[];
    });

/** How long a decision may take before the policy stops waiting on it. */
const DEFAULT_TIMEOUT_MS = 5_000;

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Evaluates an opt-in policy using only durable inbox identifiers. Callers
 * keep its result observational while mode is shadow, so a slow or failed
 * decision can never delay the existing responsive delivery or hard operator
 * controls.
 */
export class ShadowResponsiveInterruptionClassifier {
  private readonly client: JevDecisionClient | undefined;
  private readonly threshold: number;
  private readonly timeoutMs: number;

  constructor(options: { client?: JevDecisionClient; threshold: number; timeoutMs?: number }) {
    this.client = options.client;
    this.threshold = options.threshold;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async evaluate(input: ResponsiveInterruptionInput): Promise<ResponsiveInterruptionDecision> {
    // Selected work is the candidate set whenever there is any. Unselected
    // rows are the fallback for an actor holding no selection, never a rival
    // to a selection — a pending row winning over selected work is precisely
    // the false pivot this policy exists to avoid predicting.
    const selected = input.selectedEntryIds.length > 0;
    const candidateSource: ResponsiveInterruptionCandidateSource = selected
      ? "selected"
      : "pending";
    const candidateEntryIds = [
      ...new Set(selected ? input.selectedEntryIds : input.pendingEntryIds),
    ].filter((entryId) => entryId !== input.incomingEntryId);
    const base: DecisionBase = {
      incomingEntryId: input.incomingEntryId,
      candidateSource,
      threshold: this.threshold,
      input: {
        incomingEntryId: input.incomingEntryId,
        selectedEntryIds: [...input.selectedEntryIds],
        pendingEntryIds: [...input.pendingEntryIds],
      },
    };
    const queue = (
      reason: ResponsiveInterruptionQueueReason,
      learned?: { confidence: number; matchedCandidateIds: readonly string[] }
    ): ResponsiveInterruptionDecision => ({ ...base, outcome: "queue", reason, ...learned });

    if (!this.client) return queue("unavailable");
    // Nothing to weigh the arrival against decides nothing; skip the round trip.
    if (candidateEntryIds.length === 0) return queue("no_candidates");

    let response: JevDecisionResponse;
    try {
      response = await this.withDeadline(
        this.client.decide({
          question: RESPONSIVE_INTERRUPTION_QUESTION,
          input: { incomingEntryId: input.incomingEntryId, candidateEntryIds, candidateSource },
        })
      );
    } catch (err) {
      // The error text is the other route by which operational content could
      // reach the audit, so only the fact of failure is recorded.
      return queue(err === DEADLINE_EXCEEDED ? "timeout" : "client_error");
    }

    if (!isConfidence(response?.confidence)) return queue("invalid_confidence");
    if (!VERDICTS.includes(response.verdict as ResponsiveInterruptionVerdict)) {
      return queue("invalid_verdict");
    }
    const verdict = response.verdict as ResponsiveInterruptionVerdict;
    // Anything the client names that it was not offered is dropped, so a
    // defective or future client cannot write free text into the audit
    // through the one field that survives redaction.
    const offered = new Set(candidateEntryIds);
    const matchedCandidateIds = [
      ...new Set((response.matchedCandidateIds ?? []).filter((id) => offered.has(id))),
    ];
    const learned = { confidence: response.confidence, matchedCandidateIds };

    // Fail closed: only a confident interrupt is an interrupt. A confident
    // *queue* needs no threshold, because queueing is what happens anyway.
    if (verdict === "interrupt" && response.confidence < this.threshold) {
      return queue("low_confidence", learned);
    }
    return { ...base, outcome: verdict, verdict, ...learned };
  }

  /**
   * Bounds a decision in wall-clock time. A shadow decision that never
   * resolves would leak a pending observation per arrival; in a later
   * authoritative mode it would stall the arrival itself.
   */
  private async withDeadline(pending: Promise<JevDecisionResponse>): Promise<JevDecisionResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(DEADLINE_EXCEEDED), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** A sentinel rather than an Error, so a real client error cannot impersonate it. */
const DEADLINE_EXCEEDED = Symbol("responsive interruption decision deadline exceeded");
