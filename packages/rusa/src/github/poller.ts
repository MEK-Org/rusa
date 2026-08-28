import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitHubOrgConfig } from "../config/types.js";
import type {
  GitHubPollingIssueClient,
  PollIssueComment,
  PollIssueOrPullRequest,
} from "../gitops/issue-client.js";

type EmitGitHubEvent = (
  event: string,
  payload: Record<string, unknown>,
  deliveryId?: string
) => Promise<void>;

export interface GitHubPollerOptions {
  repos: string[];
  orgs?: GitHubOrgConfig[];
  /** Repository whose deploy branch head is watched independently of tracker repositories. */
  deployRepo?: string;
  /** Branch whose head changes synthesize deploy push notifications. */
  deployBranch?: string;
  /**
   * Optional because raw `config.yaml` does not guarantee it — see
   * {@link DEFAULT_POLL_INTERVAL_SECONDS}. Declaring it required made the type
   * promise a number the config layer never had to supply .
   */
  intervalSeconds?: number;
  home: string;
  issueClient: GitHubPollingIssueClient;
  onEvent: EmitGitHubEvent;
  statePath?: string;
}

interface RepoPollState {
  issuesWatermark?: string;
  commentsWatermark?: string;
  /** @deprecated kept only to migrate pre-stream-cursor state files. */
  watermark?: string;
  seen: string[];
  branchHeads?: Record<string, string>;
}

interface PollerState {
  repos: Record<string, RepoPollState>;
}

const DEFAULT_WATERMARK = "1970-01-01T00:00:00.000Z";
const MAX_SEEN_PER_REPO = 1000;

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
  private readonly statePath: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private closed = false;

  constructor(private readonly options: GitHubPollerOptions) {
    this.statePath = options.statePath ?? join(options.home, "github-poller-state.json");
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
      const state = this.loadState();
      const repos = await this.resolveConfiguredRepos();
      for (const repo of repos) {
        await this.pollRepo(repo, state);
      }
      if (this.options.deployRepo) await this.pollDeployBranch(this.options.deployRepo, state);
      this.saveState(state);
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

  private async pollDeployBranch(repo: string, state: PollerState): Promise<void> {
    const branch = this.options.deployBranch ?? "master";
    const head = await this.options.issueClient.getPollBranchHead(repo, branch);
    if (!head) return;

    const repoState = state.repos[repo] ?? { seen: [] };
    state.repos[repo] = repoState;
    const previous = repoState.branchHeads?.[branch];
    repoState.branchHeads = { ...repoState.branchHeads, [branch]: head.sha };
    if (previous === undefined || previous === head.sha) return;

    // Match webhook push routing: the fully qualified ref makes this an exact
    // github_branch notification for the dedicated deploy subscription.
    await this.options.onEvent(
      "push",
      {
        before: previous,
        after: head.sha,
        ref: `refs/heads/${branch}`,
        repository: repositoryPayload(repo),
      },
      eventDeliveryId(repo, `push:${branch}:${head.sha}`)
    );
  }

  private async pollRepo(repo: string, state: PollerState): Promise<void> {
    if (!state.repos[repo]) {
      state.repos[repo] = { watermark: DEFAULT_WATERMARK, seen: [] };
    }
    const repoState = state.repos[repo];
    const seen = new Set(repoState.seen);
    const issuesWatermark = repoState.issuesWatermark ?? repoState.watermark ?? DEFAULT_WATERMARK;
    const commentsWatermark =
      repoState.commentsWatermark ?? repoState.watermark ?? DEFAULT_WATERMARK;
    let nextIssuesWatermark = issuesWatermark;
    let nextCommentsWatermark = commentsWatermark;

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

    for (const event of events) {
      if (seen.has(event.key)) continue;
      await event.emit();
      seen.add(event.key);
      if (event.stream === "issues" && event.updatedAt > nextIssuesWatermark) {
        nextIssuesWatermark = event.updatedAt;
      } else if (event.stream === "comments" && event.updatedAt > nextCommentsWatermark) {
        nextCommentsWatermark = event.updatedAt;
      }
    }

    repoState.issuesWatermark = nextIssuesWatermark;
    repoState.commentsWatermark = nextCommentsWatermark;
    delete repoState.watermark;
    repoState.seen = Array.from(seen).slice(-MAX_SEEN_PER_REPO);
  }

  private loadState(): PollerState {
    if (!existsSync(this.statePath)) return { repos: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf-8")) as PollerState;
      return { repos: parsed.repos ?? {} };
    } catch (err) {
      console.warn(
        `[github-poller] failed to read state; starting fresh: ${err instanceof Error ? err.message : String(err)}`
      );
      return { repos: {} };
    }
  }

  private saveState(state: PollerState): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
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
