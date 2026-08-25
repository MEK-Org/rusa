import type { ProviderConfig, RusaConfig } from "../config/types.js";
import { AntigravityProvider } from "./antigravity.js";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";
import { CopilotProvider } from "./copilot.js";
import { FakeProvider } from "./fake-provider.js";
import { KimiProvider } from "./kimi.js";
import { validateModelPin } from "./model-catalog.js";
import type { CodingProvider } from "./types.js";

// Keyed by CLI command (the `cliCommand` resolved in getProvider). Antigravity's
// binary is `agy`, so it registers under "agy" while its provider name is
// "antigravity".
const providerConstructors: Record<
  string,
  (name: string, config: ProviderConfig, model?: string) => CodingProvider
> = {
  claude: (name, config, model) => new ClaudeProvider(name, config, model),
  codex: (name, config, model) => new CodexProvider(name, config, model),
  agy: (name, config, model) => new AntigravityProvider(name, config, model),
  kimi: (name, config, model) => new KimiProvider(name, config, model),
  copilot: (name, config, model) => new CopilotProvider(name, config, model),
  fake: (name, _config, _model) => new FakeProvider(undefined, name),
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

/**
 * Resolve the provider the root actor runs on. Config-driven and intentionally
 * independent of the DB enabled-models / persona quota routing — the root model
 * is just config ("default cheap (agy), Claude escape-hatch"; see the actor-mesh
 * design). Defaults to agy; honors an optional `root.model` override. Throws if
 * `root.provider` isn't declared under `providers`.
 */
export function resolveRootProvider(config: RusaConfig): CodingProvider {
  const providerName = config.rootActor?.provider?.trim() || DEFAULT_ROOT_PROVIDER;
  const model = config.rootActor?.model?.trim() || undefined;
  if (!getEffectiveProviderConfig(providerName, config)) {
    throw new Error(
      `rootActor.provider "${providerName}" is not configured under "providers" in config.yaml`
    );
  }
  return instantiateProvider(providerName, model, config);
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
  model?: string
): CodingProvider {
  if (!getEffectiveProviderConfig(providerName, config)) {
    throw new Error(
      `provider "${providerName}" is not configured under "providers" in config.yaml`
    );
  }
  const trimmedModel = model?.trim();
  if (model !== undefined && !trimmedModel) {
    throw new Error(
      `empty model slug requested for provider "${providerName}" — refusing to fall back to the provider's default model `
    );
  }
  if (trimmedModel) {
    const validation = validateModelPin(providerName, trimmedModel);
    if (validation.status === "unknown") {
      console.warn(`[model-catalog] ${validation.warning}`);
    }
  }
  return instantiateProvider(providerName, trimmedModel, config);
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
  config: RusaConfig
): CodingProvider {
  const providerConfig = getEffectiveProviderConfig(providerName, config);
  if (!providerConfig) {
    throw new Error(`Provider "${providerName}" not found in config`);
  }

  // Display name is "model (provider)" for CLI execution, or just the provider
  // name when no model is pinned (the CLI then uses its default).
  const displayName = modelName ? `${modelName} (${providerName})` : providerName;

  const command = providerConfig.cliCommand ?? providerName;
  const ctor = providerConstructors[command];
  if (!ctor) {
    throw new Error(
      `No implementation for CLI command "${command}" (requested by provider "${providerName}")`
    );
  }

  return ctor(displayName, providerConfig, modelName);
}
