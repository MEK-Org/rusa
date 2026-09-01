import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Join one durable actor run to the inbox work and obligation it selected.
 *
 * Inbox entries may bear on more than one obligation over their lifetime, so
 * their association is a separate many-to-many table. A run focus, by
 * contrast, has at most one primary obligation and one replaceable selected
 * entry set.
 */
export const inboxRunFocus: Migration = {
  id: "0031_inbox_run_focus",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE actor_run_focus (
        run_id                TEXT PRIMARY KEY REFERENCES actor_runs(id) ON DELETE CASCADE,
        actor_id              TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
        primary_obligation_id TEXT REFERENCES obligations(id) ON DELETE RESTRICT,
        resolution            TEXT NOT NULL
          CHECK (resolution IN ('explicit', 'inferred', 'none', 'ambiguous')),
        selected_at           TEXT NOT NULL,
        diagnostics_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(diagnostics_json))
      );

      CREATE INDEX idx_actor_run_focus_actor_selected
        ON actor_run_focus(actor_id, selected_at DESC, run_id DESC);

      CREATE TABLE actor_run_focus_entries (
        run_id   TEXT NOT NULL REFERENCES actor_run_focus(run_id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
        entry_id TEXT NOT NULL REFERENCES actor_inbox_entries(id) ON DELETE RESTRICT,
        PRIMARY KEY (run_id, entry_id)
      );

      CREATE INDEX idx_actor_run_focus_entries_inbox
        ON actor_run_focus_entries(actor_id, entry_id, run_id);

      CREATE TABLE inbox_entry_obligations (
        actor_id            TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
        entry_id            TEXT NOT NULL REFERENCES actor_inbox_entries(id) ON DELETE CASCADE,
        obligation_id       TEXT NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
        associated_at       TEXT NOT NULL,
        associated_by_run_id TEXT REFERENCES actor_runs(id) ON DELETE SET NULL,
        PRIMARY KEY (actor_id, entry_id, obligation_id)
      );

      CREATE INDEX idx_inbox_entry_obligations_obligation
        ON inbox_entry_obligations(obligation_id, actor_id, entry_id);
    `);
  },
};
