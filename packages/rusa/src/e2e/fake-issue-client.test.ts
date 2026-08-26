import { describe, expect, it } from "vitest";
import { FakeIssueClient } from "./fake-issue-client.js";
import { LocalTracker } from "./local-tracker.js";

const REPO = "rusa-e2e/scratch";
const BOT = "rusa-e2e-bot";

function setup() {
  const tracker = new LocalTracker({
    repo: REPO,
    baseUrl: "http://localhost:8084",
    botAccount: BOT,
  });
  const client = new FakeIssueClient(tracker, BOT);
  return { tracker, client };
}

describe("FakeIssueClient", () => {
  it("creates a PR over a pushed branch and returns its number and url", async () => {
    const { client } = setup();
    const pr = await client.createPullRequest({
      repo: REPO,
      head: "mc/issue-1",
      title: "Add greeting",
      body: "body",
      reviewer: "human",
      base: "main",
    });
    expect(pr).toEqual({
      number: 1,
      htmlUrl: "http://localhost:8084/rusa-e2e/scratch/pull/1",
    });
  });

  it("upserts the existing PR for a head branch instead of creating a second", async () => {
    const { client } = setup();
    const first = await client.createPullRequest({
      repo: REPO,
      head: "mc/issue-1",
      title: "v1",
      body: "b1",
      reviewer: "human",
    });
    const second = await client.createPullRequest({
      repo: REPO,
      head: "mc/issue-1",
      title: "v2",
      body: "b2",
      reviewer: "human",
    });
    expect(second).toEqual(first);
    const details = await client.getPullRequestDetails(REPO, 1);
    expect(details.title).toBe("v2");
    expect(details.state).toBe("open");
    expect(details.headRef).toBe("mc/issue-1");
  });

  it("lists the bot's open PRs and parses the issue number from the branch", async () => {
    const { client } = setup();
    await client.createPullRequest({
      repo: REPO,
      head: "mc/issue-7",
      title: "t",
      body: "b",
      reviewer: "human",
    });
    const prs = await client.getOpenPullRequestsByAuthor(REPO, BOT);
    expect(prs).toHaveLength(1);
    expect(prs[0].issueNumber).toBe(7);
    expect(prs[0].headRef).toBe("mc/issue-7");
  });

  it("records the orchestrator's own comments without feeding intake back", async () => {
    const events: string[] = [];
    const tracker = new LocalTracker({
      repo: REPO,
      baseUrl: "http://localhost:8084",
      botAccount: BOT,
      onEvent: (type) => {
        events.push(type);
      },
    });
    const client = new FakeIssueClient(tracker, BOT);
    await tracker.createIssue({ title: "x", body: "y" }); // emits "issues"

    await client.postComment(REPO, 1, "Which framework should I use?");
    expect(tracker.getIssue(1)?.comments).toHaveLength(1);
    expect(events).toEqual(["issues"]); // postComment did not emit issue_comment
  });

  it("reads an issue's title/body/state and its comments", async () => {
    const { tracker, client } = setup();
    await tracker.createIssue({ title: "Clean up legacy code", body: "rip the bandaid off" });
    await tracker.addIssueComment(1, { body: "sounds good", author: "human" });

    const issue = await client.getIssue(REPO, 1);
    expect(issue).toMatchObject({
      number: 1,
      title: "Clean up legacy code",
      body: "rip the bandaid off",
      state: "open",
    });

    const comments = await client.listIssueComments(REPO, 1);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: "human", body: "sounds good" });
  });

  it("throws when reading a missing issue (no silent empty result to confabulate over)", async () => {
    const { client } = setup();
    await expect(client.getIssue(REPO, 999)).rejects.toThrow(/not found/);
    await expect(client.listIssueComments(REPO, 999)).rejects.toThrow(/not found/);
  });

  it("treats add_reaction as a harmless no-op (reactions don't reconcile)", async () => {
    const { tracker, client } = setup();
    await tracker.createIssue({ title: "x", body: "y" });
    await expect(client.addReaction(REPO, 1, "eyes")).resolves.toBeUndefined();
  });

  it("returns inline review comments recorded for a submitted review", async () => {
    const { tracker, client } = setup();
    tracker.upsertPrByHead({
      headRef: "mc/issue-1",
      title: "PR",
      body: "",
      base: "main",
      author: BOT,
    });
    const review = await tracker.submitReview(1, {
      state: "changes_requested",
      comments: [{ path: "src/x.ts", line: 4, body: "rename this", diffHunk: "@@ -1 +1 @@" }],
    });
    const comments = await client.getPrReviewComments(REPO, 1, review.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      id: expect.any(Number),
      path: "src/x.ts",
      line: 4,
      body: "rename this",
      diffHunk: "@@ -1 +1 @@",
      author: "e2e-user",
      inReplyToId: null,
    });
    expect(await client.getPrReviewComments(REPO, 1, 999)).toEqual([]);
  });

  it("creates standalone review comments and threads replies", async () => {
    const { tracker, client } = setup();
    tracker.upsertPrByHead({
      headRef: "mc/issue-1",
      title: "PR",
      body: "",
      base: "main",
      author: BOT,
    });

    const rootComment = await client.createPrReviewComment({
      repo: REPO,
      prNumber: 1,
      path: "src/main.ts",
      line: 10,
      body: "Initial question?",
    });
    expect(rootComment).toMatchObject({
      id: expect.any(Number),
      path: "src/main.ts",
      line: 10,
      body: "Initial question?",
    });

    const replyComment = await client.createPrReviewComment({
      repo: REPO,
      prNumber: 1,
      inReplyTo: rootComment.id,
      body: "Reply explanation.",
    });
    expect(replyComment).toMatchObject({
      id: expect.any(Number),
      path: "src/main.ts",
      line: 10,
      body: "Reply explanation.",
    });

    const allComments = await client.getPrReviewComments(REPO, 1);
    expect(allComments).toHaveLength(2);
    expect(allComments[0].id).toBe(rootComment.id);
    expect(allComments[0].inReplyToId).toBeNull();
    expect(allComments[1].id).toBe(replyComment.id);
    expect(allComments[1].inReplyToId).toBe(rootComment.id);

    await expect(
      client.createPrReviewComment({
        repo: REPO,
        prNumber: 1,
        inReplyTo: 99999,
        body: "Orphaned reply",
      })
    ).rejects.toThrow(/Cannot reply to comment #99999/);
  });

  it("defaults the sub-issue hierarchy to the single-issue case", async () => {
    const { tracker, client } = setup();
    await tracker.createIssue({ title: "x", body: "y" });
    expect(await client.getParentIssueNumber(REPO, 1)).toBeNull();
    expect(await client.getRootIssueNumber(REPO, 1)).toBeNull();
    expect(await client.hasSubIssues(REPO, 1)).toBe(false);
  });

  it("roundtrips close and reopen state reasons between FakeIssueClient and LocalTracker", async () => {
    const { tracker, client } = setup();
    await tracker.createIssue({ title: "x", body: "y" });

    // close defaults to "completed"
    await client.closeIssue(REPO, 1);
    let issue = await client.getIssue(REPO, 1);
    expect(issue.state).toBe("closed");
    expect(issue.stateReason).toBe("completed");

    // reopen clears it to "reopened"
    await client.reopenIssue(REPO, 1);
    issue = await client.getIssue(REPO, 1);
    expect(issue.state).toBe("open");
    expect(issue.stateReason).toBe("reopened");

    // explicit close reason
    await client.closeIssue(REPO, 1, "not_planned");
    issue = await client.getIssue(REPO, 1);
    expect(issue.state).toBe("closed");
    expect(issue.stateReason).toBe("not_planned");
  });
});
