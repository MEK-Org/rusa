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

/** A model ID segment that is only a version number, such as `5` or `3.1`. */
const VERSION_SEGMENT = /^\d+(?:[._]\d+)*$/;

/**
 * The stable name of a model-scoped quota window (#1282): the model family its
 * models share, e.g. `claude-fable` for `claude-fable-5`, `claude-fable-5-1`
 * and `claude-fable-5-2`. The name, never the model list, is the window's lane
 * identity, so a model joining, leaving or being re-ordered in the window
 * keeps its lane, pacing history and period start.
 *
 * Each model ID is split on hyphens and whitespace and its version segments
 * are dropped; the name is the segments every model shares, from the start.
 * The input is the catalog-validated model list (`resolveWindowModels`), so
 * the name never depends on how the parser spelled the panel line. Models
 * that share no leading segment name the window by their sorted families
 * instead, so two unrelated allocations still never share a lane.
 */
export function quotaWindowName(models: readonly string[]): string {
  const families = [
    ...new Set(
      models
        .map((model) =>
          model
            .trim()
            .toLowerCase()
            .split(/[\s-]+/)
            .filter((segment) => segment.length > 0 && !VERSION_SEGMENT.test(segment))
            .join("-")
        )
        .filter((family) => family.length > 0)
    ),
  ].sort();
  if (families.length <= 1) return families[0] ?? "";
  const split = families.map((family) => family.split("-"));
  const shared: string[] = [];
  for (const [index, segment] of split[0].entries()) {
    if (!split.every((segments) => segments[index] === segment)) break;
    shared.push(segment);
  }
  return shared.length > 0 ? shared.join("-") : families.join(",");
}

/**
 * True only when two model-scoped windows carry the same window name, or
 * when both are provider-scoped. This is deliberately stricter than comparing
 * model-vs-provider shape: inference must not borrow a reset from one named
 * model allocation for another allocation with the same window kind. Two
 * readings of one window whose model lists differ are the same window
 * ({@link quotaWindowName}).
 */
export function hasSameQuotaWindowScope(
  left: Pick<QuotaLimit, "scope">,
  right: Pick<QuotaLimit, "scope">
): boolean {
  const modelScope = (
    limit: Pick<QuotaLimit, "scope">
  ): { provider: string; models: string[] } | null => {
    if (typeof limit.scope !== "object" || limit.scope === null) return null;
    const { provider, models } = limit.scope;
    if (
      typeof provider !== "string" ||
      !Array.isArray(models) ||
      models.length === 0 ||
      models.some((model) => typeof model !== "string")
    ) {
      return null;
    }
    return { provider, models };
  };

  const leftModelScope = modelScope(left);
  const rightModelScope = modelScope(right);
  if (leftModelScope || rightModelScope) {
    return (
      leftModelScope !== null &&
      rightModelScope !== null &&
      leftModelScope.provider === rightModelScope.provider &&
      quotaWindowName(leftModelScope.models) === quotaWindowName(rightModelScope.models)
    );
  }
  return isProviderScopedWindow(left) && isProviderScopedWindow(right);
}
