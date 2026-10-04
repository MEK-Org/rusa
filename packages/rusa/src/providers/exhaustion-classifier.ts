import { Type } from "@google/genai";
import { sanitizeFailureText } from "../actor/failure-sink.js";
import { extractGeminiText, getGeminiClient } from "../understanding/gemini-utils.js";
import type { RunResult } from "./types.js";

// Upper bound on the failed-run text handed to the remote classifier. The
// exhaustion signal lives at the tail of the output, so we keep the tail.
const CLASSIFIER_INPUT_LEN = 2000;

export interface ExhaustionClassification {
  exhausted: boolean;
}

export type ExhaustionClassifier = (result: RunResult) => Promise<ExhaustionClassification>;

export function createExhaustionClassifier(geminiApiKey?: string): ExhaustionClassifier {
  return async (result) => classifyRunExhaustion(result, geminiApiKey);
}

export type ExhaustionFallbackResult = "quota" | "transient-network" | "unknown";

export async function classifyRunExhaustion(
  result: RunResult,
  geminiApiKey?: string
): Promise<ExhaustionClassification> {
  if (result.success) return { exhausted: false };
  const output = (result.output ?? "").trim();
  if (!output) return { exhausted: false };

  if (!geminiApiKey) {
    const classification = deterministicExhaustionFallback(output);
    if (classification === "transient-network") {
      console.warn(
        `[exhaustion-classifier] Transient network error detected in fallback: ${output}`
      );
    }
    return { exhausted: classification === "quota" };
  }

  // The remote classifier must never see in-flight tool-call/request payloads:
  // scrub them (same rules as the failure sink) and cap length before it leaves
  // the process. On the primary-failed-then-fallback-succeeds path no failure
  // sink ever runs, so this is the only place that sanitizes this text.
  const classifierInput = sanitizeFailureText(output).slice(-CLASSIFIER_INPUT_LEN);

  try {
    const client = getGeminiClient(geminiApiKey);
    const response = await client.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents:
        "Classify this failed coding-agent run. Return exhausted=true only when the failure " +
        "is caused by the selected model/provider capacity being unavailable or exhausted: " +
        "weekly or periodic quota, usage credits depleted, rate limit, temporary provider " +
        "capacity limit, or a session/window cap such as a five-hour limit. Return false " +
        "for auth, syntax, tool, sandbox, cancellation, network setup, or ordinary command " +
        `failures.\n\n${classifierInput}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            exhausted: {
              type: Type.BOOLEAN,
              description:
                "True when retrying on a configured fallback model is appropriate because model/provider capacity is exhausted.",
            },
          },
          required: ["exhausted"],
        },
        systemInstruction:
          "You are a strict error classifier for a coding-agent harness. Prefer false unless " +
          "the failed run is clearly blocked by model/provider capacity exhaustion. Do not " +
          "quote or summarize the input; return only the JSON schema.",
      },
    });
    const text = await extractGeminiText(response);
    const parsed = JSON.parse(text) as { exhausted?: unknown };
    return { exhausted: parsed.exhausted === true };
  } catch (err) {
    const classification = deterministicExhaustionFallback(output);
    console.warn(
      `[exhaustion-classifier] Remote classifier failed (using deterministic fallback: ${classification}). Error: ${err instanceof Error ? err.message : String(err)}`
    );
    if (classification === "transient-network") {
      console.warn(
        `[exhaustion-classifier] Transient network error detected in fallback: ${output}`
      );
    }
    return { exhausted: classification === "quota" };
  }
}

// One rule source serves both the full-output fallback and bounded raw capture.
const NETWORK_TERMS = [
  "connection timed out",
  "connection timeout",
  "network changed",
  "network change",
  "getaddrinfo",
  "eai_again",
  "socket hang up",
  "network is unreachable",
  "etimedout",
  "enetunreach",
  "ehostunreach",
  "enetdown",
  "enotfound",
  "econnrefused",
  "econnreset",
  "econnaborted",
  "dns lookup",
  "dns resolution",
  "fetch failed",
  "network error",
  "networkerror",
  "clientnetworkerror",
  "socketerror",
  "connecttimeouterror",
  "headerstimeouterror",
  "bodytimeouterror",
  "sockettimeouterror",
  "err_network_changed",
  "err_connection_timed_out",
  "err_connection_reset",
  "err_connection_refused",
  "err_name_not_resolved",
  "err_internet_disconnected",
  "err_address_unreachable",
  "err_connection_aborted",
  "err_connection_closed",
  "err_timed_out",
  "temporary failure in name resolution",
  "tls handshake timeout",
  "ssl handshake timeout",
  "request timed out",
  "request timeout",
  "504 gateway timeout",
  "gateway timeout",
  "502 bad gateway",
  "bad gateway",
  "503 service unavailable",
  "service unavailable",
] as const;
const QUOTA_RULES: readonly (readonly string[])[] = [
  ["quota", "exhaust"],
  ["quota", "limit"],
  ["quota", "deplet"],
  ["quota", "used up"],
  ["usage limit"],
  ["rate limit"],
  ["429"],
  ["5", "hour", "limit"],
  ["five", "hour", "limit"],
  ["session cap"],
  ["session limit"],
  ["hit your", "limit"],
  ["capacity exhausted"],
];

const EXHAUSTION_TERMS = [...new Set([...NETWORK_TERMS, ...QUOTA_RULES.flat()])];
const EXHAUSTION_OVERLAP = Math.max(...EXHAUSTION_TERMS.map((term) => term.length)) - 1;

function matchingExhaustionRule(has: (term: string) => boolean): {
  classification: ExhaustionFallbackResult;
  terms: readonly string[];
} {
  // Preserve the existing network-over-quota precedence, including composite
  // quota facts that may occur arbitrarily far apart in the complete stream.
  const network = NETWORK_TERMS.find(has);
  if (network) return { classification: "transient-network", terms: [network] };
  const quota = QUOTA_RULES.find((terms) => terms.every(has));
  return quota
    ? { classification: "quota", terms: quota }
    : { classification: "unknown", terms: [] };
}

// Bounded raw capture labels its exact omitted-byte count. The count is our own
// accounting, not provider text, so its digits must never satisfy the "429" or
// "5"/"hour"/"limit" rules. Only this exact whole line is ignored.
const OMITTED_DIAGNOSTIC_LABEL = /^\[Codex raw diagnostics: \d+ UTF-8 bytes omitted; tail\]$/gm;

export function omittedDiagnosticLabel(omittedBytes: number): string {
  return `[Codex raw diagnostics: ${omittedBytes} UTF-8 bytes omitted; tail]`;
}

export function deterministicExhaustionFallback(output: string): ExhaustionFallbackResult {
  const lower = output.replace(OMITTED_DIAGNOSTIC_LABEL, "").toLowerCase();
  return matchingExhaustionRule((term) => lower.includes(term)).classification;
}

/** Internal capture helper: literal facts plus the longest chunk-boundary overlap.
 * It deliberately matches the same interleaved raw stdout/stderr as the existing
 * fallback, including tool-output false positives. It is not provider diagnosis.
 */
export class ExhaustionDiagnosticMatcher {
  private readonly observed = new Set<string>();
  private suffix = "";

  push(text: string): void {
    // Lowercase only bounded windows, including for one giant diagnostic chunk.
    for (let start = 0; start < text.length; start += 4096) {
      const part = text.slice(start, start + 4096);
      const lower = (this.suffix + part).toLowerCase();
      for (const term of EXHAUSTION_TERMS) {
        if (!this.observed.has(term) && lower.includes(term)) this.observed.add(term);
      }
      this.suffix = (this.suffix + part).slice(-EXHAUSTION_OVERLAP);
    }
  }

  classification(): ExhaustionFallbackResult {
    return matchingExhaustionRule((term) => this.observed.has(term)).classification;
  }

  /** Truthful matched terms also reproduce the existing deterministic decision.
   * Call only when raw fallback eviction would otherwise change that decision.
   * The vocabulary/summary coupling is pinned at the provider/classifier boundary.
   * This does not promise equivalence for the already-bounded remote classifier.
   */
  evidence(): string {
    const { terms } = matchingExhaustionRule((term) => this.observed.has(term));
    return `[Codex raw diagnostic terms matched before tail eviction: ${terms.map((term) => JSON.stringify(term)).join(", ")}]`;
  }
}
