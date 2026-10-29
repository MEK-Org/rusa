import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
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
import { createCustomMcpServer } from "./custom-mcp.js";
import {
  buildGrantableServers,
  type GrantableServerDeps,
  handleCapabilityRevoked,
  mountGrantedServers,
} from "./grantable-servers.js";
import { McpHttpServer } from "./http-server.js";

const fixture = join(process.cwd(), "src/mcp/fixtures/custom-http-server.mjs");

interface ServiceEvent {
  event: string;
  pid: number;
  port?: number;
  sessionId?: string;
  scope?: string;
  status?: number;
  reason?: string;
}

/** One run of the independently started synthetic service. */
interface Service {
  child: ChildProcess;
  port: number;
  events: ServiceEvent[];
}

interface GraphContext {
  userId: string;
  scope: string;
  sessionId: string;
  renderedAt: number;
  renders: number;
  written: string[];
  pid: number;
}

let dir: string;
let secretsDir: string;
let stateFile: string;
let config: CustomMcpServerConfig;
const grants = new Map<string, string[]>();
const connected: Client[] = [];
const services: Service[] = [];

async function startService(port = 0, user = "configured-user"): Promise<Service> {
  const child = spawn(
    process.execPath,
    [
      fixture,
      "--port",
      String(port),
      "--token-file",
      join(secretsDir, "graph-token"),
      "--user",
      user,
      "--state-file",
      stateFile,
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  const events: ServiceEvent[] = [];
  const listening = new Promise<number>((resolve, reject) => {
    child.once("exit", () => reject(new Error("synthetic service exited before listening")));
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const event = JSON.parse(line) as ServiceEvent;
      events.push(event);
      if (event.event === "listening") resolve(event.port as number);
    });
  });
  const service = { child, port: await listening, events };
  services.push(service);
  return service;
}

async function stopService(service: Service): Promise<void> {
  // A killed child reports its signal rather than an exit code.
  if (service.child.exitCode !== null || service.child.signalCode !== null) return;
  const exited = new Promise((resolve) => service.child.once("exit", resolve));
  service.child.kill();
  await exited;
}

function urlOf(service: Service): string {
  return `http://127.0.0.1:${service.port}/mcp`;
}

async function connect(
  actorId: string,
  overrides: Partial<CustomMcpServerConfig> = {},
  logger?: Logger
): Promise<Client> {
  const proxy = createCustomMcpServer({
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

async function call(
  client: Client,
  name: string,
  args?: Record<string, unknown>
): Promise<GraphContext> {
  const result = (await client.callTool({ name, ...(args ? { arguments: args } : {}) })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? "null") as GraphContext;
}

const opened = (service: Service) =>
  service.events.filter((event) => event.event === "session_opened");
const closedSessions = (service: Service) =>
  service.events.filter((event) => event.event === "session_closed").map((e) => e.sessionId);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rusa-custom-http-mcp-"));
  secretsDir = join(dir, "secrets");
  stateFile = join(dir, "graph-state.json");
  // Created as the host secrets directory would be.
  mkdirSync(secretsDir, { mode: 0o700 });
  writeFileSync(join(secretsDir, "graph-token"), `${randomBytes(32).toString("hex")}\n`, {
    mode: 0o600,
  });
});

afterEach(async () => {
  await Promise.all(connected.splice(0).map((client) => client.close()));
  await Promise.all(services.splice(0).map(stopService));
  grants.clear();
  rmSync(dir, { recursive: true, force: true });
});

async function withService(): Promise<Service> {
  const service = await startService();
  config = {
    url: urlOf(service),
    tokenFile: "graph-token",
    userId: "configured-user",
    readTools: ["read_goal", "slow_read"],
    writeTools: ["write_goal"],
  };
  return service;
}

describe("configured custom MCP over a running local HTTP service", () => {
  it("filters discovery and sends only the fixed user and current scope", async () => {
    const service = await withService();
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");

    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "read_goal",
      "slow_read",
    ]);
    expect(await call(client, "read_goal")).toMatchObject({
      userId: "configured-user",
      scope: "read",
    });
    await expect(
      client.callTool({ name: "write_goal", arguments: { value: "x" } })
    ).resolves.toMatchObject({ isError: true });
    await expect(client.callTool({ name: "unconfigured_tool" })).resolves.toMatchObject({
      isError: true,
    });
    expect(opened(service).map((event) => event.scope)).toEqual(["read"]);
  });

  it("opens no service session for wrong-user and ungranted actors", async () => {
    const service = await withService();
    grants.set("wrong", ["glass_goals:another-user:write"]);
    const wrongUser = await connect("wrong");
    await expect(wrongUser.listTools()).resolves.toEqual({ tools: [] });
    await expect(wrongUser.callTool({ name: "read_goal" })).resolves.toMatchObject({
      isError: true,
    });

    const ungranted = await connect("ungranted");
    await expect(ungranted.listTools()).resolves.toEqual({ tools: [] });
    expect(opened(service)).toEqual([]);
  });

  it("reuses the service's rendered graph across calls, sessions and reconnects", async () => {
    const service = await withService();
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const first = await connect("reader");
    const a = await call(first, "read_goal");
    const b = await call(first, "read_goal");
    expect(b.sessionId).toBe(a.sessionId);

    // A closed client session ends only its own service session.
    await first.close();
    await vi.waitFor(() => expect(closedSessions(service)).toEqual([a.sessionId]));

    const second = await connect("reader");
    const c = await call(second, "read_goal");
    expect(c.sessionId).not.toBe(a.sessionId);
    expect(c).toMatchObject({ pid: a.pid, renderedAt: a.renderedAt, renders: 1 });
    expect(service.events.filter((event) => event.event === "rendered")).toHaveLength(1);
    expect(service.child.exitCode).toBeNull();
  });

  it("rechecks the live grant for an established session", async () => {
    await withService();
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");
    await call(client, "read_goal");

    grants.set("reader", []);
    await expect(client.callTool({ name: "read_goal" })).resolves.toMatchObject({ isError: true });
    await expect(client.listTools()).resolves.toEqual({ tools: [] });
  });

  it("replaces the service session when a live grant changes scope", async () => {
    const service = await withService();
    grants.set("actor", ["glass_goals:configured-user:read"]);
    const client = await connect("actor");
    const read = await call(client, "read_goal");

    grants.set("actor", ["glass_goals:configured-user:write"]);
    const write = await call(client, "write_goal", { value: "first" });
    expect(write).toMatchObject({ scope: "write", written: ["first"], renders: 1 });
    expect(write.sessionId).not.toBe(read.sessionId);
    await vi.waitFor(() => expect(closedSessions(service)).toContain(read.sessionId));

    grants.set("actor", ["glass_goals:configured-user:read"]);
    expect(await call(client, "read_goal")).toMatchObject({ scope: "read", written: ["first"] });
  });

  it("keeps separate actors in separate service sessions and scopes", async () => {
    await withService();
    grants.set("reader", ["glass_goals:configured-user:read"]);
    grants.set("writer", ["glass_goals:configured-user:write"]);
    const reader = await connect("reader");
    const writer = await connect("writer");

    const r = await call(reader, "read_goal");
    const w = await call(writer, "write_goal", { value: "w" });
    expect(r.scope).toBe("read");
    expect(w.scope).toBe("write");
    expect(w.sessionId).not.toBe(r.sessionId);
    // The writer's change is visible to the reader through the shared graph.
    expect(await call(reader, "read_goal")).toMatchObject({
      sessionId: r.sessionId,
      written: ["w"],
    });
  });

  it("forwards cancellation to the service", async () => {
    const service = await withService();
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");
    const { sessionId } = await call(client, "read_goal");

    const abort = new AbortController();
    const slow = client.callTool({ name: "slow_read" }, undefined, { signal: abort.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));
    abort.abort();
    await expect(slow).rejects.toThrow();
    await vi.waitFor(() =>
      expect(service.events).toContainEqual(
        expect.objectContaining({ event: "cancelled", sessionId })
      )
    );
    // The session survives a cancelled call.
    expect((await call(client, "read_goal")).sessionId).toBe(sessionId);
  });

  it("recovers after the service restarts, without leaking its outage to later calls", async () => {
    const first = await withService();
    grants.set("writer", ["glass_goals:configured-user:write"]);
    const warn = vi.fn();
    const client = await connect("writer", {}, { warn } as unknown as Logger);
    const before = await call(client, "write_goal", { value: "kept" });

    // Restarted under the session: the service no longer knows it, and the
    // next call starts a fresh one transparently.
    await stopService(first);
    const second = await startService(first.port);
    const after = await call(client, "read_goal");
    expect(after.pid).toBe(second.child.pid);
    expect(after.sessionId).not.toBe(before.sessionId);
    expect(after.written).toEqual(["kept"]);

    // While it is down, a call fails with a bounded reason and is logged.
    await stopService(second);
    expect(await client.callTool({ name: "read_goal" })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "custom MCP upstream unavailable" }],
    });
    expect(warn).toHaveBeenCalledWith(
      "custom_mcp_upstream_failed",
      expect.objectContaining({ actorId: "writer", capability: "glass_goals" })
    );
    await startService(first.port);
    expect((await call(client, "read_goal")).written).toEqual(["kept"]);
  }, 20_000);

  it("is refused by the service for a wrong token or a user it does not serve", async () => {
    const service = await withService();
    grants.set("reader", ["glass_goals:configured-user:read"]);
    writeFileSync(join(secretsDir, "wrong-token"), "not-the-token\n", { mode: 0o600 });
    const wrongToken = await connect("reader", { tokenFile: "wrong-token" });
    await expect(wrongToken.listTools()).resolves.toEqual({ tools: [] });

    grants.set("other", ["glass_goals:other-user:read"]);
    const otherUser = await connect("other", { userId: "other-user" });
    await expect(otherUser.listTools()).resolves.toEqual({ tools: [] });

    expect(
      service.events.filter((event) => event.event === "rejected").map((e) => e.status)
    ).toEqual(expect.arrayContaining([401, 403]));
    expect(opened(service)).toEqual([]);
  });

  it("never reads a token file outside the secrets directory", async () => {
    const service = await withService();
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader", { tokenFile: "../secrets/graph-token" });
    await expect(client.listTools()).resolves.toEqual({ tools: [] });
    expect(service.events.filter((event) => event.event !== "listening")).toEqual([]);
  });
});

describe("configured HTTP service through the mesh grant boundary", () => {
  it("serves a follower-hosted grantee and ends only its service session on revoke", async () => {
    const service = await withService();
    const actors = new InMemoryActorRepository();
    const grantStore = new InMemoryCapabilityGrantStore();
    const servers = buildGrantableServers({
      customMcpServers: { glass_goals: config },
      secretsDir,
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
    mesh.grantCapability("reader", "glass_goals:configured-user:read", "admin");

    await mcpHttp.start();
    const hubToken = randomBytes(32).toString("hex");
    const hub = new FollowerHub(hubToken);
    const origin = await hub.listen("127.0.0.1", 0);
    const tool = new Client({ name: "follower-actor", version: "0.0.0" });
    try {
      const registered = await fetch(`${origin}/register`, {
        method: "POST",
        headers: { authorization: `Bearer ${hubToken}`, "content-type": "application/json" },
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
      expect(spec.url.startsWith(`${origin}/mcp/`)).toBe(true);
      // The provider-facing endpoint is Rusa's own, never the service's.
      expect(spec.url).not.toContain(String(service.port));

      await tool.connect(new StreamableHTTPClientTransport(new URL(spec.url)));
      expect((await tool.listTools()).tools.map((t) => t.name).sort()).toEqual([
        "read_goal",
        "slow_read",
      ]);
      const { sessionId } = await call(tool, "read_goal");

      await mesh.revokeCapability("reader", "glass_goals:configured-user:read", "admin");
      await vi.waitFor(() => expect(closedSessions(service)).toEqual([sessionId]));
      expect(service.child.exitCode).toBeNull();
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
