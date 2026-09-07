import type { RusaConfig } from "../config/types.js";
import { CODEX_REASONING_EFFORTS } from "./codex-model.js";
import { isAntigravityGeminiModel, validateModelPin } from "./model-catalog.js";
import type { ModelEffortSelection } from "./reasoning-effort.js";
import { normalizeModelEffortSelection, validateReasoningEffort } from "./reasoning-effort.js";

const PROVIDER_REASONING_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: CODEX_REASONING_EFFORTS,
  agy: ["low", "medium", "high"],
};

export interface ProviderSelectionOptions {
  onUnknownModelPin?: (warning: string) => void;
}

/** Default root provider when `config.rootActor` is unset — `agy` (Antigravity). */
export const DEFAULT_ROOT_PROVIDER = "antigravity";
export const DEFAULT_ROOT_EFFORT = "high";

/** The native CLI capability family behind a logical provider config key. */
export function providerCapabilityName(providerName: string, config: RusaConfig): string {
  return config.providers[providerName]?.cliCommand?.trim() || providerName;
}

/**
 * The single config-aware validation and normalization boundary for a requested
 * provider/model/effort combination. Config ingress, spawn, live
 * reconfiguration, and provider construction all route through this function.
 *
 * This module deliberately contains only selection data and validation. Config
 * loading must not pull in provider execution modules, whose sandbox helpers
 * read config at run time.
 */
export function validateProviderSelection(
  config: RusaConfig,
  providerName: string,
  model?: string,
  effort?: string | null,
  options?: ProviderSelectionOptions
): ModelEffortSelection {
  const providerConfig = config.providers[providerName];
  if (!providerConfig) {
    throw new Error(
      `provider "${providerName}" is not configured under "providers" in config.yaml`
    );
  }
  const capabilityName = providerCapabilityName(providerName, config);
  const selection = normalizeModelEffortSelection(capabilityName, model, effort);
  if (model !== undefined && !selection.model) {
    throw new Error(
      `empty model slug requested for provider "${providerName}" — refusing to fall back to the provider's default model `
    );
  }
  let allowedEfforts = PROVIDER_REASONING_EFFORTS[capabilityName];
  if (selection.model) {
    if (
      (capabilityName === "agy" || capabilityName === "antigravity") &&
      !isAntigravityGeminiModel(selection.model)
    ) {
      throw new Error(
        `Antigravity supports Gemini models only; rejected model "${selection.model}" for provider "${providerName}"`
      );
    }
    const validation = validateModelPin(capabilityName, selection.model);
    if (validation.status === "unknown") {
      options?.onUnknownModelPin?.(validation.warning);
    } else if (
      validation.status === "accepted" &&
      validation.efforts &&
      validation.efforts.length > 0
    ) {
      allowedEfforts = validation.efforts;
    }
  }
  validateReasoningEffort(capabilityName, selection.model, selection.effort, allowedEfforts);
  return selection;
}
