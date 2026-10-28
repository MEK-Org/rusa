import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorMesh } from "../actor/actor-mesh.js";
import { CAPABILITY_ADMIN_CAPABILITY } from "../actor/administrative-capabilities.js";
import { InMemoryCapabilityGrantStore } from "../actor/capability-grants.js";
import type { CustomMcpServerConfig } from "../config/types.js";
import type { Logger } from "../observability/logger.js";
import { FollowerHub } from "../remote-instances/follower-hub.js";
import { INSTANCE_PROTOCOL_VERSION } from "../remote-instances/protocol.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import { createCustomStdioMcpServer } from "./custom-stdio-mcp.js";
import {
  buildGrantableServers,
  type GrantableServerDeps,
  handleCapabilityRevoked,
  mountGrantedServers,
} from "./grantable-servers.js";
import { McpHttpServer } from "./http-server.js";

const fixture = join(process.cwd(), "src/mcp/fixtures/custom-stdio-server.mjs");

const config: CustomMcpServerConfig = {
  command: process.execPath,
  args: [fixture],
  userId: "configured-user",
  readTools: ["read_goal"],
  writeTools: ["write_goal"],
};

const grants = new Map<string, string[]>();
const connected: Client[] = [];

async function connect(
  actorId: string,
  overrides: Partial<CustomMcpServerConfig> = {},
  logger?: Logger
): Promise<Client> {
  const proxy = createCustomStdioMcpServer({
    actorId,
    server: { capability: "glass_goals", config: { ...config, ...overrides } },
    activeCapabilities: (id) => grants.get(id) ?? [],
    ...(logger ? { logger } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  connected.push(client);
  return client;
}

interface LaunchContext {
  userId: string;
  scope: string;
  actorId: string | null;
  pid: number;
}

async function call(client: Client, name: string): Promise<LaunchContext> {
  const result = (await client.callTool({ name })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? "null") as LaunchContext;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(connected.splice(0).map((client) => client.close()));
  grants.clear();
});

describe("configured host-side stdio MCP proxy", () => {
  it("filters discovery, fixes the upstream graph identity, and never passes an actor identity", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["read_goal"]);
    expect(await call(client, "read_goal")).toMatchObject({
      userId: "configured-user",
      scope: "read",
      actorId: null,
    });
    await expect(client.callTool({ name: "write_goal" })).resolves.toMatchObject({ isError: true });
  });

  it("fails closed for wrong-user and ungranted actors", async () => {
    grants.set("wrong", ["glass_goals:another-user:write"]);
    const wrongUser = await connect("wrong");
    await expect(wrongUser.listTools()).resolves.toMatchObject({ tools: [] });

    const ungranted = await connect("ungranted");
    await expect(ungranted.listTools()).resolves.toMatchObject({ tools: [] });
  });

  it("checks the live grant again for an already established session", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["read_goal"]);

    grants.set("reader", []);
    await expect(client.callTool({ name: "read_goal" })).resolves.toMatchObject({ isError: true });
  });

  it("restarts its private upstream when a live grant changes scope", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");
    const read = await call(client, "read_goal");
    expect(read.scope).toBe("read");

    grants.set("reader", ["glass_goals:configured-user:write"]);
    const write = await call(client, "write_goal");
    expect(write.scope).toBe("write");
    expect(write.pid).not.toBe(read.pid);
    await vi.waitFor(() => expect(alive(read.pid)).toBe(false));

    grants.set("reader", ["glass_goals:configured-user:read"]);
    expect((await call(client, "read_goal")).scope).toBe("read");
  });

  it("keeps separate actor sessions in separate upstream scope contexts", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    grants.set("writer", ["glass_goals:configured-user:write"]);
    const reader = await connect("reader");
    const writer = await connect("writer");

    const first = await call(reader, "read_goal");
    expect(first.scope).toBe("read");
    expect((await call(writer, "write_goal")).scope).toBe("write");
    expect(await call(reader, "read_goal")).toEqual(first);
  });

  it("shares one child between concurrent first calls on a cold session", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader");

    const [first, second] = await Promise.all([
      call(client, "read_goal"),
      call(client, "read_goal"),
    ]);
    expect(second.pid).toBe(first.pid);
  });

  it("relaunches after its child exits instead of reusing the dead client", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const client = await connect("reader", { readTools: ["read_goal", "exit_now"] });
    const before = await call(client, "read_goal");

    await expect(client.callTool({ name: "exit_now" })).resolves.toMatchObject({ isError: true });
    await vi.waitFor(() => expect(alive(before.pid)).toBe(false));

    const after = await call(client, "read_goal");
    expect(after.pid).not.toBe(before.pid);
  });

  it("logs why a granted actor sees no tools when the upstream cannot start", async () => {
    grants.set("reader", ["glass_goals:configured-user:read"]);
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const client = await connect(
      "reader",
      { command: join(process.cwd(), "src/mcp/fixtures/missing-mcp-server") },
      logger
    );

    await expect(client.listTools()).resolves.toEqual({ tools: [] });
    expect(warn).toHaveBeenCalledWith(
      "custom_mcp_upstream_failed",
      expect.objectContaining({ actorId: "reader", capability: "glass_goals" })
    );
    expect(await client.callTool({ name: "read_goal" })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "custom MCP upstream unavailable" }],
    });
  });
});

describe("configured stdio MCP through the mesh grant boundary", () => {
  it("accepts only the configured grant shape, serves a follower-hosted grantee, and closes the child on revoke", async () => {
    const actors = new InMemoryActorRepository();
    const grantStore = new InMemoryCapabilityGrantStore();
    const servers = buildGrantableServers({
      customMcpServers: { glass_goals: config },
      activeCapabilitiesForActor: (actorId) => mesh.activeCapabilitiesFor(actorId),
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
      const { pid } = await call(tool, "read_goal");
      expect(alive(pid)).toBe(true);

      await mesh.revokeCapability("reader", "glass_goals:configured-user:read", "admin");
      await vi.waitFor(() => expect(alive(pid)).toBe(false));
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
