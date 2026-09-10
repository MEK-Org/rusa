import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Durable per-actor experiment enrollments (#394).
 *
 * The smallest durable scheme that survives restart *and* keeps a rollout from
 * turning into permanent actor configuration: one row per (actor, experiment),
 * where the row's existence is the entire state. Enrolling inserts, unenrolling
 * deletes, and evaluation is an existence check.
 *
 * Shaped after `capability_grants` (0036) — the mesh's other per-actor durable
 * authority table — with two deliberate differences:
 *
 * - **No `revoked_at` tombstone.** A grant keeps its revocation because the
 *   grant history *is* the audit trail for a capability someone once held. A
 *   rollout has no such obligation: who enrolled whom and when is on the mesh
 *   event timeline (`experiment_enrolled` / `experiment_unenrolled`), so the
 *   table holds only what is true now, and unenrolling leaves nothing behind.
 * - **No name constraint.** The registry of legal experiment names lives in
 *   code (`actor/experiments.ts`) and the mesh rejects anything outside it. A
 *   CHECK naming the experiments would make every registry edit a table
 *   rebuild, which is the opposite of what an experiment list is for — and
 *   an experiment is supposed to be cheap to add and cheaper to delete.
 *
 * `ON DELETE RESTRICT` matches `capability_grants` and `obligations.parent_id`:
 * an actor row cannot vanish out from under state that names it. It costs
 * nothing in practice, because retirement marks an actor retired rather than
 * deleting it, and an unenroll clears the reference outright.
 *
 * Retirement itself is deliberately not modelled here. An enrollment outlives a
 * retired actor so a revived one resumes the rollout it was in; withdrawing it
 * is an explicit unenroll, which the mesh permits on a retired actor precisely
 * so a rollout can be wound back without reviving anybody.
 */
export const actorExperiments: Migration = {
  id: "0047_actor_experiments",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE actor_experiments (
        actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
        experiment  TEXT NOT NULL,
        enrolled_by TEXT NOT NULL,
        enrolled_at TEXT NOT NULL,
        PRIMARY KEY (actor_id, experiment)
      );
    `);
  },
};
