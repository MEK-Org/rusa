import { afterEach, describe, expect, it, vi } from "vitest";
import { PubsubChatSource } from "./pubsub-source.js";
import type { ChatMessage, ChatSpaceMemberPage, ListChatSpaceMembersOptions } from "./types.js";

const pubsubMock = vi.hoisted(() => ({
  handlers: new Map<string, (message: unknown) => void>(),
  subscriptionClose: vi.fn(async () => {}),
  pubsubClose: vi.fn(async () => {}),
}));

vi.mock("@google-cloud/pubsub", () => ({
  PubSub: class {
    subscription() {
      return {
        on: (event: string, handler: (message: unknown) => void) => {
          pubsubMock.handlers.set(event, handler);
        },
        close: pubsubMock.subscriptionClose,
      };
    }

    close = pubsubMock.pubsubClose;
  },
}));

const SELF = "users/self";
const HUMAN = "users/human";

function roomMessage() {
  return {
    attributes: {},
    data: Buffer.from(
      JSON.stringify({
        message: {
          name: "spaces/room/messages/message",
          sender: { name: HUMAN, type: "HUMAN" },
          space: { name: "spaces/room", spaceType: "SPACE" },
          text: "no mention",
        },
      })
    ),
    ack: vi.fn(),
    nack: vi.fn(),
  };
}

async function deliver(
  listSpaceMembers: (
    spaceName: string,
    options?: ListChatSpaceMembersOptions
  ) => Promise<ChatSpaceMemberPage>
) {
  const received: ChatMessage[] = [];
  const log = vi.fn();
  const source = new PubsubChatSource({
    projectId: "project",
    subscription: "subscription",
    keyFilename: "/dev/null",
    selfUserId: SELF,
    resolveSpaceType: vi.fn(async () => "SPACE"),
    listSpaceMembers,
    log,
  });
  await source.start((message) => {
    received.push(message);
  });

  const rawMessage = roomMessage();
  pubsubMock.handlers.get("message")?.(rawMessage);
  await vi.waitFor(() => expect(received).toHaveLength(1));
  await source.close();
  return { received, rawMessage, log };
}

afterEach(() => {
  pubsubMock.handlers.clear();
  vi.clearAllMocks();
});

describe("PubsubChatSource room membership", () => {
  it("keeps a room mention-gated when a later page adds a third member", async () => {
    const listSpaceMembers = vi
      .fn<
        (spaceName: string, options?: ListChatSpaceMembersOptions) => Promise<ChatSpaceMemberPage>
      >()
      .mockResolvedValueOnce({
        members: [
          { name: SELF, type: "BOT" },
          { name: HUMAN, type: "HUMAN" },
        ],
        nextPageToken: "next",
      })
      .mockResolvedValueOnce({
        members: [{ name: "users/third", type: "HUMAN" }],
        nextPageToken: "unused",
      });

    const { received, rawMessage } = await deliver(listSpaceMembers);

    expect(listSpaceMembers).toHaveBeenCalledTimes(2);
    expect(listSpaceMembers).toHaveBeenNthCalledWith(2, "spaces/room", {
      pageSize: 1000,
      pageToken: "next",
    });
    expect(received[0]?.isDirectMessage).toBe(false);
    expect(rawMessage.ack).toHaveBeenCalledOnce();
    expect(rawMessage.nack).not.toHaveBeenCalled();
  });

  it("fails closed when a later membership page throws", async () => {
    const listSpaceMembers = vi
      .fn<
        (spaceName: string, options?: ListChatSpaceMembersOptions) => Promise<ChatSpaceMemberPage>
      >()
      .mockResolvedValueOnce({
        members: [
          { name: SELF, type: "BOT" },
          { name: HUMAN, type: "HUMAN" },
        ],
        nextPageToken: "next",
      })
      .mockRejectedValueOnce(new Error("membership lookup failed"));

    const { received, rawMessage, log } = await deliver(listSpaceMembers);

    expect(listSpaceMembers).toHaveBeenCalledTimes(2);
    expect(received[0]?.isDirectMessage).toBe(false);
    expect(rawMessage.ack).toHaveBeenCalledOnce();
    expect(rawMessage.nack).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "space membership lookup failed for spaces/room: membership lookup failed"
    );
  });
});
