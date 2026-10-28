import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { CustomMcpServerConfig } from "../config/types.js";
import { type Logger, serializeError } from "../observability/logger.js";
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
  logger?: Logger;
}

class NotGrantedError extends Error {}

/**
 * The access one grant confers on a configured server: `read` or `write` for
 * exactly `<capability>:<configured-user-id>:read|write`, otherwise nothing.
 * The mesh refuses any other shape at grant time; this re-check covers a row
 * left behind by a later change to the configured user.
 */
export function customGrantAccess(
  grant: string,
  server: ConfiguredCustomMcpServer
): Access | undefined {
  const prefix = `${server.capability}:${server.config.userId}:`;
  if (!grant.startsWith(prefix)) return undefined;
  const permission = grant.slice(prefix.length);
  return permission === "read" || permission === "write" ? permission : undefined;
}

function activeAccess(
  actorId: string,
  server: ConfiguredCustomMcpServer,
  activeCapabilities: (actorId: string) => readonly string[]
): Set<Access> {
  const access = new Set<Access>();
  for (const grant of activeCapabilities(actorId)) {
    const permission = customGrantAccess(grant, server);
    if (permission) access.add(permission);
  }
  return access;
}

// A write grant includes reads: a writer has to find the node it changes.
function permits(access: ReadonlySet<Access>, classification: Access): boolean {
  return classification === "read"
    ? access.has("read") || access.has("write")
    : access.has("write");
}

// The actor sees a bounded category; the operator log keeps the full error.
function failureReason(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return "cancelled";
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return "timed out";
  if (error instanceof McpError) return `returned protocol error ${error.code}`;
  return "unavailable";
}

/**
 * Proxy one configured host-side stdio MCP process through a fresh per-actor
 * loopback session. The actor never receives the command, environment, or a
 * direct upstream endpoint: it sees only the standard local HTTP MCP server.
 */
export function createCustomStdioMcpServer(options: CustomStdioMcpOptions): McpServer {
  const { actorId, server: configured, activeCapabilities, logger } = options;
  const classifications = new Map<string, Access>([
    ...configured.config.readTools.map((name) => [name, "read"] as const),
    ...configured.config.writeTools.map((name) => [name, "write"] as const),
  ]);
  let upstream: UpstreamSession | undefined;
  // The child still initializing, so a closing downstream session can end it
  // at once instead of after the initialization timeout.
  let starting: UpstreamSession | undefined;
  // Every launch decision runs behind the previous one, so concurrent calls on
  // a cold session share one child instead of each spawning and orphaning one.
  let pending: Promise<unknown> = Promise.resolve();
  let closed = false;

  const closeSession = async (session: UpstreamSession): Promise<void> => {
    try {
      await session.client.close();
    } catch {
      // Client close is best effort; the transport close below owns the child cleanup.
    }
    try {
      await session.transport.close();
    } catch {
      // The transport has a bounded termination sequence of its own.
    }
  };

  const closeUpstream = async (): Promise<void> => {
    const current = upstream;
    upstream = undefined;
    if (current) await closeSession(current);
  };

  const launch = async (scope: Access): Promise<UpstreamSession> => {
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
      // stdout carries the protocol, so stderr is the upstream's only log.
      // Inheriting it lands diagnostics in the service log and can never fill
      // an undrained pipe and stall the child.
      stderr: "inherit",
    });
    const client = new Client({ name: "rusa-custom-mcp-proxy", version: "0.1.0" });
    const session: UpstreamSession = { client, transport, scope };
    starting = session;
    try {
      await client.connect(transport, { timeout: UPSTREAM_TIMEOUT_MS });
    } catch (error) {
      await closeSession(session);
      throw error;
    } finally {
      starting = undefined;
    }
    if (closed) {
      // The downstream session ended while this child was starting.
      await closeSession(session);
      throw new Error("custom MCP proxy session closed during upstream launch");
    }
    // A child that exits on its own is not reused: the next call relaunches.
    client.onclose = () => {
      if (upstream === session) upstream = undefined;
    };
    upstream = session;
    return session;
  };

  const ensureUpstream = (required: Access): Promise<UpstreamSession> => {
    const next = pending.then(async () => {
      const access = activeAccess(actorId, configured, activeCapabilities);
      if (!permits(access, required)) {
        throw new NotGrantedError(`${configured.capability} is not currently granted`);
      }
      const scope = access.has("write") ? "write" : "read";
      if (upstream?.scope === scope) return upstream;
      // A scope change ends calls still in flight on the old child; the
      // upstream never continues with a stale launch scope.
      await closeUpstream();
      return launch(scope);
    });
    pending = next.catch(() => undefined);
    return next;
  };

  const logFailure = (operation: string, error: unknown, tool?: string): void => {
    logger?.warn("custom_mcp_upstream_failed", {
      actorId,
      capability: configured.capability,
      operation,
      ...(tool ? { tool } : {}),
      error: serializeError(error),
    });
  };

  const proxy = new McpServer(
    { name: configured.capability, version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  // StreamableHTTPServerTransport closes this protocol when its downstream
  // session goes away, which in turn terminates the private stdio child.
  proxy.server.onclose = () => {
    closed = true;
    if (starting) void closeSession(starting);
    void closeUpstream();
  };

  proxy.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const access = activeAccess(actorId, configured, activeCapabilities);
    if (access.size === 0) return { tools: [] };
    try {
      const current = await ensureUpstream(access.has("write") ? "write" : "read");
      // The proxy filters, so it follows every upstream page and answers with
      // one; a single deadline bounds the whole walk.
      const deadline = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await current.client.listTools(cursor === undefined ? undefined : { cursor }, {
          signal: deadline,
        });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return {
        tools: tools.filter(
          (tool) =>
            classifications.has(tool.name) &&
            permits(access, classifications.get(tool.name) as Access)
        ),
      };
    } catch (error) {
      // Discovery is not authorization: the actor sees an empty surface, and
      // the operator log says why a granted actor has no tools.
      if (!(error instanceof NotGrantedError)) logFailure("list_tools", error);
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
    } catch (error) {
      if (error instanceof NotGrantedError) {
        return toolError("custom MCP tool is not currently granted");
      }
      logFailure("call_tool", error, request.params.name);
      return toolError(`custom MCP upstream ${failureReason(error, extra.signal)}`);
    }
  });
  return proxy;
}
