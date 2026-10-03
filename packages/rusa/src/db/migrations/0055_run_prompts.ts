import type { Migration } from "./types.js";

/** Retained launch text stays out of the run ledger and event stream (#866). */
export const runPrompts: Migration = {
  id: "0055_run_prompts",
  up: (db) => {
    db.exec(`
      CREATE TABLE run_prompts (
        run_id TEXT PRIMARY KEY REFERENCES actor_runs(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        prompt_bytes INTEGER NOT NULL,
        provider TEXT NOT NULL,
        created_at TEXT NOT NULL,
        provenance TEXT
      );
      CREATE INDEX run_prompts_created_at ON run_prompts(created_at);
    `);
  },
};
