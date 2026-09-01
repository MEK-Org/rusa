import { parseCodexModel } from "./codex.js";

/**
 * Provider-native reasoning level. This deliberately remains a string rather
 * than a mesh-wide enum: providers expose different vocabularies.
 */
export type ReasoningEffort = string;

export interface ModelEffortSelection {
  model?: string;
  effort?: ReasoningEffort;
}

const EFFORT_ALIASES: Readonly<Record<string, string>> = {
  "extra-high": "xhigh",
};

export function normalizeReasoningEffort(effort: string): string {
  const normalized = effort.trim().toLowerCase();
  if (!normalized) throw new Error("reasoning effort must be a non-empty string");
  return EFFORT_ALIASES[normalized] ?? normalized;
}

/**
 * Split legacy Codex pins such as `gpt-5.6-sol medium` into the two durable
 * settings. Explicit first-class effort wins only when it agrees; conflicting
 * declarations fail instead of silently changing effective behavior.
 */
export function normalizeModelEffortSelection(
  provider: string,
  rawModel?: string,
  rawEffort?: string
): ModelEffortSelection {
  const model = rawModel?.trim() || undefined;
  const explicitEffort = rawEffort === undefined ? undefined : normalizeReasoningEffort(rawEffort);
  if (provider !== "codex" || !model) {
    return { model, effort: explicitEffort };
  }

  const parsed = parseCodexModel(model);
  const legacyEffort = parsed.reasoningEffort
    ? normalizeReasoningEffort(parsed.reasoningEffort)
    : undefined;
  if (parsed.model !== model && legacyEffort === undefined) {
    throw new Error(
      `unrecognized legacy Codex model qualifier in "${model}"; pass the model slug and effort as separate settings`
    );
  }
  if (explicitEffort && legacyEffort && explicitEffort !== legacyEffort) {
    throw new Error(
      `conflicting reasoning efforts for provider "codex": model pin carries "${legacyEffort}" but effort is "${explicitEffort}"`
    );
  }
  return {
    model: parsed.model,
    effort: explicitEffort ?? legacyEffort,
  };
}

/**
 * Validate an explicit effort against the provider adapter's native vocabulary.
 * Model-specific compatibility remains owned by the native CLI/server: keeping
 * a second model×effort matrix here would drift and could reject newly valid
 * combinations. Native failures retain the exact selection in failure notices.
 */
export function validateReasoningEffort(
  provider: string,
  model: string | undefined,
  effort: string | undefined,
  supportedEfforts: readonly string[] | undefined
): void {
  if (effort === undefined) return;
  const normalized = normalizeReasoningEffort(effort);
  if (!supportedEfforts) {
    throw new Error(
      `provider "${provider}" does not expose a reasoning-effort control; omit effort to use its default behavior`
    );
  }
  const supported = supportedEfforts.map(normalizeReasoningEffort);
  if (!supported.includes(normalized)) {
    throw new Error(
      `reasoning effort validation failed for provider "${provider}"${model ? ` / model "${model}"` : ""}: rejected "${effort}"; acceptable values: ${supported.map((value) => `"${value}"`).join(", ")}`
    );
  }
}
