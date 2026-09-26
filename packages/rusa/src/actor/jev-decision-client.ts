import { APIError, choice, type Fetch, type JsonValue, TypeSafeClient } from "@typesafe-ai/sdk";
import {
  type JevDecisionClient,
  type JevDecisionRequest,
  type JevDecisionResponse,
  JevInputUnavailableError,
} from "./responsive-interruption.js";

/**
 * The TypeSafe API root. It matches the SDK default but is passed explicitly:
 * left unset, the SDK would take `TYPESAFE_BASE_URL` from the daemon's
 * environment and send the bearer credential and inbox text wherever it names.
 */
const JEV_BASE_URL = "https://api.typesafe.ai";
/** An alias rather than a pinned release lets the operator's TypeSafe account select its current model. */
export const JEV_DEFAULT_MODEL = "jev-latest";
/**
 * Most candidates resolved and sent per decision, in the scheduler's order.
 * Uncalibrated placeholder: the `pending` fallback can be a whole inbox, and
 * this bounds source reads and request size until shadow data says otherwise.
 * The count left out is still sent, so the model knows the list was cut.
 */
export const JEV_MAX_CANDIDATES = 20;

/**
 * The two outcomes offered to the model, which are also the verdicts accepted
 * back. Exported so a test can pin the wording the operator approved (#710).
 */
export const INTERRUPTION_CRITERIA = {
  interrupt: "the arriving item relates to the current work, or its relationship is uncertain.",
  queue: "the arriving item is clearly unrelated to the current work.",
};

/** A type alias rather than an interface, so it is assignable to the SDK's JSON state. */
export type JevResolvedInboxEntry = {
  id: string;
  source: string;
  /** Inbox payload type, so a candidate without readable text still says what it is. */
  type: string;
  /** Source text (bounded), or null when the source could not be read. Never persisted. */
  text: string | null;
  truncated?: true;
  /**
   * Who sent it and when (ISO-8601), or null when unknown, so the model can
   * see that two messages came from the same person seconds apart. Never
   * persisted.
   */
  sender: string | null;
  timestamp: string | null;
};

/** Host-owned resolution boundary; neither the scheduler nor its audit stores text. */
export type ResolveJevInboxEntry = (
  actorId: string,
  entryId: string,
  signal?: AbortSignal
) => Promise<JevResolvedInboxEntry>;

/**
 * TypeSafe transport behind the existing JEV seam, using the official
 * `@typesafe-ai/sdk` client. It sends once (`maxRetries: 0`), because a retry
 * would resend real inbox content, and turns SDK logging off so prompt bodies
 * never reach logs. Every failure throws, and the shadow scheduler queues.
 */
export class HttpJevDecisionClient implements JevDecisionClient {
  private readonly client: TypeSafeClient;

  constructor(
    apiKey: string,
    private readonly resolveEntry: ResolveJevInboxEntry,
    fetch?: Fetch
  ) {
    this.client = new TypeSafeClient({
      apiKey,
      baseURL: JEV_BASE_URL,
      retry: { maxRetries: 0 },
      logLevel: "off",
      ...(fetch ? { fetch } : {}),
    });
  }

  async decide(
    request: JevDecisionRequest,
    options: { signal?: AbortSignal } = {}
  ): Promise<JevDecisionResponse> {
    const { actorId } = request;
    const { incomingEntryId, candidateEntryIds, candidateSource } = request.input;
    // Without the arriving item's text there is nothing to decide. That is an
    // input gap, not a transport failure, and the audit keeps them apart. It is
    // settled before any candidate is read.
    const incoming = await this.resolveEntry(actorId, incomingEntryId, options.signal);
    if (incoming.text === null) throw new JevInputUnavailableError();
    const sent = candidateEntryIds.slice(0, JEV_MAX_CANDIDATES);
    // Each candidate says which set it came from, so the model can tell
    // current work (selected) from unread context (pending).
    const candidates = await Promise.all(
      sent.map(async (entryId) => ({
        ...(await this.resolveEntry(actorId, entryId, options.signal)),
        candidateSource,
      }))
    );
    const omittedCandidates = candidateEntryIds.length - sent.length;
    const state: JsonValue = {
      incoming,
      candidates,
      candidateSource,
      ...(omittedCandidates > 0 ? { omittedCandidates } : {}),
    };

    let answer: { choice: unknown; confidence: unknown } | undefined;
    try {
      const result = await this.client.systemOne(
        {
          model: JEV_DEFAULT_MODEL,
          state,
          questions: { interruption: choice(request.question, INTERRUPTION_CRITERIA) },
        },
        { signal: options.signal }
      );
      answer = result.answers?.interruption;
    } catch (err) {
      if (err instanceof APIError) {
        throw new Error(`JEV decision service returned HTTP ${err.status}`);
      }
      throw err;
    }
    // The SDK types the answer but does not validate the wire, so the two
    // fields the policy uses are checked here.
    if (
      typeof answer?.choice !== "string" ||
      !Object.hasOwn(INTERRUPTION_CRITERIA, answer.choice) ||
      typeof answer.confidence !== "number"
    ) {
      throw new Error("JEV decision service returned an invalid interruption answer");
    }
    return { verdict: answer.choice, confidence: answer.confidence };
  }
}
