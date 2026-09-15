import type { GitHubOrgConfig } from "../config/types.js";
import type {
  GitHubPollingIssueClient,
  PollIssueComment,
  PollIssueOrPullRequest,
} from "../gitops/issue-client.js";
import {
  GITHUB_POLL_EPOCH,
  type GitHubPollSeenEvent,
  type GitHubPollStateStore,
} from "./poll-state-store.js";

type EmitGitHubEvent = (
  event: string,
  payload: Record<string, unknown>,
  deliveryId?: string
) => Promise<void>;

export interface GitHubPollerOptions {
  repos: string[];
  orgs?: GitHubOrgConfig[];
  /** Branch whose head changes synthesize repo-scoped deploy push notifications. */
  deployBranch?: string;
  /**
   * Optional because raw `config.yaml` does not guarantee it — see
   * {@link DEFAULT_POLL_INTERVAL_SECONDS}. Declaring it required made the type
   * promise a number the config layer never had to supply .
   */
  intervalSeconds?: number;
  issueClient: GitHubPollingIssueClient;
  onEvent: EmitGitHubEvent;
  /**
   * Durable cursors, seen keys, branch heads and draft set in `mesh.db`. The poller
   * writes through to it after every delivery rather than snapshotting at the
   * end of a cycle; see {@link GitHubPollStateStore} for the ordering rule
   * that makes a mid-cycle crash re-emit rather than skip.
   */
  state: GitHubPollStateStore;
}

/**
 * Applied when the caller supplies no interval. The invariant "the poller always
 * has a numeric interval" belongs here rather than in the config loader, because
 * a programmatic construction that bypasses `loadConfig` needs it too. Without it
 * an absent value multiplied out to `NaN`, which `setInterval` coerces to `0` —
 * a hot poll loop rather than a visible failure . Kept well under the
 * 15-minute stamp freshness window in `mcp/stamp.ts`, which assumes this cadence.
 */
export const DEFAULT_POLL_INTERVAL_SECONDS = 300;

export class GitHubEventPoller {
  private readonly state: GitHubPollStateStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private closed = false;

  constructor(private readonly options: GitHubPollerOptions) {
    this.state = options.state;
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce().catch((err) => this.logPollError(err));
    this.timer = setInterval(
      () => void this.pollOnce().catch((err) => this.logPollError(err)),
      (this.options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000
    );
    this.timer.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const repos = await this.resolveConfiguredRepos();
      const explicitRepos = new Set(this.options.repos.map((repo) => repo.toLowerCase()));
      for (const repo of repos) {
        await this.pollRepo(repo);
        if (explicitRepos.has(repo.toLowerCase())) {
          await this.pollDeployBranch(repo);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async resolveConfiguredRepos(): Promise<string[]> {
    const excluded = new Set(
      (this.options.orgs ?? [])
        .flatMap((entry) => entry.excludedRepos ?? [])
        .map((repo) => repo.toLowerCase())
    );
    const repos = new Map<string, string>();
    const add = (repo: string): void => {
      const key = repo.toLowerCase();
      if (!excluded.has(key)) repos.set(key, repo);
    };

    for (const repo of this.options.repos) add(repo);
    for (const entry of this.options.orgs ?? []) {
      for (const repo of await this.options.issueClient.listPollOrganizationRepositories(
        entry.org
      )) {
        add(repo);
      }
    }
    return [...repos.values()];
  }

  private async pollDeployBranch(repo: string): Promise<void> {
    const branch = this.options.deployBranch ?? "master";
    const head = await this.options.issueClient.getPollBranchHead(repo, branch);
    if (!head) return;

    const previous = this.state.getBranchHead(repo, branch);
    if (previous === undefined || previous === head.sha) {
      this.state.recordBranchHead(repo, branch, head.sha);
      return;
    }

    // Deliberately omit `ref`: a webhook push with a ref is an exact
    // github_branch resource and cannot bubble. Polling is enabled only for
    // explicitly configured github.repos, so this synthetic notification is
    // repo-scoped and reaches that exact configured subscription. This replaces
    // the removed explicit deploy-branch eventSource without turning github.orgs
    // into a branch-push firehose.
    await this.options.onEvent(
      "push",
      {
        before: previous,
        after: head.sha,
        repository: repositoryPayload(repo),
      },
      eventDeliveryId(repo, `push:${branch}:${head.sha}`)
    );
    // Persisted only once the push has been delivered, so a crash in between
    // re-emits it next cycle under the same delivery id.
    this.state.recordBranchHead(repo, branch, head.sha);
  }

  private async pollRepo(repo: string): Promise<void> {
    const { issuesWatermark, commentsWatermark } = this.state.getCursors(repo) ?? {
      issuesWatermark: GITHUB_POLL_EPOCH,
      commentsWatermark: GITHUB_POLL_EPOCH,
    };

    const issueRecords = await this.options.issueClient.listUpdatedIssuesAndPullRequests(
      repo,
      issuesWatermark
    );
    const comments = await this.options.issueClient.listUpdatedIssueComments(
      repo,
      commentsWatermark
    );

    // Each entry is the seen event the store will record plus how to emit it.
    const events: Array<GitHubPollSeenEvent & { emit: () => Promise<void> }> = [
      ...comments.map((comment) => ({
        key: `issue_comment:${comment.id}:${comment.updatedAt}`,
        updatedAt: comment.updatedAt,
        stream: "comments" as const,
        emit: async () => {
          const issue = await this.options.issueClient.getPollIssue(repo, comment.issueNumber);
          await this.options.onEvent(
            "issue_comment",
            issueCommentPayload(repo, comment, issue),
            eventDeliveryId(repo, `issue_comment:${comment.id}:${comment.updatedAt}`)
          );
        },
      })),
      ...issueRecords
        .filter((issue) => !issue.isPullRequest)
        .map((issue) => ({
          key: `issues:${issue.number}:${issue.updatedAt}`,
          updatedAt: issue.updatedAt,
          stream: "issues" as const,
          emit: () =>
            this.options.onEvent(
              "issues",
              issuePayload(repo, issue),
              eventDeliveryId(repo, `issues:${issue.number}:${issue.updatedAt}`)
            ),
        })),
      ...issueRecords
        .filter((issue) => issue.isPullRequest)
        .map((pullRequest) => ({
          key: `pull_request:${pullRequest.number}:${pullRequest.updatedAt}`,
          updatedAt: pullRequest.updatedAt,
          stream: "issues" as const,
          emit: () =>
            this.options.onEvent(
              "pull_request",
              pullRequestPayload(
                repo,
                pullRequest,
                this.state.isDraftPullRequest(repo, pullRequest.number)
              ),
              eventDeliveryId(repo, `pull_request:${pullRequest.number}:${pullRequest.updatedAt}`)
            ),
          // The PR's standing once this event is out. Entries leave the draft
          // set when the PR is ready or closed.
          pullRequest: {
            number: pullRequest.number,
            draft: pullRequest.draft && pullRequest.state === "open",
          },
        })),
    ].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

    // Deliver oldest first, and record each event only after its delivery
    // resolved: a crash before that point re-emits the event next cycle under
    // the same delivery id, which the durable inbox already dedups, whereas
    // recording first would drop it. A PR's draft standing rides on the same
    // record, so it can never be committed without the key or vice versa.
    for (const event of events) {
      if (this.state.hasSeen(repo, event.key)) continue;
      await event.emit();
      const { emit: _emit, ...seen } = event;
      this.state.recordEmitted(repo, seen);
    }

    // Only now, with both batches fully processed, may the cursors move — to
    // the newest timestamp each endpoint returned. Advancing per delivered
    // event instead would be safe only while the delivery order is ascending
    // and `since` is inclusive; a crash part-way through an unsorted or
    // equal-timestamp batch would otherwise leave the cursor past an event
    // that never went out, and no later fetch could return it. Deferring the
    // advance costs one re-fetch of an interrupted batch, whose already
    // delivered events the seen keys above suppress.
    const latestIssue = latestUpdatedAt(issueRecords);
    if (latestIssue) this.state.advanceCursor(repo, "issues", latestIssue);
    const latestComment = latestUpdatedAt(comments);
    if (latestComment) this.state.advanceCursor(repo, "comments", latestComment);
    this.state.pruneSeen(repo);
  }

  private logPollError(err: unknown): void {
    console.warn(
      `[github-poller] poll failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * The newest `updatedAt` in one endpoint's response, or `undefined` for an
 * empty one — an empty batch teaches nothing, so its cursor stays put.
 */
function latestUpdatedAt(records: Array<{ updatedAt: string }>): string | undefined {
  let latest: string | undefined;
  for (const record of records) {
    if (latest === undefined || record.updatedAt > latest) latest = record.updatedAt;
  }
  return latest;
}

function eventDeliveryId(repo: string, eventKey: string): string {
  return `poll:${repo}:${eventKey}`;
}

export function startGitHubEventPoller(options: GitHubPollerOptions): GitHubEventPoller {
  const poller = new GitHubEventPoller(options);
  poller.start();
  return poller;
}

function repositoryPayload(repo: string): Record<string, unknown> {
  const [owner, name] = repo.split("/");
  return {
    full_name: repo,
    name,
    owner: { login: owner },
  };
}

function sender(login: string): Record<string, unknown> {
  return { login };
}

function issuePayload(repo: string, issue: PollIssueOrPullRequest): Record<string, unknown> {
  return {
    action: issue.createdAt === issue.updatedAt ? "opened" : "edited",
    repository: repositoryPayload(repo),
    issue: webhookIssue(issue),
    sender: sender(issue.author),
  };
}

function issueCommentPayload(
  repo: string,
  comment: PollIssueComment,
  issue: PollIssueOrPullRequest
): Record<string, unknown> {
  return {
    action: comment.createdAt === comment.updatedAt ? "created" : "edited",
    repository: repositoryPayload(repo),
    comment: {
      id: comment.id,
      body: comment.body,
      user: sender(comment.author),
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    },
    issue: webhookIssue(issue),
    sender: sender(comment.author),
  };
}

function pullRequestPayload(
  repo: string,
  pullRequest: PollIssueOrPullRequest,
  wasDraft: boolean
): Record<string, unknown> {
  return {
    action: pullRequestAction(pullRequest, wasDraft),
    repository: repositoryPayload(repo),
    pull_request: {
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body,
      user: sender(pullRequest.author),
      state: pullRequest.state,
      created_at: pullRequest.createdAt,
      updated_at: pullRequest.updatedAt,
      draft: pullRequest.draft,
    },
    sender: sender(pullRequest.author),
  };
}

/**
 * Polling sees states, webhooks see transitions. `opened` and `edited` come
 * from timestamps as before; `ready_for_review` is the one transition worth
 * reconstructing, because a draft opening is held at the PR and the owner
 * would otherwise never hear about it (issue #307). `wasDraft` comes from the
 * durable draft set, so the reconstruction survives a restart.
 */
function pullRequestAction(pullRequest: PollIssueOrPullRequest, wasDraft: boolean): string {
  if (pullRequest.createdAt === pullRequest.updatedAt) return "opened";
  if (wasDraft && !pullRequest.draft && pullRequest.state === "open") return "ready_for_review";
  return "edited";
}

function webhookIssue(issue: PollIssueOrPullRequest): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: sender(issue.author),
    state: issue.state,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    ...(issue.isPullRequest ? { pull_request: {} } : {}),
  };
}
