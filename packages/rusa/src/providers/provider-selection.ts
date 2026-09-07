import type { RusaConfig } from "../config/types.js";
import { isAntigravityGeminiModel, validateModelPin } from "./model-catalog.js";
import {
  CODEX_REASONING_EFFORTS,
  type ModelEffortSelection,
  normalizeModelEffortSelection,
  validateReasoningEffort,
} from "./reasoning-effort.js";

interface ProviderCapability {
  efforts?: readonly string[];
}

/**
 * Execution-free provider descriptor shared with the runtime registry. Keeping
 * all supported commands here lets config load validate selection without
 * importing provider implementations, while the registry's exact mapping below
 * makes a missing or extra implementation a type error.
 */
export const PROVIDER_CAPABILITIES = {
  claude: { efforts: ["low", "medium", "high", "xhigh", "max"] },
  codex: { efforts: CODEX_REASONING_EFFORTS },
  agy: { efforts: ["low", "medium", "high"] },
  kimi: {},
  copilot: {},
  fake: {},
} as const satisfies Readonly<Record<string, ProviderCapability>>;

export type ProviderCommand = keyof typeof PROVIDER_CAPABILITIES;

export function isProviderCommand(command: string): command is ProviderCommand {
  return command in PROVIDER_CAPABILITIES;
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
  effort?: string | null
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
  const capability: ProviderCapability | undefined = isProviderCommand(capabilityName)
    ? PROVIDER_CAPABILITIES[capabilityName]
    : undefined;
  let allowedEfforts = capability?.efforts;
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
      console.warn(`[model-catalog] ${validation.warning}`);
    } else if (validation.efforts && validation.efforts.length > 0) {
      allowedEfforts = validation.efforts;
    }
  }
  validateReasoningEffort(capabilityName, selection.model, selection.effort, allowedEfforts);
  return selection;
}
