import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SyncClient } from "@thkp-eng/goals-core";
import type { DocumentContentsLogEntry } from "@thkp-eng/goals-types";
import { z } from "zod";
import {
  addRelationship,
  archiveNode,
  createNode,
  listChildren,
  nodeShapeWarnings,
  removeRelationship,
  spliceNodeContents,
  updateNodeContents,
  updateNodeTitle,
  viewNode,
} from "../understanding/graph-store.js";
import { searchNodes } from "../understanding/retrieve.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

/** The pull-only read server, mounted for every agent. */
export const UNDERSTANDING_READ_MCP_NAME = "understanding";
/** The grantable write server, mounted only for the granted IU steward . */
export const UNDERSTANDING_WRITE_MCP_NAME = "understanding-write";

/** How long any single glass-goals interaction may take before we fail soft. */
const OP_TIMEOUT_MS = 30_000;

/**
 * How the understanding MCP servers reach glass-goals. A single shared,
 * lazily-authenticated {@link SyncClient} backs both read and write (the whole
 * graph is in memory once synced); `getClient` resolves `null` when glass-goals
 * is unconfigured/unreachable so the tools fail soft instead of throwing.
 */
export interface UnderstandingMcpDeps {
  getClient: () => Promise<SyncClient | null>;
}

/**
 * An explicitly-owned, lazily-authenticated holder for the shared glass-goals
 * {@link SyncClient} (ISSUE_NUM; Operator's DI review of ISSUE_NUM — no module-global state).
 * One instance per server run: the wiring (`start.ts`) creates it and injects it
 * into both understanding servers, so read + write share one client. Preserves
 * what the old singleton bought:
 *  1. **lazy auth** — `load()` runs (Firebase login + init) only on the first
 *     `getClient()`, not at construction;
 *  2. **one client per run** — a SUCCESSFUL client is memoized and shared (and
 *     concurrent first-calls share the one in-flight login);
 *  3. **fail-soft** — a `null` result is NOT memoized, so a transient
 *     missing-cred/unreachable is retried on the next call.
 * `reset()` drops the memo — the auth-expiry re-login seam, now instance state.
 */
export interface UnderstandingSyncClientProvider extends UnderstandingMcpDeps {
  reset(): void;
}

export function createUnderstandingSyncClientProvider(
  load: () => Promise<SyncClient | null>
): UnderstandingSyncClientProvider {
  let client: SyncClient | null = null;
  let inFlight: Promise<SyncClient | null> | null = null;
  return {
    getClient() {
      if (client) return Promise.resolve(client);
      if (!inFlight) {
        inFlight = load()
          .then((c) => {
            if (c) client = c; // memoize only a real client; null stays retryable
            inFlight = null;
            return c;
          })
          .catch((err) => {
            inFlight = null;
            throw err;
          });
      }
      return inFlight;
    },
    reset() {
      client = null;
      inFlight = null;
    },
  };
}

/** Bound a glass-goals interaction so a hung sync/write can't wedge the run. */
function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${OP_TIMEOUT_MS}ms`)),
      OP_TIMEOUT_MS
    );
    if (typeof timer.unref === "function") timer.unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

async function requireClient(deps: UnderstandingMcpDeps): Promise<SyncClient> {
  const client = await withTimeout(deps.getClient(), "glass-goals connect");
  if (!client) {
    throw new Error("integrated-understanding store unavailable (glass-goals not reachable)");
  }
  return client;
}

/**
 * Populate empty node bodies from the externalized string store. glass-goals stores a
 * `documentContents` entry's text in a separate `v001_strings` KV doc (the op is text-less),
 * so a node read from the synced graph has empty `contents` until that string is loaded — the
 * same externalization the calibration view resolves , here server-side for the read MCP.
 * The distiller's own backfill ops carry their text inline (already populated, skipped). Batched
 * + fail-soft: if a string can't be resolved the body just stays empty.
 */
async function resolveContents<T extends { id: string; contents: string }>(
  client: SyncClient,
  nodes: T[],
  loadStrings?: (ids: string[]) => Promise<Record<string, string>>
): Promise<T[]> {
  if (!loadStrings) return nodes;
  const goals = client.getGoals();
  const pending: { node: T; entryId: string }[] = [];
  for (const node of nodes) {
    if (node.contents) continue; // already inline (e.g. the distiller's backfill ops)
    const entry = goals
      .get(node.id)
      ?.log.find((e): e is DocumentContentsLogEntry => e.type === "documentContents");
    if (entry && !entry.text) pending.push({ node, entryId: entry.id });
  }
  if (pending.length === 0) return nodes;
  const strings = await loadStrings(pending.map((p) => p.entryId));
  for (const { node, entryId } of pending) {
    const s = strings[entryId];
    if (s) node.contents = s;
  }
  return nodes;
}

/**
 * READ tools over the integrated-understanding graph — pull-only, for every agent
 * (ISSUE_NUM, phase 1b). Reads serve the in-memory synced state, so they're cheap;
 * they fail soft (an error result, never a transport throw) when glass-goals is
 * unreachable. Pull-only by design: an agent ingests understanding only when it
 * deliberately consults, bounding the blast radius of a wrong node.
 */
export function createUnderstandingReadServer(
  deps: UnderstandingMcpDeps,
  rootNodeId?: string,
  loadStrings?: (ids: string[]) => Promise<Record<string, string>>,
  options?: { isFenced?: () => boolean }
): McpServer {
  const server = createMcpServer(
    { name: UNDERSTANDING_READ_MCP_NAME, version: "0.1.0" },
    { isFenced: options?.isFenced }
  );

  server.registerTool(
    "search",
    {
      title: "Search the integrated understanding",
      description:
        "Find nodes in the integrated-understanding library relevant to a task/query. Returns ranked nodes (id, title, contents). Consult this before non-trivial work to reuse what the system already knows.",
      inputSchema: {
        query: z.string().describe("A task description or topic to find relevant knowledge for."),
        k: z.number().int().positive().max(50).optional().describe("Max results (default 10)."),
      },
    },
    async ({ query, k }) => {
      try {
        const client = await requireClient(deps);
        return toolOk(
          await resolveContents(
            client,
            searchNodes(client, query, k ?? 10, 2, rootNodeId),
            loadStrings
          )
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "get_node",
    {
      title: "Get an understanding node",
      description: "Fetch one node by id: its title, markdown contents, parents, and children.",
      inputSchema: { id: z.string().describe("The node id.") },
    },
    async ({ id }) => {
      try {
        const client = await requireClient(deps);
        const node = viewNode(client, id, rootNodeId);
        if (!node) return toolError(new Error(`node not found: ${id}`));
        await resolveContents(client, [node], loadStrings);
        return toolOk(node);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "list_children",
    {
      title: "List children of a node",
      description:
        "List the direct children of a node, or the top-level nodes when no id is given. Use to browse the hierarchy. An id that names no visible node is an error (`node not found: <id>`), never an empty list, so an empty result means the node has no children and nothing else — which also makes this the cheap way to check that an id resolves, without fetching a whole body.",
      inputSchema: {
        node_id: z
          .string()
          .optional()
          .describe(
            "Parent node id. Omitting it does not widen the result — it selects a different subject: the top-level set. Pass an id to walk a specific node's children."
          ),
      },
    },
    async ({ node_id }) => {
      try {
        const client = await requireClient(deps);
        const children = listChildren(client, node_id, rootNodeId);
        // Same answer get_node gives for the same id: a result that names nothing
        // is an error, not an empty one .
        if (!children) return toolError(new Error(`node not found: ${node_id}`));
        return toolOk(children);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "overview",
    {
      title: "Overview of the integrated understanding",
      description:
        "The top-level map of the library. Returns top-level knowledge areas. Start here to orient before searching.",
      inputSchema: {},
    },
    async () => {
      try {
        const client = await requireClient(deps);
        // The no-id call asks for the top-level set, which always resolves.
        return toolOk({ children: listChildren(client, undefined, rootNodeId) ?? [] });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}

/**
 * WRITE tools over the integrated-understanding graph (ISSUE_NUM, phase 1b). This is a
 * GRANTABLE capability (`understanding-write`), mounted only for the actor root
 * grants it to — the single IU steward, which is the sole writer. Every write is
 * timeout-bounded and fails soft so a hung glass-goals call can't wedge the run.
 *
 * Retry semantics (elder 4a): the tools NEVER auto-retry, so a single call makes
 * at most one attempt — a timeout that abandons a still-in-flight op can't itself
 * dup. The update/relationship/archive ops are convergent (re-applying replace/
 * set-title/add-parent/remove-parent/archive yields the same state), so they're
 * safe to retry. `create_node` is the one exception: a manual retry after a
 * timeout could create a second node, so re-read (search/get_node) before
 * retrying a create. `splice_node_contents` is safe for a different reason — a
 * retry after a splice that actually landed can't find its anchor any more, so it
 * reports "old_text not found" rather than applying twice. Root-archive/-rename
 * are refused by the store (root guard).
 */
export function createUnderstandingWriteServer(
  deps: UnderstandingMcpDeps,
  rootNodeId?: string,
  options?: { isFenced?: () => boolean }
): McpServer {
  const server = createMcpServer(
    { name: UNDERSTANDING_WRITE_MCP_NAME, version: "0.1.0" },
    { isFenced: options?.isFenced }
  );

  server.registerTool(
    "create_node",
    {
      title: "Create an understanding node",
      description:
        "Create a node with a title and markdown body, optionally linked under a parent. Returns the new node id. Prefer updating an existing node over creating a near-duplicate.",
      inputSchema: {
        title: z.string().describe("Short conceptual title (not an issue id)."),
        contents: z.string().describe("Markdown body."),
        parent_id: z
          .string()
          .optional()
          .describe(
            "Parent node id to link under. Omit to create a new TOP-LEVEL area — that is the sanctioned way to add one, not an orphan, and it stays reachable from the root. Do not pass the configured root id explicitly; that is rejected."
          ),
      },
    },
    async ({ title, contents, parent_id }) => {
      try {
        const client = await requireClient(deps);
        const id = await withTimeout(
          createNode(client, { title, contents, parentId: parent_id }, rootNodeId),
          "create_node"
        );
        // A node must not be BORN over a split trigger either .
        const warnings = nodeShapeWarnings({ next: contents });
        return toolOk(warnings.length > 0 ? { id, warnings } : { id });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "update_node_contents",
    {
      title: "Update a node's markdown body",
      description:
        "Replace or append the markdown body of an existing node. Prefer folding a finding into the section that already owns the concept (a `replace` of the whole body) over appending a new dated section beside it — appended sections turn a node into a changelog . To correct part of a body rather than restate all of it, use `splice_node_contents` — re-emitting a large body by hand to change a few sentences risks mangling the rest. The write always lands; if the resulting body is past a ISSUE_NUM Part 2 split trigger the result carries `warnings` with the actual numbers, which is your cue to split the node.",
      inputSchema: {
        node_id: z.string(),
        action: z.enum(["replace", "append"]),
        text: z.string(),
      },
    },
    async ({ node_id, action, text }) => {
      try {
        const client = await requireClient(deps);
        const warnings = await withTimeout(
          updateNodeContents(client, { nodeId: node_id, action, text }, rootNodeId),
          "update_node_contents"
        );
        // Warn, never refuse : a reject mid-pass drops the window's finding.
        return toolOk(warnings.length > 0 ? { status: "ok", warnings } : "ok");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "splice_node_contents",
    {
      title: "Correct part of a node's markdown body in place",
      description:
        "Change a passage of an existing node's body without restating the rest . Give the exact text to replace (`old_text`, copied from the node as it reads now) and what it should say instead (`new_text`). Use this — not a whole-body `update_node_contents` replace — whenever you are correcting or rewording part of a node: it is the difference between a two-sentence fix and re-emitting every character of a long body, where the rest can be mangled without anyone noticing. `old_text` is literal text, not a pattern. The call FAILS, writing nothing, if the anchor matches zero times (usually a mis-copied anchor: re-read the node) or more than once without `replace_all` (extend the anchor with surrounding text until it is unique).",
      inputSchema: {
        node_id: z.string(),
        old_text: z
          .string()
          .describe("Exact text to replace, copied verbatim from the node's current body."),
        new_text: z.string().describe("What that text should say instead. May be empty to delete."),
        replace_all: z
          .boolean()
          .optional()
          .describe(
            "Change every occurrence of a genuinely repeated anchor. Default false, which makes an anchor matching more than once an error rather than a guess at which one you meant."
          ),
      },
    },
    async ({ node_id, old_text, new_text, replace_all }) => {
      try {
        const client = await requireClient(deps);
        const warnings = await withTimeout(
          spliceNodeContents(
            client,
            { nodeId: node_id, oldText: old_text, newText: new_text, replaceAll: replace_all },
            rootNodeId
          ),
          "splice_node_contents"
        );
        return toolOk(warnings.length > 0 ? { status: "ok", warnings } : "ok");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "update_node_title",
    {
      title: "Rename a node",
      description: "Update a node's title.",
      inputSchema: { node_id: z.string(), new_title: z.string() },
    },
    async ({ node_id, new_title }) => {
      try {
        const client = await requireClient(deps);
        await withTimeout(
          updateNodeTitle(client, { nodeId: node_id, newTitle: new_title }, rootNodeId),
          "update_node_title"
        );
        return toolOk("ok");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "add_relationship",
    {
      title: "Link two nodes (parent → child)",
      description: "Add a parent→child edge between two existing nodes (the graph is a DAG).",
      inputSchema: { parent_id: z.string(), child_id: z.string() },
    },
    async ({ parent_id, child_id }) => {
      try {
        const client = await requireClient(deps);
        await withTimeout(
          addRelationship(client, { parentId: parent_id, childId: child_id }, rootNodeId),
          "add_relationship"
        );
        return toolOk("ok");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "remove_relationship",
    {
      title: "Unlink two nodes",
      description: "Remove a parent→child edge between two nodes.",
      inputSchema: { parent_id: z.string(), child_id: z.string() },
    },
    async ({ parent_id, child_id }) => {
      try {
        const client = await requireClient(deps);
        await withTimeout(
          removeRelationship(client, { parentId: parent_id, childId: child_id }, rootNodeId),
          "remove_relationship"
        );
        return toolOk("ok");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "archive_node",
    {
      title: "Archive a node",
      description: "Soft-delete (archive) a node.",
      inputSchema: { node_id: z.string() },
    },
    async ({ node_id }) => {
      try {
        const client = await requireClient(deps);
        await withTimeout(archiveNode(client, node_id, rootNodeId), "archive_node");
        return toolOk("ok");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
