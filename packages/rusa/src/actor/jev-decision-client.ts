import {
  type JevDecisionClient,
  type JevDecisionRequest,
  type JevDecisionResponse,
  JevInputUnavailableError,
} from "./responsive-interruption.js";

/** The documented TypeSafe System One endpoint used for this narrow shadow policy. */
export const JEV_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
/** An alias rather than a pinned release lets the operator's TypeSafe account select its current model. */
export const JEV_DEFAULT_MODEL = "jev-latest";
/**
 * Most candidates resolved and sent per decision, in the scheduler's order.
 * Uncalibrated placeholder: the `pending` fallback can be a whole inbox, and
 * this bounds source reads and request size until shadow data says otherwise.
 * The count left out is still sent, so the model knows the list was cut.
 */
export const JEV_MAX_CANDIDATES = 20;

export interface JevResolvedInboxEntry {
  id: string;
  source: string;
  /** Inbox payload type, so a candidate without readable text still says what it is. */
  type: string;
  /** Source text (bounded), or null when the source could not be read. Never persisted. */
  text: string | null;
  truncated?: true;
}

/** Host-owned resolution boundary; neither the scheduler nor its audit stores text. */
export type ResolveJevInboxEntry = (
  actorId: string,
  entryId: string,
  signal?: AbortSignal
) => Promise<JevResolvedInboxEntry>;

export type JevFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Minimal TypeSafe transport behind the existing JEV seam. It intentionally
 * sends one typed Choice question and does no retry: every retry would resend
 * real inbox text, while the shadow scheduler already fails safely to queue.
 */
export class HttpJevDecisionClient implements JevDecisionClient {
  constructor(
    private readonly apiKey: string,
    private readonly resolveEntry: ResolveJevInboxEntry,
    private readonly fetchImpl: JevFetch = globalThis.fetch as unknown as JevFetch
  ) {}

  async decide(
    request: JevDecisionRequest,
    options: { signal?: AbortSignal } = {}
  ): Promise<JevDecisionResponse> {
    const { actorId } = request;
    const { incomingEntryId, candidateEntryIds, candidateSource } = request.input;
    const sent = candidateEntryIds.slice(0, JEV_MAX_CANDIDATES);
    const [incoming, ...candidates] = await Promise.all(
      [incomingEntryId, ...sent].map((entryId) =>
        this.resolveEntry(actorId, entryId, options.signal)
      )
    );
    // Without the arriving item's text there is nothing to decide. That is an
    // input gap, not a transport failure, and the audit keeps them apart.
    if (!incoming || incoming.text === null) throw new JevInputUnavailableError();
    const omittedCandidates = candidateEntryIds.length - sent.length;

    const response = await this.fetchImpl(JEV_SYSTEM_ONE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: options.signal,
      body: JSON.stringify({
        model: JEV_DEFAULT_MODEL,
        state: {
          incoming,
          candidates,
          candidateSource,
          ...(omittedCandidates > 0 ? { omittedCandidates } : {}),
        },
        questions: {
          interruption: {
            type: "choice",
            instructions: request.question,
            criteria: {
              interrupt:
                "The arriving item bears on the listed work clearly enough that continuing would waste or spoil it.",
              queue: "The arriving item can safely wait in the queue.",
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`JEV decision service returned HTTP ${response.status}`);

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new Error("JEV decision service returned invalid JSON");
    }
    const answer = (
      parsed as {
        answers?: Record<
          string,
          { type?: unknown; choice?: unknown; probabilities?: unknown; confidence?: unknown }
        >;
      }
    ).answers?.interruption;
    if (
      !answer ||
      answer.type !== "choice" ||
      typeof answer.choice !== "string" ||
      !hasChoiceProbabilities(answer.probabilities) ||
      typeof answer.confidence !== "number"
    ) {
      throw new Error("JEV decision service returned an invalid interruption answer");
    }
    return { verdict: answer.choice, confidence: answer.confidence };
  }
}

function hasChoiceProbabilities(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const probabilities = value as Record<string, unknown>;
  return (
    typeof probabilities.interrupt === "number" &&
    typeof probabilities.queue === "number" &&
    Number.isFinite(probabilities.interrupt) &&
    Number.isFinite(probabilities.queue)
  );
}
