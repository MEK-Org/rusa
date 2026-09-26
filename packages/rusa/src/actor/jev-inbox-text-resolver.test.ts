import { describe, expect, it, vi } from "vitest";
import { createJevInboxTextResolver, JEV_MAX_ENTRY_TEXT_CHARS } from "./jev-inbox-text-resolver.js";

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: "entry",
  actorId: "actor",
  source: "gchat:spaces/S",
  deliveredAt: new Date(),
  seenAt: null,
  handledAt: null,
  handledNote: null,
  payload: { type: "gchat.message", messageName: "spaces/S/messages/M" },
  ...overrides,
});

function deps(row: ReturnType<typeof entry> | null = entry()) {
  return {
    inbox: { read: vi.fn(() => row) },
    chatClient: {
      getMessage: vi.fn(async () => ({ name: "spaces/S/messages/M", text: "real chat text" })),
      getSpace: vi.fn(),
    },
    slackClient: {
      getMessage: vi.fn(async () => ({ channel: "C", ts: "1.2", text: "real slack text" })),
      getChannel: vi.fn(),
    },
    meshChat: {
      getById: vi.fn(() => ({
        id: "m",
        ts: "",
        senderId: "root",
        recipientId: "actor",
        body: "real mesh text",
        sessionId: null,
      })),
    },
    issueClient: {
      getIssue: vi.fn(),
      getPrReviewComments: vi.fn(),
      getPullRequestReview: vi.fn(),
      listIssueComments: vi.fn(),
    },
  };
}

describe("createJevInboxTextResolver", () => {
  it("reads a Google Chat message only at the host-side decision boundary", async () => {
    const source = deps();
    await expect(createJevInboxTextResolver(source)("actor", "entry")).resolves.toEqual({
      id: "entry",
      source: "gchat:spaces/S",
      type: "gchat.message",
      text: "real chat text",
    });
    expect(source.inbox.read).toHaveBeenCalledWith("actor", "entry");
    expect(source.chatClient.getMessage).toHaveBeenCalledWith("spaces/S/messages/M");
  });

  it("reads the specific GitHub comment rather than the whole issue", async () => {
    const source = deps(
      entry({
        source: "github:owner/repo/issues/7",
        payload: { type: "issue_comment.created", commentId: 44 },
      })
    );
    source.issueClient.listIssueComments.mockResolvedValue([
      { id: 43, author: "a", body: "other", createdAt: "" },
      { id: 44, author: "b", body: "review this exact change", createdAt: "" },
    ]);

    await expect(createJevInboxTextResolver(source)("actor", "entry")).resolves.toMatchObject({
      text: "review this exact change",
    });
    expect(source.issueClient.getIssue).not.toHaveBeenCalled();
  });

  it("does not stand the issue body in for a comment event with no usable id", async () => {
    const source = deps(
      entry({
        source: "github:owner/repo/issues/7",
        payload: { type: "issue_comment.created", commentId: "44" },
      })
    );

    await expect(createJevInboxTextResolver(source)("actor", "entry")).resolves.toMatchObject({
      text: null,
    });
    expect(source.issueClient.getIssue).not.toHaveBeenCalled();
    expect(source.issueClient.listIssueComments).not.toHaveBeenCalled();
  });

  it("reads obligation attention from its inline intent", async () => {
    const source = deps(
      entry({
        source: "obligation:ob-1",
        payload: {
          type: "obligation.ready_head",
          obligationId: "ob-1",
          intent: "Land the deploy fix",
        },
      })
    );
    await expect(createJevInboxTextResolver(source)("actor", "entry")).resolves.toMatchObject({
      type: "obligation.ready_head",
      text: "Land the deploy fix",
    });
  });

  it("reads a scheduled mesh message through its message id", async () => {
    const source = deps(
      entry({
        source: "mesh:root",
        payload: { type: "mesh.scheduled_message", messageId: "m", fromId: "root" },
      })
    );
    await expect(createJevInboxTextResolver(source)("actor", "entry")).resolves.toMatchObject({
      text: "real mesh text",
    });
    expect(source.meshChat.getById).toHaveBeenCalledWith("m");
  });

  it("returns null text instead of failing when the source has none", async () => {
    const source = deps(entry({ payload: { type: "system.disk", priority: "responsive" } }));
    await expect(createJevInboxTextResolver(source)("actor", "entry")).resolves.toMatchObject({
      type: "system.disk",
      text: null,
    });
    const missing = deps(null);
    await expect(createJevInboxTextResolver(missing)("actor", "gone")).resolves.toMatchObject({
      id: "gone",
      text: null,
    });
  });

  it("bounds each entry's text", async () => {
    const source = deps();
    source.chatClient.getMessage.mockResolvedValue({
      name: "spaces/S/messages/M",
      text: "x".repeat(JEV_MAX_ENTRY_TEXT_CHARS + 10),
    });
    const resolved = await createJevInboxTextResolver(source)("actor", "entry");
    expect(resolved.text).toHaveLength(JEV_MAX_ENTRY_TEXT_CHARS);
    expect(resolved.truncated).toBe(true);
  });

  it("reads the source on every call, so a failed read is not reused", async () => {
    const source = deps();
    source.chatClient.getMessage.mockRejectedValueOnce(new Error("transient"));
    const resolve = createJevInboxTextResolver(source);
    await expect(resolve("actor", "entry")).resolves.toMatchObject({ text: null });
    await expect(resolve("actor", "entry")).resolves.toMatchObject({ text: "real chat text" });
    expect(source.chatClient.getMessage).toHaveBeenCalledTimes(2);
  });
});
