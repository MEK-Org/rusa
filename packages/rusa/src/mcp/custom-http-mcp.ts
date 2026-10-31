import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import {
  Client,
  InsufficientScopeError,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { assertSecretContainment, secretsDirPath } from "../config/secrets.js";
import type { CustomMcpServerConfig } from "../config/types.js";
import type { Logger } from "../observability/logger.js";
import { toolError } from "./result.js";

/**
 * The MCP revision rusa speaks to a custom server: the 2026-07-28 Streamable
 * HTTP era, pinned. A server that only answers the 2025 `initialize`
 * handshake is refused rather than negotiated down to.
 */
export const CUSTOM_MCP_PROTOCOL_VERSION = "2026-07-28";
/** Path of the MCP endpoint on the configured Unix socket. */
export const CUSTOM_MCP_ENDPOINT_PATH = "/mcp";
const UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
type Access = "read" | "write";

export interface ConfiguredCustomMcpServer {
  capability: string;
  config: CustomMcpServerConfig;
}

export interface CustomHttpMcpOptions {
  actorId: string;
  server: ConfiguredCustomMcpServer;
  activeCapabilities: (actorId: string) => readonly string[];
  secretsDir?: string;
  logger?: Logger;
}

class NotGrantedError extends Error {}
class RequestTooLargeError extends Error {}

interface DriftRecord {
  lastUpstreamKeyByScope: Map<Access, string>;
  lastWarned?: {
    scope: Access;
    missing: string[];
    unclassified: string[];
  };
}

/**
 * Deduplication state for classification drift warnings: memoized per server
 * configuration, tracking observed upstream tool listings by discovery scope.
 */
const warnedDriftsByServer = new Map<string, DriftRecord>();

function serverConfigKey(configured: ConfiguredCustomMcpServer): string {
  const read = [...configured.config.readTools].sort().join(",");
  const write = [...configured.config.writeTools].sort().join(",");
  return `${configured.capability}:${configured.config.socketPath}:${read}:${write}`;
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

/**
 * `fetch` over the service's Unix socket for the SDK transport, which has no
 * socket option of its own. Node's `fetch` cannot dial a Unix socket without
 * an extra dependency, so this adapts `node:http` to the Web `Response` the
 * transport reads. Each exchange is one connection: the service is stateless
 * and nothing is kept open between calls. The response is buffered whole
 * under a cap before the transport reads it. The contract has the service
 * answer in plain JSON (its handler runs in the SDK's `json` response mode);
 * a one-shot SSE answer would still be buffered and read, so nothing here
 * depends on it. The request bound is applied here, on the exact body the
 * service would receive, so an oversized request never dials the socket.
 */
function fetchOverSocket(socketPath: string): typeof fetch {
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = init?.body;
      if (body !== undefined && body !== null && typeof body !== "string") {
        reject(new Error("unsupported request body"));
        return;
      }
      if (body && Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
        reject(new RequestTooLargeError());
        return;
      }
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        headers[name] = value;
      });
      // The service checks Host like any local HTTP server; the socket path
      // is the real address.
      headers.host = url.host;
      if (body) headers["content-length"] = String(Buffer.byteLength(body));
      // Dial the socket here rather than through `socketPath`: an unusable
      // path (over the kernel's length limit, say) makes the dial fail before
      // the HTTP client listens for it, and that failure would otherwise
      // escape as an uncaught exception. Without an agent, node uses this
      // connection once and closes it.
      const socket = net.connect({ path: socketPath });
      socket.on("error", reject);
      const req = http.request(
        {
          createConnection: () => socket,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers,
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) {
              res.destroy(new Error("service response too large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (typeof value === "string") responseHeaders.set(name, value);
              else if (Array.isArray(value)) responseHeaders.set(name, value.join(", "));
            }
            const status = res.statusCode ?? 0;
            try {
              resolve(
                new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
                  status,
                  statusText: res.statusMessage ?? "",
                  headers: responseHeaders,
                })
              );
            } catch (error) {
              reject(error);
            }
          });
        }
      );
      req.on("error", reject);
      req.end(body ?? undefined);
    });
}

function refused(error: unknown): boolean {
  return (
    error instanceof InsufficientScopeError ||
    (error instanceof SdkHttpError && (error.status === 401 || error.status === 403))
  );
}

/**
 * Adapt a separately running MCP service to the existing per-actor MCP
 * endpoint. The service speaks the official MCP 2026-07-28 Streamable HTTP
 * contract over a host Unix socket, following the coordinator's transport
 * pattern; no actor session owns the service or its graph context.
 */
export function createCustomHttpMcpServer(options: CustomHttpMcpOptions): McpServer {
  const { actorId, server: configured, activeCapabilities, logger } = options;
  const classifications = new Map<string, Access>([
    ...configured.config.readTools.map((name) => [name, "read"] as const),
    ...configured.config.writeTools.map((name) => [name, "write"] as const),
  ]);
  const endpoint = new URL(`http://localhost${CUSTOM_MCP_ENDPOINT_PATH}`);
  const inflight = new Set<AbortController>();
  let closed = false;

  /**
   * One upstream exchange: a fresh stateless connection carrying the host
   * credential, the configured user and the scope this call needs. The
   * service holds no session, so a client per request costs one extra
   * `server/discover` round trip on the local socket and nothing else.
   */
  const withUpstream = async <T>(
    required: Access,
    signal: AbortSignal | undefined,
    operation: (upstream: Client, cancellation: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const access = activeAccess(actorId, configured, activeCapabilities);
    if (closed || !permits(access, required)) throw new NotGrantedError();
    // Read the contained host secret on each request so rotation needs no
    // actor-session restart. Never send credentials to an actor or log them.
    const token = readFileSync(
      assertSecretContainment(configured.config.tokenFile, options.secretsDir ?? secretsDirPath()),
      "utf8"
    ).trim();
    if (!token || /[^\x21-\x7e]/.test(token)) throw new Error("invalid service credential");
    const controller = new AbortController();
    inflight.add(controller);
    const deadline = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    const cancellation = AbortSignal.any([
      controller.signal,
      deadline,
      ...(signal ? [signal] : []),
    ]);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: fetchOverSocket(configured.config.socketPath),
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`,
          "rusa-mcp-user-id": configured.config.userId,
          "rusa-mcp-scope": required,
        },
      },
      // A scope refusal is the service's verdict on this configured user;
      // there is no OAuth flow to step up through.
      onInsufficientScope: "throw",
    });
    const upstream = new Client(
      { name: "rusa", version: "0.1.0" },
      { versionNegotiation: { mode: { pin: CUSTOM_MCP_PROTOCOL_VERSION } } }
    );
    // The connect-time version probe runs before the protocol layer attaches
    // and ignores the request signal, so cancellation closes the transport
    // outright: that aborts whatever HTTP exchange is in flight.
    const abort = () => void transport.close().catch(() => {});
    cancellation.addEventListener("abort", abort, { once: true });
    try {
      // The listener never fires for a signal that is already aborted, hence
      // the check first.
      cancellation.throwIfAborted();
      await upstream.connect(transport, { signal: cancellation, timeout: UPSTREAM_TIMEOUT_MS });
      return await operation(upstream, cancellation);
    } catch (error) {
      if (deadline.aborted) throw new Error("timed out");
      if (cancellation.aborted) throw new Error("cancelled");
      throw error;
    } finally {
      cancellation.removeEventListener("abort", abort);
      inflight.delete(controller);
      await upstream.close().catch(() => {});
    }
  };

  const logFailure = (operation: string, error: unknown, tool?: string): void => {
    // Only a coarse reason and status are logged: SDK errors quote the
    // service's response text, which may carry host auth detail.
    logger?.warn("custom_mcp_upstream_failed", {
      actorId,
      capability: configured.capability,
      operation,
      ...(tool ? { tool } : {}),
      ...(error instanceof SdkHttpError
        ? { status: error.status }
        : error instanceof InsufficientScopeError
          ? { status: 403 }
          : {}),
      reason: failureReason(error),
    });
  };
  const failureReason = (error: unknown): string => {
    if (error instanceof Error && ["timed out", "cancelled"].includes(error.message)) {
      return error.message;
    }
    if (error instanceof RequestTooLargeError) return "request too large";
    return refused(error) ? "refused" : "unavailable";
  };
  const checkClassificationDrift = (
    discoveryScope: Access,
    upstreamTools: Array<{ name: string }>
  ): void => {
    const upstreamNames = upstreamTools.map((t) => t.name).sort();
    const upstreamKey = upstreamNames.join(",");
    const key = serverConfigKey(configured);
    let record = warnedDriftsByServer.get(key);
    if (!record) {
      record = { lastUpstreamKeyByScope: new Map() };
      warnedDriftsByServer.set(key, record);
    }

    if (record.lastUpstreamKeyByScope.get(discoveryScope) === upstreamKey) {
      return;
    }
    record.lastUpstreamKeyByScope.set(discoveryScope, upstreamKey);

    const observedSet = new Set(upstreamNames);
    const unclassified = upstreamNames.filter((name) => !classifications.has(name));

    const toCheck =
      discoveryScope === "write"
        ? [...configured.config.readTools, ...configured.config.writeTools]
        : [...configured.config.readTools];
    const missing = Array.from(new Set(toCheck))
      .filter((name) => !observedSet.has(name))
      .sort();

    if (unclassified.length > 0 || missing.length > 0) {
      if (record.lastWarned) {
        if (record.lastWarned.scope === "write" && discoveryScope === "read") {
          const hasNewMissing = missing.some((m) => !record.lastWarned?.missing.includes(m));
          const hasNewUnclassified = unclassified.some(
            (u) => !record.lastWarned?.unclassified.includes(u)
          );
          if (!hasNewMissing && !hasNewUnclassified) {
            return;
          }
        }
        if (
          record.lastWarned.missing.join(",") === missing.join(",") &&
          record.lastWarned.unclassified.join(",") === unclassified.join(",")
        ) {
          return;
        }
      }

      logger?.warn("custom_mcp_classification_drift", {
        capability: configured.capability,
        scope: discoveryScope,
        missing,
        unclassified,
      });
      record.lastWarned = {
        scope: discoveryScope,
        missing,
        unclassified,
      };
    } else if (discoveryScope === "write" || configured.config.writeTools.length === 0) {
      record.lastWarned = undefined;
    }
  };
  const proxy = new McpServer(
    { name: configured.capability, version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  proxy.server.onclose = () => {
    closed = true;
    for (const controller of inflight) controller.abort();
  };
  proxy.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const access = activeAccess(actorId, configured, activeCapabilities);
    if (access.size === 0) return { tools: [] };
    try {
      // Discovery carries the actor's effective scope, so the service lists
      // what that scope allows; rusa's own classification then decides what
      // this actor may see and call.
      const discoveryScope: Access = access.has("write") ? "write" : "read";
      const result = ListToolsResultSchema.parse(
        await withUpstream(discoveryScope, extra.signal, (upstream, cancellation) =>
          upstream.listTools(undefined, { signal: cancellation })
        )
      );
      checkClassificationDrift(discoveryScope, result.tools);
      const currentAccess = activeAccess(actorId, configured, activeCapabilities);
      return {
        tools: result.tools.filter((tool) => {
          const classification = classifications.get(tool.name);
          return classification !== undefined && permits(currentAccess, classification);
        }),
      };
    } catch (error) {
      if (!(error instanceof NotGrantedError)) logFailure("list_tools", error);
      return { tools: [] };
    }
  });
  proxy.server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
    const classification = classifications.get(call.params.name);
    const access = activeAccess(actorId, configured, activeCapabilities);
    if (!classification || !permits(access, classification)) {
      return toolError("custom MCP tool is not currently granted");
    }
    try {
      // Valid tool results, including domain errors, are service-owned public
      // output. The trusted service must sanitize exceptions before returning
      // them; transport, status and malformed-result failures are redacted here.
      return CallToolResultSchema.parse(
        await withUpstream(classification, extra.signal, (upstream, cancellation) =>
          upstream.callTool(
            { name: call.params.name, arguments: call.params.arguments ?? {} },
            { signal: cancellation }
          )
        )
      );
    } catch (error) {
      if (error instanceof NotGrantedError)
        return toolError("custom MCP tool is not currently granted");
      logFailure("call_tool", error, call.params.name);
      return toolError(
        `custom MCP upstream ${extra.signal.aborted ? "cancelled" : failureReason(error)}`
      );
    }
  });
  return proxy;
}
