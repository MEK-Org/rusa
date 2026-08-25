import type { GlassGoalsConfig, RusaConfig } from "../config/types.js";

/**
 * Resolve the Glass Goals configuration for Integrated Understanding ,
 * preferring `understanding.glassGoals` over the legacy top-level `glassGoals` section.
 */
export function resolveGlassGoalsConfig(config: RusaConfig): GlassGoalsConfig | undefined {
  return config.understanding?.glassGoals ?? config.glassGoals;
}

/**
 * Resolve the IU scope anchor independently of its persistence provider.
 *
 * `understanding.rootNodeId` takes precedence. `understanding.glassGoals.rootNodeId`
 * and legacy `glassGoals.rootNodeId` are retained as compatibility fallbacks for existing
 * remote-backed installations. Local-only instances use `understanding.rootNodeId`
 * without accidentally opting into Glass Goals baseline loading.
 */
export function resolveUnderstandingRootNodeId(config: RusaConfig): string | undefined {
  return (
    config.understanding?.rootNodeId?.trim() ||
    config.understanding?.glassGoals?.rootNodeId?.trim() ||
    config.glassGoals?.rootNodeId?.trim()
  );
}
