import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MeshChat } from "../db/repositories/mesh-chat-repository.js";
import type { InstanceEntityRef } from "../remote-instances/protocol.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const MESH_CHAT_MCP_NAME = "mesh-chat-read";

export interface MeshChatReadDeps {
  readRemote?: (ref: InstanceEntityRef) => Promise<MeshChat>;
  getById: (id: string) => MeshChat | null;
  listForActor: (actorId: string, opts?: { peerId?: string; limit?: number }) => MeshChat[];
}

/** Source-backed lookup for content referenced by mesh inbox entries. */
export function createMeshChatMcpServer(deps: MeshChatReadDeps, actorId: string): McpServer {
  const server = createMcpServer({ name: MESH_CHAT_MCP_NAME, version: "0.1.0" });
  server.registerTool(
    "get_message",
    {
      title: "Read a mesh chat message",
      description: "Read one durable mesh chat message referenced by this actor's inbox.",
      inputSchema: {
        message_id: z.string().min(1),
        instance: z
          .string()
          .regex(/^[a-zA-Z0-9_-]{1,64}$/)
          .optional()
          .describe("Origin instance from the inbox entity reference; omitted for local messages."),
      },
    },
    async ({ message_id, instance }) => {
      try {
        const message = instance
          ? await deps.readRemote?.({ instance, kind: "message", id: message_id })
          : deps.getById(message_id);
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
