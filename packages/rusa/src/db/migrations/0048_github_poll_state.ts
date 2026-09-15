import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Durable GitHub poll cursors, retiring `github-poller-state.json` as a source
 * of truth (#472, under #175).
 *
 * The poller's job is to turn GitHub's list endpoints into at-most-once
 * inbox deliveries. Delivery dedup already lives in `actor_inbox_entries`
 * (a deterministic per-(event key, actor) row id inserted with
 * `ON CONFLICT DO NOTHING`), but that table stores only the *hash* of the
 * event key and no timestamps, so it cannot answer "up to when has this repo
 * been ingested" or "what was the deploy branch head last time". Those two
 * facts lived only in the JSON file. Losing the file did not merely cost a
 * rebuild: every cursor fell back to the epoch (a full re-scan of every repo,
 * one API call per comment ever written), historical events were replayed to
 * any recipient the first pass had not reached, and a deploy-branch push that
 * landed while the file was absent was never synthesized at all, because the
 * poller only emits a push when it holds a previous head. That is why this
 * state is a durable authority and not a cache exception.
 *
 * The branch-head loss is closed only by the previous head no longer going
 * missing: the poller still records a first sighting without emitting, since
 * a push notification needs a `before` and a first sighting has none. There
 * is no bootstrap emission and no warning for a configured repository that
 * has no head row yet; the first cycle after this migration records, and
 * every later push is synthesized against a head that survives restarts.
 *
 * ## Four tables, not one JSON column
 *
 * Follows `host_jobs` (0040) and `event_sources` (0038): ordinary scalar
 * columns for every field the poller reads or advances, and nothing the
 * poller does not read. The retired file kept the seen set as an array capped
 * at its last 1000 entries; here it is relational and keyed by the event's
 * own `updated_at`, so retention is decided by the cursor it protects (see
 * the repository) rather than by a count that was only ever a size bound.
 *
 * ## `github_poll_repos.repo` is the natural key
 *
 * The poller addresses repositories by their configured `owner/name` string
 * and nothing else joins to them, so a surrogate id would only add a lookup.
 * The three child tables cascade with it: a cursor row that goes away takes
 * its seen keys, branch heads and draft set with it, because none of those
 * mean anything without the cursor they qualify.
 *
 * ## Timestamps are GitHub's own text
 *
 * Every cursor and `event_updated_at` is the `updated_at` string GitHub
 * returned (`YYYY-MM-DDTHH:MM:SSZ`), stored verbatim and compared as text.
 * One spelling per instant is what makes byte order time order, which the
 * no-rewind guard and retention both rely on; the legacy import therefore
 * checks that shape and copies the text rather than reformatting it, since a
 * `.000Z` spelling of the same second would sort *before* the runtime's.
 *
 * ## Branch heads as a map, not a column pair
 *
 * The poller watches one configured deploy branch per repository at a time,
 * but the configured branch can change, and a head is only useful when it is
 * the *previous* head of the branch now being watched: the first observation
 * of a branch never emits. The retired file kept a branch→head map for that
 * reason, so switching the deploy branch and back does not lose the push that
 * landed in between; the table is that map, imported losslessly.
 *
 * ## Draft pull requests
 *
 * Polling reports states, not transitions. `ready_for_review` is the one
 * transition the poller reconstructs (#307): a PR last polled as an open draft
 * that now reports not-draft. The set of such PRs must survive a restart or
 * the transition is reported as a plain `edited`, which never climbs to the
 * repo owner. It moves in the same transaction as the seen key of the event
 * that changed it, so a crash cannot leave the event recorded and the draft
 * standing stale.
 *
 * ## Two cursors per repo, and a `stream` on every seen key
 *
 * Issues/PRs and comments are separate GitHub list endpoints, and the poller
 * has advanced their cursors independently since it split them. Storing them
 * as two columns on one row keeps "the repo's ingestion position" a single
 * row read and a single row write. Each seen key names the stream whose
 * cursor it protects: a key is only worth keeping while its own stream's
 * `since` could return the event again, and the two cursors can be weeks
 * apart. The retired file encoded the stream in the key's prefix; the column
 * says it outright so retention does not have to parse keys.
 */
export const githubPollState: Migration = {
  id: "0048_github_poll_state",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE github_poll_repos (
        repo               TEXT PRIMARY KEY,
        issues_watermark   TEXT NOT NULL,
        comments_watermark TEXT NOT NULL
      );

      CREATE TABLE github_poll_seen_events (
        repo             TEXT NOT NULL REFERENCES github_poll_repos(repo) ON DELETE CASCADE,
        event_key        TEXT NOT NULL,
        stream           TEXT NOT NULL CHECK (stream IN ('issues', 'comments')),
        event_updated_at TEXT NOT NULL,
        PRIMARY KEY (repo, event_key)
      );

      -- No index beyond the primary key: retention prunes below each
      -- stream's cursor every cycle, so a repo's rows are only the keys at
      -- its cursors plus one unprocessed batch, and the (repo, ...) prefix
      -- of the key already bounds every read and prune to that handful.

      CREATE TABLE github_poll_branch_heads (
        repo     TEXT NOT NULL REFERENCES github_poll_repos(repo) ON DELETE CASCADE,
        branch   TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        PRIMARY KEY (repo, branch)
      );

      CREATE TABLE github_poll_draft_pull_requests (
        repo        TEXT NOT NULL REFERENCES github_poll_repos(repo) ON DELETE CASCADE,
        pull_number INTEGER NOT NULL,
        PRIMARY KEY (repo, pull_number)
      );
    `);
  },
};
