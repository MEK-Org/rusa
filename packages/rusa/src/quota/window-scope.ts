import type { QuotaLimit } from "../mcp/quota-mcp.js";

/**
 * The one rule for "is this window the provider's own?", shared by observation
 * ingestion (`./shared-store.js`) and dashboard/API presentation
 * (`../dashboard/quota-api.js`) so the two can never disagree about which
 * windows speak for a provider.
 *
 * A window belongs to the provider unless the extractor explicitly scoped it to
 * a model. Absent scope reads as provider on purpose: `scope` is optional at the
 * parse boundary and several provider parses never emit it, so requiring
 * `scope === "provider"` would silently drop every unscoped window instead of
 * just the model ones.
 *
 * Model rows are excluded rather than relabelled: a codex panel can carry a
 * model reserve whose Weekly sits at 100% left, and a reserve row presented as
 * an unqualified provider "Weekly limit" is worse than no row at all — it reads
 * as a full weekly budget while the provider's real weekly window is half spent.
 */
export function isProviderScopedWindow(limit: Pick<QuotaLimit, "scope">): boolean {
  return limit.scope !== "model";
}
