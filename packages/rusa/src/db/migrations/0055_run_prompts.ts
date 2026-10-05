import type { Migration } from "./types.js";

/**
 * Retained launch text stays out of the run ledger and event stream (#866).
 * It is not part of the run entity: fetching a run never loads it, callers
 * ask for it separately, and they must expect it to be gone once the 30-day
 * retention prunes it.
 */
export const runPrompts: Migration = {
  id: "0055_run_prompts",
  up: (db) => {
    db.exec(`
      CREATE TABLE run_prompts (
        run_id TEXT PRIMARY KEY REFERENCES actor_runs(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX run_prompts_created_at ON run_prompts(created_at);
    `);
  },
};
