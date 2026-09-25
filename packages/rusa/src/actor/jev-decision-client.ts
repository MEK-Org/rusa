import {
  APIError,
  type ChoiceCriteria,
  type ChoiceQuestion,
  choice,
  type EntryType,
  type Fetch,
  type SystemOneResult,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
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

export interface JevFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export type JevFetch = (
  input: string,
  init: JevFetchInit
) => Promise<Response | { ok: boolean; status: number; json(): Promise<unknown> }>;

function adaptFetch(fetchImpl: JevFetch): Fetch {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const rawHeaders = init?.headers ?? {};
    const headers: Record<string, string> =
      rawHeaders instanceof Headers
        ? Object.fromEntries(rawHeaders.entries())
        : (rawHeaders as Record<string, string>);
    const res = await fetchImpl(input, {
      method: init?.method ?? "POST",
      headers,
      body: typeof init?.body === "string" ? init.body : JSON.stringify(init?.body ?? {}),
      signal: init?.signal ?? undefined,
    });
    if (res instanceof Response) return res;
    if (
      typeof (res as Response).clone === "function" &&
      typeof (res as Response).text === "function"
    ) {
      return res as Response;
    }
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/**
 * TypeSafe transport behind the existing JEV seam leveraging the official
 * `@typesafe-ai/sdk` client. It configures single-send (`maxRetries: 0`) and
 * disables SDK logging to ensure no prompt content or retry leaks occur, while
 * the shadow scheduler fails safely to queue.
 */
export class HttpJevDecisionClient implements JevDecisionClient {
  private readonly client: TypeSafeClient;

  constructor(
    apiKey: string,
    private readonly resolveEntry: ResolveJevInboxEntry,
    fetchImpl: JevFetch = globalThis.fetch as unknown as JevFetch,
    client?: TypeSafeClient
  ) {
    this.client =
      client ??
      new TypeSafeClient({
        apiKey,
        baseURL: new URL(JEV_SYSTEM_ONE_URL).origin,
        fetch: adaptFetch(fetchImpl),
        retry: { maxRetries: 0 },
        logLevel: "off",
        dangerouslyAllowBrowser: true,
      });
  }

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

    let result: SystemOneResult<{ interruption: ChoiceQuestion<ChoiceCriteria> }>;
    try {
      result = await this.client.systemOne(
        {
          model: JEV_DEFAULT_MODEL,
          state: {
            incoming,
            candidates,
            candidateSource,
            ...(omittedCandidates > 0 ? { omittedCandidates } : {}),
          } as unknown as EntryType,
          questions: {
            interruption: choice(request.question, {
              interrupt:
                "The arriving item bears on the listed work clearly enough that continuing would waste or spoil it.",
              queue: "The arriving item can safely wait in the queue.",
            }),
          },
        },
        { signal: options.signal }
      );
    } catch (err) {
      if (err instanceof APIError) {
        throw new Error(`JEV decision service returned HTTP ${err.status}`);
      }
      throw err;
    }

    const answer = (
      result as {
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

/**
 * The documented Choice answer is a distribution over the criteria. One that is
 * not (a value outside [0, 1], or a total off 1 by more than rounding) says the
 * answer is malformed, so it is not trusted to carry a verdict.
 */
function hasChoiceProbabilities(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { interrupt, queue } = value as Record<string, unknown>;
  const isProbability = (p: unknown): p is number => typeof p === "number" && p >= 0 && p <= 1;
  return (
    isProbability(interrupt) && isProbability(queue) && Math.abs(interrupt + queue - 1) <= 0.01
  );
}
