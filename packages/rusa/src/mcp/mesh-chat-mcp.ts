import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MeshChat } from "../db/repositories/mesh-chat-repository.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const MESH_CHAT_MCP_NAME = "mesh-chat-read";

export interface MeshChatReadDeps {
  getById: (id: string) => MeshChat | null;
  listForActor: (actorId: string, opts?: { peerId?: string; limit?: number }) => MeshChat[];
}

/** Source-backed lookup for content referenced by mesh inbox entries. */
export function createMeshChatMcpServer(
  deps: MeshChatReadDeps,
  actorId: string,
  options?: { isFenced?: () => boolean }
): McpServer {
  const server = createMcpServer(
    { name: MESH_CHAT_MCP_NAME, version: "0.1.0" },
    { isFenced: options?.isFenced }
  );
  server.registerTool(
    "get_message",
    {
      title: "Read a mesh chat message",
      description: "Read one durable mesh chat message referenced by this actor's inbox.",
      inputSchema: { message_id: z.string().min(1) },
    },
    async ({ message_id }) => {
      try {
        const message = deps.getById(message_id);
        if (!message || (message.recipientId !== actorId && message.senderId !== actorId)) {
          throw new Error("mesh chat message not found");
        }
        return toolOk(message);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "list_messages",
    {
      title: "List mesh chat messages",
      description:
        "List this actor's recent durable mesh messages, optionally restricted to a peer actor, to refresh conversation context.",
      inputSchema: {
        peer_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional().default(50),
      },
    },
    async ({ peer_id, limit }) => {
      try {
        return toolOk({
          messages: deps.listForActor(actorId, {
            ...(peer_id ? { peerId: peer_id } : {}),
            limit,
          }),
        });
      } catch (err) {
        return toolError(err);
      }
    }
  );
  return server;
}
