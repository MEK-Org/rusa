import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveHome } from "../config/secrets.js";
import {
  buildGitBridgeDeliverable,
  formatGitBridgePullRequestResult,
} from "./git-bridge-deliverable.js";

const execFileAsync = promisify(execFile);

export interface CreatePROptions {
  /** Repository in owner/name format */
  repo: string;
  /** Feature branch name */
  head: string;
  /** PR title */
  title: string;
  /** PR body/description */
  body: string;
  /**
   * GitHub username to request review from. Omit to open the PR with no
   * requested reviewer — the default, since a review is routed deliberately
   * rather than attached to every PR .
   */
  reviewer?: string;
  /**
   * Base branch for the PR. When omitted, the repo's default branch is used
   * on creation, or preserved unchanged on update.
   * Set this for sub-issue work that targets a long-lived feature branch,
   * or to retarget an existing PR to a new base branch.
   */
  base?: string;
}

export interface CreateIssueOptions {
  /** Repository in owner/name format */
  repo: string;
  /** Issue title */
  title: string;
  /** Issue body/description */
  body: string;
  /** Labels to apply at creation time. */
  labels?: string[];
}

export interface CreatedIssue {
  number: number;
  htmlUrl: string;
}

export interface CreatedPullRequest {
  number: number;
  htmlUrl: string;
}

export interface MergePullRequestOptions {
  /** Repository in owner/name format */
  repo: string;
  /** Pull request number */
  prNumber: number;
  /** Merge strategy */
  method: "merge" | "squash" | "rebase";
  /** Delete the head branch after a successful merge. */
  deleteBranch?: boolean;
  /** Optional merge commit body, used for explicit non-green override records. */
  commitMessage?: string;
  /** PR head SHA that was evaluated before merge; GitHub rejects if the head advanced. */
  expectedHeadSha?: string;
}

export interface PrReviewCommentItem {
  /** Relative path of the file to comment on */
  path: string;
  /** Line number in the diff to comment on */
  line: number;
  /** Inline comment body text */
  body: string;
  /** Side of the diff: "LEFT" (deleted) or "RIGHT" (added/modified) */
  side?: "LEFT" | "RIGHT";
  /** Starting line number for multi-line comments */
  startLine?: number;
  /** Starting side for multi-line comments */
  startSide?: "LEFT" | "RIGHT";
}

export interface CreatePullRequestReviewOptions {
  /** Repository in owner/name format */
  repo: string;
  /** Pull request number */
  prNumber: number;
  /** Review verdict */
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  /** Review body text */
  body: string;
  /** Optional commit SHA the review applies to */
  commitId?: string;
  /** Optional batch of inline review comments attached to this review */
  comments?: PrReviewCommentItem[];
}

export interface CreatePrReviewCommentOptions {
  /** Repository in owner/name format */
  repo: string;
  /** Pull request number */
  prNumber: number;
  /** Review comment body text */
  body: string;
  /** Relative path of the file being commented on (required when starting a new thread, omit if inReplyTo is set) */
  path?: string;
  /** Line number in the diff (required when starting a new line thread, omit if inReplyTo is set) */
  line?: number;
  /** Commit SHA to attach comment to. If omitted, resolved from PR head SHA. */
  commitId?: string;
  /** Side of the diff: "LEFT" (deleted) or "RIGHT" (added/modified). Defaults to "RIGHT". */
  side?: "LEFT" | "RIGHT";
  /** Starting line number for multi-line comments */
  startLine?: number;
  /** Starting side for multi-line comments */
  startSide?: "LEFT" | "RIGHT";
  /** Comment ID to reply to (if replying to an existing review comment thread) */
  inReplyTo?: number;
  /** Subject type: "line" (default) or "file" */
  subjectType?: "line" | "file";
}

export interface CreatedPrReviewComment {
  id: number;
  htmlUrl: string;
  path: string;
  line: number | null;
  body: string;
}

export interface PrReviewComment {
  id?: number;
  path: string;
  line: number | null;
  body: string;
  diffHunk: string;
  author?: string;
  createdAt?: string;
  inReplyToId?: number | null;
}

export interface PullRequestDetails {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  headRef: string;
  headSha: string;
  state: string;
}

export interface PullRequestChecksStatus {
  state: "success" | "failure" | "pending";
  headSha: string;
  blocking: { name: string; conclusion: string }[];
}

interface ReportedCiRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
  source: "checks" | "actions";
  createdAt: string | null;
  supersessionKey: string;
}

const GREEN_CI_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

/**
 * Reads an issue number out of a branch name, for the `issueNumber` hint on
 * {@link OpenPullRequest}. Matches an `issue-<n>` segment anywhere in the ref, so
 * `mc/issue-42`, `mc/fix/issue-42-slug` and `bot/issue-42-slug` all resolve.
 *
 * Both boundaries are deliberate: `reissue-42` is not issue 42, and `issue-42x`
 * is not a number worth trusting. A ref this cannot read yields `null`, which
 * callers must treat as "no issue named" rather than as grounds to drop the PR.
 */
export function parseIssueNumberFromBranch(branchName: string): number | null {
  const match = branchName.match(/(?:^|[^a-z0-9])issue-(\d+)(?![a-z0-9])/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

export interface OpenPullRequest {
  number: number;
  title: string;
  headRef: string;
  headRefName: string;
  htmlUrl: string;
  body: string;
  author: string;
  labels: string[];
  updatedAt: string;
  issueNumber: number | null;
}

export interface OpenIssue {
  number: number;
  title: string;
  author: string;
  labels: string[];
  state: "open" | "closed";
  updatedAt: string;
}

export interface ListIssuesOptions {
  state?: "open" | "closed" | "all";
  labels?: string[];
}

export type IssueStateReason = "completed" | "not_planned" | "reopened" | null;
export type CloseIssueReason = "completed" | "not_planned";

export interface IssueDetails {
  number: number;
  title: string;
  body: string;
  state: string;
  stateReason?: IssueStateReason;
  author: string;
}

export interface IssueComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface PollIssueOrPullRequest {
  number: number;
  title: string;
  body: string;
  author: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  isPullRequest: boolean;
}

export interface PollIssueComment {
  id: number;
  issueNumber: number;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PollBranchHead {
  sha: string;
}

export interface GitHubPollingIssueClient {
  /** List repositories currently visible in an organization. */
  listPollOrganizationRepositories(org: string): Promise<string[]>;
  /** Read one branch head for deploy-push polling; null means the branch is absent. */
  getPollBranchHead(repo: string, branch: string): Promise<PollBranchHead | null>;
  /** Fetch issues and PR-backed issues updated after a watermark for event polling. */
  listUpdatedIssuesAndPullRequests(repo: string, since: string): Promise<PollIssueOrPullRequest[]>;
  /** Fetch issue/PR conversation comments updated after a watermark for event polling. */
  listUpdatedIssueComments(repo: string, since: string): Promise<PollIssueComment[]>;
  /** Fetch the issue wrapper for a polled comment, including PR marker when present. */
  getPollIssue(repo: string, issueNumber: number): Promise<PollIssueOrPullRequest>;
}

/**
 * The reaction emoji GitHub supports on an issue/PR. `eyes` is the 👀 ack the
 * root uses to signal "seen" (reply-on-origin) without shelling raw `gh`.
 */
export type ReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

/**
 * Provider-neutral interface for the issue/PR tracker Rusa reconciles
 * against. `GitHubIssueClient` is the production implementation (backed by the
 * GitHub REST API); the self-contained e2e runner provides a peer
 * `FakeIssueClient` backed by a local tracker. The interface holds exactly the
 * operations the system performs today — nothing GitHub-specific leaks above
 * it beyond the sub-issue hierarchy, which simpler trackers model with a plain
 * parent pointer.
 *
 * Fully async: the production implementation makes network calls, and
 * blocking the event loop there would stall every concurrent thread plus
 * inbound webhook handling.
 *
 * See devlog/2026-06-07-self-contained-runner/design.md §5.2.
 */
export interface IssueClient {
  /** Create an issue. Returns the created issue number and URL. */
  createIssue(opts: CreateIssueOptions): Promise<CreatedIssue>;
  /**
   * Create a pull request, or update the existing one if a PR for the same head
   * branch already exists. Returns the number and URL of the created or
   * existing PR.
   */
  createPullRequest(opts: CreatePROptions): Promise<CreatedPullRequest>;
  /**
   * Query open pull requests created by a specific author. Returns every open
   * PR by that author; `issueNumber` is a best-effort read of the branch name
   * and is null when the branch names no issue.
   */
  getOpenPullRequestsByAuthor(repo: string, author: string): Promise<OpenPullRequest[]>;
  /**
   * Query all open pull requests, on the same terms as the author-scoped call
   * minus the author filter.
   */
  getOpenPullRequests(repo: string): Promise<OpenPullRequest[]>;
  /** Query issues with optional state and label filters. */
  listIssues(repo: string, opts?: ListIssuesOptions): Promise<OpenIssue[]>;
  /** Fetch pull request details. */
  getPullRequestDetails(repo: string, prNumber: number): Promise<PullRequestDetails>;
  /** Fetch and roll up status checks for a pull request's current head commit. */
  getPullRequestChecksStatus(repo: string, prNumber: number): Promise<PullRequestChecksStatus>;
  /**
   * Fetch an issue's (or PR's) title, body, and state. The deterministic read
   * path that replaces shelling `gh issue view` — see GROUNDING_DISCIPLINE.
   */
  getIssue(repo: string, issueNumber: number): Promise<IssueDetails>;
  /** Fetch the conversation comments on an issue or PR (not review comments). */
  listIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]>;
  /** Replace an issue body's markdown. */
  updateIssueBody(repo: string, issueNumber: number, body: string): Promise<void>;
  /** Post a comment on an issue or pull request. */
  postComment(repo: string, issueNumber: number, body: string): Promise<void>;
  /** Add a label to an issue or pull request. */
  addLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  /** Remove a label from an issue or pull request. */
  removeLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  /** Close an issue. */
  closeIssue(repo: string, issueNumber: number, stateReason?: CloseIssueReason): Promise<void>;
  /** Reopen a previously closed issue. */
  reopenIssue(repo: string, issueNumber: number): Promise<void>;
  /**
   * Merge a pull request, optionally deleting its head branch afterward.
   * Returns the merge commit SHA.
   */
  mergePullRequest(opts: MergePullRequestOptions): Promise<string>;
  /**
   * Submit a review (approve/request-changes/comment) on a pull request.
   * Returns the review URL if the API provides one.
   */
  createPullRequestReview(opts: CreatePullRequestReviewOptions): Promise<string | undefined>;
  /**
   * Post an inline review comment on a pull request diff or reply to an existing
   * review comment thread. Returns the created comment details.
   */
  createPrReviewComment(opts: CreatePrReviewCommentOptions): Promise<CreatedPrReviewComment>;
  /** Add a reaction emoji to an issue or PR (e.g. `eyes` to acknowledge). */
  addReaction(repo: string, issueNumber: number, content: ReactionContent): Promise<void>;
  /**
   * Add a reaction to a specific comment rather than the issue/PR as a whole.
   * `scope` selects the endpoint: `issue` for a conversation comment, `review`
   * for an inline PR review comment.
   */
  addCommentReaction(
    repo: string,
    commentId: number,
    content: ReactionContent,
    scope: "issue" | "review"
  ): Promise<void>;
  /** Fetch inline comments for a pull request (optionally filtered to a specific review). */
  getPrReviewComments(
    repo: string,
    prNumber: number,
    reviewId?: number
  ): Promise<PrReviewComment[]>;
  /**
   * Return the parent issue number if this issue is a sub-issue, or null if it
   * is a root issue (no parent).
   */
  getParentIssueNumber(repo: string, issueNumber: number): Promise<number | null>;
  /**
   * Return the topmost root issue number by walking the sub-issue parent chain.
   * Returns null if `issueNumber` itself has no parent (it is already a root).
   */
  getRootIssueNumber(repo: string, issueNumber: number): Promise<number | null>;
  /** Return true if this issue has at least one sub-issue (a "feature root"). */
  hasSubIssues(repo: string, issueNumber: number): Promise<boolean>;
  /** Attach a child issue to a parent tracking issue. */
  addSubIssue(repo: string, parentIssueNumber: number, childIssueNumber: number): Promise<void>;
  /** Detach a child issue from its parent. */
  removeSubIssue(repo: string, parentIssueNumber: number, childIssueNumber: number): Promise<void>;
}

/** A non-2xx GitHub API response, with the status code callers branch on. */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: string
  ) {
    super(`GitHub API ${method} ${path} failed with ${status}: ${body.slice(0, 500)}`);
    this.name = "GitHubApiError";
  }
}

/** Checks could not be read, so merge callers must fail closed unless overridden. */
export class PullRequestChecksUnreadableError extends Error {
  constructor(
    readonly repo: string,
    readonly prNumber: number,
    readonly cause: unknown,
    readonly headSha?: string
  ) {
    super(
      `Could not read checks for ${repo}#${prNumber}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "PullRequestChecksUnreadableError";
  }
}

/** GitHub rejected the merge because the PR head no longer matches the checked SHA. */
export class PullRequestHeadAdvancedError extends Error {
  constructor(
    readonly repo: string,
    readonly prNumber: number,
    readonly expectedHeadSha: string,
    readonly cause: unknown
  ) {
    super(
      `PR head advanced during merge for ${repo}#${prNumber}; re-run the checks gate before merging.`
    );
    this.name = "PullRequestHeadAdvancedError";
  }
}

const API_BASE = "https://api.github.com";

/**
 * Production {@link IssueClient}: direct REST calls against api.github.com.
 *
 * The `gh` CLI is used exactly once — `gh auth token` at first call — so the
 * client rides the host's existing gh auth context (including keyring-stored
 * tokens that never appear in a config file). A `GH_TOKEN`/`GITHUB_TOKEN` env
 * var takes precedence, mirroring gh's own resolution order, which is what
 * CI/systemd environments set anyway. Quickstart can also write a restrictive
 * `$RUSA_HOME/github-token` file so the PAT stays out of argv and the
 * process environment.
 */
export class GitHubIssueClient implements IssueClient {
  private token: string | null = null;

  private async resolveToken(): Promise<string> {
    if (this.token) return this.token;
    const fromEnv = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
    if (fromEnv) {
      this.token = fromEnv;
      return fromEnv;
    }
    const tokenFile = join(resolveHome(), "github-token");
    if (existsSync(tokenFile)) {
      const fromFile = readFileSync(tokenFile, "utf8").trim();
      if (fromFile) {
        this.token = fromFile;
        return fromFile;
      }
    }
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { encoding: "utf-8" });
    const token = stdout.trim();
    if (!token) {
      throw new Error("gh auth token returned nothing; run `gh auth login` or set GH_TOKEN");
    }
    this.token = token;
    return token;
  }

  /** One REST call. Returns the parsed JSON body (undefined for 204s). */
  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.resolveToken();
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "rusa",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new GitHubApiError(res.status, method, path, text);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.api<{ data?: T; errors?: Array<{ message: string }> }>(
      "POST",
      "/graphql",
      {
        query,
        variables,
      }
    );
    if (res.errors && res.errors.length > 0) {
      throw new Error(`GraphQL error: ${res.errors.map((e) => e.message).join(", ")}`);
    }
    if (!res.data) {
      throw new Error("GraphQL response missing data");
    }
    return res.data;
  }

  private async apiPages<T>(path: string, params: URLSearchParams): Promise<T[]> {
    const all: T[] = [];
    const perPage = params.get("per_page") ?? "100";
    params.set("per_page", perPage);

    for (let page = 1; ; page++) {
      params.set("page", String(page));
      const batch = await this.api<T[]>("GET", `${path}?${params.toString()}`);
      all.push(...batch);
      if (batch.length < Number.parseInt(perPage, 10)) return all;
    }
  }

  async createPullRequest(opts: CreatePROptions): Promise<CreatedPullRequest> {
    // Check if an open PR already exists for this head branch
    const existing = await this.findExistingPR(opts.repo, opts.head);
    if (existing) {
      // Update the existing PR's title, body, and base (if provided), then return its number + URL
      await this.api("PATCH", `/repos/${opts.repo}/pulls/${existing.number}`, {
        title: opts.title,
        body: opts.body,
        ...(opts.base !== undefined ? { base: opts.base } : {}),
      });
      return { number: existing.number, htmlUrl: existing.url };
    }

    // Unlike `gh pr create`, the REST endpoint requires an explicit base.
    const base = opts.base ?? (await this.getDefaultBranch(opts.repo));
    const pr = await this.api<{ number: number; html_url: string }>(
      "POST",
      `/repos/${opts.repo}/pulls`,
      { title: opts.title, body: opts.body, head: opts.head, base }
    );

    // No reviewer means no review request at all — not a substituted default.
    // Requesting one is a deliberate routing act .
    if (opts.reviewer) {
      await this.api("POST", `/repos/${opts.repo}/pulls/${pr.number}/requested_reviewers`, {
        reviewers: [opts.reviewer],
      });
    }

    return { number: pr.number, htmlUrl: pr.html_url };
  }

  async createIssue(opts: CreateIssueOptions): Promise<CreatedIssue> {
    const issue = await this.api<{ number: number; html_url: string }>(
      "POST",
      `/repos/${opts.repo}/issues`,
      {
        title: opts.title,
        body: opts.body,
        ...(opts.labels?.length ? { labels: opts.labels } : {}),
      }
    );
    return { number: issue.number, htmlUrl: issue.html_url };
  }

  private async getDefaultBranch(repo: string): Promise<string> {
    const data = await this.api<{ default_branch: string }>("GET", `/repos/${repo}`);
    return data.default_branch;
  }

  /**
   * Check if an open PR already exists for a given head branch.
   */
  private async findExistingPR(
    repo: string,
    head: string
  ): Promise<{ number: number; url: string } | null> {
    try {
      const owner = repo.split("/")[0];
      const prs = await this.api<Array<{ number: number; html_url: string }>>(
        "GET",
        `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open&per_page=1`
      );
      const pr = prs[0];
      return pr ? { number: pr.number, url: pr.html_url } : null;
    } catch {
      return null;
    }
  }

  async getParentIssueNumber(repo: string, issueNumber: number): Promise<number | null> {
    try {
      const parent = await this.api<{ number?: number }>(
        "GET",
        `/repos/${repo}/issues/${issueNumber}/parent`
      );
      return typeof parent?.number === "number" ? parent.number : null;
    } catch (err) {
      // No parent (or sub-issues unsupported on this repo) surfaces as 404.
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
  }

  async getRootIssueNumber(repo: string, issueNumber: number): Promise<number | null> {
    let current: number | null = await this.getParentIssueNumber(repo, issueNumber);
    if (current === null) return null;

    for (let i = 0; i < 16; i++) {
      const next = await this.getParentIssueNumber(repo, current);
      if (next === null) return current;
      current = next;
    }
    return current;
  }

  async hasSubIssues(repo: string, issueNumber: number): Promise<boolean> {
    try {
      const subIssues = await this.api<unknown[]>(
        "GET",
        `/repos/${repo}/issues/${issueNumber}/sub_issues?per_page=1`
      );
      return Array.isArray(subIssues) && subIssues.length > 0;
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return false;
      throw err;
    }
  }

  private async getIssueNodeId(repo: string, issueNumber: number): Promise<string> {
    const [owner, name] = repo.split("/");
    const res = await this.graphql<{ repository?: { issue?: { id: string } | null } }>(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          issue(number: $number) {
            id
          }
        }
      }`,
      { owner, name, number: issueNumber }
    );
    const issue = res.repository?.issue;
    if (!issue) {
      throw new Error(`issue ${repo}#${issueNumber} not found`);
    }
    return issue.id;
  }

  async addSubIssue(
    repo: string,
    parentIssueNumber: number,
    childIssueNumber: number
  ): Promise<void> {
    const parentId = await this.getIssueNodeId(repo, parentIssueNumber);
    const childId = await this.getIssueNodeId(repo, childIssueNumber);
    await this.graphql(
      `mutation($issueId: ID!, $subIssueId: ID!) { addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId, replaceParent: true }) { clientMutationId } }`,
      { issueId: parentId, subIssueId: childId }
    );
  }

  async removeSubIssue(
    repo: string,
    parentIssueNumber: number,
    childIssueNumber: number
  ): Promise<void> {
    const parentId = await this.getIssueNodeId(repo, parentIssueNumber);
    const childId = await this.getIssueNodeId(repo, childIssueNumber);
    await this.graphql(
      `mutation($issueId: ID!, $subIssueId: ID!) { removeSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) { clientMutationId } }`,
      { issueId: parentId, subIssueId: childId }
    );
  }

  async getPrReviewComments(
    repo: string,
    prNumber: number,
    reviewId?: number
  ): Promise<PrReviewComment[]> {
    const path =
      reviewId !== undefined
        ? `/repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments`
        : `/repos/${repo}/pulls/${prNumber}/comments`;
    const comments = await this.apiPages<{
      id: number;
      path: string;
      line: number | null;
      original_line: number | null;
      body: string;
      diff_hunk: string;
      user?: { login: string };
      created_at?: string;
      in_reply_to_id?: number | null;
    }>(path, new URLSearchParams({ per_page: "100" }));

    return comments.map((c) => ({
      id: c.id,
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      body: c.body,
      diffHunk: c.diff_hunk,
      author: c.user?.login,
      createdAt: c.created_at,
      inReplyToId: c.in_reply_to_id ?? null,
    }));
  }

  async getIssue(repo: string, issueNumber: number): Promise<IssueDetails> {
    const issue = await this.api<{
      number: number;
      title: string;
      body: string | null;
      state: string;
      state_reason: "completed" | "not_planned" | "reopened" | null;
      user: { login: string } | null;
    }>("GET", `/repos/${repo}/issues/${issueNumber}`);
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state,
      stateReason: issue.state_reason,
      author: issue.user?.login ?? "",
    };
  }

  async listIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]> {
    const comments = await this.apiPages<{
      id: number;
      body: string | null;
      user: { login: string } | null;
      created_at: string;
    }>(`/repos/${repo}/issues/${issueNumber}/comments`, new URLSearchParams({ per_page: "100" }));
    return comments.map((c) => ({
      id: c.id,
      author: c.user?.login ?? "",
      body: c.body ?? "",
      createdAt: c.created_at,
    }));
  }

  async listUpdatedIssuesAndPullRequests(
    repo: string,
    since: string
  ): Promise<PollIssueOrPullRequest[]> {
    const params = new URLSearchParams({
      state: "all",
      since,
      sort: "updated",
      direction: "asc",
      per_page: "100",
    });
    const issues = await this.apiPages<PollIssueResponse>(`/repos/${repo}/issues`, params);
    return issues.map(mapPollIssue);
  }

  async listPollOrganizationRepositories(org: string): Promise<string[]> {
    const repos = await this.apiPages<{ full_name: string }>(
      `/orgs/${org}/repos`,
      new URLSearchParams({ type: "all", per_page: "100" })
    );
    return repos.map((repo) => repo.full_name);
  }

  async getPollBranchHead(repo: string, branch: string): Promise<PollBranchHead | null> {
    try {
      const response = await this.api<{ commit: { sha: string } }>(
        "GET",
        `/repos/${repo}/branches/${encodeURIComponent(branch)}`
      );
      return { sha: response.commit.sha };
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
  }

  async listUpdatedIssueComments(repo: string, since: string): Promise<PollIssueComment[]> {
    const params = new URLSearchParams({ since, per_page: "100" });
    const comments = await this.apiPages<{
      id: number;
      body: string | null;
      user: { login: string } | null;
      created_at: string;
      updated_at: string;
      issue_url: string;
    }>(`/repos/${repo}/issues/comments`, params);

    return comments.map((comment) => ({
      id: comment.id,
      issueNumber: issueNumberFromUrl(comment.issue_url),
      author: comment.user?.login ?? "",
      body: comment.body ?? "",
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    }));
  }

  async getPollIssue(repo: string, issueNumber: number): Promise<PollIssueOrPullRequest> {
    const issue = await this.api<PollIssueResponse>("GET", `/repos/${repo}/issues/${issueNumber}`);
    return mapPollIssue(issue);
  }

  async postComment(repo: string, issueNumber: number, body: string): Promise<void> {
    await this.api("POST", `/repos/${repo}/issues/${issueNumber}/comments`, { body });
  }

  async updateIssueBody(repo: string, issueNumber: number, body: string): Promise<void> {
    await this.api("PATCH", `/repos/${repo}/issues/${issueNumber}`, { body });
  }

  async addLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    await this.api("POST", `/repos/${repo}/issues/${issueNumber}/labels`, { labels: [label] });
  }

  async removeLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    await this.api(
      "DELETE",
      `/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`
    );
  }

  async closeIssue(
    repo: string,
    issueNumber: number,
    stateReason?: CloseIssueReason
  ): Promise<void> {
    await this.api("PATCH", `/repos/${repo}/issues/${issueNumber}`, {
      state: "closed",
      ...(stateReason ? { state_reason: stateReason } : {}),
    });
  }

  async reopenIssue(repo: string, issueNumber: number): Promise<void> {
    await this.api("PATCH", `/repos/${repo}/issues/${issueNumber}`, { state: "open" });
  }

  async mergePullRequest(opts: MergePullRequestOptions): Promise<string> {
    // Learn the head ref before merging (merging doesn't remove the branch itself).
    const headRef = opts.deleteBranch
      ? (await this.getPullRequestDetails(opts.repo, opts.prNumber)).headRef
      : undefined;

    let result: { sha: string };
    try {
      result = await this.api<{ sha: string }>(
        "PUT",
        `/repos/${opts.repo}/pulls/${opts.prNumber}/merge`,
        {
          merge_method: opts.method,
          ...(opts.commitMessage ? { commit_message: opts.commitMessage } : {}),
          ...(opts.expectedHeadSha ? { sha: opts.expectedHeadSha } : {}),
        }
      );
    } catch (err) {
      if (
        err instanceof GitHubApiError &&
        err.status === 409 &&
        opts.expectedHeadSha &&
        err.message.includes("Head branch was modified")
      ) {
        throw new PullRequestHeadAdvancedError(opts.repo, opts.prNumber, opts.expectedHeadSha, err);
      }
      throw err;
    }

    if (headRef) {
      try {
        await this.api(
          "DELETE",
          `/repos/${opts.repo}/git/refs/heads/${encodeURIComponent(headRef)}`
        );
      } catch (err) {
        // Tolerate a branch that's already gone (auto-delete-branch repo setting,
        // a prior manual delete, etc). GitHub reports this as 422 or 404.
        if (!(err instanceof GitHubApiError && (err.status === 422 || err.status === 404))) {
          throw err;
        }
      }
    }

    return result.sha;
  }

  async createPullRequestReview(opts: CreatePullRequestReviewOptions): Promise<string | undefined> {
    const payload: Record<string, unknown> = {
      body: opts.body,
      event: opts.event,
    };
    if (opts.commitId) {
      payload.commit_id = opts.commitId;
    }
    if (opts.comments && opts.comments.length > 0) {
      payload.comments = opts.comments.map((c) => ({
        path: c.path,
        line: c.line,
        body: c.body,
        side: c.side ?? "RIGHT",
        ...(c.startLine !== undefined ? { start_line: c.startLine } : {}),
        ...(c.startLine !== undefined ? { start_side: c.startSide ?? c.side ?? "RIGHT" } : {}),
      }));
    }
    const review = await this.api<{ html_url?: string }>(
      "POST",
      `/repos/${opts.repo}/pulls/${opts.prNumber}/reviews`,
      payload
    );
    return review?.html_url;
  }

  async createPrReviewComment(opts: CreatePrReviewCommentOptions): Promise<CreatedPrReviewComment> {
    const payload: Record<string, unknown> = {
      body: opts.body,
    };
    if (opts.inReplyTo !== undefined) {
      if (
        opts.path !== undefined ||
        opts.line !== undefined ||
        opts.side !== undefined ||
        opts.startLine !== undefined ||
        opts.startSide !== undefined ||
        opts.subjectType !== undefined
      ) {
        throw new Error(
          "inReplyTo cannot be combined with path, line, side, startLine, startSide, or subjectType"
        );
      }
      payload.in_reply_to = opts.inReplyTo;
    } else {
      if (!opts.path) {
        throw new Error("path is required when creating a new review comment");
      }
      payload.path = opts.path;

      if (opts.subjectType === "file") {
        if (
          opts.line !== undefined ||
          opts.side !== undefined ||
          opts.startLine !== undefined ||
          opts.startSide !== undefined
        ) {
          throw new Error(
            "line, side, startLine, and startSide cannot be provided when subjectType is 'file'"
          );
        }
        payload.subject_type = "file";
      } else {
        if (opts.line === undefined) {
          throw new Error("line is required for line-level review comments");
        }
        payload.line = opts.line;
        const side = opts.side ?? "RIGHT";
        payload.side = side;
        if (opts.startLine !== undefined) {
          if (opts.startLine > opts.line) {
            throw new Error(
              `startLine (${opts.startLine}) cannot be greater than line (${opts.line})`
            );
          }
          payload.start_line = opts.startLine;
          payload.start_side = opts.startSide ?? side;
        }
      }

      let commitId = opts.commitId;
      if (!commitId) {
        const prDetails = await this.getPullRequestDetails(opts.repo, opts.prNumber);
        commitId = prDetails.headSha;
      }
      payload.commit_id = commitId;
    }

    const comment = await this.api<{
      id: number;
      html_url: string;
      path: string;
      line: number | null;
      body: string;
    }>("POST", `/repos/${opts.repo}/pulls/${opts.prNumber}/comments`, payload);

    return {
      id: comment.id,
      htmlUrl: comment.html_url,
      path: comment.path,
      line: comment.line,
      body: comment.body,
    };
  }

  async addReaction(repo: string, issueNumber: number, content: ReactionContent): Promise<void> {
    await this.api("POST", `/repos/${repo}/issues/${issueNumber}/reactions`, { content });
  }

  async addCommentReaction(
    repo: string,
    commentId: number,
    content: ReactionContent,
    scope: "issue" | "review"
  ): Promise<void> {
    const path =
      scope === "review"
        ? `/repos/${repo}/pulls/comments/${commentId}/reactions`
        : `/repos/${repo}/issues/comments/${commentId}/reactions`;
    await this.api("POST", path, { content });
  }

  async getPullRequestDetails(repo: string, prNumber: number): Promise<PullRequestDetails> {
    const pr = await this.api<{
      number: number;
      title: string;
      body: string | null;
      html_url: string;
      head: { ref: string; sha: string };
      state: string;
    }>("GET", `/repos/${repo}/pulls/${prNumber}`);

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      htmlUrl: pr.html_url,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      state: pr.state,
    };
  }

  async getPullRequestChecksStatus(
    repo: string,
    prNumber: number
  ): Promise<PullRequestChecksStatus> {
    let headSha: string | undefined;
    try {
      const pr = await this.api<{
        head: { sha: string };
      }>("GET", `/repos/${repo}/pulls/${prNumber}`);
      headSha = pr.head.sha;
      const blocking: { name: string; conclusion: string }[] = [];
      let hasFailure = false;
      let hasPending = false;

      const combined = await this.api<{
        state: "error" | "failure" | "pending" | "success";
        statuses: Array<{
          context?: string;
          state: "error" | "failure" | "pending" | "success";
        }>;
      }>("GET", `/repos/${repo}/commits/${headSha}/status`);

      for (const status of combined.statuses) {
        const name = status.context ?? "commit status";
        if (status.state === "failure" || status.state === "error") {
          hasFailure = true;
          blocking.push({ name, conclusion: status.state });
        } else if (status.state === "pending") {
          hasPending = true;
          blocking.push({ name, conclusion: status.state });
        }
      }
      if (combined.statuses.length > 0) {
        if (combined.state === "failure" || combined.state === "error") {
          hasFailure = true;
          if (!blocking.some((check) => check.conclusion === combined.state)) {
            blocking.push({ name: "combined status", conclusion: combined.state });
          }
        } else if (combined.state === "pending") {
          hasPending = true;
          if (!blocking.some((check) => check.conclusion === "pending")) {
            blocking.push({ name: "combined status", conclusion: "pending" });
          }
        }
      }

      const reportedRuns = this.latestReportedRunsByIdentity(
        await this.listReportedRuns(repo, headSha)
      );
      for (const run of reportedRuns) {
        const name = run.name;
        if (run.status !== "completed") {
          hasPending = true;
          blocking.push({ name, conclusion: run.status });
          continue;
        }
        const conclusion = run.conclusion;
        if (conclusion === null) {
          hasPending = true;
          blocking.push({ name, conclusion: "pending" });
        } else if (!GREEN_CI_CONCLUSIONS.has(conclusion)) {
          hasFailure = true;
          blocking.push({ name, conclusion });
        }
      }

      if (combined.statuses.length === 0 && reportedRuns.length === 0) {
        hasPending = true;
        blocking.push({ name: "no checks reported", conclusion: "missing" });
      }

      return {
        state: hasFailure ? "failure" : hasPending ? "pending" : "success",
        headSha,
        blocking,
      };
    } catch (err) {
      throw new PullRequestChecksUnreadableError(repo, prNumber, err, headSha);
    }
  }

  private async listReportedRuns(repo: string, headSha: string): Promise<ReportedCiRun[]> {
    let checkRunsError: unknown;
    try {
      return await this.listCheckRuns(repo, headSha);
    } catch (err) {
      checkRunsError = err;
    }

    try {
      // The Actions fallback sees GitHub Actions workflow runs only; third-party
      // check-runs would be invisible here. Our CI is Actions-only today.
      return await this.listActionsWorkflowRuns(repo, headSha);
    } catch (actionsError) {
      throw new AggregateError(
        [checkRunsError, actionsError],
        `Could not read check-runs or Actions workflow runs for ${repo}@${headSha}`
      );
    }
  }

  private latestReportedRunsByIdentity(runs: ReportedCiRun[]): ReportedCiRun[] {
    const runsByIdentity = new Map<string, ReportedCiRun[]>();

    for (const run of runs) {
      const equivalentRuns = runsByIdentity.get(run.supersessionKey) ?? [];
      equivalentRuns.push(run);
      runsByIdentity.set(run.supersessionKey, equivalentRuns);
    }

    return [...runsByIdentity.values()].flatMap((equivalentRuns) => {
      let latestTimestampedRun: ReportedCiRun | undefined;
      const runsWithoutTimestamps: ReportedCiRun[] = [];

      for (const run of equivalentRuns) {
        const runTime = this.reportedRunTime(run);
        if (runTime === null) {
          // Recency is unknowable, so retain the run rather than risk hiding a pending/failing check.
          runsWithoutTimestamps.push(run);
          continue;
        }

        const latestTime = latestTimestampedRun ? this.reportedRunTime(latestTimestampedRun) : null;
        if (
          !latestTimestampedRun ||
          (latestTime !== null &&
            (runTime > latestTime || (runTime === latestTime && run.id > latestTimestampedRun.id)))
        ) {
          latestTimestampedRun = run;
        }
      }

      return latestTimestampedRun
        ? [latestTimestampedRun, ...runsWithoutTimestamps]
        : runsWithoutTimestamps;
    });
  }

  private reportedRunTime(run: ReportedCiRun): number | null {
    if (!run.createdAt) return null;
    const timestamp = Date.parse(run.createdAt);
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  private async listCheckRuns(repo: string, headSha: string): Promise<ReportedCiRun[]> {
    const all: ReportedCiRun[] = [];
    const perPage = 100;

    for (let page = 1; ; page++) {
      const batch = await this.api<{
        check_runs: Array<{
          id: number;
          name: string;
          status: "queued" | "in_progress" | "completed" | string;
          conclusion: string | null;
          started_at: string | null;
          app: { id: number } | null;
        }>;
      }>("GET", `/repos/${repo}/commits/${headSha}/check-runs?per_page=${perPage}&page=${page}`);
      all.push(
        ...batch.check_runs.map((run) => ({
          id: run.id,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          source: "checks" as const,
          createdAt: run.started_at,
          supersessionKey: run.app
            ? `checks:${run.app.id}:${run.name}`
            : `checks:unknown-app:${run.id}`,
        }))
      );
      if (batch.check_runs.length < perPage) return all;
    }
  }

  private async listActionsWorkflowRuns(repo: string, headSha: string): Promise<ReportedCiRun[]> {
    const all: ReportedCiRun[] = [];
    const perPage = 100;

    for (let page = 1; ; page++) {
      const batch = await this.api<{
        total_count: number;
        workflow_runs: Array<{
          id: number;
          name: string | null;
          status: "queued" | "in_progress" | "completed" | string;
          conclusion: string | null;
          created_at: string;
          run_started_at: string | null;
          workflow_id: number;
          event: string;
        }>;
      }>(
        "GET",
        `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(
          headSha
        )}&per_page=${perPage}&page=${page}`
      );
      all.push(
        ...batch.workflow_runs.map((run) => ({
          id: run.id,
          name: run.name ?? "GitHub Actions workflow",
          status: run.status,
          conclusion: run.conclusion,
          source: "actions" as const,
          createdAt: run.created_at ?? run.run_started_at,
          supersessionKey: `actions:${run.workflow_id}:${run.event}`,
        }))
      );
      if (batch.workflow_runs.length < perPage) return all;
    }
  }

  async getOpenPullRequestsByAuthor(repo: string, author: string): Promise<OpenPullRequest[]> {
    return (await this.fetchOpenPullRequests(repo)).filter((pr) => pr.author === author);
  }

  async getOpenPullRequests(repo: string): Promise<OpenPullRequest[]> {
    return this.fetchOpenPullRequests(repo);
  }

  async listIssues(repo: string, opts: ListIssuesOptions = {}): Promise<OpenIssue[]> {
    const params = new URLSearchParams({
      state: opts.state ?? "open",
      per_page: "100",
    });
    if (opts.labels?.length) {
      params.set("labels", opts.labels.join(","));
    }
    const issues = await this.apiPages<{
      number: number;
      title: string;
      user: { login: string } | null;
      labels: Array<string | { name?: string | null }>;
      state: "open" | "closed";
      updated_at: string;
      pull_request?: unknown;
    }>(`/repos/${repo}/issues`, params);

    return issues
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        author: issue.user?.login ?? "",
        labels: issue.labels
          .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
          .filter((label) => label.length > 0),
        state: issue.state,
        updatedAt: issue.updated_at,
      }));
  }

  private async fetchOpenPullRequests(repo: string): Promise<OpenPullRequest[]> {
    const prs = await this.apiPages<{
      number: number;
      title: string;
      head: { ref: string };
      html_url: string;
      body: string | null;
      user: { login: string } | null;
      labels: Array<string | { name?: string | null }>;
      updated_at: string;
    }>(`/repos/${repo}/pulls`, new URLSearchParams({ state: "open", per_page: "100" }));

    return prs.map((pr) => {
      return {
        number: pr.number,
        title: pr.title,
        headRef: pr.head.ref,
        headRefName: pr.head.ref,
        htmlUrl: pr.html_url,
        body: pr.body ?? "",
        author: pr.user?.login ?? "",
        labels: pr.labels
          .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
          .filter((label) => label.length > 0),
        updatedAt: pr.updated_at,
        issueNumber: parseIssueNumberFromBranch(pr.head.ref),
      };
    });
  }
}

export class GitBridgeIssueClient implements IssueClient, GitHubPollingIssueClient {
  constructor(
    private readonly delegate: IssueClient & GitHubPollingIssueClient,
    private readonly opts: { port: number }
  ) {}

  async createPullRequest(opts: CreatePROptions): Promise<CreatedPullRequest> {
    const deliverable = buildGitBridgeDeliverable({
      repo: opts.repo,
      head: opts.head,
      base: opts.base,
      port: this.opts.port,
    });
    // No PR exists on the bridge path — the deliverable instructions stand in
    // for the URL and there is no real PR number to report (0 is the "no PR"
    // placeholder). In practice unreachable: the per-actor tracker tool
    // short-circuits the bridge before reaching the client.
    return { number: 0, htmlUrl: formatGitBridgePullRequestResult(deliverable) };
  }

  createIssue(opts: CreateIssueOptions): Promise<CreatedIssue> {
    return this.delegate.createIssue(opts);
  }

  getOpenPullRequestsByAuthor(repo: string, author: string): Promise<OpenPullRequest[]> {
    return this.delegate.getOpenPullRequestsByAuthor(repo, author);
  }

  getOpenPullRequests(repo: string): Promise<OpenPullRequest[]> {
    return this.delegate.getOpenPullRequests(repo);
  }

  listIssues(repo: string, opts?: ListIssuesOptions): Promise<OpenIssue[]> {
    return this.delegate.listIssues(repo, opts);
  }

  getPullRequestDetails(repo: string, prNumber: number): Promise<PullRequestDetails> {
    return this.delegate.getPullRequestDetails(repo, prNumber);
  }

  getPullRequestChecksStatus(repo: string, prNumber: number): Promise<PullRequestChecksStatus> {
    return this.delegate.getPullRequestChecksStatus(repo, prNumber);
  }

  getIssue(repo: string, issueNumber: number): Promise<IssueDetails> {
    return this.delegate.getIssue(repo, issueNumber);
  }

  listIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]> {
    return this.delegate.listIssueComments(repo, issueNumber);
  }

  postComment(repo: string, issueNumber: number, body: string): Promise<void> {
    return this.delegate.postComment(repo, issueNumber, body);
  }

  updateIssueBody(repo: string, issueNumber: number, body: string): Promise<void> {
    return this.delegate.updateIssueBody(repo, issueNumber, body);
  }

  addLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    return this.delegate.addLabel(repo, issueNumber, label);
  }

  removeLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    return this.delegate.removeLabel(repo, issueNumber, label);
  }

  closeIssue(repo: string, issueNumber: number, stateReason?: CloseIssueReason): Promise<void> {
    return this.delegate.closeIssue(repo, issueNumber, stateReason);
  }

  reopenIssue(repo: string, issueNumber: number): Promise<void> {
    return this.delegate.reopenIssue(repo, issueNumber);
  }

  mergePullRequest(opts: MergePullRequestOptions): Promise<string> {
    return this.delegate.mergePullRequest(opts);
  }

  createPullRequestReview(opts: CreatePullRequestReviewOptions): Promise<string | undefined> {
    return this.delegate.createPullRequestReview(opts);
  }

  createPrReviewComment(opts: CreatePrReviewCommentOptions): Promise<CreatedPrReviewComment> {
    return this.delegate.createPrReviewComment(opts);
  }

  addReaction(repo: string, issueNumber: number, content: ReactionContent): Promise<void> {
    return this.delegate.addReaction(repo, issueNumber, content);
  }

  addCommentReaction(
    repo: string,
    commentId: number,
    content: ReactionContent,
    scope: "issue" | "review"
  ): Promise<void> {
    return this.delegate.addCommentReaction(repo, commentId, content, scope);
  }

  getPrReviewComments(
    repo: string,
    prNumber: number,
    reviewId?: number
  ): Promise<PrReviewComment[]> {
    return this.delegate.getPrReviewComments(repo, prNumber, reviewId);
  }

  getParentIssueNumber(repo: string, issueNumber: number): Promise<number | null> {
    return this.delegate.getParentIssueNumber(repo, issueNumber);
  }

  getRootIssueNumber(repo: string, issueNumber: number): Promise<number | null> {
    return this.delegate.getRootIssueNumber(repo, issueNumber);
  }

  hasSubIssues(repo: string, issueNumber: number): Promise<boolean> {
    return this.delegate.hasSubIssues(repo, issueNumber);
  }

  addSubIssue(repo: string, parentIssueNumber: number, childIssueNumber: number): Promise<void> {
    return this.delegate.addSubIssue(repo, parentIssueNumber, childIssueNumber);
  }

  removeSubIssue(repo: string, parentIssueNumber: number, childIssueNumber: number): Promise<void> {
    return this.delegate.removeSubIssue(repo, parentIssueNumber, childIssueNumber);
  }

  listUpdatedIssuesAndPullRequests(repo: string, since: string): Promise<PollIssueOrPullRequest[]> {
    return this.delegate.listUpdatedIssuesAndPullRequests(repo, since);
  }

  listPollOrganizationRepositories(org: string): Promise<string[]> {
    return this.delegate.listPollOrganizationRepositories(org);
  }

  getPollBranchHead(repo: string, branch: string): Promise<PollBranchHead | null> {
    return this.delegate.getPollBranchHead(repo, branch);
  }

  listUpdatedIssueComments(repo: string, since: string): Promise<PollIssueComment[]> {
    return this.delegate.listUpdatedIssueComments(repo, since);
  }

  getPollIssue(repo: string, issueNumber: number): Promise<PollIssueOrPullRequest> {
    return this.delegate.getPollIssue(repo, issueNumber);
  }
}

interface PollIssueResponse {
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  state: string;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

function mapPollIssue(issue: PollIssueResponse): PollIssueOrPullRequest {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    author: issue.user?.login ?? "",
    state: issue.state,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    isPullRequest: issue.pull_request !== undefined,
  };
}

function issueNumberFromUrl(issueUrl: string): number {
  const raw = issueUrl.split("/").pop();
  const number = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(number)) {
    throw new Error(`Could not parse issue number from ${issueUrl}`);
  }
  return number;
}

/**
 * Bridge accessor for the active {@link IssueClient}, deliberately mirroring
 * {@link getRepositories}. It lets the many call sites (scheduler, personas,
 * dashboard) share one swappable client without threading it down from the
 * composition root. The default is the production {@link GitHubIssueClient}; the
 * e2e runner calls {@link setIssueClient} to install a `FakeIssueClient`.
 */
let activeIssueClient: IssueClient | null = null;

export function getIssueClient(): IssueClient {
  if (!activeIssueClient) {
    activeIssueClient = new GitHubIssueClient();
  }
  return activeIssueClient;
}

export function setIssueClient(client: IssueClient): void {
  activeIssueClient = client;
}

export function resetIssueClient(): void {
  activeIssueClient = null;
}
