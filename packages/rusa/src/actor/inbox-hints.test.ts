import { describe, expect, it } from "vitest";
import { attachInboxHints, isGchatThreadHead, resolveInboxHint } from "./inbox-hints.js";
import type { InboxEntry } from "./inbox-store.js";

function makeEntry(partial: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: "test-entry-1",
    actorId: "root",
    source: "mesh:root",
    deliveredAt: new Date("2026-08-18T10:00:00Z"),
    seenAt: null,
    handledAt: null,
    handledNote: null,
    payload: { type: "generic.event" },
    ...partial,
  };
}

describe("inbox hints", () => {
  describe("human operator messages ", () => {
    it("provides a reminder to reply via mesh chat for human.message payload", () => {
      const entry = makeEntry({
        source: "mesh:human:operator",
        payload: {
          type: "human.message",
          messageId: "msg-123",
          fromId: "human:operator",
          sessionId: "sess-abc",
        },
      });
      const hint = resolveInboxHint(entry);
      expect(hint).toContain("This is a message from the human operator");
      expect(hint).toContain(
        "Reply directly to the human operator using your reply tool or mesh chat"
      );
    });

    it("provides a reminder for human.voice payload", () => {
      const entry = makeEntry({
        source: "mesh:human:operator",
        payload: {
          type: "human.voice",
          messageId: "msg-456",
          fromId: "human:operator",
        },
      });
      const hint = resolveInboxHint(entry);
      expect(hint).toContain(
        "Reply directly to the human operator using your reply tool or mesh chat"
      );
    });

    it("provides a reminder when source is mesh:human", () => {
      const entry = makeEntry({
        source: "mesh:human",
        payload: {
          type: "custom.message",
        },
      });
      const hint = resolveInboxHint(entry);
      expect(hint).toContain(
        "Reply directly to the human operator using your reply tool or mesh chat"
      );
    });

    it("provides a reminder when fromId is human operator", () => {
      const entry = makeEntry({
        source: "mesh:some_source",
        payload: {
          type: "message",
          fromId: "human:admin",
        },
      });
      const hint = resolveInboxHint(entry);
      expect(hint).toContain(
        "Reply directly to the human operator using your reply tool or mesh chat"
      );
    });
  });

  describe("isGchatThreadHead", () => {
    it("returns true when messageName has M.M matching thread M", () => {
      expect(
        isGchatThreadHead(
          "spaces/hPHAPyAAAAE/messages/07k_kyozWSk.07k_kyozWSk",
          "spaces/hPHAPyAAAAE/threads/07k_kyozWSk"
        )
      ).toBe(true);
      expect(isGchatThreadHead("spaces/AAA/messages/BBB.BBB", "spaces/AAA/threads/BBB")).toBe(true);
    });

    it("returns true when messageName has M matching thread M", () => {
      expect(isGchatThreadHead("spaces/AAA/messages/BBB", "spaces/AAA/threads/BBB")).toBe(true);
      expect(isGchatThreadHead("BBB", "BBB")).toBe(true);
    });

    it("returns false when messageName is a different message ID in the thread", () => {
      expect(isGchatThreadHead("spaces/AAA/messages/CCC", "spaces/AAA/threads/BBB")).toBe(false);
      expect(isGchatThreadHead("spaces/AAA/messages/CCC.CCC", "spaces/AAA/threads/BBB")).toBe(
        false
      );
      expect(isGchatThreadHead("spaces/AAA/messages/CCC.BBB", "spaces/AAA/threads/BBB")).toBe(
        false
      );
    });

    it("returns false when either messageName or threadName is missing", () => {
      expect(isGchatThreadHead(undefined, "spaces/AAA/threads/BBB")).toBe(false);
      expect(isGchatThreadHead("spaces/AAA/messages/BBB.BBB", undefined)).toBe(false);
      expect(isGchatThreadHead(undefined, undefined)).toBe(false);
    });
  });

  describe("Google Chat messages (ISSUE_NUM, ISSUE_NUM)", () => {
    it("provides top-level guidance for a thread-head message carrying implicit thread resource ", () => {
      const entry = makeEntry({
        source: "chat_space:spaces/hPHAPyAAAAE",
        payload: {
          type: "gchat.message",
          spaceName: "spaces/hPHAPyAAAAE",
          threadName: "spaces/hPHAPyAAAAE/threads/07k_kyozWSk",
          messageName: "spaces/hPHAPyAAAAE/messages/07k_kyozWSk.07k_kyozWSk",
        },
      });
      const hint = resolveInboxHint(entry);
      expect(hint).toBe(
        "This Google Chat message is at top-level in 'spaces/hPHAPyAAAAE' (not in a thread) — in the UI it appears as a standalone message, and a thread only comes into being if someone replies to it. It still carries a threadName: in Google Chat every message has one, and on a top-level message that id is the handle you would use to start a thread here, not a sign that a thread already exists. You can confirm this one from the payload alone — messageName is 'spaces/hPHAPyAAAAE/messages/07k_kyozWSk.07k_kyozWSk', whose message id equals its thread id, the signature of a message heading its own as-yet-empty thread. Reply with the chat-write 'send_message' tool, passing spaceName 'spaces/hPHAPyAAAAE' and omitting threadName, unless the message explicitly requests creating a new thread."
      );
    });

    it("provides top-level guidance for thread-head message with single-id format (#1719)", () => {
      const entry = makeEntry({
        source: "chat_space:spaces/AAA",
        payload: {
          type: "gchat.message",
          spaceName: "spaces/AAA",
          threadName: "spaces/AAA/threads/BBB",
          messageName: "spaces/AAA/messages/BBB",
        },
      });
      const hint = resolveInboxHint(entry);
      expect(hint).toBe(
        "This Google Chat message is at top-level in 'spaces/AAA' (not in a thread) — in the UI it appears as a standalone message, and a thread only comes into being if someone replies to it. It still carries a threadName: in Google Chat every message has one, and on a top-level message that id is the handle you would use to start a thread here, not a sign that a thread already exists. You can confirm this one from the payload alone — messageName is 'spaces/AAA/messages/BBB', whose message id equals its thread id, the signature of a message heading its own as-yet-empty thread. Reply with the chat-write 'send_message' tool, passing spaceName 'spaces/AAA' and omitting threadName, unless the message explicitly requests creating a new thread."
      );
    });

    it("recovers spaceName from threadName for thread-head message when spaceName is omitted (#1719)", () => {
      const entry = makeEntry({
        source: "unknown",
        payload: {
          type: "gchat.message",
          threadName: "spaces/AAA/threads/BBB",
          messageName: "spaces/AAA/messages/BBB.BBB",
        },
      });
      const hint = resolveInboxHint(entry);
      expect(hint).toBe(
        "This Google Chat message is at top-level in 'spaces/AAA' (not in a thread) — in the UI it appears as a standalone message, and a thread only comes into being if someone replies to it. It still carries a threadName: in Google Chat every message has one, and on a top-level message that id is the handle you would use to start a thread here, not a sign that a thread already exists. You can confirm this one from the payload alone — messageName is 'spaces/AAA/messages/BBB.BBB', whose message id equals its thread id, the signature of a message heading its own as-yet-empty thread. Reply with the chat-write 'send_message' tool, passing spaceName 'spaces/AAA' and omitting threadName, unless the message explicitly requests creating a new thread."
      );
    });

    it("provides threading guidance with payload check when message is a genuine in-thread reply (#1719)", () => {
      const entry = makeEntry({
        source: "chat_space:spaces/AAA",
        payload: {
          type: "gchat.message",
          spaceName: "spaces/AAA",
          threadName: "spaces/AAA/threads/BBB",
          messageName: "spaces/AAA/messages/CCC",
        },
      });
      const hint = resolveInboxHint(entry);
      expect(hint).toBe(
        "This Google Chat message is in thread 'spaces/AAA/threads/BBB'. You can confirm this one from the payload alone — messageName is 'spaces/AAA/messages/CCC', whose message id differs from its thread id, making this a reply inside an existing thread. Reply inside this thread with the chat-write 'send_message' tool, passing spaceName 'spaces/AAA' and threadName 'spaces/AAA/threads/BBB' (threadName must belong to spaceName)."
      );
    });

    it("provides threading guidance without payload check when in-thread message omits messageName", () => {
      const entry = makeEntry({
        source: "chat_space:spaces/AAA",
        payload: {
          type: "gchat.message",
          spaceName: "spaces/AAA",
          threadName: "spaces/AAA/threads/BBB",
        },
      });
      const hint = resolveInboxHint(entry);
      expect(hint).toBe(
        "This Google Chat message is in thread 'spaces/AAA/threads/BBB'. Reply inside this thread with the chat-write 'send_message' tool, passing spaceName 'spaces/AAA' and threadName 'spaces/AAA/threads/BBB' (threadName must belong to spaceName)."
      );
    });

    it("provides top-level space guidance when message is not in a thread", () => {
      const entry = makeEntry({
        source: "chat_space:spaces/AAA",
        payload: {
          type: "gchat.message",
          spaceName: "spaces/AAA",
          messageName: "spaces/AAA/messages/CCC",
        },
      });
      const hint = resolveInboxHint(entry);
      expect(hint).toBe(
        "This Google Chat message is at top-level in 'spaces/AAA' (not in a thread). Reply with the chat-write 'send_message' tool, passing spaceName 'spaces/AAA' and omitting threadName, unless the message explicitly requests creating a new thread."
      );
    });

    it("handles missing spaceName gracefully for unthreaded messages", () => {
      const entry = makeEntry({
        source: "unknown",
        payload: {
          type: "gchat.message",
        },
      });
      const hint = resolveInboxHint(entry);
      expect(hint).toBe(
        "This Google Chat message is at top-level (not in a thread). Reply with the chat-write 'send_message' tool, passing the message's spaceName and omitting threadName, unless the message explicitly requests creating a new thread."
      );
    });
  });

  describe("other message types", () => {
    it("returns undefined for peer mesh messages and standard events", () => {
      const entry = makeEntry({
        source: "mesh:worker-1",
        payload: {
          type: "mesh.message",
          fromId: "worker-1",
        },
      });
      expect(resolveInboxHint(entry)).toBeUndefined();
    });
  });

  describe("attachInboxHints", () => {
    it("enriches items with hints when available and keeps items without hints unchanged", () => {
      const entries = [
        makeEntry({
          id: "e1",
          source: "mesh:human:operator",
          payload: { type: "human.message" },
        }),
        makeEntry({
          id: "e2",
          source: "mesh:worker-1",
          payload: { type: "mesh.message" },
        }),
      ];

      const hinted = attachInboxHints(entries);
      expect(hinted[0].id).toBe("e1");
      expect(hinted[0].hint).toBeDefined();
      expect(hinted[0].hint).toContain("human operator");

      expect(hinted[1].id).toBe("e2");
      expect(hinted[1].hint).toBeUndefined();
    });
  });
});
