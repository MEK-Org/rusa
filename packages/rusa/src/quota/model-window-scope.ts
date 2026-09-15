import type { ModelEntry } from "../providers/model-catalog.js";

/**
 * Catalog-aware validation of model-scoped quota windows — the trust boundary
 * between the LLM parser and every consumer of parsed quota state.
 *
 * The parser is *supplied* the provider's configured model IDs and may classify
 * a named or family window only against that list. Code here — never the
 * parser — decides what survives: raw model labels are intersected with the
 * canonical configured IDs, canonicalized (a display label resolves to its
 * identifier), deduplicated, and returned in catalog order. A window whose
 * model list empties out is dropped, so an unknown, ambiguous, reserve, or
 * special-allocation label with no configured match can never masquerade as
 * provider-wide evidence or as a reading for a model the pool does not run.
 *
 * This is deliberately an intersection against the runtime model catalog, not
 * a hand-maintained family whitelist: what the pool actually runs decides what
 * a model window may mean.
 */

/** A configured model as the catalog presents it: identifier plus display label. */
export interface ConfiguredModelRef {
  identifier: string;
  displayLabel?: string;
}

/**
 * The canonical configured model IDs for a provider: every passable catalog
 * entry's identifier. Quota-group headers and labels marked `passable: false`
 * (e.g. agy's "Gemini Flash" group headers) are not models the pool can pin,
 * so they are not valid window subjects.
 */
export function configuredModelRefs(entries: readonly ModelEntry[]): readonly ConfiguredModelRef[] {
  return entries
    .filter((entry) => entry.passable !== false)
    .map((entry) => ({ identifier: entry.identifier, displayLabel: entry.displayLabel }));
}

/**
 * Resolve the parser's raw model labels for one window against the configured
 * catalog. Returns the canonical configured IDs the window applies to, in
 * catalog order, deduplicated — or an empty list when nothing configured
 * matches (the caller drops the window in that case).
 *
 * Matching is by identifier or display label, trimmed and case-insensitive;
 * the result always carries the canonical identifier, never the parser's
 * spelling. A label that names no configured model — including a model from
 * another provider, a reserve pool, or a family name with no configured
 * member — simply matches nothing and is excluded by the intersection.
 */
export function resolveWindowModels(
  rawModels: readonly string[],
  configured: readonly ConfiguredModelRef[]
): string[] {
  if (configured.length === 0) return [];
  // A raw parser label has meaning only when it identifies one configured
  // model. Keep collisions as an explicit rejection rather than letting the
  // last catalog row win: a shared display label must not make a model window
  // apply to an arbitrary model.
  const byKey = new Map<string, string | null>();
  const addKey = (key: string, identifier: string) => {
    const existing = byKey.get(key);
    if (existing === undefined || existing === identifier) {
      byKey.set(key, identifier);
    } else {
      byKey.set(key, null);
    }
  };
  for (const ref of configured) {
    const identifier = ref.identifier.trim();
    if (!identifier) continue;
    addKey(identifier.toLowerCase(), identifier);
    const label = ref.displayLabel?.trim();
    if (label) addKey(label.toLowerCase(), identifier);
  }
  const matched = new Set<string>();
  for (const raw of rawModels) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const identifier = byKey.get(key);
    if (identifier !== undefined && identifier !== null) matched.add(identifier);
  }
  // Return the canonical set in catalog order. Apart from making snapshots
  // stable across equivalent LLM ordering, this means every persisted scope
  // has one representation for dedupe/restart/read comparisons.
  return configured
    .map((ref) => ref.identifier.trim())
    .filter((identifier, index, all) => Boolean(identifier) && all.indexOf(identifier) === index)
    .filter((identifier) => matched.has(identifier));
}
