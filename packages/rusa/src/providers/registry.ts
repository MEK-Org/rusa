import type { ProviderConfig, RusaConfig } from "../config/types.js";
import { AntigravityProvider } from "./antigravity.js";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";
import { CopilotProvider } from "./copilot.js";
import { FakeProvider } from "./fake-provider.js";
import { KimiProvider } from "./kimi.js";
import {
  isProviderCommand,
  type ProviderCommand,
  validateProviderSelection,
} from "./provider-selection.js";
import type { CodingProvider } from "./types.js";

export {
  DEFAULT_ROOT_EFFORT,
  DEFAULT_ROOT_PROVIDER,
  providerCapabilityName,
  validateProviderSelection,
} from "./provider-selection.js";

// Keyed by CLI command (the `cliCommand` resolved in getProvider). Antigravity's
// binary is `agy`, so it registers under "agy" while its provider name is
// "antigravity".
interface ProviderAdapter {
  create: (name: string, config: ProviderConfig, model?: string, effort?: string) => CodingProvider;
}

// This exact mapping is checked against PROVIDER_CAPABILITIES, the pure source
// of selection metadata. Adding an adapter or capability without the other is
// a type error instead of a config-load/runtime drift.
const providerAdapters = {
  claude: {
    create: (name, config, model, effort) => new ClaudeProvider(name, config, model, effort),
  },
  codex: {
    create: (name, config, model, effort) => new CodexProvider(name, config, model, effort),
  },
  agy: {
    create: (name, config, model, effort) =>
      new AntigravityProvider(name, config, model, undefined, effort),
  },
  kimi: { create: (name, config, model) => new KimiProvider(name, config, model) },
  copilot: { create: (name, config, model) => new CopilotProvider(name, config, model) },
  fake: { create: (name) => new FakeProvider(undefined, name) },
} satisfies Readonly<Record<ProviderCommand, ProviderAdapter>>;

/** Returns the effective provider config for a given provider name. */
function getEffectiveProviderConfig(
  providerName: string,
  config: RusaConfig
): RusaConfig["providers"][string] | undefined {
  return config.providers[providerName];
}

/**
 * The one home for throttle-lane aliases. `antigravity`'s binary is `agy`, so
 * every spelling of the provider name must canonicalize onto the `agy` lane —
 * adding a future alias means adding one row here, nowhere else.
 */
const THROTTLE_LANE_ALIASES: Record<string, string> = {
  antigravity: "agy",
};

function resolveThrottleLaneAlias(raw: string): string {
  const key = raw.trim().toLocaleLowerCase("en-US");
  return THROTTLE_LANE_ALIASES[key] ?? key;
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
  return resolveThrottleLaneAlias(key);
}

/**
 * Normalize an inbound provider query parameter (e.g. `?provider=`) to the
 * canonical throttle lane key: trim and case-fold, then apply the alias table.
 * Config-free counterpart of {@link providerThrottleKey} so the alias table
 * lives in exactly one place.
 */
export function normalizeProviderThrottleKey(raw: string): string {
  return resolveThrottleLaneAlias(raw);
}

export const QUOTA_THROTTLE_PROVIDERS = ["claude", "codex", "agy", "kimi"] as const;
export type QuotaThrottleProvider = (typeof QUOTA_THROTTLE_PROVIDERS)[number];

/**
 * Resolve the provider the root actor runs on. Config-driven and intentionally
 * independent of the DB enabled-models / persona quota routing — the root model
 * is just config. Config loading passes this same selection through the shared model
 * config validator. Throws if the provider or model is blank.
 */
export function resolveRootProvider(config: RusaConfig): CodingProvider {
  const rootActor = config.rootActor;
  if (!rootActor) throw new Error("rootActor must specify an explicit provider and model");
  const providerName = typeof rootActor.provider === "string" ? rootActor.provider.trim() : "";
  if (!providerName) throw new Error("rootActor.provider must be a non-empty string");
  const model = typeof rootActor.model === "string" ? rootActor.model.trim() : "";
  if (!model) throw new Error("rootActor.model must be a non-empty string");
  const selection = validateProviderSelection(config, providerName, model, rootActor.effort);
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
  const selection = validateProviderSelection(config, providerName, model, effort);
  return instantiateProvider(providerName, selection.model, selection.effort, config);
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
  const adapter = isProviderCommand(command) ? providerAdapters[command] : undefined;
  if (!adapter) {
    throw new Error(
      `No implementation for CLI command "${command}" (requested by provider "${providerName}")`
    );
  }

  return adapter.create(displayName, providerConfig, modelName, effort);
}
