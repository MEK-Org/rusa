import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { createE2EInstanceServer } from "./e2e-instance-mcp.js";

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("e2e-instance MCP", () => {
  it("mounts up/start, down/stop, and status with the grantee identity baked in", async () => {
    const manager = {
      up: vi.fn(() => ({ state: "up" as const, port: 8083 as const })),
      down: vi.fn(() => ({ state: "down" as const, port: 8083 as const })),
      status: vi.fn(() => ({ state: "down" as const, port: 8083 as const })),
    };
    const client = await connect(createE2EInstanceServer({ manager }, "actor-a"));

    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "down",
      "start",
      "status",
      "stop",
      "up",
    ]);
    await client.callTool({ name: "up", arguments: { worktree: "/owned/repo" } });
    await client.callTool({ name: "start", arguments: { worktree: "/owned/other" } });
    await client.callTool({ name: "down", arguments: {} });
    await client.callTool({ name: "stop", arguments: {} });
    await client.callTool({ name: "status", arguments: {} });

    expect(manager.up).toHaveBeenNthCalledWith(1, "actor-a", "/owned/repo");
    expect(manager.up).toHaveBeenNthCalledWith(2, "actor-a", "/owned/other");
    expect(manager.down).toHaveBeenCalledTimes(2);
    expect(manager.down).toHaveBeenCalledWith("actor-a");
    expect(manager.status).toHaveBeenCalledOnce();
  });
});
