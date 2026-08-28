import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GitHubPollingIssueClient,
  IssueClient,
  PollIssueComment,
  PollIssueOrPullRequest,
} from "../gitops/issue-client.js";
import { GitBridgeIssueClient } from "../gitops/issue-client.js";
import { parseDirectedDeliveryDirective } from "../webhook/directed-delivery.js";
import { deriveGitHubInboxNotification } from "./inbox-notification.js";
import { GitHubEventPoller } from "./poller.js";

class MockPollIssueClient implements Partial<GitHubPollingIssueClient> {
  issues: PollIssueOrPullRequest[] = [];
  comments: PollIssueComment[] = [];
  pollIssues = new Map<number, PollIssueOrPullRequest>();
  issueSinceCalls: string[] = [];
  commentSinceCalls: string[] = [];
  polledRepos: string[] = [];
  orgRepos = new Map<string, string[]>();
  branchHeads = new Map<string, string>();

  async listPollOrganizationRepositories(org: string): Promise<string[]> {
    return this.orgRepos.get(org) ?? [];
  }

  async getPollBranchHead(repo: string, branch: string): Promise<{ sha: string } | null> {
    const sha = this.branchHeads.get(`${repo}@${branch}`);
    return sha ? { sha } : null;
  }

  async listUpdatedIssuesAndPullRequests(
    _repo: string,
    since: string
  ): Promise<PollIssueOrPullRequest[]> {
    this.polledRepos.push(_repo);
    this.issueSinceCalls.push(since);
    return this.issues.filter((issue) => issue.updatedAt > since);
  }

  async listUpdatedIssueComments(_repo: string, since: string): Promise<PollIssueComment[]> {
    this.commentSinceCalls.push(since);
    return this.comments.filter((comment) => comment.updatedAt > since);
  }

  async getPollIssue(_repo: string, issueNumber: number): Promise<PollIssueOrPullRequest> {
    const issue = this.pollIssues.get(issueNumber);
    if (!issue) throw new Error(`missing issue ${issueNumber}`);
    return issue;
  }
}

describe("GitHubEventPoller", () => {
  let home = "";

  afterEach(() => {
    vi.useRealTimers();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("polls explicit repositories plus organization repositories and suppresses exclusions", async () => {
    home = mkdtempSync(join(tmpdir(), "rusa-github-poller-"));
    const client = new MockPollIssueClient();
    client.orgRepos.set("dummy-org", [
      "dummy-org/included",
      "dummy-org/excluded",
      "dummy-org/duplicate",
    ]);

    await new GitHubEventPoller({
      repos: ["dummy-org/duplicate", "other-org/explicit"],
      orgs: [{ org: "dummy-org", excludedRepos: ["dummy-org/excluded"] }],
      home,
      issueClient: client as GitHubPollingIssueClient,
      onEvent: async () => undefined,
    }).pollOnce();

    expect(client.polledRepos).toEqual([
      "dummy-org/duplicate",
      "other-org/explicit",
      "dummy-org/included",
    ]);
  });

  it("emits an exact branch push for a deploy repository outside the tracker feeds", async () => {
    home = mkdtempSync(join(tmpdir(), "rusa-github-poller-"));
    const client = new MockPollIssueClient();
    const branchKey = "example-org/service-repo@master";
    client.branchHeads.set(branchKey, "sha-before");
    const events: Array<{
      event: string;
      payload: Record<string, unknown>;
      deliveryId?: string;
    }> = [];
    const poller = new GitHubEventPoller({
      repos: ["example-org/tracker-repo"],
      deployRepo: "example-org/service-repo",
      deployBranch: "master",
      home,
      issueClient: client as GitHubPollingIssueClient,
      onEvent: async (event, payload, deliveryId) => {
        events.push({ event, payload, deliveryId });
      },
    });

    await poller.pollOnce();
    client.branchHeads.set(branchKey, "sha-after");
    await poller.pollOnce();

    expect(events).toEqual([
      {
        event: "push",
        payload: {
          before: "sha-before",
          after: "sha-after",
          ref: "refs/heads/master",
          repository: {
            full_name: "example-org/service-repo",
            name: "service-repo",
            owner: { login: "example-org" },
          },
        },
        deliveryId: "poll:example-org/service-repo:push:master:sha-after",
      },
    ]);
    expect(client.polledRepos).toEqual(["example-org/tracker-repo", "example-org/tracker-repo"]);
    expect(deriveGitHubInboxNotification("push", events[0].payload)?.resource).toEqual({
      kind: "github_branch",
      repo: "example-org/service-repo",
      ref: "refs/heads/master",
    });
  });

  it("maps a polled mesh:deliver issue comment to webhook-shaped payload", async () => {
    home = mkdtempSync(join(tmpdir(), "rusa-github-poller-"));
    const client = new MockPollIssueClient();
    client.comments = [
      {
        id: 10,
        issueNumber: 42,
        author: "mock-bot",
        body: "done\n<!-- mesh:deliver worker-1 -->",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:00:00.000Z",
      },
    ];
    client.pollIssues.set(42, {
      number: 42,
      title: "Work item",
      body: "issue body",
      author: "someone",
      state: "open",
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
      isPullRequest: false,
    });
    const events: Array<[string, Record<string, unknown>]> = [];

    await new GitHubEventPoller({
      repos: ["dummy-org/dummy-repo"],
      intervalSeconds: 300,
      home,
      issueClient: client as GitHubPollingIssueClient,
      onEvent: async (event, payload) => {
        events.push([event, payload]);
      },
    }).pollOnce();

    expect(events).toHaveLength(1);
    const [event, payload] = events[0];
    expect(event).toBe("issue_comment");
    expect(payload).toMatchObject({
      action: "created",
      repository: { full_name: "dummy-org/dummy-repo" },
      sender: { login: "mock-bot" },
      comment: {
        id: 10,
        body: "done\n<!-- mesh:deliver worker-1 -->",
        user: { login: "mock-bot" },
      },
      issue: { number: 42, body: "issue body" },
    });
    expect(parseDirectedDeliveryDirective((payload.comment as { body: string }).body)).toBe(
      "worker-1"
    );
  });

  it("maps PR comments with issue.pull_request so routing treats them as PR resources", async () => {
    home = mkdtempSync(join(tmpdir(), "rusa-github-poller-"));
    const client = new MockPollIssueClient();
    client.comments = [
      {
        id: 11,
        issueNumber: 7,
        author: "reviewer",
        body: "comment",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:00:00.000Z",
      },
    ];
    client.pollIssues.set(7, {
      number: 7,
      title: "PR",
      body: "pr issue wrapper",
      author: "author",
      state: "open",
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
      isPullRequest: true,
    });
    const events: Array<[string, Record<string, unknown>]> = [];

    await new GitHubEventPoller({
      repos: ["dummy-org/dummy-repo"],
      intervalSeconds: 300,
      home,
      issueClient: client as GitHubPollingIssueClient,
      onEvent: async (event, payload) => {
        events.push([event, payload]);
      },
    }).pollOnce();

    expect(events[0][1]).toMatchObject({
      issue: { number: 7, pull_request: {} },
      sender: { login: "reviewer" },
    });
  });

  it("maps PR-backed issue records to pull_request events", async () => {
    home = mkdtempSync(join(tmpdir(), "rusa-github-poller-"));
    const client = new MockPollIssueClient();
    client.issues = [
      {
        number: 9,
        title: "Poller PR",
        body: "pr body\n<!-- mesh:deliver worker-2 -->",
        author: "mock-bot",
        state: "open",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:01:00.000Z",
        isPullRequest: true,
      },
    ];
    const events: Array<[string, Record<string, unknown>]> = [];

    await new GitHubEventPoller({
      repos: ["dummy-org/dummy-repo"],
      intervalSeconds: 300,
      home,
      issueClient: client as GitHubPollingIssueClient,
      onEvent: async (event, payload) => {
        events.push([event, payload]);
      },
    }).pollOnce();

    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe("pull_request");
    expect(events[0][1]).toMatchObject({
      action: "edited",
      sender: { login: "mock-bot" },
      pull_request: {
        number: 9,
        body: "pr body\n<!-- mesh:deliver worker-2 -->",
        user: { login: "mock-bot" },
      },
    });
  });

  it("persists watermark and dedupes across restarts", async () => {
    home = mkdtempSync(join(tmpdir(), "rusa-github-poller-"));
    const client = new MockPollIssueClient();
    client.issues = [
      {
        number: 1,
        title: "One",
        body: "body",
        author: "author",
        state: "open",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:01:00.000Z",
        isPullRequest: false,
      },
    ];
    const events: Array<[string, Record<string, unknown>]> = [];
    const makePoller = () =>
      new GitHubEventPoller({
        repos: ["dummy-org/dummy-repo"],
        intervalSeconds: 300,
        home,
        issueClient: client as GitHubPollingIssueClient,
        onEvent: async (event, payload) => {
          events.push([event, payload]);
        },
      });

    await makePoller().pollOnce();
    await makePoller().pollOnce();

    expect(events).toHaveLength(1);
    expect(client.issueSinceCalls).toEqual([
      "1970-01-01T00:00:00.000Z",
      "2026-07-03T00:01:00.000Z",
    ]);
    expect(client.commentSinceCalls).toEqual([
      "1970-01-01T00:00:00.000Z",
      "1970-01-01T00:00:00.000Z",
    ]);
    expect(readFileSync(join(home, "github-poller-state.json"), "utf-8")).toContain(
      '"issuesWatermark": "2026-07-03T00:01:00.000Z"'
    );
  });

  it("tracks issue/PR and comment watermarks independently", async () => {
    home = mkdtempSync(join(tmpdir(), "rusa-github-poller-"));
    const client = new MockPollIssueClient();
    client.issues = [
      {
        number: 1,
        title: "One",
        body: "body",
        author: "author",
        state: "open",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:10:00.000Z",
        isPullRequest: false,
      },
    ];
    client.comments = [
      {
        id: 20,
        issueNumber: 1,
        author: "commenter",
        body: "late comment",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:05:00.000Z",
      },
    ];
    client.pollIssues.set(1, client.issues[0]);
    const events: Array<[string, Record<string, unknown>]> = [];
    const makePoller = () =>
      new GitHubEventPoller({
        repos: ["dummy-org/dummy-repo"],
        intervalSeconds: 300,
        home,
        issueClient: client as GitHubPollingIssueClient,
        onEvent: async (event, payload) => {
          events.push([event, payload]);
        },
      });

    await makePoller().pollOnce();
    await makePoller().pollOnce();

    expect(events.map(([event]) => event).sort()).toEqual(["issue_comment", "issues"]);
    expect(client.issueSinceCalls).toEqual([
      "1970-01-01T00:00:00.000Z",
      "2026-07-03T00:10:00.000Z",
    ]);
    expect(client.commentSinceCalls).toEqual([
      "1970-01-01T00:00:00.000Z",
      "2026-07-03T00:05:00.000Z",
    ]);
  });

  it("polls on the configured interval", async () => {
    vi.useFakeTimers();
    home = mkdtempSync(join(tmpdir(), "rusa-github-poller-"));
    const client = new MockPollIssueClient();
    const poller = new GitHubEventPoller({
      repos: ["dummy-org/dummy-repo"],
      intervalSeconds: 12,
      home,
      issueClient: client as GitHubPollingIssueClient,
      onEvent: async () => {},
    });

    poller.start();
    await Promise.resolve();
    expect(client.issueSinceCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(client.issueSinceCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.issueSinceCalls).toHaveLength(2);
    poller.close();
  });

  it("falls back to a 300s interval when none is supplied, instead of a hot loop ", async () => {
    vi.useFakeTimers();
    home = mkdtempSync(join(tmpdir(), "rusa-github-poller-"));
    const client = new MockPollIssueClient();
    const poller = new GitHubEventPoller({
      repos: ["dummy-org/dummy-repo"],
      // intervalSeconds deliberately absent — this is the config.yaml-omits-the-key
      // case. Before the fix it multiplied out to NaN, which setInterval coerces
      // to 0, so the assertions below would see hundreds of polls rather than one.
      home,
      issueClient: client as GitHubPollingIssueClient,
      onEvent: async () => {},
    });

    poller.start();
    await Promise.resolve();
    expect(client.issueSinceCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(client.issueSinceCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.issueSinceCalls).toHaveLength(2);
    poller.close();
  });

  it("forwards poll methods through a GitBridgeIssueClient delegate ", async () => {
    home = mkdtempSync(join(tmpdir(), "rusa-github-poller-"));

    const delegate = new RecordingBridgeDelegate();
    delegate.comments = [
      {
        id: 30,
        issueNumber: 1218,
        author: "mock-bot",
        body: "ack",
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
    ];
    delegate.pollIssues.set(1218, {
      number: 1218,
      title: "Bridge poll regression",
      body: "body",
      author: "author",
      state: "open",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      isPullRequest: false,
    });

    const bridgeClient = new GitBridgeIssueClient(delegate, { port: 9091 });
    const events: Array<[string, Record<string, unknown>]> = [];

    await new GitHubEventPoller({
      repos: ["dummy-org/dummy-repo"],
      deployRepo: "dummy-org/dummy-repo",
      intervalSeconds: 300,
      home,
      issueClient: bridgeClient,
      onEvent: async (event, payload) => {
        events.push([event, payload]);
      },
    }).pollOnce();

    expect(delegate.calls).toEqual([
      {
        method: "listUpdatedIssuesAndPullRequests",
        repo: "dummy-org/dummy-repo",
        since: "1970-01-01T00:00:00.000Z",
      },
      {
        method: "listUpdatedIssueComments",
        repo: "dummy-org/dummy-repo",
        since: "1970-01-01T00:00:00.000Z",
      },
      { method: "getPollIssue", repo: "dummy-org/dummy-repo", issueNumber: 1218 },
      { method: "getPollBranchHead", repo: "dummy-org/dummy-repo", branch: "master" },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe("issue_comment");
  });
});

class RecordingBridgeDelegate implements IssueClient, GitHubPollingIssueClient {
  calls: Array<
    | { method: "listPollOrganizationRepositories"; org: string }
    | { method: "getPollBranchHead"; repo: string; branch: string }
    | { method: "listUpdatedIssuesAndPullRequests"; repo: string; since: string }
    | { method: "listUpdatedIssueComments"; repo: string; since: string }
    | { method: "getPollIssue"; repo: string; issueNumber: number }
  > = [];
  comments: PollIssueComment[] = [];
  pollIssues = new Map<number, PollIssueOrPullRequest>();

  async listPollOrganizationRepositories(org: string): Promise<string[]> {
    this.calls.push({ method: "listPollOrganizationRepositories", org });
    return [];
  }

  async getPollBranchHead(repo: string, branch: string): Promise<null> {
    this.calls.push({ method: "getPollBranchHead", repo, branch });
    return null;
  }

  async listUpdatedIssuesAndPullRequests(
    repo: string,
    since: string
  ): Promise<PollIssueOrPullRequest[]> {
    this.calls.push({ method: "listUpdatedIssuesAndPullRequests", repo, since });
    return [];
  }

  async listUpdatedIssueComments(repo: string, since: string): Promise<PollIssueComment[]> {
    this.calls.push({ method: "listUpdatedIssueComments", repo, since });
    return this.comments;
  }

  async getPollIssue(repo: string, issueNumber: number): Promise<PollIssueOrPullRequest> {
    this.calls.push({ method: "getPollIssue", repo, issueNumber });
    const issue = this.pollIssues.get(issueNumber);
    if (!issue) throw new Error(`missing issue ${issueNumber}`);
    return issue;
  }

  // IssueClient stub surface: the bridge also delegates these, but this test
  // targets the poll methods that were previously missing.
  createPullRequest = notImplemented;
  createIssue = notImplemented;
  getOpenPullRequestsByAuthor = notImplemented;
  getOpenPullRequests = notImplemented;
  listIssues = notImplemented;
  getPullRequestDetails = notImplemented;
  getPullRequestChecksStatus = notImplemented;
  getIssue = notImplemented;
  listIssueComments = notImplemented;
  postComment = notImplemented;
  updateIssueBody = notImplemented;
  addLabel = notImplemented;
  removeLabel = notImplemented;
  closeIssue = notImplemented;
  reopenIssue = notImplemented;
  mergePullRequest = notImplemented;
  createPullRequestReview = notImplemented;
  createPrReviewComment = notImplemented;
  addReaction = notImplemented;
  addCommentReaction = notImplemented;
  getPrReviewComments = notImplemented;
  getParentIssueNumber = notImplemented;
  getRootIssueNumber = notImplemented;
  hasSubIssues = notImplemented;
  addSubIssue = notImplemented;
  removeSubIssue = notImplemented;
}

function notImplemented(..._args: unknown[]): never {
  throw new Error("not implemented in test delegate");
}
