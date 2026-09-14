import type { QuotaLimit } from "../mcp/quota-mcp.js";

/**
 * The one rule for "is this window the provider's own?", shared by observation
 * ingestion (`./shared-store.js`), inference (`../mcp/quota-mcp.js`), and
 * dashboard/API presentation (`../dashboard/quota-api.js`) so the three can
 * never disagree about which windows speak for a provider.
 *
 * A window is model-scoped when its validated object scope carries a non-empty
 * `models` list — the canonical configured models the observed window applies
 * to. Everything else is provider-scoped: an explicit `{ provider }`, or no
 * scope at all. Absent scope reads as provider on purpose: `scope` is optional
 * at the parse boundary and several provider parses never emit it, so
 * requiring `scope.provider` to be set would silently drop every unscoped
 * window instead of just the model ones.
 *
 * Model rows are excluded from provider evidence rather than relabelled: a
 * codex panel can carry a model reserve whose Weekly sits at 100% left, and a
 * reserve row presented as an unqualified provider "Weekly limit" is worse
 * than no row at all — it reads as a full weekly budget while the provider's
 * real weekly window is half spent.
 */
export function isModelScopedWindow(limit: Pick<QuotaLimit, "scope">): boolean {
  return (
    limit.scope === "model" ||
    (typeof limit.scope === "object" &&
      limit.scope !== null &&
      Array.isArray(limit.scope.models) &&
      limit.scope.models.length > 0)
  );
}

export function isProviderScopedWindow(limit: Pick<QuotaLimit, "scope">): boolean {
  return limit.scope !== "model" && !isModelScopedWindow(limit);
}
