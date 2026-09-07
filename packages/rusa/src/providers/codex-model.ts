/** Canonical reasoning levels accepted by the native Codex CLI. */
export const CODEX_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

const CODEX_LEGACY_EFFORT_ALIASES = ["extra-high"] as const;
const CODEX_LEGACY_EFFORTS: readonly string[] = [
  ...CODEX_REASONING_EFFORTS,
  ...CODEX_LEGACY_EFFORT_ALIASES,
];

function recognizedLegacyCodexEffort(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return CODEX_LEGACY_EFFORTS.includes(normalized) ? normalized : undefined;
}

/**
 * Parse a Codex model string into its base model identifier and optional reasoning effort qualifier.
 * Codex models are slugs like 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4-mini'.
 * Reasoning effort (e.g. 'low', 'medium', 'high', 'extra-high', 'none') is configured separately
 * in Codex (via `model_reasoning_effort` in config.toml or `--config model_reasoning_effort=...`)
 * and must not be passed inside `--model <slug>` (which causes 400 errors from ChatGPT-auth accounts).
 */
export function parseCodexModel(rawModel?: string): {
  model?: string;
  reasoningEffort?: string;
} {
  if (!rawModel) return {};
  const trimmed = rawModel.trim();
  if (!trimmed) return {};

  const baseMatch = trimmed.match(/^([^\s(]+)/);
  const baseModel = baseMatch ? baseMatch[1] : trimmed;

  const effortRemainder = trimmed.slice(baseModel.length).trim();
  let reasoningEffort = recognizedLegacyCodexEffort(effortRemainder);
  const parenthesized = effortRemainder.match(/^\((.*)\)$/);
  if (!reasoningEffort && parenthesized) {
    const detail = parenthesized[1].trim();
    reasoningEffort = recognizedLegacyCodexEffort(detail);
    const displayDetail = detail.match(/^reasoning\s+([^,]+),\s*summaries\s+[^,]+$/i);
    if (!reasoningEffort && displayDetail) {
      reasoningEffort = recognizedLegacyCodexEffort(displayDetail[1]);
    }
  }

  return {
    model: baseModel,
    reasoningEffort,
  };
}
