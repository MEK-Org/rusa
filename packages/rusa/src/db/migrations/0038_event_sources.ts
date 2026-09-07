import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * The two durable halves of event-source routing, plus the receipt that retires
 * `event-subscriptions.json`.
 *
 * **Ownership** (`event_source_owners`) is single: at most one actor owns an
 * event source at a time, ownership arrives by delegation, by the config-implied
 * seed, or by creating the resource, and it is what governs bubbling — an event
 * with no owner at its exact source may climb to the owner of the parent
 * resource. The rows previously kept in `event-subscriptions.json` are all
 * ownership claims, which is why the legacy import lands here.
 *
 * **Subscription** (`event_source_subscriptions`) is many: any actor may
 * subscribe itself to any in-scope source and receives *direct* events on that
 * exact source. Subscriptions never bubble and never participate in ownership
 * resolution, so a subscriber cannot be handed work claimed by an owner.
 *
 * Two tables rather than a `kind` column because the two row classes share no
 * invariant: ownership is constrained to one live claimant and keeps tombstones,
 * subscription is unconstrained in count and keeps none.
 *
 * `resource` on both sides is the canonical `<scheme>:<path>` reference string
 * produced by `normalizeEventResource`, so legacy spellings converge to one key.
 *
 * ## `event_source_owners`
 *
 * One row per (resource, actor_id) — the key the in-memory store already
 * enforces — with the audit trail kept as a nullable `unsubscribed_at` rather
 * than a duplicate status enum. Releasing ownership is an `UPDATE`, so the row
 * survives as a tombstone that keeps outranking the config-implied seed
 * `reconcileEventSources` re-derives on every boot; a `DELETE` would let a
 * delegated-away source silently revert to root at the next restart.
 *
 * The partial unique index is the one-active-owner-per-resource invariant that
 * routing depends on, enforced by the database rather than by a read-then-write
 * race in application code: at most one row per resource may have
 * `unsubscribed_at IS NULL`, while any number of tombstones may coexist.
 *
 * `ON DELETE RESTRICT` matches `capability_grants` and `obligations.parent_id`.
 * There is no actor-deletion path today — `ActorRepository` exposes no delete
 * and retirement is a `retired_at` timestamp — so RESTRICT costs nothing now.
 * Note that releasing ownership does not release the reference: the tombstone
 * still names the actor, so RESTRICT holds against an actor's whole ownership
 * history, not just its live row. That is the intent — a future deletion path
 * has to decide out loud what becomes of the record of who owned which event
 * source, where an unconstrained column or `ON DELETE CASCADE` would discard it
 * silently.
 *
 * ## `event_source_subscriptions`
 *
 * One row per (resource, actor_id) and nothing else: no `unsubscribed_at`,
 * because unsubscribing is a `DELETE`. Ownership needs tombstones only to
 * outrank a seed that is re-derived each boot; a subscription has no seed to
 * outrank, so a removed row has nothing left to say.
 *
 * That is also why this side is `ON DELETE CASCADE` where ownership is
 * RESTRICT, and the asymmetry is deliberate rather than an oversight. An
 * ownership row is a durable record of who held a source, kept precisely so it
 * cannot vanish unnoticed. A subscription row is live routing configuration
 * with no audit role by construction — once its actor is gone the row can only
 * be inert, so cascading it away is the honest answer rather than a question a
 * future deletion path has to re-answer.
 *
 * `subscribed_by` stays unconstrained text on both tables, like
 * `capability_grants.granted_by`: it records who performed the write, which may
 * be an operator or a mechanical boot path rather than a row in `actors`.
 *
 * ## `legacy_import_receipts`
 *
 * Records that a legacy JSON source has been imported and the database is
 * authoritative for it. It is what makes a re-appearing or partially-archived
 * source file recognizable as stale instead of forcing a content comparison
 * against durable rows that have since moved on. This slice registers only the
 * `event-subscriptions.json` source.
 */
export const eventSources: Migration = {
  id: "0038_event_sources",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE event_source_owners (
        resource        TEXT NOT NULL,
        actor_id        TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
        subscribed_by   TEXT NOT NULL,
        subscribed_at   TEXT NOT NULL,
        unsubscribed_at TEXT,
        PRIMARY KEY (resource, actor_id)
      );

      CREATE UNIQUE INDEX event_source_owners_one_active
        ON event_source_owners (resource)
        WHERE unsubscribed_at IS NULL;

      CREATE TABLE event_source_subscriptions (
        resource      TEXT NOT NULL,
        actor_id      TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
        subscribed_by TEXT NOT NULL,
        subscribed_at TEXT NOT NULL,
        PRIMARY KEY (resource, actor_id)
      );

      CREATE INDEX event_source_subscriptions_by_actor
        ON event_source_subscriptions (actor_id);

      CREATE TABLE legacy_import_receipts (
        source      TEXT PRIMARY KEY,
        imported_at TEXT NOT NULL,
        row_count   INTEGER NOT NULL
      );
    `);
  },
};
