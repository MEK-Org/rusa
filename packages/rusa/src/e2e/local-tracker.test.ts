import { describe, expect, it, vi } from "vitest";
import { LocalTracker } from "./local-tracker.js";

function makeTracker(onEvent?: (e: string, p: Record<string, unknown>) => void) {
  return new LocalTracker({
    repo: "rusa-e2e/scratch",
    baseUrl: "http://localhost:8084",
    botAccount: "rusa-e2e-bot",
    onEvent,
  });
}

describe("LocalTracker", () => {
  it("files an issue assigned to the bot and emits an active issues event", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const tracker = makeTracker((type, payload) => events.push({ type, payload }));

    const issue = await tracker.createIssue({ title: "Add a greeting", body: "Please add hello" });

    expect(issue.number).toBe(1);
    expect(issue.htmlUrl).toBe("http://localhost:8084/rusa-e2e/scratch/issues/1");
    expect(issue.assignees).toEqual(["rusa-e2e-bot"]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("issues");
    const payload = events[0].payload as {
      action: string;
      issue: { number: number; assignees: Array<{ login: string }> };
      repository: { full_name: string };
    };
    expect(payload.action).toBe("opened");
    expect(payload.issue.number).toBe(1);
    expect(payload.issue.assignees).toEqual([{ login: "rusa-e2e-bot" }]);
    expect(payload.repository.full_name).toBe("rusa-e2e/scratch");
  });

  it("leaves an issue unassigned when assign is false", async () => {
    const tracker = makeTracker();
    const issue = await tracker.createIssue({ title: "x", body: "y", assign: false });
    expect(issue.assignees).toEqual([]);
  });

  it("shares one numbering space between issues and PRs", async () => {
    const tracker = makeTracker();
    await tracker.createIssue({ title: "one", body: "" });
    const pr = tracker.upsertPrByHead({
      headRef: "mc/issue-1",
      title: "PR",
      body: "",
      base: "main",
      author: "rusa-e2e-bot",
    });
    expect(pr.number).toBe(2);
    expect(pr.htmlUrl).toBe("http://localhost:8084/rusa-e2e/scratch/pull/2");
  });

  it("emits an issue_comment event for agent comments but not for recorded ones", async () => {
    const onEvent = vi.fn();
    const tracker = makeTracker(onEvent);
    await tracker.createIssue({ title: "x", body: "y" });
    onEvent.mockClear();

    await tracker.addIssueComment(1, { body: "what about edge cases?", author: "reviewer" });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toBe("issue_comment");
    const payload = onEvent.mock.calls[0][1] as {
      comment: { body: string; user: { login: string } };
    };
    expect(payload.comment.body).toBe("what about edge cases?");
    expect(payload.comment.user.login).toBe("reviewer");

    onEvent.mockClear();
    tracker.recordComment(1, { body: "orchestrator reply", author: "rusa-e2e-bot" });
    expect(onEvent).not.toHaveBeenCalled();
    expect(tracker.getIssue(1)?.comments).toHaveLength(2);
  });

  it("upserts a PR for an existing head branch rather than duplicating", () => {
    const tracker = makeTracker();
    const first = tracker.upsertPrByHead({
      headRef: "mc/issue-1",
      title: "Initial",
      body: "v1",
      base: "main",
      author: "bot",
    });
    const second = tracker.upsertPrByHead({
      headRef: "mc/issue-1",
      title: "Updated",
      body: "v2",
      base: "staging",
      author: "bot",
    });
    expect(second.number).toBe(first.number);
    expect(tracker.listPrs()).toHaveLength(1);
    expect(tracker.getPr(first.number)?.title).toBe("Updated");
    expect(tracker.getPr(first.number)?.base).toBe("staging");

    // Preserves base when base is omitted on update
    const third = tracker.upsertPrByHead({
      headRef: "mc/issue-1",
      title: "Updated again",
      body: "v3",
      author: "bot",
    });
    expect(third.number).toBe(first.number);
    expect(tracker.getPr(first.number)?.base).toBe("staging");
  });

  it("models sub-issue hierarchy with a plain parent pointer", async () => {
    const tracker = makeTracker();
    const root = await tracker.createIssue({ title: "feature", body: "" });
    expect(tracker.getParent(root.number)).toBeNull();
    expect(tracker.getRoot(root.number)).toBeNull();
    expect(tracker.hasChildren(root.number)).toBe(false);
  });

  it("emits a submitted pull_request_review event when a review is filed", async () => {
    const onEvent = vi.fn();
    const tracker = makeTracker(onEvent);
    tracker.upsertPrByHead({
      headRef: "mc/issue-1",
      title: "PR",
      body: "",
      base: "main",
      author: "rusa-e2e-bot",
    });
    onEvent.mockClear();

    const review = await tracker.submitReview(1, {
      state: "changes_requested",
      body: "Rename greet to hello",
      author: "reviewer",
      comments: [{ path: "src/index.ts", line: 3, body: "use hello()", diffHunk: "@@ -1 +1 @@" }],
    });

    expect(review.id).toBe(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toBe("pull_request_review");
    const payload = onEvent.mock.calls[0][1] as {
      action: string;
      review: { id: number; state: string; body: string; user: { login: string } };
      pull_request: { number: number; head: { ref: string } };
      repository: { full_name: string };
    };
    expect(payload.action).toBe("submitted");
    expect(payload.review.state).toBe("changes_requested");
    expect(payload.review.user.login).toBe("reviewer");
    expect(payload.pull_request.number).toBe(1);
    expect(payload.pull_request.head.ref).toBe("mc/issue-1");
    expect(payload.repository.full_name).toBe("rusa-e2e/scratch");
  });

  it("returns inline review comments by review id", async () => {
    const tracker = makeTracker();
    tracker.upsertPrByHead({
      headRef: "mc/issue-1",
      title: "PR",
      body: "",
      base: "main",
      author: "rusa-e2e-bot",
    });
    const review = await tracker.submitReview(1, {
      state: "commented",
      comments: [{ path: "a.ts", line: null, body: "nit", diffHunk: "@@" }],
    });
    expect(tracker.getReviewComments(1, review.id)).toEqual([
      { path: "a.ts", line: null, body: "nit", diffHunk: "@@" },
    ]);
    expect(tracker.getReviewComments(1, 999)).toEqual([]);
    expect(tracker.listReviews(1)).toHaveLength(1);
  });

  it("computes a PR diff as a real git diff against the bare remote", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = mkdtempSync(join(tmpdir(), "tracker-diff-"));
    const remotePath = join(root, "repo.git");
    const work = join(root, "work");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    execFileSync("git", ["init", "--bare", "-b", "main", remotePath]);
    mkdirSync(work);
    execFileSync("git", ["init", "-b", "main", work]);
    writeFileSync(join(work, "f.txt"), "hello\n");
    git(work, "add", ".");
    git(work, "commit", "-m", "init");
    git(work, "remote", "add", "origin", remotePath);
    git(work, "push", "origin", "main");
    git(work, "checkout", "-b", "mc/issue-1");
    writeFileSync(join(work, "f.txt"), "hello world\n");
    git(work, "commit", "-am", "change");
    git(work, "push", "origin", "mc/issue-1");

    const tracker = new LocalTracker({
      repo: "rusa-e2e/scratch",
      baseUrl: "http://localhost:8084",
      botAccount: "rusa-e2e-bot",
      remotePath,
    });
    tracker.upsertPrByHead({
      headRef: "mc/issue-1",
      title: "PR",
      body: "",
      base: "main",
      author: "rusa-e2e-bot",
    });
    const diff = tracker.getPrDiff(1);
    expect(diff).toContain("-hello");
    expect(diff).toContain("+hello world");
  });

  it("throws a clear error when asked for a diff with no bare remote", () => {
    const tracker = makeTracker();
    tracker.upsertPrByHead({
      headRef: "mc/issue-1",
      title: "PR",
      body: "",
      base: "main",
      author: "rusa-e2e-bot",
    });
    expect(() => tracker.getPrDiff(1)).toThrow(/no bare remote/);
  });
});
