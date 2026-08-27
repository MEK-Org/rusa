import { Cupid, type Goal, type SyncClient } from "@thkp-eng/goals-core";
import type {
  AddParentLogEntry,
  DocumentContentsLogEntry,
  RemoveParentLogEntry,
  StatusLogEntry,
} from "@thkp-eng/goals-types";

/**
 * The integrated-understanding graph as plain create/update/relate/archive
 * operations over a glass-goals {@link SyncClient} (ISSUE_NUM, phase 1b). This is the
 * graph-edit logic of the old `distill.ts` lifted out of its Gemini tool-calling
 * loop into a reusable library: the IU steward (the sole writer) drives it through
 * the `understanding-write` MCP tools, and any agent reads through the read tools.
 *
 * A node is a glass-goals `Goal`: `text` is the title, a `documentContents` log
 * entry holds the markdown body, and parent/child edges are `addParent`/
 * `removeParent` log entries — so the library is a thin, typed wrapper over
 * `syncClient.modifyGoal`. Markdown-only nodes; no bespoke schema (settled).
 */

/** A node's current markdown body — the latest `documentContents` entry, or "". */
export function getNodeContents(goal: Goal): string {
  return (
    goal.log.find((e): e is DocumentContentsLogEntry => e.type === "documentContents")?.text ?? ""
  );
}

/**
 * The next body for an `update_node_contents` op — the single definition of what
 * `append` means . A body is stored as one `documentContents` entry, not an
 * accumulation, so an appender that writes only the fragment silently replaces the
 * node. Both writers — this module's {@link updateNodeContents} (the live pass, via
 * the `understanding-write` MCP) and `distill.ts`'s applier (the eval/replay path) —
 * compose through here so the two paths cannot drift apart again.
 */
export function composeNodeContents(
  goal: Goal,
  action: "replace" | "append",
  text: string
): string {
  return action === "append" ? `${getNodeContents(goal)}\n\n${text}`.trimStart() : text;
}

/**
 * The body after a targeted in-place splice  — the third thing you can do to a
 * body, beside replace and append. `replace`/`append` are both whole-body operations:
 * correcting one clause in a 62k node means hand-re-emitting all 62k characters, and
 * the transcription risk of that is worse than the stale clause it fixes. So a known-
 * false line survives because the only available correction is more dangerous than it.
 *
 * The safety guarantee here is the ANCHOR CHECK, not a human eyeball over 62k
 * characters: an anchor that matches zero times, or more than once without an explicit
 * `replaceAll`, throws. Never a silent no-op (which reads as "corrected" when nothing
 * was), never a first-match guess (which corrects the wrong occurrence and leaves the
 * intended one standing — the worse of the two, because both then look right).
 *
 * Plain string operations throughout, no pattern matching: the anchor is literal text
 * the caller read out of the node, and every character in it — `*`, `(`, `#`, `.` —
 * must mean itself.
 */
export function applyNodeSplice(
  body: string,
  input: { oldText: string; newText: string; replaceAll?: boolean }
): string {
  const { oldText, newText, replaceAll = false } = input;
  if (oldText === "") {
    throw new Error("old_text is required: an empty anchor matches at every position");
  }
  if (oldText === newText) {
    throw new Error("old_text and new_text are identical: this splice would change nothing");
  }
  const occurrences = body.split(oldText).length - 1;
  if (occurrences === 0) {
    throw new Error(
      `old_text not found in the node body: ${describeAnchor(oldText)}. Re-read the node ` +
        `and copy the anchor exactly — whitespace, punctuation, and line breaks included.`
    );
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `old_text is ambiguous: it matches ${occurrences} times in the node body ` +
        `(${describeAnchor(oldText)}). Extend the anchor with surrounding text until it is ` +
        `unique, or pass replace_all: true if every occurrence should change.`
    );
  }
  return body.split(oldText).join(newText);
}

/** A one-line, length-bounded echo of an anchor, for an error the caller has to act on. */
function describeAnchor(anchor: string): string {
  const oneLine = anchor.split("\n").join("\\n");
  const shown = oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
  return `"${shown}" (${anchor.length} characters)`;
}

/**
 * The ISSUE_NUM Part 2 node-length triggers: one concept, one read (~5–15k chars),
 * no changelog. They are SOFT — {@link nodeShapeWarnings} reports a breach, the
 * write still lands . A hard reject mid-pass would drop that window's
 * finding on the floor, which is a worse failure than an over-long node.
 */
export const NODE_LENGTH_TRIGGER = 10_000;
export const NODE_SECTION_TRIGGER = 8;

/** How many `## ` sections a markdown body opens. */
function countSections(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) n++;
  }
  return n;
}

/**
 * Structural-health warnings for a body about to be stored . The nightly
 * distill pass appends one dated `## ` section per window, which grows a node into
 * a changelog by construction; a split is a one-time correction against that
 * continuous force, and prompt text asking the pass to fold instead does not reach
 * an actor that is already running. So the durable half is this: measure at the
 * write, and hand the numbers back in the tool result, in the same run, at the
 * moment of the breach.
 *
 * `previous`/`appended` are supplied only for an `append` — an append that opens a
 * new `## ` section on a node that is ALREADY over a trigger is precisely the
 * changelog step, and gets its own, loudest warning.
 */
export function nodeShapeWarnings(input: {
  next: string;
  previous?: string;
  appended?: string;
}): string[] {
  const warnings: string[] = [];
  const sections = countSections(input.next);
  if (input.next.length > NODE_LENGTH_TRIGGER) {
    warnings.push(
      `Node body is now ${input.next.length} characters, past the ${NODE_LENGTH_TRIGGER}-character split trigger (ISSUE_NUM Part 2: one concept, one read). Split it into a hub plus children rather than growing it further.`
    );
  }
  if (sections > NODE_SECTION_TRIGGER) {
    warnings.push(
      `Node body now opens ${sections} "## " sections, past the ${NODE_SECTION_TRIGGER}-section split trigger (ISSUE_NUM Part 2). Split it into a hub plus children rather than growing it further.`
    );
  }
  if (
    input.appended !== undefined &&
    input.previous !== undefined &&
    countSections(input.appended) > 0 &&
    (input.previous.length > NODE_LENGTH_TRIGGER ||
      countSections(input.previous) > NODE_SECTION_TRIGGER)
  ) {
    warnings.push(
      `This append opens a new "## " section on a node that was ALREADY over a split trigger (${input.previous.length} characters, ${countSections(input.previous)} sections). That is the changelog step ISSUE_NUM exists to stop: fold the finding into the section that already owns the concept, or split first and write the new section into the child.`
    );
  }
  return warnings;
}

/** A read-friendly view of a node for the MCP read tools. */
/**
 * Compute the set of node IDs that are transitively reachable from rootNodeId
 * (following subGoalIds downwards). Includes rootNodeId itself and all its descendants.
 * Returns an empty set if rootNodeId is not found in goals.
 */
export function getReachableNodeIds(goals: Map<string, Goal>, rootNodeId: string): Set<string> {
  const reachable = new Set<string>();
  if (!goals.has(rootNodeId)) return reachable;

  const stack: string[] = [rootNodeId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (reachable.has(current)) continue;
    reachable.add(current);

    const goal = goals.get(current);
    if (!goal) continue;

    for (const childId of goal.subGoalIds) {
      if (goals.has(childId) && !reachable.has(childId)) {
        stack.push(childId);
      }
    }
  }

  return reachable;
}

export interface NodeView {
  id: string;
  title: string;
  contents: string;
  parents: { id: string; title: string | undefined }[];
  children: { id: string; title: string | undefined }[];
}

/**
 * Does `id` name a node this reader can see at all? The three ways it can fail —
 * the configured root (hidden by design), a node outside the root-scoped closure
 * , and an id no node carries — are indistinguishable to a reader and must
 * stay that way, so every reader asks this one predicate rather than re-deriving it
 * (ISSUE_NUM: they had drifted, and `listChildren` answered `[]` where `viewNode`
 * answered "not found"). Exported because the distiller and LLM-retrieval tool
 * loops are readers too, and each had its own inline copy of the rule .
 */
export function isArchivedGoal(goal: Goal): boolean {
  return goal.log.find((e): e is StatusLogEntry => e.type === "status")?.status === "ar";
}

export function isVisibleNode(
  goals: Map<string, Goal>,
  id: string,
  reachable: Set<string> | null,
  rootNodeId?: string
): boolean {
  if (rootNodeId && id === rootNodeId) return false;
  if (reachable && !reachable.has(id)) return false;
  const goal = goals.get(id);
  if (!goal) return false;
  if (isArchivedGoal(goal)) return false;
  return true;
}

export function viewNode(syncClient: SyncClient, id: string, rootNodeId?: string): NodeView | null {
  const goals = syncClient.getGoals();
  const reachable =
    rootNodeId && goals.has(rootNodeId) ? getReachableNodeIds(goals, rootNodeId) : null;
  if (!isVisibleNode(goals, id, reachable, rootNodeId)) return null;

  const goal = goals.get(id);
  if (!goal) return null;
  return {
    id: goal.id,
    title: goal.text,
    contents: getNodeContents(goal),
    parents: Array.from(goal.superGoalIds)
      .filter((pid) => isVisibleNode(goals, pid, reachable, rootNodeId))
      .map((pid) => ({ id: pid, title: goals.get(pid)?.text })),
    children: Array.from(goal.subGoalIds)
      .filter((cid) => isVisibleNode(goals, cid, reachable, rootNodeId))
      .map((cid) => ({ id: cid, title: goals.get(cid)?.text })),
  };
}

/**
 * Direct children of `parentId`, or the root's children when omitted.
 *
 * Returns `null` when an explicitly-given `parentId` names nothing this reader can
 * see, exactly as {@link viewNode} does — so an empty array now means one thing
 * only: **this node has no children**. It used to mean that *or* "no such node",
 * which made the cheap "does this id resolve" probe pass every bad id ; the
 * one-character-wrong id that motivated the ruled read-back convention would have
 * sailed through it. The no-argument call (the top-level set) never returns `null`.
 */
export function listChildren(
  syncClient: SyncClient,
  parentId?: string,
  rootNodeId?: string
): { id: string; title: string; childCount: number }[] | null {
  const goals = syncClient.getGoals();
  const reachable =
    rootNodeId && goals.has(rootNodeId) ? getReachableNodeIds(goals, rootNodeId) : null;
  if (parentId !== undefined && !isVisibleNode(goals, parentId, reachable, rootNodeId)) return null;

  const effectiveParentId =
    parentId ?? (rootNodeId && goals.has(rootNodeId) ? rootNodeId : undefined);

  let ids: string[];
  if (effectiveParentId) {
    ids = Array.from(goals.get(effectiveParentId)?.subGoalIds ?? []).filter((cid) =>
      isVisibleNode(goals, cid, reachable, rootNodeId)
    );
  } else {
    ids = Array.from(goals.values())
      .filter((g) => Array.from(g.superGoalIds).every((pid) => !goals.has(pid)))
      .map((g) => g.id)
      .filter((id) => isVisibleNode(goals, id, reachable, rootNodeId));
  }

  return ids
    .map((id) => {
      const g = goals.get(id);
      if (!g) return null;
      const childCount = Array.from(g.subGoalIds).filter((cid) =>
        isVisibleNode(goals, cid, reachable, rootNodeId)
      ).length;
      return {
        id,
        title: g.text,
        childCount,
      };
    })
    .filter((n): n is { id: string; title: string; childCount: number } => n !== null);
}

/**
 * Is `id` a top-level root of the graph (no parent present in the graph)? The IU
 * is a single-root DAG, so its conceptual root is the (only) such node — used to
 * refuse destructive edits to it without hardcoding its id .
 */
export function isRootNode(syncClient: SyncClient, id: string): boolean {
  const goals = syncClient.getGoals();
  const g = goals.get(id);
  if (!g) return false;
  return Array.from(g.superGoalIds).every((pid) => !goals.has(pid));
}

function docEntry(text: string): DocumentContentsLogEntry {
  return {
    id: Cupid.random().encode(),
    creationTime: Date.now(),
    type: "documentContents",
    text,
  } satisfies DocumentContentsLogEntry;
}

/**
 * Create a node (title + markdown body) and link it under parentId or rootNodeId.
 * When parentId is omitted and rootNodeId is configured, automatically links under rootNodeId.
 */
export async function createNode(
  syncClient: SyncClient,
  input: { title: string; contents: string; parentId?: string; id?: string },
  rootNodeId?: string
): Promise<string> {
  const title = input.title.trim();
  if (!title) throw new Error("title is required");
  const goals = syncClient.getGoals();

  let parentId = input.parentId;
  if (!parentId && rootNodeId && goals.has(rootNodeId)) {
    parentId = rootNodeId;
  }

  if (parentId) {
    if (rootNodeId && parentId === rootNodeId) {
      // Internal auto-reparenting target is allowed, but explicit targeting of root is treated as not found
      if (input.parentId === rootNodeId) {
        throw new Error(`parent node not found: ${parentId}`);
      }
    } else {
      if (!goals.has(parentId)) {
        throw new Error(`parent node not found: ${parentId}`);
      }
      if (rootNodeId) {
        const reachable = getReachableNodeIds(goals, rootNodeId);
        if (!reachable.has(parentId)) {
          throw new Error(`parent node not found: ${parentId}`);
        }
      }
    }
  }

  const id = input.id ?? Cupid.random().encode();
  if (goals.has(id)) throw new Error(`node already exists: ${id}`);
  await syncClient.modifyGoal({ id, text: title, logEntry: docEntry(input.contents) });
  if (parentId) {
    await syncClient.modifyGoal({
      id,
      logEntry: {
        id: Cupid.random().encode(),
        creationTime: Date.now(),
        type: "addParent",
        parentId,
      } satisfies AddParentLogEntry,
    });
  }
  return id;
}

/**
 * Replace or append the markdown body of an existing node. Returns the
 * {@link nodeShapeWarnings} for the body that was just stored — the write always
 * lands; the warnings ride back in the tool result .
 */
export async function updateNodeContents(
  syncClient: SyncClient,
  input: { nodeId: string; action: "replace" | "append"; text: string },
  rootNodeId?: string
): Promise<string[]> {
  const goals = syncClient.getGoals();
  if (
    rootNodeId &&
    (input.nodeId === rootNodeId || !getReachableNodeIds(goals, rootNodeId).has(input.nodeId))
  ) {
    throw new Error(`node not found: ${input.nodeId}`);
  }
  const goal = goals.get(input.nodeId);
  if (!goal) throw new Error(`node not found: ${input.nodeId}`);
  const previous = getNodeContents(goal);
  const next = composeNodeContents(goal, input.action, input.text);
  await syncClient.modifyGoal({ id: input.nodeId, logEntry: docEntry(next) });
  return nodeShapeWarnings({
    next,
    previous,
    appended: input.action === "append" ? input.text : undefined,
  });
}

/**
 * Correct a node's body in place  — see {@link applyNodeSplice} for why the
 * anchor check is the safety guarantee. The anchor is resolved against the body as
 * stored right now, so a stale anchor fails loudly instead of writing over a body
 * that moved underneath the caller.
 */
export async function spliceNodeContents(
  syncClient: SyncClient,
  input: { nodeId: string; oldText: string; newText: string; replaceAll?: boolean },
  rootNodeId?: string
): Promise<string[]> {
  const goals = syncClient.getGoals();
  if (
    rootNodeId &&
    (input.nodeId === rootNodeId || !getReachableNodeIds(goals, rootNodeId).has(input.nodeId))
  ) {
    throw new Error(`node not found: ${input.nodeId}`);
  }
  const goal = goals.get(input.nodeId);
  if (!goal) throw new Error(`node not found: ${input.nodeId}`);
  const previous = getNodeContents(goal);
  const next = applyNodeSplice(previous, input);
  await syncClient.modifyGoal({ id: input.nodeId, logEntry: docEntry(next) });
  // A splice that doesn't grow the body is a correction, which is the opposite of the
  // force ISSUE_NUM measures. Warning on it would nag every correction to an over-trigger
  // node — training the steward to ignore the numbers, and taxing exactly the operation
  // this primitive exists to make safe. Growth still warns.
  return next.length > previous.length ? nodeShapeWarnings({ next }) : [];
}

/** Rename a node. */
export async function updateNodeTitle(
  syncClient: SyncClient,
  input: { nodeId: string; newTitle: string },
  rootNodeId?: string
): Promise<void> {
  const title = input.newTitle.trim();
  if (!title) throw new Error("newTitle is required");
  const goals = syncClient.getGoals();
  if (
    rootNodeId &&
    (input.nodeId === rootNodeId || !getReachableNodeIds(goals, rootNodeId).has(input.nodeId))
  ) {
    throw new Error(`node not found: ${input.nodeId}`);
  }
  if (!goals.has(input.nodeId)) throw new Error(`node not found: ${input.nodeId}`);
  if (isRootNode(syncClient, input.nodeId) || input.nodeId === rootNodeId) {
    throw new Error(`refusing to rename a root node: ${input.nodeId}`);
  }
  await syncClient.modifyGoal({ id: input.nodeId, text: title });
}

/**
 * Would adding the `parentId → childId` edge close a cycle? True iff `childId`
 * is already an ancestor of `parentId` (equivalently, `parentId` is already a
 * descendant of `childId`) — so the new edge would complete a loop. Walks up
 * from `parentId` via `superGoalIds`; the `visited` set keeps the walk
 * terminating even though the pre-mesh graph still holds real cycles from the
 * old distiller (ISSUE_NUM/ISSUE_NUM). Only edges to nodes present in the graph are
 * followed, matching how the rest of the store treats dangling ids.
 *
 * Exported so the other `addParent`-emitting site — the distiller's
 * `create_relationship` op — can share the same guard : the IU is acyclic
 * across *both* write sites, not just this one.
 */
export function wouldCreateCycle(
  goals: Map<string, Goal>,
  parentId: string,
  childId: string
): boolean {
  if (parentId === childId) return true; // a self-parent edge is a trivial 1-cycle
  const visited = new Set<string>();
  const stack: string[] = [parentId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === childId) return true; // childId reachable upward from parentId → loop
    if (visited.has(current)) continue;
    visited.add(current);
    for (const superId of goals.get(current)?.superGoalIds ?? []) {
      if (goals.has(superId) && !visited.has(superId)) stack.push(superId);
    }
  }
  return false;
}

/**
 * Add a parent→child edge between two existing nodes. The IU is a DAG **by
 * construction**: an op that would close a cycle is rejected here, at the write
 * seam, rather than cleaned up reactively later (ISSUE_NUM — mirrors the prod
 * glass_goals "if adding an op would create a loop, ignore that op" rule Operator
 * described on ISSUE_NUM). We surface a thrown error rather than silently dropping,
 * so the (interactive) caller learns the edge was refused and why.
 */
export async function addRelationship(
  syncClient: SyncClient,
  input: { parentId: string; childId: string },
  rootNodeId?: string
): Promise<void> {
  const goals = syncClient.getGoals();
  if (rootNodeId) {
    if (input.parentId === rootNodeId || input.childId === rootNodeId) {
      throw new Error(`node not found`);
    }
    const reachable = getReachableNodeIds(goals, rootNodeId);
    if (!reachable.has(input.parentId)) throw new Error(`parent node not found: ${input.parentId}`);
    if (!reachable.has(input.childId)) throw new Error(`child node not found: ${input.childId}`);
  } else {
    if (!goals.has(input.parentId)) throw new Error(`parent node not found: ${input.parentId}`);
    if (!goals.has(input.childId)) throw new Error(`child node not found: ${input.childId}`);
  }
  if (wouldCreateCycle(goals, input.parentId, input.childId)) {
    throw new Error(
      `refusing to add edge ${input.parentId}→${input.childId}: it would introduce a graph cycle (the IU is a DAG by construction)`
    );
  }
  await syncClient.modifyGoal({
    id: input.childId,
    logEntry: {
      id: Cupid.random().encode(),
      creationTime: Date.now(),
      type: "addParent",
      parentId: input.parentId,
    } satisfies AddParentLogEntry,
  });
}

/** Remove a parent→child edge. */
export async function removeRelationship(
  syncClient: SyncClient,
  input: { parentId: string; childId: string },
  rootNodeId?: string
): Promise<void> {
  const goals = syncClient.getGoals();
  if (rootNodeId) {
    if (input.parentId === rootNodeId || input.childId === rootNodeId) {
      throw new Error(`node not found`);
    }
    const reachable = getReachableNodeIds(goals, rootNodeId);
    if (!reachable.has(input.childId)) throw new Error(`child node not found: ${input.childId}`);
  } else {
    if (!goals.has(input.childId)) throw new Error(`child node not found: ${input.childId}`);
  }
  await syncClient.modifyGoal({
    id: input.childId,
    logEntry: {
      id: Cupid.random().encode(),
      creationTime: Date.now(),
      type: "removeParent",
      parentId: input.parentId,
    } satisfies RemoveParentLogEntry,
  });
}

/** Archive (soft-delete) a node. */
export async function archiveNode(
  syncClient: SyncClient,
  nodeId: string,
  rootNodeId?: string
): Promise<void> {
  const goals = syncClient.getGoals();
  if (
    rootNodeId &&
    (nodeId === rootNodeId || !getReachableNodeIds(goals, rootNodeId).has(nodeId))
  ) {
    throw new Error(`node not found: ${nodeId}`);
  }
  if (!goals.has(nodeId)) throw new Error(`node not found: ${nodeId}`);
  if (isRootNode(syncClient, nodeId) || nodeId === rootNodeId) {
    throw new Error(`refusing to archive a root node: ${nodeId}`);
  }
  await syncClient.modifyGoal({
    id: nodeId,
    logEntry: {
      id: Cupid.random().encode(),
      creationTime: Date.now(),
      type: "status",
      status: "ar", // GoalStatus.archived
    } as StatusLogEntry,
  });
}
