import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * One opt-in completion predicate per obligation (#190).
 *
 * The matcher is deliberately separate from `obligations`: only a small
 * subset of leaves need one, its event lookup needs its own target index, and
 * keeping lifecycle observations with the predicate avoids making every
 * obligation row carry kind-specific nullable columns. `spec_json` stays
 * application-validated JSON (no SQLite JSON functions), so a kind's own
 * parameters can gain fields without a column change. Adding a new kind still
 * means a rebuild, because `kind` keeps the repository's usual CHECK.
 *
 * `pr_merged` targets are stored canonically lowercase, so the webhook lookup
 * is an exact match on the `(kind, target)` index.
 */
export const obligationCompletionMatchers: Migration = {
  id: "0059_obligation_completion_matchers",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE obligation_completion_matchers (
        obligation_id        TEXT PRIMARY KEY REFERENCES obligations(id) ON DELETE CASCADE,
        kind                 TEXT NOT NULL CHECK (kind IN ('pr_merged', 'deployed')),
        target               TEXT NOT NULL CHECK (length(trim(target)) > 0),
        spec_json            TEXT NOT NULL CHECK (length(trim(spec_json)) > 0),
        set_by               TEXT NOT NULL CHECK (length(trim(set_by)) > 0),
        set_at               TEXT NOT NULL CHECK (length(trim(set_at)) > 0),
        satisfied_at         TEXT,
        satisfied_ref        TEXT,
        closed_unmerged_at   TEXT
      );

      CREATE INDEX idx_obligation_completion_matchers_target
        ON obligation_completion_matchers(kind, target);
    `);
  },
};
