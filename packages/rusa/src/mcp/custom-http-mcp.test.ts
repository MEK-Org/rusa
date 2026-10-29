// @vitest-environment node
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActorMesh } from "../actor/actor-mesh.js";
import { CAPABILITY_ADMIN_CAPABILITY } from "../actor/administrative-capabilities.js";
import { InMemoryCapabilityGrantStore } from "../actor/capability-grants.js";
import type { CustomMcpServerConfig } from "../config/types.js";
import type { Logger } from "../observability/logger.js";
import { FollowerHub } from "../remote-instances/follower-hub.js";
import { INSTANCE_PROTOCOL_VERSION } from "../remote-instances/protocol.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import { createCustomHttpMcpServer } from "./custom-http-mcp.js";
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
let mode:
  | "normal"
  | "hang"
  | "hold-response"
  | "drop-write-response"
  | "tool-error"
  | "bad-json"
  | "large"
  | "error";
let calls: Array<{ method: string | undefined; path: string; scope: string | undefined }>;
let aborted: number;
let mutations: number;
let heldResponses: Array<() => void>;
const grants = new Map<string, string[]>();
const connected: Client[] = [];
const credential = "synthetic-service-token";

// One independently listening service owns this synthetic graph for the whole
// test. No MCP session or caller can create, release or select its identity.
async function startService(): Promise<void> {
  const contextId = randomBytes(8).toString("hex");
  let visits = 0;
  service = http.createServer((req, res) => {
    res.on("close", () => {
      if (!res.writableEnded) aborted++;
    });
    const scope = req.headers["rusa-mcp-scope"] as string | undefined;
    calls.push({ method: req.method, path: req.url ?? "", scope });
    if (
      req.headers.authorization !== `Bearer ${credential}` ||
      req.headers["rusa-mcp-user-id"] !== "configured-user" ||
      !["read", "write"].includes(scope ?? "")
    ) {
      res.writeHead(403).end("private rejection detail");
      return;
    }
    if (mode === "hang") return;
    if (mode === "error") {
      res.writeHead(500).end(credential);
      return;
    }
    if (mode === "bad-json") {
      res.end("not JSON");
      return;
    }
    if (mode === "large") {
      res.end("x".repeat(16 * 1024 * 1024 + 1));
      return;
    }
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname === "/v1/tools" && req.method === "GET") {
      res.end(
        JSON.stringify({
          tools: ["read_goal", "write_goal", "unclassified"].map((name) => ({
            name,
            inputSchema: { type: "object" },
          })),
        })
      );
      return;
    }
    const name = decodeURIComponent(url.pathname.slice("/v1/tools/".length));
    if (
      !(
        (name === "read_goal" && req.method === "GET") ||
        (name === "write_goal" && req.method === "POST" && scope === "write")
      )
    ) {
      res.writeHead(403).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const args = JSON.parse(
        req.method === "GET" ? (url.searchParams.get("arguments") ?? "{}") : body
      );
      if (req.method === "POST") mutations++;
      if (mode === "drop-write-response" && req.method === "POST") {
        req.socket.destroy();
        return;
      }
      if (mode === "tool-error") {
        res.end(
          JSON.stringify({ isError: true, content: [{ type: "text", text: "No such goal" }] })
        );
        return;
      }
      const response = JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              contextId,
              visits: ++visits,
              userId: req.headers["rusa-mcp-user-id"],
              scope,
              args,
              actorId: req.headers["rusa-mcp-actor-id"] ?? null,
            }),
          },
        ],
      });
      const send = () => res.end(response);
      if (mode === "hold-response") heldResponses.push(send);
      else send();
    });
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
  await startService();
});

afterEach(async () => {
  await Promise.all(connected.splice(0).map((client) => client.close()));
  service.closeAllConnections();
  await new Promise<void>((resolve) => service.close(() => resolve()));
  grants.clear();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("configured host HTTP JSON service", () => {
  it("filters discovery and uses GET reads / POST writes with fixed identity and independent scopes", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    grants.set("writer", ["glass_goals:configured-user:write"]);
    const reader = await connect("reader");
    const writer = await connect("writer");
    expect((await reader.listTools()).tools.map((t) => t.name)).toEqual(["read_goal"]);
    expect((await writer.listTools()).tools.map((t) => t.name)).toEqual([
      "read_goal",
      "write_goal",
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
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "POST", "GET"]);
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
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("does not retry a committed write whose response connection is lost", async () => {
    grants.set("writer", ["glass_goals:configured-user:write"]);
    const client = await connect("writer");
    mode = "drop-write-response";
    expect(await client.callTool({ name: "write_goal" })).toMatchObject({
      isError: true,
      content: [{ text: "custom MCP upstream unavailable" }],
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
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
    expect(JSON.stringify(warn.mock.calls)).not.toContain(credential);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private rejection");
  });

  it("refuses invalid upstream identity/authentication and observes host token rotation", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");
    writeFileSync(join(secretsDir, "service-token"), "wrong-token");
    expect(await client.listTools()).toEqual({ tools: [] });
    writeFileSync(join(secretsDir, "service-token"), credential);
    expect((await client.listTools()).tools).toHaveLength(1);
    grants.set("wrong", ["glass_goals:another-user:write"]);
    expect(await (await connect("wrong", { userId: "another-user" })).listTools()).toEqual({
      tools: [],
    });
  });

  it("cancels hung requests on downstream close without stopping the service", async () => {
    mode = "hang";
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");
    const pending = client.callTool({ name: "read_goal" }).catch(() => undefined);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await client.close();
    await pending;
    await vi.waitFor(() => expect(aborted).toBeGreaterThan(0));
    expect(service.listening).toBe(true);
  });

  it("applies the request deadline and caller cancellation", async () => {
    mode = "hang";
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const client = await connect("reader");
    const pending = client.callTool({ name: "read_goal" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    deadline.abort();
    expect(await pending).toMatchObject({ content: [{ text: "custom MCP upstream timed out" }] });
    vi.restoreAllMocks();
    const cancelled = new AbortController();
    const second = client
      .callTool({ name: "read_goal" }, undefined, { signal: cancelled.signal })
      .catch(() => undefined);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    cancelled.abort();
    await second;
    await vi.waitFor(() => expect(aborted).toBe(2));
  });

  it("bounds arguments before opening a service request", async () => {
    grants.set("writer", ["glass_goals:configured-user:write"]);
    const client = await connect("writer");
    expect(
      await client.callTool({ name: "read_goal", arguments: { large: "x".repeat(8192) } })
    ).toMatchObject({ isError: true });
    expect(
      await client.callTool({ name: "write_goal", arguments: { large: "x".repeat(1024 * 1024) } })
    ).toMatchObject({ isError: true });
    expect(calls).toEqual([]);
  });
});

describe("configured HTTP service through the mesh grant boundary", () => {
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
