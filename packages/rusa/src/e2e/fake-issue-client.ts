import {
  type CloseIssueReason,
  type CreatedIssue,
  type CreatedPrReviewComment,
  type CreatedPullRequest,
  type CreateIssueOptions,
  type CreatePROptions,
  type CreatePrReviewCommentOptions,
  type CreatePullRequestReviewOptions,
  type IssueClient,
  type IssueComment,
  type IssueDetails,
  type ListIssuesOptions,
  type MergePullRequestOptions,
  type OpenIssue,
  type OpenPullRequest,
  type PollIssueComment,
  type PollIssueOrPullRequest,
  type PrReviewComment,
  type PullRequestChecksStatus,
  PullRequestChecksUnreadableError,
  type PullRequestDetails,
  type ReactionContent,
} from "../gitops/issue-client.js";
import type { LocalTracker, ReviewState } from "./local-tracker.js";

/** Maps the REST-shaped review event to the tracker's lowercase verdict. */
const REVIEW_EVENT_TO_STATE: Record<CreatePullRequestReviewOptions["event"], ReviewState> = {
  APPROVE: "approved",
  REQUEST_CHANGES: "changes_requested",
  COMMENT: "commented",
};

/**
 * A peer {@link IssueClient} for the self-contained e2e runner — a sibling of
 * `GitHubIssueClient`, not a mock. It is backed by the {@link LocalTracker} (and,
 * for PRs, the branches the scheduler has already pushed to the local bare
 * remote). Everything above this seam runs the real production code; only the
 * provider edge is swapped. See devlog/2026-06-07-self-contained-runner/design.md §5.2.
 */
export class FakeIssueClient implements IssueClient {
  private readonly prChecks = new Map<number, PullRequestChecksStatus | "unreadable">();

  constructor(
    private readonly tracker: LocalTracker,
    private readonly botAccount: string
  ) {}

  setPullRequestChecksStatus(prNumber: number, status: PullRequestChecksStatus | "unreadable") {
    this.prChecks.set(prNumber, status);
  }

  async createIssue(opts: CreateIssueOptions): Promise<CreatedIssue> {
    const issue = await this.tracker.createIssue({
      title: opts.title,
      body: opts.body,
      author: this.botAccount,
      assign: false,
    });
    for (const label of opts.labels ?? []) {
      this.tracker.addIssueLabel(issue.number, label);
    }
    return { number: issue.number, htmlUrl: issue.htmlUrl };
  }

  async createPullRequest(opts: CreatePROptions): Promise<CreatedPullRequest> {
    // The branch already exists in the bare remote (the scheduler pushes before
    // calling us); we only register/update the PR object over it.
    const pr = this.tracker.upsertPrByHead({
      headRef: opts.head,
      title: opts.title,
      body: opts.body,
      ...(opts.base !== undefined ? { base: opts.base } : {}),
      author: this.botAccount,
    });
    return { number: pr.number, htmlUrl: pr.htmlUrl };
  }

  async getOpenPullRequestsByAuthor(_repo: string, author: string): Promise<OpenPullRequest[]> {
    return this.tracker.listOpenPrsByAuthor(author).map((pr) => this.toOpenPullRequest(pr));
  }

  async getOpenPullRequests(_repo: string): Promise<OpenPullRequest[]> {
    return this.tracker
      .listPrs()
      .filter((pr) => pr.state === "open")
      .map((pr) => this.toOpenPullRequest(pr));
  }

  async listIssues(_repo: string, opts: ListIssuesOptions = {}): Promise<OpenIssue[]> {
    const state = opts.state ?? "open";
    return this.tracker
      .listIssues()
      .filter((issue) => state === "all" || issue.state === state)
      .filter(
        (issue) =>
          !opts.labels?.length || opts.labels.every((label) => issue.labels.includes(label))
      )
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        author: issue.author,
        labels: issue.labels,
        state: issue.state,
        updatedAt: issue.updatedAt,
      }));
  }

  async getPullRequestDetails(_repo: string, prNumber: number): Promise<PullRequestDetails> {
    const pr = this.tracker.getPr(prNumber);
    if (!pr) throw new Error(`PR #${prNumber} not found in local tracker`);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      htmlUrl: pr.htmlUrl,
      headRef: pr.headRef,
      headSha: `fake-head-${prNumber}`,
      state: pr.state,
    };
  }

  async getPullRequestChecksStatus(
    repo: string,
    prNumber: number
  ): Promise<PullRequestChecksStatus> {
    const status = this.prChecks.get(prNumber);
    if (status === "unreadable") {
      throw new PullRequestChecksUnreadableError(repo, prNumber, new Error("fake unreadable"));
    }
    if (status) return status;
    return { state: "success", headSha: `fake-head-${prNumber}`, blocking: [] };
  }

  async getIssue(_repo: string, issueNumber: number): Promise<IssueDetails> {
    const issue = this.tracker.getIssue(issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found in local tracker`);
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      stateReason: issue.stateReason,
      author: issue.author,
    };
  }

  async listIssueComments(_repo: string, issueNumber: number): Promise<IssueComment[]> {
    const issue = this.tracker.getIssue(issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found in local tracker`);
    return issue.comments.map((c) => ({
      id: c.id,
      author: c.author,
      body: c.body,
      createdAt: c.createdAt,
    }));
  }

  async listUpdatedIssuesAndPullRequests(
    _repo: string,
    since: string
  ): Promise<PollIssueOrPullRequest[]> {
    return [
      ...this.tracker.listIssues().map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        author: issue.author,
        state: issue.state,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        isPullRequest: false,
      })),
      ...this.tracker.listPrs().map((pr) => ({
        number: pr.number,
        title: pr.title,
        body: pr.body,
        author: pr.author,
        state: pr.state,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        isPullRequest: true,
      })),
    ].filter((record) => record.updatedAt > since);
  }

  async listPollOrganizationRepositories(_org: string): Promise<string[]> {
    return [];
  }

  async getPollBranchHead(_repo: string, _branch: string): Promise<null> {
    return null;
  }

  async listUpdatedIssueComments(_repo: string, since: string): Promise<PollIssueComment[]> {
    return this.tracker
      .listIssues()
      .flatMap((issue) =>
        issue.comments.map((comment) => ({
          id: comment.id,
          issueNumber: issue.number,
          author: comment.author,
          body: comment.body,
          createdAt: comment.createdAt,
          updatedAt: comment.createdAt,
        }))
      )
      .filter((comment) => comment.updatedAt > since);
  }

  async getPollIssue(_repo: string, issueNumber: number): Promise<PollIssueOrPullRequest> {
    const issue = this.tracker.getIssue(issueNumber);
    if (issue) {
      return {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        author: issue.author,
        state: issue.state,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        isPullRequest: false,
      };
    }
    const pr = this.tracker.getPr(issueNumber);
    if (!pr) throw new Error(`Issue #${issueNumber} not found in local tracker`);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      author: pr.author,
      state: pr.state,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      isPullRequest: true,
    };
  }

  async postComment(_repo: string, issueNumber: number, body: string): Promise<void> {
    // The orchestrator's own comment: record it (surfaced via the read API) but
    // do not emit an intake event — it must not loop back as a user signal.
    this.tracker.recordComment(issueNumber, { author: this.botAccount, body });
  }

  async updateIssueBody(_repo: string, issueNumber: number, body: string): Promise<void> {
    this.tracker.updateIssueBody(issueNumber, body);
  }

  async addLabel(_repo: string, issueOrPrNumber: number, label: string): Promise<void> {
    if (this.tracker.getIssue(issueOrPrNumber)) {
      this.tracker.addIssueLabel(issueOrPrNumber, label);
      return;
    }
    if (this.tracker.getPr(issueOrPrNumber)) {
      this.tracker.addPrLabel(issueOrPrNumber, label);
      return;
    }
    throw new Error(`Issue or PR #${issueOrPrNumber} not found in local tracker`);
  }

  async removeLabel(_repo: string, issueOrPrNumber: number, label: string): Promise<void> {
    if (this.tracker.getIssue(issueOrPrNumber)) {
      this.tracker.removeIssueLabel(issueOrPrNumber, label);
      return;
    }
    if (this.tracker.getPr(issueOrPrNumber)) {
      this.tracker.removePrLabel(issueOrPrNumber, label);
      return;
    }
    throw new Error(`Issue or PR #${issueOrPrNumber} not found in local tracker`);
  }

  async closeIssue(
    _repo: string,
    issueNumber: number,
    stateReason?: CloseIssueReason
  ): Promise<void> {
    await this.tracker.closeIssue(issueNumber, stateReason);
  }

  async reopenIssue(_repo: string, issueNumber: number): Promise<void> {
    await this.tracker.reopenIssue(issueNumber);
  }

  async mergePullRequest(opts: MergePullRequestOptions): Promise<string> {
    return this.tracker.mergePr(opts.prNumber, opts.method);
  }

  async createPullRequestReview(opts: CreatePullRequestReviewOptions): Promise<string | undefined> {
    const review = this.tracker.recordReview(opts.prNumber, {
      state: REVIEW_EVENT_TO_STATE[opts.event],
      body: opts.body,
      author: this.botAccount,
      comments: opts.comments,
    });
    const pr = this.tracker.getPr(opts.prNumber);
    return pr ? `${pr.htmlUrl}#pullrequestreview-${review.id}` : undefined;
  }

  async createPrReviewComment(opts: CreatePrReviewCommentOptions): Promise<CreatedPrReviewComment> {
    return this.tracker.recordPrReviewComment(opts.prNumber, {
      path: opts.path,
      line: opts.line,
      body: opts.body,
      author: this.botAccount,
      inReplyTo: opts.inReplyTo,
    });
  }

  async addReaction(_repo: string, _issueNumber: number, _content: ReactionContent): Promise<void> {
    // Reactions are cosmetic acknowledgements with no reconcile effect; the local
    // tracker doesn't model them, so this is a no-op in e2e.
  }

  async addCommentReaction(
    _repo: string,
    _commentId: number,
    _content: ReactionContent,
    _scope: "issue" | "review"
  ): Promise<void> {
    // No-op in e2e — same rationale as addReaction (no reconcile effect).
  }

  async getPrReviewComments(
    _repo: string,
    prNumber: number,
    reviewId?: number
  ): Promise<PrReviewComment[]> {
    return this.tracker.getReviewComments(prNumber, reviewId).map((c) => ({
      id: c.id,
      path: c.path,
      line: c.line,
      body: c.body,
      diffHunk: c.diffHunk,
      author: c.author,
      createdAt: c.createdAt,
      inReplyToId: c.inReplyToId ?? null,
    }));
  }

  async getParentIssueNumber(_repo: string, issueNumber: number): Promise<number | null> {
    return this.tracker.getParent(issueNumber);
  }

  async getRootIssueNumber(_repo: string, issueNumber: number): Promise<number | null> {
    return this.tracker.getRoot(issueNumber);
  }

  async hasSubIssues(_repo: string, issueNumber: number): Promise<boolean> {
    return this.tracker.hasChildren(issueNumber);
  }

  async addSubIssue(
    _repo: string,
    _parentIssueNumber: number,
    _childIssueNumber: number
  ): Promise<void> {
    throw new Error("sub-issue parenting is not modelled by the e2e tracker");
  }

  async removeSubIssue(
    _repo: string,
    _parentIssueNumber: number,
    _childIssueNumber: number
  ): Promise<void> {
    throw new Error("sub-issue parenting is not modelled by the e2e tracker");
  }
  private toOpenPullRequest(pr: {
    number: number;
    title: string;
    headRef: string;
    htmlUrl: string;
    body: string;
    author: string;
    labels: string[];
    updatedAt: string;
  }): OpenPullRequest {
    return {
      number: pr.number,
      title: pr.title,
      headRef: pr.headRef,
      headRefName: pr.headRef,
      htmlUrl: pr.htmlUrl,
      body: pr.body,
      author: pr.author,
      labels: pr.labels,
      updatedAt: pr.updatedAt,
    };
  }
}
