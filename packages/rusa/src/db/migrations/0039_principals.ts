import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Durable identity storage: the principal supertype every attribution domain
 * already shares, plus the user subtype an authenticated instance needs.
 *
 * **Why a supertype rather than a string convention.** Attribution columns
 * (`obligations.owner_id`, `mesh_chat.sender_id`/`recipient_id`,
 * `mesh_events.actor_id`) already hold three different classes of id: actor
 * ids, the retired human literal, and `system:*` writes performed by mesh
 * infrastructure. Deciding what one of those is by parsing its prefix means the
 * answer lives in every reader. One row per identity, carrying its kind, makes
 * that a lookup instead — and is why an actor's principal id *is* its actor id:
 * the ids already written into those columns must keep resolving unchanged.
 *
 * **Actors and principals are synchronized in application transactions.**
 * An actor's principal id is its actor id. Because actor retirement is tracked via
 * `retired_at` timestamp mutation rather than hard row deletion, and actor creation
 * runs transactionally with principal creation in `SqliteActorRepository`, the
 * schema avoids an artificial nullable `actor_id` foreign key column on `principals`.
 *
 * **Users are keyed by verified issuer + subject, never by email.** Email is
 * admission metadata that a provider can legitimately change; the durable key
 * is the pair the token verifier produces. Both are nullable *together* so a
 * user can exist before any login binds one — the pre-binding state that lets
 * an operator provision the instance owner explicitly instead of letting the
 * first person to sign in claim it. SQLite treats NULLs as distinct in a unique
 * index, so any number of users may await binding while no two may share a
 * bound identity. `email` is unique so one admission entry cannot be provisioned
 * twice; that is a duplicate-row guard, not a claim that email is identity.
 *
 * **Nothing here interprets `human:operator`.** It deliberately gets no
 * principal row: the historical references to it are migrated by hand, as a
 * deployment operation, and this slice must not decide who they belong to. That
 * is also why no attribution column gains a foreign key to `principals` yet —
 * one would refuse every legacy row still holding the literal.
 */
export const principals: Migration = {
  id: "0039_principals",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE principals (
        id         TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
        kind       TEXT NOT NULL CHECK (kind IN ('actor', 'user', 'system')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE users (
        principal_id          TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE RESTRICT,
        email                 TEXT NOT NULL
                                CHECK (email = lower(trim(email)) AND length(email) > 0),
        firebase_issuer       TEXT
                                CHECK (firebase_issuer IS NULL OR length(trim(firebase_issuer)) > 0),
        firebase_subject      TEXT
                                CHECK (firebase_subject IS NULL OR length(trim(firebase_subject)) > 0),
        root_actor_id         TEXT REFERENCES actors(id) ON DELETE RESTRICT,
        disabled_at           TEXT,
        last_authenticated_at TEXT,
        CHECK ((firebase_issuer IS NULL) = (firebase_subject IS NULL))
      );
      CREATE UNIQUE INDEX users_external_identity_idx
        ON users (firebase_issuer, firebase_subject);
      CREATE UNIQUE INDEX users_root_actor_id_idx ON users (root_actor_id);
      CREATE UNIQUE INDEX users_email_idx ON users (email);

      -- Seed one actor principal per existing actor, carrying that actor's own
      -- creation time. An instance upgrading with a populated actors table and a
      -- fresh instance creating the same actors through the repository therefore
      -- reach byte-identical principal rows.
      INSERT OR IGNORE INTO principals (id, kind, created_at)
        SELECT id, 'actor', created_at FROM actors;

      -- The mesh's own writes (dropped-delivery notices and the like) are
      -- attributed to this identity today. The literal is inlined rather than
      -- imported so a later rename of the constant cannot retroactively change
      -- what this migration did, following 0025's handling of the same problem.
      INSERT OR IGNORE INTO principals (id, kind, created_at)
        VALUES ('system:mesh', 'system', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
  },
};
