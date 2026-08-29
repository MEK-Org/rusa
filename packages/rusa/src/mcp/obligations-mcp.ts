import { Buffer } from "node:buffer";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ObligationRepository } from "../db/repositories/obligation-repository.js";
import type { ObligationStatus } from "../obligations/obligation.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const OBLIGATIONS_MCP_NAME = "obligations";

type ObligationServerRepository = Pick<
  ObligationRepository,
  | "get"
  | "listChildrenPage"
  | "listOwnedPage"
  | "create"
  | "setTerminalStatus"
  | "movePriorityInternal"
  | "reassign"
  | "reparent"
>;

export interface ObligationsMcpOptions {
  isFenced?: () => boolean;
  /** Whether this actor may change the current obligation's owner. */
  canReassign?: (
    actorId: string,
    obligation: ReturnType<ObligationRepository["require"]>
  ) => boolean;
}

const DEFAULT_PAGE_LIMIT = 50;

type PageCursor =
  | {
      v: 1;
      scope: "children" | "blocking-children";
      obligationId: string;
      offset: number;
    }
  | {
      v: 1;
      scope: "owned";
      actorId: string;
      status: ObligationStatus | null;
      offset: number;
    };

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): PageCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as PageCursor;
    if (
      parsed.v !== 1 ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0 ||
      !["children", "blocking-children", "owned"].includes(parsed.scope)
    ) {
      throw new Error("invalid cursor fields");
    }
    return parsed;
  } catch {
    throw new Error("invalid obligation cursor");
  }
}

function childOffset(
  cursor: string | undefined,
  scope: "children" | "blocking-children",
  obligationId: string
): number {
  if (!cursor) return 0;
  const decoded = decodeCursor(cursor);
  if (
    decoded.scope !== scope ||
    !("obligationId" in decoded) ||
    decoded.obligationId !== obligationId
  ) {
    throw new Error("obligation cursor does not match this child projection");
  }
  return decoded.offset;
}

function ownedOffset(
  cursor: string | undefined,
  actorId: string,
  status: ObligationStatus | undefined
): number {
  if (!cursor) return 0;
  const decoded = decodeCursor(cursor);
  if (
    decoded.scope !== "owned" ||
    !("actorId" in decoded) ||
    decoded.actorId !== actorId ||
    decoded.status !== (status ?? null)
  ) {
    throw new Error("obligation cursor does not match this actor or status filter");
  }
  return decoded.offset;
}

/** Actor-bound view of durable obligations. The model never supplies actor_id on list_owned. */
export function createObligationsMcpServer(
  repository: ObligationServerRepository,
  actorId: string,
  options?: ObligationsMcpOptions
): McpServer {
  const server = createMcpServer(
    { name: OBLIGATIONS_MCP_NAME, version: "0.1.0" },
    { isFenced: options?.isFenced }
  );
  const ownerId = actorId;

  server.registerTool(
    "get_obligation",
    {
      title: "Get one obligation and its direct blockers",
      description:
        "Read one obligation with its parent plus bounded, independently pageable direct-child and live-blocker projections.",
      inputSchema: {
        id: z.string().trim().min(1),
        limit: z.number().int().min(1).max(100).optional().default(DEFAULT_PAGE_LIMIT),
        children_cursor: z.string().max(1_024).optional(),
        blocking_children_cursor: z.string().max(1_024).optional(),
      },
    },
    async ({ id, limit, children_cursor, blocking_children_cursor }) => {
      try {
        const obligation = repository.get(id);
        if (!obligation) throw new Error("obligation not found");
        const childrenOffset = childOffset(children_cursor, "children", id);
        const blockingOffset = childOffset(blocking_children_cursor, "blocking-children", id);
        const children = repository.listChildrenPage(id, { limit, offset: childrenOffset });
        const blockingChildren = repository.listChildrenPage(id, {
          limit,
          offset: blockingOffset,
          blockingOnly: true,
        });
        return toolOk({
          obligation,
          parent: obligation.parentId === null ? null : repository.get(obligation.parentId),
          children: {
            items: children.obligations,
            total: children.total,
            truncated: childrenOffset > 0 || children.hasMore,
            nextCursor: children.hasMore
              ? encodeCursor({
                  v: 1,
                  scope: "children",
                  obligationId: id,
                  offset: childrenOffset + limit,
                })
              : null,
          },
          blockingChildren: {
            items: blockingChildren.obligations,
            total: blockingChildren.total,
            truncated: blockingOffset > 0 || blockingChildren.hasMore,
            nextCursor: blockingChildren.hasMore
              ? encodeCursor({
                  v: 1,
                  scope: "blocking-children",
                  obligationId: id,
                  offset: blockingOffset + limit,
                })
              : null,
          },
        });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "list_owned",
    {
      title: "List this actor's obligations",
      description:
        "List a bounded page of obligations owned by this actor in ready-before-waiting queue order. Actor identity is bound by the server.",
      inputSchema: {
        status: z.enum(["ready", "waiting", "done", "cancelled"]).optional(),
        limit: z.number().int().min(1).max(100).optional().default(DEFAULT_PAGE_LIMIT),
        cursor: z.string().max(1_024).optional(),
      },
    },
    async ({ status, limit, cursor }) => {
      try {
        const offset = ownedOffset(cursor, actorId, status);
        const page = repository.listOwnedPage(ownerId, { status, limit, offset });
        return toolOk({
          ownerId,
          obligations: page.obligations,
          total: page.total,
          truncated: offset > 0 || page.hasMore,
          nextCursor: page.hasMore
            ? encodeCursor({
                v: 1,
                scope: "owned",
                actorId,
                status: status ?? null,
                offset: offset + limit,
              })
            : null,
        });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "create_obligation",
    {
      title: "Create a new obligation",
      description:
        "Create a new obligation. If parent_id is specified, the parent obligation transitions to waiting if it was ready.",
      inputSchema: {
        owner_id: z.string().trim().min(1),
        parent_id: z.string().trim().min(1).nullable().optional(),
        intent: z.string().nullable().optional(),
        external_ref: z.string().trim().min(1).nullable().optional(),
        priority: z.number().finite().nullable().optional(),
      },
    },
    async ({ owner_id, parent_id, intent, external_ref, priority }) => {
      try {
        const obligation = repository.create({
          ownerId: owner_id,
          parentId: parent_id ?? null,
          intent: intent ?? null,
          externalRef: external_ref ?? null,
          priority: priority ?? null,
          // Bound by the server from this server's actor identity, exactly like
          // `owner` on list_owned. There is deliberately no `created_by` field
          // in inputSchema: #1671's trust boundary requires that attribution is
          // never accepted as model-supplied payload, so an actor cannot claim
          // to be anyone else — including when it creates work owned by another.
          creatorId: actorId,
        });
        return toolOk({ obligation });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "set_obligation_status",
    {
      title: "Set terminal status for an obligation",
      description:
        "Transition an obligation to 'done' or 'cancelled'. It must have no live children. If the parent was waiting and has no remaining live children, the parent re-readies at its retained priority.",
      inputSchema: {
        id: z.string().trim().min(1),
        status: z.enum(["done", "cancelled"]),
      },
    },
    async ({ id, status }) => {
      try {
        const obligation = repository.setTerminalStatus(id, status);
        return toolOk({ obligation });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "reorder_obligation",
    {
      title: "Reorder a ready obligation in its owner's queue",
      description:
        "Reorders a ready obligation in its owner's queue using midpoint priority calculation and collision repair.",
      inputSchema: {
        id: z.string().trim().min(1),
        previous_id: z.string().trim().min(1).nullable().optional(),
        next_id: z.string().trim().min(1).nullable().optional(),
        scope: z.enum(["subtree", "self"]).optional().default("subtree"),
      },
    },
    async ({ id, previous_id, next_id, scope }) => {
      try {
        const obligation = repository.movePriorityInternal(
          id,
          previous_id ?? null,
          next_id ?? null,
          scope
        );
        return toolOk({ obligation });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "reassign_obligation",
    {
      title: "Reassign a live obligation",
      description:
        "Change a ready or waiting obligation's owner while preserving its identity, tree position, priority, external reference, and state.",
      inputSchema: {
        id: z.string().trim().min(1),
        owner_id: z.string().trim().min(1),
      },
    },
    async ({ id, owner_id }) => {
      try {
        const current = repository.get(id);
        if (!current) throw new Error("obligation not found");
        const authorized = options?.canReassign
          ? options.canReassign(actorId, current)
          : current.ownerId === actorId;
        if (!authorized) throw new Error("not authorized to reassign this obligation");
        const obligation = repository.reassign(id, owner_id);
        return toolOk({ obligation, previousOwnerId: current.ownerId });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "reparent_obligation",
    {
      title: "Reparent an obligation",
      description:
        "Change the parent of an obligation. Preserves stored priority override; a NULL stored priority inherits from the new ancestry. Transactionally re-evaluates old and new parents' waiting/ready states and rejects cycles and self-parenting.",
      inputSchema: {
        id: z.string().trim().min(1),
        parent_id: z.string().trim().min(1).nullable().optional(),
      },
    },
    async ({ id, parent_id }) => {
      try {
        const obligation = repository.reparent(id, parent_id ?? null);
        return toolOk({ obligation });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
