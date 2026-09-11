import type Database from "better-sqlite3";
import type { ExperimentEnrollment, ExperimentEnrollmentStore } from "../../actor/experiments.js";

type EnrollmentRow = {
  actor_id: string;
  experiment: string;
  enrolled_by: string;
  enrolled_at: string;
};

function fromRow(row: EnrollmentRow): ExperimentEnrollment {
  return {
    actorId: row.actor_id,
    experiment: row.experiment,
    enrolledBy: row.enrolled_by,
    enrolledAt: row.enrolled_at,
  };
}

/**
 * SQLite implementation of {@link ExperimentEnrollmentStore} (#394) — every
 * call reads straight from `actor_experiments` with no process-local cache, so
 * an enrollment committed by another connection is visible to the next call
 * without an orchestrator restart, and every enrollment survives one.
 * `actor_id` is owned by the referenced `actors` row (0047_actor_experiments).
 *
 * The row's existence is the state: `enroll` inserts, `unenroll` deletes, and
 * both report whether they actually changed anything so the caller can stay
 * idempotent without reading first.
 */
export class DbExperimentEnrollmentStore implements ExperimentEnrollmentStore {
  constructor(private readonly db: Database.Database) {}

  enroll(enrollment: ExperimentEnrollment): boolean {
    // DO NOTHING, not DO UPDATE: re-enrolling an already-enrolled actor is not a
    // new enrollment, so the stamp of the enrollment actually in force is the
    // one that stays.
    return (
      this.db
        .prepare(
          `INSERT INTO actor_experiments (actor_id, experiment, enrolled_by, enrolled_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(actor_id, experiment) DO NOTHING`
        )
        .run(
          enrollment.actorId,
          enrollment.experiment,
          enrollment.enrolledBy,
          enrollment.enrolledAt
        ).changes > 0
    );
  }

  unenroll(actorId: string, experiment: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM actor_experiments WHERE actor_id = ? AND experiment = ?")
        .run(actorId, experiment).changes > 0
    );
  }

  isEnrolled(actorId: string, experiment: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM actor_experiments WHERE actor_id = ? AND experiment = ?")
        .get(actorId, experiment) !== undefined
    );
  }

  list(): ExperimentEnrollment[] {
    return (
      this.db
        .prepare(
          "SELECT actor_id, experiment, enrolled_by, enrolled_at FROM actor_experiments ORDER BY actor_id, experiment"
        )
        .all() as EnrollmentRow[]
    ).map(fromRow);
  }
}
