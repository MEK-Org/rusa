import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Operator-attested Slack identities for existing human principals (#1038).
 *
 * A verified Slack sender is an identity claim, not authority: a message from
 * Slack user `U…` in workspace `T…` resolves to a human only when an operator
 * has explicitly bound that exact pair to an existing user. That is why this
 * is a dedicated relation rather than columns on `users` (one human may have
 * several separately verified Slack identities, and Firebase/Google identity
 * columns are filled only by a verified sign-in) or mutable event-source JSON.
 *
 * - **Key.** The exact `(workspace_id, slack_user_id)` pair, compared as
 *   stored: Slack ids are opaque and case is preserved. The GLOB checks admit
 *   only the alphanumeric shape Slack ids have, so an email address, a display
 *   name or a padded id cannot be stored as one.
 * - **One live holder per pair.** The primary key means a pair names at most
 *   one human. Rebinding it is a revoke followed by a separately authorized
 *   grant; the row is reused, and the prior state survives in the event log.
 * - **Revocation** is the nullable `revoked_*` triple, all set or all null.
 * - **Audit.** Every grant and revoke appends one row to
 *   `slack_principal_binding_events` in the same transaction, carrying the
 *   binding's prior state as JSON. Idempotent repeats change nothing and log
 *   nothing.
 *
 * Both the bound and the granting principal must be `users` rows, so an actor
 * or `system:*` id can neither hold nor grant a binding. The tables start
 * empty: nothing is seeded or inferred from existing users or connections.
 *
 * `actor_inbox_source` indexes the existing inbox table on `source`, so the
 * Slack message origin proof (`slackMessageWorkspaces`) searches one channel's
 * rows instead of scanning every inbox entry on each reference it renders.
 * Nothing is backfilled; the index builds from the rows already present.
 */
export const slackPrincipalBindings: Migration = {
  id: "0063_slack_principal_bindings",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE slack_principal_bindings (
        workspace_id  TEXT NOT NULL
                        CHECK (length(workspace_id) > 0 AND workspace_id NOT GLOB '*[^A-Za-z0-9]*'),
        slack_user_id TEXT NOT NULL
                        CHECK (length(slack_user_id) > 0 AND slack_user_id NOT GLOB '*[^A-Za-z0-9]*'),
        principal_id  TEXT NOT NULL REFERENCES users(principal_id) ON DELETE RESTRICT,
        granted_at    TEXT NOT NULL,
        granted_by    TEXT NOT NULL REFERENCES users(principal_id) ON DELETE RESTRICT,
        grant_ref     TEXT NOT NULL CHECK (length(trim(grant_ref)) > 0),
        revoked_at    TEXT,
        revoked_by    TEXT REFERENCES users(principal_id) ON DELETE RESTRICT,
        revoke_ref    TEXT CHECK (revoke_ref IS NULL OR length(trim(revoke_ref)) > 0),
        PRIMARY KEY (workspace_id, slack_user_id),
        CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)
               AND (revoked_at IS NULL) = (revoke_ref IS NULL))
      );

      CREATE TABLE slack_principal_binding_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id  TEXT NOT NULL,
        slack_user_id TEXT NOT NULL,
        action        TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
        principal_id  TEXT NOT NULL REFERENCES users(principal_id) ON DELETE RESTRICT,
        operator_id   TEXT NOT NULL REFERENCES users(principal_id) ON DELETE RESTRICT,
        decision_ref  TEXT NOT NULL CHECK (length(trim(decision_ref)) > 0),
        occurred_at   TEXT NOT NULL,
        prior_json    TEXT
      );

      CREATE INDEX actor_inbox_source ON actor_inbox_entries (source);
    `);
  },
};
