import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Normalized store for the *explicit* event subscriptions previously kept in
 * `event-subscriptions.json`. Config-implied subscriptions are not durable
 * state — `reconcileEventSources` re-derives them from `config.yaml` on every
 * boot and unions them over these rows — so only explicit ownership and its
 * tombstones land here.
 *
 * Shape mirrors 0036_capability_grants: one row per (resource, actor_id) — the
 * key the in-memory/file stores already enforce — with the audit trail kept as
 * a nullable `unsubscribed_at` rather than a duplicate status enum, so an
 * unsubscribe leaves a tombstone that keeps outranking the config-implied seed
 * across restarts instead of vanishing.
 *
 * `resource` is the canonical `<scheme>:<path>` reference string produced by
 * `normalizeEventResource`, so legacy spellings converge to one key.
 *
 * The partial unique index is the one-active-owner-per-resource invariant that
 * routing depends on, enforced by the database rather than by a read-then-write
 * race in application code: at most one row per resource may have
 * `unsubscribed_at IS NULL`, while any number of tombstones may coexist.
 *
 * `ON DELETE RESTRICT` matches `capability_grants` and `obligations.parent_id`.
 * There is no actor-deletion path today — `ActorRepository` exposes no delete
 * and retirement is a `retired_at` timestamp — so RESTRICT costs nothing now
 * and, if a deletion path is ever added, forces it to unsubscribe first rather
 * than silently discarding who owned which event source.
 *
 * `subscribed_by` stays unconstrained text, like `capability_grants.granted_by`:
 * it records who performed the subscribe, which may be an operator or a
 * mechanical boot path rather than a row in `actors`.
 *
 * `legacy_import_receipts` records that a legacy JSON source has been imported
 * and the database is authoritative for it. It is what makes a re-appearing or
 * partially-archived source file recognizable as stale instead of forcing a
 * content comparison against durable rows that have since moved on. This slice
 * registers only the `event-subscriptions.json` source.
 */
export const eventSubscriptions: Migration = {
  id: "0038_event_subscriptions",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE event_subscriptions (
        resource        TEXT NOT NULL,
        actor_id        TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
        subscribed_by   TEXT NOT NULL,
        subscribed_at   TEXT NOT NULL,
        unsubscribed_at TEXT,
        PRIMARY KEY (resource, actor_id)
      );

      CREATE UNIQUE INDEX event_subscriptions_one_active_owner
        ON event_subscriptions (resource)
        WHERE unsubscribed_at IS NULL;

      CREATE TABLE legacy_import_receipts (
        source      TEXT PRIMARY KEY,
        imported_at TEXT NOT NULL,
        row_count   INTEGER NOT NULL
      );
    `);
  },
};
