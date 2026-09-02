import { Buffer } from "node:buffer";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { OBLIGATION_TITLE_MAX, type ObligationStatus } from "../obligations/obligation.js";
import { REFERENCE_SCHEMES } from "../references/reference.js";
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
  | "setExternalRef"
  | "attachArtifact"
  | "listArtifacts"
  | "movePriorityInternal"
  | "reassign"
  | "reparent"
  | "setRecurrence"
>;

export interface ObligationsMcpOptions {
  /**
   * Resolve a requested owner to one the mesh can route to, or refuse it.
   *
   * Injected because this module has no registry. Absent, any nonblank string
   * is accepted — which is what production did, since `ObligationRepository` is
   * constructed there without an `actorExists` probe, leaving the repository's
   * own guard inert. That admitted nonexistent actors and arbitrary `system:*`
   * ids: exactly the owner drift `0025` migrates away, re-entering through the
   * write boundary.
   */
  resolveOwner?: (
    rawOwnerId: string
  ) => { ok: true; ownerId: string } | { ok: false; error: string };

  isFenced?: () => boolean;
  /** Whether this actor may make an owner-authorized mutation to an obligation. */
  canManage?: (actorId: string, obligation: ReturnType<ObligationRepository["require"]>) => boolean;
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
  const canManage = (obligation: ReturnType<ObligationRepository["require"]>): boolean =>
    options?.canManage ? options.canManage(actorId, obligation) : obligation.ownerId === actorId;

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
          artifacts: repository.listArtifacts(id),
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
        "Create a new obligation. `title` is the heading a queue shows; keep it to one short line and put the detail in `intent`. If parent_id is specified, the parent obligation transitions to waiting if it was ready.",
      inputSchema: {
        owner_id: z.string().trim().min(1),
        title: z.string().trim().min(1).max(OBLIGATION_TITLE_MAX),
        parent_id: z.string().trim().min(1).nullable().optional(),
        intent: z.string().nullable().optional(),
        external_ref: z.string().trim().min(1).nullable().optional(),
        priority: z.number().finite().nullable().optional(),
        recurrence: z
          .union([
            z.object({ policy: z.literal("cron"), cronExpr: z.string().trim().min(1) }),
            z.object({
              policy: z.literal("completion_interval"),
              intervalSeconds: z.number().int().min(1),
            }),
          ])
          .nullable()
          .optional(),
      },
    },
    async ({ owner_id, title, parent_id, intent, external_ref, priority, recurrence }) => {
      try {
        const owner = options?.resolveOwner?.(owner_id) ?? { ok: true as const, ownerId: owner_id };
        if (!owner.ok) return toolError(new Error(owner.error));
        const obligation = repository.create({
          ownerId: owner.ownerId,
          title,
          parentId: parent_id ?? null,
          intent: intent ?? null,
          externalRef: external_ref ?? null,
          priority: priority ?? null,
          recurrence: recurrence ?? null,
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
    "set_obligation_recurrence",
    {
      title: "Set recurrence for an obligation",
      description:
        "Enables, changes, or disables recurrence for an obligation, and reconciles its OS job.",
      inputSchema: {
        id: z.string().trim().min(1),
        recurrence: z
          .union([
            z.object({ policy: z.literal("cron"), cronExpr: z.string().trim().min(1) }),
            z.object({
              policy: z.literal("completion_interval"),
              intervalSeconds: z.number().int().min(1),
            }),
          ])
          .nullable(),
      },
    },
    async ({ id, recurrence }) => {
      try {
        const obligation = repository.setRecurrence(id, recurrence);
        return toolOk({ obligation });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "set_obligation_status",
    {
      title: "Set terminal status for an obligation",
      description:
        "Transition an obligation to 'done' or 'cancelled'. It must have no live children. If the parent was waiting and has no remaining live children, the parent re-readies at its retained priority. Pass `note` to record why in words, and `resolution_ref` to cite what settled it (e.g. the mesh_chat message that answered the question) — the ref is attached to the obligation as part of the same transition.",
      inputSchema: {
        id: z.string().trim().min(1),
        status: z.enum(["done", "cancelled"]),
        note: z.string().nullable().optional(),
        resolution_ref: z.string().trim().min(1).nullable().optional(),
      },
    },
    async ({ id, status, note, resolution_ref }) => {
      try {
        const obligation = repository.setTerminalStatus(
          id,
          status,
          note ?? null,
          resolution_ref ?? null
        );
        return toolOk({ obligation });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "set_external_ref",
    {
      title: "Link or unlink the issue/PR/repo this obligation is",
      description:
        "Set the obligation's identity claim — the external object this obligation *is* — or pass null to unlink. Accepts a GitHub owner, repository, issue or pull request: github:OWNER, github:OWNER/REPO, github:OWNER/REPO/issues/33, github:OWNER/REPO/pulls/76. At most one live obligation may claim a given ref. This is not attach_artifact: a comment or review is evidence *about* the work, so cite it as an artifact instead.",
      inputSchema: {
        id: z.string().trim().min(1),
        external_ref: z.string().trim().min(1).nullable(),
      },
    },
    async ({ id, external_ref }) => {
      try {
        const current = repository.get(id);
        if (!current) throw new Error("obligation not found");
        if (!canManage(current)) throw new Error("not authorized to change this obligation's ref");
        return toolOk({ obligation: repository.setExternalRef(id, external_ref ?? null) });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "attach_artifact",
    {
      title: "Cite an artifact on an obligation",
      description: `Attach a reference to something that bears on this obligation — the chat message that raised it, the review that changed it, the PR that carries it. Refs are '<scheme>:<path>', scheme one of: ${REFERENCE_SCHEMES.join(", ")}, and the path is collection/id pairs: github:OWNER/REPO/issues/33, github:OWNER/REPO/issues/33/comments/12345, gchat:spaces/S/messages/M, mesh:messages/<id>. Attaching the same ref twice is a no-op, not an error. This is not external_ref, which asserts the obligation *is* a GitHub owner, repository, issue or pull request.`,
      inputSchema: {
        obligation_id: z.string().trim().min(1),
        ref: z.string().trim().min(1),
        label: z.string().nullable().optional(),
      },
    },
    async ({ obligation_id, ref, label }) => {
      try {
        const artifact = repository.attachArtifact(obligation_id, ref, {
          label: label ?? null,
          // Bound server-side from this server's identity, exactly like
          // `creatorId` on create: who cited a thing is attribution, and
          // attribution is never accepted as model payload (#1671).
          attachedBy: actorId,
        });
        return toolOk({ artifact });
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
        if (!canManage(current)) throw new Error("not authorized to reassign this obligation");
        const owner = options?.resolveOwner?.(owner_id) ?? { ok: true as const, ownerId: owner_id };
        if (!owner.ok) throw new Error(owner.error);
        const obligation = repository.reassign(id, owner.ownerId);
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
