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

/**
 * A reference to a named model class defined under `modelClasses` in
 * config.yaml. It is deliberately the *whole* model_config value rather than an
 * entry inside a pool: a class already names a pool, so allowing it to sit
 * beside tuples would make "what did this actor actually ask for" ambiguous.
 */
export interface ModelClassReference {
  class: string;
}

/** A model_config value that names providers/models directly. */
export type ConcreteModelConfigInput = RawProviderModelConfig | RawProviderModelConfig[];

/**
 * Everything a caller may supply as model_config: concrete tuples, or a named
 * class reference resolved against config by {@link resolveModelClasses}.
 * There is still no implicit default — omitting model_config entirely remains
 * an error at every entry point.
 */
export type ModelConfigInput = ConcreteModelConfigInput | ModelClassReference;

export function isModelClassReference(input: unknown): input is ModelClassReference {
  return typeof input === "object" && input !== null && !Array.isArray(input) && "class" in input;
}

/**
 * Narrow an already-resolved model_config, rejecting a residual class
 * reference rather than repairing it. Used where no config is in hand (the
 * config-free mesh fallback, the tuple validator's own entry guard) so a
 * reference that slipped past its resolution boundary fails loudly instead of
 * being read as a tuple with a missing provider.
 */
export function assertConcreteModelConfig(input: ModelConfigInput): ConcreteModelConfigInput {
  if (isModelClassReference(input)) {
    throw new Error(
      `modelConfig carries an unresolved model class reference ({ class: "${input.class}" }) — model classes are resolved against config.yaml and are not available here`
    );
  }
  return input;
}

/**
 * Resolve a named model class reference into the concrete pool config.yaml
 * declares for it, and pass concrete input through untouched (by identity, so
 * no path is silently renormalized). This is the single resolution boundary:
 * each ingress resolves once, up front, and everything downstream sees only
 * tuples.
 *
 * The returned pool is a copy taken at resolution time — that copy is what gets
 * validated and persisted, so a later edit to the class in config.yaml changes
 * only what *new* selections resolve to.
 */
export function resolveModelClasses(
  config: RusaConfig,
  input: ModelConfigInput
): ConcreteModelConfigInput {
  if (!isModelClassReference(input)) {
    if (Array.isArray(input)) {
      for (const entry of input) {
        if (isModelClassReference(entry)) {
          throw new Error(
            `model class reference { class: "${entry.class}" } must be the whole model_config value, not one entry inside a pool`
          );
        }
      }
    }
    return input;
  }
  const name = input.class?.trim();
  if (!name) {
    throw new Error("model class reference is missing a class name");
  }
  const defined = config.modelClasses?.[name];
  if (!defined) {
    const known = Object.keys(config.modelClasses ?? {}).sort();
    throw new Error(
      known.length > 0
        ? `unknown model class "${name}" — classes configured in config.yaml: ${known.join(", ")}`
        : `unknown model class "${name}" — no modelClasses are configured in config.yaml`
    );
  }
  if (defined.length === 0) {
    throw new Error(
      `model class "${name}" is empty — a class must declare at least one provider/model entry`
    );
  }
  return defined.map((entry) => ({ ...entry }));
}

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
  input: ConcreteModelConfigInput,
  current: readonly ProviderModelConfig[] | undefined
): ConcreteModelConfigInput {
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
  const concrete = assertConcreteModelConfig(input);
  const list = Array.isArray(concrete) ? concrete : [concrete];
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
