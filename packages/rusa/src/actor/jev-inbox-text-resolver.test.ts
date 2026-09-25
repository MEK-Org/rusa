import { describe, expect, it, vi } from "vitest";
import { createJevInboxTextResolver } from "./jev-inbox-text-resolver.js";

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: "entry",
  actorId: "actor",
  source: "chat_space:spaces/S",
  deliveredAt: new Date(),
  seenAt: null,
  handledAt: null,
  handledNote: null,
  payload: { type: "gchat.message", messageName: "spaces/S/messages/M" },
  ...overrides,
});

function deps(row = entry()) {
  return {
    inbox: { read: vi.fn(() => row) },
    chatClient: {
      getMessage: vi.fn(async () => ({ name: "spaces/S/messages/M", text: "real chat text" })),
    },
    slackClient: {
      getMessage: vi.fn(async () => ({ channel: "C", ts: "1", text: "real slack text" })),
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
      getPullRequestDetails: vi.fn(),
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
      source: "chat_space:spaces/S",
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

  it("fails closed when the source cannot supply text", async () => {
    const source = deps(entry({ payload: { type: "system.disk", priority: "responsive" } }));
    await expect(createJevInboxTextResolver(source)("actor", "entry")).rejects.toThrow(
      "inbox source has no readable text"
    );
  });
});
