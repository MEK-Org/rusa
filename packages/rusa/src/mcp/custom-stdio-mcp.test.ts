import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createCustomStdioMcpServer } from "./custom-stdio-mcp.js";

const fixture = join(process.cwd(), "src/mcp/fixtures/custom-stdio-server.mjs");

const grants = new Map<string, string[]>();
const connected: Client[] = [];

async function connect(actorId: string): Promise<Client> {
  const proxy = createCustomStdioMcpServer({
    actorId,
    server: {
      capability: "glass_goals",
      config: {
        command: process.execPath,
        args: [fixture],
        userId: "configured-user",
        readTools: ["read_goal"],
        writeTools: ["write_goal"],
      },
    },
    activeCapabilities: (id) => grants.get(id) ?? [],
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  connected.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(connected.splice(0).map((client) => client.close()));
  grants.clear();
});

describe("configured host-side stdio MCP proxy", () => {
  it("filters discovery, fixes the upstream graph identity, and never passes an actor identity", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");

    await expect(client.listTools()).resolves.toMatchObject({
      tools: [{ name: "read_goal" }],
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["read_goal"]);

    const result = await client.callTool({ name: "read_goal" });
    expect(result).not.toHaveProperty("isError", true);
    expect((result as { content: Array<unknown> }).content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify({ userId: "configured-user", scope: "read", actorId: null }),
    });

    await expect(client.callTool({ name: "write_goal" })).resolves.toMatchObject({ isError: true });
  });

  it("fails closed for wrong-user and ungranted actors", async () => {
    grants.set("wrong", ["glass_goals:another-user:write"]);
    const wrongUser = await connect("wrong");
    await expect(wrongUser.listTools()).resolves.toMatchObject({ tools: [] });

    const ungranted = await connect("ungranted");
    await expect(ungranted.listTools()).resolves.toMatchObject({ tools: [] });
  });

  it("checks the live grant again for an already established session", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["read_goal"]);

    grants.set("reader", []);
    await expect(client.callTool({ name: "read_goal" })).resolves.toMatchObject({ isError: true });
  });

  it("restarts its private upstream when a live grant changes scope", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");
    expect(
      ((await client.callTool({ name: "read_goal" })) as { content: Array<unknown> }).content[0]
    ).toMatchObject({
      text: JSON.stringify({ userId: "configured-user", scope: "read", actorId: null }),
    });

    grants.set("reader", ["glass_goals:configured-user:write"]);
    expect(
      ((await client.callTool({ name: "write_goal" })) as { content: Array<unknown> }).content[0]
    ).toMatchObject({
      text: JSON.stringify({ userId: "configured-user", scope: "write", actorId: null }),
    });

    grants.set("reader", ["glass_goals:configured-user:read"]);
    expect(
      ((await client.callTool({ name: "read_goal" })) as { content: Array<unknown> }).content[0]
    ).toMatchObject({
      text: JSON.stringify({ userId: "configured-user", scope: "read", actorId: null }),
    });
  });

  it("keeps separate actor sessions in separate upstream scope contexts", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    grants.set("writer", ["glass_goals:configured-user:write"]);
    const reader = await connect("reader");
    const writer = await connect("writer");

    expect(
      ((await reader.callTool({ name: "read_goal" })) as { content: Array<unknown> }).content[0]
    ).toMatchObject({
      text: JSON.stringify({ userId: "configured-user", scope: "read", actorId: null }),
    });
    expect(
      ((await writer.callTool({ name: "write_goal" })) as { content: Array<unknown> }).content[0]
    ).toMatchObject({
      text: JSON.stringify({ userId: "configured-user", scope: "write", actorId: null }),
    });
    expect(
      ((await reader.callTool({ name: "read_goal" })) as { content: Array<unknown> }).content[0]
    ).toMatchObject({
      text: JSON.stringify({ userId: "configured-user", scope: "read", actorId: null }),
    });
  });
});
