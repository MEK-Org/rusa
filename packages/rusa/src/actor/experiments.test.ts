import { describe, expect, it } from "vitest";
import {
  EXPERIMENT,
  testExperimentEnrollmentStoreContract,
  WORKER,
} from "./experiment-enrollment-store.contract.js";
import {
  assertKnownExperiment,
  EXPERIMENT_NAMES,
  EXPERIMENTS,
  HEAD_OBLIGATION_CLOSURE_EXPERIMENT,
  InMemoryExperimentEnrollmentStore,
  isKnownExperiment,
} from "./experiments.js";

describe("the experiment registry", () => {
  it("is exactly the hard-coded set, and every entry has an intent", () => {
    expect(EXPERIMENT_NAMES).toEqual([HEAD_OBLIGATION_CLOSURE_EXPERIMENT]);
    for (const name of EXPERIMENT_NAMES) {
      expect(EXPERIMENTS[name].intent.trim().length).toBeGreaterThan(0);
    }
  });

  it("recognizes a registered name and rejects everything else", () => {
    expect(isKnownExperiment(HEAD_OBLIGATION_CLOSURE_EXPERIMENT)).toBe(true);
    expect(isKnownExperiment("head_obligation_closure ")).toBe(false);
    expect(isKnownExperiment("Head_Obligation_Closure")).toBe(false);
    expect(isKnownExperiment("not_an_experiment")).toBe(false);
    expect(isKnownExperiment("")).toBe(false);
    // An inherited Object property is not an experiment, however much it looks
    // like a key.
    expect(isKnownExperiment("constructor")).toBe(false);
    expect(isKnownExperiment("toString")).toBe(false);
  });

  it("names the registry contents when it refuses an unknown experiment", () => {
    expect(assertKnownExperiment(HEAD_OBLIGATION_CLOSURE_EXPERIMENT)).toBe(
      HEAD_OBLIGATION_CLOSURE_EXPERIMENT
    );
    expect(() => assertKnownExperiment("not_an_experiment")).toThrow(
      `unknown experiment: not_an_experiment (known: ${EXPERIMENT_NAMES.join(", ")})`
    );
  });
});

testExperimentEnrollmentStoreContract(
  "InMemoryExperimentEnrollmentStore",
  () => new InMemoryExperimentEnrollmentStore()
);

describe("InMemoryExperimentEnrollmentStore", () => {
  it("keeps no state between instances (it is the test/e2e store)", () => {
    const first = new InMemoryExperimentEnrollmentStore();
    first.enroll({
      actorId: WORKER,
      experiment: EXPERIMENT,
      enrolledBy: "root",
      enrolledAt: "2026-09-10T00:00:00Z",
    });
    expect(new InMemoryExperimentEnrollmentStore().isEnrolled(WORKER, EXPERIMENT)).toBe(false);
  });
});
