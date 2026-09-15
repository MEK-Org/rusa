/** Which GitHub list endpoint an event came from; each has its own cursor. */
export type GitHubPollStream = "issues" | "comments";

/** The `since` cursor for each of a repository's two poll streams. */
export interface GitHubPollCursors {
  issuesWatermark: string;
  commentsWatermark: string;
}

/** An event the poller has emitted, keyed the way its delivery id is keyed. */
export interface GitHubPollSeenEvent {
  key: string;
  stream: GitHubPollStream;
  updatedAt: string;
  /**
   * For a pull request event, the PR's draft standing once this event has
   * been delivered. Carried on the seen event so the store can move the
   * durable draft set in the same transaction as the key: the next cycle
   * skips this key, so any draft change it implied has to land with it.
   */
  pullRequest?: { number: number; draft: boolean };
}

/**
 * Everything durable the poller knows about one repository — the unit the
 * legacy import writes and `db-check` reads. The poller itself only ever
 * touches the per-call surface of {@link GitHubPollStateStore}.
 */
export interface GitHubPollRepoState extends GitHubPollCursors {
  repo: string;
  seen: GitHubPollSeenEvent[];
  branchHeads: Record<string, string>;
  /** Open PRs last polled as drafts; see {@link GitHubPollStateStore.isDraftPullRequest}. */
  draftPullRequests: number[];
}

/**
 * Durable poll position for the GitHub event poller: per-repo stream cursors,
 * the seen keys those cursors can still re-fetch, the last observed head of
 * each deploy branch, and the PRs last seen as drafts. Replaces the retired
 * `github-poller-state.json`.
 *
 * Every timestamp is GitHub's own `updated_at` text, stored verbatim and
 * compared as text; see the 0048 migration for why the spelling matters.
 *
 * The poller drives this store event by event rather than saving a snapshot
 * per cycle, so the write contract is what makes a crash safe:
 *
 * - {@link recordEmitted} is called only *after* the event's delivery has
 *   resolved. A crash between delivery and this call re-emits the event next
 *   cycle, and the durable inbox's per-(key, actor) row id absorbs the
 *   repeat. The other order — record first, deliver second — loses events.
 * - {@link advanceCursor} is called only once a stream's whole fetched batch
 *   has been processed, never per event. A cursor that moved after each
 *   delivery would be correct only if the delivery order were ascending *and*
 *   `since` were inclusive; otherwise a crash part-way through a batch leaves
 *   the cursor past an event that was never delivered, and the next fetch
 *   cannot return it. Deferring the advance makes the no-missed-event property
 *   independent of both: the next cycle re-fetches the whole batch, and the
 *   seen keys recorded above suppress re-delivering the part that got out.
 * - {@link recordBranchHead} follows the same after-delivery rule as
 *   {@link recordEmitted} for synthesized pushes.
 *
 * This is exactly the set of calls `poller.ts` makes. Whole-repository
 * reads and writes (`list`, `importRepo`) belong to the SQLite
 * implementation, where the one-shot legacy import uses them; a test double
 * of the poller's port does not have to provide them.
 */
export interface GitHubPollStateStore {
  /** The repository's cursors, or `undefined` if it has never been polled. */
  getCursors(repo: string): GitHubPollCursors | undefined;
  /** Whether `eventKey` has already been emitted for `repo`. */
  hasSeen(repo: string, eventKey: string): boolean;
  /**
   * Record that `event` was delivered. Creates the repository row on first use
   * with both cursors at the epoch. Idempotent for a repeated key.
   */
  recordEmitted(repo: string, event: GitHubPollSeenEvent): void;
  /**
   * Move `stream`'s cursor forward to `updatedAt`, creating the repository row
   * on first use. Never rewinds: a value at or before the stored cursor is
   * ignored, so an out-of-order call cannot re-open a window that has closed.
   */
  advanceCursor(repo: string, stream: GitHubPollStream, updatedAt: string): void;
  /**
   * Drop seen keys that neither stream's `since` can return again — those
   * strictly older than their own stream's cursor. GitHub's `since` is
   * inclusive, so keys *at* the cursor stay.
   */
  pruneSeen(repo: string): void;
  /** The last observed head of `branch`, or `undefined` if never observed. */
  getBranchHead(repo: string, branch: string): string | undefined;
  /** Record `sha` as the last observed head of `branch`. */
  recordBranchHead(repo: string, branch: string, sha: string): void;
  /**
   * Whether `pullNumber` was an open draft the last time the poller delivered
   * an event for it. Polling reports states, not transitions; this is what
   * turns a not-draft record into `ready_for_review` rather than `edited`.
   */
  isDraftPullRequest(repo: string, pullNumber: number): boolean;
}

/** The cursor every stream starts from before its first successful poll. */
export const GITHUB_POLL_EPOCH = "1970-01-01T00:00:00.000Z";
