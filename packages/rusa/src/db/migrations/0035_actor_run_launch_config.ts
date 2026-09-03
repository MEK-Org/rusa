import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * `actor_runs.model` was already writable, but the only path that ever wrote it
 * was `complete()` copying the provider's post-hoc read-back (`RunResult.model`,
 * populated only by `codex.ts`) — so every other provider's rows landed with an
 * empty model despite a real pin having been passed at launch (design #184).
 * `effort` has no prior column at all.
 *
 * `effort_is_set` mirrors the `desired_effort_is_set` pattern from
 * `0034_actor_runtime_state`: a provider with no native effort control gets an
 * explicit `0`, not a bare NULL, so it reads as "recorded — not applicable"
 * rather than being indistinguishable from a historical row that predates this
 * column (NULL) or a future bug that fails to record at all.
 */
export const actorRunLaunchConfig: Migration = {
  id: "0035_actor_run_launch_config",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE actor_runs ADD COLUMN effort TEXT;
      ALTER TABLE actor_runs ADD COLUMN effort_is_set INTEGER CHECK (effort_is_set IN (0, 1));
    `);
  },
};
