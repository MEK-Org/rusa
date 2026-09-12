import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Append-only attributable mutation history stream for obligations (#185).
 *
 * An obligation row records its current owner and immutable `creator_id`,
 * but historically preserved neither the acting principal nor prior values
 * across later mutations (reassign, reparent, reorder, priority, status, external-ref).
 *
 * ## Why not `mesh_events`
 *
 * `mesh_events` is the mesh's actor-observability log: its columns are
 * `(id, ts, kind, actor_id, peer_id, detail, body, success, payload)`, indexed
 * on `actor_id`, `kind` and `ts`. It carries no obligation id, so an
 * obligation-local read is a `LIKE`/`json_extract` scan of every event the mesh
 * has ever recorded rather than an indexed lookup — the opposite of the bounded
 * per-obligation page #185 asks for. It also holds no before/after tracked-field
 * values, so "who changed this owner, and from what" cannot be answered from it
 * at all without inventing exactly the payload this table stores. And it is not
 * in practice immutable: earlier migrations rewrite its rows in place and drop
 * its columns, which is acceptable for observability and disqualifying for an
 * audit record. A separate table keeps the audit contract independent of a log
 * whose shape the mesh reserves the right to keep editing.
 *
 * ## Schema design
 *
 * - `obligation_history` table stores:
 *   - `id`: strictly monotonic integer primary key
 *   - `obligation_id`: references `obligations(id)` with `ON DELETE RESTRICT`
 *   - `mutation_kind`: semantic mutation ("reassign", "reparent", "priority", "status", "external_ref")
 *   - `acting_principal`: server-bound entity id (actor UUID, `human:operator`, `system:mesh`)
 *   - `timestamp`: ISO-8601 mutation timestamp
 *   - `payload`: versioned JSON document with `schemaVersion`, `before`, and `after` states
 *
 * ## Deletion is blocked, not cascaded
 *
 * An audit stream that a delete can erase is not an audit stream: the one write
 * most worth attributing would be the one that removes the evidence. The
 * reference therefore restricts rather than cascades, matching how
 * `obligations.parent_id` already refuses to let a delete take rows with it.
 * No production path deletes obligations — terminal transitions mark rows
 * `done`/`cancelled` and keep them — so restricting takes nothing away today;
 * it makes the next attempt to add such a path surface here, where the question
 * of what happens to the record has to be answered on purpose.
 *
 * ## Versioned payload, validated in consuming code
 *
 * Per issue #185 and steward guidance, the JSON blob is explicitly versioned
 * and validated by consuming TypeScript/Zod code rather than SQLite `json_*`
 * validators or JSON-shape CHECKs. This avoids schema rigidity and table rebuilds
 * while guaranteeing type safety at the consuming boundary.
 *
 * ## Deterministic ordering
 *
 * Reads query newest-first by `(obligation_id, id DESC)`. A strictly monotonic
 * integer key guarantees deterministic chronological insertion ordering even
 * for multiple mutations occurring within the same millisecond timestamp,
 * eliminating wall-clock timestamp ties and non-chronological random-UUID ordering.
 *
 * In SQLite, secondary indexes on rowid tables automatically append the rowid (`id`).
 * An index on `(obligation_id)` therefore stores `(obligation_id, id)` B-tree keys,
 * allowing queries filtered by `obligation_id` and ordered by `id DESC` to scan the
 * index backwards with zero temporary B-trees or sorting overhead. The index narrows
 * and orders the search; non-indexed columns are retrieved via rowid lookup.
 */
export const obligationHistory: Migration = {
  id: "0045_obligation_history",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS obligation_history (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        obligation_id    TEXT NOT NULL REFERENCES obligations(id) ON DELETE RESTRICT,
        mutation_kind    TEXT NOT NULL CHECK (length(trim(mutation_kind)) > 0),
        acting_principal TEXT NOT NULL CHECK (length(trim(acting_principal)) > 0),
        timestamp        TEXT NOT NULL CHECK (length(trim(timestamp)) > 0),
        payload          TEXT NOT NULL CHECK (length(trim(payload)) > 0)
      );

      CREATE INDEX IF NOT EXISTS idx_obligation_history_obligation
        ON obligation_history(obligation_id);
    `);
  },
};
