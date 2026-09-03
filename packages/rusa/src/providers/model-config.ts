import type { RusaConfig } from "../config/types.js";
import { providerCapabilityName, validateProviderSelection } from "./registry.js";

/**
 * One declared provider/model/effort choice — the atomic unit of the
 * modelConfig/model_config API. A bare object is a fixed choice; an ordered
 * array is a pool of acceptable choices, tried earliest-available first.
 */
export interface ProviderModelConfig {
  provider: string;
  model?: string;
  effort?: string;
}

export type ModelConfigInput = ProviderModelConfig | ProviderModelConfig[];

/**
 * Standing default coder pool used by `spawn_thread` when the caller omits
 * `model_config` — earliest-available order. See MEK-Org/rusa#169. A pool of
 * this length requires a portable actor (`context_mode: "ledger" | "tail"`);
 * an omitted `model_config` on a native spawn still fails
 * {@link validateModelConfigPool}'s portable-only check, same as an explicit
 * multi-entry pool would.
 */
export const DEFAULT_CODER_POOL: readonly ProviderModelConfig[] = [
  { provider: "claude", model: "claude-sonnet-5" },
  { provider: "kimi", model: "kimi-for-coding" },
  { provider: "codex", model: "gpt-5.6-sol" },
];

/**
 * Bounds a modelConfig pool so a misconfigured actor can't fan a single spawn
 * out across an unbounded number of provider lanes.
 */
export const MAX_MODEL_CONFIG_POOL_SIZE = 8;

/**
 * Normalize the modelConfig/model_config object-or-array API into a bounded,
 * non-empty, declaration-ordered `ProviderModelConfig[]`, validating every
 * tuple through {@link validateProviderSelection} — the single config-aware
 * boundary — and rejecting empty/oversized/duplicate pools. Pools longer than
 * one require a portable actor: a native provider session is tied to one
 * provider and can't be handed between candidates.
 */
export function validateModelConfigPool(
  config: RusaConfig,
  input: ModelConfigInput,
  opts: { portable: boolean }
): ProviderModelConfig[] {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0) {
    throw new Error("modelConfig must declare at least one provider/model entry");
  }
  if (list.length > MAX_MODEL_CONFIG_POOL_SIZE) {
    throw new Error(
      `modelConfig may declare at most ${MAX_MODEL_CONFIG_POOL_SIZE} entries, got ${list.length}`
    );
  }
  if (list.length > 1 && !opts.portable) {
    throw new Error(
      "a modelConfig pool of more than one entry requires a portable actor — a native provider session can't move between candidates"
    );
  }

  const seen = new Set<string>();
  return list.map((entry) => {
    const providerName = entry.provider?.trim();
    if (!providerName) {
      throw new Error("modelConfig entry is missing a provider");
    }
    const selection = validateProviderSelection(config, providerName, entry.model, entry.effort);
    const identity = JSON.stringify([
      providerCapabilityName(providerName, config),
      selection.model ?? "",
      selection.effort ?? "",
    ]);
    if (seen.has(identity)) {
      throw new Error(
        `modelConfig has a duplicate entry: provider "${providerName}"${selection.model ? ` model "${selection.model}"` : ""}${selection.effort ? ` effort "${selection.effort}"` : ""}`
      );
    }
    seen.add(identity);
    return { provider: providerName, model: selection.model, effort: selection.effort };
  });
}
