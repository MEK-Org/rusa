import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Goal, SyncClient } from "@thkp-eng/goals-core";
import { getNodeContents, getReachableNodeIds, isVisibleNode } from "./graph-store.js";

/**
 * Sanitizes a node title for safe filesystem filenames.
 * Replaces non-alphanumeric character sequences with a single hyphen,
 * trims leading/trailing hyphens, and lowercases.
 * Falls back to "untitled" if no alphanumeric characters remain.
 */
export function sanitizeNodeSlug(title: string): string {
  const sanitized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "untitled";
}

/**
 * Formats a node's rendered filename: `<sanitized-slug>--<id.slice(0, 6)>.md`.
 * The 6-character Cupid ID prefix is exact and case-preserving.
 */
export function formatNodeFilename(title: string, id: string): string {
  const slug = sanitizeNodeSlug(title);
  const prefix = id.slice(0, 6);
  return `${slug}--${prefix}.md`;
}

/**
 * Formats deterministic YAML frontmatter containing the node's full ID,
 * title, and parent/child relationship IDs.
 */
export function formatFrontmatter(meta: {
  id: string;
  title: string;
  parent_ids: string[];
  child_ids: string[];
}): string {
  const escapedTitle = JSON.stringify(meta.title);
  const parentLines =
    meta.parent_ids.length === 0
      ? " []"
      : `\n${meta.parent_ids.map((pid) => `  - ${pid}`).join("\n")}`;
  const childLines =
    meta.child_ids.length === 0
      ? " []"
      : `\n${meta.child_ids.map((cid) => `  - ${cid}`).join("\n")}`;

  return `---\nid: ${meta.id}\ntitle: ${escapedTitle}\nparent_ids:${parentLines}\nchild_ids:${childLines}\n---\n`;
}

/**
 * Renders the full markdown file content for an IU node:
 * deterministic YAML frontmatter followed immediately by the raw document body.
 */
export function renderNodeDocument(
  goal: Goal,
  relations: { parent_ids: string[]; child_ids: string[] }
): string {
  const frontmatter = formatFrontmatter({
    id: goal.id,
    title: goal.text,
    parent_ids: relations.parent_ids,
    child_ids: relations.child_ids,
  });
  return `${frontmatter}${getNodeContents(goal)}`;
}

export interface RenderSnapshotResult {
  fileCount: number;
  nodeIds: string[];
}

/**
 * Renders all visible, non-archived nodes from the Integrated Understanding
 * graph store into a flat directory of `<slug>--<id-prefix>.md` files.
 *
 * Enforces:
 * - Shared non-archived visibility predicate (`isVisibleNode`)
 * - Fail-loud whole-filename collision guard across visible nodes
 * - Byte-for-byte post-frontmatter parity with `getNodeContents(goal)`
 */
export async function renderUnderstandingSnapshot(
  syncClient: SyncClient,
  targetDir: string,
  rootNodeId?: string
): Promise<RenderSnapshotResult> {
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const goals = syncClient.getGoals();
  const reachable = rootNodeId ? getReachableNodeIds(goals, rootNodeId) : null;

  // Identify visible nodes using the unified predicate
  const visibleGoals: Goal[] = [];
  for (const [id, goal] of goals) {
    if (isVisibleNode(goals, id, reachable, rootNodeId)) {
      visibleGoals.push(goal);
    }
  }

  // Sort deterministically by ID for reproducible export order
  visibleGoals.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Check whole-rendered-filename collisions
  const filenameToNodeId = new Map<string, string>();
  for (const goal of visibleGoals) {
    const filename = formatNodeFilename(goal.text, goal.id);
    const existingId = filenameToNodeId.get(filename);
    if (existingId !== undefined) {
      throw new Error(
        `Collision detected for rendered filename "${filename}": node ${goal.id} collides with node ${existingId}`
      );
    }
    filenameToNodeId.set(filename, goal.id);
  }

  const nodeIds: string[] = [];

  // Materialize files
  for (const goal of visibleGoals) {
    const filename = formatNodeFilename(goal.text, goal.id);
    const parentIds = Array.from(goal.superGoalIds)
      .filter((pid) => isVisibleNode(goals, pid, reachable, rootNodeId))
      .sort();
    const childIds = Array.from(goal.subGoalIds)
      .filter((cid) => isVisibleNode(goals, cid, reachable, rootNodeId))
      .sort();

    const fileContent = renderNodeDocument(goal, {
      parent_ids: parentIds,
      child_ids: childIds,
    });

    writeFileSync(join(targetDir, filename), fileContent, "utf-8");
    nodeIds.push(goal.id);
  }

  return {
    fileCount: visibleGoals.length,
    nodeIds,
  };
}
