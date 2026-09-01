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
        primary_obligation_id TEXT REFERENCES obligations(id) ON DELETE SET NULL,
        resolution            TEXT NOT NULL
          CHECK (resolution IN ('explicit', 'inferred', 'none', 'ambiguous')),
        selected_at           TEXT NOT NULL,
        entry_ids_json        TEXT NOT NULL CHECK (json_valid(entry_ids_json)),
        diagnostics_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(diagnostics_json))
      );

      CREATE TABLE inbox_entry_obligations (
        actor_id            TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
        entry_id            TEXT NOT NULL REFERENCES actor_inbox_entries(id) ON DELETE CASCADE,
        obligation_id       TEXT NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
        associated_at       TEXT NOT NULL,
        associated_by_run_id TEXT REFERENCES actor_runs(id) ON DELETE SET NULL,
        PRIMARY KEY (actor_id, entry_id, obligation_id)
      );
    `);
  },
};
