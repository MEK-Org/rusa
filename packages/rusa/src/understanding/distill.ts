import { FunctionCallingConfigMode, GoogleGenAI, type ToolListUnion, Type } from "@google/genai";
import { Cupid, type Goal, type SyncClient } from "@thkp-eng/goals-core";
import type {
  AddParentLogEntry,
  DocumentContentsLogEntry,
  RemoveParentLogEntry,
  StatusLogEntry,
} from "@thkp-eng/goals-types";
import { z } from "zod";
import type { RusaConfig } from "../config/types.js";
import { createTask, getRepositories } from "../db/index.js";
import type { RawInput } from "../db/repositories/index.js";
import { extractGeminiReasoning, extractGeminiText } from "./gemini-utils.js";
import { handleGraphReadTool } from "./graph-read-tools.js";
import {
  applyNodeSplice,
  composeNodeContents,
  getNodeContents,
  wouldCreateCycle,
} from "./graph-store.js";
import { getUnderstandingSyncClient } from "./persistence-utils.js";

/** The distiller previews less of each child than retrieval and wants parents on getNode. */
const READ_TOOL_PROJECTION = { snippetLength: 100, includeParents: true };

const DISTILLATION_MODEL = "gemini-3-flash-preview";
const DISTILLATION_INTERVAL_HOURS = 1;
const DISTILLATION_BATCH_SIZE = 50;
const CONCEPTUAL_ROOT_TITLE = "Integrated Knowledge Universe";

interface CreateNodePayload {
  title: string;
  contents: string;
  parent_id?: string;
  repo?: string;
  rationale?: string;
}

interface UpdateNodeTitlePayload {
  node_id: string;
  new_title: string;
  rationale?: string;
}

interface UpdateNodeContentsPayload {
  node_id: string;
  action: "replace" | "append";
  text: string;
  rationale?: string;
}

interface SpliceNodeContentsPayload {
  node_id: string;
  old_text: string;
  new_text: string;
  replace_all?: boolean;
  rationale?: string;
}

interface DeleteNodePayload {
  node_id: string;
  rationale?: string;
}

interface RelationshipPayload {
  parent_id: string;
  child_id: string;
  rationale?: string;
}

type NodeOpPayload =
  | CreateNodePayload
  | UpdateNodeTitlePayload
  | UpdateNodeContentsPayload
  | SpliceNodeContentsPayload
  | DeleteNodePayload
  | RelationshipPayload;

interface NodeOp {
  rationale: string;
  operation:
    | "create_node"
    | "update_node_title"
    | "update_node_contents"
    | "splice_node_contents"
    | "delete_node"
    | "create_relationship"
    | "delete_relationship";
  payload: NodeOpPayload;
}

const nodeOpPayloadSchemas: Record<NodeOp["operation"], z.ZodType<NodeOpPayload>> = {
  create_node: z.object({
    title: z.string(),
    contents: z.string(),
    parent_id: z.string().optional(),
    repo: z.string().optional(),
    rationale: z.string().optional(),
  }),
  update_node_title: z.object({
    node_id: z.string(),
    new_title: z.string(),
    rationale: z.string().optional(),
  }),
  update_node_contents: z.object({
    node_id: z.string(),
    action: z.enum(["replace", "append"]),
    text: z.string(),
    rationale: z.string().optional(),
  }),
  splice_node_contents: z.object({
    node_id: z.string(),
    old_text: z.string(),
    new_text: z.string(),
    replace_all: z.boolean().optional(),
    rationale: z.string().optional(),
  }),
  delete_node: z.object({
    node_id: z.string(),
    rationale: z.string().optional(),
  }),
  create_relationship: z.object({
    parent_id: z.string(),
    child_id: z.string(),
    rationale: z.string().optional(),
  }),
  delete_relationship: z.object({
    parent_id: z.string(),
    child_id: z.string(),
    rationale: z.string().optional(),
  }),
};

export type DistillationOutcome = "completed" | "noop" | "skipped" | "failed";

export interface DistillationRunResult {
  outcome: DistillationOutcome;
  inputsProcessed: number;
  domainsUpdated: number;
  newDomainsCreated: number;
  nodesUpdated: number;
  nodesCreated: number;
  runSummary: string;
  error?: string;
  events: string[];
  /** Raw JSON string returned by the model, for inspection and replay. */
  modelResponseRaw?: string;
  /** Extracted thoughts/reasoning from the model response. */
  modelReasoning?: string;
  /** Full turn-by-turn conversation from the agentic loop, including tool calls and responses. */
  modelConversation?: ConversationTurn[];
  /** Root node id used during this distillation run. */
  rootNodeId?: string;
  /**
   * Number of unprocessed raw inputs still pending after this batch completed.
   * Non-zero means the batch limit was hit and another run should be scheduled.
   */
  remainingAfterBatch?: number;
}

export interface DistillationRunOptions {
  preferredRootNodeId?: string | null;
}

interface ConversationPart {
  text?: string;
  functionCall?: {
    name?: string;
    args?: Record<string, unknown>;
    id?: string;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
    id?: string;
  };
}

interface ConversationTurn {
  role?: string;
  parts?: ConversationPart[];
}

function clipForLog(value: string, maxLength = 120): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function buildGraphTopology(syncClient: SyncClient): string {
  const goals = syncClient.getGoals();
  if (goals.size === 0) return "(empty — no nodes yet)";

  const rootIds = Array.from(goals.values())
    .filter((g) => Array.from(g.superGoalIds).every((pid) => !goals.has(pid)))
    .map((g) => g.id);

  const lines: string[] = [];
  for (const rootId of rootIds) {
    const root = goals.get(rootId);
    if (!root) continue;
    const childIds = Array.from(root.subGoalIds).filter((cid) => goals.has(cid));
    lines.push(
      `- ${root.text} [id: ${rootId}]${childIds.length > 0 ? ` (${childIds.length} children)` : ""}`
    );
    for (const childId of childIds.slice(0, 10)) {
      const child = goals.get(childId);
      if (!child) continue;
      const grandChildCount = Array.from(child.subGoalIds).filter((cid) => goals.has(cid)).length;
      lines.push(
        `  - ${child.text} [id: ${childId}]${grandChildCount > 0 ? ` (${grandChildCount} children)` : ""}`
      );
    }
    if (childIds.length > 10) lines.push(`  - … and ${childIds.length - 10} more children`);
  }
  return lines.join("\n");
}

function getRootIds(goals: Map<string, Goal>): string[] {
  const roots: string[] = [];
  for (const g of goals.values()) {
    const hasParent = Array.from(g.superGoalIds).some((pid) => goals.has(pid));
    if (!hasParent) roots.push(g.id);
  }
  return roots;
}

function descendantCount(goals: Map<string, Goal>, rootId: string): number {
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const g = goals.get(id);
    if (!g) continue;
    for (const cid of g.subGoalIds) {
      if (goals.has(cid)) stack.push(cid);
    }
  }
  // Exclude the root itself.
  return Math.max(0, seen.size - 1);
}

function resolveConceptualRootId(syncClient: SyncClient): string | null {
  const goals = syncClient.getGoals();
  if (goals.size === 0) return null;

  // Prefer explicit conceptual-root title if it already exists.
  const exact = Array.from(goals.values()).find(
    (g) => g.text.trim().toLowerCase() === CONCEPTUAL_ROOT_TITLE.toLowerCase()
  );
  if (exact) return exact.id;

  // Fallback for resumed runs: choose the most "root-like" previous top-level node.
  const roots = getRootIds(goals);
  if (roots.length === 1) return roots[0];
  if (roots.length > 1) {
    const ranked = roots
      .map((id) => ({ id, score: descendantCount(goals, id) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return ranked[0]?.id ?? null;
  }

  // Defensive fallback for malformed graph states.
  return Array.from(goals.keys()).sort()[0] ?? null;
}

function buildStableOntologyPrompt(rawInputs: RawInput[], syncClient: SyncClient): string {
  const inputsList = rawInputs
    .map(
      (ri) =>
        `- id: ${ri.id}\n  platform: ${ri.platform}\n  repo: ${ri.repo ?? "(none)"}\n  author: ${ri.author}\n  content:\n${ri.content}`
    )
    .join("\n\n");

  const topology = buildGraphTopology(syncClient);

  return `You are a knowledge distillation system maintaining a Directed Acyclic Graph (DAG) ontology.
Your job is to synthesize new information into a stable structure of knowledge Nodes.

## Current Ontology (top 2 levels — ids included)

${topology}

## New Raw Inputs (unprocessed)

${inputsList}

## Instructions

Knowledge is stored as a collection of **Nodes**. Each Node has a title, detailed contents, and relationships to other nodes.
There are NO conceptual differences between "Domains" and "Principles" — everything is just a Node.
Nodes can have parents and children (forming a DAG).

### Mandatory exploration — DO NOT skip this

Before proposing any operations you **must**:
1. Call \`listChildren()\` (no argument) to confirm the live top-level structure.
   - If this returns an empty list, there are NO nodes in the system yet. Create the conceptual root node first.
2. Traverse by calling \`listChildren(node_id)\` for relevant nodes; use \`getNode(id)\` when you need full contents before deciding to update.
3. Only after exploring may you apply mutation tool calls.

**Strict deduplication rule:** Do NOT create a new node for an entity that already exists under a different name or slight variation (e.g. "rusa", "Rusa Project", and "rusa repository" are the same thing). When in doubt, fold into an existing node via \`splice_node_contents\` or \`update_node_contents\` rather than \`create_node\`.

**Always use the opaque \`id\` string** returned by the tools when referencing nodes. Never use a title as an id.

### Hierarchy requirements — prioritize a well-formed tree

The prime objective is a clear, stable hierarchy. Ensure:
1. Maintain a single conceptual root node named "${CONCEPTUAL_ROOT_TITLE}".
2. Integrate and fold findings into existing sections in place. Do NOT append dated sections to existing nodes (which turns nodes into changelogs, ISSUE_NUM).
3. Create child nodes only when a section becomes substantial enough to stand alone as a meaty document.
4. When splitting a section into a child node, remove or condense that section in the parent and place the detailed material in the child.
5. Every created child node is placed into the hierarchy immediately by providing \`parent_id\` at \`create_node\` time or by a \`create_relationship\` right after.
6. Never update a node title unless you have its \`id\` from a tool result.

### Graph Exploration Tools

- \`getNode(id: string)\`: Retrieve full content and metadata of a specific node.
- \`listChildren(node_id?: string)\`: List direct children of a node, or top-level nodes if called without an argument.

DO NOT use XML tags like <tool_call>. Use native tool calling. DO NOT call hallucinated tools like get_edges() or get_graph_info() — you only have the 2 tools above.

### Applying Changes (tool calls only)

After exploring, apply changes via tool calls. Do NOT output a JSON operations array.
You may issue multiple tool calls in a single turn.
Include a short \`rationale\` field in mutation tool arguments when possible.

**Mutation Tools (use these as tool calls):**
- \`create_node(title, contents, parent_id?, repo?)\`
  - \`parent_id\`: id of the parent node. Specify this to place the new node in the hierarchy immediately.
- \`update_node_title(node_id, new_title)\`
- \`update_node_contents(node_id, action: "replace" | "append", text)\` — replace the markdown body or append new content. Prefer folding into the section that already owns the concept over appending a new section.
- \`splice_node_contents(node_id, old_text, new_text, replace_all?)\` — change a specific passage in a node's body in place without restating the rest . \`old_text\` must match literal text in the current body.
- \`delete_node(node_id)\`
- \`create_relationship(parent_id, child_id)\` — use only to link two nodes that already exist
- \`delete_relationship(parent_id, child_id)\`
- \`finish_task(summary?)\` — signal completion for this batch

### Strategy
1. **Analyze** the raw inputs.
2. **Explore** the existing graph with the tools above — traverse to find natural homes.
3. **Distill** the information in the raw input into the integrated understanding. The point is not to perfectly preserve the raw input, but to integrate it into the existing knowledge graph such that future agents will be able to incorporate this knowledge when they handle future tasks.
4. **Prefer updating/splicing** existing nodes over creating new ones. Re-distill sections in place to current state.
5. **Synthesize** multiple related inputs into conceptual markdown sections (avoid one-node-per-issue unless truly distinct).
6. **Prefer parent updates first**; only split to subnodes when a section is clearly large and coherent enough.
7. **Update related nodes** when needed to keep constraints consistent across documents.
8. **Apply** the minimal set of tool calls needed to integrate the new knowledge.

### Anti-patterns (avoid these)
- Do NOT create nodes that are just issue titles or IDs.
- Do NOT mirror raw inputs verbatim across multiple nodes; synthesize.
- Do NOT create a new node if the information can be folded into an existing node.
- Do NOT create tiny child nodes; keep small additions in the parent/root document.
- Do NOT turn nodes into changelogs by appending dated "## " sections — integrate findings into the existing conceptual sections in place .

IMPORTANT: Tools like \`getNode\` and \`listChildren\` are NOT operations. They are functions you call using the tool-use mechanism to gather information *before* you apply changes.

When you are finished, call \`finish_task(summary?)\`. Do not output plain text like DONE.`;
}

function _inferRepoScopeForProposal(
  proposedRepo: string | null,
  rawInputIds: string[],
  inputRepoById: Map<string, string | null>,
  singleRepoFromBatch: string | null
): string | null {
  const normalizedProposed =
    typeof proposedRepo === "string" && proposedRepo.trim().length > 0 ? proposedRepo.trim() : null;
  if (normalizedProposed) return normalizedProposed;

  if (rawInputIds.length === 0) {
    return singleRepoFromBatch;
  }

  const repos = new Set<string>();
  for (const rawInputId of rawInputIds) {
    const repo = inputRepoById.get(rawInputId);
    if (repo) repos.add(repo);
  }

  // If all referenced inputs come from one repo, default to that repo scope.
  if (repos.size === 1) {
    return [...repos][0] ?? null;
  }

  return null;
}

function _inferSingleRepoFromBatch(rawInputs: RawInput[]): string | null {
  const repos = new Set<string>();
  for (const rawInput of rawInputs) {
    if (rawInput.repo) repos.add(rawInput.repo);
  }
  if (repos.size === 1) {
    return [...repos][0] ?? null;
  }
  return null;
}

/**
 * Run the distillation pipeline: gather unprocessed inputs, call LLM, apply updates.
 */
export async function runDistillation(
  config: RusaConfig,
  externalSyncClient?: SyncClient,
  options: DistillationRunOptions = {}
): Promise<DistillationRunResult> {
  const runId = new Date().toISOString();
  const events: string[] = [];
  const logStep = (message: string): void => {
    events.push(message);
    console.log(`[distill] [${runId}] ${message}`);
  };
  logStep("Distillation run started");

  const rawInputs = getRepositories().rawInputs.getPendingDistillation(DISTILLATION_BATCH_SIZE);
  if (rawInputs.length === 0) {
    logStep("No unprocessed raw inputs, skipping distillation");
    return {
      outcome: "noop",
      inputsProcessed: 0,
      domainsUpdated: 0,
      newDomainsCreated: 0,
      nodesUpdated: 0,
      nodesCreated: 0,
      runSummary: "No pending inputs",
      events,
    };
  }

  logStep(`Processing ${rawInputs.length} unprocessed raw input(s)`);
  logStep(`Input IDs queued for processing: ${rawInputs.map((ri) => ri.id).join(", ")}`);
  for (const rawInput of rawInputs) {
    logStep(
      `Input ${rawInput.id} by ${clipForLog(rawInput.author, 40)} in ${rawInput.repo ?? "(none)"}: ${clipForLog(rawInput.content, 100)}`
    );
  }

  const apiKey = config.geminiApiKey?.trim();
  if (!apiKey) {
    const error = "No Gemini API key configured";
    logStep(`${error}, skipping distillation`);
    return {
      outcome: "skipped",
      inputsProcessed: 0,
      domainsUpdated: 0,
      newDomainsCreated: 0,
      nodesUpdated: 0,
      nodesCreated: 0,
      runSummary: "Skipped: missing Gemini API key",
      error,
      events,
    };
  }

  const syncClient = externalSyncClient ?? (await getUnderstandingSyncClient(config));
  if (syncClient) {
    logStep("glass_goals sync enabled.");
  } else {
    logStep("Sync client not available, skipping distillation");
    return {
      outcome: "skipped",
      inputsProcessed: 0,
      domainsUpdated: 0,
      newDomainsCreated: 0,
      nodesUpdated: 0,
      nodesCreated: 0,
      runSummary: "Skipped: missing sync client",
      events,
    };
  }

  // Determine conceptual root from preferred replay id first, then graph heuristics.
  let conceptualRootId: string | null = null;
  if (options.preferredRootNodeId) {
    if (!syncClient.getGoals().has(options.preferredRootNodeId)) {
      const error = `Preferred root node id not found in current graph: ${options.preferredRootNodeId}`;
      logStep(error);
      return {
        outcome: "failed",
        inputsProcessed: 0,
        domainsUpdated: 0,
        newDomainsCreated: 0,
        nodesUpdated: 0,
        nodesCreated: 0,
        runSummary: `Failed: ${error}`,
        error,
        events,
      };
    }
    conceptualRootId = options.preferredRootNodeId;
  } else {
    conceptualRootId = resolveConceptualRootId(syncClient);
  }
  if (!conceptualRootId) {
    const rootId = Cupid.random().encode();
    await syncClient.modifyGoal({
      id: rootId,
      text: CONCEPTUAL_ROOT_TITLE,
      logEntry: {
        id: Cupid.random().encode(),
        creationTime: Date.now(),
        type: "documentContents",
        text: `# ${CONCEPTUAL_ROOT_TITLE}\n\n## Overview\n\nThis node is the top-level conceptual document for integrated understanding.\n`,
      } as DocumentContentsLogEntry,
    });
    conceptualRootId = rootId;
    logStep(`Created conceptual root node: ${CONCEPTUAL_ROOT_TITLE} [id: ${conceptualRootId}]`);
  } else {
    const existing = syncClient.getGoals().get(conceptualRootId);
    logStep(
      `Using conceptual root from existing graph: ${existing?.text ?? "(unknown)"} [id: ${conceptualRootId}]`
    );
  }

  // Split the prompt: static rules in systemInstruction, dynamic data in user prompt
  const fullPrompt = buildStableOntologyPrompt(rawInputs, syncClient);
  const systemInstructionBreak = fullPrompt.indexOf("## New Raw Inputs");
  const systemPrompt = fullPrompt.slice(0, systemInstructionBreak).trim();
  const userPromptPart = fullPrompt.slice(systemInstructionBreak).trim();

  logStep(
    `Built distillation prompts: system(${systemPrompt.length}), user(${userPromptPart.length})`
  );

  const genAI = new GoogleGenAI({ apiKey });

  const tools: ToolListUnion = [
    {
      functionDeclarations: [
        {
          name: "getNode",
          description: "Retrieve full log of a node",
          parameters: {
            type: Type.OBJECT,
            properties: {
              node_id: { type: Type.STRING },
            },
            required: ["node_id"],
          },
        },
        {
          name: "listChildren",
          description: "List direct sub-nodes",
          parameters: {
            type: Type.OBJECT,
            properties: {
              node_id: { type: Type.STRING, description: "Optional parent node ID" },
            },
          },
        },
        {
          name: "create_node",
          description: "Create a new node and optionally attach it to a parent",
          parameters: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              contents: { type: Type.STRING },
              parent_id: { type: Type.STRING },
              repo: { type: Type.STRING },
              rationale: { type: Type.STRING },
            },
            required: ["title", "contents"],
          },
        },
        {
          name: "update_node_title",
          description: "Update a node title",
          parameters: {
            type: Type.OBJECT,
            properties: {
              node_id: { type: Type.STRING },
              new_title: { type: Type.STRING },
              rationale: { type: Type.STRING },
            },
            required: ["node_id", "new_title"],
          },
        },
        {
          name: "update_node_contents",
          description: "Update a node's contents",
          parameters: {
            type: Type.OBJECT,
            properties: {
              node_id: { type: Type.STRING },
              action: { type: Type.STRING, enum: ["replace", "append"] },
              text: { type: Type.STRING },
              rationale: { type: Type.STRING },
            },
            required: ["node_id", "action", "text"],
          },
        },
        {
          name: "splice_node_contents",
          description:
            "Correct part of a node's markdown body in place without restating the rest ",
          parameters: {
            type: Type.OBJECT,
            properties: {
              node_id: { type: Type.STRING },
              old_text: { type: Type.STRING },
              new_text: { type: Type.STRING },
              replace_all: { type: Type.BOOLEAN },
              rationale: { type: Type.STRING },
            },
            required: ["node_id", "old_text", "new_text"],
          },
        },
        {
          name: "delete_node",
          description: "Archive a node",
          parameters: {
            type: Type.OBJECT,
            properties: {
              node_id: { type: Type.STRING },
              rationale: { type: Type.STRING },
            },
            required: ["node_id"],
          },
        },
        {
          name: "create_relationship",
          description: "Add a parent relationship between existing nodes",
          parameters: {
            type: Type.OBJECT,
            properties: {
              parent_id: { type: Type.STRING },
              child_id: { type: Type.STRING },
              rationale: { type: Type.STRING },
            },
            required: ["parent_id", "child_id"],
          },
        },
        {
          name: "delete_relationship",
          description: "Remove a parent relationship between existing nodes",
          parameters: {
            type: Type.OBJECT,
            properties: {
              parent_id: { type: Type.STRING },
              child_id: { type: Type.STRING },
              rationale: { type: Type.STRING },
            },
            required: ["parent_id", "child_id"],
          },
        },
        {
          name: "finish_task",
          description: "Signal that distillation is complete for this batch",
          parameters: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
            },
          },
        },
      ],
    },
  ];

  logStep(`Starting agentic loop with model ${DISTILLATION_MODEL}`);

  const history: ConversationTurn[] = [];

  let reasoning = "";
  let turns = 0;
  const maxTurns = 15;
  const opToolNames = new Set([
    "create_node",
    "update_node_title",
    "update_node_contents",
    "splice_node_contents",
    "delete_node",
    "create_relationship",
    "delete_relationship",
  ]);
  let finished = false;
  let finishSummary = "";

  const createdNodeIds = new Map<string, string>(); // title → id for nodes created this run
  let nodesCreated = 0;
  let nodesUpdated = 0;
  let failedOperations = 0; // ISSUE_NUM: ops whose apply threw (SQLite/constraint/Firestore) — never swallowed

  function resolveNodeId(idOrTitle: string): string | null {
    if (!syncClient) return null;
    const goals = syncClient.getGoals();
    if (typeof idOrTitle !== "string" || idOrTitle.trim().length === 0) return null;
    if (goals.has(idOrTitle)) return idOrTitle;
    const createdId = createdNodeIds.get(idOrTitle);
    if (createdId) return createdId;
    // Case-insensitive title fallback
    const lower = idOrTitle.toLowerCase();
    for (const [id, goal] of goals) {
      if (goal.text.toLowerCase() === lower) return id;
    }
    return null;
  }

  async function applyOperation(op: NodeOp): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!syncClient) return { ok: true };
    const payload = op.payload;
    logStep(`Applying ${op.operation}: ${op.rationale}`);

    try {
      if (op.operation === "create_node") {
        const typedPayload: CreateNodePayload = payload as CreateNodePayload;
        const title = typeof typedPayload.title === "string" ? typedPayload.title.trim() : "";
        if (/^issue\s*#\d+/i.test(title)) {
          logStep(
            `create_node: rejected issue-specific title="${typedPayload.title}", use a generalized conceptual title`
          );
          return { ok: true };
        }

        const goalsBefore = syncClient.getGoals();
        const defaultParentId =
          conceptualRootId && goalsBefore.has(conceptualRootId)
            ? conceptualRootId
            : resolveConceptualRootId(syncClient);
        const id = Cupid.random().encode();
        await syncClient.modifyGoal({
          id,
          text: title,
          logEntry: {
            id: Cupid.random().encode(),
            creationTime: Date.now(),
            type: "documentContents",
            text: typedPayload.contents,
          } satisfies DocumentContentsLogEntry,
        });
        createdNodeIds.set(typedPayload.title, id);
        nodesCreated++;

        // If the model specified a parent at creation time, apply it immediately.
        if (typedPayload.parent_id) {
          const parentId = resolveNodeId(typedPayload.parent_id);
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
          } else {
            logStep(
              `create_node: could not resolve parent_id=${typedPayload.parent_id}, relationship skipped`
            );
          }
        } else if (defaultParentId) {
          await syncClient.modifyGoal({
            id,
            logEntry: {
              id: Cupid.random().encode(),
              creationTime: Date.now(),
              type: "addParent",
              parentId: defaultParentId,
            } satisfies AddParentLogEntry,
          });
        }
      } else if (op.operation === "update_node_title") {
        const typedPayload: UpdateNodeTitlePayload = payload as UpdateNodeTitlePayload;
        if (/^issue\s*#\d+/i.test(String(typedPayload.new_title ?? ""))) {
          logStep(
            `update_node_title: rejected issue-specific title="${typedPayload.new_title}", use a generalized conceptual title`
          );
          return { ok: true };
        }
        const nodeId = resolveNodeId(typedPayload.node_id);
        if (!nodeId) {
          logStep(`update_node_title: could not resolve node_id=${typedPayload.node_id}, skipping`);
          return { ok: true };
        }
        await syncClient.modifyGoal({
          id: nodeId,
          text: typedPayload.new_title,
        });
        nodesUpdated++;
      } else if (op.operation === "update_node_contents") {
        const typedPayload: UpdateNodeContentsPayload = payload as UpdateNodeContentsPayload;
        const nodeId = resolveNodeId(typedPayload.node_id);
        if (!nodeId) {
          logStep(
            `update_node_contents: could not resolve node_id=${typedPayload.node_id}, skipping`
          );
          return { ok: true };
        }
        // Honour `action` . A body is one `documentContents` entry rather than
        // an accumulation, so writing the fragment alone made every `append` — the
        // value the prompt actively steers toward — a silent truncating replace.
        // Compose through graph-store so this path and the live MCP path agree.
        const goal = syncClient.getGoals().get(nodeId);
        if (!goal) {
          logStep(`update_node_contents: node_id=${nodeId} disappeared before write, skipping`);
          return { ok: true };
        }
        await syncClient.modifyGoal({
          id: nodeId,
          logEntry: {
            id: Cupid.random().encode(),
            creationTime: Date.now(),
            type: "documentContents",
            text: composeNodeContents(goal, typedPayload.action, typedPayload.text),
          } satisfies DocumentContentsLogEntry,
        });
        nodesUpdated++;
      } else if (op.operation === "splice_node_contents") {
        const typedPayload: SpliceNodeContentsPayload = payload as SpliceNodeContentsPayload;
        const nodeId = resolveNodeId(typedPayload.node_id);
        if (!nodeId) {
          logStep(
            `splice_node_contents: could not resolve node_id=${typedPayload.node_id}, skipping`
          );
          return { ok: true };
        }
        const goal = syncClient.getGoals().get(nodeId);
        if (!goal) {
          logStep(`splice_node_contents: node_id=${nodeId} disappeared before write, skipping`);
          return { ok: true };
        }
        const previous = getNodeContents(goal);
        const next = applyNodeSplice(previous, {
          oldText: typedPayload.old_text,
          newText: typedPayload.new_text,
          replaceAll: typedPayload.replace_all,
        });
        await syncClient.modifyGoal({
          id: nodeId,
          logEntry: {
            id: Cupid.random().encode(),
            creationTime: Date.now(),
            type: "documentContents",
            text: next,
          } satisfies DocumentContentsLogEntry,
        });
        nodesUpdated++;
      } else if (op.operation === "create_relationship") {
        const typedPayload: RelationshipPayload = payload as RelationshipPayload;
        const childId = resolveNodeId(typedPayload.child_id);
        const parentId = resolveNodeId(typedPayload.parent_id);
        if (!childId || !parentId) {
          logStep(
            `create_relationship: could not resolve child=${typedPayload.child_id} or parent=${typedPayload.parent_id}, skipping`
          );
          return { ok: true };
        }
        // Keep the graph acyclic by construction here too : this is the
        // sibling addParent-emitting site to graph-store.addRelationship. Skip-
        // and-log the loop-closing op (the faithful form of the glass_goals
        // "ignore the loop-creating op" rule Operator cited on ISSUE_NUM), consistent
        // with this loop's other skips, so the distiller can't inject a cycle.
        if (wouldCreateCycle(syncClient.getGoals(), parentId, childId)) {
          logStep(
            `create_relationship: parent=${parentId} child=${childId} would introduce a graph cycle, skipping`
          );
          return { ok: true };
        }
        await syncClient.modifyGoal({
          id: childId,
          logEntry: {
            id: Cupid.random().encode(),
            creationTime: Date.now(),
            type: "addParent",
            parentId,
          } satisfies AddParentLogEntry,
        });
      } else if (op.operation === "delete_relationship") {
        const typedPayload: RelationshipPayload = payload as RelationshipPayload;
        const childId = resolveNodeId(typedPayload.child_id);
        const parentId = resolveNodeId(typedPayload.parent_id);
        if (!childId || !parentId) {
          logStep(
            `delete_relationship: could not resolve child=${typedPayload.child_id} or parent=${typedPayload.parent_id}, skipping`
          );
          return { ok: true };
        }
        await syncClient.modifyGoal({
          id: childId,
          logEntry: {
            id: Cupid.random().encode(),
            creationTime: Date.now(),
            type: "removeParent",
            parentId,
          } satisfies RemoveParentLogEntry,
        });
      } else if (op.operation === "delete_node") {
        const typedPayload: DeleteNodePayload = payload as DeleteNodePayload;
        const nodeId = resolveNodeId(typedPayload.node_id);
        if (!nodeId) {
          logStep(`delete_node: could not resolve node_id=${typedPayload.node_id}, skipping`);
          return { ok: true };
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
      return { ok: true };
    } catch (err) {
      // ISSUE_NUM: propagate the failure instead of swallowing it. The caller reports it to the
      // model (so the agent loop can retry/halt) and the run withholds markProcessed so the
      // affected inputs are retried next run rather than silently lost.
      const error = err instanceof Error ? err.message : String(err);
      logStep(`Operation failed: ${error}`);
      return { ok: false, error };
    }
  }

  while (turns < maxTurns) {
    turns++;
    logStep(`Turn ${turns} starting...`);

    const initialUserContent = {
      role: "user",
      parts: [{ text: `${userPromptPart}\n\nPlease begin by exploring the graph as instructed.` }],
    };
    const requestContents = history.length > 0 ? history : [initialUserContent];

    // Ensure the initial user prompt is captured in history so tool calls have a valid preceding turn.
    if (history.length === 0) {
      history.push(initialUserContent);
    }

    logStep(
      `History summary: ${history
        .map((h) => {
          const parts = (h.parts || [])
            .map((p) => {
              if (p.functionCall) return "functionCall";
              if (p.functionResponse) return "functionResponse";
              if (typeof p.text === "string") return "text";
              return "other";
            })
            .join("|");
          return `${h.role ?? "unknown"}:${parts}`;
        })
        .join(" -> ")}`
    );

    const response = await genAI.models.generateContent({
      model: DISTILLATION_MODEL,
      contents: requestContents,
      config: {
        temperature: 0,
        systemInstruction: systemPrompt,
        tools: tools,
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: [
              "listChildren",
              "getNode",
              "create_node",
              "update_node_title",
              "update_node_contents",
              "splice_node_contents",
              "delete_node",
              "create_relationship",
              "delete_relationship",
              "finish_task",
            ],
          },
        },
        httpOptions: {
          timeout: 600_000, // 10 minutes
        },
        thinkingConfig: { includeThoughts: true },
      },
    });

    const turnReasoning = await extractGeminiReasoning(response);
    if (turnReasoning) {
      logStep(`Model thoughts (turn ${turns}): ${clipForLog(turnReasoning, 500)}`);
      reasoning += `${turnReasoning}\n`;
    }

    const candidate = response.candidates?.[0];
    let toolCalls: ConversationPart[] = [];
    let sawTextToolCall = false;
    const candidateParts = (candidate?.content?.parts?.map((p) => p as ConversationPart) ??
      []) as ConversationPart[];
    if (candidate?.content) {
      toolCalls = candidateParts.filter((p) => !!p.functionCall);
    }

    // Fallback: some models (especially reasoning ones) might return a tool call
    // as a JSON block in the text rather than through the official mechanism.
    const text = toolCalls.length === 0 ? await extractGeminiText(response) : "";
    if (toolCalls.length === 0 && text) {
      let maybeJson = text.trim();

      const xmlMatch = maybeJson.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
      if (xmlMatch?.[1]) {
        maybeJson = xmlMatch[1].trim();
      } else {
        // Extract from markdown code block if present
        const match = maybeJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (match?.[1]) {
          maybeJson = match[1].trim();
        } else {
          maybeJson = maybeJson
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/i, "")
            .trim();
        }
      }

      if (
        maybeJson.startsWith("{") &&
        maybeJson.includes('"name"') &&
        maybeJson.includes('"arguments"')
      ) {
        try {
          const parsed = JSON.parse(maybeJson);
          if (parsed.name && parsed.arguments) {
            logStep(
              `Detected tool call in text (ignored, re-asking for native tool call): ${parsed.name}`
            );
            sawTextToolCall = true;
          }
        } catch {
          // Not valid JSON tool call, ignore
        }
      } else if (maybeJson.startsWith("[") && maybeJson.includes('"name"')) {
        // Handle array of tool calls
        try {
          const parsed = JSON.parse(maybeJson);
          if (Array.isArray(parsed) && parsed[0]?.name) {
            logStep(
              `Detected ${parsed.length} tool call(s) in text array (ignored, re-asking for native tool calls)`
            );
            sawTextToolCall = true;
          }
        } catch {
          // ignore
        }
      }
    }

    if (toolCalls.length > 0) {
      // Only keep function call parts in history to maintain valid tool-call sequencing.
      history.push({
        role: "model",
        parts: toolCalls,
      });
      for (const call of toolCalls) {
        const fnName = call.functionCall?.name ?? "(unknown)";
        const args = call.functionCall?.args ?? {};
        logStep(`Tool call: ${fnName} args=${JSON.stringify(args)}`);
      }
      logStep(`Model called ${toolCalls.length} tool(s)`);
      const functionResponses: ConversationPart[] = [];
      const goals = syncClient.getGoals();

      for (const call of toolCalls) {
        const fullFnName = call.functionCall?.name || "";
        const fn = fullFnName.includes("/") ? fullFnName.split("/").slice(1).join("/") : fullFnName;
        const args = call.functionCall?.args ?? {};
        const callId = call.functionCall?.id;

        let content: Record<string, unknown> = {};
        if (fn === "finish_task") {
          finished = true;
          finishSummary = typeof args.summary === "string" ? args.summary : "";
          content = { status: "finished" };
        } else if (opToolNames.has(fn)) {
          const operation = fn as NodeOp["operation"];
          const payloadResult = nodeOpPayloadSchemas[operation].safeParse(args);
          if (!payloadResult.success) {
            failedOperations++;
            content = {
              status: "failed",
              error: `Invalid ${operation} payload: ${payloadResult.error.message}`,
            };
          } else {
            const op: NodeOp = {
              rationale: typeof args.rationale === "string" ? args.rationale : "tool_call",
              operation,
              payload: payloadResult.data,
            };
            const result = await applyOperation(op);
            if (result.ok) {
              content = { status: "ok" };
            } else {
              // ISSUE_NUM: surface the failure so the model can retry or halt, instead of a false "ok".
              failedOperations++;
              content = { status: "failed", error: result.error };
            }
          }
        } else if (fn === "getNode" || fn === "listChildren") {
          // One visibility rule, shared with the store and with LLM retrieval .
          // The distiller reads the whole graph rather than a root-scoped closure, so
          // it passes no rootNodeId — that scope is unchanged by the fold.
          content = handleGraphReadTool(goals, fn, args, READ_TOOL_PROJECTION);
        } else {
          content = {
            error: `Unknown tool: ${fn}. You ONLY have these tools available: listChildren, getNode, create_node, update_node_title, update_node_contents, splice_node_contents, delete_node, create_relationship, delete_relationship, finish_task. Check your syntax.`,
          };
          logStep(`Model tried to call unknown tool: ${fn}`);
        }

        // The exact structure required by @google/genai for a function response part
        const responsePayload = content?.error ? { error: content.error } : { output: content };
        functionResponses.push({
          functionResponse: {
            name: fullFnName,
            response: responsePayload,
            ...(callId ? { id: callId } : {}),
          },
        });
        logStep(`Tool response: ${fullFnName} ${JSON.stringify(content)}`);
      }

      const toolResponseParts = [...functionResponses];
      history.push({
        role: "user",
        parts: toolResponseParts,
      });
      if (finished) break;
    } else {
      // No tool calls, keep the model content as-is for continuity.
      if (candidate?.content) {
        history.push({
          role: candidate.content.role || "model",
          parts: candidateParts,
        });
      }
      if (text || candidate?.content?.parts?.[0]?.text) {
        const finalText = text || candidate?.content?.parts?.[0]?.text || "";
        logStep(`Model response text length: ${finalText.length}`);
      }
      if (sawTextToolCall) {
        logStep("Model attempted tool call via text. Retrying with native tool call requirement.");
      } else {
        logStep("Model returned no tool call. Retrying...");
      }
      const retryMessage =
        "Please call a tool using native tool calling. Call finish_task when finished.";
      history.push({
        role: "user",
        parts: [{ text: retryMessage }],
      });
    }
  }

  if (!finished) {
    const error =
      turns >= maxTurns ? "Max turns reached without finish_task" : "Distillation failed";
    logStep(error);
    return {
      outcome: "failed",
      inputsProcessed: 0,
      domainsUpdated: 0,
      newDomainsCreated: 0,
      nodesUpdated: 0,
      nodesCreated: 0,
      runSummary: `Failed: ${error}`,
      error,
      events,
    };
  }

  // ISSUE_NUM: if any operation threw during apply, DO NOT mark the batch processed — otherwise a
  // partial/failed write would silently drop those inputs from the graph. Withholding
  // markProcessed leaves them pending so the next run retries (same contract as the
  // not-finished failure path above).
  if (failedOperations > 0) {
    const error = `${failedOperations} operation(s) failed to apply`;
    logStep(`Distillation ${error}; withholding markProcessed so inputs are retried next run.`);
    return {
      outcome: "failed",
      inputsProcessed: 0,
      domainsUpdated: 0,
      newDomainsCreated: nodesCreated,
      nodesUpdated,
      nodesCreated,
      runSummary: `Failed: ${error} (${nodesCreated} created, ${nodesUpdated} updated before failure)`,
      error,
      events,
    };
  }

  // Mark all inputs as processed
  getRepositories().rawInputs.markProcessed(rawInputs.map((ri) => ri.id));

  const remainingAfterBatch = getRepositories().rawInputs.countPendingDistillation();
  const runSummary = `${rawInputs.length} input(s) processed, ${nodesCreated} nodes created, ${nodesUpdated} updated.${remainingAfterBatch > 0 ? ` ${remainingAfterBatch} input(s) still pending.` : ""}`;
  logStep(`Distillation complete: ${runSummary}`);

  return {
    outcome: "completed",
    inputsProcessed: rawInputs.length,
    domainsUpdated: 0, // Legacy field
    newDomainsCreated: nodesCreated, // Mapping for visibility
    nodesUpdated: nodesUpdated,
    nodesCreated: nodesCreated,
    runSummary,
    events,
    modelResponseRaw: JSON.stringify({ finish_task: { summary: finishSummary } }),
    modelReasoning: reasoning,
    modelConversation: history,
    rootNodeId: conceptualRootId ?? undefined,
    remainingAfterBatch,
  };
}

export function recomputeDistillation(since?: string): number {
  const count = getRepositories().rawInputs.resetDistillation(since);
  if (count > 0) {
    createTask({
      repo: "_system",
      source: "distillation",
      persona: "distiller",
      context: { type: "distillation" },
      reasoning: "Manual full recompute requested",
    });
  }
  return count;
}

export function scheduleNextDistillation(): string {
  const notBefore = new Date(
    Date.now() + DISTILLATION_INTERVAL_HOURS * 60 * 60 * 1000
  ).toISOString();
  return createTask({
    repo: "_system",
    source: "distillation",
    persona: "distiller",
    context: { type: "distillation" },
    notBefore,
    reasoning: "Next scheduled run",
  });
}

export function scheduleImmediateDistillation(
  reasoning = "Additional pending raw inputs remain after batched distillation"
): string {
  return createTask({
    repo: "_system",
    source: "distillation",
    persona: "distiller",
    context: { type: "distillation" },
    reasoning,
  });
}

export function scheduleDistillationIfNeeded(): string | null {
  if (getRepositories().maintenance.hasPendingDistillationTask()) return null;
  return scheduleNextDistillation();
}
