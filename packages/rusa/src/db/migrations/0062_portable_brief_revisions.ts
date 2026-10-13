import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Append-only history of accepted portable-context brief writes (#954).
 *
 * A brief-mode actor replaces its own brief through the brief MCP server. The
 * snapshot (`portable_context_snapshots`, 0048) keeps only the current brief;
 * this table is the one authoritative record of how it got there, shaped after
 * `obligation_history` (0045) so the two histories read the same way.
 *
 * ## Schema design
 *
 * - `id`: strictly monotonic integer key, so newest-first reads are an index
 *   scan with no timestamp ties.
 * - `actor_id`: references `actors(id)` with `ON DELETE RESTRICT`, matching the
 *   snapshot it describes: brief history must not vanish with an actor row.
 * - `generation`: the brief generation this write produced. `UNIQUE(actor_id,
 *   generation)` means two writers that both read generation N cannot both
 *   record N+1 — the database backstop under the repository's compare-and-set.
 * - `acting_principal`: the server-bound writer identity, never tool input.
 * - `timestamp`: ISO-8601 time the write was accepted.
 * - `payload`: versioned JSON (`schemaVersion`, `before`, `after`, optional
 *   `explanation`), validated by the consuming repository rather than by
 *   SQLite JSON functions, as in 0045 and 0048.
 *
 * ## Retention
 *
 * Every accepted write is kept; nothing prunes. A row is bounded (two briefs
 * under the 16 KiB cap plus an explanation), only an accepted CHANGE appends
 * (an unchanged write is a no-op), and writes are actor-initiated and rare. The
 * dashboard's latest-ten view is a `LIMIT` on read, not a retention policy.
 *
 * The `UNIQUE(actor_id, generation)` constraint creates the index that serves
 * `WHERE actor_id = ? ORDER BY generation DESC`.
 */
export const portableBriefRevisions: Migration = {
  id: "0062_portable_brief_revisions",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE portable_brief_revisions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id         TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
        generation       INTEGER NOT NULL CHECK (generation > 0),
        acting_principal TEXT NOT NULL CHECK (length(trim(acting_principal)) > 0),
        timestamp        TEXT NOT NULL CHECK (length(trim(timestamp)) > 0),
        payload          TEXT NOT NULL CHECK (length(trim(payload)) > 0),
        UNIQUE (actor_id, generation)
      );
    `);
  },
};
