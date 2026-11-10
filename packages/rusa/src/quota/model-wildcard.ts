import type { QuotaLimit } from "../mcp/quota-mcp.js";

/**
 * Wildcards in a quota window's model list (#1282). An entry may be a pattern
 * such as `claude-fable-*`, where `*` stands for any run of characters, so a
 * lane names a model family once instead of listing every member. A model
 * joining the family then leaves the lane's list, and so its identity,
 * unchanged. Every place that asks "does this list cover that model" asks it
 * here.
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

/**
 * Whether two model lists name a model in common: an entry of one equals, or
 * as a pattern covers, an entry of the other.
 */
export function modelListsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => modelEntryCovers(a, b) || modelEntryCovers(b, a)));
}

/**
 * Put a reading's model windows on the wildcard lane that covers them. A
 * window whose every model is covered by exactly one of `laneModelLists` that
 * holds a pattern takes that lane's list as its own; any other window is
 * returned as read. Two covering lanes are ambiguous and claim nothing.
 */
export function joinWildcardLanes<L extends Pick<QuotaLimit, "scope">>(
  limits: readonly L[],
  laneModelLists: readonly (readonly string[])[]
): L[] {
  const wildcardLanes = laneModelLists.filter((lane) => lane.some(isModelPattern));
  return limits.map((limit) => {
    if (typeof limit.scope !== "object" || limit.scope === null) return limit;
    const models = limit.scope.models;
    if (!Array.isArray(models) || models.length === 0 || models.some(isModelPattern)) return limit;
    const covering = wildcardLanes.filter((lane) =>
      models.every((model) => modelListCovers(lane, model.trim()))
    );
    if (covering.length !== 1) return limit;
    return { ...limit, scope: { ...limit.scope, models: [...covering[0]] } };
  });
}
