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

export function deterministicExhaustionFallback(output: string): ExhaustionFallbackResult {
  const lower = output.toLowerCase();

  // Network transient error detection
  if (
    lower.includes("connection timed out") ||
    lower.includes("connection timeout") ||
    lower.includes("network changed") ||
    lower.includes("network change") ||
    lower.includes("getaddrinfo") ||
    lower.includes("eai_again") ||
    lower.includes("socket hang up") ||
    lower.includes("network is unreachable") ||
    lower.includes("etimedout") ||
    lower.includes("enetunreach") ||
    lower.includes("ehostunreach") ||
    lower.includes("enetdown") ||
    lower.includes("enotfound") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("econnaborted") ||
    lower.includes("dns lookup") ||
    lower.includes("dns resolution") ||
    lower.includes("fetch failed") ||
    lower.includes("network error") ||
    lower.includes("networkerror") ||
    lower.includes("clientnetworkerror") ||
    lower.includes("socketerror") ||
    lower.includes("connecttimeouterror") ||
    lower.includes("headerstimeouterror") ||
    lower.includes("bodytimeouterror") ||
    lower.includes("sockettimeouterror") ||
    lower.includes("err_network_changed") ||
    lower.includes("err_connection_timed_out") ||
    lower.includes("err_connection_reset") ||
    lower.includes("err_connection_refused") ||
    lower.includes("err_name_not_resolved") ||
    lower.includes("err_internet_disconnected") ||
    lower.includes("err_address_unreachable") ||
    lower.includes("err_connection_aborted") ||
    lower.includes("err_connection_closed") ||
    lower.includes("err_timed_out") ||
    lower.includes("temporary failure in name resolution") ||
    lower.includes("tls handshake timeout") ||
    lower.includes("ssl handshake timeout") ||
    lower.includes("request timed out") ||
    lower.includes("request timeout") ||
    lower.includes("504 gateway timeout") ||
    lower.includes("gateway timeout") ||
    lower.includes("502 bad gateway") ||
    lower.includes("bad gateway") ||
    lower.includes("503 service unavailable") ||
    lower.includes("service unavailable")
  ) {
    return "transient-network";
  }

  // Quota error detection
  if (
    (lower.includes("quota") &&
      (lower.includes("exhaust") ||
        lower.includes("limit") ||
        lower.includes("deplet") ||
        lower.includes("used up"))) ||
    lower.includes("usage limit") ||
    lower.includes("rate limit") ||
    lower.includes("429") ||
    (lower.includes("5") && lower.includes("hour") && lower.includes("limit")) ||
    (lower.includes("five") && lower.includes("hour") && lower.includes("limit")) ||
    lower.includes("session cap") ||
    lower.includes("session limit") ||
    (lower.includes("hit your") && lower.includes("limit")) ||
    lower.includes("capacity exhausted")
  ) {
    return "quota";
  }

  return "unknown";
}
