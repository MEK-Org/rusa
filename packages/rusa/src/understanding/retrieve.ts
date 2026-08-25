import type { Goal, SyncClient } from "@thkp-eng/goals-core";
import type { DocumentContentsLogEntry } from "@thkp-eng/goals-types";
import type { RusaConfig } from "../config/types.js";
import { getReachableNodeIds } from "./graph-store.js";
import { getUnderstandingSyncClient } from "./persistence-utils.js";
import { DEFAULT_RETRIEVAL_MODEL, searchNodesLlm } from "./retrieve-llm.js";
import { resolveUnderstandingRootNodeId } from "./root-scope.js";

export interface RetrievedNode {
  id: string;
  title: string;
  contents: string;
  relevanceScore: number;
}

function getNodeContents(goal: Goal): string {
  const entry = goal.log.find((e): e is DocumentContentsLogEntry => e.type === "documentContents");
  return entry?.text ?? "";
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "in",
  "to",
  "of",
  "at",
  "by",
  "on",
  "if",
  "or",
  "as",
  "be",
  "we",
  "it",
  "no",
  "so",
  "do",
  "go",
  "and",
  "but",
  "for",
  "are",
  "was",
  "has",
  "had",
  "not",
  "can",
  "you",
  "its",
  "via",
  "per",
  "yet",
  "any",
  "all",
  "our",
  "out",
  "use",
  "how",
  "why",
  "who",
  "may",
  "get",
]);

function extractQueryWords(taskDescription: string): string[] {
  return taskDescription
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

function scoreNode(goal: Goal, queryWords: string[]): number {
  const title = goal.text.toLowerCase();
  const contents = getNodeContents(goal).toLowerCase();
  let score = 0;
  for (const word of queryWords) {
    if (title.includes(word)) score += 2;
    if (contents.includes(word)) score += 1;
  }
  return score;
}

/**
 * Search a SyncClient graph for nodes relevant to a task description.
 * When rootNodeId is provided, restricts search to nodes reachable from rootNodeId (excluding rootNodeId itself).
 *
 * Phase 1: keyword match on title/contents.
 * Phase 2: upward neighborhood expansion to include parent context nodes.
 */
export function searchNodes(
  syncClient: SyncClient,
  taskDescription: string,
  maxResults = 10,
  minScore = 2,
  rootNodeId?: string
): RetrievedNode[] {
  const goals = syncClient.getGoals();
  const queryWords = extractQueryWords(taskDescription);
  if (queryWords.length === 0) return [];

  const reachable = rootNodeId ? getReachableNodeIds(goals, rootNodeId) : null;

  // Phase 1: score all nodes by keyword relevance (excluding rootNodeId itself and unreachable nodes).
  const directScores = new Map<string, number>();
  for (const [id, goal] of goals) {
    if (reachable) {
      if (!reachable.has(id) || id === rootNodeId) continue;
    }
    const score = scoreNode(goal, queryWords);
    if (score > 0) directScores.set(id, score);
  }

  // Phase 2: expand upward — add parent nodes at reduced weight for context (within reachable bounds).
  const expanded = new Map<string, { score: number }>();
  for (const [id, score] of directScores) {
    if (!expanded.has(id)) expanded.set(id, { score });

    let frontier = Array.from(goals.get(id)?.superGoalIds ?? []).filter((pid) =>
      reachable ? reachable.has(pid) && pid !== rootNodeId : goals.has(pid)
    );
    let depth = 1;
    while (frontier.length > 0 && depth <= 2) {
      const next: string[] = [];
      for (const pid of frontier) {
        if (goals.has(pid) && !expanded.has(pid)) {
          expanded.set(pid, { score: score / (depth * 2) });
          next.push(
            ...Array.from(goals.get(pid)?.superGoalIds ?? []).filter((spid) =>
              reachable ? reachable.has(spid) && spid !== rootNodeId : goals.has(spid)
            )
          );
        }
      }
      frontier = next;
      depth++;
    }
  }

  return Array.from(expanded.entries())
    .map(([id, { score }]) => {
      const goal = goals.get(id);
      if (!goal) {
        return null;
      }
      return {
        id,
        title: goal.text,
        contents: getNodeContents(goal),
        relevanceScore: score,
      };
    })
    .filter((node): node is RetrievedNode => node !== null)
    .filter((n) => n.relevanceScore >= minScore)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, maxResults);
}

// Module-level state: the result of the previous retrieval call, used as
// the input to meta-retrieval on the next call.
let lastRetrievalResult: RetrievedNode[] = [];

function formatMetaQuery(previousResult: RetrievedNode[]): string {
  const nodeList = previousResult.map((n) => `- ${n.title}`).join("\n");
  return (
    `The previous knowledge retrieval identified the following relevant areas:\n${nodeList}\n\n` +
    `What guidance exists about retrieval strategy or knowledge organization for these areas?`
  );
}

/**
 * Retrieve relevant nodes from the live knowledge graph for a task description.
 *
 * Uses LLM-based retrieval when a Gemini API key is available:
 * 1. Meta-retrieval: uses the previous call's result to find any guidance nodes
 *    about how to approach retrieval (enabling distilled feedback to influence
 *    future retrieval behaviour).
 * 2. Primary retrieval: finds nodes relevant to the task, informed by the
 *    meta-retrieval context.
 *
 * Falls back to keyword search if no API key is configured.
 */
export async function getRelevantNodes(
  config: RusaConfig,
  taskDescription: string
): Promise<RetrievedNode[]> {
  const syncClient = await getUnderstandingSyncClient(config);
  if (!syncClient) return [];
  const rootNodeId = resolveUnderstandingRootNodeId(config);

  const apiKey = config.geminiApiKey?.trim();
  if (!apiKey) {
    return searchNodes(syncClient, taskDescription, 10, 2, rootNodeId);
  }

  // Step 1: meta-retrieval — find any guidance nodes about retrieval strategy,
  // using the previous call's result as the query input.
  let metaNodes: RetrievedNode[] = [];
  if (lastRetrievalResult.length > 0) {
    try {
      const metaQuery = formatMetaQuery(lastRetrievalResult);
      metaNodes = await searchNodesLlm(
        syncClient,
        metaQuery,
        apiKey,
        DEFAULT_RETRIEVAL_MODEL,
        undefined,
        rootNodeId
      );
    } catch {
      // Meta-retrieval failure is non-fatal; proceed without guidance.
    }
  }

  // Step 2: primary retrieval, informed by any meta-context found above.
  let result: RetrievedNode[] = [];
  try {
    result = await searchNodesLlm(
      syncClient,
      taskDescription,
      apiKey,
      DEFAULT_RETRIEVAL_MODEL,
      metaNodes,
      rootNodeId
    );
  } catch (err) {
    console.warn("[retrieve] LLM retrieval failed, falling back to keyword search:", err);
    result = searchNodes(syncClient, taskDescription, 10, 2, rootNodeId);
  }

  lastRetrievalResult = result;
  return result;
}

/**
 * Format retrieved nodes as a prompt section for injection into agent prompts.
 */
export function formatNodesForPrompt(nodes: RetrievedNode[]): string {
  if (nodes.length === 0) return "";

  let section =
    `## Integrated Understanding\n\n` +
    `The following knowledge nodes are relevant to your task.\n` +
    `You MUST respect this knowledge when making implementation decisions.\n\n`;

  for (const node of nodes) {
    section += `### ${node.title}\n`;
    if (node.contents) {
      section += `${node.contents}\n`;
    }
    section += `\n`;
  }

  return section;
}
