import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// A synthetic, independently running graph service. It owns its token, its
// fixed user and a rendered graph shared by every session, and reports what
// happened as JSON lines on stdout so a test can observe the service side.
const { values: options } = parseArgs({
  options: {
    port: { type: "string", default: "0" },
    "token-file": { type: "string" },
    user: { type: "string" },
    "state-file": { type: "string" },
  },
});
const token = readFileSync(options["token-file"], "utf8").trim();
const userId = options.user;
const stateFile = options["state-file"];

const report = (event) =>
  process.stdout.write(`${JSON.stringify({ ...event, pid: process.pid })}\n`);

// Rendered lazily on the first read and then kept for the life of the
// service, across sessions; writes persist, so a restart recovers them.
let rendered;
const graph = () => {
  if (!rendered) {
    const written =
      stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : [];
    rendered = { renderedAt: Date.now(), renders: 1, written };
    report({ event: "rendered" });
  }
  return rendered;
};

const sessions = new Map();

function sessionServer(scope) {
  const server = new McpServer({ name: "synthetic-graph-service", version: "0.1.0" });
  const context = (sessionId) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          userId,
          scope,
          sessionId,
          renderedAt: graph().renderedAt,
          renders: graph().renders,
          written: graph().written,
          pid: process.pid,
        }),
      },
    ],
  });
  server.registerTool("read_goal", { description: "Synthetic graph read." }, async (extra) =>
    context(extra.sessionId)
  );
  server.registerTool(
    "write_goal",
    { description: "Synthetic graph write.", inputSchema: { value: z.string() } },
    async ({ value }, extra) => {
      // The service enforces its session scope itself, behind Rusa's filter.
      if (scope !== "write") {
        return { isError: true, content: [{ type: "text", text: "read-only session" }] };
      }
      graph().written.push(value);
      if (stateFile) writeFileSync(stateFile, JSON.stringify(graph().written));
      return context(extra.sessionId);
    }
  );
  server.registerTool("slow_read", { description: "Waits until cancelled." }, async (extra) => {
    await new Promise((resolve) => {
      extra.signal.addEventListener("abort", resolve, { once: true });
    });
    report({ event: "cancelled", sessionId: extra.sessionId });
    return context(extra.sessionId);
  });
  server.registerTool("unconfigured_tool", { description: "Must never be proxied." }, async () => ({
    content: [{ type: "text", text: "unexpected" }],
  }));
  return server;
}

const reject = (res, status, reason) => {
  report({ event: "rejected", status, reason });
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ error: reason }));
};

const http = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) return reject(res, 401, "token");
  if (req.headers["rusa-mcp-user-id"] !== userId) return reject(res, 403, "user");
  const scope = req.headers["rusa-mcp-scope"];
  if (scope !== "read" && scope !== "write") return reject(res, 403, "scope");
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return reject(res, 404, "session");
    // A session keeps the scope it was opened with.
    if (session.scope !== scope) return reject(res, 403, "scope changed");
    return session.transport.handleRequest(req, res);
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, scope });
      report({ event: "session_opened", sessionId: id, scope });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId && sessions.delete(transport.sessionId)) {
      report({ event: "session_closed", sessionId: transport.sessionId });
    }
  };
  await sessionServer(scope).connect(transport);
  await transport.handleRequest(req, res);
});

http.listen(Number(options.port), "127.0.0.1", () => {
  report({ event: "listening", port: http.address().port });
});
