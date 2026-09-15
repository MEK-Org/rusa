import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Durable storage for portable-context snapshots (#473), retiring the
 * per-actor `portable-context/<actorId>.json` files as a source of truth.
 *
 * A snapshot is authoritative memory, not a cache. Its ledger item ids,
 * statuses, priorities, generation counter and `lastFoldedSourceId` cursor are
 * minted by the compactor as it folds messages and run outputs; nothing can
 * rebuild an equivalent snapshot from the sources alone, because the fold is a
 * model call whose output is not reproducible. That is what puts the snapshot
 * in `mesh.db` next to the sources it was folded from, instead of in a file
 * that a home-directory restore or a partial deploy can leave behind.
 *
 * ## One row per actor, the state as one versioned JSON document
 *
 * The snapshot is stored whole in `snapshot`, not decomposed into ledger-item
 * rows. The compactor reads and writes the entire state on every fold and
 * nothing queries a ledger item on its own, so a child table would add write
 * fan-out and a reassembly step with no reader to serve. The document carries
 * its own `schemaVersion`, and the column has no database-level shape
 * constraint — no CHECK, no `json_valid`, no `json_extract` — matching
 * `actors.model_config` (0034) and `host_jobs.manifest` (0040): the versioned
 * shape is owned and validated by `DbPortableContextStore` at the point of
 * consumption, which is also the one place that knows how to read an older
 * version forward.
 *
 * `schema_version`, `generation` and `updated_at` are write-time projections
 * of the document, kept as columns so an operator can see which document
 * versions an instance holds and how far each actor's memory has advanced
 * without parsing a blob. They are never read back as state: the reader takes
 * the document, and only the document, as the snapshot.
 *
 * ## `ON DELETE RESTRICT`
 *
 * Matches `host_jobs` (0040) and `actor_experiments` (0047). Memory that
 * cannot be reconstructed must not disappear silently with its actor row.
 * Checked against the repository layer as it stands: `ActorRepository` exposes
 * no delete and retirement is a `retired_at` timestamp, so RESTRICT blocks no
 * production path today and forces a future deletion path to say out loud what
 * becomes of a retired actor's memory.
 *
 * Mutable until it reaches `master`: the id is the next one after
 * `0047_actor_experiments` on `staging`, and nothing between depends on it.
 */
export const portableContextSnapshots: Migration = {
  id: "0048_portable_context_snapshots",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE portable_context_snapshots (
        actor_id       TEXT PRIMARY KEY REFERENCES actors(id) ON DELETE RESTRICT,
        schema_version INTEGER NOT NULL,
        generation     INTEGER NOT NULL,
        updated_at     TEXT NOT NULL,
        snapshot       TEXT NOT NULL
      );
    `);
  },
};
