/**
 * Actor experiments — the mesh's rollout seam (#394).
 *
 * A behavior that should eventually be true of every actor still has to be
 * tried on a few first. Before this existed, the only way to say "these actors,
 * not those" was a durable column on `actors`, which turns every rollout into a
 * permanent piece of actor *configuration* — a knob nobody later removes, even
 * once the behavior is universal or abandoned. An enrollment is the other
 * shape: the actor is in the experiment or it is not, the set of experiments is
 * a hard-coded list in code, and retiring an experiment is deleting its entry
 * plus its rows rather than rewriting a table every actor carries.
 *
 * Three properties are the whole design:
 *
 * - **The registry is code.** {@link EXPERIMENTS} is the complete list. New
 *   enrollments must be registered, and unregistered names are behaviorally
 *   inactive (`isEnrolledInExperiment` evaluates to false). Stale rows may
 *   temporarily exist in the store after an experiment is removed from the
 *   registry until root explicitly unenrolls them for cleanup. That keeps the
 *   store from silently becoming a bag of arbitrary strings whose meaning lives
 *   only in whoever typed them.
 * - **Presence is the state.** A row means enrolled; no row means not enrolled.
 *   There is no per-experiment tombstone, unlike `capability_grants`, because a
 *   rollout has no audit obligation a capability has: the row is the only
 *   durable state, and `enrolledBy`/`enrolledAt` describe the enrollment in
 *   force so an active enrollment reads back deterministically. The mesh
 *   events (`experiment_enrolled`/`experiment_unenrolled`) are best-effort
 *   observability, not a record anything depends on.
 * - **Administration is root-only and ungrantable.** Enforced in
 *   {@link ActorMesh}, one layer up from this module, which is pure registry
 *   plus persistence.
 */

/** One entry in the hard-coded registry. */
export interface ExperimentDefinition {
  /** What enrolling an actor is expected to change, in one line. */
  readonly intent: string;
}

/**
 * The `head_obligation_closure` experiment: the #382 clean-yield rule that a run
 * which selects a new head obligation must make that obligation terminal or
 * decompose it before yielding cleanly. Named here so the rollout boundary
 * exists ahead of the behavior; #382 consumes it separately, and this package
 * deliberately carries none of that behavior.
 */
export const HEAD_OBLIGATION_CLOSURE_EXPERIMENT = "head_obligation_closure";

/**
 * The complete set of experiments an actor may be enrolled in. Adding one is a
 * code change here and nowhere else — no migration, no schema constraint, no
 * data backfill. Removing one is the same edit plus deleting its rows, which is
 * exactly the disposability an experiment is supposed to have.
 */
export const EXPERIMENTS = {
  [HEAD_OBLIGATION_CLOSURE_EXPERIMENT]: {
    intent:
      "Require a run that selects a new head obligation to finish or decompose it before it may yield cleanly.",
  },
} as const satisfies Record<string, ExperimentDefinition>;

/** The registered experiment names, as a type. */
export type ExperimentName = keyof typeof EXPERIMENTS;

/** The registered names in a stable order, for readback and error messages. */
export const EXPERIMENT_NAMES: readonly ExperimentName[] = Object.keys(
  EXPERIMENTS
).sort() as ExperimentName[];

/**
 * Whether `name` is a registered experiment. `Object.hasOwn`, not `in`: an
 * inherited `Object` key ("constructor", "toString") is not an experiment,
 * however much it resolves like one.
 */
export function isKnownExperiment(name: string): name is ExperimentName {
  return Object.hasOwn(EXPERIMENTS, name);
}

/**
 * Narrow `name` to a registered experiment or refuse it, naming the registry so
 * the caller learns what it could have said instead of guessing again.
 */
export function assertKnownExperiment(name: string): ExperimentName {
  if (!isKnownExperiment(name)) {
    throw new Error(`unknown experiment: ${name} (known: ${EXPERIMENT_NAMES.join(", ")})`);
  }
  return name;
}

/** One actor's current enrollment in one experiment. */
export interface ExperimentEnrollment {
  /** The enrolled actor's id (its stable thread id). */
  actorId: string;
  /** The experiment name: registered when enrolled, or a formerly registered name in a stale row awaiting cleanup. */
  experiment: string;
  /** Who enrolled it — the root, in v1. */
  enrolledBy: string;
  /** ISO timestamp of the enrollment that is currently in force. */
  enrolledAt: string;
}

/**
 * What an enroll/unenroll reported back: the canonical thread id the change was
 * keyed on and whether anything actually changed. `changed: false` is the
 * idempotent repeat — already enrolled, or nothing to remove.
 */
export interface ExperimentEnrollmentChange {
  actorId: string;
  changed: boolean;
}

/**
 * Persistence boundary for enrollments — mirrors `CapabilityGrantStore`: SQLite
 * in production ({@link DbExperimentEnrollmentStore}), in-memory for tests and
 * the e2e runner. Keyed on (actorId, experiment); at most one row per pair.
 *
 * The store is registry-blind on purpose. Validating a name here would put the
 * registry behind the persistence boundary, where a SQLite constraint would
 * have to be rewritten every time the list changes; the mesh validates instead,
 * so nothing but code has an opinion about which experiments exist.
 */
export interface ExperimentEnrollmentStore {
  /**
   * Enroll `actorId`. Idempotent: returns true when this call changed the
   * state, false when the actor was already enrolled (in which case the
   * existing stamp is kept, since no new enrollment happened).
   */
  enroll(enrollment: ExperimentEnrollment): boolean;
  /**
   * Remove an enrollment. Idempotent: returns true when a row was removed,
   * false when there was nothing to remove.
   */
  unenroll(actorId: string, experiment: string): boolean;
  /** Whether `actorId` is currently enrolled in `experiment`. */
  isEnrolled(actorId: string, experiment: string): boolean;
  /**
   * Every current enrollment, ordered by (actorId, experiment) with plain
   * code-unit comparison — the readback/inspection view. Ordering is part of
   * the contract so a readback is the same whichever store backs the mesh.
   */
  list(): ExperimentEnrollment[];
}

const key = (actorId: string, experiment: string): string => `${actorId} ${experiment}`;

/** (actorId, experiment) order, comparing code units like SQLite's BINARY collation. */
const byKey = (a: ExperimentEnrollment, b: ExperimentEnrollment): number => {
  if (a.actorId !== b.actorId) return a.actorId < b.actorId ? -1 : 1;
  if (a.experiment !== b.experiment) return a.experiment < b.experiment ? -1 : 1;
  return 0;
};

/** In-memory enrollment store — for tests and the e2e runner. */
export class InMemoryExperimentEnrollmentStore implements ExperimentEnrollmentStore {
  private readonly enrollments = new Map<string, ExperimentEnrollment>();

  enroll(enrollment: ExperimentEnrollment): boolean {
    const k = key(enrollment.actorId, enrollment.experiment);
    if (this.enrollments.has(k)) return false;
    this.enrollments.set(k, { ...enrollment });
    return true;
  }

  unenroll(actorId: string, experiment: string): boolean {
    return this.enrollments.delete(key(actorId, experiment));
  }

  isEnrolled(actorId: string, experiment: string): boolean {
    return this.enrollments.has(key(actorId, experiment));
  }

  list(): ExperimentEnrollment[] {
    return [...this.enrollments.values()].sort(byKey).map((enrollment) => ({ ...enrollment }));
  }
}
