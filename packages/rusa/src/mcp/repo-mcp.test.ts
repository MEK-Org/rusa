import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  type IssueClient,
  type MergePullRequestOptions,
  type PullRequestChecksStatus,
  PullRequestChecksUnreadableError,
  type PullRequestDetails,
} from "../gitops/issue-client.js";
import { createRepoMcpServer } from "./repo-mcp.js";
import { parseAuthor } from "./stamp.js";

type Call = { method: string; args: unknown[] };

function recordingIssueClient(
  checksStatus: PullRequestChecksStatus | Error = {
    state: "success",
    headSha: "head-sha",
    blocking: [],
  },
  prDetails: Partial<PullRequestDetails> = {}
): { client: IssueClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: IssueClient = {
    createIssue: async () => ({ number: 1, htmlUrl: "" }),
    createPullRequest: async () => ({ number: 1, htmlUrl: "" }),
    getOpenPullRequestsByAuthor: async () => [],
    getOpenPullRequests: async () => [],
    listIssues: async () => [],
    getPullRequestDetails: async (repo, prNumber) => {
      calls.push({ method: "getPullRequestDetails", args: [repo, prNumber] });
      return {
        number: 1,
        title: "",
        body: "",
        htmlUrl: "",
        headRef: "",
        baseRef: "staging",
        headSha: "details-head-sha",
        state: "",
        ...prDetails,
      };
    },
    getPullRequestChecksStatus: async (repo, prNumber) => {
      calls.push({ method: "getPullRequestChecksStatus", args: [repo, prNumber] });
      if (checksStatus instanceof Error) throw checksStatus;
      return checksStatus;
    },
    getIssue: async () => ({ number: 1, title: "", body: "", state: "", author: "" }),
    listIssueComments: async () => [],
    postComment: async (repo, issueNumber, body) => {
      calls.push({ method: "postComment", args: [repo, issueNumber, body] });
    },
    updateIssueBody: async () => {},
    addLabel: async () => {},
    removeLabel: async () => {},
    closeIssue: async (repo, issueNumber, stateReason) => {
      calls.push({ method: "closeIssue", args: [repo, issueNumber, stateReason] });
    },
    reopenIssue: async () => {},
    mergePullRequest: async (opts: MergePullRequestOptions) => {
      calls.push({ method: "mergePullRequest", args: [opts] });
      return "abc123sha";
    },
    createPullRequestReview: async () => undefined,
    createPrReviewComment: async () => ({
      id: 1,
      htmlUrl: "https://example.test/pr/1#discussion_r1",
      path: "a.ts",
      line: 1,
      body: "b",
    }),
    addReaction: async () => {},
    addCommentReaction: async () => {},
    getPrReviewComments: async () => [],
    getPullRequestReview: async () => null,
    getParentIssueNumber: async () => null,
    getRootIssueNumber: async () => null,
    hasSubIssues: async () => false,
    addSubIssue: async () => {},
    removeSubIssue: async () => {},
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

describe("repo MCP server", () => {
  it("exposes the full repo write tool surface", async () => {
    const { client: backend } = recordingIssueClient();
    const client = await connect(createRepoMcpServer("test-actor-1", backend));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["merge_pull_request"]);
  });

  it("merges pull request with default options and checks headSha", async () => {
    const { client: backend, calls } = recordingIssueClient();
    const client = await connect(createRepoMcpServer("test-actor-1", backend));

    const res = (await client.callTool({
      name: "merge_pull_request",
      arguments: { repo: "owner/repo", prNumber: 42 },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("abc123sha");

    expect(calls).toHaveLength(3);
    expect(calls[0].method).toBe("getPullRequestDetails");
    expect(calls[0].args).toEqual(["owner/repo", 42]);
    expect(calls[1].method).toBe("getPullRequestChecksStatus");
    expect(calls[1].args).toEqual(["owner/repo", 42]);

    expect(calls[2].method).toBe("mergePullRequest");
    expect(calls[2].args[0]).toEqual({
      repo: "owner/repo",
      prNumber: 42,
      method: "squash",
      deleteBranch: true,
      commitMessage: undefined,
      expectedHeadSha: "head-sha",
    });
  });

  it("refuses merge when checks are non-green and no override is provided", async () => {
    const { client: backend, calls } = recordingIssueClient({
      state: "failure",
      headSha: "head-sha",
      blocking: [{ name: "ci/test", conclusion: "failure" }],
    });
    const client = await connect(createRepoMcpServer("test-actor-1", backend));

    const res = (await client.callTool({
      name: "merge_pull_request",
      arguments: { repo: "owner/repo", prNumber: 42 },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Pull request checks are failure: ci/test (failure)");
    expect(textOf(res)).toContain("Pass overrideFailingChecks: true and overrideReason");
    expect(calls.map((c) => c.method)).toEqual([
      "getPullRequestDetails",
      "getPullRequestChecksStatus",
    ]);
  });

  it("refuses merge when overrideFailingChecks is true but overrideReason is empty or missing", async () => {
    const { client: backend, calls } = recordingIssueClient({
      state: "failure",
      headSha: "head-sha",
      blocking: [{ name: "ci/test", conclusion: "failure" }],
    });
    const client = await connect(createRepoMcpServer("test-actor-1", backend));

    const res = (await client.callTool({
      name: "merge_pull_request",
      arguments: {
        repo: "owner/repo",
        prNumber: 42,
        overrideFailingChecks: true,
        overrideReason: "   ",
      },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("overrideReason is required to merge over non-green checks");
    expect(calls).toHaveLength(0);
  });

  it("allows merge over non-green checks with override and stamps the commit and comment", async () => {
    const { client: backend, calls } = recordingIssueClient({
      state: "failure",
      headSha: "head-sha",
      blocking: [{ name: "ci/test", conclusion: "failure" }],
    });
    const client = await connect(
      createRepoMcpServer("test-actor-1", backend, { instanceId: "test-instance" })
    );

    const res = (await client.callTool({
      name: "merge_pull_request",
      arguments: {
        repo: "owner/repo",
        prNumber: 42,
        overrideFailingChecks: true,
        overrideReason: "Emergency hotfix",
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("abc123sha");

    expect(calls).toHaveLength(4);
    expect(calls[0].method).toBe("getPullRequestDetails");
    expect(calls[1].method).toBe("getPullRequestChecksStatus");
    expect(calls[2].method).toBe("mergePullRequest");
    const mergeOpts = calls[2].args[0] as MergePullRequestOptions;
    expect(mergeOpts.commitMessage).toBe(
      "Merged over non-green checks by test-actor-1. Reason: Emergency hotfix"
    );

    expect(calls[3].method).toBe("postComment");
    expect(calls[3].args[0]).toBe("owner/repo");
    expect(calls[3].args[1]).toBe(42);
    const commentBody = calls[3].args[2] as string;
    expect(commentBody).toContain(
      "Merged over non-green checks by test-actor-1. Reason: Emergency hotfix"
    );
    expect(parseAuthor(commentBody)).toBe("test-actor-1");
  });

  it("handles unreadable checks error and refuses without override", async () => {
    const { client: backend, calls } = recordingIssueClient(
      new PullRequestChecksUnreadableError(
        "owner/repo",
        42,
        "Checks API unavailable",
        "unreadable-sha"
      )
    );
    const client = await connect(createRepoMcpServer("test-actor-1", backend));

    const res = (await client.callTool({
      name: "merge_pull_request",
      arguments: { repo: "owner/repo", prNumber: 42 },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Checks are unreadable");
    expect(calls.map((c) => c.method)).toEqual([
      "getPullRequestDetails",
      "getPullRequestChecksStatus",
    ]);
  });

  it("handles unreadable checks error and permits with override", async () => {
    const { client: backend, calls } = recordingIssueClient(
      new PullRequestChecksUnreadableError(
        "owner/repo",
        42,
        "Checks API unavailable",
        "unreadable-sha"
      )
    );
    const client = await connect(createRepoMcpServer("test-actor-1", backend));

    const res = (await client.callTool({
      name: "merge_pull_request",
      arguments: {
        repo: "owner/repo",
        prNumber: 42,
        overrideFailingChecks: true,
        overrideReason: "Emergency hotfix",
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(4);
    const mergeOpts = calls[2].args[0] as MergePullRequestOptions;
    expect(mergeOpts.expectedHeadSha).toBe("unreadable-sha");
  });

  it("notifies after successful merge_pull_request", async () => {
    const { client: backend } = recordingIssueClient();
    const onWrite = vi.fn();
    const client = await connect(createRepoMcpServer("test-actor-1", backend, { onWrite }));

    await client.callTool({
      name: "merge_pull_request",
      arguments: { repo: "owner/repo", prNumber: 42 },
    });

    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("closes exactly the issues named by the directive after a successful staging merge", async () => {
    const { client: backend, calls } = recordingIssueClient(undefined, {
      body: "Ships the parser.\n\n<!-- mesh:close-on-merge #114 #9 -->",
    });
    const client = await connect(
      createRepoMcpServer("test-actor-1", backend, { instanceId: "test-instance" })
    );

    const res = (await client.callTool({
      name: "merge_pull_request",
      arguments: { repo: "owner/repo", prNumber: 42 },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(textOf(res).split("\n")[0]).toBe("abc123sha");
    expect(textOf(res)).toContain("#114");
    expect(textOf(res)).toContain("#9");

    expect(calls.map((c) => c.method)).toEqual([
      "getPullRequestDetails",
      "getPullRequestChecksStatus",
      "mergePullRequest",
      "closeIssue",
      "postComment",
      "closeIssue",
      "postComment",
    ]);
    expect(calls[3].args).toEqual(["owner/repo", 114, "completed"]);
    expect(calls[5].args).toEqual(["owner/repo", 9, "completed"]);
    const closeComment = calls[4].args[2] as string;
    expect(closeComment).toContain("#42");
    expect(parseAuthor(closeComment)).toBe("test-actor-1");
  });

  it("closes nothing when the body only carries visible closing-keyword prose", async () => {
    const { client: backend, calls } = recordingIssueClient(undefined, {
      body: "Closes #114\n\nFixes #9.",
    });
    const client = await connect(createRepoMcpServer("test-actor-1", backend));

    const res = (await client.callTool({
      name: "merge_pull_request",
      arguments: { repo: "owner/repo", prNumber: 42 },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("abc123sha");
    expect(calls.map((c) => c.method)).not.toContain("closeIssue");
  });

  it("refuses to merge when the directive is malformed, closing nothing", async () => {
    const { client: backend, calls } = recordingIssueClient(undefined, {
      body: "<!-- mesh:close-on-merge #114, #9 -->",
    });
    const client = await connect(createRepoMcpServer("test-actor-1", backend));

    const res = (await client.callTool({
      name: "merge_pull_request",
      arguments: { repo: "owner/repo", prNumber: 42 },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("mesh:close-on-merge");
    expect(calls.map((c) => c.method)).toEqual(["getPullRequestDetails"]);
  });

  it("closes nothing when the merge itself fails", async () => {
    const { client: backend, calls } = recordingIssueClient(undefined, {
      body: "<!-- mesh:close-on-merge #114 -->",
    });
    const failing: IssueClient = {
      ...backend,
      mergePullRequest: async () => {
        throw new Error("merge failed");
      },
    };
    const client = await connect(createRepoMcpServer("test-actor-1", failing));

    const res = (await client.callTool({
      name: "merge_pull_request",
      arguments: { repo: "owner/repo", prNumber: 42 },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
    expect(calls.map((c) => c.method)).not.toContain("closeIssue");
  });

  it("closes nothing when the pull request merged into a branch other than staging", async () => {
    const { client: backend, calls } = recordingIssueClient(undefined, {
      baseRef: "master",
      body: "<!-- mesh:close-on-merge #114 -->",
    });
    const client = await connect(createRepoMcpServer("test-actor-1", backend));

    const res = (await client.callTool({
      name: "merge_pull_request",
      arguments: { repo: "owner/repo", prNumber: 42 },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("abc123sha");
    expect(calls.map((c) => c.method)).not.toContain("closeIssue");
  });

  it("reports a failed close without failing an already-merged pull request", async () => {
    const { client: backend, calls } = recordingIssueClient(undefined, {
      body: "<!-- mesh:close-on-merge #114 -->",
    });
    const client = await connect(
      createRepoMcpServer("test-actor-1", {
        ...backend,
        closeIssue: async () => {
          throw new Error("issue is locked");
        },
      })
    );

    const res = (await client.callTool({
      name: "merge_pull_request",
      arguments: { repo: "owner/repo", prNumber: 42 },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(textOf(res).split("\n")[0]).toBe("abc123sha");
    expect(textOf(res)).toContain("issue is locked");
    expect(calls.map((c) => c.method)).toContain("mergePullRequest");
  });

  it("does not notify when merge_pull_request fails", async () => {
    const failing: IssueClient = {
      ...recordingIssueClient().client,
      mergePullRequest: async () => {
        throw new Error("merge failed");
      },
    };
    const onWrite = vi.fn();
    const client = await connect(createRepoMcpServer("test-actor-1", failing, { onWrite }));

    const res = (await client.callTool({
      name: "merge_pull_request",
      arguments: { repo: "owner/repo", prNumber: 42 },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
    expect(onWrite).not.toHaveBeenCalled();
  });
});
