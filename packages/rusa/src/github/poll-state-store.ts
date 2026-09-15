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
}

/** Everything durable the poller knows about one repository. */
export interface GitHubPollRepoState extends GitHubPollCursors {
  repo: string;
  seen: GitHubPollSeenEvent[];
  branchHeads: Record<string, string>;
}

/**
 * Durable poll position for the GitHub event poller: per-repo stream cursors,
 * the seen keys those cursors can still re-fetch, and the last observed head
 * of each deploy branch. Replaces the retired `github-poller-state.json`.
 *
 * The poller drives this store event by event rather than saving a snapshot
 * per cycle, so the write contract is what makes a crash safe:
 *
 * - {@link recordEmitted} is called only *after* the event's delivery has
 *   resolved, and it moves the seen key and the stream cursor together. A
 *   crash between delivery and this call re-emits the event next cycle, and
 *   the durable inbox's per-(key, actor) row id absorbs the repeat. The other
 *   order — cursor first, delivery second — is the one that loses events.
 * - {@link recordBranchHead} follows the same rule for synthesized pushes.
 */
export interface GitHubPollStateStore {
  /** The repository's cursors, or `undefined` if it has never been polled. */
  getCursors(repo: string): GitHubPollCursors | undefined;
  /** Whether `eventKey` has already been emitted for `repo`. */
  hasSeen(repo: string, eventKey: string): boolean;
  /**
   * Record that `event` was delivered and advance its stream's cursor to at
   * least `event.updatedAt`, atomically. Creates the repository row on first
   * use with both cursors at the epoch.
   */
  recordEmitted(repo: string, event: GitHubPollSeenEvent): void;
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
  /** Every repository with durable state, for import planning and inspection. */
  list(): GitHubPollRepoState[];
  /**
   * Write a whole repository's state in one statement batch. Used by the
   * one-shot legacy import, which runs it inside the import transaction; the
   * poller itself never calls this.
   */
  importRepo(state: GitHubPollRepoState): void;
}

/** The cursor every stream starts from before its first successful poll. */
export const GITHUB_POLL_EPOCH = "1970-01-01T00:00:00.000Z";
