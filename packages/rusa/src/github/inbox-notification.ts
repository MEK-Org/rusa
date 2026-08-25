import type { EventResource } from "../actor/event-subscriptions.js";
import type { InboxPayload } from "../actor/inbox-store.js";

export interface GitHubInboxNotification {
  resource: EventResource;
  payload: InboxPayload;
}

/**
 * Derive the one event resource used for both ISSUE_NUM routing and inbox source
 * serialization, plus event-specific metadata that is not already encoded in
 * that source.
 */
export function deriveGitHubInboxNotification(
  event: string,
  payload: Record<string, unknown>
): GitHubInboxNotification | null {
  const repo = (payload.repository as { full_name?: unknown } | undefined)?.full_name;
  if (typeof repo !== "string" || !repo) return null;

  const action = (payload.action as string | undefined)?.trim();
  const type = action ? `${event}.${action}` : event;
  let resource: EventResource;

  if (event === "check_suite" || event === "check_run") {
    const checkSuite = payload.check_suite as
      | { pull_requests?: Array<{ number?: unknown }>; head_branch?: unknown }
      | undefined;
    const checkRun = payload.check_run as
      | {
          pull_requests?: Array<{ number?: unknown }>;
          head_branch?: unknown;
          check_suite?: {
            pull_requests?: Array<{ number?: unknown }>;
            head_branch?: unknown;
          };
        }
      | undefined;

    const rawPrNumber =
      event === "check_suite"
        ? checkSuite?.pull_requests?.[0]?.number
        : (checkRun?.pull_requests?.[0]?.number ??
          checkRun?.check_suite?.pull_requests?.[0]?.number);
    const prNumber = integerId(rawPrNumber);

    const rawHeadBranch =
      event === "check_suite"
        ? checkSuite?.head_branch
        : (checkRun?.head_branch ?? checkRun?.check_suite?.head_branch);
    const headBranch =
      typeof rawHeadBranch === "string" && rawHeadBranch.trim().length > 0
        ? rawHeadBranch.trim()
        : undefined;

    if (prNumber !== undefined) {
      resource = { kind: "github_pr", repo, number: prNumber };
    } else if (headBranch !== undefined) {
      const ref = headBranch.startsWith("refs/") ? headBranch : `refs/heads/${headBranch}`;
      resource = { kind: "github_branch", repo, ref };
    } else {
      resource = { kind: "github_repo", repo };
    }
  } else {
    const pullRequest = payload.pull_request as { number?: unknown } | undefined;
    const issue = payload.issue as { number?: unknown; pull_request?: unknown } | undefined;
    const number = integerId(pullRequest?.number) ?? integerId(issue?.number);
    const isPullRequest = pullRequest != null || issue?.pull_request != null;
    const rawRef = typeof payload.ref === "string" ? payload.ref : undefined;
    const refType = payload.ref_type;
    const ref =
      event === "push"
        ? rawRef
        : (event === "create" || event === "delete") && refType === "branch" && rawRef
          ? `refs/heads/${rawRef}`
          : undefined;

    if (ref !== undefined) {
      resource = { kind: "github_branch", repo, ref };
    } else if (isPullRequest && number !== undefined) {
      resource = { kind: "github_pr", repo, number };
    } else if (number !== undefined) {
      resource = { kind: "github_issue", repo, number };
    } else {
      resource = { kind: "github_repo", repo };
    }
  }

  const inboxPayload: InboxPayload = { type };
  if (type === "pull_request.closed") {
    const merged = (payload.pull_request as { merged?: unknown } | undefined)?.merged;
    if (typeof merged === "boolean") inboxPayload.merged = merged;
  }
  const commentId = integerId((payload.comment as { id?: unknown } | undefined)?.id);
  if (commentId !== undefined) inboxPayload.commentId = commentId;

  return { resource, payload: inboxPayload };
}

function integerId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
