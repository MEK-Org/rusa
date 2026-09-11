import { describe, expect, it } from "vitest";
import type { ExperimentEnrollment, ExperimentEnrollmentStore } from "./experiments.js";

export const ROOT = "root";
export const WORKER = "worker-thread-1";
export const OTHER = "worker-thread-2";

/** The one registered experiment; the store itself holds no registry opinion. */
export const EXPERIMENT = "strict_obligation_handling";

export const enrollment = (over: Partial<ExperimentEnrollment> = {}): ExperimentEnrollment => ({
  actorId: WORKER,
  experiment: EXPERIMENT,
  enrolledBy: ROOT,
  enrolledAt: "2026-09-10T00:00:00Z",
  ...over,
});

/**
 * Behavior every {@link ExperimentEnrollmentStore} implementation must satisfy,
 * independent of backing storage — run against both
 * `InMemoryExperimentEnrollmentStore` and `DbExperimentEnrollmentStore`.
 * Implementation-specific concerns (foreign keys, primary-key enforcement,
 * reopen after restart) stay in each store's own test file.
 *
 * The store is deliberately registry-blind: rejecting an unregistered name is
 * the mesh's job, one layer up, so a registry edit never has to reach storage.
 */
export function testExperimentEnrollmentStoreContract(
  name: string,
  makeStore: () => ExperimentEnrollmentStore
): void {
  describe(`${name} (ExperimentEnrollmentStore contract)`, () => {
    it("enrolls an actor and reports the enrollment back", () => {
      const store = makeStore();
      expect(store.enroll(enrollment())).toBe(true);
      expect(store.isEnrolled(WORKER, EXPERIMENT)).toBe(true);
      expect(store.isEnrolled(OTHER, EXPERIMENT)).toBe(false);
    });

    it("is idempotent per (actorId, experiment) and reports no change on the repeat", () => {
      const store = makeStore();
      expect(store.enroll(enrollment())).toBe(true);
      expect(store.enroll(enrollment({ enrolledAt: "2026-09-11T00:00:00Z" }))).toBe(false);
      expect(store.list()).toHaveLength(1);
      // The first enrollment stamp is the one that survives: re-enrolling an
      // already-enrolled actor is a no-op, not a fresh enrollment.
      expect(store.list()[0]?.enrolledAt).toBe("2026-09-10T00:00:00Z");
    });

    it("unenrolls, leaving no row behind", () => {
      const store = makeStore();
      store.enroll(enrollment());
      expect(store.unenroll(WORKER, EXPERIMENT)).toBe(true);
      expect(store.isEnrolled(WORKER, EXPERIMENT)).toBe(false);
      expect(store.list()).toEqual([]);
    });

    it("unenrolling an actor that was never enrolled is a no-op", () => {
      const store = makeStore();
      expect(store.unenroll(WORKER, EXPERIMENT)).toBe(false);
      expect(store.unenroll(WORKER, EXPERIMENT)).toBe(false);
      expect(store.list()).toEqual([]);
    });

    it("re-enrolls after an unenrollment with the new stamp", () => {
      const store = makeStore();
      store.enroll(enrollment());
      store.unenroll(WORKER, EXPERIMENT);
      expect(store.enroll(enrollment({ enrolledAt: "2026-09-12T00:00:00Z" }))).toBe(true);
      expect(store.isEnrolled(WORKER, EXPERIMENT)).toBe(true);
      expect(store.list()[0]?.enrolledAt).toBe("2026-09-12T00:00:00Z");
    });

    it("tracks enrollments per actor and experiment independently", () => {
      const store = makeStore();
      store.enroll(enrollment({ actorId: WORKER, experiment: EXPERIMENT }));
      store.enroll(enrollment({ actorId: WORKER, experiment: "other_experiment" }));
      store.enroll(enrollment({ actorId: OTHER, experiment: EXPERIMENT }));

      expect(store.isEnrolled(WORKER, EXPERIMENT)).toBe(true);
      expect(store.isEnrolled(WORKER, "other_experiment")).toBe(true);
      expect(store.isEnrolled(OTHER, EXPERIMENT)).toBe(true);
      expect(store.isEnrolled(OTHER, "other_experiment")).toBe(false);

      store.unenroll(WORKER, EXPERIMENT);
      expect(store.isEnrolled(WORKER, EXPERIMENT)).toBe(false);
      expect(store.isEnrolled(WORKER, "other_experiment")).toBe(true);
      expect(store.isEnrolled(OTHER, EXPERIMENT)).toBe(true);
    });

    it("list() returns every current enrollment ordered by (actorId, experiment)", () => {
      const store = makeStore();
      // Names spelled in known alphabetical order here rather than reusing the
      // registered one, so renaming an experiment cannot quietly flip what this
      // asserts. Enrolled out of order on purpose: the contract is key order,
      // not insertion order, so a readback is the same whichever store backs it.
      store.enroll(enrollment({ actorId: OTHER, experiment: "alpha_experiment" }));
      store.enroll(enrollment({ actorId: WORKER, experiment: "beta_experiment" }));
      store.enroll(enrollment({ actorId: WORKER, experiment: "alpha_experiment" }));
      expect(store.list()).toEqual([
        enrollment({ actorId: WORKER, experiment: "alpha_experiment" }),
        enrollment({ actorId: WORKER, experiment: "beta_experiment" }),
        enrollment({ actorId: OTHER, experiment: "alpha_experiment" }),
      ]);
    });
  });
}
