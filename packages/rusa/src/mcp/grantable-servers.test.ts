import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { InMemoryHostJobStore } from "../actor/host-job-store.js";
import { FakeChatClient } from "../chat/fake.js";
import { createSelectedInboxEntriesAccessor } from "../commands/start.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import type { InboxEntry } from "../repositories/inbox-repository.js";
import type { DistillerState } from "../understanding/distiller-cursor.js";
import {
  buildGrantableServers,
  type GrantableServerDeps,
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
    downloadFile: async () => Buffer.alloc(0),
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
  // host-plane job runner. Adding anything further means updating this
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
    ]);
  });

  it("registers the host-maintenance servers only when their deps are wired (#549)", () => {
    const updateDepsFor = vi.fn<(selfId: string) => UpdateToolDeps>(() => ({
      plan: { branch: "master", drainTimeoutMs: 1 },
      deps: {} as UpdateToolDeps["deps"],
      hasCapability: () => true,
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
      "update",
      "pnpm-hardlinks",
    ]);
    // The update factory is invoked with the grantee's unspoofable id so the
    // drainer can self-exclude the caller rather than a fixed root id.
    servers.get("update")?.("0b2c3d4e-steward", []);
    expect(updateDepsFor).toHaveBeenCalledWith("0b2c3d4e-steward");
    expect(() => servers.get("pnpm-hardlinks")?.("0b2c3d4e-steward", [])).not.toThrow();
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
      mountGrantedServers("actor-1", ["understanding-write", "host-jobs"], servers, mcpHttp).map(
        (spec) => spec.name
      )
    ).toEqual(["understanding-write", "host-jobs"]);
    expect(mountedFactories.has("actor-1:distiller")).toBe(false);

    // Authorized: the grant mounts the distiller server, and the read is on it.
    expect(mountGrantedServers("actor-1", ["distiller"], servers, mcpHttp)).toEqual([
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
        ["chat-write:spaces/A", "chat-write:spaces/B:thread"],
        factories,
        mcpHttp
      )
    ).toEqual([{ name: "chat-write", url: "http://mcp/actor-1:chat-write" }]);
    mountedFactories.get("actor-1:chat-write")?.();
    expect(createdWith).toHaveBeenLastCalledWith("actor-1", ["spaces/A", "spaces/B:thread"]);

    mountGrantedServers(
      "actor-1",
      ["chat-write:spaces/A", "chat-write:spaces/B:thread", "chat-write:spaces/C"],
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
      ["calendar-read:legacy@example.com", "calendar-read:account:a@example.com"],
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
      downloadAttachment: async () => Buffer.alloc(0),
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
      downloadAttachment: async () => Buffer.alloc(0),
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
