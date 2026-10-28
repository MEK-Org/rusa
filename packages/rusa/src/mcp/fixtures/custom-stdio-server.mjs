import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const [mode, pidFile] = process.argv.slice(2);

if (mode === "--never-initialize") {
  // A synthetic upstream stuck in startup: it never answers initialize and,
  // like any stdio server, exits once its stdin closes. Each launch appends
  // its pid, so a test can count how many children started.
  appendFileSync(pidFile, `${process.pid}\n`);
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
  await new Promise(() => {});
}

if (mode === "--paged") {
  // A synthetic upstream whose permitted tool is only on the second page.
  const paged = new Server(
    { name: "synthetic-paged", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  const page = (name) => ({ name, inputSchema: { type: "object" } });
  paged.setRequestHandler(ListToolsRequestSchema, async (request) =>
    request.params?.cursor === "page-2"
      ? { tools: [page("read_goal")] }
      : { tools: [page("unconfigured_tool")], nextCursor: "page-2" }
  );
  await paged.connect(new StdioServerTransport());
  await new Promise(() => {});
}

const launchContext = () => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        userId: process.env.RUSA_MCP_USER_ID,
        scope: process.env.RUSA_MCP_SCOPE,
        actorId: process.env.RUSA_MCP_ACTOR_ID ?? null,
        pid: process.pid,
      }),
    },
  ],
});

const server = new McpServer({ name: "synthetic-glass-goals", version: "0.1.0" });
server.registerTool("read_goal", { description: "Synthetic graph read." }, async () =>
  launchContext()
);
server.registerTool("write_goal", { description: "Synthetic graph write." }, async () =>
  launchContext()
);
server.registerTool("exit_now", { description: "Synthetic upstream crash." }, async () =>
  process.exit(1)
);
server.registerTool("unconfigured_tool", { description: "Must never be proxied." }, async () => ({
  content: [{ type: "text", text: "unexpected" }],
}));

await server.connect(new StdioServerTransport());
