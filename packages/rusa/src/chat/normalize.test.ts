import { describe, expect, it } from "vitest";
import { parseChatMessageData, toChatMessage } from "./normalize.js";

const SELF = "users/103698126301854079443";
const HUMAN = "users/111707186720517078091";

// Verbatim decoded `data` from a real google.workspace.chat.message.v1.created
// Pub/Sub message (a plain DM saying "test").
const REAL_DM_DATA = JSON.stringify({
  message: {
    name: "spaces/hPHAPyAAAAE/messages/07k_kyozWSk.07k_kyozWSk",
    sender: { name: HUMAN, type: "HUMAN" },
    createTime: "2026-06-16T12:14:15.457007Z",
    text: "test",
    thread: { name: "spaces/hPHAPyAAAAE/threads/07k_kyozWSk" },
    space: { name: "spaces/hPHAPyAAAAE" },
    argumentText: "test",
    formattedText: "test",
  },
});

describe("parseChatMessageData", () => {
  it("parses a real DM payload (no spaceType, no annotations)", () => {
    const parsed = parseChatMessageData(REAL_DM_DATA);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      name: "spaces/hPHAPyAAAAE/messages/07k_kyozWSk.07k_kyozWSk",
      spaceName: "spaces/hPHAPyAAAAE",
      threadName: "spaces/hPHAPyAAAAE/threads/07k_kyozWSk",
      senderName: HUMAN,
      senderType: "HUMAN",
      text: "test",
      mentionedUserNames: [],
    });
    // The event payload omits spaceType — must be resolved separately.
    expect(parsed?.spaceType).toBeUndefined();
  });

  it("extracts @mentions from USER_MENTION annotations", () => {
    const data = JSON.stringify({
      message: {
        name: "spaces/S/messages/M.M",
        sender: { name: HUMAN, type: "HUMAN" },
        space: { name: "spaces/S" },
        text: "hey @bot",
        annotations: [{ type: "USER_MENTION", userMention: { user: { name: SELF } } }],
      },
    });
    const parsed = parseChatMessageData(data);
    expect(parsed?.mentionedUserNames).toEqual([SELF]);
  });

  it("extracts attachments when present on the message payload", () => {
    const data = JSON.stringify({
      message: {
        name: "spaces/S/messages/M.M",
        sender: { name: HUMAN, type: "HUMAN" },
        space: { name: "spaces/S" },
        text: "check this out",
        attachment: [
          {
            name: "spaces/S/messages/M.M/attachments/ATT1",
            contentName: "architecture.png",
            contentType: "image/png",
            attachmentDataRef: { resourceName: "spaces/S/attachments/RES1" },
            source: "UPLOADED_CONTENT",
          },
        ],
      },
    });
    const parsed = parseChatMessageData(data);
    expect(parsed?.attachments).toEqual([
      {
        name: "spaces/S/messages/M.M/attachments/ATT1",
        contentName: "architecture.png",
        contentType: "image/png",
        attachmentDataRef: { resourceName: "spaces/S/attachments/RES1" },
        source: "UPLOADED_CONTENT",
      },
    ]);
    if (!parsed) throw new Error("expected parsed");
    const chatMsg = toChatMessage(parsed, SELF, "SPACE");
    expect(chatMsg.attachments).toEqual(parsed.attachments);
  });

  it("returns null for non-message / malformed payloads", () => {
    expect(parseChatMessageData("not json")).toBeNull();
    expect(parseChatMessageData(JSON.stringify({ message: {} }))).toBeNull();
    expect(parseChatMessageData(JSON.stringify({}))).toBeNull();
  });
});

describe("toChatMessage", () => {
  it("flags a DM and self-mention from a resolved space type", () => {
    const parsed = parseChatMessageData(REAL_DM_DATA);
    if (!parsed) throw new Error("expected a parsed message");
    const msg = toChatMessage(parsed, SELF, "DIRECT_MESSAGE");
    expect(msg.isDirectMessage).toBe(true);
    expect(msg.mentionsSelf).toBe(false);
    expect(msg.senderName).toBe(HUMAN);
  });

  it("does not flag a DM for a room space type", () => {
    const parsed = parseChatMessageData(REAL_DM_DATA);
    if (!parsed) throw new Error("expected a parsed message");
    const msg = toChatMessage(parsed, SELF, "SPACE");
    expect(msg.isDirectMessage).toBe(false);
  });

  it("treats a room containing only self and one human as a DM", () => {
    const parsed = parseChatMessageData(REAL_DM_DATA);
    if (!parsed) throw new Error("expected a parsed message");
    const msg = toChatMessage(parsed, SELF, "SPACE", [
      { name: SELF, type: "BOT" },
      { name: HUMAN, type: "HUMAN" },
    ]);
    expect(msg.isDirectMessage).toBe(true);
  });

  it("keeps a room with three members mention-gated", () => {
    const parsed = parseChatMessageData(REAL_DM_DATA);
    if (!parsed) throw new Error("expected a parsed message");
    const msg = toChatMessage(parsed, SELF, "SPACE", [
      { name: SELF, type: "BOT" },
      { name: HUMAN, type: "HUMAN" },
      { name: "users/another-human", type: "HUMAN" },
    ]);
    expect(msg.isDirectMessage).toBe(false);
  });
});
