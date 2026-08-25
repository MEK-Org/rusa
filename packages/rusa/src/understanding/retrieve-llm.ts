import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Part,
  type ToolListUnion,
  Type,
} from "@google/genai";
import type { SyncClient } from "@thkp-eng/goals-core";
import { handleGraphReadTool } from "./graph-read-tools.js";
import { getNodeContents, getReachableNodeIds } from "./graph-store.js";
import type { RetrievedNode } from "./retrieve.js";

export const DEFAULT_RETRIEVAL_MODEL = "gemini-2.5-flash";
const MAX_TURNS = 15;

/** Retrieval shows a slightly longer preview than the distiller and needs no parents. */
const READ_TOOL_PROJECTION = { snippetLength: 120, includeParents: false };

/**
 * LLM-based retrieval: the model explores the graph using listChildren/getNode
 * and calls select_nodes when it has identified the relevant set.
 * Restricts exploration to nodes reachable from rootNodeId (excluding rootNodeId itself).
 */
export async function searchNodesLlm(
  syncClient: SyncClient,
  taskDescription: string,
  apiKey: string,
  model = DEFAULT_RETRIEVAL_MODEL,
  metaContext?: RetrievedNode[],
  rootNodeId?: string
): Promise<RetrievedNode[]> {
  if (!taskDescription.trim()) return [];

  const goals = syncClient.getGoals();
  if (goals.size === 0) return [];
  const reachable = rootNodeId ? getReachableNodeIds(goals, rootNodeId) : null;

  const genAI = new GoogleGenAI({ apiKey });

  const tools: ToolListUnion = [
    {
      functionDeclarations: [
        {
          name: "listChildren",
          description:
            "List direct children of a node, or all top-level nodes if called without an argument.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              node_id: {
                type: Type.STRING,
                description: "Parent node ID. Omit to list top-level nodes.",
              },
            },
          },
        },
        {
          name: "getNode",
          description: "Retrieve the full contents of a specific node.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              node_id: { type: Type.STRING },
            },
            required: ["node_id"],
          },
        },
        {
          name: "select_nodes",
          description:
            "Declare the final set of node IDs that are relevant to the task. Call this when you are done exploring.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              node_ids: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "IDs of relevant nodes. May be empty if nothing is relevant.",
              },
            },
            required: ["node_ids"],
          },
        },
      ],
    },
  ];

  const metaGuidance =
    metaContext && metaContext.length > 0
      ? `\n\n## Retrieval Guidance\n\n` +
        `The following knowledge was retrieved to guide this retrieval. ` +
        `Take it into account when selecting nodes:\n\n` +
        metaContext.map((n) => `### ${n.title}\n${n.contents}`).join("\n\n")
      : "";

  const systemPrompt =
    `You are a knowledge retrieval assistant. An agent is about to work on the task described by the user. ` +
    `Your job is to identify which knowledge nodes from the graph would be useful context for that agent.\n\n` +
    `Workflow:\n` +
    `1. Call listChildren() with no argument to see the top-level structure.\n` +
    `2. Explore promising nodes with listChildren(node_id) or getNode(node_id) to read their contents.\n` +
    `3. Call select_nodes with the final list of relevant node IDs.\n\n` +
    `Selection guidance:\n` +
    `- Include a node if its contents would help an agent understand the domain, constraints, conventions, ` +
    `or prior decisions relevant to this task.\n` +
    `- Include it even if the task content overlaps with what is already in the node — that overlap is ` +
    `precisely what makes it useful context for the agent.\n` +
    `- When in doubt, include the node rather than exclude it.\n` +
    `- Do NOT include the root node ("Integrated Knowledge Universe") or other purely structural nodes ` +
    `unless their direct contents are useful.\n\n` +
    `IMPORTANT: select_nodes MUST always be called with a node_ids array (even if empty). ` +
    `Never call select_nodes without providing the node_ids argument.` +
    metaGuidance;

  const userPrompt =
    `Task description:\n\n${taskDescription.trim()}\n\n` +
    `Start by calling listChildren() with no argument to see the top-level structure, ` +
    `then explore as needed, then call select_nodes with your final answer.`;

  const history: Array<{ role: "user" | "model"; parts: Part[] }> = [
    { role: "user", parts: [{ text: userPrompt }] },
  ];

  let selectedIds: string[] = [];
  let turns = 0;

  while (turns < MAX_TURNS) {
    turns++;

    const response = await genAI.models.generateContent({
      model,
      contents: history,
      config: {
        temperature: 0,
        systemInstruction: systemPrompt,
        tools,
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: ["listChildren", "getNode", "select_nodes"],
          },
        },
        httpOptions: { timeout: 120_000 },
      },
    });

    const candidate = response.candidates?.[0];
    const toolCalls = (candidate?.content?.parts ?? []).filter(
      (p): p is { functionCall: { name?: string; args?: Record<string, unknown>; id?: string } } =>
        typeof p === "object" && p !== null && "functionCall" in p && !!p.functionCall
    );
    if (toolCalls.length === 0) break;

    history.push({ role: "model", parts: toolCalls });

    const functionResponses: Array<{
      functionResponse: {
        name: string;
        response: Record<string, unknown>;
        id?: string;
      };
    }> = [];
    let done = false;

    for (const call of toolCalls) {
      const fn: string = call.functionCall?.name ?? "";
      const args: Record<string, unknown> = call.functionCall?.args ?? {};
      const callId = call.functionCall?.id;
      let content: Record<string, unknown>;

      if (fn === "select_nodes") {
        selectedIds = Array.isArray(args.node_ids)
          ? args.node_ids.filter((id): id is string => typeof id === "string")
          : [];
        content = { status: "selected", count: selectedIds.length };
        done = true;
      } else if (fn === "listChildren" || fn === "getNode") {
        content = handleGraphReadTool(goals, fn, args, { ...READ_TOOL_PROJECTION, rootNodeId });
      } else {
        content = { error: `Unknown tool: ${fn}` };
      }

      functionResponses.push({
        functionResponse: {
          name: fn,
          response: content?.error ? { error: content.error } : { output: content },
          ...(callId ? { id: callId } : {}),
        },
      });
    }

    history.push({ role: "user", parts: functionResponses });
    if (done) break;
  }

  return selectedIds
    .filter((id) => (reachable ? reachable.has(id) && id !== rootNodeId : goals.has(id)))
    .map((id) => {
      const goal = goals.get(id);
      if (!goal) {
        return null;
      }
      return {
        id,
        title: goal.text,
        contents: getNodeContents(goal),
        relevanceScore: 1,
      };
    })
    .filter((node): node is RetrievedNode => node !== null);
}
