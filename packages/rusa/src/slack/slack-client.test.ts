import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readSlackToken, SlackClient } from "./slack-client.js";

describe("Slack token placement", () => {
  it("reads only files directly in the masked RUSA_HOME/secrets directory", () => {
    const home = mkdtempSync(join(tmpdir(), "rusa-slack-token-"));
    const dir = join(home, "secrets");
    mkdirSync(dir, { mode: 0o700 });
    const safe = join(dir, "bot-token");
    const outside = join(home, "bot-token");
    writeFileSync(safe, " xoxb-test \n", { mode: 0o600 });
    writeFileSync(outside, "xoxb-outside", { mode: 0o600 });
    expect(readSlackToken(safe, home)).toBe("xoxb-test");
    expect(() => readSlackToken(outside, home)).toThrow(/directly inside/);
  });
});

describe("SlackClient.listRecentMessages", () => {
  function clientWith(web: Record<string, unknown>): SlackClient {
    const client = new SlackClient("xoxb-test");
    Object.defineProperty(client, "web", { value: web });
    return client;
  }

  it("returns the channel's newest top-level messages oldest first, skipping broadcast replies", async () => {
    const history = vi.fn(async () => ({
      messages: [
        { ts: "4.0", text: "newest", user: "U1" },
        { ts: "3.5", text: "broadcast reply", user: "U2", thread_ts: "1.0" },
        { ts: "3.0", text: "bot", bot_id: "B1" },
        { ts: "2.0", text: "thread parent", user: "U2", thread_ts: "2.0" },
        { ts: "1.0", text: "too old", user: "U1" },
      ],
    }));
    const client = clientWith({ conversations: { history } });
    const messages = await client.listRecentMessages("C1", { limit: 3 });
    expect(history).toHaveBeenCalledWith({ channel: "C1", limit: 9 });
    expect(messages).toEqual([
      { channel: "C1", ts: "2.0", text: "thread parent", user: "U2", threadTs: "2.0" },
      { channel: "C1", ts: "3.0", text: "bot", user: "B1", threadTs: undefined },
      { channel: "C1", ts: "4.0", text: "newest", user: "U1", threadTs: undefined },
    ]);
  });

  it("walks a thread's reply pages to return its tail", async () => {
    const replies = vi.fn(async ({ cursor }: { cursor?: string }) =>
      cursor
        ? { messages: [{ ts: "1.3", text: "c", user: "U1", thread_ts: "1.0" }] }
        : {
            messages: [
              { ts: "1.0", text: "parent", user: "U1", thread_ts: "1.0" },
              { ts: "1.1", text: "a", user: "U2", thread_ts: "1.0" },
              { ts: "1.2", text: "b", user: "U1", thread_ts: "1.0" },
            ],
            response_metadata: { next_cursor: "page-2" },
          }
    );
    const client = clientWith({ conversations: { replies } });
    const messages = await client.listRecentMessages("C1", { threadTs: "1.0", limit: 2 });
    expect(replies).toHaveBeenCalledTimes(2);
    expect(messages.map((m) => m.text)).toEqual(["b", "c"]);
  });
});

describe("SlackClient.react", () => {
  it("invokes web.reactions.add with channel, timestamp, and name", async () => {
    const add = vi.fn(async () => ({ ok: true }));
    const client = new SlackClient("xoxb-test");
    Object.defineProperty(client, "web", { value: { reactions: { add } } });

    await client.react("C123", "1234567890.123456");
    expect(add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1234567890.123456",
      name: "eyes",
    });

    await client.react("C123", "1234567890.123456", "thumbsup");
    expect(add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1234567890.123456",
      name: "thumbsup",
    });
  });
});

describe("SlackClient history pages", () => {
  type Reply = { status?: number; headers?: Record<string, string>; body?: unknown };

  /** A real WebClient over a synthetic Slack API: each request takes the next scripted reply. */
  function slackApi(replies: Reply[]) {
    const requests: { method: string; params: Record<string, string> }[] = [];
    const fetch = vi.fn(async (url: string | URL, init?: { body?: unknown }) => {
      const method = String(url).split("/").pop() ?? "";
      const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
      delete params.token;
      requests.push({ method, params });
      const reply = replies.shift() ?? { body: { ok: true } };
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json", ...reply.headers },
      });
    });
    return { client: new SlackClient("xoxb-synthetic", { fetch }), requests, fetch };
  }

  it("reads one bounded channel page newest first and hands back the cursor", async () => {
    const { client, requests } = slackApi([
      {
        body: {
          ok: true,
          messages: [
            { ts: "1791849700.000200", text: "later", user: "U1" },
            {
              ts: "1791849650.000100",
              text: "thread parent",
              user: "U2",
              thread_ts: "1791849650.000100",
              reply_count: 3,
              latest_reply: "1791849690.000000",
            },
          ],
          has_more: true,
          response_metadata: { next_cursor: "bmV4dA==" },
        },
      },
    ]);
    const page = await client.listHistory("C1", {
      oldest: "1791849600.000000",
      latest: "1791936000.000000",
      limit: 2,
    });
    expect(requests).toEqual([
      {
        method: "conversations.history",
        params: {
          channel: "C1",
          limit: "2",
          oldest: "1791849600.000000",
          latest: "1791936000.000000",
        },
      },
    ]);
    expect(page).toEqual({
      channel: "C1",
      order: "newest_first",
      messages: [
        { channel: "C1", ts: "1791849700.000200", text: "later", user: "U1" },
        {
          channel: "C1",
          ts: "1791849650.000100",
          text: "thread parent",
          user: "U2",
          threadTs: "1791849650.000100",
          replyCount: 3,
          latestReply: "1791849690.000000",
        },
      ],
      hasMore: true,
      nextCursor: "bmV4dA==",
    });
  });

  it("walks a range across pages until Slack stops returning a cursor", async () => {
    const { client, requests } = slackApi([
      {
        body: {
          ok: true,
          messages: [{ ts: "3.0", text: "c" }],
          has_more: true,
          response_metadata: { next_cursor: "page-2" },
        },
      },
      {
        body: {
          ok: true,
          messages: [{ ts: "2.0", text: "b", bot_id: "B1", subtype: "bot_message" }],
          has_more: false,
          response_metadata: { next_cursor: "" },
        },
      },
    ]);
    const first = await client.listHistory("C1", { oldest: "1.0", inclusive: true, limit: 1 });
    const second = await client.listHistory("C1", {
      oldest: "1.0",
      inclusive: true,
      limit: 1,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(requests.map((r) => r.params)).toEqual([
      { channel: "C1", limit: "1", oldest: "1.0", inclusive: "true" },
      { channel: "C1", limit: "1", oldest: "1.0", inclusive: "true", cursor: "page-2" },
    ]);
    expect(second).toEqual({
      channel: "C1",
      order: "newest_first",
      messages: [{ channel: "C1", ts: "2.0", text: "b", botId: "B1", subtype: "bot_message" }],
      hasMore: false,
    });
  });

  it("reads a thread page oldest first through conversations.replies", async () => {
    const { client, requests } = slackApi([
      {
        body: {
          ok: true,
          messages: [
            { ts: "5.0", text: "parent", user: "U1", thread_ts: "5.0", reply_count: 2 },
            { ts: "5.1", text: "first reply", user: "U2", thread_ts: "5.0" },
          ],
          has_more: true,
          response_metadata: { next_cursor: "replies-2" },
        },
      },
    ]);
    const page = await client.listThreadReplies("C1", "5.0", { latest: "6.0", limit: 2 });
    expect(requests).toEqual([
      {
        method: "conversations.replies",
        params: { channel: "C1", ts: "5.0", limit: "2", latest: "6.0" },
      },
    ]);
    expect(page.order).toBe("oldest_first");
    expect(page.threadTs).toBe("5.0");
    expect(page.messages.map((m) => m.text)).toEqual(["parent", "first reply"]);
    expect(page.nextCursor).toBe("replies-2");
  });

  it("names the needed scope without echoing the token's granted scopes", async () => {
    const { client } = slackApi([
      {
        body: {
          ok: false,
          error: "missing_scope",
          needed: "groups:history",
          provided: "channels:history,chat:write",
        },
      },
    ]);
    const err = await client.listHistory("G1", { limit: 10 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      "Slack token lacks a scope conversations.history needs for this request (needed: groups:history)"
    );
    expect((err as Error).message).not.toContain("chat:write");
  });

  it.each([
    ["not_in_channel", /not a member of this conversation.*not_in_channel/],
    ["channel_not_found", /not found or not visible to this token/],
    ["thread_not_found", /thread not found/],
    ["invalid_cursor", /^Slack conversations\.replies failed: invalid_cursor$/],
  ])("reports %s from an inaccessible thread or conversation", async (code, message) => {
    const { client } = slackApi([{ body: { ok: false, error: code } }]);
    await expect(client.listThreadReplies("C9", "5.0", { limit: 10 })).rejects.toThrow(message);
  });

  it("reports a rate limit with Slack's retry-after instead of waiting it out", async () => {
    const { client, fetch } = slackApi([
      { status: 429, headers: { "retry-after": "30" }, body: { ok: false, error: "ratelimited" } },
    ]);
    const started = Date.now();
    await expect(client.listHistory("C1", { limit: 10 })).rejects.toThrow(
      "Slack rate limited conversations.history; retry after 30 seconds"
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports a Slack outage or network failure at once instead of retrying it", async () => {
    const { client, fetch } = slackApi([{ status: 503, body: { ok: false } }]);
    const started = Date.now();
    await expect(client.listHistory("C1", { limit: 10 })).rejects.toThrow(/statusCode = 503/);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(client.listThreadReplies("C1", "5.0", { limit: 10 })).rejects.toThrow(
      /fetch failed/
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("SlackClient conversation discovery", () => {
  function slackApi(replies: { status?: number; body: unknown }[]) {
    const requests: Record<string, string>[] = [];
    const fetch = vi.fn(async (url: string | URL, init?: { body?: unknown }) => {
      expect(String(url)).toMatch(/conversations\.list$/);
      const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
      delete params.token;
      requests.push(params);
      const reply = replies.shift() ?? { body: { ok: true } };
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    });
    return { client: new SlackClient("xoxb-synthetic", { fetch }), requests };
  }

  it("lists one page with stable IDs, types and Slack's membership flags", async () => {
    const { client, requests } = slackApi([
      {
        body: {
          ok: true,
          channels: [
            { id: "C1", name: "general", is_channel: true, is_member: true, is_archived: false },
            { id: "C2", name: "random", is_channel: true, is_member: false, is_archived: false },
            {
              id: "G1",
              name: "ops",
              is_channel: false,
              is_group: true,
              is_private: true,
              is_member: true,
            },
            { id: "G2", name: "mpdm-a--b-1", is_mpim: true, is_private: true },
            { id: "D1", is_im: true, user: "U1" },
            { id: "X1", name: "odd" },
            { name: "no-id", is_channel: true },
          ],
          response_metadata: { next_cursor: "dGVhbTpD" },
        },
      },
    ]);
    const page = await client.listConversations({
      types: ["public_channel", "private_channel", "mpim", "im"],
      excludeArchived: true,
      limit: 7,
    });
    expect(requests).toEqual([
      { types: "public_channel,private_channel,mpim,im", exclude_archived: "true", limit: "7" },
    ]);
    expect(page).toEqual({
      types: ["public_channel", "private_channel", "mpim", "im"],
      conversations: [
        { id: "C1", name: "general", type: "public_channel", isMember: true, isArchived: false },
        { id: "C2", name: "random", type: "public_channel", isMember: false, isArchived: false },
        { id: "G1", name: "ops", type: "private_channel", isMember: true },
        { id: "G2", name: "mpdm-a--b-1", type: "mpim" },
        { id: "D1", type: "im", user: "U1" },
        { id: "X1", name: "odd", type: "unknown" },
      ],
      hasMore: true,
      nextCursor: "dGVhbTpD",
    });
  });

  it("keeps walking through an empty page that still carries a cursor", async () => {
    const { client, requests } = slackApi([
      { body: { ok: true, channels: [], response_metadata: { next_cursor: "page-2" } } },
      {
        body: {
          ok: true,
          channels: [{ id: "C9", name: "old", is_channel: true, is_archived: true }],
          response_metadata: { next_cursor: "" },
        },
      },
    ]);
    const first = await client.listConversations({
      types: ["public_channel"],
      excludeArchived: false,
      limit: 1,
    });
    expect(first).toEqual({
      types: ["public_channel"],
      conversations: [],
      hasMore: true,
      nextCursor: "page-2",
    });
    const second = await client.listConversations({
      types: ["public_channel"],
      excludeArchived: false,
      limit: 1,
      cursor: "page-2",
    });
    expect(requests[1]).toEqual({
      types: "public_channel",
      exclude_archived: "false",
      limit: "1",
      cursor: "page-2",
    });
    expect(second).toEqual({
      types: ["public_channel"],
      conversations: [{ id: "C9", name: "old", type: "public_channel", isArchived: true }],
      hasMore: false,
    });
  });

  it("fails a listing whose type needs a scope the token lacks, naming only that scope", async () => {
    const { client } = slackApi([
      {
        body: {
          ok: false,
          error: "missing_scope",
          needed: "groups:read",
          provided: "channels:read,chat:write",
        },
      },
    ]);
    const err = await client
      .listConversations({ types: ["private_channel"], excludeArchived: true, limit: 10 })
      .catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "Slack token lacks a scope conversations.list needs for this request (needed: groups:read)"
    );
    expect((err as Error).message).not.toContain("chat:write");
  });

  it.each([
    ["invalid_types", /^Slack conversations\.list failed: invalid_types$/],
    ["invalid_auth", /^Slack conversations\.list failed: invalid_auth$/],
  ])("reports %s", async (code, message) => {
    const { client } = slackApi([{ body: { ok: false, error: code } }]);
    await expect(
      client.listConversations({ types: ["public_channel"], excludeArchived: true, limit: 10 })
    ).rejects.toThrow(message);
  });
});
