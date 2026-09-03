import { describe, expect, it, vi } from "vitest";
import type {
  IssueClient,
  IssueComment,
  IssueDetails,
  PrReviewComment,
} from "../gitops/issue-client.js";
import { resolveReference } from "./resolve.js";

/** A production-shaped `IssueDetails`, as `GitHubIssueClient.getIssue` really returns. */
function issueDetails(overrides: Partial<IssueDetails> = {}): IssueDetails {
  return {
    number: 33,
    title: "Something broke",
    body: "Steps to reproduce...",
    state: "open",
    author: "octocat",
    ...overrides,
  };
}

function issueComment(overrides: Partial<IssueComment> = {}): IssueComment {
  return {
    id: 12345,
    author: "octocat",
    body: "Looks right to me.",
    createdAt: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

function prReviewComment(overrides: Partial<PrReviewComment> = {}): PrReviewComment {
  return {
    id: 555,
    path: "src/foo.ts",
    line: 10,
    body: "nit: rename this",
    diffHunk: "@@ -1,3 +1,3 @@",
    author: "octocat",
    createdAt: "2026-09-01T11:00:00Z",
    ...overrides,
  };
}

describe("resolveReference — github", () => {
  it("resolves an issue using the real IssueClient shape (title, body, author — no user.login)", async () => {
    const getIssue = vi.fn<IssueClient["getIssue"]>().mockResolvedValue(issueDetails());
    const resolved = await resolveReference("github:MEK-Org/rusa/issues/33", {
      issueClient: { getIssue },
    });

    expect(getIssue).toHaveBeenCalledWith("MEK-Org/rusa", 33);
    expect(resolved.unavailable).toBeNull();
    expect(resolved.body).toBe("Steps to reproduce...");
    expect(resolved.author).toBe("octocat");
    expect(resolved.entity).toEqual({
      type: "github_issue",
      title: "Something broke",
      description: "Steps to reproduce...",
    });
  });

  it("resolves a pull request the same way, tagged as github_pull_request", async () => {
    const getIssue = vi
      .fn<IssueClient["getIssue"]>()
      .mockResolvedValue(issueDetails({ title: "Fix the bug" }));
    const resolved = await resolveReference("github:MEK-Org/rusa/pulls/76", {
      issueClient: { getIssue },
    });

    expect(getIssue).toHaveBeenCalledWith("MEK-Org/rusa", 76);
    expect(resolved.entity).toEqual({
      type: "github_pull_request",
      title: "Fix the bug",
      description: "Steps to reproduce...",
    });
  });

  it("resolves an issue comment via listIssueComments", async () => {
    const listIssueComments = vi
      .fn<IssueClient["listIssueComments"]>()
      .mockResolvedValue([
        issueComment({ id: 1 }),
        issueComment({ id: 12345, body: "The actual comment" }),
      ]);
    const resolved = await resolveReference("github:MEK-Org/rusa/issues/33/comments/12345", {
      issueClient: { listIssueComments },
    });

    expect(listIssueComments).toHaveBeenCalledWith("MEK-Org/rusa", 33);
    expect(resolved.unavailable).toBeNull();
    expect(resolved.body).toBe("The actual comment");
    expect(resolved.author).toBe("octocat");
    expect(resolved.entity).toEqual({ type: "github_comment", body: "The actual comment" });
  });

  it("resolves a PR review comment via getPrReviewComments", async () => {
    const getPrReviewComments = vi
      .fn<IssueClient["getPrReviewComments"]>()
      .mockResolvedValue([prReviewComment({ id: 555, body: "nit: rename this" })]);
    const resolved = await resolveReference("github:MEK-Org/rusa/pulls/76/comments/555", {
      issueClient: { getPrReviewComments },
    });

    expect(getPrReviewComments).toHaveBeenCalledWith("MEK-Org/rusa", 76);
    expect(resolved.unavailable).toBeNull();
    expect(resolved.body).toBe("nit: rename this");
    expect(resolved.entity).toEqual({ type: "github_comment", body: "nit: rename this" });
  });

  it("resolves a PR review via getPullRequestReview", async () => {
    const getPullRequestReview = vi.fn<IssueClient["getPullRequestReview"]>().mockResolvedValue({
      id: 9001,
      state: "APPROVED",
      body: "Ship it.",
      author: "octocat",
    });
    const resolved = await resolveReference("github:MEK-Org/rusa/pulls/76/reviews/9001", {
      issueClient: { getPullRequestReview },
    });

    expect(getPullRequestReview).toHaveBeenCalledWith("MEK-Org/rusa", 76, 9001);
    expect(resolved.unavailable).toBeNull();
    expect(resolved.body).toBe("Ship it.");
    expect(resolved.author).toBe("octocat");
    expect(resolved.entity).toEqual({ type: "github_review", body: "Ship it.", state: "APPROVED" });
  });

  it("keeps an issue comment reference unavailable, not the whole request failing, when the tracker has no such comment", async () => {
    const listIssueComments = vi.fn<IssueClient["listIssueComments"]>().mockResolvedValue([]);
    const resolved = await resolveReference("github:MEK-Org/rusa/issues/33/comments/999", {
      issueClient: { listIssueComments },
    });

    expect(resolved.unavailable).toMatch(/not found/);
    expect(resolved.body).toBeNull();
    expect(resolved.entity).toBeUndefined();
  });

  it("keeps a review reference unavailable when the tracker reports it deleted (null)", async () => {
    const getPullRequestReview = vi
      .fn<IssueClient["getPullRequestReview"]>()
      .mockResolvedValue(null);
    const resolved = await resolveReference("github:MEK-Org/rusa/pulls/76/reviews/9001", {
      issueClient: { getPullRequestReview },
    });

    expect(resolved.unavailable).toMatch(/not found/);
    expect(resolved.entity).toBeUndefined();
  });

  it("never rejects when the tracker throws — an inaccessible resource stays a generic unavailable result", async () => {
    const getIssue = vi
      .fn<IssueClient["getIssue"]>()
      .mockRejectedValue(new Error("GitHub API 404"));
    const resolved = await resolveReference("github:MEK-Org/rusa/issues/33", {
      issueClient: { getIssue },
    });

    expect(resolved.unavailable).toBeTruthy();
    expect(resolved.entity).toBeUndefined();
  });

  it("says why a comment is unavailable when no tracker is configured, rather than showing nothing", async () => {
    const resolved = await resolveReference("github:MEK-Org/rusa/issues/33/comments/12345", {});
    expect(resolved.unavailable).toMatch(/not configured/);
    expect(resolved.url).toContain("MEK-Org/rusa/issues/33");
  });

  it("does not resolve a review under an issues collection — reviews only exist on pull requests", async () => {
    const resolved = await resolveReference("github:MEK-Org/rusa/issues/33/reviews/1", {});
    expect(resolved.unavailable).toBeTruthy();
    expect(resolved.entity).toBeUndefined();
  });
});

describe("resolveReference — mesh", () => {
  it("exposes raw sender/recipient ids as a structured entity rather than baking them into title text", async () => {
    const getById = vi.fn().mockReturnValue({
      id: "m1",
      senderId: "actor-1",
      recipientId: "human:operator",
      body: "hello",
      ts: "2026-09-01T00:00:00Z",
    });
    const resolved = await resolveReference("mesh:messages/m1", { meshChat: { getById } });

    expect(resolved.entity).toEqual({
      type: "mesh_message",
      senderId: "actor-1",
      recipientId: "human:operator",
    });
    // author still carries the raw id — callers resolve it to a handle themselves.
    expect(resolved.author).toBe("actor-1");
  });
});
