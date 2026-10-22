import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type {
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAI,
} from "@google/genai";
import { resolveHome } from "../config/index.js";
import { createLogger, type Logger } from "./logger.js";

export const GEMINI_USAGE_EVENT = "gemini_usage";
export const GEMINI_USAGE_PURPOSES = [
  "portable_compaction",
  "quota_parse",
  "model_catalog_parse",
  "kimi_screen_classification",
  "exhaustion_classification",
  "understanding_distillation",
  "understanding_retrieval",
  "avatar_generation",
  "speech_transcription",
  "speech_synthesis",
] as const;
export type GeminiUsagePurpose = (typeof GEMINI_USAGE_PURPOSES)[number];

// Names deliberately avoid "token": the logger redacts credential fields
// containing that word. Provider counts are copied through this allowlist only.
export const GEMINI_COUNT_FIELDS = {
  input: "promptTokenCount",
  response: "candidatesTokenCount",
  thinking: "thoughtsTokenCount",
  cachedInput: "cachedContentTokenCount",
  toolInput: "toolUsePromptTokenCount",
  total: "totalTokenCount",
} as const;
export type GeminiCounts = { -readonly [K in keyof typeof GEMINI_COUNT_FIELDS]: number | null };

/** Optional mesh identity present at an already-attributed call site. */
export interface GeminiUsageAttribution {
  actorId?: string | null;
  runId?: string | null;
}

export interface GeminiUsageRecord {
  version: 1;
  occurredAt: string;
  instanceId: string;
  processId: string;
  pid: number;
  attemptId: string;
  purpose: GeminiUsagePurpose;
  actorId: string | null;
  runId: string | null;
  requestedModel: string;
  model: string;
  outcome: "response" | "error" | "cancelled";
  usage: "complete" | "partial" | "missing";
  /** An interrupted stream's last snapshot; never included in completed totals. */
  partial: boolean;
  counts: GeminiCounts;
}

const processId = randomUUID();
let usageLogger: Logger | undefined;
let instanceId: string | undefined;

// Stable per host/home, opaque in exported logs: no hostname or home path.
function instanceIdentity(home: string): string {
  return createHash("sha256")
    .update(`${hostname()}\0${resolve(home)}`)
    .digest("hex");
}

/** Service entrypoints share their configured, credential-scrubbing logger. */
export function configureGeminiUsage(logger: Logger, home: string): void {
  usageLogger = logger.child({ component: "gemini-usage" });
  instanceId = instanceIdentity(home);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function geminiCounts(metadata: unknown): GeminiCounts {
  const source = object(metadata);
  const counts = {} as GeminiCounts;
  for (const [name, providerName] of Object.entries(GEMINI_COUNT_FIELDS)) {
    const value = source?.[providerName];
    counts[name as keyof GeminiCounts] =
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  return counts;
}

function usageIdentifier(value: unknown): string | null {
  // Identifiers are correlation keys, unlike displayable model names. Refuse
  // an overlong value rather than recording a plausible-looking truncation.
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

/** One observable application request, including every outer retry/fallback. */
export function beginGeminiAttempt(
  purpose: GeminiUsagePurpose,
  requestedModel: string,
  attribution?: GeminiUsageAttribution
) {
  const attemptId = randomUUID();
  // Capture the sink and identity now: overlapping requests cannot switch sinks.
  const logger = usageLogger;
  const instance = instanceId;
  const actorId = usageIdentifier(attribution?.actorId);
  // A run always belongs to an actor. Do not create an orphan run id when a
  // caller only has instance-level context.
  const runId = actorId === null ? null : usageIdentifier(attribution?.runId);
  let counts = geminiCounts(undefined);
  let model = requestedModel;
  let finished = false;
  return {
    /** Stream metadata is cumulative: keep the last snapshot, never add chunks. */
    observe(response: unknown): void {
      try {
        const source = object(response);
        if (object(source?.usageMetadata)) counts = geminiCounts(source?.usageMetadata);
        if (typeof source?.modelVersion === "string" && source.modelVersion.length > 0) {
          model = source.modelVersion.slice(0, 200);
        }
      } catch {
        /* Telemetry getters must preserve the API result. */
      }
    },
    finish(outcome: GeminiUsageRecord["outcome"], partial = false): void {
      if (finished) return;
      finished = true;
      try {
        const anyCounts = Object.values(counts).some((value) => value !== null);
        const record: GeminiUsageRecord = {
          version: 1,
          occurredAt: new Date().toISOString(),
          instanceId: instance ?? instanceIdentity(resolveHome()),
          processId,
          pid: process.pid,
          attemptId,
          purpose,
          actorId,
          runId,
          requestedModel: requestedModel.slice(0, 200),
          model: model.slice(0, 200),
          outcome,
          usage: !anyCounts
            ? "missing"
            : partial || counts.input === null || counts.response === null || counts.total === null
              ? "partial"
              : "complete",
          partial,
          counts,
        };
        const sink = logger ?? createLogger({ context: { component: "gemini-usage" } });
        sink.info(GEMINI_USAGE_EVENT, { usage: record });
      } catch {
        // Accounting must preserve the API result, retry policy and scheduling.
      }
    },
  };
}

/** Capture returned usage before parsing/validation at the caller can reject it. */
export async function observeGeminiRequest<T>(
  purpose: GeminiUsagePurpose,
  model: string,
  request: () => Promise<T>,
  attribution?: GeminiUsageAttribution
): Promise<T> {
  const attempt = beginGeminiAttempt(purpose, model, attribution);
  try {
    const response = await request();
    attempt.observe(response);
    attempt.finish("response");
    return response;
  } catch (error) {
    attempt.finish("error");
    throw error;
  }
}

/** SDK boundary: derive the requested model from the unchanged request itself. */
export function generateGeminiContent(
  client: Pick<GoogleGenAI, "models">,
  purpose: GeminiUsagePurpose,
  request: GenerateContentParameters,
  attribution?: GeminiUsageAttribution
): Promise<GenerateContentResponse> {
  return observeGeminiRequest(
    purpose,
    request.model,
    () => client.models.generateContent(request),
    attribution
  );
}
