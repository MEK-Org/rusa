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

/**
 * GitHub's conclusions for a completed check suite.
 *
 * Listed rather than taken as `string` so {@link CHECK_SUITE_WAKES} can be a
 * total `Record` over them.
 */
type CheckSuiteConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "stale"
  | "startup_failure"
  | "skipped";

/**
 * Whether a completed check suite is something an actor has to act on.
 *
 * A green suite is a status transition the gate already tracks, and it arrives
 * once per re-run: root's inbox took ~10 of them in two wakes off one
 * obligations stack, none actionable. A red one means somebody has work, so
 * this cannot be a blanket drop of `check_suite.completed` — the distinction
 * is the whole point.
 *
 * Total on purpose: a conclusion GitHub adds later fails to compile until
 * somebody decides which it is. The unrecognised case still wakes (see
 * {@link checkSuiteWakesAnyone}), because the two directions are not
 * symmetrical — an extra wake is noise somebody clears, while a suppressed one
 * is a red CI nobody is told about.
 */
const CHECK_SUITE_WAKES: Readonly<Record<CheckSuiteConclusion, boolean>> = {
  failure: true,
  timed_out: true,
  action_required: true,
  // The suite never ran. Nobody is coming to tell you again.
  startup_failure: true,

  success: false,
  neutral: false,
  skipped: false,
  // Both mean superseded, not broken: a newer suite is running or has run, and
  // it will announce its own conclusion. Waking on these would restore exactly
  // the per-re-run churn this filter exists to stop.
  cancelled: false,
  stale: false,
};

/**
 * Should this `check_suite` webhook payload wake anybody?
 *
 * Answers `true` for anything it does not recognise — a payload with no
 * conclusion, a conclusion GitHub added since, a shape that isn't a check
 * suite at all. Over-filtering here is silent, and a silently swallowed red CI
 * is worse than a noisy green one.
 */
export function checkSuiteWakesAnyone(payload: Record<string, unknown>): boolean {
  const conclusion = (payload.check_suite as { conclusion?: unknown } | undefined)?.conclusion;
  if (typeof conclusion !== "string") return true;
  return CHECK_SUITE_WAKES[conclusion as CheckSuiteConclusion] ?? true;
}
