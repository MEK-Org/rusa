import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { InMemoryHostJobStore } from "../actor/host-job-store.js";
import type { DistillerState } from "../understanding/distiller-cursor.js";
import {
  buildGrantableServers,
  type GrantableServerDeps,
  handleCapabilityRevoked,
  mountGrantedServers,
} from "./grantable-servers.js";

let distillerState: DistillerState = {
  lastDistilled: null,
  consecutiveFailures: 0,
};

const STUB_DEPS: GrantableServerDeps = {
  gmailClient: { sendEmail: async () => ({ id: "message-1" }) },
  onEmailSend: () => {},
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

  it("registers chat-read and chat-write when chatClient is present and remounts chat-read on revocation", async () => {
    const fakeChatClient = {
      listSpaces: async () => ({ spaces: [] }),
      listMessages: async () => ({ messages: [] }),
      getMessage: async () => ({ name: "spaces/A/messages/M1" }),
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
    expect([...serversWithChat.keys()]).toContain("chat-read");
    expect([...serversWithChat.keys()]).toContain("chat-write");

    const removed: string[] = [];
    const mounted: string[] = [];
    const chatReadFactory = serversWithChat.get("chat-read");
    if (!chatReadFactory) throw new Error("chat-read factory missing");
    serversWithChat.set("chat-read", (selfId, params) => {
      return chatReadFactory(selfId, params);
    });

    await handleCapabilityRevoked(
      "actor-1",
      "chat-read:spaces/B",
      () => ["chat-read:spaces/A"],
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

    expect(removed).toEqual(["actor-1:chat-read"]);
    expect(mounted).toEqual(["actor-1:chat-read"]);
  });

  it("preserves wildcard * for chat-read and chat-write capability grants", () => {
    const fakeChatClient = {
      listSpaces: async () => ({ spaces: [] }),
      listMessages: async () => ({ messages: [] }),
      getMessage: async () => ({ name: "spaces/A/messages/M1" }),
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
    const chatReadFactory = serversWithChat.get("chat-read");
    const chatWriteFactory = serversWithChat.get("chat-write");
    if (!chatReadFactory || !chatWriteFactory) {
      throw new Error("expected chat-read and chat-write factories");
    }

    // Calling factory with ["*"] should not throw and configure wildcard access
    const readServer = chatReadFactory("actor-1", ["*"]);
    const writeServer = chatWriteFactory("actor-1", ["*"]);
    expect(readServer).toBeDefined();
    expect(writeServer).toBeDefined();
  });
});
