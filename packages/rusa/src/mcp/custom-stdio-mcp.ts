import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CustomMcpServerConfig } from "../config/types.js";
import { toolError } from "./result.js";

const UPSTREAM_TIMEOUT_MS = 30_000;

type Access = "read" | "write";

export interface ConfiguredCustomMcpServer {
  capability: string;
  config: CustomMcpServerConfig;
}

interface UpstreamSession {
  client: Client;
  transport: StdioClientTransport;
  scope: Access;
}

export interface CustomStdioMcpOptions {
  actorId: string;
  server: ConfiguredCustomMcpServer;
  activeCapabilities: (actorId: string) => readonly string[];
}

function activeAccess(
  actorId: string,
  server: ConfiguredCustomMcpServer,
  activeCapabilities: (actorId: string) => readonly string[]
): Set<Access> {
  const access = new Set<Access>();
  const prefix = `${server.capability}:`;
  for (const capability of activeCapabilities(actorId)) {
    if (!capability.startsWith(prefix)) continue;
    const [userId, permission, ...rest] = capability.slice(prefix.length).split(":");
    if (userId !== server.config.userId || rest.length !== 0) continue;
    if (permission === "read" || permission === "write") access.add(permission);
  }
  return access;
}

function permits(access: ReadonlySet<Access>, classification: Access): boolean {
  return classification === "read"
    ? access.has("read") || access.has("write")
    : access.has("write");
}

/**
 * Proxy one configured host-side stdio MCP process through a fresh per-actor
 * loopback session. The actor never receives the command, environment, or a
 * direct upstream endpoint: it sees only the standard local HTTP MCP server.
 */
export function createCustomStdioMcpServer(options: CustomStdioMcpOptions): McpServer {
  const { actorId, server: configured, activeCapabilities } = options;
  const classifications = new Map<string, Access>([
    ...configured.config.readTools.map((name) => [name, "read"] as const),
    ...configured.config.writeTools.map((name) => [name, "write"] as const),
  ]);
  let upstream: UpstreamSession | undefined;

  const closeUpstream = async (): Promise<void> => {
    const current = upstream;
    upstream = undefined;
    if (!current) return;
    try {
      await current.client.close();
    } catch {
      // Client close is best effort; the transport close below owns the child cleanup.
    }
    try {
      await current.transport.close();
    } catch {
      // The transport has a bounded termination sequence of its own.
    }
  };

  const ensureUpstream = async (required: Access): Promise<UpstreamSession> => {
    const access = activeAccess(actorId, configured, activeCapabilities);
    if (!permits(access, required)) {
      throw new Error(`custom MCP capability ${configured.capability} is not currently granted`);
    }
    const scope = access.has("write") ? "write" : "read";
    if (upstream?.scope === scope) return upstream;
    await closeUpstream();
    const transport = new StdioClientTransport({
      command: configured.config.command,
      ...(configured.config.args ? { args: configured.config.args } : {}),
      ...(configured.config.cwd ? { cwd: configured.config.cwd } : {}),
      // This is the complete upstream identity contract. It intentionally has
      // no actor id, caller-controlled user or scope input, or raw credential.
      env: {
        RUSA_MCP_USER_ID: configured.config.userId,
        RUSA_MCP_SCOPE: scope,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "rusa-custom-mcp-proxy", version: "0.1.0" });
    try {
      await client.connect(transport);
    } catch {
      await transport.close().catch(() => undefined);
      throw new Error("custom MCP upstream unavailable");
    }
    upstream = { client, transport, scope };
    return upstream;
  };

  const proxy = new McpServer(
    { name: configured.capability, version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  // StreamableHTTPServerTransport closes this protocol when its downstream
  // session goes away, which in turn terminates the private stdio child.
  proxy.server.onclose = () => {
    void closeUpstream();
  };

  proxy.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const access = activeAccess(actorId, configured, activeCapabilities);
    if (access.size === 0) return { tools: [] };
    try {
      const current = await ensureUpstream(access.has("write") ? "write" : "read");
      const listed = await current.client.listTools(undefined, { timeout: UPSTREAM_TIMEOUT_MS });
      return {
        tools: listed.tools.filter(
          (tool) =>
            classifications.has(tool.name) &&
            permits(access, classifications.get(tool.name) as Access)
        ),
      };
    } catch {
      // Tool discovery is not authorization. Do not reveal upstream failures,
      // names, resources, or prompts to an actor that cannot use this surface.
      return { tools: [] };
    }
  });

  proxy.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const classification = classifications.get(request.params.name);
    const access = activeAccess(actorId, configured, activeCapabilities);
    if (!classification || !permits(access, classification)) {
      return toolError("custom MCP tool is not currently granted");
    }
    try {
      const current = await ensureUpstream(classification);
      return await current.client.callTool(
        {
          name: request.params.name,
          ...(request.params.arguments ? { arguments: request.params.arguments } : {}),
        },
        undefined,
        { signal: extra.signal, timeout: UPSTREAM_TIMEOUT_MS }
      );
    } catch {
      return toolError("custom MCP upstream unavailable");
    }
  });
  return proxy;
}
