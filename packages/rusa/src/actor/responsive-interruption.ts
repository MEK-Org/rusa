/**
 * The deliberately narrow local seam for #533. It models one open-ended JEV
 * decision — "given this information, should we interrupt?" — and nothing
 * else; it is not a general provider abstraction.
 *
 * The request carries durable inbox identifiers. The live client resolves the
 * corresponding source text on the host, immediately before its opt-in HTTP
 * request; that boundary is deliberately outside this scheduler policy. The
 * decision and its durable audit remain identifiers only.
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
 * stays closed: a probability of yes is exactly as
 * machine-readable as a taxonomy, so scheduling and audit remain
 * deterministic. The thing that was narrowed is the question, not the record.
 */

/** A live client sees ids; resolving them to text is its own concern. */
export interface JevDecisionClient {
  /**
   * `signal` is the policy deadline's cancellation path. A client must pass it
   * to its transport so an abandoned shadow observation does not continue
   * sending content after the scheduler has stopped waiting for it.
   */
  decide(
    request: JevDecisionRequest,
    options?: { signal?: AbortSignal }
  ): Promise<JevDecisionResponse>;
}

/**
 * Thrown by a client that could not read the arriving item's text. Recorded as
 * `input_unavailable` so the audit separates "nothing to decide on" from a
 * failed call.
 */
export class JevInputUnavailableError extends Error {
  constructor() {
    super("JEV decision input text is unavailable");
    this.name = "JevInputUnavailableError";
  }
}

export interface JevDecisionRequest {
  /** Host-local lookup key. It is not copied into the durable decision audit. */
  actorId: string;
  /** Optional evaluation ID linking the decision audit to its query log entry. */
  evaluationId?: string;
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
  /** Noul probability of yes (interrupt), finite and in [0, 1]. */
  interruptProbability: number;
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

/**
 * The question itself, exported because it is the policy — the thing a review
 * argues about — and because a test can then assert the seam asks it rather
 * than something adjacent.
 */
export const RESPONSIVE_INTERRUPTION_QUESTION =
  "Should we interrupt the current work for the arriving item?" +
  " Corrections, cancellations, clarifications, and follow-ups about the current" +
  " work should interrupt. An item that is clearly unrelated should wait." +
  " If the relationship is uncertain or the current work is not known, favor" +
  " interrupting. Use sender and timestamps to interpret the relationship" +
  " between messages. Candidates marked selected are the current work;" +
  " candidates marked pending are unread context, not confirmed current work.";

/** What a would-interrupt looks like on the arriving Google Chat message. */
export const SHADOW_INTERRUPT_EMOJI = "✅";
/** What a would-queue looks like on the arriving Google Chat message. */
export const SHADOW_QUEUE_EMOJI = "❌";

/**
 * The reaction that surfaces a shadow verdict in place. Shadow mode changes no
 * scheduling, so this is the only way an operator sees a prediction where the
 * message actually lives; the audit event remains the durable record.
 */
export function shadowVerdictEmoji(verdict: ResponsiveInterruptionVerdict): string {
  return verdict === "interrupt" ? SHADOW_INTERRUPT_EMOJI : SHADOW_QUEUE_EMOJI;
}

/** The threshold-applied prediction, or null when no valid probability arrived. */
export function shadowPrediction(
  decision: ResponsiveInterruptionDecision
): ResponsiveInterruptionVerdict | null {
  return decision.interruptProbability === undefined ? null : decision.outcome;
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
  verdict: ResponsiveInterruptionVerdict
): { messageName: string; emoji: string } | null {
  if (payload.type !== "gchat.message") return null;
  const messageName = payload.messageName;
  if (typeof messageName !== "string" || messageName.length === 0) return null;
  return { messageName, emoji: shadowVerdictEmoji(verdict) };
}

export interface ResponsiveInterruptionInput {
  /** Host-local lookup key for a live client; not copied into the audit. */
  actorId: string;
  incomingEntryId: string;
  /** The primary candidate set. Whenever it is non-empty it is the only set. */
  selectedEntryIds: readonly string[];
  /** Unselected rows, offered only when nothing is selected. */
  pendingEntryIds: readonly string[];
  /** Optional evaluation ID linking the decision audit to its query log entry. */
  evaluationId?: string;
}

interface DecisionBase {
  evaluationId?: string;
  incomingEntryId: string;
  candidateSource: ResponsiveInterruptionCandidateSource;
  threshold: number;
  /** IDs only: message bodies and other operational content never enter the audit. */
  input: Omit<ResponsiveInterruptionInput, "actorId">;
}

/**
 * Why a decision produced no interrupt. These stay distinct on purpose: the
 * feature exists to measure, and "we never asked", "the client broke", "it ran
 * long" and "it answered but not confidently" are different data.
 */
export type ResponsiveInterruptionQueueReason =
  | "unavailable"
  | "client_error"
  | "input_unavailable"
  | "timeout"
  | "no_candidates"
  | "invalid_probability"
  | "below_threshold";

export type ResponsiveInterruptionDecision =
  | (DecisionBase & {
      outcome: ResponsiveInterruptionVerdict;
      interruptProbability: number;
      matchedCandidateIds: readonly string[];
    })
  | (DecisionBase & {
      outcome: "queue";
      reason: ResponsiveInterruptionQueueReason;
      /** The original Noul probability survives a below-threshold outcome. */
      interruptProbability?: number;
      matchedCandidateIds?: readonly string[];
    });

/**
 * How long a decision may take before the policy stops waiting on it. The
 * budget covers the live client's source reads as well as its HTTP request.
 * Expiry aborts the request through the `AbortSignal` passed to `decide`; the
 * source clients take no signal, so the client stops waiting on a read in
 * progress rather than cancelling it, and sends nothing after expiry.
 * Uncalibrated placeholder: shadow mode delays nothing, and `timeout` is
 * recorded as its own reason, so the shadow data is what calibrates it.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

function isProbability(value: unknown): value is number {
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
      ...(input.evaluationId !== undefined ? { evaluationId: input.evaluationId } : {}),
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
      learned?: {
        interruptProbability: number;
        matchedCandidateIds: readonly string[];
      }
    ): ResponsiveInterruptionDecision => ({ ...base, outcome: "queue", reason, ...learned });

    if (!this.client) return queue("unavailable");
    // Nothing to weigh the arrival against decides nothing; skip the round trip.
    if (candidateEntryIds.length === 0) return queue("no_candidates");

    let response: JevDecisionResponse;
    try {
      response = await this.withDeadline(this.client, {
        actorId: input.actorId,
        ...(input.evaluationId !== undefined ? { evaluationId: input.evaluationId } : {}),
        question: RESPONSIVE_INTERRUPTION_QUESTION,
        input: { incomingEntryId: input.incomingEntryId, candidateEntryIds, candidateSource },
      });
    } catch (err) {
      // The error text is the other route by which operational content could
      // reach the audit, so only the fact of failure is recorded.
      if (err === DEADLINE_EXCEEDED) return queue("timeout");
      return queue(err instanceof JevInputUnavailableError ? "input_unavailable" : "client_error");
    }

    if (!isProbability(response?.interruptProbability)) return queue("invalid_probability");
    // Anything the client names that it was not offered is dropped, so a
    // defective or future client cannot write free text into the audit
    // through the one field that survives redaction.
    const offered = new Set(candidateEntryIds);
    const matchedCandidateIds = [
      ...new Set((response.matchedCandidateIds ?? []).filter((id) => offered.has(id))),
    ];
    const learned = { interruptProbability: response.interruptProbability, matchedCandidateIds };

    // Noul is P(yes), so apply the threshold directly. There is no winning
    // label or second confidence score to gate first.
    if (response.interruptProbability < this.threshold) {
      return queue("below_threshold", learned);
    }
    return { ...base, outcome: "interrupt", ...learned };
  }

  /**
   * Bounds a decision in wall-clock time. A shadow decision that never
   * resolves would leak a pending observation per arrival; in a later
   * authoritative mode it would stall the arrival itself.
   */
  private async withDeadline(
    client: JevDecisionClient,
    request: JevDecisionRequest
  ): Promise<JevDecisionResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        client.decide(request, { signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort(DEADLINE_EXCEEDED);
            reject(DEADLINE_EXCEEDED);
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** A sentinel rather than an Error, so a real client error cannot impersonate it. */
const DEADLINE_EXCEEDED = Symbol("responsive interruption decision deadline exceeded");
