import { readFileSync } from "node:fs";
import http from "node:http";
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

const UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_READ_PATH_BYTES = 8 * 1024;
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
 * Adapt a separately running HTTP JSON service to the existing per-actor MCP
 * endpoint. Ordinary HTTP over a host Unix socket follows the coordinator's
 * transport pattern; no actor session owns the service or its graph context.
 */
export function createCustomHttpMcpServer(options: CustomHttpMcpOptions): McpServer {
  const { actorId, server: configured, activeCapabilities, logger } = options;
  const classifications = new Map<string, Access>([
    ...configured.config.readTools.map((name) => [name, "read"] as const),
    ...configured.config.writeTools.map((name) => [name, "write"] as const),
  ]);
  const inflight = new Set<AbortController>();
  let closed = false;

  const request = async (path: string, required: Access, body?: unknown, signal?: AbortSignal) => {
    const access = activeAccess(actorId, configured, activeCapabilities);
    if (closed || !permits(access, required)) throw new NotGrantedError();
    // Read the contained host secret on each request so rotation needs no
    // actor-session restart. Never send credentials to an actor or log them.
    const token = readFileSync(
      assertSecretContainment(configured.config.tokenFile, options.secretsDir ?? secretsDirPath()),
      "utf8"
    ).trim();
    if (!token || /[^\x21-\x7e]/.test(token)) throw new Error("invalid service credential");
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (
      Buffer.byteLength(path) > MAX_READ_PATH_BYTES ||
      (encoded !== undefined && Buffer.byteLength(encoded) > MAX_REQUEST_BYTES)
    ) {
      throw new Error("custom MCP request too large");
    }
    const controller = new AbortController();
    inflight.add(controller);
    const deadline = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    const cancellation = AbortSignal.any([
      controller.signal,
      deadline,
      ...(signal ? [signal] : []),
    ]);
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const req = http.request(
          {
            socketPath: configured.config.socketPath,
            path,
            method: encoded === undefined ? "GET" : "POST",
            agent: false,
            signal: cancellation,
            headers: {
              authorization: `Bearer ${token}`,
              "Rusa-Mcp-User-Id": configured.config.userId,
              "Rusa-Mcp-Scope": required,
              ...(encoded === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(encoded),
                  }),
            },
          },
          (res) => {
            if (res.statusCode !== 200) {
              res.destroy();
              reject(new Error(`service HTTP status ${res.statusCode}`));
              return;
            }
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
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
              } catch {
                reject(new Error("invalid service JSON"));
              }
            });
          }
        );
        req.on("error", reject);
        req.end(encoded);
      });
    } catch (error) {
      if (deadline.aborted) throw new Error("timed out");
      if (cancellation.aborted) throw new Error("cancelled");
      throw error;
    } finally {
      inflight.delete(controller);
    }
  };

  const logFailure = (operation: string, error: unknown, tool?: string): void => {
    // Do not serialize a request or server error body containing host auth.
    logger?.warn("custom_mcp_upstream_failed", {
      actorId,
      capability: configured.capability,
      operation,
      ...(tool ? { tool } : {}),
      reason:
        error instanceof Error && ["timed out", "cancelled"].includes(error.message)
          ? error.message
          : "unavailable",
    });
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
      const result = ListToolsResultSchema.parse(
        await request("/v1/tools", access.has("write") ? "write" : "read", undefined, extra.signal)
      );
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
      const path = `/v1/tools/${encodeURIComponent(call.params.name)}`;
      const args = call.params.arguments ?? {};
      // Valid tool results, including domain errors, are service-owned public
      // output. The trusted service must sanitize exceptions before returning
      // them; transport, status and malformed-result failures are redacted here.
      return CallToolResultSchema.parse(
        await request(
          classification === "read"
            ? `${path}?arguments=${encodeURIComponent(JSON.stringify(args))}`
            : path,
          classification,
          classification === "write" ? args : undefined,
          extra.signal
        )
      );
    } catch (error) {
      if (error instanceof NotGrantedError)
        return toolError("custom MCP tool is not currently granted");
      logFailure("call_tool", error, call.params.name);
      const reason = extra.signal.aborted
        ? "cancelled"
        : error instanceof Error && ["timed out", "cancelled"].includes(error.message)
          ? error.message
          : "unavailable";
      return toolError(`custom MCP upstream ${reason}`);
    }
  });
  return proxy;
}
