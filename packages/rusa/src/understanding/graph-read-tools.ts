import type { Goal } from "@thkp-eng/goals-core";
import { getNodeContents, getReachableNodeIds, isVisibleNode } from "./graph-store.js";

/**
 * The read half of the graph tool loops the distiller and LLM retrieval each run.
 *
 * Both drive a model around the same graph with the same two tools, and both used
 * to re-derive the visibility rule inline — which is how they drifted apart from
 * the store and from each other . `viewNode`/`listChildren` were collapsed
 * onto one predicate by ISSUE_NUM; this is the third and fourth implementation folded
 * onto that same predicate, so there is now exactly one answer to "does this id
 * name a node this reader can see".
 *
 * The projections still differ where the callers genuinely need them to — snippet
 * length, and whether `getNode` carries parents — so those are options rather than
 * a reason to keep a second copy of the rule.
 */
export interface GraphReadToolOptions {
  /** Restrict visibility to the closure reachable from this node , hiding the node itself. Omit for the whole graph. */
  rootNodeId?: string;
  /** Characters of a child's contents to include as a preview in `listChildren`. */
  snippetLength: number;
  /** Whether `getNode`'s projection carries the node's parents. */
  includeParents: boolean;
}

/** The read-only tools this module answers. Anything else is the caller's to dispatch. */
export type GraphReadToolName = "listChildren" | "getNode";

function visibleChildIds(goals: Map<string, Goal>, goal: Goal, reachable: Set<string> | null) {
  return Array.from(goal.subGoalIds).filter((cid) =>
    reachable ? reachable.has(cid) : goals.has(cid)
  );
}

/**
 * Answer one `listChildren`/`getNode` tool call.
 *
 * An id that names nothing this reader can see returns an error naming the id —
 * the same answer the `list_children` and `get_node` MCP tools give, and the
 * reason an empty `children` array now means one thing only: this node has no
 * children . The no-argument `listChildren` asks for the top-level set,
 * which always resolves.
 */
export function handleGraphReadTool(
  goals: Map<string, Goal>,
  fn: GraphReadToolName,
  args: Record<string, unknown>,
  opts: GraphReadToolOptions
): Record<string, unknown> {
  const { rootNodeId, snippetLength, includeParents } = opts;
  const reachable = rootNodeId ? getReachableNodeIds(goals, rootNodeId) : null;

  if (fn === "getNode") {
    const nodeId = typeof args.node_id === "string" ? args.node_id : "";
    if (!isVisibleNode(goals, nodeId, reachable, rootNodeId)) {
      return { error: `node not found: ${nodeId}` };
    }
    const goal = goals.get(nodeId);
    if (!goal) return { error: `node not found: ${nodeId}` };
    return {
      id: goal.id,
      title: goal.text,
      contents: getNodeContents(goal),
      ...(includeParents
        ? {
            parents: Array.from(goal.superGoalIds)
              .filter((pid) => (reachable ? reachable.has(pid) : goals.has(pid)))
              .map((pid) => ({ id: pid, title: goals.get(pid)?.text })),
          }
        : {}),
      children: visibleChildIds(goals, goal, reachable).map((cid) => ({
        id: cid,
        title: goals.get(cid)?.text,
      })),
    };
  }

  const parentId = typeof args.node_id === "string" ? args.node_id : undefined;
  if (parentId !== undefined && !isVisibleNode(goals, parentId, reachable, rootNodeId)) {
    return { error: `node not found: ${parentId}` };
  }

  const effectiveParentId =
    parentId ?? (rootNodeId && goals.has(rootNodeId) ? rootNodeId : undefined);

  if (effectiveParentId) {
    const parent = goals.get(effectiveParentId);
    const children = parent
      ? visibleChildIds(goals, parent, reachable).map((cid) => {
          const child = goals.get(cid) as Goal;
          return {
            id: cid,
            title: child.text,
            snippet: getNodeContents(child).slice(0, snippetLength),
            childCount: visibleChildIds(goals, child, reachable).length,
          };
        })
      : [];
    return { children };
  }

  // Whole-graph top level: the roots, one level of their children with them, so an
  // unscoped caller gets the shape of the graph in a single call.
  const children = Array.from(goals.values())
    .filter((g) => Array.from(g.superGoalIds).every((pid) => !goals.has(pid)))
    .map((g) => ({
      id: g.id,
      title: g.text,
      children: visibleChildIds(goals, g, null).map((cid) => ({
        id: cid,
        title: goals.get(cid)?.text,
      })),
    }));
  return { children };
}
