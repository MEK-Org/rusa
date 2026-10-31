// @vitest-environment node
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createMcpHandler,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
  McpServer as UpstreamMcpServer,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ActorMesh } from "../actor/actor-mesh.js";
import { CAPABILITY_ADMIN_CAPABILITY } from "../actor/administrative-capabilities.js";
import { InMemoryCapabilityGrantStore } from "../actor/capability-grants.js";
import type { CustomMcpServerConfig } from "../config/types.js";
import type { Logger } from "../observability/logger.js";
import { FollowerHub } from "../remote-instances/follower-hub.js";
import { INSTANCE_PROTOCOL_VERSION } from "../remote-instances/protocol.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import {
  CUSTOM_MCP_PROTOCOL_VERSION,
  createCustomHttpMcpServer,
  resetCustomMcpDriftWarningsForTest,
} from "./custom-http-mcp.js";
import {
  buildGrantableServers,
  type GrantableServerDeps,
  handleCapabilityRevoked,
  mountGrantedServers,
} from "./grantable-servers.js";
import { McpHttpServer } from "./http-server.js";

let dir: string;
let secretsDir: string;
let config: CustomMcpServerConfig;
let service: http.Server;
let upstreamToolsByScope: ((write: boolean) => string[]) | undefined;
// Failure modes other than `hang-discover` and `legacy` apply to `tools/call`
// after a successful `server/discover`, so they exercise the connected path.
let mode:
  | "normal"
  | "hang"
  | "hang-discover"
  | "legacy"
  | "hold-response"
  | "drop-write-response"
  | "tool-error"
  | "bad-json"
  | "large"
  | "error";
interface Call {
  method: string | undefined;
  tool: string | undefined;
  scope: string | undefined;
  protocolVersion: string | undefined;
}
let calls: Call[];
let aborted: number;
let mutations: number;
let heldResponses: Array<() => void>;
const grants = new Map<string, string[]>();
const connected: Client[] = [];
const credential = "synthetic-service-token";

const toolCalls = (name?: string) =>
  calls.filter((c) => c.method === "tools/call" && (name === undefined || c.tool === name));

// The host service's bearer gate: the SDK's own `requireBearerAuth`, fed a
// verifier that answers like the service does. A wrong token is an invalid
// token (401); a user the service does not act for, or a scope it does not
// recognise, is insufficient scope (403). The challenge shape is the SDK's.
const gate = (headers: http.IncomingHttpHeaders) =>
  requireBearerAuth({
    verifier: {
      async verifyAccessToken(token) {
        if (token !== credential) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, "private rejection detail");
        }
        if (headers["rusa-mcp-user-id"] !== "configured-user") {
          throw new OAuthError(OAuthErrorCode.InsufficientScope, "private rejection detail");
        }
        const scope = headers["rusa-mcp-scope"];
        if (scope !== "read" && scope !== "write") {
          throw new OAuthError(OAuthErrorCode.InsufficientScope, "private rejection detail");
        }
        return {
          token,
          clientId: "configured-user",
          scopes: scope === "write" ? ["read", "write"] : ["read"],
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        };
      },
    },
  });

// One independently listening MCP service owns this synthetic graph for the
// whole test. It speaks only the 2026-07-28 Streamable HTTP era: a legacy
// `initialize` is rejected, and every request is served statelessly by a
// fresh per-request server. No MCP session or caller can create, release or
// select its graph identity.
async function startService(): Promise<void> {
  const contextId = randomBytes(8).toString("hex");
  let visits = 0;
  const handler = createMcpHandler(
    ({ requestInfo, authInfo }) => {
      const headers = requestInfo?.headers;
      const upstream = new UpstreamMcpServer({ name: "synthetic-graph", version: "0.0.0" });
      // Like the host service, list write tools only to a write-scoped caller.
      const write = authInfo?.scopes.includes("write") === true;
      const toolNames = upstreamToolsByScope
        ? upstreamToolsByScope(write)
        : write
          ? ["read_goal", "write_goal", "unclassified"]
          : ["read_goal"];
      for (const name of toolNames) {
        upstream.registerTool(
          name,
          {
            inputSchema: z.looseObject({}),
            annotations: { readOnlyHint: name === "read_goal" },
          },
          async (args) => {
            if (name === "write_goal") mutations++;
            if (mode === "tool-error") {
              return { isError: true, content: [{ type: "text", text: "No such goal" }] };
            }
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    contextId,
                    visits: ++visits,
                    userId: headers?.get("rusa-mcp-user-id"),
                    scope: headers?.get("rusa-mcp-scope"),
                    args,
                    actorId: headers?.get("rusa-mcp-actor-id") ?? null,
                  }),
                },
              ],
            };
          }
        );
      }
      return upstream;
    },
    { responseMode: "json", legacy: "reject" }
  );
  service = http.createServer(async (req, res) => {
    res.on("close", () => {
      if (!res.writableEnded) aborted++;
    });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    let message: { method?: string; params?: { name?: string } } = {};
    try {
      message = JSON.parse(body);
    } catch {
      // A non-JSON body is recorded with no method.
    }
    const scope = req.headers["rusa-mcp-scope"] as string | undefined;
    const tool = message.params?.name;
    calls.push({
      method: message.method,
      tool,
      scope,
      protocolVersion: req.headers["mcp-protocol-version"] as string | undefined,
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string" && name !== "content-length") headers.set(name, value);
    }
    const request = new Request(`http://localhost${req.url ?? "/"}`, {
      method: req.method,
      headers,
      body,
    });
    const auth = await gate(req.headers)(request);
    if (auth instanceof Response) {
      res.writeHead(auth.status, Object.fromEntries(auth.headers)).end(await auth.text());
      return;
    }
    if (message.method === "server/discover") {
      if (mode === "hang-discover") return;
      if (mode === "legacy") {
        // What a 2025-era server answers to the version probe.
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: (message as { id?: unknown }).id ?? null,
            error: { code: -32601, message: "Method not found" },
          })
        );
        return;
      }
    } else if (message.method === "tools/call") {
      if (mode === "hang") return;
      if (mode === "error") {
        res.writeHead(500).end(credential);
        return;
      }
      if (mode === "bad-json") {
        res.writeHead(200, { "content-type": "application/json" }).end("not JSON");
        return;
      }
      if (mode === "large") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end("x".repeat(16 * 1024 * 1024 + 1));
        return;
      }
    }
    const response = await handler.fetch(request, { authInfo: auth });
    const text = await response.text();
    if (mode === "drop-write-response" && tool === "write_goal") {
      req.socket.destroy();
      return;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    const send = () => res.end(text);
    if (mode === "hold-response" && message.method === "tools/call") heldResponses.push(send);
    else send();
  });
  await new Promise<void>((resolve, reject) => {
    service.once("error", reject);
    service.listen(config.socketPath, resolve);
  });
}

async function connect(
  actorId: string,
  overrides: Partial<CustomMcpServerConfig> = {},
  logger?: Logger
): Promise<Client> {
  const proxy = createCustomHttpMcpServer({
    actorId,
    server: { capability: "glass_goals", config: { ...config, ...overrides } },
    activeCapabilities: (id) => grants.get(id) ?? [],
    secretsDir,
    ...(logger ? { logger } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  connected.push(client);
  return client;
}

interface Context {
  contextId: string;
  visits: number;
  userId: string;
  scope: string;
  args: unknown;
  actorId: null;
}
async function call(
  client: Client,
  name: string,
  args?: Record<string, unknown>
): Promise<Context> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? "null") as Context;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rusa-http-"));
  secretsDir = join(dir, "secrets");
  mkdirSync(secretsDir, { mode: 0o700 });
  writeFileSync(join(secretsDir, "service-token"), credential, { mode: 0o600 });
  config = {
    socketPath: join(dir, "service.sock"),
    tokenFile: "service-token",
    userId: "configured-user",
    readTools: ["read_goal"],
    writeTools: ["write_goal"],
  };
  mode = "normal";
  calls = [];
  aborted = 0;
  mutations = 0;
  heldResponses = [];
  upstreamToolsByScope = undefined;
  await startService();
});

afterEach(async () => {
  await Promise.all(connected.splice(0).map((client) => client.close()));
  service.closeAllConnections();
  await new Promise<void>((resolve) => service.close(() => resolve()));
  // Exclusively MCP v2: no exchange in any test fell back to the legacy
  // handshake, and every request claimed the pinned revision.
  expect(calls.map((c) => c.method)).not.toContain("initialize");
  expect(new Set(calls.map((c) => c.protocolVersion))).toEqual(
    new Set(calls.length === 0 ? [] : [CUSTOM_MCP_PROTOCOL_VERSION])
  );
  grants.clear();
  resetCustomMcpDriftWarningsForTest();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("configured host MCP service", () => {
  it("filters discovery and calls tools over stateless MCP with fixed identity and independent scopes", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    grants.set("writer", ["glass_goals:configured-user:write"]);
    const reader = await connect("reader");
    const writer = await connect("writer");
    expect((await reader.listTools()).tools.map((t) => t.name)).toEqual(["read_goal"]);
    expect((await writer.listTools()).tools.map((t) => t.name)).toEqual([
      "read_goal",
      "write_goal",
    ]);
    expect(calls.filter((c) => c.method === "tools/list").map((c) => c.scope)).toEqual([
      "read",
      "write",
    ]);
    const first = await call(reader, "read_goal", { id: "a/b ?&=#" });
    expect(first).toMatchObject({
      userId: "configured-user",
      scope: "read",
      actorId: null,
      args: { id: "a/b ?&=#" },
    });
    expect(await call(writer, "write_goal", { title: "synthetic" })).toMatchObject({
      scope: "write",
      contextId: first.contextId,
    });
    expect((await call(writer, "read_goal")).scope).toBe("read");
    expect(toolCalls().map((c) => [c.tool, c.scope])).toEqual([
      ["read_goal", "read"],
      ["write_goal", "write"],
      ["read_goal", "read"],
    ]);
    // Each exchange is its own stateless connection: a version probe, then
    // the one request. Nothing else is sent and no session is kept.
    expect(new Set(calls.map((c) => c.method))).toEqual(
      new Set(["server/discover", "tools/list", "tools/call"])
    );
    expect(calls.filter((c) => c.method === "server/discover")).toHaveLength(5);
    const count = calls.length;
    expect(await reader.callTool({ name: "write_goal" })).toMatchObject({ isError: true });
    expect(await writer.callTool({ name: "unclassified" })).toMatchObject({ isError: true });
    expect(calls).toHaveLength(count);
  });

  it("fails closed without contacting the service for ungranted or wrong-user actors", async () => {
    grants.set("wrong", ["glass_goals:other-user:write"]);
    for (const actor of ["none", "wrong"]) {
      const client = await connect(actor);
      expect(await client.listTools()).toEqual({ tools: [] });
      expect(await client.callTool({ name: "read_goal" })).toMatchObject({ isError: true });
    }
    expect(calls).toEqual([]);
  });

  it("checks grants on an established session and picks up scope changes per request", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");
    const before = await call(client, "read_goal");
    grants.set("reader", ["glass_goals:configured-user:write"]);
    expect(await call(client, "write_goal")).toMatchObject({
      contextId: before.contextId,
      scope: "write",
    });
    grants.set("reader", ["glass_goals:configured-user:read"]);
    expect((await call(client, "read_goal")).scope).toBe("read");
    grants.set("reader", []);
    const count = calls.length;
    expect(await client.listTools()).toEqual({ tools: [] });
    expect(await client.callTool({ name: "read_goal" })).toMatchObject({ isError: true });
    expect(calls).toHaveLength(count);
  });

  it.each([
    ["read", "write", "read_goal", "write_goal"],
    ["write", "read", "write_goal", "read_goal"],
  ] as const)("keeps an admitted request alive across a %s-to-%s scope change", async (before, after, admitted, next) => {
    grants.set("actor", [`glass_goals:configured-user:${before}`]);
    const client = await connect("actor");
    mode = "hold-response";
    const pending = client.callTool({ name: admitted });
    await vi.waitFor(() => expect(heldResponses).toHaveLength(1));
    grants.set("actor", [`glass_goals:configured-user:${after}`]);
    mode = "normal";
    expect((await call(client, next)).scope).toBe(after);
    heldResponses[0]?.();
    expect(await pending).not.toMatchObject({ isError: true });
    expect(aborted).toBe(0);
    expect(mutations).toBe(1);
    if (after === "read") {
      expect(await client.callTool({ name: "write_goal" })).toMatchObject({ isError: true });
      expect(mutations).toBe(1);
    }
  });

  it("reuses service graph context across concurrent calls and client reconnects", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");
    const [first, second] = await Promise.all([
      call(client, "read_goal"),
      call(client, "read_goal"),
    ]);
    expect(second.contextId).toBe(first.contextId);
    expect(new Set([first.visits, second.visits])).toEqual(new Set([1, 2]));
    await client.close();
    expect(service.listening).toBe(true);
    expect(await call(await connect("reader"), "read_goal")).toMatchObject({
      contextId: first.contextId,
      visits: 3,
    });
  });

  it("recovers on the next request after service restart", async () => {
    grants.set("writer", ["glass_goals:configured-user:write"]);
    const client = await connect("writer");
    const before = await call(client, "read_goal");
    await new Promise<void>((resolve) => service.close(() => resolve()));
    expect(await client.callTool({ name: "write_goal" })).toMatchObject({ isError: true });
    await startService();
    expect((await call(client, "read_goal")).contextId).not.toBe(before.contextId);
    expect(toolCalls("write_goal")).toHaveLength(0);
  });

  it("reports an unusable socket path as unavailable instead of crashing the host", async () => {
    grants.set("writer", ["glass_goals:configured-user:write"]);
    const warn = vi.fn();
    // Longer than the kernel allows for a Unix socket address: the dial fails
    // before any HTTP exchange starts.
    const socketPath = join(dir, `${"x".repeat(120)}.sock`);
    const client = await connect("writer", { socketPath }, { warn } as unknown as Logger);
    expect(await client.listTools()).toEqual({ tools: [] });
    expect(await client.callTool({ name: "write_goal" })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "custom MCP upstream unavailable" }],
    });
    expect(warn).toHaveBeenCalledWith(
      "custom_mcp_upstream_failed",
      expect.objectContaining({ reason: "unavailable", operation: "call_tool", tool: "write_goal" })
    );
    expect(calls).toEqual([]);
  });

  it("does not retry a committed write whose response connection is lost", async () => {
    grants.set("writer", ["glass_goals:configured-user:write"]);
    const client = await connect("writer");
    mode = "drop-write-response";
    expect(await client.callTool({ name: "write_goal" })).toMatchObject({
      isError: true,
      content: [{ text: "custom MCP upstream unavailable" }],
    });
    expect(toolCalls("write_goal")).toHaveLength(1);
    expect(mutations).toBe(1);
  });

  it("preserves caller-safe tool errors supplied by the trusted service", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");
    mode = "tool-error";
    expect(await client.callTool({ name: "read_goal" })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "No such goal" }],
    });
  });

  it.each([
    "bad-json",
    "large",
    "error",
  ] as const)("bounds %s failures and redacts upstream errors", async (failure) => {
    mode = failure;
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const warn = vi.fn();
    const client = await connect("reader", {}, { warn } as unknown as Logger);
    expect(await client.callTool({ name: "read_goal" })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "custom MCP upstream unavailable" }],
    });
    // The failure arrived on the connected path, after the probe succeeded.
    expect(calls.map((c) => c.method)).toEqual(["server/discover", "tools/call"]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(credential);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private rejection");
  });

  it("refuses a legacy-only server without falling back to initialize", async () => {
    mode = "legacy";
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const warn = vi.fn();
    const client = await connect("reader", {}, { warn } as unknown as Logger);
    expect(await client.callTool({ name: "read_goal" })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "custom MCP upstream unavailable" }],
    });
    expect(await client.listTools()).toEqual({ tools: [] });
    expect(calls.map((c) => c.method)).toEqual(["server/discover", "server/discover"]);
    expect(warn).toHaveBeenCalledWith(
      "custom_mcp_upstream_failed",
      expect.objectContaining({ reason: "unavailable", operation: "call_tool" })
    );
  });

  it("reports a write tool misclassified as read as unavailable, with no write", async () => {
    // Sent at read scope, the service knows no such tool and answers the
    // ordinary tool-not-found error; nothing is stepped up or retried.
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const warn = vi.fn();
    const client = await connect(
      "reader",
      { readTools: ["read_goal", "write_goal"], writeTools: [] },
      { warn } as unknown as Logger
    );
    expect(await client.callTool({ name: "write_goal" })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "custom MCP upstream unavailable" }],
    });
    expect(toolCalls("write_goal").map((c) => c.scope)).toEqual(["read"]);
    expect(mutations).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "custom_mcp_upstream_failed",
      expect.objectContaining({ reason: "unavailable", tool: "write_goal" })
    );
  });

  it("refuses invalid upstream identity/authentication and observes host token rotation", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const warn = vi.fn();
    const client = await connect("reader", {}, { warn } as unknown as Logger);
    writeFileSync(join(secretsDir, "service-token"), "wrong-token");
    expect(await client.listTools()).toEqual({ tools: [] });
    expect(warn).toHaveBeenCalledWith(
      "custom_mcp_upstream_failed",
      expect.objectContaining({ status: 401, reason: "refused", operation: "list_tools" })
    );
    writeFileSync(join(secretsDir, "service-token"), credential);
    expect((await client.listTools()).tools).toHaveLength(1);
    // A configured user the service does not act for is refused with the
    // SDK's 403 insufficient_scope challenge; that verdict stands.
    grants.set("wrong", ["glass_goals:another-user:write"]);
    const wrong = await connect("wrong", { userId: "another-user" }, { warn } as unknown as Logger);
    expect(await wrong.listTools()).toEqual({ tools: [] });
    expect(await wrong.callTool({ name: "write_goal" })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "custom MCP upstream refused" }],
    });
    expect(warn).toHaveBeenCalledWith(
      "custom_mcp_upstream_failed",
      expect.objectContaining({ status: 403, reason: "refused", tool: "write_goal" })
    );
    expect(mutations).toBe(0);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private rejection");
  });

  it("cancels a hung tool call on downstream close without stopping the service", async () => {
    mode = "hang";
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");
    const pending = client.callTool({ name: "read_goal" }).catch(() => undefined);
    await vi.waitFor(() => expect(toolCalls()).toHaveLength(1));
    await client.close();
    await pending;
    await vi.waitFor(() => expect(aborted).toBeGreaterThan(0));
    expect(service.listening).toBe(true);
  });

  it("applies the request deadline to a hung call and caller cancellation to a hung probe", async () => {
    mode = "hang";
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const client = await connect("reader");
    const pending = client.callTool({ name: "read_goal" });
    await vi.waitFor(() => expect(toolCalls()).toHaveLength(1));
    deadline.abort();
    expect(await pending).toMatchObject({ content: [{ text: "custom MCP upstream timed out" }] });
    vi.restoreAllMocks();
    // The version probe ignores the request signal; cancellation reaches it
    // through the transport.
    mode = "hang-discover";
    const cancelled = new AbortController();
    const second = client
      .callTool({ name: "read_goal" }, undefined, { signal: cancelled.signal })
      .catch(() => undefined);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    cancelled.abort();
    await second;
    await vi.waitFor(() => expect(aborted).toBe(2));
    // A signal already aborted when the call arrives sends nothing at all.
    const count = calls.length;
    const settled = new AbortController();
    settled.abort();
    await client
      .callTool({ name: "read_goal" }, undefined, { signal: settled.signal })
      .catch(() => undefined);
    expect(calls).toHaveLength(count);
  });

  it("bounds the request body before it is sent", async () => {
    grants.set("writer", ["glass_goals:configured-user:write"]);
    const warn = vi.fn();
    const client = await connect("writer", {}, { warn } as unknown as Logger);
    for (const name of ["read_goal", "write_goal"]) {
      expect(
        await client.callTool({ name, arguments: { large: "x".repeat(1024 * 1024) } })
      ).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "custom MCP upstream request too large" }],
      });
    }
    expect(toolCalls()).toEqual([]);
    expect(mutations).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "custom_mcp_upstream_failed",
      expect.objectContaining({ reason: "request too large", tool: "write_goal" })
    );
  });

  it("warns once on write-scoped listing for unserved and unclassified tools, and deduplicates across actors", async () => {
    upstreamToolsByScope = () => ["a", "b"];
    grants.set("writer1", ["glass_goals:configured-user:write"]);
    grants.set("writer2", ["glass_goals:configured-user:write"]);
    const warn = vi.fn();
    const writer1 = await connect("writer1", { readTools: ["a"], writeTools: ["c"] }, {
      warn,
    } as unknown as Logger);
    await writer1.listTools();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "custom_mcp_classification_drift",
      expect.objectContaining({
        capability: "glass_goals",
        scope: "write",
        missing: ["c"],
        unclassified: ["b"],
      })
    );

    const writer2 = await connect("writer2", { readTools: ["a"], writeTools: ["c"] }, {
      warn,
    } as unknown as Logger);
    await writer2.listTools();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns on read-scoped listing about unclassified tools without reporting missing write tools", async () => {
    upstreamToolsByScope = () => ["a", "b"];
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const warn = vi.fn();
    const reader = await connect("reader", { readTools: ["a"], writeTools: ["c"] }, {
      warn,
    } as unknown as Logger);
    await reader.listTools();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "custom_mcp_classification_drift",
      expect.objectContaining({
        capability: "glass_goals",
        scope: "read",
        missing: [],
        unclassified: ["b"],
      })
    );
  });

  it("emits a fresh warning when the upstream tool listing changes between calls", async () => {
    let currentTools = ["a", "b"];
    upstreamToolsByScope = () => currentTools;
    grants.set("writer", ["glass_goals:configured-user:write"]);
    const warn = vi.fn();
    const writer = await connect("writer", { readTools: ["a"], writeTools: ["c"] }, {
      warn,
    } as unknown as Logger);
    await writer.listTools();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith(
      "custom_mcp_classification_drift",
      expect.objectContaining({
        capability: "glass_goals",
        scope: "write",
        missing: ["c"],
        unclassified: ["b"],
      })
    );

    currentTools = ["a", "d"];
    await writer.listTools();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      "custom_mcp_classification_drift",
      expect.objectContaining({
        capability: "glass_goals",
        scope: "write",
        missing: ["c"],
        unclassified: ["d"],
      })
    );
  });

  it("logs nothing when configuration fully matches the upstream listing", async () => {
    upstreamToolsByScope = () => ["read_goal", "write_goal"];
    grants.set("writer", ["glass_goals:configured-user:write"]);
    const warn = vi.fn();
    const writer = await connect(
      "writer",
      { readTools: ["read_goal"], writeTools: ["write_goal"] },
      { warn } as unknown as Logger
    );
    await writer.listTools();
    expect(warn).not.toHaveBeenCalledWith("custom_mcp_classification_drift", expect.anything());
  });
});

describe("configured MCP service through the mesh grant boundary", () => {
  it("accepts only the configured grant shape, serves a follower-hosted grantee, and leaves the service running on revoke", async () => {
    const actors = new InMemoryActorRepository();
    const grantStore = new InMemoryCapabilityGrantStore();
    const servers = buildGrantableServers({
      customMcpServers: { glass_goals: config },
      customMcpSecretsDir: secretsDir,
      activeCapabilitiesForActor: (actorId: string) => mesh.activeCapabilitiesFor(actorId),
      // Only the custom factory is exercised; the built-ins are never built.
    } as unknown as GrantableServerDeps);
    const mcpHttp = new McpHttpServer({ servers: {} });
    const mesh: ActorMesh = new ActorMesh({
      actors,
      rootId: "admin",
      capabilityGrants: grantStore,
      grantableCapabilities: new Set(servers.keys()),
      customMcpUserIds: new Map([["glass_goals", config.userId]]),
      onCapabilityRevoked: (actorId, capability) =>
        handleCapabilityRevoked(
          actorId,
          capability,
          () => mesh.activeCapabilitiesFor(actorId),
          servers,
          mcpHttp
        ),
      now: () => "2026-01-01T00:00:00Z",
      createActor: (ctx) => ({
        id: ctx.record.id,
        requestRun: () => {},
        markUnkillable: () => {},
        close: () => {},
        preemptForResponsive: () => ({ preempted: false }),
        isRunning: false,
      }),
    });
    for (const [id, parentId] of [
      ["admin", null],
      ["reader", "admin"],
    ] as const) {
      actors.upsert({
        id,
        charter: id,
        parentId,
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
      });
    }
    grantStore.grant({
      actorId: "admin",
      capability: CAPABILITY_ADMIN_CAPABILITY,
      grantedBy: "test",
      grantedAt: "2026-01-01T00:00:00Z",
    });

    for (const malformed of [
      "glass_goals",
      "glass_goals:configured-user",
      "glass_goals:another-user:read",
      "glass_goals:configured-user:admin",
      "glass_goals:configured-user:read:extra",
    ]) {
      expect(() => mesh.grantCapability("reader", malformed, "admin")).toThrow(
        /glass_goals:configured-user:read or glass_goals:configured-user:write/
      );
    }
    expect(mesh.activeCapabilitiesFor("reader")).toEqual([]);
    mesh.grantCapability("reader", "glass_goals:configured-user:read", "admin");

    await mcpHttp.start();
    const token = randomBytes(32).toString("hex");
    const hub = new FollowerHub(token);
    const origin = await hub.listen("127.0.0.1", 0);
    const tool = new Client({ name: "follower-actor", version: "0.0.0" });
    try {
      const registered = await fetch(`${origin}/register`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          id: "mac",
          platform: "darwin",
          pid: 123,
          generation: "mac-process-one",
          protocolVersion: INSTANCE_PROTOCOL_VERSION,
        }),
      });
      expect(registered.status).toBe(200);
      hub.createHost("mac", "reader");
      const [spec] = hub.toolUrls(
        "mac",
        "reader",
        mountGrantedServers("reader", mesh.activeCapabilitiesFor("reader"), servers, mcpHttp)
      );
      if (!spec) throw new Error("no proxied spec");
      expect(spec.name).toBe("glass_goals");
      expect(spec.url.startsWith(`${origin}/mcp/`)).toBe(true);

      await tool.connect(new StreamableHTTPClientTransport(new URL(spec.url)));
      expect((await tool.listTools()).tools.map((t) => t.name)).toEqual(["read_goal"]);
      const before = await call(tool, "read_goal");
      expect(service.listening).toBe(true);

      await mesh.revokeCapability("reader", "glass_goals:configured-user:read", "admin");
      expect(service.listening).toBe(true);
      grants.set("other", ["glass_goals:configured-user:read"]);
      expect((await call(await connect("other"), "read_goal")).contextId).toBe(before.contextId);
      expect(
        mountGrantedServers("reader", mesh.activeCapabilitiesFor("reader"), servers, mcpHttp)
      ).toEqual([]);
    } finally {
      await tool.close();
      await hub.close();
      await mcpHttp.close();
    }
  });
});
