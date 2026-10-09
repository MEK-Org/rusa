import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * The Google account id a user signed in with (#890).
 *
 * Google Chat names a message's sender `users/{id}`. That id is the same value
 * the verified dashboard sign-in token carries as
 * `firebase.identities["google.com"][0]`, so storing it here is what lets a
 * Chat message resolve to the user principal who sent it. The column is filled
 * only from that verified token at sign-in; nothing else writes it.
 *
 * It is nullable because existing users have not signed in since the column
 * appeared, so no backfill is needed: a user's Chat messages simply stay
 * unmatched until their next sign-in. The unique index means one Google
 * account names at most one user. SQLite treats NULLs as distinct, so any
 * number of users may still be unset.
 */
export const userGoogleAccountId: Migration = {
  id: "0058_user_google_account_id",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE users ADD COLUMN google_account_id TEXT
        CHECK (google_account_id IS NULL OR length(google_account_id) > 0);
      CREATE UNIQUE INDEX users_google_account_id_idx ON users (google_account_id);
    `);
  },
};
