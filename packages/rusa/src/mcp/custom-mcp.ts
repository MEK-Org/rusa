import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { assertSecretContainment } from "../config/secrets.js";
import type { CustomMcpServerConfig } from "../config/types.js";
import { type Logger, serializeError } from "../observability/logger.js";
import { toolError } from "./result.js";

const UPSTREAM_TIMEOUT_MS = 30_000;

/** Fixed graph user sent to a configured HTTP service on every request. */
export const CUSTOM_MCP_USER_HEADER = "Rusa-Mcp-User-Id";
/** Current `read` or `write` scope of one upstream HTTP session. */
export const CUSTOM_MCP_SCOPE_HEADER = "Rusa-Mcp-Scope";

type Access = "read" | "write";

export interface ConfiguredCustomMcpServer {
  capability: string;
  config: CustomMcpServerConfig;
}

interface UpstreamSession {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  scope: Access;
}

export interface CustomMcpOptions {
  actorId: string;
  server: ConfiguredCustomMcpServer;
  activeCapabilities: (actorId: string) => readonly string[];
  /** Host secrets directory holding an HTTP server's `tokenFile`. */
  secretsDir?: string;
  logger?: Logger;
}

class NotGrantedError extends Error {}

// A 404 for an established session means the service no longer knows it,
// typically after a restart; it did not process the request, so one retry
// on a fresh session is safe even for a write.
function isExpiredSession(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
}

// A failure below the protocol leaves the session unusable; the next call
// starts a fresh one instead of reusing it.
function isTransportFailure(error: unknown, signal?: AbortSignal): boolean {
  return !signal?.aborted && !(error instanceof McpError) && !(error instanceof NotGrantedError);
}

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

// Only the DELETE that ends a session gets a deadline here: a request's own
// timeout already bounds the others, and a GET event stream is long-lived.
const boundedFetch: typeof fetch = (input, init) =>
  init?.method === "DELETE"
    ? fetch(input, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
    : fetch(input, init);

/**
 * Proxy one configured upstream through a fresh per-actor loopback session:
 * either a private host-side stdio process, or a private MCP session on an
 * independently running local HTTP service. The actor never receives the
 * command, environment, service endpoint or token: it sees only the standard
 * local HTTP MCP server.
 */
export function createCustomMcpServer(options: CustomMcpOptions): McpServer {
  const { actorId, server: configured, activeCapabilities, secretsDir, logger } = options;
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
    // An HTTP session is ended on the service, which keeps running; stdio
    // children end with their transport below.
    if (session.transport instanceof StreamableHTTPClientTransport && session.transport.sessionId) {
      try {
        await session.transport.terminateSession();
      } catch {
        // A service that is gone or slow expires the session on its own.
      }
    }
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

  const openTransport = (scope: Access): UpstreamSession["transport"] => {
    const { url, tokenFile, command, args, cwd, userId } = configured.config;
    if (url) {
      // The service's token is read per session from the host secrets
      // directory, so a rotated file takes effect at the next session.
      if (!tokenFile || !secretsDir) throw new Error("custom MCP service token is not configured");
      const token = readFileSync(assertSecretContainment(tokenFile, secretsDir), "utf-8").trim();
      if (!token) throw new Error("custom MCP service token file is empty");
      return new StreamableHTTPClientTransport(new URL(url), {
        // The same identity contract as stdio, plus the host-held token: no
        // actor id and no caller-controlled user or scope.
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
            [CUSTOM_MCP_USER_HEADER]: userId,
            [CUSTOM_MCP_SCOPE_HEADER]: scope,
          },
        },
        fetch: boundedFetch,
      });
    }
    if (!command) throw new Error("custom MCP server has neither command nor url");
    return new StdioClientTransport({
      command,
      ...(args ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      // This is the complete upstream identity contract. It intentionally has
      // no actor id, caller-controlled user or scope input, or raw credential.
      env: {
        RUSA_MCP_USER_ID: userId,
        RUSA_MCP_SCOPE: scope,
      },
      // stdout carries the protocol, so stderr is the upstream's only log.
      // Inheriting it lands diagnostics in the service log and can never fill
      // an undrained pipe and stall the child.
      stderr: "inherit",
    });
  };

  const closeUpstream = async (): Promise<void> => {
    const current = upstream;
    upstream = undefined;
    if (current) await closeSession(current);
  };

  const launch = async (scope: Access): Promise<UpstreamSession> => {
    // A launch queued behind one the close already ended must not replace it.
    if (closed) throw new Error("custom MCP proxy session closed before upstream launch");
    const transport = openTransport(scope);
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
      // A scope change ends calls still in flight on the old session; the
      // upstream never continues with a stale scope.
      await closeUpstream();
      return launch(scope);
    });
    pending = next.catch(() => undefined);
    return next;
  };

  const discard = (session: UpstreamSession): void => {
    if (upstream !== session) return;
    upstream = undefined;
    void closeSession(session);
  };

  // Run one upstream request. A session the service has forgotten is replaced
  // and the request retried once; any other failure below the protocol drops
  // the session so the next request reconnects.
  const withUpstream = async <T>(
    required: Access,
    request: (session: UpstreamSession) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> => {
    const attempt = async (retry: boolean): Promise<T> => {
      const session = await ensureUpstream(required);
      try {
        return await request(session);
      } catch (error) {
        if (isTransportFailure(error, signal)) discard(session);
        if (retry && isExpiredSession(error)) return attempt(false);
        throw error;
      }
    };
    return attempt(true);
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
  // session goes away, which in turn terminates the private stdio child or
  // ends the private session on the HTTP service.
  proxy.server.onclose = () => {
    closed = true;
    if (starting) void closeSession(starting);
    void closeUpstream();
  };

  proxy.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const access = activeAccess(actorId, configured, activeCapabilities);
    if (access.size === 0) return { tools: [] };
    try {
      // The proxy filters, so it follows every upstream page and answers with
      // one; a single deadline bounds the whole walk.
      const deadline = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
      const tools = await withUpstream(
        access.has("write") ? "write" : "read",
        async (current) => {
          const listed: Tool[] = [];
          let cursor: string | undefined;
          do {
            const page = await current.client.listTools(
              cursor === undefined ? undefined : { cursor },
              { signal: deadline }
            );
            listed.push(...page.tools);
            cursor = page.nextCursor;
          } while (cursor !== undefined);
          return listed;
        },
        deadline
      );
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
      return await withUpstream(
        classification,
        (current) =>
          current.client.callTool(
            {
              name: request.params.name,
              ...(request.params.arguments ? { arguments: request.params.arguments } : {}),
            },
            undefined,
            { signal: extra.signal, timeout: UPSTREAM_TIMEOUT_MS }
          ),
        extra.signal
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
