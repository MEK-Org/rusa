import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "synthetic-glass-goals", version: "0.1.0" });
server.registerTool("read_goal", { description: "Synthetic graph read." }, async () => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        userId: process.env.RUSA_MCP_USER_ID,
        scope: process.env.RUSA_MCP_SCOPE,
        actorId: process.env.RUSA_MCP_ACTOR_ID ?? null,
      }),
    },
  ],
}));
server.registerTool("write_goal", { description: "Synthetic graph write." }, async () => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        userId: process.env.RUSA_MCP_USER_ID,
        scope: process.env.RUSA_MCP_SCOPE,
        actorId: process.env.RUSA_MCP_ACTOR_ID ?? null,
      }),
    },
  ],
}));
server.registerTool("unconfigured_tool", { description: "Must never be proxied." }, async () => ({
  content: [{ type: "text", text: "unexpected" }],
}));

await server.connect(new StdioServerTransport());
