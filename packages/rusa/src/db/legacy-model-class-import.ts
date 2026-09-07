import type Database from "better-sqlite3";
import { validateLegacyModelClasses } from "../config/loader.js";
import type { RusaConfig } from "../config/types.js";
import type { ProviderModelConfig } from "../providers/model-config.js";
import type { Repositories } from "./repositories/index.js";

/** Receipt key for the one-time #276 config authority cutover. */
export const MODEL_CLASSES_CONFIG_CUTOVER_SOURCE = "config.yaml:modelClasses:v1";

export type ModelClassConfigCutoverPlan =
  | { kind: "already-cut-over" }
  | { kind: "cut-over"; definitions: Array<{ name: string; modelConfig: ProviderModelConfig[] }> };

export interface ModelClassConfigCutoverResult {
  plan: ModelClassConfigCutoverPlan;
  configuredDefinitions: number;
  legacyConfigPresent: boolean;
}

/**
 * Read-only view of the config-to-database handoff for `rusa db-check`.
 *
 * A preflight calls the exact same planner that boot uses, then uses this
 * summary only to explain its result. It never writes class rows or a receipt.
 * Once a receipt exists, boot intentionally ignores legacy config without
 * validating it; this summary preserves that behavior and reports malformed
 * stale data as a divergence instead of making it authoritative again.
 */
export interface ModelClassConfigCutoverPreflight {
  disposition: "would-import" | "already-cut-over";
  legacyConfigDefinitions: number | null;
  durableDefinitions: number;
  legacyConfigDivergesFromDurable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function legacyDefinitionEntries(config: RusaConfig): ReadonlyMap<string, unknown> | undefined {
  if (config.modelClasses === undefined) return new Map();
  if (!isRecord(config.modelClasses)) return undefined;
  return new Map(Object.entries(config.modelClasses));
}

/**
 * Make the config-to-database handoff explicit. The config block is a
 * transitional import source only: we copy the validated definitions exactly
 * once and record the receipt in the same transaction. Later restarts never
 * read it as authority, so a stale file cannot undo a runtime edit or delete.
 */
export function planModelClassConfigCutover(options: {
  config: RusaConfig;
  repositories: Pick<Repositories, "legacyImportReceipts" | "modelClasses">;
}): ModelClassConfigCutoverResult {
  const legacyConfigPresent = options.config.modelClasses !== undefined;
  if (options.repositories.legacyImportReceipts.has(MODEL_CLASSES_CONFIG_CUTOVER_SOURCE)) {
    // The receipt deliberately outranks every possible stale config shape.
    // Do not even structurally validate it here: config is no longer a runtime
    // source and a bad restored block must not block a database-backed restart.
    return {
      plan: { kind: "already-cut-over" },
      configuredDefinitions: legacyDefinitionEntries(options.config)?.size ?? 0,
      legacyConfigPresent,
    };
  }
  // Before the receipt exists config is a migration input, so validate it at
  // the exact handoff boundary rather than treating loadConfig as a permanent
  // second source of truth.
  validateLegacyModelClasses(options.config);
  const configured = Object.entries(options.config.modelClasses ?? {}).map(
    ([name, modelConfig]) => ({
      name,
      modelConfig: modelConfig.map((entry) => ({ ...entry })),
    })
  );
  const durable = options.repositories.modelClasses.list();
  if (durable.length > 0) {
    throw new Error(
      `model-class config cutover cannot proceed: ${durable.length} durable model class(es) exist without a cutover receipt; refusing to let config.yaml overwrite runtime state`
    );
  }
  return {
    plan: { kind: "cut-over", definitions: configured },
    configuredDefinitions: configured.length,
    legacyConfigPresent,
  };
}

/**
 * Describe a plan after it has passed through {@link planModelClassConfigCutover}.
 * The planner remains the only place that validates a pre-receipt config input,
 * keeping db-check and normal boot from drifting. This function only compares a
 * stale, post-receipt config block for operator visibility.
 */
export function preflightModelClassConfigCutover(options: {
  config: RusaConfig;
  planResult: ModelClassConfigCutoverResult;
  repositories: Pick<Repositories, "modelClasses">;
}): ModelClassConfigCutoverPreflight {
  const durable = options.repositories.modelClasses.list();
  if (options.planResult.plan.kind === "cut-over") {
    return {
      disposition: "would-import",
      legacyConfigDefinitions: options.planResult.plan.definitions.length,
      durableDefinitions: durable.length,
      // The planner has already refused the only ambiguous state: durable rows
      // without a receipt. An empty store is intentionally ready for this plan.
      legacyConfigDivergesFromDurable: false,
    };
  }

  const legacy = legacyDefinitionEntries(options.config);
  if (legacy === undefined) {
    return {
      disposition: "already-cut-over",
      legacyConfigDefinitions: null,
      durableDefinitions: durable.length,
      legacyConfigDivergesFromDurable: true,
    };
  }
  if (options.config.modelClasses === undefined) {
    return {
      disposition: "already-cut-over",
      legacyConfigDefinitions: 0,
      durableDefinitions: durable.length,
      legacyConfigDivergesFromDurable: false,
    };
  }
  return {
    disposition: "already-cut-over",
    legacyConfigDefinitions: legacy.size,
    durableDefinitions: durable.length,
    legacyConfigDivergesFromDurable:
      legacy.size !== durable.length ||
      durable.some(
        (definition) =>
          JSON.stringify(legacy.get(definition.name)) !== JSON.stringify(definition.modelConfig)
      ),
  };
}

export interface ApplyModelClassConfigCutoverResult {
  importedDefinitions: number;
  ignoredStaleConfig: boolean;
}

export function applyModelClassConfigCutover(
  planResult: ModelClassConfigCutoverResult,
  options: { db: Database.Database; repositories: Repositories; now?: () => string }
): ApplyModelClassConfigCutoverResult {
  if (planResult.plan.kind === "already-cut-over") {
    return {
      importedDefinitions: 0,
      ignoredStaleConfig: planResult.legacyConfigPresent,
    };
  }
  const definitions = planResult.plan.definitions;
  const at = (options.now ?? (() => new Date().toISOString()))();
  options.db.transaction(() => {
    for (const definition of definitions) {
      options.repositories.modelClasses.upsert(definition.name, definition.modelConfig, at);
    }
    options.repositories.legacyImportReceipts.record(
      MODEL_CLASSES_CONFIG_CUTOVER_SOURCE,
      at,
      definitions.length
    );
  })();
  return { importedDefinitions: definitions.length, ignoredStaleConfig: false };
}
