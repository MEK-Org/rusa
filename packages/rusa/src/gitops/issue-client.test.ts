import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitBridgeIssueClient,
  GitHubApiError,
  GitHubIssueClient,
  type GitHubPollingIssueClient,
  type IssueClient,
  PullRequestChecksUnreadableError,
  PullRequestHeadAdvancedError,
} from "./issue-client.js";

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Route-table fetch mock: maps "METHOD /path" to a response. The client is
 * tested at the HTTP boundary — request shapes out, GitHub wire shapes in.
 */
function installFetch(routes: Record<string, { status?: number; json?: unknown }>) {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace("https://api.github.com", "");
      const method = init?.method ?? "GET";
      requests.push({
        method,
        path,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const route = routes[`${method} ${path}`];
      if (!route) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      return new Response(route.json !== undefined ? JSON.stringify(route.json) : "", {
        status: route.status ?? 200,
      });
    })
  );
  return requests;
}

const REPO = "test-org/test-repo";

describe("GitHubIssueClient", () => {
  beforeEach(() => {
    // Token comes from the env (gh's own precedence); no `gh` exec in tests.
    vi.stubEnv("GH_TOKEN", "test-token-123");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends the auth context on every call", async () => {
    const requests = installFetch({
      [`POST /repos/${REPO}/issues/7/comments`]: { status: 201, json: { id: 1 } },
    });

    await new GitHubIssueClient().postComment(REPO, 7, "hello");

    expect(requests).toHaveLength(1);
    expect(requests[0].headers.Authorization).toBe("Bearer test-token-123");
    expect(requests[0].headers.Accept).toBe("application/vnd.github+json");
    expect(requests[0].body).toEqual({ body: "hello" });
  });

  it("lists organization repositories for poll scope expansion", async () => {
    const requests = installFetch({
      "GET /orgs/test-org/repos?type=all&per_page=100&page=1": {
        json: [{ full_name: "test-org/one" }, { full_name: "test-org/two" }],
      },
    });

    await expect(
      new GitHubIssueClient().listPollOrganizationRepositories("test-org")
    ).resolves.toEqual(["test-org/one", "test-org/two"]);
    expect(requests[0].path).toBe("/orgs/test-org/repos?type=all&per_page=100&page=1");
  });

  it("reads a deploy branch head and treats an absent branch as no head", async () => {
    installFetch({
      [`GET /repos/${REPO}/branches/release%2Fprod`]: { json: { commit: { sha: "abc123" } } },
      [`GET /repos/${REPO}/branches/missing`]: { status: 404, json: { message: "Not Found" } },
    });
    const client = new GitHubIssueClient();

    await expect(client.getPollBranchHead(REPO, "release/prod")).resolves.toEqual({
      sha: "abc123",
    });
    await expect(client.getPollBranchHead(REPO, "missing")).resolves.toBeNull();
  });

  it("can read a PAT from RUSA_HOME/github-token without GH_TOKEN", async () => {
    vi.unstubAllEnvs();
    const home = mkdtempSync(join(tmpdir(), "rusa-gh-token-"));
    vi.stubEnv("RUSA_HOME", home);
    writeFileSync(join(home, "github-token"), "file-token-456\n", { mode: 0o600 });
    const requests = installFetch({
      [`POST /repos/${REPO}/issues/7/comments`]: { status: 201, json: { id: 1 } },
    });

    await new GitHubIssueClient().postComment(REPO, 7, "hello");

    expect(requests[0].headers.Authorization).toBe("Bearer file-token-456");
  });

  it("creates an issue with optional labels", async () => {
    const requests = installFetch({
      [`POST /repos/${REPO}/issues`]: {
        status: 201,
        json: { number: 44, html_url: `https://github.com/${REPO}/issues/44` },
      },
    });

    const issue = await new GitHubIssueClient().createIssue({
      repo: REPO,
      title: "New issue",
      body: "Issue body",
      labels: ["bug", "triage"],
    });

    expect(issue).toEqual({ number: 44, htmlUrl: `https://github.com/${REPO}/issues/44` });
    expect(requests[0].body).toEqual({
      title: "New issue",
      body: "Issue body",
      labels: ["bug", "triage"],
    });
  });

  it("updates an issue body", async () => {
    const requests = installFetch({
      [`PATCH /repos/${REPO}/issues/44`]: { json: {} },
    });

    await new GitHubIssueClient().updateIssueBody(REPO, 44, "Updated body");

    expect(requests[0].body).toEqual({ body: "Updated body" });
  });

  it("creates a PR with reviewer when none exists for the head branch", async () => {
    const requests = installFetch({
      [`GET /repos/${REPO}/pulls?head=${encodeURIComponent("test-org:mc/issue-9")}&state=open&per_page=1`]:
        { json: [] },
      [`POST /repos/${REPO}/pulls`]: {
        status: 201,
        json: { number: 12, html_url: "https://github.com/test-org/test-repo/pull/12" },
      },
      [`POST /repos/${REPO}/pulls/12/requested_reviewers`]: { status: 201, json: {} },
    });

    const pr = await new GitHubIssueClient().createPullRequest({
      repo: REPO,
      head: "mc/issue-9",
      title: "Add feature",
      body: "Adds it.",
      reviewer: "operator",
      base: "master",
    });

    expect(pr).toEqual({
      number: 12,
      htmlUrl: "https://github.com/test-org/test-repo/pull/12",
    });
    const create = requests.find((r) => r.path === `/repos/${REPO}/pulls` && r.method === "POST");
    expect(create?.body).toEqual({
      title: "Add feature",
      body: "Adds it.",
      head: "mc/issue-9",
      base: "master",
    });
    const reviewers = requests.find((r) => r.path.endsWith("/requested_reviewers"));
    expect(reviewers?.body).toEqual({ reviewers: ["operator"] });
  });

  it("requests no reviewer at all when none is given ", async () => {
    // Deliberately does NOT stub requested_reviewers: the assertion is that the
    // call is never made, not that it is made and ignored.
    const requests = installFetch({
      [`GET /repos/${REPO}/pulls?head=${encodeURIComponent("test-org:mc/issue-9")}&state=open&per_page=1`]:
        { json: [] },
      [`POST /repos/${REPO}/pulls`]: {
        status: 201,
        json: { number: 12, html_url: "https://github.com/test-org/test-repo/pull/12" },
      },
    });

    const pr = await new GitHubIssueClient().createPullRequest({
      repo: REPO,
      head: "mc/issue-9",
      title: "Add feature",
      body: "Adds it.",
      base: "master",
    });

    expect(pr).toEqual({
      number: 12,
      htmlUrl: "https://github.com/test-org/test-repo/pull/12",
    });
    expect(requests.some((r) => r.path.endsWith("/requested_reviewers"))).toBe(false);
  });

  it("updates the existing PR including base retarget instead of creating a second one", async () => {
    const requests = installFetch({
      [`GET /repos/${REPO}/pulls?head=${encodeURIComponent("test-org:mc/issue-9")}&state=open&per_page=1`]:
        { json: [{ number: 12, html_url: "https://github.com/test-org/test-repo/pull/12" }] },
      [`PATCH /repos/${REPO}/pulls/12`]: { json: {} },
    });

    const pr = await new GitHubIssueClient().createPullRequest({
      repo: REPO,
      head: "mc/issue-9",
      title: "Updated title",
      body: "Updated body.",
      reviewer: "operator",
      base: "staging",
    });

    expect(pr).toEqual({
      number: 12,
      htmlUrl: "https://github.com/test-org/test-repo/pull/12",
    });
    expect(requests.some((r) => r.method === "POST")).toBe(false);
    const patch = requests.find((r) => r.method === "PATCH");
    expect(patch?.body).toEqual({
      title: "Updated title",
      body: "Updated body.",
      base: "staging",
    });
  });

  it("updates the existing PR preserving base when base is omitted", async () => {
    const requests = installFetch({
      [`GET /repos/${REPO}/pulls?head=${encodeURIComponent("test-org:mc/issue-9")}&state=open&per_page=1`]:
        { json: [{ number: 12, html_url: "https://github.com/test-org/test-repo/pull/12" }] },
      [`PATCH /repos/${REPO}/pulls/12`]: { json: {} },
    });

    const pr = await new GitHubIssueClient().createPullRequest({
      repo: REPO,
      head: "mc/issue-9",
      title: "Updated title",
      body: "Updated body.",
      reviewer: "operator",
    });

    expect(pr).toEqual({
      number: 12,
      htmlUrl: "https://github.com/test-org/test-repo/pull/12",
    });
    expect(requests.some((r) => r.method === "POST")).toBe(false);
    const patch = requests.find((r) => r.method === "PATCH");
    expect(patch?.body).toEqual({ title: "Updated title", body: "Updated body." });
  });

  it("surfaces error when retargeting PR base fails on GitHub", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls?head=${encodeURIComponent("test-org:mc/issue-9")}&state=open&per_page=1`]:
        { json: [{ number: 12, html_url: "https://github.com/test-org/test-repo/pull/12" }] },
      [`PATCH /repos/${REPO}/pulls/12`]: {
        status: 422,
        json: { message: "Validation Failed", errors: [{ message: "Base branch does not exist" }] },
      },
    });

    await expect(
      new GitHubIssueClient().createPullRequest({
        repo: REPO,
        head: "mc/issue-9",
        title: "Updated title",
        body: "Updated body.",
        base: "nonexistent-branch",
      })
    ).rejects.toThrow(GitHubApiError);
  });

  it("resolves the repo default branch when base is omitted (REST requires one)", async () => {
    const requests = installFetch({
      [`GET /repos/${REPO}/pulls?head=${encodeURIComponent("test-org:mc/issue-9")}&state=open&per_page=1`]:
        { json: [] },
      [`GET /repos/${REPO}`]: { json: { default_branch: "develop" } },
      [`POST /repos/${REPO}/pulls`]: {
        status: 201,
        json: { number: 13, html_url: "https://github.com/test-org/test-repo/pull/13" },
      },
      [`POST /repos/${REPO}/pulls/13/requested_reviewers`]: { status: 201, json: {} },
    });

    await new GitHubIssueClient().createPullRequest({
      repo: REPO,
      head: "mc/issue-9",
      title: "t",
      body: "b",
      reviewer: "operator",
    });

    const create = requests.find((r) => r.path === `/repos/${REPO}/pulls` && r.method === "POST");
    expect((create?.body as { base: string }).base).toBe("develop");
  });

  it("git-bridge createPullRequest returns local metadata without REST calls", async () => {
    const delegateCalls: string[] = [];
    const delegate = {
      ...({} as IssueClient & GitHubPollingIssueClient),
      createPullRequest: async () => {
        delegateCalls.push("createPullRequest");
        return { number: 1, htmlUrl: "https://github.example/pr/1" };
      },
    };
    const requests = installFetch({});

    const result = await new GitBridgeIssueClient(delegate, { port: 9091 }).createPullRequest({
      repo: REPO,
      head: "mc/issue-9",
      title: "t",
      body: "b",
      reviewer: "operator",
      base: "staging",
    });

    // No PR exists on the bridge path: number is the 0 placeholder and the
    // instructions stand in for the URL.
    expect(result.number).toBe(0);
    expect(result.htmlUrl).toContain(
      "http://localhost:9091/test-org/test-repo/compare/mc%2Fissue-9"
    );
    expect(result.htmlUrl).toContain("git fetch rusa");
    expect(result.htmlUrl).toContain("git diff staging...rusa/mc/issue-9");
    expect(delegateCalls).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("reads an issue's content, defaulting a null body to empty and capturing state_reason", async () => {
    installFetch({
      [`GET /repos/${REPO}/issues/506`]: {
        json: {
          number: 506,
          title: "Clean up legacy code..",
          body: null,
          state: "closed",
          state_reason: "not_planned",
          user: { login: "AlabasterAxe" },
        },
      },
    });

    const issue = await new GitHubIssueClient().getIssue(REPO, 506);
    expect(issue).toEqual({
      number: 506,
      title: "Clean up legacy code..",
      body: "",
      state: "closed",
      stateReason: "not_planned",
      author: "AlabasterAxe",
    });
  });

  it("lists issue comments mapped from the wire shape", async () => {
    installFetch({
      [`GET /repos/${REPO}/issues/506/comments?per_page=100&page=1`]: {
        json: [
          { id: 1, body: "first", user: { login: "operator" }, created_at: "2026-06-19T00:00:00Z" },
          { id: 2, body: null, user: null, created_at: "2026-06-19T01:00:00Z" },
        ],
      },
    });

    const comments = await new GitHubIssueClient().listIssueComments(REPO, 506);
    expect(comments).toEqual([
      { id: 1, author: "operator", body: "first", createdAt: "2026-06-19T00:00:00Z" },
      { id: 2, author: "", body: "", createdAt: "2026-06-19T01:00:00Z" },
    ]);
  });

  it("paginates issue comments until the final short page", async () => {
    installFetch({
      [`GET /repos/${REPO}/issues/506/comments?per_page=100&page=1`]: {
        json: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          body: `page 1 comment ${index + 1}`,
          user: { login: "bot" },
          created_at: "2026-06-19T00:00:00Z",
        })),
      },
      [`GET /repos/${REPO}/issues/506/comments?per_page=100&page=2`]: {
        json: [
          {
            id: 101,
            body: "owner update",
            user: { login: "cloudy-porpoise" },
            created_at: "2026-06-20T00:00:00Z",
          },
        ],
      },
    });

    const comments = await new GitHubIssueClient().listIssueComments(REPO, 506);
    expect(comments).toHaveLength(101);
    expect(comments.at(-1)).toMatchObject({
      id: 101,
      author: "cloudy-porpoise",
      body: "owner update",
    });
  });

  it("posts a reaction with the chosen content", async () => {
    const requests = installFetch({
      [`POST /repos/${REPO}/issues/506/reactions`]: { status: 201, json: { id: 1 } },
    });

    await new GitHubIssueClient().addReaction(REPO, 506, "eyes");
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({ content: "eyes" });
  });

  it("adds labels and closes issues via GitHub issues endpoints", async () => {
    const requests = installFetch({
      [`POST /repos/${REPO}/issues/506/labels`]: { status: 200, json: [] },
      [`PATCH /repos/${REPO}/issues/506`]: { json: { state: "closed" } },
    });

    const client = new GitHubIssueClient();
    await client.addLabel(REPO, 506, "owner:cloudy-porpoise");
    await client.closeIssue(REPO, 506);

    expect(requests.map((request) => [request.method, request.path, request.body])).toEqual([
      ["POST", `/repos/${REPO}/issues/506/labels`, { labels: ["owner:cloudy-porpoise"] }],
      ["PATCH", `/repos/${REPO}/issues/506`, { state: "closed" }],
    ]);
  });

  it("closes an issue with a state_reason", async () => {
    const requests = installFetch({
      [`PATCH /repos/${REPO}/issues/506`]: {
        json: { state: "closed", state_reason: "not_planned" },
      },
    });

    await new GitHubIssueClient().closeIssue(REPO, 506, "not_planned");

    expect(requests.map((request) => [request.method, request.path, request.body])).toEqual([
      ["PATCH", `/repos/${REPO}/issues/506`, { state: "closed", state_reason: "not_planned" }],
    ]);
  });

  it("removes a label via DELETE on the named-label endpoint", async () => {
    const requests = installFetch({
      [`DELETE /repos/${REPO}/issues/506/labels/${encodeURIComponent("owner:cloudy-porpoise")}`]: {
        status: 200,
        json: [],
      },
    });

    await new GitHubIssueClient().removeLabel(REPO, 506, "owner:cloudy-porpoise");

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("DELETE");
    expect(requests[0].path).toBe(
      `/repos/${REPO}/issues/506/labels/${encodeURIComponent("owner:cloudy-porpoise")}`
    );
  });

  it("reopens an issue via PATCH state:open", async () => {
    const requests = installFetch({
      [`PATCH /repos/${REPO}/issues/506`]: { json: { state: "open" } },
    });

    await new GitHubIssueClient().reopenIssue(REPO, 506);

    expect(requests).toEqual([
      expect.objectContaining({
        method: "PATCH",
        path: `/repos/${REPO}/issues/506`,
        body: { state: "open" },
      }),
    ]);
  });

  it("merges a pull request, deleting the head branch by default", async () => {
    const requests = installFetch({
      [`GET /repos/${REPO}/pulls/12`]: {
        json: {
          number: 12,
          title: "Add feature",
          body: "",
          html_url: `https://github.com/${REPO}/pull/12`,
          head: { ref: "mc/issue-9" },
          state: "open",
        },
      },
      [`PUT /repos/${REPO}/pulls/12/merge`]: {
        json: { sha: "deadbeef", merged: true, message: "merged" },
      },
      [`DELETE /repos/${REPO}/git/refs/heads/${encodeURIComponent("mc/issue-9")}`]: {
        status: 200,
      },
    });

    const sha = await new GitHubIssueClient().mergePullRequest({
      repo: REPO,
      prNumber: 12,
      method: "squash",
      deleteBranch: true,
    });

    expect(sha).toBe("deadbeef");
    expect(requests.map((r) => [r.method, r.path])).toEqual([
      ["GET", `/repos/${REPO}/pulls/12`],
      ["PUT", `/repos/${REPO}/pulls/12/merge`],
      ["DELETE", `/repos/${REPO}/git/refs/heads/${encodeURIComponent("mc/issue-9")}`],
    ]);
    const merge = requests.find((r) => r.method === "PUT");
    expect(merge?.body).toEqual({ merge_method: "squash" });
  });

  it("merges a pull request without touching the branch when deleteBranch is false", async () => {
    const requests = installFetch({
      [`PUT /repos/${REPO}/pulls/12/merge`]: {
        json: { sha: "cafebabe", merged: true, message: "merged" },
      },
    });

    const sha = await new GitHubIssueClient().mergePullRequest({
      repo: REPO,
      prNumber: 12,
      method: "rebase",
      deleteBranch: false,
    });

    expect(sha).toBe("cafebabe");
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({ merge_method: "rebase" });
  });

  it("passes an override commit message into the squash merge request", async () => {
    const requests = installFetch({
      [`PUT /repos/${REPO}/pulls/12/merge`]: {
        json: { sha: "cafebabe", merged: true, message: "merged" },
      },
    });

    await new GitHubIssueClient().mergePullRequest({
      repo: REPO,
      prNumber: 12,
      method: "squash",
      deleteBranch: false,
      commitMessage: "Merged over non-green checks by actor. Reason: emergency",
    });

    expect(requests[0].body).toEqual({
      merge_method: "squash",
      commit_message: "Merged over non-green checks by actor. Reason: emergency",
    });
  });

  it("passes the expected head sha into the merge request", async () => {
    const requests = installFetch({
      [`PUT /repos/${REPO}/pulls/12/merge`]: {
        json: { sha: "cafebabe", merged: true, message: "merged" },
      },
    });

    await new GitHubIssueClient().mergePullRequest({
      repo: REPO,
      prNumber: 12,
      method: "squash",
      deleteBranch: false,
      expectedHeadSha: "evaluated-head-sha",
    });

    expect(requests[0].body).toEqual({
      merge_method: "squash",
      sha: "evaluated-head-sha",
    });
  });

  it("maps a merge 409 with expected head sha to a head-advanced error", async () => {
    installFetch({
      [`PUT /repos/${REPO}/pulls/12/merge`]: {
        status: 409,
        json: { message: "Head branch was modified. Review and try the merge again." },
      },
    });

    await expect(
      new GitHubIssueClient().mergePullRequest({
        repo: REPO,
        prNumber: 12,
        method: "squash",
        deleteBranch: false,
        expectedHeadSha: "evaluated-head-sha",
      })
    ).rejects.toThrow(PullRequestHeadAdvancedError);
  });

  it("does not map a merge-conflict 409 to a head-advanced error", async () => {
    installFetch({
      [`PUT /repos/${REPO}/pulls/12/merge`]: {
        status: 409,
        json: { message: "Pull Request is not mergeable" },
      },
    });

    try {
      await new GitHubIssueClient().mergePullRequest({
        repo: REPO,
        prNumber: 12,
        method: "squash",
        deleteBranch: false,
        expectedHeadSha: "evaluated-head-sha",
      });
      throw new Error("Expected merge to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect(err).not.toBeInstanceOf(PullRequestHeadAdvancedError);
    }
  });

  it("tolerates an already-deleted head branch after merge", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/12`]: {
        json: {
          number: 12,
          title: "Add feature",
          body: "",
          html_url: `https://github.com/${REPO}/pull/12`,
          head: { ref: "mc/issue-9" },
          state: "open",
        },
      },
      [`PUT /repos/${REPO}/pulls/12/merge`]: {
        json: { sha: "deadbeef", merged: true, message: "merged" },
      },
      [`DELETE /repos/${REPO}/git/refs/heads/${encodeURIComponent("mc/issue-9")}`]: {
        status: 422,
        json: { message: "Reference does not exist" },
      },
    });

    await expect(
      new GitHubIssueClient().mergePullRequest({
        repo: REPO,
        prNumber: 12,
        method: "squash",
        deleteBranch: true,
      })
    ).resolves.toBe("deadbeef");
  });

  it("propagates a non-422/404 error deleting the head branch after merge", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/12`]: {
        json: {
          number: 12,
          title: "Add feature",
          body: "",
          html_url: `https://github.com/${REPO}/pull/12`,
          head: { ref: "mc/issue-9" },
          state: "open",
        },
      },
      [`PUT /repos/${REPO}/pulls/12/merge`]: {
        json: { sha: "deadbeef", merged: true, message: "merged" },
      },
      [`DELETE /repos/${REPO}/git/refs/heads/${encodeURIComponent("mc/issue-9")}`]: {
        status: 500,
        json: { message: "boom" },
      },
    });

    await expect(
      new GitHubIssueClient().mergePullRequest({
        repo: REPO,
        prNumber: 12,
        method: "squash",
        deleteBranch: true,
      })
    ).rejects.toThrow("500");
  });

  it("submits a pull request review and returns its html_url", async () => {
    const requests = installFetch({
      [`POST /repos/${REPO}/pulls/12/reviews`]: {
        status: 200,
        json: { html_url: `https://github.com/${REPO}/pull/12#pullrequestreview-1` },
      },
    });

    const url = await new GitHubIssueClient().createPullRequestReview({
      repo: REPO,
      prNumber: 12,
      event: "APPROVE",
      body: "Looks good.",
    });

    expect(url).toBe(`https://github.com/${REPO}/pull/12#pullrequestreview-1`);
    expect(requests[0].body).toEqual({ body: "Looks good.", event: "APPROVE" });
  });

  it("returns undefined for a pull request review response with no html_url", async () => {
    installFetch({
      [`POST /repos/${REPO}/pulls/12/reviews`]: { status: 200, json: {} },
    });

    const url = await new GitHubIssueClient().createPullRequestReview({
      repo: REPO,
      prNumber: 12,
      event: "COMMENT",
      body: "Just a note.",
    });

    expect(url).toBeUndefined();
  });

  it("submits a pull request review with commit_id and inline comments", async () => {
    const requests = installFetch({
      [`POST /repos/${REPO}/pulls/12/reviews`]: {
        status: 200,
        json: { html_url: `https://github.com/${REPO}/pull/12#pullrequestreview-2` },
      },
    });

    const url = await new GitHubIssueClient().createPullRequestReview({
      repo: REPO,
      prNumber: 12,
      event: "REQUEST_CHANGES",
      body: "Needs changes.",
      commitId: "commit-sha-123",
      comments: [{ path: "src/index.ts", line: 42, body: "Consider refactoring", side: "RIGHT" }],
    });

    expect(url).toBe(`https://github.com/${REPO}/pull/12#pullrequestreview-2`);
    expect(requests[0].body).toEqual({
      body: "Needs changes.",
      event: "REQUEST_CHANGES",
      commit_id: "commit-sha-123",
      comments: [
        {
          path: "src/index.ts",
          line: 42,
          body: "Consider refactoring",
          side: "RIGHT",
          start_line: undefined,
          start_side: undefined,
        },
      ],
    });
  });

  it("creates an inline PR review comment resolving headSha and defaulting side to RIGHT", async () => {
    const requests = installFetch({
      [`GET /repos/${REPO}/pulls/12`]: {
        status: 200,
        json: {
          number: 12,
          title: "PR 12",
          body: "body",
          html_url: `https://github.com/${REPO}/pull/12`,
          head: { ref: "feature", sha: "pr-head-sha-456" },
          state: "open",
        },
      },
      [`POST /repos/${REPO}/pulls/12/comments`]: {
        status: 201,
        json: {
          id: 101,
          html_url: `https://github.com/${REPO}/pull/12#discussion_r101`,
          path: "packages/app.ts",
          line: 15,
          body: "Why this pattern?",
        },
      },
    });

    const result = await new GitHubIssueClient().createPrReviewComment({
      repo: REPO,
      prNumber: 12,
      path: "packages/app.ts",
      line: 15,
      body: "Why this pattern?",
    });

    expect(result).toEqual({
      id: 101,
      htmlUrl: `https://github.com/${REPO}/pull/12#discussion_r101`,
      path: "packages/app.ts",
      line: 15,
      body: "Why this pattern?",
    });
    expect(
      requests.find((r) => r.method === "POST" && r.path === `/repos/${REPO}/pulls/12/comments`)
        ?.body
    ).toEqual({
      body: "Why this pattern?",
      path: "packages/app.ts",
      line: 15,
      side: "RIGHT",
      commit_id: "pr-head-sha-456",
    });
  });

  it("creates a file-level PR review comment when subjectType is 'file'", async () => {
    const requests = installFetch({
      [`POST /repos/${REPO}/pulls/12/comments`]: {
        status: 201,
        json: {
          id: 103,
          html_url: `https://github.com/${REPO}/pull/12#discussion_r103`,
          path: "packages/app.ts",
          line: null,
          body: "Overall file comments.",
        },
      },
    });

    const result = await new GitHubIssueClient().createPrReviewComment({
      repo: REPO,
      prNumber: 12,
      path: "packages/app.ts",
      subjectType: "file",
      commitId: "custom-sha",
      body: "Overall file comments.",
    });

    expect(result.id).toBe(103);
    expect(requests[0].body).toEqual({
      body: "Overall file comments.",
      path: "packages/app.ts",
      subject_type: "file",
      commit_id: "custom-sha",
    });
  });

  it("creates a multi-line PR review comment defaulting startSide to side", async () => {
    const requests = installFetch({
      [`POST /repos/${REPO}/pulls/12/comments`]: {
        status: 201,
        json: {
          id: 104,
          html_url: `https://github.com/${REPO}/pull/12#discussion_r104`,
          path: "packages/app.ts",
          line: 25,
          body: "Multi line review.",
        },
      },
    });

    await new GitHubIssueClient().createPrReviewComment({
      repo: REPO,
      prNumber: 12,
      path: "packages/app.ts",
      startLine: 20,
      line: 25,
      commitId: "custom-sha",
      body: "Multi line review.",
    });

    expect(requests[0].body).toEqual({
      body: "Multi line review.",
      path: "packages/app.ts",
      line: 25,
      side: "RIGHT",
      start_line: 20,
      start_side: "RIGHT",
      commit_id: "custom-sha",
    });
  });

  it("validates createPrReviewComment input constraints", async () => {
    const client = new GitHubIssueClient();

    // inReplyTo combined with path/line
    await expect(
      client.createPrReviewComment({
        repo: REPO,
        prNumber: 12,
        inReplyTo: 101,
        path: "packages/app.ts",
        body: "bad",
      })
    ).rejects.toThrow("inReplyTo cannot be combined");

    // subjectType: file with line
    await expect(
      client.createPrReviewComment({
        repo: REPO,
        prNumber: 12,
        subjectType: "file",
        path: "packages/app.ts",
        line: 10,
        body: "bad",
      })
    ).rejects.toThrow("line, side, startLine, and startSide cannot be provided");

    // line missing for line-level comment
    await expect(
      client.createPrReviewComment({
        repo: REPO,
        prNumber: 12,
        path: "packages/app.ts",
        body: "bad",
      })
    ).rejects.toThrow("line is required");

    // startLine > line
    await expect(
      client.createPrReviewComment({
        repo: REPO,
        prNumber: 12,
        path: "packages/app.ts",
        startLine: 30,
        line: 20,
        commitId: "sha",
        body: "bad",
      })
    ).rejects.toThrow("startLine (30) cannot be greater than line (20)");
  });

  it("creates a PR review comment reply when inReplyTo is supplied", async () => {
    const requests = installFetch({
      [`POST /repos/${REPO}/pulls/12/comments`]: {
        status: 201,
        json: {
          id: 102,
          html_url: `https://github.com/${REPO}/pull/12#discussion_r102`,
          path: "packages/app.ts",
          line: 15,
          body: "Good point, updating.",
        },
      },
    });

    const result = await new GitHubIssueClient().createPrReviewComment({
      repo: REPO,
      prNumber: 12,
      inReplyTo: 101,
      body: "Good point, updating.",
    });

    expect(result.id).toBe(102);
    expect(requests[0].body).toEqual({
      body: "Good point, updating.",
      in_reply_to: 101,
    });
  });

  it("maps PR details from the GitHub wire shape", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          number: 5,
          title: "Title",
          body: null,
          html_url: "https://github.com/test-org/test-repo/pull/5",
          head: { ref: "mc/issue-3", sha: "details-head-sha" },
          state: "open",
        },
      },
    });

    const details = await new GitHubIssueClient().getPullRequestDetails(REPO, 5);
    expect(details).toEqual({
      number: 5,
      title: "Title",
      body: "",
      htmlUrl: "https://github.com/test-org/test-repo/pull/5",
      headRef: "mc/issue-3",
      headSha: "details-head-sha",
      state: "open",
    });
  });

  it("rolls up combined statuses and check-runs for the PR head sha", async () => {
    const requests = installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          head: { sha: "head-sha-123" },
        },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/status`]: {
        json: {
          state: "success",
          statuses: [{ context: "legacy-ci", state: "success" }],
        },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/check-runs?per_page=100&page=1`]: {
        json: {
          check_runs: [
            { name: "pnpm lint", status: "completed", conclusion: "failure" },
            { name: "unit tests", status: "in_progress", conclusion: null },
            { name: "typecheck", status: "completed", conclusion: "success" },
          ],
        },
      },
    });

    const status = await new GitHubIssueClient().getPullRequestChecksStatus(REPO, 5);

    expect(status).toEqual({
      state: "failure",
      headSha: "head-sha-123",
      blocking: [
        { name: "pnpm lint", conclusion: "failure" },
        { name: "unit tests", conclusion: "in_progress" },
      ],
    });
    expect(requests.map((r) => [r.method, r.path])).toEqual([
      ["GET", `/repos/${REPO}/pulls/5`],
      ["GET", `/repos/${REPO}/commits/head-sha-123/status`],
      ["GET", `/repos/${REPO}/commits/head-sha-123/check-runs?per_page=100&page=1`],
    ]);
  });

  it("ignores an empty legacy combined-status pending state when check-runs are green", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          head: { sha: "head-sha-123" },
        },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/status`]: {
        json: {
          state: "pending",
          statuses: [],
        },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/check-runs?per_page=100&page=1`]: {
        json: {
          check_runs: [
            { name: "pnpm lint", status: "completed", conclusion: "success" },
            { name: "typecheck", status: "completed", conclusion: "success" },
          ],
        },
      },
    });

    const status = await new GitHubIssueClient().getPullRequestChecksStatus(REPO, 5);

    expect(status).toEqual({
      state: "success",
      headSha: "head-sha-123",
      blocking: [],
    });
  });

  it("treats a PR head with no reported statuses or check-runs as pending", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          head: { sha: "head-sha-123" },
        },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/status`]: {
        json: {
          state: "pending",
          statuses: [],
        },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/check-runs?per_page=100&page=1`]: {
        json: {
          check_runs: [],
        },
      },
    });

    const status = await new GitHubIssueClient().getPullRequestChecksStatus(REPO, 5);

    expect(status).toEqual({
      state: "pending",
      headSha: "head-sha-123",
      blocking: [{ name: "no checks reported", conclusion: "missing" }],
    });
  });

  it("falls back to Actions workflow runs when check-runs are unreadable", async () => {
    const requests = installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          head: { sha: "head-sha-123" },
        },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/status`]: {
        json: { state: "success", statuses: [] },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/check-runs?per_page=100&page=1`]: {
        status: 403,
        json: { message: "Resource not accessible by personal access token" },
      },
      [`GET /repos/${REPO}/actions/runs?head_sha=head-sha-123&per_page=100&page=1`]: {
        json: {
          total_count: 1,
          workflow_runs: [{ id: 1001, name: "CI", status: "completed", conclusion: "success" }],
        },
      },
    });

    const status = await new GitHubIssueClient().getPullRequestChecksStatus(REPO, 5);

    expect(status).toEqual({
      state: "success",
      headSha: "head-sha-123",
      blocking: [],
    });
    expect(requests.map((r) => [r.method, r.path])).toEqual([
      ["GET", `/repos/${REPO}/pulls/5`],
      ["GET", `/repos/${REPO}/commits/head-sha-123/status`],
      ["GET", `/repos/${REPO}/commits/head-sha-123/check-runs?per_page=100&page=1`],
      ["GET", `/repos/${REPO}/actions/runs?head_sha=head-sha-123&per_page=100&page=1`],
    ]);
  });

  it("ignores a superseded failure when the latest workflow run of the same name succeeds", async () => {
    const requests = installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          head: { sha: "current-head-sha" },
        },
      },
      [`GET /repos/${REPO}/commits/current-head-sha/status`]: {
        json: { state: "success", statuses: [] },
      },
      [`GET /repos/${REPO}/commits/current-head-sha/check-runs?per_page=100&page=1`]: {
        status: 403,
        json: { message: "Resource not accessible by personal access token" },
      },
      [`GET /repos/${REPO}/actions/runs?head_sha=current-head-sha&per_page=100&page=1`]: {
        json: {
          total_count: 2,
          workflow_runs: [
            {
              id: 2001,
              name: "CI",
              workflow_id: 17,
              event: "pull_request",
              status: "completed",
              conclusion: "failure",
              created_at: "2026-07-21T16:13:58Z",
              run_started_at: "2026-07-21T16:14:02Z",
            },
            {
              id: 2002,
              name: "CI",
              workflow_id: 17,
              event: "pull_request",
              status: "completed",
              conclusion: "success",
              created_at: "2026-07-22T12:37:46Z",
              run_started_at: "2026-07-22T12:37:50Z",
            },
          ],
        },
      },
    });

    const status = await new GitHubIssueClient().getPullRequestChecksStatus(REPO, 5);

    expect(status).toEqual({
      state: "success",
      headSha: "current-head-sha",
      blocking: [],
    });
    expect(requests.map((request) => request.path)).toEqual([
      `/repos/${REPO}/pulls/5`,
      `/repos/${REPO}/commits/current-head-sha/status`,
      `/repos/${REPO}/commits/current-head-sha/check-runs?per_page=100&page=1`,
      `/repos/${REPO}/actions/runs?head_sha=current-head-sha&per_page=100&page=1`,
    ]);
  });

  it("still blocks a lone genuine workflow failure", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          head: { sha: "current-head-sha" },
        },
      },
      [`GET /repos/${REPO}/commits/current-head-sha/status`]: {
        json: { state: "success", statuses: [] },
      },
      [`GET /repos/${REPO}/commits/current-head-sha/check-runs?per_page=100&page=1`]: {
        status: 403,
        json: { message: "Resource not accessible by personal access token" },
      },
      [`GET /repos/${REPO}/actions/runs?head_sha=current-head-sha&per_page=100&page=1`]: {
        json: {
          total_count: 1,
          workflow_runs: [
            {
              id: 2003,
              name: "CI",
              workflow_id: 17,
              event: "pull_request",
              status: "completed",
              conclusion: "failure",
              created_at: "2026-07-22T13:00:00Z",
              run_started_at: "2026-07-22T13:00:05Z",
            },
          ],
        },
      },
    });

    const status = await new GitHubIssueClient().getPullRequestChecksStatus(REPO, 5);

    expect(status).toEqual({
      state: "failure",
      headSha: "current-head-sha",
      blocking: [{ name: "CI", conclusion: "failure" }],
    });
  });

  it("does not collapse same-name workflow runs from different events", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          head: { sha: "current-head-sha" },
        },
      },
      [`GET /repos/${REPO}/commits/current-head-sha/status`]: {
        json: { state: "success", statuses: [] },
      },
      [`GET /repos/${REPO}/commits/current-head-sha/check-runs?per_page=100&page=1`]: {
        status: 403,
        json: { message: "Resource not accessible by personal access token" },
      },
      [`GET /repos/${REPO}/actions/runs?head_sha=current-head-sha&per_page=100&page=1`]: {
        json: {
          total_count: 2,
          workflow_runs: [
            {
              id: 2004,
              name: "CI",
              workflow_id: 17,
              event: "pull_request",
              status: "completed",
              conclusion: "failure",
              created_at: "2026-07-22T13:00:00Z",
              run_started_at: "2026-07-22T13:00:05Z",
            },
            {
              id: 2005,
              name: "CI",
              workflow_id: 17,
              event: "push",
              status: "completed",
              conclusion: "success",
              created_at: "2026-07-22T13:05:00Z",
              run_started_at: "2026-07-22T13:05:05Z",
            },
          ],
        },
      },
    });

    const status = await new GitHubIssueClient().getPullRequestChecksStatus(REPO, 5);

    expect(status).toEqual({
      state: "failure",
      headSha: "current-head-sha",
      blocking: [{ name: "CI", conclusion: "failure" }],
    });
  });

  it("keeps a queued check run blocking when its start time cannot establish recency", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          head: { sha: "current-head-sha" },
        },
      },
      [`GET /repos/${REPO}/commits/current-head-sha/status`]: {
        json: { state: "success", statuses: [] },
      },
      [`GET /repos/${REPO}/commits/current-head-sha/check-runs?per_page=100&page=1`]: {
        json: {
          check_runs: [
            {
              id: 101,
              name: "CI",
              status: "completed",
              conclusion: "success",
              started_at: "2026-07-22T13:00:00Z",
              app: { id: 15368 },
            },
            {
              id: 102,
              name: "CI",
              status: "queued",
              conclusion: null,
              started_at: null,
              app: { id: 15368 },
            },
          ],
        },
      },
    });

    const status = await new GitHubIssueClient().getPullRequestChecksStatus(REPO, 5);

    expect(status).toEqual({
      state: "pending",
      headSha: "current-head-sha",
      blocking: [{ name: "CI", conclusion: "queued" }],
    });
  });

  it("treats zero Actions workflow runs as pending when check-runs are unreadable", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          head: { sha: "head-sha-123" },
        },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/status`]: {
        json: { state: "success", statuses: [] },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/check-runs?per_page=100&page=1`]: {
        status: 403,
        json: { message: "Resource not accessible by personal access token" },
      },
      [`GET /repos/${REPO}/actions/runs?head_sha=head-sha-123&per_page=100&page=1`]: {
        json: {
          total_count: 0,
          workflow_runs: [],
        },
      },
    });

    const status = await new GitHubIssueClient().getPullRequestChecksStatus(REPO, 5);

    expect(status).toEqual({
      state: "pending",
      headSha: "head-sha-123",
      blocking: [{ name: "no checks reported", conclusion: "missing" }],
    });
  });

  it("treats an in-progress Actions workflow run as pending when check-runs are unreadable", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          head: { sha: "head-sha-123" },
        },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/status`]: {
        json: { state: "success", statuses: [] },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/check-runs?per_page=100&page=1`]: {
        status: 403,
        json: { message: "Resource not accessible by personal access token" },
      },
      [`GET /repos/${REPO}/actions/runs?head_sha=head-sha-123&per_page=100&page=1`]: {
        json: {
          total_count: 1,
          workflow_runs: [{ id: 1002, name: "CI", status: "in_progress", conclusion: null }],
        },
      },
    });

    const status = await new GitHubIssueClient().getPullRequestChecksStatus(REPO, 5);

    expect(status).toEqual({
      state: "pending",
      headSha: "head-sha-123",
      blocking: [{ name: "CI", conclusion: "in_progress" }],
    });
  });

  it("treats completed non-success Actions workflow run conclusions as failures", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          head: { sha: "head-sha-123" },
        },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/status`]: {
        json: { state: "success", statuses: [] },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/check-runs?per_page=100&page=1`]: {
        status: 403,
        json: { message: "Resource not accessible by personal access token" },
      },
      [`GET /repos/${REPO}/actions/runs?head_sha=head-sha-123&per_page=100&page=1`]: {
        json: {
          total_count: 1,
          workflow_runs: [{ id: 1003, name: "CI", status: "completed", conclusion: "stale" }],
        },
      },
    });

    const status = await new GitHubIssueClient().getPullRequestChecksStatus(REPO, 5);

    expect(status).toEqual({
      state: "failure",
      headSha: "head-sha-123",
      blocking: [{ name: "CI", conclusion: "stale" }],
    });
  });

  it("treats unknown completed workflow run conclusions as failures", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          head: { sha: "head-sha-123" },
        },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/status`]: {
        json: { state: "success", statuses: [] },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/check-runs?per_page=100&page=1`]: {
        json: {
          check_runs: [{ name: "future CI", status: "completed", conclusion: "some_future_state" }],
        },
      },
    });

    const status = await new GitHubIssueClient().getPullRequestChecksStatus(REPO, 5);

    expect(status).toEqual({
      state: "failure",
      headSha: "head-sha-123",
      blocking: [{ name: "future CI", conclusion: "some_future_state" }],
    });
  });

  it("treats a skipped Actions workflow run as green when check-runs are unreadable", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          head: { sha: "head-sha-123" },
        },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/status`]: {
        json: { state: "success", statuses: [] },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/check-runs?per_page=100&page=1`]: {
        status: 403,
        json: { message: "Resource not accessible by personal access token" },
      },
      [`GET /repos/${REPO}/actions/runs?head_sha=head-sha-123&per_page=100&page=1`]: {
        json: {
          total_count: 1,
          workflow_runs: [{ id: 1004, name: "CI", status: "completed", conclusion: "skipped" }],
        },
      },
    });

    const status = await new GitHubIssueClient().getPullRequestChecksStatus(REPO, 5);

    expect(status).toEqual({
      state: "success",
      headSha: "head-sha-123",
      blocking: [],
    });
  });

  it("reports unreadable pull request checks only when check-runs and Actions both fail", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/5`]: {
        json: {
          head: { sha: "head-sha-123" },
        },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/status`]: {
        json: { state: "success", statuses: [] },
      },
      [`GET /repos/${REPO}/commits/head-sha-123/check-runs?per_page=100&page=1`]: {
        status: 403,
        json: { message: "Resource not accessible by integration" },
      },
      [`GET /repos/${REPO}/actions/runs?head_sha=head-sha-123&per_page=100&page=1`]: {
        status: 500,
        json: { message: "Internal Server Error" },
      },
    });

    await expect(new GitHubIssueClient().getPullRequestChecksStatus(REPO, 5)).rejects.toThrow(
      PullRequestChecksUnreadableError
    );
  });

  it("filters open PRs by author and parses the issue number from the branch", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=1`]: {
        json: [
          {
            number: 1,
            title: "Ours",
            head: { ref: "mc/issue-42" },
            html_url: "u1",
            body: "b",
            user: { login: "bot" },
            labels: [{ name: "owner:bot" }],
            updated_at: "2026-01-02T00:00:00Z",
          },
          {
            number: 2,
            title: "Someone else's",
            head: { ref: "mc/issue-43" },
            html_url: "u2",
            body: "b",
            user: { login: "human" },
            labels: [],
            updated_at: "2026-01-03T00:00:00Z",
          },
          {
            number: 3,
            title: "Ours, but not an mc branch",
            head: { ref: "feature/foo" },
            html_url: "u3",
            body: "b",
            user: { login: "bot" },
            labels: [],
            updated_at: "2026-01-04T00:00:00Z",
          },
        ],
      },
    });

    const prs = await new GitHubIssueClient().getOpenPullRequestsByAuthor(REPO, "bot");
    expect(prs).toEqual([
      {
        number: 1,
        title: "Ours",
        headRef: "mc/issue-42",
        headRefName: "mc/issue-42",
        htmlUrl: "u1",
        body: "b",
        author: "bot",
        labels: ["owner:bot"],
        updatedAt: "2026-01-02T00:00:00Z",
        issueNumber: 42,
      },
    ]);
  });

  it("lists all open PRs without filtering by author or branch pattern", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=1`]: {
        json: [
          {
            number: 1,
            title: "Meta branch",
            head: { ref: "mc/issue-42" },
            html_url: "u1",
            body: null,
            user: { login: "bot" },
            labels: [{ name: "owner:bot" }],
            updated_at: "2026-01-02T00:00:00Z",
          },
          {
            number: 2,
            title: "Feature branch",
            head: { ref: "feature/foo" },
            html_url: "u2",
            body: "b2",
            user: { login: "human" },
            labels: [],
            updated_at: "2026-01-03T00:00:00Z",
          },
        ],
      },
    });

    const prs = await new GitHubIssueClient().getOpenPullRequests(REPO);
    expect(prs).toEqual([
      {
        number: 1,
        title: "Meta branch",
        headRef: "mc/issue-42",
        headRefName: "mc/issue-42",
        htmlUrl: "u1",
        body: "",
        author: "bot",
        labels: ["owner:bot"],
        updatedAt: "2026-01-02T00:00:00Z",
        issueNumber: 42,
      },
      {
        number: 2,
        title: "Feature branch",
        headRef: "feature/foo",
        headRefName: "feature/foo",
        htmlUrl: "u2",
        body: "b2",
        author: "human",
        labels: [],
        updatedAt: "2026-01-03T00:00:00Z",
        issueNumber: null,
      },
    ]);
  });

  it("paginates open pull requests", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=1`]: {
        json: Array.from({ length: 100 }, (_, index) => ({
          number: index + 1,
          title: `PR ${index + 1}`,
          head: { ref: `feature/${index + 1}` },
          html_url: `u${index + 1}`,
          body: "",
          user: { login: "bot" },
          labels: [],
          updated_at: "2026-01-02T00:00:00Z",
        })),
      },
      [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=2`]: {
        json: [
          {
            number: 101,
            title: "PR 101",
            head: { ref: "feature/101" },
            html_url: "u101",
            body: "",
            user: { login: "bot" },
            labels: [],
            updated_at: "2026-01-03T00:00:00Z",
          },
        ],
      },
    });

    const prs = await new GitHubIssueClient().getOpenPullRequests(REPO);
    expect(prs).toHaveLength(101);
    expect(prs.at(-1)?.number).toBe(101);
  });

  it("lists issues with state and label filters", async () => {
    installFetch({
      [`GET /repos/${REPO}/issues?state=all&per_page=100&labels=bug%2Ctriage&page=1`]: {
        json: [
          {
            number: 4,
            title: "Real issue",
            user: { login: "human" },
            labels: [{ name: "bug" }, { name: "triage" }],
            state: "open",
            updated_at: "2026-01-02T00:00:00Z",
          },
          {
            number: 5,
            title: "PR from issues endpoint",
            user: { login: "bot" },
            labels: [],
            state: "open",
            updated_at: "2026-01-03T00:00:00Z",
            pull_request: {},
          },
        ],
      },
    });

    const issues = await new GitHubIssueClient().listIssues(REPO, {
      state: "all",
      labels: ["bug", "triage"],
    });
    expect(issues).toEqual([
      {
        number: 4,
        title: "Real issue",
        author: "human",
        labels: ["bug", "triage"],
        state: "open",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ]);
  });

  it("paginates issues before filtering PR-backed issue records", async () => {
    installFetch({
      [`GET /repos/${REPO}/issues?state=open&per_page=100&page=1`]: {
        json: Array.from({ length: 100 }, (_, index) => ({
          number: index + 1,
          title: `Issue ${index + 1}`,
          user: { login: "human" },
          labels: [],
          state: "open",
          updated_at: "2026-01-02T00:00:00Z",
        })),
      },
      [`GET /repos/${REPO}/issues?state=open&per_page=100&page=2`]: {
        json: [
          {
            number: 101,
            title: "Issue 101",
            user: { login: "human" },
            labels: [],
            state: "open",
            updated_at: "2026-01-03T00:00:00Z",
          },
          {
            number: 102,
            title: "PR wrapper",
            user: { login: "bot" },
            labels: [],
            state: "open",
            updated_at: "2026-01-03T00:00:00Z",
            pull_request: {},
          },
        ],
      },
    });

    const issues = await new GitHubIssueClient().listIssues(REPO);
    expect(issues).toHaveLength(101);
    expect(issues.at(-1)?.number).toBe(101);
  });

  it("maps review comments, falling back to original_line", async () => {
    installFetch({
      [`GET /repos/${REPO}/pulls/5/reviews/77/comments?per_page=100&page=1`]: {
        json: [
          { path: "a.ts", line: 10, original_line: 8, body: "fix", diff_hunk: "@@ -1 +1 @@" },
          { path: "b.ts", line: null, original_line: 4, body: "also", diff_hunk: "@@ -2 +2 @@" },
        ],
      },
    });

    const comments = await new GitHubIssueClient().getPrReviewComments(REPO, 5, 77);
    expect(comments).toEqual([
      {
        id: undefined,
        path: "a.ts",
        line: 10,
        body: "fix",
        diffHunk: "@@ -1 +1 @@",
        author: undefined,
        createdAt: undefined,
        inReplyToId: null,
      },
      {
        id: undefined,
        path: "b.ts",
        line: 4,
        body: "also",
        diffHunk: "@@ -2 +2 @@",
        author: undefined,
        createdAt: undefined,
        inReplyToId: null,
      },
    ]);
  });

  it("fetches all PR review comments across pages when reviewId is omitted", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      path: `src/file_${i}.ts`,
      line: i + 1,
      original_line: i + 1,
      body: `comment ${i + 1}`,
      diff_hunk: "@@ -1 +1 @@",
      user: { login: "reviewer-1" },
      created_at: "2026-08-25T00:00:00Z",
      in_reply_to_id: null,
    }));
    const page2 = [
      {
        id: 101,
        path: "src/file_101.ts",
        line: 101,
        original_line: 101,
        body: "comment 101",
        diff_hunk: "@@ -1 +1 @@",
        user: { login: "reviewer-2" },
        created_at: "2026-08-25T01:00:00Z",
        in_reply_to_id: 1,
      },
    ];

    installFetch({
      [`GET /repos/${REPO}/pulls/5/comments?per_page=100&page=1`]: {
        json: page1,
      },
      [`GET /repos/${REPO}/pulls/5/comments?per_page=100&page=2`]: {
        json: page2,
      },
    });

    const comments = await new GitHubIssueClient().getPrReviewComments(REPO, 5);
    expect(comments).toHaveLength(101);
    expect(comments[0]).toEqual({
      id: 1,
      path: "src/file_0.ts",
      line: 1,
      body: "comment 1",
      diffHunk: "@@ -1 +1 @@",
      author: "reviewer-1",
      createdAt: "2026-08-25T00:00:00Z",
      inReplyToId: null,
    });
    expect(comments[100]).toEqual({
      id: 101,
      path: "src/file_101.ts",
      line: 101,
      body: "comment 101",
      diffHunk: "@@ -1 +1 @@",
      author: "reviewer-2",
      createdAt: "2026-08-25T01:00:00Z",
      inReplyToId: 1,
    });
  });

  it("treats 404 as 'no parent' / 'no sub-issues' and propagates other errors", async () => {
    installFetch({
      [`GET /repos/${REPO}/issues/2/parent`]: { json: { number: 1 } },
      [`GET /repos/${REPO}/issues/9/sub_issues?per_page=1`]: {
        status: 500,
        json: { message: "boom" },
      },
      // issue 1 has no routes: parent + sub_issues both 404
    });

    const client = new GitHubIssueClient();
    expect(await client.getParentIssueNumber(REPO, 1)).toBeNull();
    expect(await client.getParentIssueNumber(REPO, 2)).toBe(1);
    expect(await client.hasSubIssues(REPO, 1)).toBe(false);
    await expect(client.hasSubIssues(REPO, 9)).rejects.toThrow("500");
  });

  it("walks the parent chain to the root", async () => {
    installFetch({
      [`GET /repos/${REPO}/issues/3/parent`]: { json: { number: 2 } },
      [`GET /repos/${REPO}/issues/2/parent`]: { json: { number: 1 } },
      // issue 1: 404 → root
    });

    expect(await new GitHubIssueClient().getRootIssueNumber(REPO, 3)).toBe(1);
    expect(await new GitHubIssueClient().getRootIssueNumber(REPO, 1)).toBeNull();
  });
  it("throws when a GraphQL query returns a 200 with an errors array", async () => {
    installFetch({
      "POST /graphql": {
        json: {
          data: { repository: { issue: { id: "node-id" } } },
          errors: [{ message: "Some GraphQL error" }],
        },
      },
    });

    await expect(new GitHubIssueClient().addSubIssue(REPO, 1, 2)).rejects.toThrow("GraphQL error");
  });
});
