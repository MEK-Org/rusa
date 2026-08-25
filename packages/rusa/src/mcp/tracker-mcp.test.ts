import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type {
  CreateIssueOptions,
  CreatePROptions,
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
          issueNumber: 1,
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
          issueNumber: null,
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
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("createPullRequest");

    const opts = calls[0].args[0] as CreatePROptions;
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
    expect(onResourceCreated).toHaveBeenCalledWith({
      kind: "github_issue",
      repo: "owner/repo",
      number: 123,
    });

    await client.callTool({
      name: "create_pull_request",
      arguments: { repo: "owner/repo", head: "feature", title: "T", body: "B" },
    });
    expect(onResourceCreated).toHaveBeenCalledWith({
      kind: "github_pr",
      repo: "owner/repo",
      number: 1,
    });
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

    expect(onWrite).toHaveBeenCalledTimes(13);
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
    expect(JSON.parse(textOf(res))).toMatchObject([{ number: 1, author: "bot", issueNumber: 1 }]);
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
      { number: 2, author: "human", headRefName: "feature/all", issueNumber: null },
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
