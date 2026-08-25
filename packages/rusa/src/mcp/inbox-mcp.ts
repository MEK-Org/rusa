import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { attachInboxHints, type SelectedInboxEntry } from "../actor/inbox-hints.js";
import type { InboxEntry, InboxStore } from "../actor/inbox-store.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export type { SelectedInboxEntry };

export const INBOX_MCP_NAME = "inbox";

export interface InboxMcpRunScope {
  select: (entryIds: string[]) => unknown;
  selected: () => readonly string[];
  onHandled?: () => void;
  isFenced?: () => boolean;
}

/** Actor-bound durable notification tools. The model never supplies actor_id. */
export function createInboxMcpServer(
  store: InboxStore,
  actorId: string,
  runScope?: InboxMcpRunScope
): McpServer {
  const server = createMcpServer(
    { name: INBOX_MCP_NAME, version: "0.1.0" },
    { isFenced: runScope?.isFenced }
  );
  let localSelection: string[] = [];
  const scope: InboxMcpRunScope =
    runScope ??
    ({
      select: (entryIds) => {
        const entries = entryIds.map((id) => {
          const entry = store.read(actorId, id);
          if (!entry) throw new Error(`inbox entry not found: ${id}`);
          if (entry.handledAt) throw new Error(`inbox entry already handled: ${id}`);
          return entry;
        });
        localSelection = [...entryIds];
        return entries;
      },
      selected: () => localSelection,
    } satisfies InboxMcpRunScope);

  server.registerTool(
    "list",
    {
      title: "List actor inbox entries",
      description:
        "List this actor's durable notifications. Defaults to unhandled, newest first. Listing never marks an entry handled.",
      inputSchema: {
        status: z.enum(["unhandled", "handled", "all"]).optional().default("unhandled"),
        source: z.string().optional().describe("Optional exact source key."),
        limit: z.number().int().min(1).max(100).optional().default(50),
        cursor: z.string().optional().describe("Opaque cursor returned by a previous list call."),
      },
    },
    async ({ status, source, limit, cursor }) => {
      try {
        return toolOk(store.list(actorId, { status, source, limit, cursor }));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "select",
    {
      title: "Select inbox work for this run",
      description:
        "Select the bounded set of unhandled entries this run will address. Selection is required before mark_handled and defines run-scoped causality. Selected entries may include source-specific handling hints (e.g. reply expectations or threading conventions).",
      inputSchema: {
        entry_ids: z.array(z.string().min(1)).min(1).max(100),
      },
    },
    async ({ entry_ids }) => {
      try {
        if (new Set(entry_ids).size !== entry_ids.length) {
          throw new Error("entry_ids must be unique");
        }
        const selected = scope.select(entry_ids);
        const entries = Array.isArray(selected)
          ? attachInboxHints(selected as InboxEntry[])
          : selected;
        return toolOk({ entries });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "read",
    {
      title: "Read one actor inbox entry",
      description:
        "Read one notification owned by this actor. Reading is idempotent and never marks it handled.",
      inputSchema: { entry_id: z.string().min(1) },
    },
    async ({ entry_id }) => {
      try {
        const entry = store.read(actorId, entry_id);
        if (!entry) throw new Error("inbox entry not found");
        return toolOk(entry);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "mark_handled",
    {
      title: "Assert inbox entries handled",
      description:
        "Explicitly assert that this actor dealt with one or more notifications. This is an actor judgment, never a mechanical read receipt. The bounded batch is atomic. Every call must include a `note` explaining how the entries were handled or why no action was needed.",
      inputSchema: {
        entry_id: z.string().min(1).optional(),
        entry_ids: z.array(z.string().min(1)).min(1).max(100).optional(),
        note: z
          .string({
            error:
              'mark_handled requires a `note`: a brief explanation of how this inbox item was handled or why no action was needed (e.g. "merged PR ISSUE_NUM to staging" or "duplicate of ISSUE_NUM; no action needed").',
          })
          .trim()
          .min(1, {
            error:
              "`note` cannot be empty — explain how this inbox item was handled or why no action was needed.",
          })
          .max(2_000)
          .describe(
            "An explanation of how this inbox item was handled or why no action was needed."
          ),
      },
    },
    async ({ entry_id, entry_ids, note }) => {
      try {
        if ((entry_id === undefined) === (entry_ids === undefined)) {
          throw new Error("provide exactly one of entry_id or entry_ids");
        }
        const ids = entry_id === undefined ? (entry_ids ?? []) : [entry_id];
        if (new Set(ids).size !== ids.length) throw new Error("entry_ids must be unique");
        const selected = new Set(scope.selected());
        const unselected = ids.filter((id) => !selected.has(id));
        if (unselected.length > 0) {
          throw new Error(`entries must be selected in this run: ${unselected.join(", ")}`);
        }
        const entries = store.markHandled(actorId, ids, undefined, note);
        scope.onHandled?.();
        return toolOk({ entries });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
