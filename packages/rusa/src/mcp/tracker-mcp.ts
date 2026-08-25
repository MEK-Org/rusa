import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EventResource } from "../actor/event-subscriptions.js";
import {
  buildGitBridgeDeliverable,
  formatGitBridgePullRequestResult,
} from "../gitops/git-bridge-deliverable.js";
import type { IssueClient } from "../gitops/issue-client.js";
import { toolError, toolOk } from "./result.js";
import { stampAuthor, stripAuthorStamps } from "./stamp.js";
import { createMcpServer } from "./strict-server.js";

export const TRACKER_MCP_NAME = "tracker";

export interface TrackerMcpOptions {
  onWrite?: () => void;
  gitBridge?: { port: number };
  onGitBridgeDeliverable?: (actorId: string, instructions: string) => void;
  instanceId?: string;
  /**
   * Invoked after `create_issue` / `create_pull_request` succeeds, with the
   * created thread's exact event resource, so the mesh can mechanically
   * subscribe the creating actor to it . Best-effort bookkeeping: a
   * throwing callback never fails the tool call.
   */
  onResourceCreated?: (resource: EventResource) => void;
  isFenced?: () => boolean;
}

/**
 * In-process MCP server exposing the issue/PR tracker (the {@link IssueClient}
 * seam) and conversation write tools with actor identity stamping.
 * Each actor gets their own instance of this server with their `selfId` baked in.
 * Writes are stamped with `<!-- mesh:author ... -->` before being sent to GitHub.
 */
export function createTrackerMcpServer(
  selfId: string,
  issueClient: IssueClient,
  options: TrackerMcpOptions = {}
): McpServer {
  const server = createMcpServer(
    { name: TRACKER_MCP_NAME, version: "0.1.0" },
    { isFenced: options.isFenced }
  );

  const appendAuthorStamp = (body: string, repo: string, issueNumber: number) =>
    body
      ? `${body}\n\n${stampAuthor(selfId, repo, issueNumber, options.instanceId)}`
      : stampAuthor(selfId, repo, issueNumber, options.instanceId);

  const appendPreCreationAuthorStamp = (body: string, repo: string) =>
    body
      ? `${body}\n\n${stampAuthor(selfId, repo, undefined, options.instanceId)}`
      : stampAuthor(selfId, repo, undefined, options.instanceId);

  /**
   * Replaces any stamps already in the body with exactly one naming this actor.
   *
   * Only for rewrites (update_body), where the incoming body is a previously stamped body
   * being replaced. Creation paths deliberately keep the append-only helpers above: a new
   * comment may legitimately QUOTE a stamp as evidence, and stripping there would silently
   * edit the author's content to no benefit (the appended stamp already wins last-index).
   */
  const restampAuthor = (body: string, repo: string, issueNumber: number) =>
    appendAuthorStamp(stripAuthorStamps(body), repo, issueNumber);

  const notifyResourceCreated = (resource: EventResource) => {
    try {
      options.onResourceCreated?.(resource);
    } catch {
      // Best-effort subscription bookkeeping — the GitHub write already
      // succeeded, so the tool call must not fail over it.
    }
  };

  server.registerTool(
    "create_pull_request",
    {
      title: "Create or update a pull request",
      description:
        "Create a PR for the given head branch, or update the existing PR if one already exists for that branch. Returns the PR URL.",
      inputSchema: {
        repo: z.string().describe("Repository in owner/name format"),
        head: z.string().describe("Feature branch name"),
        title: z.string(),
        body: z.string(),
        reviewer: z
          .string()
          .optional()
          .describe(
            "GitHub username to request review from. Omit unless this PR specifically needs that person's input — no reviewer is requested when absent."
          ),
        base: z
          .string()
          .optional()
          .describe(
            "Base branch; defaults to the repo default branch when omitted on creation, or retargets the base branch when supplied on an existing PR"
          ),
      },
    },
    async (args) => {
      try {
        if (options.gitBridge) {
          const deliverable = buildGitBridgeDeliverable({
            repo: args.repo,
            head: args.head,
            base: args.base,
            port: options.gitBridge.port,
          });
          options.onGitBridgeDeliverable?.(selfId, deliverable.instructions);
          options.onWrite?.();
          // No onResourceCreated here: on the bridge path no PR exists at tool
          // time (a human opens it later from the delivered branch), so there
          // is no resource to hand the creator .
          return toolOk(formatGitBridgePullRequestResult(deliverable));
        }
        // Stamped with the v3 pre-creation stamp, exactly like create_issue.
        // Now that the creator mechanically holds this PR's event source
        // , the stamp is what suppresses the creator's own body-ful
        // `pull_request/opened` echo; authorship still resolves per-event via
        // authorStampBodyForWebhookPayload, so labeled/closed/merged never
        // borrow it.
        const pr = await issueClient.createPullRequest({
          ...args,
          body: appendPreCreationAuthorStamp(args.body, args.repo),
        });
        options.onWrite?.();
        notifyResourceCreated({ kind: "github_pr", repo: args.repo, number: pr.number });
        return toolOk(pr.htmlUrl);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "list_open_prs",
    {
      title: "List open pull requests",
      description:
        "List open pull requests. When author is provided, preserves the legacy author-scoped rusa branch behavior; when omitted, returns all open PRs with best-effort parsed issue numbers.",
      inputSchema: {
        repo: z.string(),
        author: z
          .string()
          .optional()
          .describe(
            "GitHub login to scope to. Omitting it selects a different code path, not a wider filter: the unscoped branch, whose issue numbers are BEST-EFFORT PARSED rather than authoritative. Passing `undefined` explicitly takes that same branch."
          ),
      },
    },
    async ({ repo, author }) => {
      try {
        return toolOk(
          author !== undefined
            ? await issueClient.getOpenPullRequestsByAuthor(repo, author)
            : await issueClient.getOpenPullRequests(repo)
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "list_open_issues",
    {
      title: "List issues",
      description: "List issues with optional state and label filters. Defaults to open issues.",
      inputSchema: {
        repo: z.string(),
        state: z.enum(["open", "closed", "all"]).optional(),
        labels: z.array(z.string()).optional(),
      },
    },
    async ({ repo, state, labels }) => {
      try {
        return toolOk(await issueClient.listIssues(repo, { state, labels }));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "get_pr_details",
    {
      title: "Get pull request details",
      description: "Fetch metadata (title, body, head ref, state, URL) for a pull request.",
      inputSchema: { repo: z.string(), prNumber: z.number().int() },
    },
    async ({ repo, prNumber }) => {
      try {
        return toolOk(await issueClient.getPullRequestDetails(repo, prNumber));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "get_issue",
    {
      title: "Get issue or PR details",
      description:
        "Fetch the title, body, state, stateReason, and author of an issue or pull request. Use this — not a shell command — to read what an issue says; it is the deterministic read path and returns exactly the issue's real content.",
      inputSchema: { repo: z.string(), issueNumber: z.number().int() },
    },
    async ({ repo, issueNumber }) => {
      try {
        return toolOk(await issueClient.getIssue(repo, issueNumber));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "list_issue_comments",
    {
      title: "List issue or PR comments",
      description:
        "Fetch the conversation comments on an issue or pull request (not inline review comments), each with author, body, and timestamp.",
      inputSchema: { repo: z.string(), issueNumber: z.number().int() },
    },
    async ({ repo, issueNumber }) => {
      try {
        return toolOk(await issueClient.listIssueComments(repo, issueNumber));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "post_comment",
    {
      title: "Comment on an issue or PR",
      description:
        "Post a comment on an issue or pull request. The comment will be stamped with your authenticated identity.",
      inputSchema: {
        repo: z.string().describe("Repository in owner/name format"),
        issueNumber: z.number().int().describe("The issue or PR number"),
        body: z.string().describe("The comment body text"),
      },
    },
    async ({ repo, issueNumber, body }) => {
      try {
        const stampedBody = appendAuthorStamp(body, repo, issueNumber);
        await issueClient.postComment(repo, issueNumber, stampedBody);
        options.onWrite?.();
        return toolOk("ok");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "create_issue",
    {
      title: "Create an issue",
      description:
        "Create an issue. The issue body will be stamped with your authenticated identity.",
      inputSchema: {
        repo: z.string().describe("Repository in owner/name format"),
        title: z.string().describe("The issue title"),
        body: z.string().describe("The issue body text"),
        labels: z.array(z.string()).optional().describe("Labels to apply to the issue"),
      },
    },
    async ({ repo, title, body, labels }) => {
      try {
        const stampedBody = appendPreCreationAuthorStamp(body, repo);
        const issue = await issueClient.createIssue({ repo, title, body: stampedBody, labels });
        options.onWrite?.();
        notifyResourceCreated({ kind: "github_issue", repo, number: issue.number });
        return toolOk(issue.htmlUrl);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "add_label",
    {
      title: "Add label",
      description: "Add a label to an issue or pull request.",
      inputSchema: {
        repo: z.string().describe("Repository in owner/name format"),
        issueNumber: z.number().int().describe("The issue or PR number"),
        label: z.string().describe("The label to add"),
      },
    },
    async ({ repo, issueNumber, label }) => {
      try {
        await issueClient.addLabel(repo, issueNumber, label);
        options.onWrite?.();
        return toolOk("labeled");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "remove_label",
    {
      title: "Remove label",
      description: "Remove a label from an issue or pull request.",
      inputSchema: {
        repo: z.string().describe("Repository in owner/name format"),
        issueNumber: z.number().int().describe("The issue or PR number"),
        label: z.string().describe("The label to remove"),
      },
    },
    async ({ repo, issueNumber, label }) => {
      try {
        await issueClient.removeLabel(repo, issueNumber, label);
        options.onWrite?.();
        return toolOk("unlabeled");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "close_issue",
    {
      title: "Close issue",
      description: "Close an issue.",
      inputSchema: {
        repo: z.string().describe("Repository in owner/name format"),
        issueNumber: z.number().int().describe("The issue number"),
        stateReason: z
          .enum(["completed", "not_planned"])
          .optional()
          .describe("The reason for closing the issue, e.g. completed or not_planned"),
      },
    },
    async ({ repo, issueNumber, stateReason }) => {
      try {
        await issueClient.closeIssue(repo, issueNumber, stateReason);
        options.onWrite?.();
        return toolOk("closed");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "reopen_issue",
    {
      title: "Reopen issue",
      description: "Reopen a previously closed issue.",
      inputSchema: {
        repo: z.string().describe("Repository in owner/name format"),
        issueNumber: z.number().int().describe("The issue number"),
      },
    },
    async ({ repo, issueNumber }) => {
      try {
        await issueClient.reopenIssue(repo, issueNumber);
        options.onWrite?.();
        return toolOk("reopened");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "post_review",
    {
      title: "Review a pull request",
      description:
        "Submit a review on a pull request (approve, request changes, or comment). " +
        "The review body will be stamped with your authenticated identity.",
      inputSchema: {
        repo: z.string().describe("Repository in owner/name format"),
        prNumber: z.number().int().describe("The pull request number"),
        event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).describe("The review verdict"),
        body: z.string().describe("The review body text"),
      },
    },
    async ({ repo, prNumber, event, body }) => {
      try {
        const stampedBody = appendAuthorStamp(body, repo, prNumber);
        const url = await issueClient.createPullRequestReview({
          repo,
          prNumber,
          event,
          body: stampedBody,
        });
        options.onWrite?.();
        return toolOk(url ?? "reviewed");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "add_reaction",
    {
      title: "React to an issue, PR, or comment",
      description:
        "Add a reaction emoji. Provide exactly one of issueNumber (react to the issue/PR " +
        "itself) or commentId (react to a specific comment). When using commentId, set " +
        "commentScope to 'review' for an inline PR review comment; it defaults to 'issue' " +
        "for a regular conversation comment.",
      inputSchema: {
        repo: z.string().describe("Repository in owner/name format"),
        content: z
          .enum(["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"])
          .describe("The reaction emoji"),
        issueNumber: z.number().int().optional().describe("React to this issue or PR"),
        commentId: z.number().int().optional().describe("React to this comment instead"),
        commentScope: z
          .enum(["issue", "review"])
          .optional()
          .describe(
            "Which kind of comment commentId refers to: 'issue' (conversation comment, " +
              "default) or 'review' (inline PR review comment)"
          ),
      },
    },
    async ({ repo, content, issueNumber, commentId, commentScope }) => {
      try {
        if ((issueNumber === undefined) === (commentId === undefined)) {
          throw new Error("Provide exactly one of issueNumber or commentId");
        }
        if (issueNumber !== undefined) {
          await issueClient.addReaction(repo, issueNumber, content);
        } else {
          await issueClient.addCommentReaction(
            repo,
            commentId as number,
            content,
            commentScope ?? "issue"
          );
        }
        options.onWrite?.();
        return toolOk("reacted");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "get_pr_review_comments",
    {
      title: "Get PR review comments",
      description: "Fetch all inline comments for a specific pull request review.",
      inputSchema: { repo: z.string(), prNumber: z.number().int(), reviewId: z.number().int() },
    },
    async ({ repo, prNumber, reviewId }) => {
      try {
        return toolOk(await issueClient.getPrReviewComments(repo, prNumber, reviewId));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "get_parent_issue",
    {
      title: "Get parent issue number",
      description:
        "Return the parent issue number if this issue is a sub-issue, or null if it is a root issue.",
      inputSchema: { repo: z.string(), issueNumber: z.number().int() },
    },
    async ({ repo, issueNumber }) => {
      try {
        return toolOk(await issueClient.getParentIssueNumber(repo, issueNumber));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "get_root_issue",
    {
      title: "Get root issue number",
      description:
        "Return the topmost root issue number by walking the sub-issue parent chain, or null if this issue is already a root.",
      inputSchema: { repo: z.string(), issueNumber: z.number().int() },
    },
    async ({ repo, issueNumber }) => {
      try {
        return toolOk(await issueClient.getRootIssueNumber(repo, issueNumber));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "has_sub_issues",
    {
      title: "Check for sub-issues",
      description: "Return true if this issue has at least one sub-issue (a feature root).",
      inputSchema: { repo: z.string(), issueNumber: z.number().int() },
    },
    async ({ repo, issueNumber }) => {
      try {
        return toolOk(await issueClient.hasSubIssues(repo, issueNumber));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "set_parent",
    {
      title: "Set parent issue",
      description: "Attach a child issue to a parent tracking issue.",
      inputSchema: {
        repo: z.string(),
        issueNumber: z.number().int().describe("The child issue number"),
        parentIssueNumber: z.number().int().describe("The parent issue number"),
      },
    },
    async ({ repo, issueNumber, parentIssueNumber }) => {
      try {
        await issueClient.addSubIssue(repo, parentIssueNumber, issueNumber);
        options.onWrite?.();
        return toolOk("parent set");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "add_sub_issue",
    {
      title: "Add sub-issue",
      description: "Attach a child issue to a parent tracking issue.",
      inputSchema: {
        repo: z.string(),
        issueNumber: z.number().int().describe("The parent issue number"),
        subIssueNumber: z.number().int().describe("The child issue number"),
      },
    },
    async ({ repo, issueNumber, subIssueNumber }) => {
      try {
        await issueClient.addSubIssue(repo, issueNumber, subIssueNumber);
        options.onWrite?.();
        return toolOk("sub-issue added");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "remove_parent",
    {
      title: "Remove parent issue",
      description: "Detach a child issue from its parent.",
      inputSchema: {
        repo: z.string(),
        issueNumber: z.number().int().describe("The child issue number"),
      },
    },
    async ({ repo, issueNumber }) => {
      try {
        const parentIssueNumber = await issueClient.getParentIssueNumber(repo, issueNumber);
        if (parentIssueNumber === null) {
          return toolError(`issue ${repo}#${issueNumber} has no parent`);
        }
        await issueClient.removeSubIssue(repo, parentIssueNumber, issueNumber);
        options.onWrite?.();
        return toolOk("parent removed");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "update_body",
    {
      title: "Replace an issue or PR body",
      description:
        "Replace the ENTIRE body of an issue or pull request with the given text — this is " +
        "not an append or patch, it overwrites the whole body, so include everything you " +
        "want kept. The new body will be re-stamped with your authenticated identity.",
      inputSchema: {
        repo: z.string().describe("Repository in owner/name format"),
        issueNumber: z.number().int().describe("The issue or PR number"),
        body: z.string().describe("The full replacement body text"),
      },
    },
    async ({ repo, issueNumber, body }) => {
      try {
        const stampedBody = restampAuthor(body, repo, issueNumber);
        await issueClient.updateIssueBody(repo, issueNumber, stampedBody);
        options.onWrite?.();
        return toolOk("ok");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
