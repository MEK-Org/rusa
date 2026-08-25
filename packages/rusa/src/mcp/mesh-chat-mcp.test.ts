import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMeshChatMcpServer } from "./mesh-chat-mcp.js";

async function connect(actorId: string): Promise<Client> {
  const messages = [
    {
      id: "message-1",
      ts: "2026-07-26T00:00:00Z",
      senderId: "root",
      recipientId: "worker",
      body: "Please review the PR",
      sessionId: null,
    },
    {
      id: "message-2",
      ts: "2026-07-26T00:01:00Z",
      senderId: "worker",
      recipientId: "root",
      body: "Review complete",
      sessionId: null,
    },
  ];
  const server = createMeshChatMcpServer(
    {
      getById: (id) => messages.find((message) => message.id === id) ?? null,
      listForActor: (visibleTo, opts) =>
        messages
          .filter(
            (message) =>
              (message.senderId === visibleTo || message.recipientId === visibleTo) &&
              (!opts?.peerId ||
                (message.senderId === visibleTo && message.recipientId === opts.peerId) ||
                (message.recipientId === visibleTo && message.senderId === opts.peerId))
          )
          .slice(0, opts?.limit),
    },
    actorId
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("mesh-chat-read MCP", () => {
  it("reads a pointer-addressed message for a participant", async () => {
    const client = await connect("worker");
    const result = (await client.callTool({
      name: "get_message",
      arguments: { message_id: "message-1" },
    })) as CallToolResult;
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Please review the PR"),
    });
  });

  it("hides messages from unrelated actors", async () => {
    const client = await connect("other");
    const result = (await client.callTool({
      name: "get_message",
      arguments: { message_id: "message-1" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
  });

  it("lists recent context shared with a peer", async () => {
    const client = await connect("worker");
    const result = (await client.callTool({
      name: "list_messages",
      arguments: { peer_id: "root", limit: 10 },
    })) as CallToolResult;
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Review complete"),
    });
  });
});
