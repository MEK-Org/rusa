import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type {
  CreateIssueOptions,
  CreatePROptions,
  CreatePrReviewCommentOptions,
  CreatePullRequestReviewOptions,
  IssueClient,
} from "../gitops/issue-client.js";
import { parseAuthor, stampAuthor, verifyAuthorStamp } from "./stamp.js";
import { createTrackerMcpServer } from "./tracker-mcp.js";

type Call = { method: string; args: unknown[] };

function recordingIssueClient(): { client: IssueClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: IssueClient = {
    createIssue: async (opts: CreateIssueOptions) => {
      calls.push({ method: "createIssue", args: [opts] });
      return { number: 123, htmlUrl: "https://example.test/issues/123" };
    },
    createPullRequest: async (opts: CreatePROptions) => {
      calls.push({ method: "createPullRequest", args: [opts] });
      return { number: 1, htmlUrl: "https://example.test/pr/1" };
    },
    createPrReviewComment: async (opts: CreatePrReviewCommentOptions) => {
      calls.push({ method: "createPrReviewComment", args: [opts] });
      return {
        id: 99,
        htmlUrl: "https://example.test/pr/1#discussion_r99",
        path: opts.path ?? "a.ts",
        line: opts.line ?? 1,
        body: opts.body,
      };
    },
    getOpenPullRequestsByAuthor: async (repo, author) => {
      calls.push({ method: "getOpenPullRequestsByAuthor", args: [repo, author] });
      return [
        {
          number: 1,
          title: "t",
          headRef: "mc/issue-1",
          headRefName: "mc/issue-1",
          htmlUrl: "u",
          body: "b",
          author,
          labels: [],
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ];
    },
    getOpenPullRequests: async (repo) => {
      calls.push({ method: "getOpenPullRequests", args: [repo] });
      return [
        {
          number: 2,
          title: "all",
          headRef: "feature/all",
          headRefName: "feature/all",
          htmlUrl: "u2",
          body: "b2",
          author: "human",
          labels: [],
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ];
    },
    listIssues: async (repo, opts) => {
      calls.push({ method: "listIssues", args: [repo, opts] });
      return [
        {
          number: 3,
          title: "issue",
          author: "operator",
          labels: opts?.labels ?? [],
          state: opts?.state === "closed" ? "closed" : "open",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ];
    },
    getPullRequestDetails: async (repo, prNumber) => {
      calls.push({ method: "getPullRequestDetails", args: [repo, prNumber] });
      return {
        number: prNumber,
        title: "t",
        body: "b",
        htmlUrl: "u",
        headRef: "h",
        headSha: "head-sha",
        state: "open",
      };
    },
    getPullRequestChecksStatus: async (repo, prNumber) => {
      calls.push({ method: "getPullRequestChecksStatus", args: [repo, prNumber] });
      return { state: "success", headSha: "head-sha", blocking: [] };
    },
    getIssue: async (repo, issueNumber) => {
      calls.push({ method: "getIssue", args: [repo, issueNumber] });
      return { number: issueNumber, title: "t", body: "b", state: "open", author: "operator" };
    },
    listIssueComments: async (repo, issueNumber) => {
      calls.push({ method: "listIssueComments", args: [repo, issueNumber] });
      return [{ id: 1, author: "operator", body: "c", createdAt: "2026-01-01T00:00:00Z" }];
    },
    postComment: async (repo, issueNumber, body) => {
      calls.push({ method: "postComment", args: [repo, issueNumber, body] });
    },
    updateIssueBody: async (repo, issueNumber, body) => {
      calls.push({ method: "updateIssueBody", args: [repo, issueNumber, body] });
    },
    addLabel: async (repo, issueNumber, label) => {
      calls.push({ method: "addLabel", args: [repo, issueNumber, label] });
    },
    removeLabel: async (repo, issueNumber, label) => {
      calls.push({ method: "removeLabel", args: [repo, issueNumber, label] });
    },
    closeIssue: async (repo, issueNumber, stateReason) => {
      calls.push({ method: "closeIssue", args: [repo, issueNumber, stateReason] });
    },
    reopenIssue: async (repo, issueNumber) => {
      calls.push({ method: "reopenIssue", args: [repo, issueNumber] });
    },
    mergePullRequest: async () => "sha",
    createPullRequestReview: async (opts: CreatePullRequestReviewOptions) => {
      calls.push({ method: "createPullRequestReview", args: [opts] });
      return "https://example.test/pr/1#pullrequestreview-1";
    },
    addReaction: async (repo, issueNumber, content) => {
      calls.push({ method: "addReaction", args: [repo, issueNumber, content] });
    },
    addCommentReaction: async (repo, commentId, content, scope) => {
      calls.push({ method: "addCommentReaction", args: [repo, commentId, content, scope] });
    },
    getPrReviewComments: async (repo, prNumber, reviewId) => {
      calls.push({ method: "getPrReviewComments", args: [repo, prNumber, reviewId] });
      return [{ path: "a.ts", line: 1, body: "c", diffHunk: "@@" }];
    },
    getPullRequestReview: async () => null,
    getParentIssueNumber: async (repo, issueNumber) => {
      calls.push({ method: "getParentIssueNumber", args: [repo, issueNumber] });
      return 7;
    },
    getRootIssueNumber: async (repo, issueNumber) => {
      calls.push({ method: "getRootIssueNumber", args: [repo, issueNumber] });
      return 3;
    },
    hasSubIssues: async (repo, issueNumber) => {
      calls.push({ method: "hasSubIssues", args: [repo, issueNumber] });
      return true;
    },
    addSubIssue: async (repo, parentIssueNumber, childIssueNumber) => {
      calls.push({ method: "addSubIssue", args: [repo, parentIssueNumber, childIssueNumber] });
    },
    removeSubIssue: async (repo, parentIssueNumber, childIssueNumber) => {
      calls.push({ method: "removeSubIssue", args: [repo, parentIssueNumber, childIssueNumber] });
    },
  };
  return { client, calls };
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}

describe("tracker MCP server", () => {
  it("exposes the full merged tracker tool surface as tools", async () => {
    const { client: backend } = recordingIssueClient();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "add_label",
        "add_reaction",
        "add_sub_issue",
        "close_issue",
        "create_issue",
        "create_pr_review_comment",
        "create_pull_request",
        "get_issue",
        "get_parent_issue",
        "get_pr_details",
        "get_pr_review_comments",
        "get_root_issue",
        "has_sub_issues",
        "list_issue_comments",
        "list_open_issues",
        "list_open_prs",
        "post_comment",
        "post_review",
        "remove_label",
        "remove_parent",
        "reopen_issue",
        "set_parent",
        "update_body",
      ].sort()
    );
  });

  it("appends authenticated actor id stamp to post_comment body", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(
      createTrackerMcpServer("test-actor-1", backend, { instanceId: "test-instance" })
    );
    const res = (await client.callTool({
      name: "post_comment",
      arguments: { repo: "owner/repo", issueNumber: 123, body: "hello world" },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("postComment");
    expect(calls[0].args[0]).toBe("owner/repo");
    expect(calls[0].args[1]).toBe(123);

    const body = calls[0].args[2] as string;
    expect(body).toContain("hello world");
    expect(body).toContain("<!-- mesh:author:v2 test-actor-1 test-instance");
    expect(parseAuthor(body)).toBe("test-actor-1");
  });

  it("reads the active selection at each write without exposing its provider", async () => {
    const { client: backend, calls } = recordingIssueClient();
    let selection: { provider: string; model?: string; effort?: string } | undefined = {
      provider: "codex",
      model: "gpt-5.6-terra",
      effort: "xhigh",
    };
    const client = await connect(
      createTrackerMcpServer("test-actor", backend, {
        actorHandle: "actor-handle",
        getRunSelection: () => selection,
      })
    );

    await client.callTool({
      name: "post_comment",
      arguments: { repo: "owner/repo", issueNumber: 123, body: "first" },
    });
    selection = { provider: "codex", model: "gpt-5.6-sol" };
    await client.callTool({
      name: "post_comment",
      arguments: { repo: "owner/repo", issueNumber: 123, body: "second" },
    });
    selection = undefined;
    await client.callTool({
      name: "post_comment",
      arguments: { repo: "owner/repo", issueNumber: 123, body: "third" },
    });

    const first = calls[0]?.args[2] as string;
    const second = calls[1]?.args[2] as string;
    const third = calls[2]?.args[2] as string;
    expect(first).toContain("*actor-handle (gpt-5.6-terra, xhigh)*");
    expect(second).toContain("*actor-handle (gpt-5.6-sol)*");
    expect(third).toContain("*actor-handle*");
    expect(first).not.toContain("codex");
    expect(second).not.toContain("codex");
    expect(third).not.toContain("codex");
  });

  it("mechanically signs every GitHub body and keeps one footer on updates", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(
      createTrackerMcpServer("test-actor", backend, {
        actorHandle: "actor-handle",
        instanceId: "test-instance",
        getRunSelection: () => ({
          provider: "codex",
          model: "gpt-5.6-terra",
          effort: "xhigh",
        }),
      })
    );

    await client.callTool({
      name: "create_issue",
      arguments: { repo: "owner/repo", title: "Issue", body: "issue body" },
    });
    await client.callTool({
      name: "create_pull_request",
      arguments: {
        repo: "owner/repo",
        head: "feature",
        title: "PR",
        body: "pr body\n\n*other-actor (old-model, low)*",
      },
    });
    await client.callTool({
      name: "post_comment",
      arguments: { repo: "owner/repo", issueNumber: 123, body: "comment body" },
    });
    await client.callTool({
      name: "post_review",
      arguments: {
        repo: "owner/repo",
        prNumber: 123,
        event: "COMMENT",
        body: "review body",
        comments: [{ path: "src/file.ts", line: 1, body: "inline review body" }],
      },
    });
    await client.callTool({
      name: "create_pr_review_comment",
      arguments: { repo: "owner/repo", prNumber: 123, inReplyTo: 99, body: "reply body" },
    });
    const oldStamp = stampAuthor("other-actor", "owner/repo", 123, "old-instance");
    await client.callTool({
      name: "update_body",
      arguments: {
        repo: "owner/repo",
        issueNumber: 123,
        body: `replacement body\n\n*other-actor (old-model, low)*\n\n${oldStamp}`,
      },
    });

    const issue = calls.find((call) => call.method === "createIssue")
      ?.args[0] as CreateIssueOptions;
    const pr = calls.find((call) => call.method === "createPullRequest")
      ?.args[0] as CreatePROptions;
    const comment = calls.find((call) => call.method === "postComment")?.args[2] as string;
    const review = calls.find((call) => call.method === "createPullRequestReview")
      ?.args[0] as CreatePullRequestReviewOptions;
    const reply = calls.find((call) => call.method === "createPrReviewComment")
      ?.args[0] as CreatePrReviewCommentOptions;
    const update = calls.find((call) => call.method === "updateIssueBody")?.args[2] as string;
    const bodies = [
      issue.body,
      pr.body,
      comment,
      review.body,
      review.comments?.[0]?.body ?? "",
      reply.body,
      update,
    ];

    for (const body of bodies) {
      expect(body).toContain("*actor-handle (gpt-5.6-terra, xhigh)*");
      expect(body).toMatch(/\*actor-handle \(gpt-5\.6-terra, xhigh\)\*\n\n<!-- mesh:author:v/);
      expect(body).not.toContain("codex");
    }
    // A creation input has no authenticated trailing stamp, so its terminal
    // italic is authored content, not an old mechanical footer.
    expect(pr.body).toContain("*other-actor (old-model, low)*");
    expect(update).not.toContain("other-actor");
    expect(update.match(/\*[^*\r\n]+\*/g)).toEqual(["*actor-handle (gpt-5.6-terra, xhigh)*"]);
  });

  it("preserves authored terminal italics and replaces a stamped PR footer pair", async () => {
    const { client: backend, calls } = recordingIssueClient();
    backend.getOpenPullRequests = async () => [
      {
        number: 1,
        title: "Existing",
        headRef: "existing",
        headRefName: "existing",
        htmlUrl: "https://example.test/pr/1",
        body: "",
        author: "bot",
        labels: [],
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ];
    const client = await connect(
      createTrackerMcpServer("test-actor", backend, {
        actorHandle: "actor-handle",
        instanceId: "test-instance",
        getRunSelection: () => ({ provider: "codex", model: "gpt-5.6-terra" }),
      })
    );
    const oldStamp = stampAuthor("other-actor", "owner/repo", undefined, "old-instance");

    await client.callTool({
      name: "create_pull_request",
      arguments: {
        repo: "owner/repo",
        head: "fresh",
        title: "Fresh",
        body: `The result was *surprising*\n\n*other-actor (old-model, low)*\n\n${oldStamp}`,
      },
    });
    await client.callTool({
      name: "create_pull_request",
      arguments: {
        repo: "owner/repo",
        head: "existing",
        title: "Existing",
        body: `Current body\n\n*other-actor (old-model, low)*\n\n${oldStamp}`,
      },
    });
    await client.callTool({
      name: "update_body",
      arguments: {
        repo: "owner/repo",
        issueNumber: 123,
        body: "The conclusion remains *surprising*",
      },
    });

    const [fresh, existing] = calls
      .filter((call) => call.method === "createPullRequest")
      .map((call) => call.args[0] as CreatePROptions);
    const update = calls.find((call) => call.method === "updateIssueBody")?.args[2] as string;

    expect(fresh.body).toContain("The result was *surprising*");
    expect(fresh.body).toContain("*other-actor (old-model, low)*");
    expect(fresh.body).toContain(oldStamp);
    expect(existing.body).not.toContain("other-actor");
    expect(existing.body).toContain("*actor-handle (gpt-5.6-terra)*");
    expect(existing.body.match(/\*[^*\r\n]+\*/g)).toEqual(["*actor-handle (gpt-5.6-terra)*"]);
    expect(existing.body.match(/<!--\s*mesh:author/g)).toHaveLength(1);
    expect(update).toContain("The conclusion remains *surprising*");
  });

  it("creates issues with a pre-creation v3 stamp from the authenticated actor id", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(
      createTrackerMcpServer("test-actor-issue", backend, { instanceId: "test-instance" })
    );
    const res = (await client.callTool({
      name: "create_issue",
      arguments: {
        repo: "owner/repo",
        title: "Issue Title",
        body: "Issue body",
        labels: ["bug", "triage"],
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("https://example.test/issues/123");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("createIssue");

    const opts = calls[0].args[0] as CreateIssueOptions;
    expect(opts.repo).toBe("owner/repo");
    expect(opts.title).toBe("Issue Title");
    expect(opts.labels).toEqual(["bug", "triage"]);

    const body = opts.body;
    expect(body).toContain("Issue body");
    expect(body).toContain("<!-- mesh:author:v3 test-actor-issue test-instance");
    expect(parseAuthor(body)).toBe("test-actor-issue");
    expect(verifyAuthorStamp(body, "owner/repo", 123)).toEqual({
      status: "verified",
      actorId: "test-actor-issue",
      instanceId: "test-instance",
    });
  });

  it("create_issue resolves the appending actor when the body quotes another actor's stamp", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(
      createTrackerMcpServer("actor-b", backend, { instanceId: "instance-b" })
    );
    const quotedActorAStamp = stampAuthor("actor-a", "owner/repo", undefined, "instance-a");

    const res = (await client.callTool({
      name: "create_issue",
      arguments: {
        repo: "owner/repo",
        title: "Quoting issue",
        body: `Quoting another actor's stamp as evidence:\n\n${quotedActorAStamp}`,
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    const body = (calls[0].args[0] as CreateIssueOptions).body;
    expect(parseAuthor(body)).toBe("actor-b");
  });

  it("create_pull_request stamps the PR body with a pre-creation v3 stamp", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(
      createTrackerMcpServer("test-actor-2", backend, { instanceId: "test-instance" })
    );

    const res = (await client.callTool({
      name: "create_pull_request",
      arguments: {
        repo: "owner/repo",
        head: "feature-branch",
        title: "PR Title",
        body: "PR body",
        reviewer: "reviewer-user",
        base: "main",
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("https://example.test/pr/1");
    expect(calls.filter((call) => call.method === "createPullRequest")).toHaveLength(1);

    const opts = calls.find((call) => call.method === "createPullRequest")
      ?.args[0] as CreatePROptions;
    expect(opts.repo).toBe("owner/repo");
    expect(opts.head).toBe("feature-branch");
    expect(opts.title).toBe("PR Title");
    expect(opts.reviewer).toBe("reviewer-user");
    expect(opts.base).toBe("main");

    const body = opts.body;
    expect(body).toContain("PR body");
    expect(body).toContain("<!-- mesh:author:v3 test-actor-2 test-instance");
    expect(parseAuthor(body)).toBe("test-actor-2");
  });

  it("create_pull_request formats git-bridge instructions when gitBridge option is active", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const onGitBridgeDeliverable = vi.fn();
    const client = await connect(
      createTrackerMcpServer("test-actor-gb", backend, {
        gitBridge: { port: 8085 },
        onGitBridgeDeliverable,
      })
    );

    const res = (await client.callTool({
      name: "create_pull_request",
      arguments: {
        repo: "owner/repo",
        head: "mc/issue-1",
        title: "Bridge PR",
        body: "Bridge body",
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(
      "Local compare: http://localhost:8085/owner/repo/compare/mc%2Fissue-1"
    );
    expect(textOf(res)).toContain("git fetch rusa");
    expect(calls).toHaveLength(0);
    expect(onGitBridgeDeliverable).toHaveBeenCalledWith(
      "test-actor-gb",
      expect.stringContaining("Local branch delivered to the Rusa git bridge.")
    );
  });

  it("submits a review with actor id stamp on post_review", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(
      createTrackerMcpServer("test-actor-review", backend, { instanceId: "test-instance" })
    );

    const res = (await client.callTool({
      name: "post_review",
      arguments: {
        repo: "owner/repo",
        prNumber: 123,
        event: "APPROVE",
        body: "LGTM!",
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("https://example.test/pr/1#pullrequestreview-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("createPullRequestReview");

    const opts = calls[0].args[0] as CreatePullRequestReviewOptions;
    expect(opts.repo).toBe("owner/repo");
    expect(opts.prNumber).toBe(123);
    expect(opts.event).toBe("APPROVE");

    const body = opts.body;
    expect(body).toContain("LGTM!");
    expect(body).toContain("<!-- mesh:author:v2 test-actor-review test-instance");
    expect(parseAuthor(body)).toBe("test-actor-review");
  });

  it("submits a review with inline comments and stamps them on post_review", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(
      createTrackerMcpServer("test-actor-skeptic", backend, { instanceId: "test-instance" })
    );

    const res = (await client.callTool({
      name: "post_review",
      arguments: {
        repo: "owner/repo",
        prNumber: 123,
        event: "REQUEST_CHANGES",
        body: "Please address these points.",
        comments: [
          {
            path: "src/worker.ts",
            line: 42,
            body: "Is this null check necessary?",
            side: "RIGHT",
          },
        ],
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("createPullRequestReview");

    const opts = calls[0].args[0] as CreatePullRequestReviewOptions;
    expect(opts.event).toBe("REQUEST_CHANGES");
    expect(opts.body).toContain("Please address these points.");
    expect(parseAuthor(opts.body)).toBe("test-actor-skeptic");
    expect(opts.comments).toHaveLength(1);
    expect(opts.comments?.[0].path).toBe("src/worker.ts");
    expect(opts.comments?.[0].line).toBe(42);
    expect(opts.comments?.[0].body).toContain("Is this null check necessary?");
    expect(parseAuthor(opts.comments?.[0].body ?? "")).toBe("test-actor-skeptic");
  });

  it("provides an actionable hint when APPROVE or REQUEST_CHANGES fails on own PR", async () => {
    const failing: IssueClient = {
      ...recordingIssueClient().client,
      createPullRequestReview: async () => {
        throw new Error("HTTP 422 Unprocessable Entity: Can not approve your own pull request");
      },
    };
    const client = await connect(
      createTrackerMcpServer("test-actor-skeptic", failing, { instanceId: "test-instance" })
    );

    const res = (await client.callTool({
      name: "post_review",
      arguments: {
        repo: "owner/repo",
        prNumber: 123,
        event: "APPROVE",
        body: "LGTM!",
      },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(
      "HTTP 422 Unprocessable Entity: Can not approve your own pull request"
    );
    expect(textOf(res)).toContain(
      "Hint: GitHub rejects APPROVE verdicts on PRs authored by the same account (including mesh-authored PRs). Submit with event: 'COMMENT' and express your verdict in the review body."
    );
  });

  it("posts an inline PR review comment with actor id stamp on create_pr_review_comment", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(
      createTrackerMcpServer("test-actor-reviewer", backend, { instanceId: "test-instance" })
    );

    const res = (await client.callTool({
      name: "create_pr_review_comment",
      arguments: {
        repo: "owner/repo",
        prNumber: 123,
        path: "src/index.ts",
        line: 55,
        body: "Can this be simplified?",
        side: "RIGHT",
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("https://example.test/pr/1#discussion_r99");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("createPrReviewComment");

    const opts = calls[0].args[0] as CreatePrReviewCommentOptions;
    expect(opts.repo).toBe("owner/repo");
    expect(opts.prNumber).toBe(123);
    expect(opts.path).toBe("src/index.ts");
    expect(opts.line).toBe(55);
    expect(opts.side).toBe("RIGHT");
    expect(opts.body).toContain("Can this be simplified?");
    expect(parseAuthor(opts.body)).toBe("test-actor-reviewer");
  });

  it("posts a file-level PR review comment on create_pr_review_comment", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(
      createTrackerMcpServer("test-actor-reviewer", backend, { instanceId: "test-instance" })
    );

    const res = (await client.callTool({
      name: "create_pr_review_comment",
      arguments: {
        repo: "owner/repo",
        prNumber: 123,
        path: "README.md",
        subjectType: "file",
        body: "File-level feedback.",
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("createPrReviewComment");

    const opts = calls[0].args[0] as CreatePrReviewCommentOptions;
    expect(opts.repo).toBe("owner/repo");
    expect(opts.prNumber).toBe(123);
    expect(opts.path).toBe("README.md");
    expect(opts.subjectType).toBe("file");
    expect(opts.line).toBeUndefined();
    expect(opts.body).toContain("File-level feedback.");
  });

  it("posts a reply to an existing PR review comment on create_pr_review_comment", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(
      createTrackerMcpServer("test-actor-reviewer", backend, { instanceId: "test-instance" })
    );

    const res = (await client.callTool({
      name: "create_pr_review_comment",
      arguments: {
        repo: "owner/repo",
        prNumber: 123,
        inReplyTo: 987,
        body: "Replying to your comment.",
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("createPrReviewComment");

    const opts = calls[0].args[0] as CreatePrReviewCommentOptions;
    expect(opts.repo).toBe("owner/repo");
    expect(opts.prNumber).toBe(123);
    expect(opts.inReplyTo).toBe(987);
    expect(opts.path).toBeUndefined();
    expect(opts.body).toContain("Replying to your comment.");
  });

  it("queries PR review comments via get_pr_review_comments tool", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend));

    await client.callTool({
      name: "get_pr_review_comments",
      arguments: { repo: "owner/repo", prNumber: 123 },
    });
    await client.callTool({
      name: "get_pr_review_comments",
      arguments: { repo: "owner/repo", prNumber: 123, reviewId: 456 },
    });

    expect(calls).toContainEqual({
      method: "getPrReviewComments",
      args: ["owner/repo", 123, undefined],
    });
    expect(calls).toContainEqual({
      method: "getPrReviewComments",
      args: ["owner/repo", 123, 456],
    });
  });

  it("restamps author on update_body", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(
      createTrackerMcpServer("test-actor-editor", backend, { instanceId: "test-instance" })
    );

    const existingStamp = stampAuthor("actor-original", "owner/repo", 55, "orig-instance");
    const oldBody = `Initial text\n\n${existingStamp}`;

    const res = (await client.callTool({
      name: "update_body",
      arguments: {
        repo: "owner/repo",
        issueNumber: 55,
        body: `${oldBody}\n\nNew appended edits`,
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("updateIssueBody");

    const newBody = calls[0].args[2] as string;
    expect(newBody).not.toContain("actor-original");
    expect(newBody).toContain("<!-- mesh:author:v2 test-actor-editor test-instance");
    expect(parseAuthor(newBody)).toBe("test-actor-editor");
  });

  it("routes bodiless write tools (add_label, remove_label, close_issue, reopen_issue)", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend));

    await client.callTool({
      name: "add_label",
      arguments: { repo: "owner/repo", issueNumber: 42, label: "bug" },
    });
    await client.callTool({
      name: "remove_label",
      arguments: { repo: "owner/repo", issueNumber: 42, label: "wip" },
    });
    await client.callTool({
      name: "close_issue",
      arguments: { repo: "owner/repo", issueNumber: 42, stateReason: "completed" },
    });
    await client.callTool({
      name: "reopen_issue",
      arguments: { repo: "owner/repo", issueNumber: 42 },
    });

    expect(calls).toContainEqual({ method: "addLabel", args: ["owner/repo", 42, "bug"] });
    expect(calls).toContainEqual({ method: "removeLabel", args: ["owner/repo", 42, "wip"] });
    expect(calls).toContainEqual({ method: "closeIssue", args: ["owner/repo", 42, "completed"] });
    expect(calls).toContainEqual({ method: "reopenIssue", args: ["owner/repo", 42] });
  });

  it("handles add_reaction for issue and comment targets", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend));

    await client.callTool({
      name: "add_reaction",
      arguments: { repo: "owner/repo", issueNumber: 42, content: "rocket" },
    });
    await client.callTool({
      name: "add_reaction",
      arguments: { repo: "owner/repo", commentId: 999, content: "heart", commentScope: "review" },
    });

    expect(calls).toContainEqual({ method: "addReaction", args: ["owner/repo", 42, "rocket"] });
    expect(calls).toContainEqual({
      method: "addCommentReaction",
      args: ["owner/repo", 999, "heart", "review"],
    });
  });

  it("rejects add_reaction when both or neither of issueNumber and commentId are provided", async () => {
    const { client: backend } = recordingIssueClient();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend));

    const neither = (await client.callTool({
      name: "add_reaction",
      arguments: { repo: "owner/repo", content: "eyes" },
    })) as CallToolResult;
    expect(neither.isError).toBe(true);

    const both = (await client.callTool({
      name: "add_reaction",
      arguments: { repo: "owner/repo", issueNumber: 1, commentId: 2, content: "eyes" },
    })) as CallToolResult;
    expect(both.isError).toBe(true);
  });

  it("notifies onResourceCreated after create_issue and create_pull_request", async () => {
    const { client: backend } = recordingIssueClient();
    const onResourceCreated = vi.fn();
    const client = await connect(
      createTrackerMcpServer("test-actor-res", backend, { onResourceCreated })
    );

    await client.callTool({
      name: "create_issue",
      arguments: { repo: "owner/repo", title: "T", body: "B" },
    });
    expect(onResourceCreated).toHaveBeenCalledWith("github:owner/repo/issues/123");

    await client.callTool({
      name: "create_pull_request",
      arguments: { repo: "owner/repo", head: "feature", title: "T", body: "B" },
    });
    expect(onResourceCreated).toHaveBeenCalledWith("github:owner/repo/pulls/1");
  });

  it("does not fail create_issue if onResourceCreated throws", async () => {
    const { client: backend } = recordingIssueClient();
    const onResourceCreated = vi.fn(() => {
      throw new Error("subscription failed");
    });
    const client = await connect(
      createTrackerMcpServer("test-actor-res", backend, { onResourceCreated })
    );

    const res = (await client.callTool({
      name: "create_issue",
      arguments: { repo: "owner/repo", title: "T", body: "B" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("https://example.test/issues/123");
  });

  it("notifies onWrite after successful writes", async () => {
    const { client: backend } = recordingIssueClient();
    const onWrite = vi.fn();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend, { onWrite }));

    await client.callTool({
      name: "post_comment",
      arguments: { repo: "o/r", issueNumber: 1, body: "hi" },
    });
    await client.callTool({
      name: "create_issue",
      arguments: { repo: "o/r", title: "T", body: "B" },
    });
    await client.callTool({
      name: "create_pull_request",
      arguments: { repo: "o/r", head: "h", title: "T", body: "B" },
    });
    await client.callTool({
      name: "add_label",
      arguments: { repo: "o/r", issueNumber: 1, label: "bug" },
    });
    await client.callTool({
      name: "remove_label",
      arguments: { repo: "o/r", issueNumber: 1, label: "bug" },
    });
    await client.callTool({
      name: "close_issue",
      arguments: { repo: "o/r", issueNumber: 1 },
    });
    await client.callTool({
      name: "reopen_issue",
      arguments: { repo: "o/r", issueNumber: 1 },
    });
    await client.callTool({
      name: "post_review",
      arguments: { repo: "o/r", prNumber: 1, event: "APPROVE", body: "ok" },
    });
    await client.callTool({
      name: "create_pr_review_comment",
      arguments: { repo: "o/r", prNumber: 1, body: "question", path: "a.ts", line: 1 },
    });
    await client.callTool({
      name: "add_reaction",
      arguments: { repo: "o/r", issueNumber: 1, content: "eyes" },
    });
    await client.callTool({
      name: "update_body",
      arguments: { repo: "o/r", issueNumber: 1, body: "new body" },
    });
    await client.callTool({
      name: "set_parent",
      arguments: { repo: "o/r", issueNumber: 1, parentIssueNumber: 10 },
    });
    await client.callTool({
      name: "remove_parent",
      arguments: { repo: "o/r", issueNumber: 1 },
    });
    await client.callTool({
      name: "add_sub_issue",
      arguments: { repo: "o/r", issueNumber: 10, subIssueNumber: 2 },
    });

    expect(onWrite).toHaveBeenCalledTimes(14);
  });

  it("does not notify when a write tool fails", async () => {
    const failing: IssueClient = {
      ...recordingIssueClient().client,
      postComment: async () => {
        throw new Error("post failed");
      },
    };
    const onWrite = vi.fn();
    const client = await connect(createTrackerMcpServer("test-actor-1", failing, { onWrite }));

    const res = (await client.callTool({
      name: "post_comment",
      arguments: { repo: "o/r", issueNumber: 42, body: "x" },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("returns read results as JSON content", async () => {
    const { client: backend } = recordingIssueClient();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend));
    const res = (await client.callTool({
      name: "get_pr_details",
      arguments: { repo: "o/r", prNumber: 5 },
    })) as CallToolResult;
    expect(JSON.parse(textOf(res))).toMatchObject({ number: 5, state: "open" });
  });

  it("lists open PRs by author via the legacy backend path", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend));
    const res = (await client.callTool({
      name: "list_open_prs",
      arguments: { repo: "o/r", author: "bot" },
    })) as CallToolResult;
    expect(JSON.parse(textOf(res))).toMatchObject([{ number: 1, author: "bot" }]);
    expect(calls).toContainEqual({ method: "getOpenPullRequestsByAuthor", args: ["o/r", "bot"] });
  });

  it("lists all open PRs when author is omitted", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend));
    const res = (await client.callTool({
      name: "list_open_prs",
      arguments: { repo: "o/r" },
    })) as CallToolResult;
    expect(JSON.parse(textOf(res))).toMatchObject([
      { number: 2, author: "human", headRefName: "feature/all" },
    ]);
    expect(calls).toContainEqual({ method: "getOpenPullRequests", args: ["o/r"] });
  });

  it("lists open issues by default", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend));
    const res = (await client.callTool({
      name: "list_open_issues",
      arguments: { repo: "o/r" },
    })) as CallToolResult;
    expect(JSON.parse(textOf(res))).toMatchObject([{ number: 3, state: "open", labels: [] }]);
    expect(calls).toContainEqual({
      method: "listIssues",
      args: ["o/r", { state: undefined, labels: undefined }],
    });
  });

  it("passes label filters through when listing issues", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend));
    const res = (await client.callTool({
      name: "list_open_issues",
      arguments: { repo: "o/r", labels: ["bug", "triage"] },
    })) as CallToolResult;
    expect(JSON.parse(textOf(res))).toMatchObject([{ labels: ["bug", "triage"] }]);
    expect(calls).toContainEqual({
      method: "listIssues",
      args: ["o/r", { state: undefined, labels: ["bug", "triage"] }],
    });
  });

  it("reads an issue's content via get_issue (the deterministic gh-view replacement)", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend));
    const res = (await client.callTool({
      name: "get_issue",
      arguments: { repo: "o/r", issueNumber: 506 },
    })) as CallToolResult;
    expect(JSON.parse(textOf(res))).toMatchObject({ number: 506, title: "t", body: "b" });
    expect(calls).toContainEqual({ method: "getIssue", args: ["o/r", 506] });
  });

  it("lists issue comments via list_issue_comments", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend));
    const res = (await client.callTool({
      name: "list_issue_comments",
      arguments: { repo: "o/r", issueNumber: 506 },
    })) as CallToolResult;
    expect(JSON.parse(textOf(res))).toEqual([
      { id: 1, author: "operator", body: "c", createdAt: "2026-01-01T00:00:00Z" },
    ]);
    expect(calls).toContainEqual({ method: "listIssueComments", args: ["o/r", 506] });
  });

  it("adds and removes sub-issues via set_parent and remove_parent tools", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend));

    await client.callTool({
      name: "set_parent",
      arguments: { repo: "o/r", issueNumber: 506, parentIssueNumber: 10 },
    });
    await client.callTool({
      name: "remove_parent",
      arguments: { repo: "o/r", issueNumber: 506 },
    });
    await client.callTool({
      name: "add_sub_issue",
      arguments: { repo: "o/r", issueNumber: 10, subIssueNumber: 507 },
    });

    expect(calls).toContainEqual({
      method: "addSubIssue",
      args: ["o/r", 10, 506],
    });
    expect(calls).toContainEqual({
      method: "removeSubIssue",
      args: ["o/r", 7, 506],
    });
    expect(calls).toContainEqual({
      method: "addSubIssue",
      args: ["o/r", 10, 507],
    });
  });

  it("fetches PR review comments with or without reviewId", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(createTrackerMcpServer("test-actor-1", backend));

    const resAll = (await client.callTool({
      name: "get_pr_review_comments",
      arguments: { repo: "o/r", prNumber: 5 },
    })) as CallToolResult;
    expect(JSON.parse(textOf(resAll))).toMatchObject([{ path: "a.ts", line: 1, body: "c" }]);
    expect(calls).toContainEqual({
      method: "getPrReviewComments",
      args: ["o/r", 5, undefined],
    });

    const resSpecific = (await client.callTool({
      name: "get_pr_review_comments",
      arguments: { repo: "o/r", prNumber: 5, reviewId: 42 },
    })) as CallToolResult;
    expect(JSON.parse(textOf(resSpecific))).toMatchObject([{ path: "a.ts", line: 1, body: "c" }]);
    expect(calls).toContainEqual({
      method: "getPrReviewComments",
      args: ["o/r", 5, 42],
    });
  });

  it("surfaces backend failures as isError results, not throws", async () => {
    const failing: IssueClient = {
      ...recordingIssueClient().client,
      hasSubIssues: async () => {
        throw new Error("boom");
      },
    };
    const client = await connect(createTrackerMcpServer("test-actor-1", failing));
    const res = (await client.callTool({
      name: "has_sub_issues",
      arguments: { repo: "o/r", issueNumber: 1 },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("boom");
  });
});
