import type { GitHubOrgConfig } from "../config/types.js";
import type {
  GitHubPollingIssueClient,
  PollIssueComment,
  PollIssueOrPullRequest,
} from "../gitops/issue-client.js";
import { GITHUB_POLL_EPOCH, type GitHubPollStateStore } from "./poll-state-store.js";

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
   * Durable cursors, seen keys and branch heads in `mesh.db`. The poller
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

    const events = [
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
              pullRequestPayload(repo, pullRequest),
              eventDeliveryId(repo, `pull_request:${pullRequest.number}:${pullRequest.updatedAt}`)
            ),
        })),
    ].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

    // Events are in ascending updatedAt order across both streams, so once an
    // event is delivered its stream cursor can move to its timestamp: anything
    // still undelivered in this batch is at or after it and a re-fetch from
    // there returns it again. The seen key and the cursor commit together, and
    // only after delivery resolved — a crash before that point re-emits the
    // event next cycle under the same delivery id, which the durable inbox
    // already dedups; a cursor committed before delivery would skip it.
    for (const event of events) {
      if (this.state.hasSeen(repo, event.key)) continue;
      await event.emit();
      this.state.recordEmitted(repo, {
        key: event.key,
        stream: event.stream,
        updatedAt: event.updatedAt,
      });
    }
    this.state.pruneSeen(repo);
  }

  private logPollError(err: unknown): void {
    console.warn(
      `[github-poller] poll failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
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
  pullRequest: PollIssueOrPullRequest
): Record<string, unknown> {
  return {
    action: pullRequest.createdAt === pullRequest.updatedAt ? "opened" : "edited",
    repository: repositoryPayload(repo),
    pull_request: {
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body,
      user: sender(pullRequest.author),
      state: pullRequest.state,
      created_at: pullRequest.createdAt,
      updated_at: pullRequest.updatedAt,
    },
    sender: sender(pullRequest.author),
  };
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
