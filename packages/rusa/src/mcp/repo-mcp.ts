import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type IssueClient,
  type PullRequestChecksStatus,
  PullRequestChecksUnreadableError,
} from "../gitops/issue-client.js";
import { toolError, toolOk } from "./result.js";
import { stampAuthor } from "./stamp.js";
import { createMcpServer } from "./strict-server.js";

export const REPO_MCP_NAME = "repo";

export interface RepoMcpOptions {
  onWrite?: () => void;
  instanceId?: string;
  isFenced?: () => boolean;
}

/**
 * In-process MCP server exposing repository mutation tools (the Contents: write
 * surface) with actor identity stamping. Each actor gets their own instance of
 * this server with their `selfId` baked in.
 */
export function createRepoMcpServer(
  selfId: string,
  issueClient: IssueClient,
  options: RepoMcpOptions = {}
): McpServer {
  const server = createMcpServer(
    { name: REPO_MCP_NAME, version: "0.1.0" },
    { isFenced: options.isFenced }
  );

  const appendAuthorStamp = (body: string, repo: string, issueNumber: number) =>
    body
      ? `${body}\n\n${stampAuthor(selfId, repo, issueNumber, options.instanceId)}`
      : stampAuthor(selfId, repo, issueNumber, options.instanceId);

  const overrideHint =
    'Pass overrideFailingChecks: true and overrideReason: "..." to merge anyway.';

  const formatBlockingChecks = (checks: PullRequestChecksStatus) =>
    checks.blocking.length
      ? checks.blocking.map((check) => `${check.name} (${check.conclusion})`).join(", ")
      : `overall checks state: ${checks.state}`;

  server.registerTool(
    "merge_pull_request",
    {
      title: "Merge a pull request",
      description:
        "Merge a pull request. Defaults to squash-merge with the head branch deleted " +
        "afterward (this repo's convention); pass method/deleteBranch to override. " +
        "Returns the merge commit SHA.",
      inputSchema: {
        repo: z.string().describe("Repository in owner/name format"),
        prNumber: z.number().int().describe("The pull request number"),
        method: z
          .enum(["merge", "squash", "rebase"])
          .optional()
          .describe("Merge strategy; defaults to squash"),
        deleteBranch: z
          .boolean()
          .optional()
          .describe("Delete the head branch after a successful merge; defaults to true"),
        overrideFailingChecks: z
          .boolean()
          .optional()
          .describe("Explicitly merge despite failing, pending, or unreadable checks"),
        overrideReason: z
          .string()
          .optional()
          .describe("Required reason when overrideFailingChecks is true"),
      },
    },
    async ({ repo, prNumber, method, deleteBranch, overrideFailingChecks, overrideReason }) => {
      try {
        const trimmedOverrideReason = overrideReason?.trim();
        if (overrideFailingChecks && !trimmedOverrideReason) {
          return toolError(new Error("overrideReason is required to merge over non-green checks"));
        }

        let checkedHeadSha: string | undefined;
        let requiresOverride = false;
        let overrideContext = "";
        try {
          const checks = await issueClient.getPullRequestChecksStatus(repo, prNumber);
          checkedHeadSha = checks.headSha;
          if (checks.state !== "success") {
            requiresOverride = true;
            overrideContext = `Pull request checks are ${checks.state}: ${formatBlockingChecks(
              checks
            )}.`;
          }
        } catch (err) {
          if (!(err instanceof PullRequestChecksUnreadableError)) throw err;
          requiresOverride = true;
          overrideContext = `${err.message}. Checks are unreadable.`;
          if (overrideFailingChecks) {
            checkedHeadSha = err.headSha;
            if (!checkedHeadSha) {
              return toolError(
                new Error(
                  `${overrideContext} Could not read PR head SHA; refusing unconstrained merge.`
                )
              );
            }
          }
        }

        if (requiresOverride && !overrideFailingChecks) {
          return toolError(new Error(`${overrideContext} ${overrideHint}`));
        }

        const overrideStamp =
          requiresOverride && trimmedOverrideReason
            ? `Merged over non-green checks by ${selfId}. Reason: ${trimmedOverrideReason}`
            : undefined;
        const sha = await issueClient.mergePullRequest({
          repo,
          prNumber,
          method: method ?? "squash",
          deleteBranch: deleteBranch ?? true,
          commitMessage: overrideStamp,
          expectedHeadSha: checkedHeadSha,
        });
        if (overrideStamp) {
          try {
            await issueClient.postComment(
              repo,
              prNumber,
              appendAuthorStamp(overrideStamp, repo, prNumber)
            );
          } catch {
            // Best-effort timeline stamp — the merge commit already carries
            // the permanent override record, so do not invite retrying a
            // successfully merged PR because the follow-up comment failed.
          }
        }
        options.onWrite?.();
        return toolOk(sha);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
