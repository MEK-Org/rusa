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
  if (options.repositories.legacyImportReceipts.has(MODEL_CLASSES_CONFIG_CUTOVER_SOURCE)) {
    // The receipt deliberately outranks every possible stale config shape.
    // Do not even structurally validate it here: config is no longer a runtime
    // source and a bad restored block must not block a database-backed restart.
    return {
      plan: { kind: "already-cut-over" },
      configuredDefinitions: options.config.modelClasses === undefined ? 0 : 1,
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
      ignoredStaleConfig: planResult.configuredDefinitions > 0,
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
