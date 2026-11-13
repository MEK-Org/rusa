import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { withDefaultActorCapabilities } from "../actor/administrative-capabilities.js";
import { InMemoryCapabilityGrantStore } from "../actor/capability-grants.js";
import { InMemoryHostJobStore } from "../actor/host-job-store.js";
import { FakeChatClient } from "../chat/fake.js";
import type { ChatSpace } from "../chat/types.js";
import { createSelectedInboxEntriesAccessor } from "../commands/start.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import type { InboxEntry } from "../repositories/inbox-repository.js";
import { SlackClient } from "../slack/slack-client.js";
import type { DistillerState } from "../understanding/distiller-cursor.js";
import {
  buildGrantableServers,
  type GrantableServerDeps,
  type GrantableServerFactory,
  handleCapabilityRevoked,
  mountGrantedServers,
} from "./grantable-servers.js";
import type { UpdateToolDeps } from "./update-mcp.js";

let distillerState: DistillerState = {
  lastDistilled: null,
  consecutiveFailures: 0,
};

const STUB_DEPS: GrantableServerDeps = {
  gmailClient: { sendEmail: async () => ({ id: "message-1" }) },
  onEmailSend: () => {},
  getRunSelectionForActor: () => undefined,
  driveClients: {
    listChildren: async () => [],
    getFileMetadata: async () => ({ id: "", name: "", mimeType: "" }),
    downloadFileStream: async () => new Response(),
    exportDoc: async () => Buffer.alloc(0),
  },
  calendarClients: {
    legacyClient: {
      listCalendars: async () => ({ items: [] }),
      listEvents: async () => ({ items: [] }),
      getEvent: async () => ({}),
      createEvent: async () => ({}),
      updateEvent: async () => ({}),
      deleteEvent: async () => {},
    },
    forAccount: () => ({
      listCalendars: async () => ({ items: [] }),
      listEvents: async () => ({ items: [] }),
      getEvent: async () => ({}),
      createEvent: async () => ({}),
      updateEvent: async () => ({}),
      deleteEvent: async () => {},
    }),
  },
  distiller: {
    store: {
      getState: () => ({ ...distillerState }),
      setState: (state) => {
        distillerState = { ...state };
      },
      seedIfUnset: (iso) => {
        if (distillerState.lastDistilled !== null) return false;
        distillerState = { ...distillerState, lastDistilled: iso };
        return true;
      },
      countSubstantiveEvents: () => 0,
      resolveSeed: async () => ({
        seed: "2026-06-10T00:00:00.000Z",
        reason: "glass-goals-latest-op",
      }),
      unsyncedCount: () => 0,
      listEvents: () => ({ events: [], hasMore: false, nextCursor: null }),
    },
  },
  understanding: { getClient: async () => null },
  hostJobs: {
    store: new InMemoryHostJobStore(),
    handleForId: (id) => `handle-${id}`,
    mcHome: "/tmp/host-jobs-mcp-test",
    recordEvent: () => {},
  },
  e2eInstance: {
    manager: {
      up: () => ({ state: "up", port: 8083 }),
      resume: () => ({ state: "up", port: 8083 }),
      down: () => ({ state: "down", port: 8083 }),
      status: () => ({ state: "down", port: 8083 }),
    },
  },
};

describe("grantable capabilities allow-list ", () => {
  // This test LOCKS the production grantable registry so every addition is a
  // conscious, reviewed decision. It was the security gate for phase 1a → 1b:
  // the registry had to stay EMPTY until claude-worker FS isolation (ISSUE_NUM/ISSUE_NUM)
  // landed, because the capability-grant system rests on unspoofable actor
  // identity — cap-URL closes the network path, but an unsandboxed claude worker
  // could otherwise harvest another actor's endpoint token from shared /tmp or
  // tamper ~/.rusa, defeating that identity.
  //
  // ISSUE_NUM (claude FS isolation) is MERGED, so phase 1b legitimately registers
  // `understanding-write` (the glass-goals write tools). ISSUE_NUM adds `distiller`,
  // another IU-steward-only capability. ISSUE_NUM adds `host-jobs`, a per-actor
  // host-plane job runner. #690 adds `quota-manual`, the leader-hosted write of
  // one manual quota reading. Adding anything further means updating this
  // assertion — the deliberate checkpoint.
  it("registers exactly the production grantable capabilities", () => {
    expect([...buildGrantableServers(STUB_DEPS).keys()]).toEqual([
      "distiller",
      "understanding-write",
      "host-jobs",
      "e2e-instance",
      "email-send",
      "calendar-read",
      "calendar-write",
      "drive-read",
      "quota-manual",
    ]);
  });

  it("registers the host-maintenance servers only when their deps are wired (#549)", () => {
    const updateDepsFor = vi.fn<(selfId: string) => UpdateToolDeps>(() => ({
      plan: { branch: "master", drainTimeoutMs: 1 },
      deps: {} as UpdateToolDeps["deps"],
      hasCapability: () => true,
      maintenanceShutdown: {} as UpdateToolDeps["maintenanceShutdown"],
    }));
    const servers = buildGrantableServers({
      ...STUB_DEPS,
      hostMaintenance: {
        updateToolDepsFor: updateDepsFor,
        pnpmHardlinks: {
          hasCapability: () => true,
          workersDir: "/tmp/grantable-servers-test-workers",
          actors: new InMemoryActorRepository(),
          runningThreadIds: () => [],
        },
      },
    });
    expect([...servers.keys()]).toEqual([
      "distiller",
      "understanding-write",
      "host-jobs",
      "e2e-instance",
      "email-send",
      "calendar-read",
      "calendar-write",
      "drive-read",
      "quota-manual",
      "update",
      "pnpm-hardlinks",
    ]);
    // The update factory is invoked with the grantee's unspoofable id so the
    // drainer can self-exclude the caller rather than a fixed root id.
    servers.get("update")?.("0b2c3d4e-steward", []);
    expect(updateDepsFor).toHaveBeenCalledWith("0b2c3d4e-steward");
    expect(() => servers.get("pnpm-hardlinks")?.("0b2c3d4e-steward", [])).not.toThrow();
  });

  it("mounts an operator-configured custom server only through its parameterized grant", async () => {
    const servers = buildGrantableServers({
      ...STUB_DEPS,
      customMcpServers: {
        glass_goals: {
          socketPath: "/tmp/synthetic-goals.sock",
          tokenFile: "synthetic-goals-token",
          userId: "configured-user",
          readTools: ["read_goal"],
          writeTools: ["write_goal"],
        },
      },
      activeCapabilitiesForActor: () => [],
    });
    const mountedFactories = new Map<string, () => McpServer>();
    const mcpHttp = {
      addServer: (name: string, factory: () => McpServer) => {
        mountedFactories.set(name, factory);
        return `http://mcp/${name}`;
      },
      removeServer: async (name: string) => {
        mountedFactories.delete(name);
      },
    };

    expect(mountGrantedServers("reader", () => [], servers, mcpHttp)).toEqual([]);
    // A row that no longer matches the configured user or scope shape never
    // reaches the provider's MCP map.
    for (const stale of [
      "glass_goals",
      "glass_goals:another-user:write",
      "glass_goals:configured-user:bogus",
    ]) {
      expect(mountGrantedServers("reader", () => [stale], servers, mcpHttp)).toEqual([]);
    }
    expect(mountedFactories.size).toBe(0);
    expect(
      mountGrantedServers("reader", () => ["glass_goals:configured-user:read"], servers, mcpHttp)
    ).toEqual([{ name: "glass_goals", url: "http://mcp/reader:glass_goals" }]);
    expect(mountedFactories.has("reader:glass_goals")).toBe(true);

    await handleCapabilityRevoked(
      "reader",
      "glass_goals:configured-user:read",
      () => ["glass_goals:another-user:write"],
      servers,
      mcpHttp
    );
    expect(mountedFactories.has("reader:glass_goals")).toBe(false);
  });

  it("refuses a custom server that would take a built-in or reserved name", () => {
    const custom = {
      socketPath: "/tmp/synthetic-goals.sock",
      tokenFile: "synthetic-goals-token",
      userId: "configured-user",
      readTools: ["read_goal"],
      writeTools: [],
    };
    expect(() =>
      buildGrantableServers({ ...STUB_DEPS, customMcpServers: { distiller: custom } })
    ).toThrow(/must not reuse a built-in MCP server or capability name/);
    expect(() =>
      buildGrantableServers({
        ...STUB_DEPS,
        customMcpServers: { secret: custom },
        reservedCapabilityNames: new Set(["secret"]),
      })
    ).toThrow(/customMcpServers\.secret must not reuse/);
  });

  it("serves the bounded mesh_events read only behind a `distiller` grant (#537)", async () => {
    // The read has no principal of its own: it exists on an actor's endpoint set
    // exactly when a `distiller` grant row does, and leaves with it. The
    // dashboard's `/api/mesh/events` is a separate, Firebase-session route.
    const servers = buildGrantableServers(STUB_DEPS);
    const mountedFactories = new Map<string, () => McpServer>();
    const mcpHttp = {
      addServer: (name: string, factory: () => McpServer) => {
        mountedFactories.set(name, factory);
        return `http://mcp/${name}`;
      },
      removeServer: async (name: string) => {
        mountedFactories.delete(name);
      },
    };

    // Denied: an actor holding other grants, but not `distiller`, has no
    // endpoint that could carry the tool at all.
    expect(
      mountGrantedServers(
        "actor-1",
        () => ["understanding-write", "host-jobs"],
        servers,
        mcpHttp
      ).map((spec) => spec.name)
    ).toEqual(["understanding-write", "host-jobs"]);
    expect(mountedFactories.has("actor-1:distiller")).toBe(false);

    // Authorized: the grant mounts the distiller server, and the read is on it.
    expect(mountGrantedServers("actor-1", () => ["distiller"], servers, mcpHttp)).toEqual([
      { name: "distiller", url: "http://mcp/actor-1:distiller" },
    ]);
    const server = mountedFactories.get("actor-1:distiller")?.();
    if (!server) throw new Error("distiller server was not mounted");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      "distill_read_events"
    );
    const result = await client.callTool({
      name: "distill_read_events",
      arguments: { since: "2026-09-16T03:12:24.897Z", until: "2026-09-17T05:10:00.574Z" },
    });
    expect(result.isError).toBeFalsy();

    // Revoked: the endpoint goes away with the grant.
    await handleCapabilityRevoked("actor-1", "distiller", () => [], servers, mcpHttp);
    expect(mountedFactories.has("actor-1:distiller")).toBe(false);
  });

  it("aggregates parameterized grants when mounting and replaces the live factory", () => {
    const createdWith = vi.fn<(actorId: string, params: string[]) => McpServer>(
      () => ({}) as McpServer
    );
    const factories = new Map([["chat-write", createdWith]]);
    const mountedFactories = new Map<string, () => McpServer>();
    const mcpHttp = {
      addServer: (name: string, factory: () => McpServer) => {
        mountedFactories.set(name, factory);
        return `http://mcp/${name}`;
      },
    };

    expect(
      mountGrantedServers(
        "actor-1",
        () => ["chat-write:spaces/A", "chat-write:spaces/B:thread"],
        factories,
        mcpHttp
      )
    ).toEqual([{ name: "chat-write", url: "http://mcp/actor-1:chat-write" }]);
    mountedFactories.get("actor-1:chat-write")?.();
    expect(createdWith).toHaveBeenLastCalledWith("actor-1", ["spaces/A", "spaces/B:thread"]);

    mountGrantedServers(
      "actor-1",
      () => ["chat-write:spaces/A", "chat-write:spaces/B:thread", "chat-write:spaces/C"],
      factories,
      mcpHttp
    );
    mountedFactories.get("actor-1:chat-write")?.();
    expect(createdWith).toHaveBeenLastCalledWith("actor-1", [
      "spaces/A",
      "spaces/B:thread",
      "spaces/C",
    ]);
  });

  it("immediately remounts calendar-read with the narrowed calendar list", async () => {
    const servers = buildGrantableServers(STUB_DEPS);
    const removed: string[] = [];
    const mounted: string[] = [];
    const mountedParams: string[][] = [];
    const calendarFactory = servers.get("calendar-read");
    if (!calendarFactory) throw new Error("calendar-read factory missing");
    servers.set("calendar-read", (selfId, params) => {
      mountedParams.push(params);
      return calendarFactory(selfId, params);
    });
    await handleCapabilityRevoked(
      "actor-1",
      "calendar-read:removed@example.com",
      () => ["calendar-read:kept@example.com"],
      servers,
      {
        removeServer: async (name) => {
          removed.push(name);
        },
        addServer: (name, factory) => {
          factory();
          mounted.push(name);
          return "http://example.invalid/mcp/token";
        },
      }
    );

    expect(removed).toEqual(["actor-1:calendar-read"]);
    expect(mounted).toEqual(["actor-1:calendar-read"]);
    expect(mountedParams).toEqual([["kept@example.com"]]);
  });

  it("registers email-send and immediately remounts it with narrowed recipients", async () => {
    const servers = buildGrantableServers(STUB_DEPS);
    const removed: string[] = [];
    const mountedParams: string[][] = [];
    const emailFactory = servers.get("email-send");
    if (!emailFactory) throw new Error("email-send factory missing");
    servers.set("email-send", (selfId, params) => {
      mountedParams.push(params);
      return emailFactory(selfId, params);
    });
    await handleCapabilityRevoked(
      "actor-1",
      "email-send:removed@example.com",
      () => ["email-send:kept@example.com"],
      servers,
      {
        removeServer: async (name) => {
          removed.push(name);
        },
        addServer: (_name, factory) => {
          factory();
          return "http://example.invalid/mcp/token";
        },
      }
    );

    expect(removed).toEqual(["actor-1:email-send"]);
    expect(mountedParams).toEqual([["kept@example.com"]]);
  });

  it("passes calendar IDs and account emails through the same grantable registry factory", () => {
    const servers = buildGrantableServers(STUB_DEPS);
    const mountedFactories = new Map<string, () => McpServer>();
    mountGrantedServers(
      "actor-1",
      () => ["calendar-read:legacy@example.com", "calendar-read:account:a@example.com"],
      servers,
      {
        addServer: (name, factory) => {
          mountedFactories.set(name, factory);
          return `http://mcp/${name}`;
        },
      }
    );

    expect([...mountedFactories.keys()]).toEqual(["actor-1:calendar-read"]);
    expect(() => mountedFactories.get("actor-1:calendar-read")?.()).not.toThrow();
  });

  it("immediately remounts drive-read with the narrowed folder list", async () => {
    const servers = buildGrantableServers(STUB_DEPS);
    const removed: string[] = [];
    const mounted: string[] = [];
    const mountedParams: string[][] = [];
    const driveFactory = servers.get("drive-read");
    if (!driveFactory) throw new Error("drive-read factory missing");
    servers.set("drive-read", (selfId, params) => {
      mountedParams.push(params);
      return driveFactory(selfId, params);
    });
    await handleCapabilityRevoked(
      "actor-1",
      "drive-read:removed-folder",
      () => ["drive-read:kept-folder"],
      servers,
      {
        removeServer: async (name) => {
          removed.push(name);
        },
        addServer: (name, factory) => {
          factory();
          mounted.push(name);
          return "http://example.invalid/mcp/token";
        },
      }
    );

    expect(removed).toEqual(["actor-1:drive-read"]);
    expect(mounted).toEqual(["actor-1:drive-read"]);
    expect(mountedParams).toEqual([["kept-folder"]]);
  });

  it("registers chat-write when chatClient is present, excludes chat-read, and remounts chat-write on revocation", async () => {
    const fakeChatClient = {
      listSpaces: async () => ({ spaces: [] }),
      listMessages: async () => ({ messages: [] }),
      getMessage: async () => ({ name: "spaces/A/messages/M1" }),
      getSpace: async () => ({ name: "spaces/A" }),
      getAttachment: async () => ({ name: "spaces/A/attachments/ATT1" }),
      downloadAttachmentStream: async () => ({
        resp: new Response(),
        name: "attachment.bin",
        contentType: "application/octet-stream",
      }),
      uploadAttachment: async () => ({ attachmentDataRef: { resourceName: "ref" } }),
      send: async () => ({ name: "spaces/A/messages/M1" }),
      react: async () => {},
      getSpaceType: async () => "SPACE",
      listSpaceMembers: async () => ({ members: [] }),
    };
    const serversWithChat = buildGrantableServers({
      ...STUB_DEPS,
      chatClient: fakeChatClient,
    });
    expect([...serversWithChat.keys()]).not.toContain("chat-read");
    expect([...serversWithChat.keys()]).toContain("chat-write");

    const removed: string[] = [];
    const mounted: string[] = [];
    const chatWriteFactory = serversWithChat.get("chat-write");
    if (!chatWriteFactory) throw new Error("chat-write factory missing");
    serversWithChat.set("chat-write", (selfId, params) => {
      return chatWriteFactory(selfId, params);
    });

    await handleCapabilityRevoked(
      "actor-1",
      "chat-write:spaces/B",
      () => ["chat-write:spaces/A"],
      serversWithChat,
      {
        removeServer: async (name) => {
          removed.push(name);
        },
        addServer: (name, factory) => {
          factory();
          mounted.push(name);
          return "http://example.invalid/mcp/token";
        },
      }
    );

    expect(removed).toEqual(["actor-1:chat-write"]);
    expect(mounted).toEqual(["actor-1:chat-write"]);

    // Revoking chat-read is a no-op that never removes or remounts the default endpoint
    const readRemoved: string[] = [];
    const readMounted: string[] = [];
    await handleCapabilityRevoked("actor-1", "chat-read:spaces/B", () => [], serversWithChat, {
      removeServer: async (name) => {
        readRemoved.push(name);
      },
      addServer: (name, factory) => {
        factory();
        readMounted.push(name);
        return "http://example.invalid/mcp/token";
      },
    });
    expect(readRemoved).toEqual([]);
    expect(readMounted).toEqual([]);
  });

  it("preserves wildcard * for chat-write capability grants", () => {
    const fakeChatClient = {
      listSpaces: async () => ({ spaces: [] }),
      listMessages: async () => ({ messages: [] }),
      getMessage: async () => ({ name: "spaces/A/messages/M1" }),
      getSpace: async () => ({ name: "spaces/A" }),
      getAttachment: async () => ({ name: "spaces/A/attachments/ATT1" }),
      downloadAttachmentStream: async () => ({
        resp: new Response(),
        name: "attachment.bin",
        contentType: "application/octet-stream",
      }),
      uploadAttachment: async () => ({ attachmentDataRef: { resourceName: "ref" } }),
      send: async () => ({ name: "spaces/A/messages/M1" }),
      react: async () => {},
      getSpaceType: async () => "SPACE",
      listSpaceMembers: async () => ({ members: [] }),
    };
    const serversWithChat = buildGrantableServers({
      ...STUB_DEPS,
      chatClient: fakeChatClient,
    });
    const chatWriteFactory = serversWithChat.get("chat-write");
    if (!chatWriteFactory) {
      throw new Error("expected chat-write factory");
    }

    // Calling factory with ["*"] should not throw and configure wildcard access
    const writeServer = chatWriteFactory("actor-1", ["*"]);
    expect(writeServer).toBeDefined();
  });

  it("wires selectedInboxEntriesForActor to chat-write capability", async () => {
    const fakeChatClient = new FakeChatClient();
    const topLevelEntry: InboxEntry = {
      id: "e1",
      actorId: "actor-1",
      source: "chat_space:spaces/A",
      deliveredAt: new Date(),
      seenAt: null,
      handledAt: null,
      handledNote: null,
      payload: {
        type: "gchat.message",
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M1",
        threadName: "spaces/A/threads/M1",
      },
    };
    const serversWithChat = buildGrantableServers({
      ...STUB_DEPS,
      chatClient: fakeChatClient,
      selectedInboxEntriesForActor: (actorId) => (actorId === "actor-1" ? [topLevelEntry] : []),
    });
    const chatWriteFactory = serversWithChat.get("chat-write");
    if (!chatWriteFactory) throw new Error("expected chat-write factory");
    const writeServer = chatWriteFactory("actor-1", ["spaces/A"]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await writeServer.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    await client.callTool({
      name: "send_message",
      arguments: { spaceName: "spaces/A", text: "hi", threadName: "spaces/A/threads/M1" },
    });
    expect(fakeChatClient.sent[0]?.threadName).toBeUndefined();
  });

  it("wires selectedInboxEntriesForActor to slack-write reply placement", async () => {
    const slackClient = new SlackClient("xoxb-synthetic");
    const send = vi.fn(async () => "9.9");
    slackClient.send = send;
    const threadReply: InboxEntry = {
      id: "e-slack",
      actorId: "actor-1",
      source: "slack:channels/C1",
      deliveredAt: new Date(),
      seenAt: null,
      handledAt: null,
      handledNote: null,
      payload: { type: "slack.message", channel: "C1", ts: "2.000001", threadTs: "1.000001" },
    };
    const servers = buildGrantableServers({
      ...STUB_DEPS,
      slackClient,
      selectedInboxEntriesForActor: (actorId) => (actorId === "actor-1" ? [threadReply] : []),
    });
    const slackWriteFactory = servers.get("slack-write");
    if (!slackWriteFactory) throw new Error("expected slack-write factory");
    for (const actorId of ["actor-1", "actor-2"]) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await slackWriteFactory(actorId, ["C1"]).connect(serverTransport);
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(clientTransport);
      await client.callTool({ name: "send_message", arguments: { channel: "C1", text: "hi" } });
    }
    // Text carries #1035's footer; this test pins placement only.
    expect(send.mock.calls).toEqual([
      ["C1", expect.stringMatching(/^hi\n/), "1.000001"],
      ["C1", expect.stringMatching(/^hi\n/), undefined],
    ]);
  });

  it("integrates createSelectedInboxEntriesAccessor with grantable chat-write and routes replies", async () => {
    const fakeChatClient = new FakeChatClient();
    const topLevelEntry: InboxEntry = {
      id: "entry-top",
      actorId: "worker-1",
      source: "chat_space:spaces/A",
      deliveredAt: new Date(),
      seenAt: null,
      handledAt: null,
      handledNote: null,
      payload: {
        type: "gchat.message",
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M1",
        threadName: "spaces/A/threads/M1",
      },
    };
    const threadEntry: InboxEntry = {
      id: "entry-thread",
      actorId: "worker-1",
      source: "chat_space:spaces/A",
      deliveredAt: new Date(),
      seenAt: null,
      handledAt: null,
      handledNote: null,
      payload: {
        type: "gchat.message",
        spaceName: "spaces/A",
        messageName: "spaces/A/messages/M2",
        threadName: "spaces/A/threads/T1",
      },
    };

    let selectedIds: string[] = ["entry-top"];
    const fakeMesh = {
      selectedInboxEntries: (actorId: string) => (actorId === "worker-1" ? selectedIds : []),
    };
    const storeMap = new Map<string, InboxEntry>([
      ["entry-top", topLevelEntry],
      ["entry-thread", threadEntry],
    ]);
    const fakeInboxStore = {
      read: (_actorId: string, id: string) => storeMap.get(id) ?? null,
    };

    const accessor = createSelectedInboxEntriesAccessor(fakeMesh, fakeInboxStore);

    const servers = buildGrantableServers({
      ...STUB_DEPS,
      chatClient: fakeChatClient,
      selectedInboxEntriesForActor: accessor,
    });
    const factory = servers.get("chat-write");
    if (!factory) throw new Error("expected chat-write factory");
    const writeServer = factory("worker-1", ["spaces/A"]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await writeServer.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);

    // 1. With entry-top selected: send with threadName matching head is stripped to top-level
    await client.callTool({
      name: "send_message",
      arguments: {
        spaceName: "spaces/A",
        text: "reply top-level",
        threadName: "spaces/A/threads/M1",
      },
    });
    expect(fakeChatClient.sent[0]?.threadName).toBeUndefined();

    // 2. Switch mesh selection to entry-thread: reply omitting threadName is routed into existing thread
    selectedIds = ["entry-thread"];
    await client.callTool({
      name: "send_message",
      arguments: { spaceName: "spaces/A", text: "reply in thread" },
    });
    expect(fakeChatClient.sent[1]?.threadName).toBe("spaces/A/threads/T1");
  });
});

describe("per-request admission of a granted endpoint (#1289 D1)", () => {
  const factory: GrantableServerFactory = () => ({}) as McpServer;
  const servers = new Map<string, GrantableServerFactory>([
    ["understanding-write", factory],
    ["host-jobs", factory],
  ]);

  function capture() {
    const authorizers = new Map<string, (() => boolean) | undefined>();
    return {
      authorizers,
      addServer: (
        name: string,
        _factory: () => McpServer,
        opts?: { authorize?: () => boolean }
      ) => {
        authorizers.set(name, opts?.authorize);
        return `http://mcp/${name}`;
      },
    };
  }

  it("admits on effective capabilities: role authority without a row, never an ignored row", () => {
    const store = new InMemoryCapabilityGrantStore();
    const capabilities = withDefaultActorCapabilities(store, () => ({
      recipientId: "default",
      capabilities: ["understanding-write"],
      ignoredGrantor: "bootstrap",
    }));
    // A legacy row that confers nothing under the policy.
    store.grant({
      actorId: "default",
      capability: "host-jobs",
      grantedBy: "bootstrap",
      grantedAt: "2026-11-12T00:00:00.000Z",
    });
    const mcpHttp = capture();

    const mounted = mountGrantedServers(
      "default",
      () => capabilities.activeFor("default"),
      servers,
      mcpHttp
    );

    expect(mounted.map((spec) => spec.name)).toEqual(["understanding-write"]);
    expect(store.activeFor("default")).not.toContain("understanding-write");
    expect(mcpHttp.authorizers.get("default:understanding-write")?.()).toBe(true);
    expect(mcpHttp.authorizers.has("default:host-jobs")).toBe(false);
  });

  it("refuses every request once any capability the endpoint was built from is gone", () => {
    let held = ["understanding-write"];
    const mcpHttp = capture();
    mountGrantedServers("actor-1", () => held, servers, mcpHttp);
    const authorize = mcpHttp.authorizers.get("actor-1:understanding-write");
    expect(authorize?.()).toBe(true);
    held = [];
    expect(authorize?.()).toBe(false);
    held = ["understanding-write"];
    expect(authorize?.()).toBe(true);
  });
});

describe("thread-scoped chat-write at the tool boundary (#1311)", () => {
  const T1 = "spaces/A/threads/T1";
  const T2 = "spaces/A/threads/T2";

  function chatEntry(messageName: string, threadName: string): InboxEntry {
    return {
      id: `entry-${messageName}`,
      actorId: "actor-1",
      source: `gchat:${threadName}`,
      deliveredAt: new Date(),
      seenAt: null,
      handledAt: null,
      handledNote: null,
      payload: { type: "gchat.message", spaceName: "spaces/A", messageName, threadName },
    };
  }

  /**
   * Mount chat-write from grant params exactly as a capability grant does.
   * With no `space`, the space's metadata cannot be read: requested-thread
   * permission alone governs placement in every space type (#1316).
   */
  async function mount(params: string[], selected: InboxEntry[] = [], space?: ChatSpace) {
    const chat = new FakeChatClient();
    if (space) chat.spaces.push(space);
    chat.messages.push(
      { name: "spaces/A/messages/R1", thread: { name: T1 } },
      { name: "spaces/A/messages/R2", thread: { name: T2 } }
    );
    const factory = buildGrantableServers({
      ...STUB_DEPS,
      chatClient: chat,
      selectedInboxEntriesForActor: () => selected,
    }).get("chat-write");
    if (!factory) throw new Error("expected chat-write factory");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await factory("actor-1", params).connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { type: string; text?: string }[];
      };
      return { isError: result.isError === true, text: result.content[0]?.text ?? "" };
    };
    return { chat, call };
  }

  const send = (args: Record<string, unknown>) => ({ spaceName: "spaces/A", text: "hi", ...args });
  const inlineAttachment = {
    attachments: [{ filename: "note.txt", contentBase64: Buffer.from("hi").toString("base64") }],
  };

  it("lets a thread writer reply in its thread, and only as a reply", async () => {
    const { chat, call } = await mount([T1]);

    expect((await call("send_message", send({ threadName: T1 }))).isError).toBe(false);
    expect(chat.sent).toEqual([
      expect.objectContaining({
        spaceName: "spaces/A",
        threadName: T1,
        requireExistingThread: true,
      }),
    ]);
  });

  it("refuses top-level, a sibling thread, another space and a mismatched thread", async () => {
    const { chat, call } = await mount([T1]);

    for (const [args, message] of [
      [send({}), /not post top-level/],
      [send({ threadName: T2 }), /thread spaces\/A\/threads\/T2 is not in allowed threads/],
      [send({ spaceName: "spaces/B", threadName: "spaces/B/threads/T1" }), /space spaces\/B/],
      // T1's id under another space must not pass as T1, and vice versa.
      [send({ threadName: "spaces/B/threads/T1" }), /must be a thread of spaceName/],
      [send({ threadName: "threads/T1" }), /must be a thread of spaceName/],
      [send({ threadName: `${T1}/extra` }), /must be a thread of spaceName/],
    ] as const) {
      const result = await call("send_message", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.text).toMatch(message);
    }
    expect(chat.sent).toEqual([]);
  });

  it("checks the thread selected-inbox routing lands in, not the arguments as written", async () => {
    // A selected reply in T1 places an unthreaded send in T1.
    const inT1 = await mount([T1], [chatEntry("spaces/A/messages/R1", T1)]);
    expect((await inT1.call("send_message", send({}))).isError).toBe(false);
    expect(inT1.chat.sent[0]).toMatchObject({ threadName: T1, requireExistingThread: true });

    // A selected reply in a sibling thread places it there, which is refused
    // before any inline attachment uploads.
    const inT2 = await mount([T1], [chatEntry("spaces/A/messages/R2", T2)]);
    const sibling = await inT2.call("send_message", send(inlineAttachment));
    expect(sibling.isError).toBe(true);
    expect(sibling.text).toMatch(/T2 is not in allowed threads/);
    expect(inT2.chat.sent).toEqual([]);
    expect(inT2.chat.uploadedAttachments).toEqual([]);

    // A selected head of T1 routes top-level unless createThread asks for its thread.
    const head = await mount([T1], [chatEntry("spaces/A/messages/T1", T1)]);
    const topLevel = await head.call("send_message", send({ threadName: T1 }));
    expect(topLevel.isError).toBe(true);
    expect(topLevel.text).toMatch(/not post top-level/);
    expect((await head.call("send_message", send({ createThread: true }))).isError).toBe(false);
    expect(head.chat.sent).toEqual([
      expect.objectContaining({ threadName: T1, requireExistingThread: true }),
    ]);
  });

  it.each([
    ["a direct message", { name: "spaces/A", spaceType: "DIRECT_MESSAGE" }],
    ["a group chat", { name: "spaces/A", spaceType: "GROUP_CHAT" }],
    ["a named space", { name: "spaces/A", spaceType: "SPACE" }],
    ["a space whose metadata cannot be read", undefined],
  ] as const)("permits an authorized selected-thread reply in %s", async (_label, space) => {
    const { chat, call } = await mount([T1], [chatEntry("spaces/A/messages/R1", T1)], space);

    expect((await call("send_message", send({}))).isError).toBe(false);
    expect(chat.sent).toEqual([
      expect.objectContaining({
        spaceName: "spaces/A",
        threadName: T1,
        requireExistingThread: true,
      }),
    ]);
  });

  it("scopes reactions to messages in the writer's thread", async () => {
    const { chat, call } = await mount([T1]);

    expect((await call("react", { messageName: "spaces/A/messages/R1" })).isError).toBe(false);
    for (const messageName of [
      "spaces/A/messages/R2",
      "spaces/A/messages/R1/reactions/X",
      "spaces/B/messages/R1",
    ]) {
      expect((await call("react", { messageName })).isError, messageName).toBe(true);
    }
    expect(chat.reactions.map((reaction) => reaction.messageName)).toEqual([
      "spaces/A/messages/R1",
    ]);
  });

  it("lets a thread writer upload into its space to attach a reply there, and nowhere else", async () => {
    const { chat, call } = await mount([T1]);
    const upload = (spaceName: string) =>
      call("upload_attachment", {
        spaceName,
        filename: "note.txt",
        contentBase64: Buffer.from("hi").toString("base64"),
      });

    expect((await upload("spaces/A")).isError).toBe(false);
    expect((await upload("spaces/B")).isError).toBe(true);
    expect(chat.uploadedAttachments.map((upload) => upload.spaceName)).toEqual(["spaces/A"]);
  });

  it("leaves a whole-space writer's placement unchanged, threads included", async () => {
    for (const params of [["spaces/A"], ["A"], ["*"], ["spaces/A", T1]]) {
      const { chat, call } = await mount(params);
      expect((await call("send_message", send({}))).isError, params.join()).toBe(false);
      expect((await call("send_message", send({ threadName: T2 }))).isError).toBe(false);
      expect((await call("react", { messageName: "spaces/A/messages/R2" })).isError).toBe(false);
      expect(chat.sent).toEqual([
        { spaceName: "spaces/A", text: expect.stringMatching(/^hi\n/), threadName: undefined },
        { spaceName: "spaces/A", text: expect.stringMatching(/^hi\n/), threadName: T2 },
      ]);
    }
  });
});
