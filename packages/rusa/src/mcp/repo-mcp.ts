import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type IssueClient,
  type PullRequestChecksStatus,
  PullRequestChecksUnreadableError,
} from "../gitops/issue-client.js";
import { parseCloseOnMergeDirective } from "./close-on-merge.js";
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

  const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const matchingCloseDirective = (
    beforeMerge: ReturnType<typeof parseCloseOnMergeDirective>,
    afterMerge: ReturnType<typeof parseCloseOnMergeDirective>
  ) =>
    beforeMerge.kind === "close" &&
    afterMerge.kind === "close" &&
    beforeMerge.issueNumbers.length === afterMerge.issueNumbers.length &&
    beforeMerge.issueNumbers.every(
      (issueNumber, index) => issueNumber === afterMerge.issueNumbers[index]
    );

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

        const pr = await issueClient.getPullRequestDetails(repo, prNumber);
        const closeDirective =
          pr.baseRef === "staging"
            ? parseCloseOnMergeDirective(pr.body)
            : { kind: "absent" as const };
        if (closeDirective.kind === "malformed") {
          return toolError(new Error(closeDirective.reason));
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
        const closeResults: string[] = [];
        if (closeDirective.kind === "close") {
          try {
            const mergedPr = await issueClient.getPullRequestDetails(repo, prNumber);
            const mergedDirective =
              mergedPr.baseRef === "staging"
                ? parseCloseOnMergeDirective(mergedPr.body)
                : { kind: "absent" as const };
            if (!matchingCloseDirective(closeDirective, mergedDirective)) {
              closeResults.push(
                "Did not close requested issues: the merged pull request no longer matched the directive read before merge."
              );
            } else {
              for (const issueNumber of closeDirective.issueNumbers) {
                try {
                  await issueClient.closeIssue(repo, issueNumber, "completed");
                  closeResults.push(`Closed #${issueNumber}.`);
                  try {
                    await issueClient.postComment(
                      repo,
                      issueNumber,
                      appendAuthorStamp(
                        `Closed automatically after pull request #${prNumber} merged to staging.`,
                        repo,
                        issueNumber
                      )
                    );
                  } catch (err) {
                    closeResults.push(
                      `Closed #${issueNumber}, but could not post its merge record: ${errorMessage(err)}`
                    );
                  }
                } catch (err) {
                  closeResults.push(`Could not close #${issueNumber}: ${errorMessage(err)}`);
                }
              }
            }
          } catch (err) {
            closeResults.push(
              `Did not close requested issues because the merged pull request could not be re-read: ${errorMessage(err)}`
            );
          }
        }
        options.onWrite?.();
        return toolOk([sha, ...closeResults].join("\n"));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
