import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/** Durable obligation tree and its derived per-owner ready ordering . */
export const obligations: Migration = {
  id: "0016_obligations",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE obligations (
        id             TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
        parent_id      TEXT REFERENCES obligations(id) ON DELETE RESTRICT,
        owner_kind     TEXT NOT NULL CHECK (owner_kind IN ('actor', 'human')),
        owner_id       TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
        intent         TEXT,
        external_ref   TEXT,
        status         TEXT NOT NULL CHECK (status IN ('ready', 'waiting', 'done', 'cancelled')),
        queue_position INTEGER NOT NULL,
        CHECK (parent_id IS NULL OR parent_id <> id),
        CHECK (external_ref IS NULL OR length(trim(external_ref)) > 0)
      );

      CREATE INDEX idx_obligations_parent
        ON obligations(parent_id);
      CREATE INDEX idx_obligations_owner_status_order
        ON obligations(owner_kind, owner_id, status, queue_position, id);
      CREATE UNIQUE INDEX idx_obligations_live_external_ref
        ON obligations(external_ref COLLATE NOCASE)
        WHERE external_ref IS NOT NULL AND status IN ('ready', 'waiting');
    `);
  },
};
