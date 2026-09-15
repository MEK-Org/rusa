import type Database from "better-sqlite3";
import {
  GITHUB_POLL_EPOCH,
  type GitHubPollCursors,
  type GitHubPollRepoState,
  type GitHubPollSeenEvent,
  type GitHubPollStateStore,
  type GitHubPollStream,
} from "../../github/poll-state-store.js";

type RepoRow = {
  repo: string;
  issues_watermark: string;
  comments_watermark: string;
};

type SeenRow = {
  repo: string;
  event_key: string;
  stream: GitHubPollStream;
  event_updated_at: string;
};

type BranchHeadRow = {
  repo: string;
  branch: string;
  head_sha: string;
};

/**
 * SQLite implementation of {@link GitHubPollStateStore} over the three
 * `github_poll_*` tables (0048_github_poll_state). Every call reads straight
 * from the database with no process-local snapshot, so the position a poll
 * cycle observes is the position the previous cycle committed, whether or
 * not the process restarted in between.
 *
 * Cursor comparisons are plain text comparisons, exactly as the retired file
 * store compared them: every value is a UTC ISO-8601 timestamp, for which
 * byte order is time order.
 */
export class DbGitHubPollStateStore implements GitHubPollStateStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  getCursors(repo: string): GitHubPollCursors | undefined {
    const row = this.db
      .prepare(
        "SELECT repo, issues_watermark, comments_watermark FROM github_poll_repos WHERE repo = ?"
      )
      .get(repo) as RepoRow | undefined;
    return row ? cursorsFromRow(row) : undefined;
  }

  hasSeen(repo: string, eventKey: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM github_poll_seen_events WHERE repo = ? AND event_key = ?")
        .get(repo, eventKey) !== undefined
    );
  }

  recordEmitted(repo: string, event: GitHubPollSeenEvent): void {
    this.db.transaction(() => {
      this.ensureRepo(repo);
      this.db
        .prepare(
          `INSERT INTO github_poll_seen_events (repo, event_key, stream, event_updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(repo, event_key) DO NOTHING`
        )
        .run(repo, event.key, event.stream, event.updatedAt);
      const column = cursorColumn(event.stream);
      this.db
        .prepare(
          `UPDATE github_poll_repos
           SET ${column} = ?, updated_at = ?
           WHERE repo = ? AND ${column} < ?`
        )
        .run(event.updatedAt, this.now(), repo, event.updatedAt);
    })();
  }

  pruneSeen(repo: string): void {
    // Each stream prunes against its own cursor: a comment key is safe to
    // forget once the comments cursor has moved past it, regardless of where
    // the issues cursor stands.
    this.db
      .prepare(
        `DELETE FROM github_poll_seen_events
         WHERE repo = ?
           AND event_updated_at < (
             SELECT CASE stream
               WHEN 'issues' THEN r.issues_watermark
               ELSE r.comments_watermark
             END
             FROM github_poll_repos r WHERE r.repo = github_poll_seen_events.repo
           )`
      )
      .run(repo);
  }

  getBranchHead(repo: string, branch: string): string | undefined {
    const row = this.db
      .prepare("SELECT head_sha FROM github_poll_branch_heads WHERE repo = ? AND branch = ?")
      .get(repo, branch) as Pick<BranchHeadRow, "head_sha"> | undefined;
    return row?.head_sha;
  }

  recordBranchHead(repo: string, branch: string, sha: string): void {
    this.db.transaction(() => {
      this.ensureRepo(repo);
      this.db
        .prepare(
          `INSERT INTO github_poll_branch_heads (repo, branch, head_sha)
           VALUES (?, ?, ?)
           ON CONFLICT(repo, branch) DO UPDATE SET head_sha = excluded.head_sha`
        )
        .run(repo, branch, sha);
    })();
  }

  list(): GitHubPollRepoState[] {
    const repos = this.db
      .prepare(
        "SELECT repo, issues_watermark, comments_watermark FROM github_poll_repos ORDER BY repo"
      )
      .all() as RepoRow[];
    const seen = this.db
      .prepare(
        `SELECT repo, event_key, stream, event_updated_at FROM github_poll_seen_events
         ORDER BY repo, event_updated_at, event_key`
      )
      .all() as SeenRow[];
    const heads = this.db
      .prepare("SELECT repo, branch, head_sha FROM github_poll_branch_heads ORDER BY repo, branch")
      .all() as BranchHeadRow[];

    return repos.map((row) => ({
      repo: row.repo,
      ...cursorsFromRow(row),
      seen: seen
        .filter((s) => s.repo === row.repo)
        .map((s) => ({ key: s.event_key, stream: s.stream, updatedAt: s.event_updated_at })),
      branchHeads: Object.fromEntries(
        heads.filter((h) => h.repo === row.repo).map((h) => [h.branch, h.head_sha])
      ),
    }));
  }

  importRepo(state: GitHubPollRepoState): void {
    this.db
      .prepare(
        `INSERT INTO github_poll_repos (repo, issues_watermark, comments_watermark, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo) DO UPDATE SET
           issues_watermark = excluded.issues_watermark,
           comments_watermark = excluded.comments_watermark,
           updated_at = excluded.updated_at`
      )
      .run(state.repo, state.issuesWatermark, state.commentsWatermark, this.now());
    const insertSeen = this.db.prepare(
      `INSERT INTO github_poll_seen_events (repo, event_key, stream, event_updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo, event_key) DO NOTHING`
    );
    for (const event of state.seen) {
      insertSeen.run(state.repo, event.key, event.stream, event.updatedAt);
    }
    const insertHead = this.db.prepare(
      `INSERT INTO github_poll_branch_heads (repo, branch, head_sha)
       VALUES (?, ?, ?)
       ON CONFLICT(repo, branch) DO UPDATE SET head_sha = excluded.head_sha`
    );
    for (const [branch, sha] of Object.entries(state.branchHeads)) {
      insertHead.run(state.repo, branch, sha);
    }
  }

  private ensureRepo(repo: string): void {
    this.db
      .prepare(
        `INSERT INTO github_poll_repos (repo, issues_watermark, comments_watermark, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo) DO NOTHING`
      )
      .run(repo, GITHUB_POLL_EPOCH, GITHUB_POLL_EPOCH, this.now());
  }
}

function cursorsFromRow(row: RepoRow): GitHubPollCursors {
  return { issuesWatermark: row.issues_watermark, commentsWatermark: row.comments_watermark };
}

function cursorColumn(stream: GitHubPollStream): "issues_watermark" | "comments_watermark" {
  return stream === "issues" ? "issues_watermark" : "comments_watermark";
}
