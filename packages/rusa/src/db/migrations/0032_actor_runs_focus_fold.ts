import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Fold the run-focus fields from the separate actor_run_focus table onto actor_runs.
 * This ensures selection focus remains bound directly to the run metadata.
 */
export const actorRunsFocusFold: Migration = {
  id: "0032_actor_runs_focus_fold",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE actor_runs ADD COLUMN focus_primary_obligation_id TEXT REFERENCES obligations(id) ON DELETE SET NULL;
      ALTER TABLE actor_runs ADD COLUMN focus_resolution TEXT CHECK (focus_resolution IN ('explicit', 'inferred', 'none', 'ambiguous'));
      ALTER TABLE actor_runs ADD COLUMN focus_selected_at TEXT;
      ALTER TABLE actor_runs ADD COLUMN focus_entry_ids_json TEXT CHECK (focus_entry_ids_json IS NULL OR json_valid(focus_entry_ids_json));
      ALTER TABLE actor_runs ADD COLUMN focus_diagnostics_json TEXT CHECK (focus_diagnostics_json IS NULL OR json_valid(focus_diagnostics_json));

      UPDATE actor_runs
      SET
        focus_primary_obligation_id = (SELECT primary_obligation_id FROM actor_run_focus WHERE run_id = actor_runs.id),
        focus_resolution = (SELECT resolution FROM actor_run_focus WHERE run_id = actor_runs.id),
        focus_selected_at = (SELECT selected_at FROM actor_run_focus WHERE run_id = actor_runs.id),
        focus_entry_ids_json = (SELECT entry_ids_json FROM actor_run_focus WHERE run_id = actor_runs.id),
        focus_diagnostics_json = (SELECT diagnostics_json FROM actor_run_focus WHERE run_id = actor_runs.id)
      WHERE id IN (SELECT run_id FROM actor_run_focus);

      DROP TABLE actor_run_focus;
    `);
  },
};
