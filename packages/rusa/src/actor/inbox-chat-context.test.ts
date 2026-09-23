import { describe, expect, it } from "vitest";
import { FakeChatClient } from "../chat/fake.js";
import type { MeshChat } from "../db/repositories/mesh-chat-repository.js";
import type { InboxEntry } from "../repositories/inbox-repository.js";
import type { SlackMessage } from "../slack/slack-client.js";
import {
  attachChatContext,
  boundChatContext,
  CHAT_CONTEXT_MAX_BYTES,
  CHAT_CONTEXT_MESSAGE_LIMIT,
  type ChatContextMessage,
  type ChatContextWindow,
} from "./inbox-chat-context.js";
import { attachInboxHints } from "./inbox-hints.js";

const SPACE = "spaces/S";

function makeEntry(partial: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: "entry-1",
    actorId: "actor-a",
    source: "gchat:spaces/S",
    deliveredAt: new Date("2026-09-23T10:00:00Z"),
    seenAt: null,
    handledAt: null,
    handledNote: null,
    payload: { type: "generic.event" },
    ...partial,
  };
}

function minute(n: number): string {
  return new Date(Date.UTC(2026, 8, 23, 9, n)).toISOString();
}

/** A top-level Google Chat message: its message id equals its thread id. */
function gchatHead(id: string, n: number, sender: string, text: string) {
  return {
    name: `${SPACE}/messages/${id}.${id}`,
    thread: { name: `${SPACE}/threads/${id}` },
    sender: { name: sender, displayName: sender === "users/bot" ? "Rusa" : "Operator" },
    createTime: minute(n),
    text,
  };
}

function gchatReply(id: string, threadId: string, n: number, sender: string, text: string) {
  return {
    name: `${SPACE}/messages/${threadId}.${id}`,
    thread: { name: `${SPACE}/threads/${threadId}` },
    sender: { name: sender },
    createTime: minute(n),
    text,
  };
}

function windowOf(entry: { chatContext?: unknown }): ChatContextWindow {
  return entry.chatContext as ChatContextWindow;
}

describe("chat context on selection", () => {
  describe("Google Chat", () => {
    it("returns the space's recent top-level messages, both senders, for a top-level entry", async () => {
      const chat = new FakeChatClient();
      chat.messages.push(
        gchatHead("a", 1, "users/op", "Can you check PR #643?"),
        gchatReply("r1", "a", 2, "users/bot", "Looking now."),
        gchatHead("b", 3, "users/bot", "PR #643 is green."),
        gchatHead("c", 4, "users/op", "Just answered on the thread")
      );
      const [entry] = await attachChatContext(
        [
          makeEntry({
            payload: {
              type: "gchat.message",
              spaceName: SPACE,
              messageName: `${SPACE}/messages/c.c`,
              threadName: `${SPACE}/threads/c`,
            },
          }),
        ],
        "actor-a",
        { chatClient: chat }
      );
      const window = windowOf(entry ?? {});
      expect(window).toMatchObject({ source: "gchat", scope: "top_level" });
      // The in-thread reply is excluded; the actor's own outbound is included.
      expect(window.messages.map((m) => m.text)).toEqual([
        "Can you check PR #643?",
        "PR #643 is green.",
        "Just answered on the thread",
      ]);
      expect(window.messages[1]).toMatchObject({
        messageId: `${SPACE}/messages/b.b`,
        threadId: `${SPACE}/threads/b`,
        sender: "users/bot",
        senderDisplayName: "Rusa",
        timestamp: minute(3),
      });
      expect(window.messages.filter((m) => m.selected).map((m) => m.messageId)).toEqual([
        `${SPACE}/messages/c.c`,
      ]);
    });

    it("returns that thread's tail for an in-thread entry", async () => {
      const chat = new FakeChatClient();
      chat.messages.push(gchatHead("a", 0, "users/op", "head"));
      for (let i = 1; i <= 12; i++) {
        chat.messages.push(
          gchatReply(`r${i}`, "a", i, i % 2 ? "users/op" : "users/bot", `reply ${i}`)
        );
      }
      chat.messages.push(gchatHead("z", 30, "users/op", "unrelated top-level"));
      const [entry] = await attachChatContext(
        [
          makeEntry({
            payload: {
              type: "gchat.message",
              spaceName: SPACE,
              messageName: `${SPACE}/messages/a.r12`,
              threadName: `${SPACE}/threads/a`,
            },
          }),
        ],
        "actor-a",
        { chatClient: chat }
      );
      const window = windowOf(entry ?? {});
      expect(window.scope).toBe("thread");
      expect(window.messages.map((m) => m.text)).toEqual(
        Array.from({ length: 10 }, (_, i) => `reply ${i + 3}`)
      );
      expect(window.messages.at(-1)?.selected).toBe(true);
    });

    it("keeps scanning past thread replies until it finds N top-level messages", async () => {
      const chat = new FakeChatClient();
      for (let i = 0; i < CHAT_CONTEXT_MESSAGE_LIMIT; i++) {
        chat.messages.push(gchatHead(`h${i}`, i, "users/op", `head ${i}`));
      }
      // 150 newer replies push every head past the first page of 100.
      for (let i = 0; i < 150; i++) {
        chat.messages.push({
          ...gchatReply(`r${i}`, "h0", 20, "users/bot", `reply ${i}`),
          createTime: new Date(Date.UTC(2026, 8, 23, 10, 0, i)).toISOString(),
        });
      }
      const [entry] = await attachChatContext(
        [makeEntry({ payload: { type: "gchat.message", spaceName: SPACE } })],
        "actor-a",
        { chatClient: chat }
      );
      expect(windowOf(entry ?? {}).messages.map((m) => m.text)).toEqual(
        Array.from({ length: 10 }, (_, i) => `head ${i}`)
      );
    });
  });

  describe("Slack", () => {
    function slackStub(messages: SlackMessage[]) {
      const calls: Array<{ channel: string; opts: { threadTs?: string; limit: number } }> = [];
      return {
        calls,
        client: {
          listRecentMessages: async (
            channel: string,
            opts: { threadTs?: string; limit: number }
          ) => {
            calls.push({ channel, opts });
            return messages;
          },
        },
      };
    }

    it("asks for the channel's top level for a top-level entry", async () => {
      const slack = slackStub([
        { channel: "C1", ts: "1.0", text: "earlier", user: "U1" },
        { channel: "C1", ts: "2.0", text: "bot reply", user: "B1" },
      ]);
      const [entry] = await attachChatContext(
        [
          makeEntry({
            source: "slack:channels/C1",
            payload: { type: "slack.message", channel: "C1", ts: "2.0", threadTs: "2.0" },
          }),
        ],
        "actor-a",
        { slackClient: slack.client }
      );
      expect(slack.calls).toEqual([{ channel: "C1", opts: { limit: 10 } }]);
      expect(windowOf(entry ?? {})).toMatchObject({
        source: "slack",
        scope: "top_level",
        messages: [
          { messageId: "1.0", sender: "U1", timestamp: "1.0", text: "earlier" },
          { messageId: "2.0", sender: "B1", text: "bot reply", selected: true },
        ],
      });
    });

    it("asks for the thread's tail for an in-thread entry", async () => {
      const slack = slackStub([
        { channel: "C1", ts: "1.0", text: "parent", user: "U1", threadTs: "1.0" },
        { channel: "C1", ts: "1.5", text: "in thread", user: "U2", threadTs: "1.0" },
      ]);
      const [entry] = await attachChatContext(
        [
          makeEntry({
            source: "slack:channels/C1",
            payload: { type: "slack.message", channel: "C1", ts: "1.5", threadTs: "1.0" },
          }),
        ],
        "actor-a",
        { slackClient: slack.client }
      );
      expect(slack.calls).toEqual([{ channel: "C1", opts: { threadTs: "1.0", limit: 10 } }]);
      expect(windowOf(entry ?? {})).toMatchObject({
        scope: "thread",
        messages: [{ threadId: "1.0" }, { messageId: "1.5", threadId: "1.0", selected: true }],
      });
    });
  });

  describe("mesh", () => {
    it("returns the pairwise conversation oldest first, including the actor's own messages", async () => {
      const rows: MeshChat[] = [
        {
          id: "m3",
          ts: "2026-09-23T10:03:00Z",
          senderId: "peer",
          recipientId: "actor-a",
          body: "third",
          sessionId: null,
        },
        {
          id: "m2",
          ts: "2026-09-23T10:02:00Z",
          senderId: "actor-a",
          recipientId: "peer",
          body: "second",
          sessionId: null,
        },
        {
          id: "m1",
          ts: "2026-09-23T10:01:00Z",
          senderId: "peer",
          recipientId: "actor-a",
          body: "first",
          sessionId: null,
        },
      ];
      const calls: unknown[] = [];
      const [entry] = await attachChatContext(
        [
          makeEntry({
            source: "mesh:peer",
            payload: { type: "mesh.message", messageId: "m3", fromId: "peer" },
          }),
        ],
        "actor-a",
        {
          meshChat: {
            listForActor: (actorId, opts) => {
              calls.push({ actorId, opts });
              return rows.map((row) => ({ ...row }));
            },
          },
        }
      );
      expect(calls).toEqual([{ actorId: "actor-a", opts: { peerId: "peer", limit: 10 } }]);
      const window = windowOf(entry ?? {});
      expect(window).toMatchObject({ source: "mesh", scope: "conversation" });
      expect(window.messages).toEqual([
        { messageId: "m1", sender: "peer", timestamp: "2026-09-23T10:01:00Z", text: "first" },
        { messageId: "m2", sender: "actor-a", timestamp: "2026-09-23T10:02:00Z", text: "second" },
        {
          messageId: "m3",
          sender: "peer",
          timestamp: "2026-09-23T10:03:00Z",
          text: "third",
          selected: true,
        },
      ]);
    });

    it("covers human operator messages the same way", async () => {
      const [entry] = await attachChatContext(
        [
          makeEntry({
            source: "mesh:human",
            payload: { type: "human.message", messageId: "h1", fromId: "human" },
          }),
        ],
        "actor-a",
        {
          meshChat: {
            listForActor: () => [
              {
                id: "h1",
                ts: "t",
                senderId: "human",
                recipientId: "actor-a",
                body: "hi",
                sessionId: "s",
              },
            ],
          },
        }
      );
      expect(windowOf(entry ?? {}).messages).toHaveLength(1);
    });
  });

  describe("bounds", () => {
    function message(i: number, text = `message ${i}`): ChatContextMessage {
      return { messageId: `m${i}`, sender: "u", timestamp: `t${i}`, text };
    }

    it("keeps only the newest N messages", () => {
      const all = Array.from({ length: 15 }, (_, i) => message(i));
      const bounded = boundChatContext(all);
      expect(bounded.messages.map((m) => m.messageId)).toEqual(
        Array.from({ length: CHAT_CONTEXT_MESSAGE_LIMIT }, (_, i) => `m${i + 5}`)
      );
      expect(bounded.omittedForBytes).toBe(0);
    });

    it("drops the oldest messages first to fit the byte cap", () => {
      const long = "x".repeat(30 * 1024);
      const all = [
        message(0, long),
        message(1, long),
        message(2, long),
        message(3, long),
        message(4),
      ];
      const bounded = boundChatContext(all);
      const total = bounded.messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
      expect(total).toBeLessThanOrEqual(CHAT_CONTEXT_MAX_BYTES);
      expect(bounded.messages.map((m) => m.messageId)).toEqual(["m2", "m3", "m4"]);
      expect(bounded.omittedForBytes).toBe(2);
    });

    it("cuts the text of a single message that alone exceeds the cap", () => {
      const bounded = boundChatContext([message(0, "é".repeat(100))], { limit: 10, maxBytes: 150 });
      const [only] = bounded.messages;
      expect(only?.textTruncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(only), "utf8")).toBeLessThanOrEqual(150);
      expect(only?.text).toMatch(/^é+$/);
    });

    it("applies both bounds to a fetched window and reports what the byte cap dropped", async () => {
      const chat = new FakeChatClient();
      for (let i = 0; i < 12; i++) {
        chat.messages.push(gchatHead(`h${i}`, i, "users/op", `${i}`.padEnd(400, "-")));
      }
      const [entry] = await attachChatContext(
        [makeEntry({ payload: { type: "gchat.message", spaceName: SPACE } })],
        "actor-a",
        { chatClient: chat },
        { limit: 5, maxBytes: 2_500 }
      );
      const window = windowOf(entry ?? {});
      expect(window.messages.map((m) => m.messageId)).toEqual(
        ["h8", "h9", "h10", "h11"].map((id) => `${SPACE}/messages/${id}.${id}`)
      );
      expect(window.omittedForBytes).toBe(1);
    });
  });

  it("leaves non-chat entries and existing reply hints unchanged", async () => {
    const entries = attachInboxHints([
      makeEntry({
        id: "gh",
        source: "github:o/r/pulls/1",
        payload: { type: "pull_request.opened" },
      }),
      makeEntry({
        id: "chat",
        payload: {
          type: "gchat.message",
          spaceName: SPACE,
          messageName: `${SPACE}/messages/a.a`,
          threadName: `${SPACE}/threads/a`,
        },
      }),
    ]);
    const chat = new FakeChatClient();
    chat.messages.push(gchatHead("a", 1, "users/op", "hi"));
    const withContext = await attachChatContext(entries, "actor-a", { chatClient: chat });
    expect(withContext[0]).toEqual(entries[0]);
    expect(withContext[1]?.hint).toBe(entries[1]?.hint);
    expect(windowOf(withContext[1] ?? {}).messages).toHaveLength(1);
  });

  it("fetches a shared conversation once and points later entries at the first", async () => {
    let fetches = 0;
    const payload = { type: "mesh.message", fromId: "peer" };
    const result = await attachChatContext(
      [
        makeEntry({ id: "e1", source: "mesh:peer", payload: { ...payload, messageId: "m1" } }),
        makeEntry({ id: "e2", source: "mesh:peer", payload: { ...payload, messageId: "m2" } }),
      ],
      "actor-a",
      {
        meshChat: {
          listForActor: () => {
            fetches++;
            return [];
          },
        },
      }
    );
    expect(fetches).toBe(1);
    expect(result[1]?.chatContext).toEqual({ sameAsEntryId: "e1" });
  });

  it("reports a failed or slow fetch on the entry instead of failing the selection", async () => {
    const chatEntry = makeEntry({ payload: { type: "gchat.message", spaceName: SPACE } });
    const [failed] = await attachChatContext([chatEntry], "actor-a", {
      chatClient: {
        listMessages: async () => {
          throw new Error("HTTP 403");
        },
      },
    });
    expect(failed?.chatContextError).toBe("HTTP 403");
    expect(failed?.chatContext).toBeUndefined();

    const [slow] = await attachChatContext(
      [chatEntry],
      "actor-a",
      { chatClient: { listMessages: () => new Promise(() => {}) } },
      undefined,
      10
    );
    expect(slow?.chatContextError).toBe("chat context timed out after 10ms");

    const [unconfigured] = await attachChatContext([chatEntry], "actor-a", {});
    expect(unconfigured?.chatContextError).toMatch(/not configured/);
  });
});
