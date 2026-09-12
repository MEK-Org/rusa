import type { EventResource } from "../actor/event-subscriptions.js";
import type { InboxPayload } from "../actor/inbox-store.js";
import { githubBranchReference } from "../references/reference.js";

export interface GitHubInboxNotification {
  resource: EventResource;
  payload: InboxPayload;
}

/**
 * Derive the one event resource used for both routing and inbox source
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
  let resource: string;

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
      resource = `github:${repo}/pulls/${prNumber}`;
    } else if (headBranch !== undefined) {
      resource = githubBranchReference(repo, headBranch);
    } else {
      resource = `github:${repo}`;
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
      resource = githubBranchReference(repo, ref);
    } else if (isPullRequest && number !== undefined) {
      resource = `github:${repo}/pulls/${number}`;
    } else if (number !== undefined) {
      resource = `github:${repo}/issues/${number}`;
    } else {
      resource = `github:${repo}`;
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
 * Check-suite conclusions that mean nobody has to act.
 *
 * A green suite is a status transition the gate already tracks, and it arrives
 * once per re-run: root's inbox took ~10 of them in two wakes off one
 * obligations stack, none actionable. A red one means somebody has work, so
 * this cannot be a blanket drop of `check_suite.completed` — the distinction
 * is the whole point.
 *
 * Stated as the non-waking set because that is the closed half. Waking is the
 * default and needs no enumeration: `failure`, `timed_out` and
 * `action_required` all mean work, and `startup_failure` means the suite never
 * ran, so nobody is coming to tell you again. A conclusion GitHub adds later
 * lands there too, which is the safe direction — see
 * {@link checkSuiteWakesAnyone}.
 */
const NON_WAKING_CHECK_SUITE_CONCLUSIONS: ReadonlySet<string> = new Set([
  "success",
  "neutral",
  "skipped",
  // Both mean superseded, not broken: a newer suite is running or has run, and
  // it will announce its own conclusion. Waking on these would restore exactly
  // the per-re-run churn this filter exists to stop.
  "cancelled",
  "stale",
]);

/**
 * Should this `check_suite` webhook payload wake anybody?
 *
 * Answers `true` for anything not named above — a payload with no conclusion, a
 * conclusion GitHub added since, a shape that isn't a check suite at all. The
 * two directions are not symmetrical: an extra wake is noise somebody clears in
 * a second, while a suppressed one is a red CI nobody is ever told about. So
 * the unknown case fails loud.
 *
 * There is deliberately no compile-time check that this list still matches
 * GitHub's. It could not be honest: the values arrive as JSON off a webhook, so
 * a locally maintained union only narrows what has already been asserted, and
 * nothing short of a generated upstream type would catch a value GitHub invents
 * next year. Rather than a type that implies a guarantee it cannot keep, the
 * safety here is the runtime default, which holds for values nobody has seen.
 */
export function checkSuiteWakesAnyone(payload: Record<string, unknown>): boolean {
  const conclusion = (payload.check_suite as { conclusion?: unknown } | undefined)?.conclusion;
  if (typeof conclusion !== "string") return true;
  return !NON_WAKING_CHECK_SUITE_CONCLUSIONS.has(conclusion);
}
