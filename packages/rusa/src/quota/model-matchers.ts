/**
 * Matching a model against a quota window's model list (#1282). An entry is a
 * model ID or a pattern such as `claude-fable-*`, where `*` stands for any run
 * of characters, so a reading can name a model family once instead of listing
 * every member. A model joining the family then leaves the lane's list, and so
 * its identity, unchanged. Every place that asks "does this list cover that
 * model" asks it here.
 */

const WILDCARD = "*";

export function isModelPattern(entry: string): boolean {
  return entry.includes(WILDCARD);
}

/** Whether one list entry, a model ID or a pattern, covers the concrete `model`. */
export function modelEntryCovers(entry: string, model: string): boolean {
  if (!isModelPattern(entry)) return entry === model;
  const parts = entry.split(WILDCARD);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (model.length < first.length + last.length) return false;
  if (!model.startsWith(first) || !model.endsWith(last)) return false;
  let from = first.length;
  const end = model.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const at = model.indexOf(part, from);
    if (at < 0 || at + part.length > end) return false;
    from = at + part.length;
  }
  return true;
}

/** Whether a model list, which may hold patterns, covers the concrete `model`. */
export function modelListCovers(models: readonly string[], model: string): boolean {
  return models.some((entry) => modelEntryCovers(entry, model));
}
