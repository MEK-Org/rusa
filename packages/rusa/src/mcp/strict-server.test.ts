import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** Mirrors the shape that bit us: one optional param whose absence means something else. */
function serverWithOptional(): McpServer {
  const server = createMcpServer({ name: "test", version: "0.1.0" });
  server.registerTool(
    "list_children",
    {
      description: "List the children of a node, or the top-level nodes when no id is given.",
      inputSchema: { node_id: z.string().optional().describe("Parent node id.") },
    },
    async ({ node_id }) => toolOk({ subject: node_id ?? "TOP_LEVEL" })
  );
  return server;
}

function dataOf(result: CallToolResult): unknown {
  const first = result.content[0];
  return JSON.parse(first && first.type === "text" ? first.text : "null");
}

describe("createMcpServer", () => {
  it("rejects an unknown param instead of answering about a different subject", async () => {
    const client = await connect(serverWithOptional());

    // The real bug: `id` is the name the sibling get_node tool uses. Dropped
    // silently, it reads as "no node_id given" — i.e. list the top level.
    const res = (await client.callTool({
      name: "list_children",
      arguments: { id: "n1" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    // The error has to name the key, or a caller can't tell which of its
    // params was wrong — the whole point is that this stops being silent.
    expect(text).toMatch(/Unrecognized key.*id/);
    expect(text).not.toContain("TOP_LEVEL");
  });

  it("still accepts the correct param, and still treats absence as the top level", async () => {
    const client = await connect(serverWithOptional());

    const named = (await client.callTool({
      name: "list_children",
      arguments: { node_id: "n1" },
    })) as CallToolResult;
    expect(named.isError).toBeFalsy();
    expect(dataOf(named)).toEqual({ subject: "n1" });

    const bare = (await client.callTool({
      name: "list_children",
      arguments: {},
    })) as CallToolResult;
    expect(bare.isError).toBeFalsy();
    expect(dataOf(bare)).toEqual({ subject: "TOP_LEVEL" });
  });

  it("rejects params on a tool that declares none", async () => {
    const server = createMcpServer({ name: "test", version: "0.1.0" });
    server.registerTool("overview", { inputSchema: {} }, async () => toolOk({ ok: true }));
    const client = await connect(server);

    expect(
      ((await client.callTool({ name: "overview", arguments: {} })) as CallToolResult).isError
    ).toBeFalsy();
    const extra = (await client.callTool({
      name: "overview",
      arguments: { k: 1 },
    })) as CallToolResult;
    expect(extra.isError).toBe(true);
    expect((extra.content[0] as { text: string }).text).toMatch(/Unrecognized key.*k/);
  });

  it("advertises the closed contract to clients", async () => {
    const client = await connect(serverWithOptional());
    const { tools } = await client.listTools();
    expect(tools[0]?.inputSchema).toMatchObject({ additionalProperties: false });
  });

  it("leaves a duck-typed complete schema alone rather than reading it as no-params", async () => {
    // A schema the SDK recognizes only by `parse`/`safeParse` keeps them on the
    // prototype, so it has no own enumerable keys. Classified by key count
    // alone it looks like the empty raw shape — a tool that takes nothing — and
    // strictifying it would advertise `properties: {}` and reject every call.
    class DuckSchema {
      parse(value: unknown): unknown {
        return value;
      }
      safeParse(value: unknown): { success: true; data: unknown } {
        return { success: true, data: value };
      }
      async safeParseAsync(value: unknown): Promise<{ success: true; data: unknown }> {
        return { success: true, data: value };
      }
    }
    const server = createMcpServer({ name: "test", version: "0.1.0" });
    server.registerTool(
      "duck",
      // biome-ignore lint/suspicious/noExplicitAny: stands in for a non-Zod SDK-compatible schema.
      { inputSchema: new DuckSchema() as any },
      async (args: unknown) => toolOk(args as object)
    );
    const client = await connect(server);

    const res = (await client.callTool({
      name: "duck",
      arguments: { a: 1 },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(dataOf(res)).toMatchObject({ a: 1 });
  });

  it("leaves a tool that registered its own complete schema alone", async () => {
    const server = createMcpServer({ name: "test", version: "0.1.0" });
    // A caller that hands over a whole schema has chosen its own unknown-key
    // policy; we don't override it.
    server.registerTool(
      "passthrough",
      { inputSchema: z.looseObject({ a: z.string() }) },
      async (args) => toolOk(args)
    );
    const client = await connect(server);

    const res = (await client.callTool({
      name: "passthrough",
      arguments: { a: "x", extra: 1 },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(dataOf(res)).toMatchObject({ a: "x", extra: 1 });
  });

  it("rejects tool calls with a fencing error when isFenced returns true", async () => {
    let fenced = false;
    const server = createMcpServer({ name: "test", version: "0.1.0" }, { isFenced: () => fenced });
    server.registerTool("action", { inputSchema: {} }, async () => toolOk({ done: true }));
    const client = await connect(server);

    const res1 = (await client.callTool({ name: "action", arguments: {} })) as CallToolResult;
    expect(res1.isError).toBeFalsy();

    fenced = true;
    const res2 = (await client.callTool({ name: "action", arguments: {} })) as CallToolResult;
    expect(res2.isError).toBe(true);
    expect((res2.content[0] as { text: string }).text).toContain(
      "Run is over: yield_run has already been called for this turn."
    );
  });
});
