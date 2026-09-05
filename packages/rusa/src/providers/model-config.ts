import type { RusaConfig } from "../config/types.js";
import { providerCapabilityName, validateProviderSelection } from "./registry.js";

/**
 * One declared provider/model/effort choice — the atomic unit of the
 * modelConfig/model_config API. A bare object is a fixed choice; an ordered
 * array is a pool of acceptable choices, tried earliest-available first.
 */
export interface ProviderModelConfig {
  provider: string;
  model: string;
  effort?: string;
}

/**
 * One raw provider/model/effort entry as it arrives from untrusted input
 * (YAML, JSON, an MCP tool call) — `model` is optional here only because
 * nothing upstream of {@link validateModelConfigPool} can enforce the
 * required-field contract on parsed input; the validated
 * {@link ProviderModelConfig} that comes out always has one.
 */
export interface RawProviderModelConfig {
  provider: string;
  model?: string;
  effort?: string;
}

export type ModelConfigInput = RawProviderModelConfig | RawProviderModelConfig[];

/**
 * Standing default coder pool used by `spawn_thread` when the caller omits
 * `model_config` — earliest-available order. See MEK-Org/rusa#169. A pool of
 * this length requires a portable actor (`context_mode: "ledger" | "tail"`);
 * an omitted `model_config` on a native spawn still fails
 * {@link validateModelConfigPool}'s portable-only check, same as an explicit
 * multi-entry pool would.
 */
export const DEFAULT_CODER_POOL: readonly ProviderModelConfig[] = [
  { provider: "claude", model: "claude-opus-5" },
  { provider: "kimi", model: "kimi-for-coding" },
  { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
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
/**
 * Fill an omitted `model` on each entry from the actor's current declared
 * pool, matched by provider — so an effort-only or provider-only partial
 * `setActorModel` update ("keep running the same model, just change the
 * effort") keeps working under the required-model contract. An entry whose
 * provider has no match in `current` (e.g. a genuine cross-provider move)
 * is left as-is and will still fail {@link validateModelConfigPool}'s
 * required-model check — falling back to the actor's own currently-running
 * model is safe and intentional; falling back to an unrelated provider's
 * default is exactly what #169 forbids.
 */
export function fillModelConfigFromCurrent(
  input: ModelConfigInput,
  current: readonly ProviderModelConfig[] | undefined
): ModelConfigInput {
  const filled = (Array.isArray(input) ? input : [input]).map((entry) => {
    if (entry.model?.trim()) return entry;
    const match = current?.find((c) => c.provider === entry.provider);
    return match ? { ...entry, model: match.model } : entry;
  });
  return Array.isArray(input) ? filled : filled[0];
}

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
    // An omitted or blank model must fail here, before anything is mutated —
    // never silently fall through to the provider's own default. #169
    // migrates the formerly-required spawn model onto every pool entry.
    const requestedModel = entry.model?.trim();
    if (!requestedModel) {
      throw new Error(
        `modelConfig entry for provider "${providerName}" is missing a model — omitted/blank models are not allowed, since that would silently select the provider's default`
      );
    }
    const selection = validateProviderSelection(config, providerName, requestedModel, entry.effort);
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
    if (!selection.model) {
      throw new Error(
        `modelConfig entry for provider "${providerName}" resolved to no model — this should be unreachable since a model was required above`
      );
    }
    return { provider: providerName, model: selection.model, effort: selection.effort };
  });
}
