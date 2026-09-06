import { Agent, request } from "node:http";
import type { Socket } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeScheduledMessagePayload } from "../actor/os-scheduler.js";
import { FakeChatClient } from "../chat/fake.js";
import type { IssueClient } from "../gitops/issue-client.js";
import { createChatWriteMcpServer } from "./chat-mcp.js";
import { type GrantableServerFactory, handleCapabilityRevoked } from "./grantable-servers.js";
import { McpHttpServer } from "./http-server.js";
import { createTrackerMcpServer } from "./tracker-mcp.js";

// Records `addLabel` rather than `postComment`: tracker.post_comment no longer
// reaches the backend at all , so a label is the write this test can use
// to prove the HTTP transport routes a call through to the IssueClient.
function fakeIssueClient(): { client: IssueClient; labels: string[] } {
  const labels: string[] = [];
  const client: IssueClient = {
    createIssue: async () => ({ number: 1, htmlUrl: "https://example.test/issues/1" }),
    createPullRequest: async () => ({ number: 1, htmlUrl: "https://example.test/pr/1" }),
    getOpenPullRequestsByAuthor: async () => [],
    getOpenPullRequests: async () => [],
    listIssues: async () => [],
    getPullRequestDetails: async (_repo, prNumber) => ({
      number: prNumber,
      title: "t",
      body: "b",
      htmlUrl: "u",
      headRef: "h",
      headSha: "head-sha",
      state: "open",
    }),
    getPullRequestChecksStatus: async () => ({
      state: "success",
      headSha: "head-sha",
      blocking: [],
    }),
    getIssue: async (_repo, issueNumber) => ({
      number: issueNumber,
      title: "t",
      body: "b",
      state: "open",
      author: "operator",
    }),
    listIssueComments: async () => [],
    postComment: async () => {},
    updateIssueBody: async () => {},
    addLabel: async (_repo, issueNumber, label) => {
      labels.push(`#${issueNumber}: ${label}`);
    },
    removeLabel: async () => {},
    closeIssue: async () => {},
    reopenIssue: async () => {},
    mergePullRequest: async () => "sha",
    createPullRequestReview: async () => undefined,
    createPrReviewComment: async () => ({
      id: 1,
      htmlUrl: "https://example.test/pr/1#discussion_r1",
      path: "a.ts",
      line: 1,
      body: "b",
    }),
    addReaction: async () => {},
    addCommentReaction: async () => {},
    getPrReviewComments: async () => [],
    getPullRequestReview: async () => null,
    getParentIssueNumber: async () => null,
    getRootIssueNumber: async () => null,
    hasSubIssues: async () => false,
    addSubIssue: async () => {},
    removeSubIssue: async () => {},
  };
  return { client, labels };
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}

function getWithAgent(url: string, agent: Agent): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent }, (res) => {
      const socket = res.socket;
      res.resume();
      res.once("end", () => {
        if (socket) resolve(socket);
        else reject(new Error("response did not have a socket"));
      });
    });
    req.once("error", reject);
    req.end();
  });
}

describe("McpHttpServer", () => {
  let http: McpHttpServer;
  let labels: string[];
  let chat: FakeChatClient;

  beforeEach(async () => {
    const issue = fakeIssueClient();
    labels = issue.labels;
    chat = new FakeChatClient();
    http = new McpHttpServer({
      servers: {
        tracker: () => createTrackerMcpServer("test", issue.client),
        chat: () => createChatWriteMcpServer("test", chat, { allowedSpaces: ["*"] }),
      },
    });
    await http.start();
  });

  afterEach(async () => {
    await http.close();
  });

  async function connect(name: string): Promise<Client> {
    const url = http.urls().find((u) => u.name === name);
    if (!url) throw new Error(`no url for ${name}`);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url.url)));
    return client;
  }

  it("exposes a loopback url per hosted server, keyed by an unguessable token (not the name)", () => {
    const urls = http.urls();
    expect(urls.map((u) => u.name).sort()).toEqual(["chat", "tracker"]);
    const tokens = new Set<string>();
    for (const u of urls) {
      // The path segment is a random UUID token, NOT the server name — so the URL
      // can't be reconstructed from a known name ("the URL is the capability").
      const m = u.url.match(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/([^/]+)$/);
      expect(m).not.toBeNull();
      const token = m?.[1] ?? "";
      expect(token).toMatch(/^[0-9a-f-]{36}$/);
      expect(token).not.toBe(u.name);
      tokens.add(token);
    }
    // Distinct servers get distinct tokens.
    expect(tokens.size).toBe(2);
  });

  it("404s a request that guesses the server NAME as the path (cap-URL: name is not the token)", async () => {
    // The security property: knowing a server's name (e.g. the well-known "root")
    // is not enough to reach it — only its unguessable token resolves.
    const base = http.urls()[0].url.replace(/\/mcp\/[^/]+$/, "");
    for (const name of ["tracker", "chat", "root"]) {
      const resp = await fetch(`${base}/mcp/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
      });
      expect(resp.status).toBe(404);
    }
  });

  it("serves the tracker tools over HTTP and routes a call to the backend", async () => {
    const client = await connect("tracker");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("add_label");

    const res = (await client.callTool({
      name: "add_label",
      arguments: { repo: "o/r", issueNumber: 7, label: "from mcp over http" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(labels).toEqual(["#7: from mcp over http"]);
    await client.close();
  });

  it("serves the chat tools over HTTP independently", async () => {
    const client = await connect("chat");
    const res = (await client.callTool({
      name: "send_message",
      arguments: { spaceName: "spaces/A", text: "hi over http" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(chat.sent).toEqual([
      { spaceName: "spaces/A", text: "hi over http", threadName: undefined },
    ]);
    expect(JSON.parse(textOf(res)).name).toContain("spaces/A/messages/");
    await client.close();
  });

  it("404s an unknown server path", async () => {
    const url = http.urls()[0].url.replace(/\/mcp\/[^/]+$/, "/mcp/nope");
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(resp.status).toBe(404);
  });

  it("keeps an idle MCP HTTP connection beyond Node's former five-second default and closes it", async () => {
    const agent = new Agent({ keepAlive: true });
    try {
      const url = http.urls()[0].url;
      const firstSocket = await getWithAgent(url, agent);

      await new Promise((resolve) => setTimeout(resolve, 5_100));

      const secondSocket = await getWithAgent(url, agent);
      expect(secondSocket).toBe(firstSocket);

      const closed = new Promise<void>((resolve) => firstSocket.once("close", () => resolve()));
      await http.close();
      await closed;
    } finally {
      agent.destroy();
    }
  }, 15_000);

  it("hosts a server added after start, then stops routing once removed", async () => {
    const url = http.addServer("tracker2", () =>
      createTrackerMcpServer("tracker2-actor", fakeIssueClient().client)
    );
    // Token path, not the name.
    expect(url).toMatch(/\/mcp\/[0-9a-f-]{36}$/);
    expect(url).not.toMatch(/\/mcp\/tracker2$/);

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("post_comment");
    await client.close();

    await http.removeServer("tracker2");
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(resp.status).toBe(404);
  });

  it("tears down live sessions when a capability is revoked (Refs ISSUE_NUM, ISSUE_NUM)", async () => {
    // This tests the actual handleCapabilityRevoked logic used by the mesh
    const grantableServers = new Map<string, GrantableServerFactory>();
    grantableServers.set("chat-write", (_id, allowedSpaces) =>
      createChatWriteMcpServer("test", chat, { allowedSpaces })
    );

    // Initial mount with two spaces
    const actorId = "test-actor";
    const initialSpaces = ["spaces/A", "spaces/B"];
    const url = http.addServer(`${actorId}:chat-write`, () => {
      const factory = grantableServers.get("chat-write");
      if (!factory) throw new Error("Missing factory");
      return factory(actorId, initialSpaces);
    });

    // Connect a client and verify it can write to space B.
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const res = (await client.callTool({
      name: "send_message",
      arguments: { spaceName: "spaces/B", text: "hi" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();

    // Revoke space B: fire the actual capability revocation logic
    const activeCaps = ["chat-write:spaces/A"]; // B is gone
    await handleCapabilityRevoked(
      actorId,
      "chat-write:spaces/B",
      () => activeCaps,
      grantableServers,
      http
    );

    // The live client transport MUST be closed by the revocation.
    // With the fix (removeServer), the transport is closed and this throws.
    await expect(
      client.callTool({
        name: "send_message",
        arguments: { spaceName: "spaces/B", text: "hi again" },
      })
    ).rejects.toThrow();

    // Find the newly mounted token url
    const newUrl = http.urls().find((u) => u.name === `${actorId}:chat-write`)?.url;
    if (!newUrl) throw new Error("new URL not found");
    expect(newUrl).not.toEqual(url); // Token should have changed

    // Reconnect and verify the narrowed scope
    const newClient = new Client({ name: "test2", version: "0.0.0" });
    await newClient.connect(new StreamableHTTPClientTransport(new URL(newUrl)));

    // Space A works.
    const resA = (await newClient.callTool({
      name: "send_message",
      arguments: { spaceName: "spaces/A", text: "hi A" },
    })) as CallToolResult;
    expect(resA.isError).toBeFalsy();

    // Space B is denied.
    const resB = (await newClient.callTool({
      name: "send_message",
      arguments: { spaceName: "spaces/B", text: "hi B" },
    })) as CallToolResult;
    expect(resB.isError).toBeTruthy();
    expect(textOf(resB)).toContain("access denied");

    await newClient.close();
  });

  it("serializes concurrent capability revocations to prevent restoring a revoked grant", async () => {
    const grantableServers = new Map<string, GrantableServerFactory>();
    grantableServers.set("chat-write", (_id, allowedSpaces) =>
      createChatWriteMcpServer("test", chat, { allowedSpaces })
    );

    const actorId = "test-actor-race";

    // Create a delayed mock for removeServer
    let resolveFirstRemove!: () => void;
    const firstRemoveDeferred = new Promise<void>((resolve) => {
      resolveFirstRemove = resolve;
    });

    const originalRemoveServer = http.removeServer.bind(http);
    let removeCalls = 0;
    const mockHttp = {
      removeServer: async (name: string) => {
        removeCalls++;
        if (removeCalls === 1) {
          // Block the FIRST removeServer until we manually unblock it
          await firstRemoveDeferred;
        }
        await originalRemoveServer(name);
      },
      addServer: http.addServer.bind(http),
    };

    // We start with active grants: A, B, C
    let currentActive = ["chat-write:spaces/A", "chat-write:spaces/B", "chat-write:spaces/C"];

    // 1. Revoke B (update state synchronously like actor-mesh does)
    currentActive = currentActive.filter((c) => c !== "chat-write:spaces/B");
    const revokeBPromise = handleCapabilityRevoked(
      actorId,
      "chat-write:spaces/B",
      () => currentActive,
      grantableServers,
      mockHttp
    );

    // Give it a tick to enter removeServer
    await new Promise((r) => setTimeout(r, 10));

    // 2. Revoke C concurrently (update state synchronously)
    currentActive = currentActive.filter((c) => c !== "chat-write:spaces/C");
    const revokeCPromise = handleCapabilityRevoked(
      actorId,
      "chat-write:spaces/C",
      () => currentActive,
      grantableServers,
      mockHttp
    );

    // 3. Unblock the first removeServer
    resolveFirstRemove?.();

    await Promise.all([revokeBPromise, revokeCPromise]);

    // Now verify the finally mounted server. It should ONLY have spaces/A.
    const newUrl = http.urls().find((u) => u.name === `${actorId}:chat-write`)?.url;
    if (!newUrl) throw new Error("new URL not found");

    const newClient = new Client({ name: "test3", version: "0.0.0" });
    await newClient.connect(new StreamableHTTPClientTransport(new URL(newUrl)));

    // A works
    const resA = (await newClient.callTool({
      name: "send_message",
      arguments: { spaceName: "spaces/A", text: "hi A" },
    })) as CallToolResult;
    expect(resA.isError).toBeFalsy();

    // C must fail! If the bug was present (restoring C), this would succeed.
    const resC = (await newClient.callTool({
      name: "send_message",
      arguments: { spaceName: "spaces/C", text: "hi C" },
    })) as CallToolResult;
    expect(resC.isError).toBeTruthy();
    expect(textOf(resC)).toContain("access denied");

    await newClient.close();
  });

  describe("POST /wake (cron-driven wake endpoint, ISSUE_NUM 1c)", () => {
    const TOKEN = "secret-wake-token";
    const wakeUrl = () => `${http.urls()[0].url.replace(/\/mcp\/[^/]+$/, "")}/wake`;
    const post = (init: RequestInit) => fetch(wakeUrl(), { method: "POST", ...init });

    it("404s when no wake handler is wired (no info leak)", async () => {
      // beforeEach wires none — /wake is indistinguishable from an unknown path.
      const resp = await post({ headers: { authorization: `Bearer ${TOKEN}` } });
      expect(resp.status).toBe(404);
    });

    it("delivers a wake to a live actor (200) and passes actorId + reason through", async () => {
      const calls: { actorId: string; reason: string }[] = [];
      http.setWakeHandler({
        token: TOKEN,
        deliver: (actorId, reason) => {
          calls.push({ actorId, reason });
          return true; // live
        },
      });
      const resp = await post({
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ actorId: "73e0b00f", reason: "nightly distill" }).toString(),
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ delivered: true });
      expect(calls).toEqual([{ actorId: "73e0b00f", reason: "nightly distill" }]);
    });

    it("delivers a wake with responsive priority when requested", async () => {
      const calls: { actorId: string; reason: string; priority?: "normal" | "responsive" }[] = [];
      http.setWakeHandler({
        token: TOKEN,
        deliver: (actorId, reason, priority) => {
          calls.push({ actorId, reason, priority });
          return true; // live
        },
      });
      const resp = await post({
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          actorId: "73e0b00f",
          reason: "bless cut",
          priority: "responsive",
        }).toString(),
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ delivered: true });
      expect(calls).toEqual([{ actorId: "73e0b00f", reason: "bless cut", priority: "responsive" }]);
    });

    it("404s with delivered:false when the actor isn't live", async () => {
      http.setWakeHandler({ token: TOKEN, deliver: () => false });
      const resp = await post({
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ actorId: "ghost", reason: "x" }).toString(),
      });
      expect(resp.status).toBe(404);
      expect(await resp.json()).toEqual({ delivered: false });
    });

    it("401s a missing or wrong bearer token without delivering", async () => {
      let delivered = false;
      http.setWakeHandler({
        token: TOKEN,
        deliver: () => {
          delivered = true;
          return true;
        },
      });
      const noAuth = await post({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "actorId=x",
      });
      expect(noAuth.status).toBe(401);
      const wrong = await post({
        headers: {
          authorization: "Bearer nope",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "actorId=x",
      });
      expect(wrong.status).toBe(401);
      expect(delivered).toBe(false); // never reached the backend
    });

    it("400s when actorId is missing", async () => {
      http.setWakeHandler({ token: TOKEN, deliver: () => true });
      const resp = await post({
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "reason=no-actor",
      });
      expect(resp.status).toBe(400);
    });

    it("405s a non-POST method", async () => {
      http.setWakeHandler({ token: TOKEN, deliver: () => true });
      const resp = await fetch(wakeUrl(), {
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(resp.status).toBe(405);
    });

    it("413s a body that exceeds the size cap", async () => {
      let delivered = false;
      http.setWakeHandler({
        token: TOKEN,
        deliver: () => {
          delivered = true;
          return true;
        },
      });
      const resp = await post({
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `actorId=x&reason=${"A".repeat(9000)}`, // > 8 KB cap
      });
      expect(resp.status).toBe(413);
      expect(delivered).toBe(false); // rejected before reaching the backend
    });
  });

  describe("POST /wake-obligation", () => {
    const TOKEN = "secret-wake-token";
    const wakeUrl = () => `${http.urls()[0].url.replace(/\/mcp\/[^/]+$/, "")}/wake-obligation`;
    const post = (init: RequestInit) => fetch(wakeUrl(), { method: "POST", ...init });

    it("404s when no wake handler is wired (no info leak)", async () => {
      const resp = await post({ body: "id=123", headers: { authorization: `Bearer ${TOKEN}` } });
      expect(resp.status).toBe(404);
    });

    it("delivers a wake and passes id through", async () => {
      let deliveredId = "";
      http.setWakeObligationHandler({
        token: TOKEN,
        deliver: (id) => {
          deliveredId = id;
        },
      });

      const resp = await post({ body: "id=123", headers: { authorization: `Bearer ${TOKEN}` } });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: true });
      expect(deliveredId).toBe("123");
    });

    it("401s on bad token", async () => {
      http.setWakeObligationHandler({ token: TOKEN, deliver: () => {} });
      const resp = await post({ body: "id=123", headers: { authorization: "Bearer bad" } });
      expect(resp.status).toBe(401);
    });
  });

  describe("POST /wake-message", () => {
    const TOKEN = "secret-wake-token";
    const wakeUrl = () => `${http.urls()[0].url.replace(/\/mcp\/[^/]+$/, "")}/wake-message`;
    const post = (init: RequestInit) => fetch(wakeUrl(), { method: "POST", ...init });

    it("404s when no wake handler is wired (no info leak)", async () => {
      const resp = await post({ body: "id=123", headers: { authorization: `Bearer ${TOKEN}` } });
      expect(resp.status).toBe(404);
    });

    it("delivers the complete versioned message payload", async () => {
      const message = {
        id: "message-123",
        toId: "recipient",
        fromId: "sender",
        body: "hello & goodbye\nnext line",
        deliverAt: "2026-09-04T12:34:56.000Z",
        sessionId: "session-1",
      };
      let delivered: unknown;
      http.setWakeMessageHandler({
        token: TOKEN,
        deliver: (scheduled) => {
          delivered = scheduled;
        },
      });

      const resp = await post({
        body: new URLSearchParams({ payload: encodeScheduledMessagePayload(message) }),
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: true });
      expect(delivered).toEqual(message);
    });

    it("rejects a malformed or unknown-version message payload", async () => {
      http.setWakeMessageHandler({ token: TOKEN, deliver: () => {} });
      const resp = await post({
        body: "payload=not-valid-base64-json",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(resp.status).toBe(400);
    });

    it("401s on bad token", async () => {
      http.setWakeMessageHandler({ token: TOKEN, deliver: () => {} });
      const resp = await post({ body: "id=123", headers: { authorization: "Bearer bad" } });
      expect(resp.status).toBe(401);
    });
  });

  describe("POST /host-jobs/exit", () => {
    const TOKEN = "secret-wake-token";
    const exitUrl = () => `${http.urls()[0].url.replace(/\/mcp\/[^/]+$/, "")}/host-jobs/exit`;

    it("passes jobId/unitName/actorId/result/exitStatus through to the backend", async () => {
      const calls: unknown[] = [];
      http.setHostJobExitHandler({
        token: TOKEN,
        onExit: (payload) => calls.push(payload),
      });

      const resp = await fetch(exitUrl(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          jobId: "job-id-1",
          unitName: "job-handle-a-12345678",
          actorId: "actor-a",
          result: "success",
          exitStatus: "0",
        }).toString(),
      });

      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: true });
      expect(calls).toEqual([
        {
          jobId: "job-id-1",
          unitName: "job-handle-a-12345678",
          actorId: "actor-a",
          result: "success",
          exitStatus: "0",
        },
      ]);
    });

    it("accepts unitName-only legacy exit payloads while rejecting empty attribution", async () => {
      const calls: unknown[] = [];
      http.setHostJobExitHandler({
        token: TOKEN,
        onExit: (payload) => calls.push(payload),
      });

      const legacy = await fetch(exitUrl(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ unitName: "job-handle-a-12345678", actorId: "actor-a" }),
      });
      expect(legacy.status).toBe(200);
      expect(calls).toEqual([
        { unitName: "job-handle-a-12345678", actorId: "actor-a", result: "", exitStatus: "" },
      ]);

      const empty = await fetch(exitUrl(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ actorId: "actor-a" }),
      });
      expect(empty.status).toBe(400);
    });
  });
});
