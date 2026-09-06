import type { ProviderConfig, RusaConfig } from "../config/types.js";
import { AntigravityProvider } from "./antigravity.js";
import { ClaudeProvider } from "./claude.js";
import { CODEX_REASONING_EFFORTS, CodexProvider } from "./codex.js";
import { CopilotProvider } from "./copilot.js";
import { FakeProvider } from "./fake-provider.js";
import { KimiProvider } from "./kimi.js";
import { isAntigravityGeminiModel, validateModelPin } from "./model-catalog.js";
import type { ModelEffortSelection } from "./reasoning-effort.js";
import { normalizeModelEffortSelection, validateReasoningEffort } from "./reasoning-effort.js";
import type { CodingProvider } from "./types.js";

// Keyed by CLI command (the `cliCommand` resolved in getProvider). Antigravity's
// binary is `agy`, so it registers under "agy" while its provider name is
// "antigravity".
interface ProviderAdapter {
  create: (name: string, config: ProviderConfig, model?: string, effort?: string) => CodingProvider;
  /** Provider-level native CLI vocabulary. Absent means no effort control. */
  efforts?: readonly string[];
}

const providerAdapters: Readonly<Record<string, ProviderAdapter>> = {
  claude: {
    create: (name, config, model, effort) => new ClaudeProvider(name, config, model, effort),
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    create: (name, config, model, effort) => new CodexProvider(name, config, model, effort),
    efforts: CODEX_REASONING_EFFORTS,
  },
  agy: {
    create: (name, config, model, effort) =>
      new AntigravityProvider(name, config, model, undefined, effort),
    efforts: ["low", "medium", "high"],
  },
  kimi: { create: (name, config, model) => new KimiProvider(name, config, model) },
  copilot: { create: (name, config, model) => new CopilotProvider(name, config, model) },
  fake: { create: (name) => new FakeProvider(undefined, name) },
};

/** Returns the effective provider config for a given provider name. */
function getEffectiveProviderConfig(
  providerName: string,
  config: RusaConfig
): RusaConfig["providers"][string] | undefined {
  return config.providers[providerName];
}

/** Default root provider when `config.rootActor` is unset — `agy` (Antigravity). */
export const DEFAULT_ROOT_PROVIDER = "antigravity";
export const DEFAULT_ROOT_EFFORT = "high";

/** The native CLI capability family behind a logical provider config key. */
export function providerCapabilityName(providerName: string, config: RusaConfig): string {
  return getEffectiveProviderConfig(providerName, config)?.cliCommand?.trim() || providerName;
}

/**
 * The canonical provider-pacing lane key for a configured provider name — the
 * shared identity used to fan multiple config keys aliasing the same CLI (or
 * modelConfig pool entries) onto one pacer/quota lane. Antigravity's binary is
 * `agy`, so it canonicalizes there even when `cliCommand` is left unset.
 */
export function providerThrottleKey(providerName: string, config: RusaConfig): string {
  const cliCommand = config.providers[providerName]?.cliCommand;
  const key = cliCommand ?? providerName;
  return key === "antigravity" ? "agy" : key;
}

/**
 * The single config-aware validation and normalization boundary for a requested
 * provider/model/effort combination. Config ingress, spawn, live
 * reconfiguration, and provider construction all route through this function.
 */
export function validateProviderSelection(
  config: RusaConfig,
  providerName: string,
  model?: string,
  effort?: string | null
): ModelEffortSelection {
  const providerConfig = getEffectiveProviderConfig(providerName, config);
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
  let allowedEfforts = providerAdapters[capabilityName]?.efforts;
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

/**
 * Resolve the provider the root actor runs on. Config-driven and intentionally
 * independent of the DB enabled-models / persona quota routing — the root model
 * is just config ("default cheap (agy), Claude escape-hatch"; see the actor-mesh
 * design). Defaults to agy; honors an optional `root.model` override. Throws if
 * `root.provider` isn't declared under `providers`.
 */
export function resolveRootProvider(config: RusaConfig): CodingProvider {
  const providerName = config.rootActor?.provider?.trim() || DEFAULT_ROOT_PROVIDER;
  const isDefaultRoot = !config.rootActor?.provider?.trim();
  const selection = validateProviderSelection(
    config,
    providerName,
    config.rootActor?.model,
    config.rootActor?.effort ?? (isDefaultRoot ? DEFAULT_ROOT_EFFORT : undefined)
  );
  return instantiateProvider(providerName, selection.model, selection.effort, config);
}

/**
 * Normalize `rootActor.fallbackModel` (string | string[] | unset) to a clean
 * list. Root-only : the root Actor's own `fallback:` option resolves a
 * fresh provider per fallback model (see start.ts) — this list is never
 * passed to a CLI provider as a launch-time flag.
 */
export function normalizeFallbackModel(config: RusaConfig): string[] | undefined {
  const raw = config.rootActor?.fallbackModel;
  if (raw == null) return undefined;
  const list = (Array.isArray(raw) ? raw : [raw]).map((m) => m.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/**
 * Resolve an arbitrary configured provider by name (a key under `providers`),
 * with an optional model. Used to run a worker actor on a different harness than
 * the root (e.g. an agy root delegating to a claude worker) — config-driven, like
 * {@link resolveRootProvider}, and independent of the DB persona/quota routing.
 * Throws if the provider isn't declared under `providers`, or if a model was
 * requested but is blank — silently dropping a requested model would hand the
 * run to the provider's default, a ISSUE_NUM-class silent substitution .
 */
export function resolveProvider(
  config: RusaConfig,
  providerName: string,
  model?: string,
  effort?: string
): CodingProvider {
  return resolveProviderWithSelection(config, providerName, model, effort).provider;
}

/**
 * Resolve a configured provider together with the canonical model/effort tuple
 * passed to it. Callers that expose a launch selection to an actor prompt use
 * this result instead of retaining a pre-normalization request.
 */
export function resolveProviderWithSelection(
  config: RusaConfig,
  providerName: string,
  model?: string,
  effort?: string
): { provider: CodingProvider; selection: ModelEffortSelection } {
  const selection = validateProviderSelection(config, providerName, model, effort);
  return {
    provider: instantiateProvider(providerName, selection.model, selection.effort, config),
    selection,
  };
}

/**
 * Instantiate a provider directly from its config, given an already-resolved
 * (or absent) model. Shared by {@link resolveRootProvider} and
 * {@link resolveProvider} (both config-driven). For CLI providers `modelName`
 * may be undefined → the CLI's own default model runs.
 */
function instantiateProvider(
  providerName: string,
  modelName: string | undefined,
  effort: string | undefined,
  config: RusaConfig
): CodingProvider {
  const providerConfig = getEffectiveProviderConfig(providerName, config);
  if (!providerConfig) {
    throw new Error(`Provider "${providerName}" not found in config`);
  }

  // Display name is "model (provider)" for CLI execution, or just the provider
  // name when no model is pinned (the CLI then uses its default).
  const selectionName = modelName
    ? `${modelName}${effort ? ` @ ${effort}` : ""}`
    : effort
      ? `default @ ${effort}`
      : undefined;
  const displayName = selectionName ? `${selectionName} (${providerName})` : providerName;

  const command = providerConfig.cliCommand ?? providerName;
  const adapter = providerAdapters[command];
  if (!adapter) {
    throw new Error(
      `No implementation for CLI command "${command}" (requested by provider "${providerName}")`
    );
  }

  return adapter.create(displayName, providerConfig, modelName, effort);
}
