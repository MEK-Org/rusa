/**
 * The local issue tracker backing the self-contained e2e runner. It is a
 * deliberately simpler issue system — not a GitHub emulator — that implements
 * exactly the slice of operations Rusa performs today (issues, comments,
 * PRs). It is the shared backing store for both the agent-facing HTTP API
 * (tracker-server.ts) and the {@link FakeIssueClient}.
 *
 * Mutations made through the agent-facing surface (filing an issue, commenting)
 * emit GitHub-shaped events via {@link LocalTrackerOptions.onEvent}, which the
 * actor-mesh runner forwards to the root actor in-process (the same `onEvent`
 * the webhook server would call) — no HTTP round-trip, no webhook server. See
 * devlog/2026-06-07-self-contained-runner/design.md §5.3.
 */

import { execFileSync } from "node:child_process";

/** A callback shaped like the webhook handler's `(eventType, payload)`. */
export type TrackerEventHandler = (
  eventType: string,
  payload: Record<string, unknown>
) => void | Promise<void>;

export interface TrackerComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface TrackerIssue {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  state: "open" | "closed";
  stateReason?: "completed" | "not_planned" | "reopened" | null;
  author: string;
  assignees: string[];
  labels: string[];
  comments: TrackerComment[];
  /** Parent issue number for sub-issue scenarios; null for a root issue. */
  parent: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TrackerPr {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  headRef: string;
  base: string | null;
  state: "open" | "closed";
  author: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

/** The review verdicts Rusa reconciles on (lowercase, as in GitHub webhooks). */
export type ReviewState = "approved" | "changes_requested" | "commented";

/** An inline comment attached to a review, shaped like {@link PrReviewComment}. */
export interface TrackerReviewComment {
  path: string;
  line: number | null;
  body: string;
  diffHunk: string;
}

export interface TrackerReview {
  id: number;
  prNumber: number;
  state: ReviewState;
  body: string;
  author: string;
  comments: TrackerReviewComment[];
  createdAt: string;
}

export interface LocalTrackerOptions {
  /** Repository identity, "owner/name" (matches the configured target). */
  repo: string;
  /** Base URL the tracker is served on, e.g. http://localhost:8084. */
  baseUrl: string;
  /** Account filed issues are assigned to (so the orchestrator picks them up). */
  botAccount: string;
  /** Author recorded for agent-filed issues/comments when none is supplied. */
  defaultAuthor?: string;
  /** In-process intake feed; receives GitHub-shaped events on agent mutations. */
  onEvent?: TrackerEventHandler;
  /**
   * Path to the local bare remote ("origin"). A PR is a real branch pushed here,
   * so the diff is a genuine `git diff base...head`. Required for {@link
   * LocalTracker.getPrDiff}; omit only in unit tests that don't read diffs.
   */
  remotePath?: string;
}

export class LocalTracker {
  private readonly issues = new Map<number, TrackerIssue>();
  private readonly prs = new Map<number, TrackerPr>();
  /** Reviews submitted against a PR, keyed by PR number. */
  private readonly reviews = new Map<number, TrackerReview[]>();
  /** Issues and PRs share one numbering space, as on GitHub. */
  private nextNumber = 1;
  private nextCommentId = 1;
  private nextReviewId = 1;

  readonly repo: string;
  private readonly baseUrl: string;
  private readonly botAccount: string;
  private readonly defaultAuthor: string;
  private readonly onEvent?: TrackerEventHandler;
  private readonly remotePath?: string;

  constructor(opts: LocalTrackerOptions) {
    this.repo = opts.repo;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.botAccount = opts.botAccount;
    this.defaultAuthor = opts.defaultAuthor ?? "e2e-user";
    this.onEvent = opts.onEvent;
    this.remotePath = opts.remotePath;
  }

  // ── Issues (agent-facing; emit intake events) ──────────────────────────────

  /**
   * File a new issue. Assigned to the bot account by default so the orchestrator
   * treats it as active work; pass `assign: false` to observe non-activation.
   * Emits an `issues`/`opened` intake event.
   */
  async createIssue(opts: {
    title: string;
    body: string;
    author?: string;
    assign?: boolean;
  }): Promise<TrackerIssue> {
    const number = this.nextNumber++;
    const now = new Date().toISOString();
    const issue: TrackerIssue = {
      number,
      title: opts.title,
      body: opts.body,
      htmlUrl: `${this.baseUrl}/${this.repo}/issues/${number}`,
      state: "open",
      author: opts.author ?? this.defaultAuthor,
      assignees: opts.assign === false ? [] : [this.botAccount],
      labels: [],
      comments: [],
      parent: null,
      createdAt: now,
      updatedAt: now,
    };
    this.issues.set(number, issue);

    await this.emit("issues", {
      action: "opened",
      issue: this.toIssuePayload(issue),
      repository: { full_name: this.repo },
    });
    return issue;
  }

  /**
   * Add a comment to an issue from a human/agent and emit an `issue_comment`
   * intake event. Use {@link recordComment} for the orchestrator's own comments,
   * which must not feed back into intake.
   */
  async addIssueComment(
    issueNumber: number,
    opts: { body: string; author?: string }
  ): Promise<TrackerComment> {
    const issue = this.requireIssue(issueNumber);
    const comment = this.recordComment(issueNumber, {
      body: opts.body,
      author: opts.author ?? this.defaultAuthor,
    });

    await this.emit("issue_comment", {
      action: "created",
      issue: this.toIssuePayload(issue),
      comment: { id: comment.id, body: comment.body, user: { login: comment.author } },
      repository: { full_name: this.repo },
    });
    return comment;
  }

  updateIssueBody(number: number, body: string): void {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`Issue #${number} not found`);
    issue.body = body;
    issue.updatedAt = new Date().toISOString();
  }

  /** Close an issue and emit an `issues`/`closed` intake event. */
  async closeIssue(issueNumber: number, stateReason?: "completed" | "not_planned"): Promise<void> {
    const issue = this.requireIssue(issueNumber);
    issue.state = "closed";
    issue.stateReason = stateReason ?? "completed";
    issue.updatedAt = new Date().toISOString();
    await this.emit("issues", {
      action: "closed",
      issue: this.toIssuePayload(issue),
      repository: { full_name: this.repo },
    });
  }

  /** Reopen a closed issue and emit an `issues`/`reopened` intake event. */
  async reopenIssue(issueNumber: number): Promise<void> {
    const issue = this.requireIssue(issueNumber);
    issue.state = "open";
    issue.stateReason = "reopened";
    issue.updatedAt = new Date().toISOString();
    await this.emit("issues", {
      action: "reopened",
      issue: this.toIssuePayload(issue),
      repository: { full_name: this.repo },
    });
  }

  addIssueLabel(issueNumber: number, label: string): void {
    const issue = this.requireIssue(issueNumber);
    if (!issue.labels.includes(label)) issue.labels.push(label);
    issue.updatedAt = new Date().toISOString();
  }

  removeIssueLabel(issueNumber: number, label: string): void {
    const issue = this.requireIssue(issueNumber);
    issue.labels = issue.labels.filter((existing) => existing !== label);
    issue.updatedAt = new Date().toISOString();
  }

  getIssue(issueNumber: number): TrackerIssue | undefined {
    return this.issues.get(issueNumber);
  }

  listIssues(): TrackerIssue[] {
    return [...this.issues.values()].sort((a, b) => a.number - b.number);
  }

  // ── Comments without intake (the orchestrator's own output) ────────────────

  /**
   * Append a comment without emitting an intake event. This is how the
   * {@link FakeIssueClient} records the orchestrator's own comments/questions:
   * they are surfaced through the read API but must not loop back as intake.
   */
  recordComment(issueNumber: number, opts: { body: string; author: string }): TrackerComment {
    const issue = this.requireIssue(issueNumber);
    const comment: TrackerComment = {
      id: this.nextCommentId++,
      author: opts.author,
      body: opts.body,
      createdAt: new Date().toISOString(),
    };
    issue.comments.push(comment);
    issue.updatedAt = comment.createdAt;
    return comment;
  }

  // ── Pull requests (backing store for FakeIssueClient) ──────────────────────

  /**
   * Create a PR over an already-pushed branch, or upsert title/body if a PR for
   * the same head branch already exists. Mirrors the GitHub client's create-or-
   * update semantics. The branch itself lives in the bare remote; the tracker
   * only records the PR object.
   */
  upsertPrByHead(opts: {
    headRef: string;
    title: string;
    body: string;
    base?: string | null;
    author: string;
  }): TrackerPr {
    const existing = [...this.prs.values()].find(
      (pr) => pr.headRef === opts.headRef && pr.state === "open"
    );
    const now = new Date().toISOString();
    if (existing) {
      existing.title = opts.title;
      existing.body = opts.body;
      if (opts.base !== undefined) {
        existing.base = opts.base;
      }
      existing.updatedAt = now;
      return existing;
    }
    const number = this.nextNumber++;
    const pr: TrackerPr = {
      number,
      title: opts.title,
      body: opts.body,
      htmlUrl: `${this.baseUrl}/${this.repo}/pull/${number}`,
      headRef: opts.headRef,
      base: opts.base ?? null,
      state: "open",
      author: opts.author,
      labels: [],
      createdAt: now,
      updatedAt: now,
    };
    this.prs.set(number, pr);
    return pr;
  }

  getPr(prNumber: number): TrackerPr | undefined {
    return this.prs.get(prNumber);
  }

  listPrs(): TrackerPr[] {
    return [...this.prs.values()].sort((a, b) => a.number - b.number);
  }

  listOpenPrsByAuthor(author: string): TrackerPr[] {
    return this.listPrs().filter((pr) => pr.state === "open" && pr.author === author);
  }

  addPrLabel(prNumber: number, label: string): void {
    const pr = this.requirePr(prNumber);
    if (!pr.labels.includes(label)) pr.labels.push(label);
    pr.updatedAt = new Date().toISOString();
  }

  removePrLabel(prNumber: number, label: string): void {
    const pr = this.requirePr(prNumber);
    pr.labels = pr.labels.filter((existing) => existing !== label);
    pr.updatedAt = new Date().toISOString();
  }

  /**
   * Merge a PR and return a synthetic commit SHA. No intake event: like PR
   * creation, merges aren't modeled as agent-facing intake in this tracker.
   * Branch deletion isn't modeled here — there's no reconcile effect from it
   * in e2e, same rationale as {@link FakeIssueClient}'s reaction no-ops.
   */
  mergePr(prNumber: number, _method: "merge" | "squash" | "rebase"): string {
    const pr = this.requirePr(prNumber);
    pr.state = "closed";
    pr.updatedAt = new Date().toISOString();
    return `fake-merge-sha-${prNumber}`;
  }

  /**
   * The real diff of a PR branch against its base, read straight from the bare
   * remote (`git diff base...head`). This is what a driving agent inspects before
   * deciding how to review — the change is real, not a recorded artifact.
   */
  getPrDiff(prNumber: number): string {
    const pr = this.requirePr(prNumber);
    if (!this.remotePath) {
      throw new Error("Local tracker has no bare remote configured; cannot compute PR diff");
    }
    const base = pr.base ?? "main";
    return execFileSync("git", ["-C", this.remotePath, "diff", `${base}...${pr.headRef}`], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  // ── Reviews (agent-facing; emit intake events) ─────────────────────────────

  /**
   * Submit a review against a PR — approve / request-changes / comment, with
   * optional inline comments — and emit a `pull_request_review`/`submitted` intake
   * event. This is what closes the reconcile loop: the handler turns it into a
   * `pr_review` signal the orchestrator acts on. The reviewer defaults to a human
   * (not the bot), since the handler ignores the bot's own reviews.
   */
  async submitReview(
    prNumber: number,
    opts: { state: ReviewState; body?: string; comments?: TrackerReviewComment[]; author?: string }
  ): Promise<TrackerReview> {
    const pr = this.requirePr(prNumber);
    const review: TrackerReview = {
      id: this.nextReviewId++,
      prNumber,
      state: opts.state,
      body: opts.body ?? "",
      author: opts.author ?? this.defaultAuthor,
      comments: opts.comments ?? [],
      createdAt: new Date().toISOString(),
    };
    const list = this.reviews.get(prNumber) ?? [];
    list.push(review);
    this.reviews.set(prNumber, list);
    pr.updatedAt = review.createdAt;

    await this.emit("pull_request_review", {
      action: "submitted",
      review: {
        id: review.id,
        state: review.state,
        body: review.body,
        user: { login: review.author },
      },
      pull_request: this.toPrPayload(pr),
      repository: { full_name: this.repo },
    });
    return review;
  }

  listReviews(prNumber: number): TrackerReview[] {
    return this.reviews.get(prNumber) ?? [];
  }

  /**
   * Record a review without emitting intake — mirrors {@link recordComment} vs
   * {@link addIssueComment}. This is how {@link FakeIssueClient} records the
   * orchestrator's own review (posted via tracker's `post_review`): it must
   * not loop back as a human signal.
   */
  recordReview(
    prNumber: number,
    opts: {
      state: ReviewState;
      body: string;
      author: string;
      comments?: Array<{
        path: string;
        line: number;
        body: string;
        side?: "LEFT" | "RIGHT";
        startLine?: number;
        startSide?: "LEFT" | "RIGHT";
      }>;
    }
  ): TrackerReview {
    const pr = this.requirePr(prNumber);
    const review: TrackerReview = {
      id: this.nextReviewId++,
      prNumber,
      state: opts.state,
      body: opts.body,
      author: opts.author,
      comments:
        opts.comments?.map((c) => ({
          path: c.path,
          line: c.line,
          body: c.body,
          diffHunk: "",
        })) ?? [],
      createdAt: new Date().toISOString(),
    };
    const list = this.reviews.get(prNumber) ?? [];
    list.push(review);
    this.reviews.set(prNumber, list);
    pr.updatedAt = review.createdAt;
    return review;
  }

  recordPrReviewComment(
    prNumber: number,
    opts: {
      path?: string;
      line?: number;
      body: string;
      author: string;
      inReplyTo?: number;
    }
  ): { id: number; htmlUrl: string; path: string; line: number | null; body: string } {
    const pr = this.requirePr(prNumber);
    const id = this.nextCommentId++;
    const comment: TrackerReviewComment = {
      path: opts.path ?? "",
      line: opts.line ?? null,
      body: opts.body,
      diffHunk: "",
    };
    const list = this.reviews.get(prNumber);
    if (!list || list.length === 0) {
      const review: TrackerReview = {
        id: this.nextReviewId++,
        prNumber,
        state: "commented",
        body: "",
        author: opts.author,
        comments: [comment],
        createdAt: new Date().toISOString(),
      };
      this.reviews.set(prNumber, [review]);
    } else {
      list[list.length - 1].comments.push(comment);
    }
    pr.updatedAt = new Date().toISOString();
    return {
      id,
      htmlUrl: `${pr.htmlUrl}#discussion_r${id}`,
      path: comment.path,
      line: comment.line,
      body: comment.body,
    };
  }

  /** Inline comments recorded for a specific review or all reviews on the PR. */
  getReviewComments(prNumber: number, reviewId?: number): TrackerReviewComment[] {
    const reviews = this.reviews.get(prNumber) ?? [];
    if (reviewId !== undefined) {
      return reviews.find((r) => r.id === reviewId)?.comments ?? [];
    }
    return reviews.flatMap((r) => r.comments);
  }

  // ── Sub-issue hierarchy (plain parent pointer) ─────────────────────────────

  getParent(issueNumber: number): number | null {
    return this.issues.get(issueNumber)?.parent ?? null;
  }

  /** Walk the parent chain; returns null if `issueNumber` is itself a root. */
  getRoot(issueNumber: number): number | null {
    let current = this.getParent(issueNumber);
    if (current === null) return null;
    for (let i = 0; i < 16; i++) {
      const next = this.getParent(current);
      if (next === null) return current;
      current = next;
    }
    return current;
  }

  hasChildren(issueNumber: number): boolean {
    return [...this.issues.values()].some((issue) => issue.parent === issueNumber);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private requireIssue(issueNumber: number): TrackerIssue {
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found in local tracker`);
    return issue;
  }

  private requirePr(prNumber: number): TrackerPr {
    const pr = this.prs.get(prNumber);
    if (!pr) throw new Error(`PR #${prNumber} not found in local tracker`);
    return pr;
  }

  private async emit(eventType: string, payload: Record<string, unknown>): Promise<void> {
    if (this.onEvent) await this.onEvent(eventType, payload);
  }

  /** Shape a tracker issue like the GitHub webhook issue object the handler reads. */
  private toIssuePayload(issue: TrackerIssue): Record<string, unknown> {
    return {
      id: issue.number,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      html_url: issue.htmlUrl,
      state: issue.state,
      state_reason: issue.stateReason,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      labels: issue.labels.map((name) => ({ name })),
      assignees: issue.assignees.map((login) => ({ login })),
      user: { login: issue.author },
    };
  }

  /** Shape a tracker PR like the GitHub webhook pull_request object the handler reads. */
  private toPrPayload(pr: TrackerPr): Record<string, unknown> {
    return {
      number: pr.number,
      title: pr.title,
      html_url: pr.htmlUrl,
      head: { ref: pr.headRef },
      body: pr.body,
      user: { login: pr.author },
      labels: pr.labels.map((name) => ({ name })),
      updated_at: pr.updatedAt,
    };
  }
}
