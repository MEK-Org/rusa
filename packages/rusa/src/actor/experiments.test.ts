import { describe, expect, it } from "vitest";
import {
  EXPERIMENT,
  testExperimentEnrollmentStoreContract,
  WORKER,
} from "./experiment-enrollment-store.contract.js";
import {
  assertKnownExperiment,
  EXPERIMENTS,
  type ExperimentRegistry,
  experimentNames,
  InMemoryExperimentEnrollmentStore,
  isKnownExperiment,
} from "./experiments.js";

const FIXTURE_REGISTRY: ExperimentRegistry = {
  fixture_rollout: { intent: "Exercise the rollout seam." },
  another_rollout: { intent: "Exercise ordering." },
};

describe("the experiment registry", () => {
  it("is empty between rollouts: strict obligation handling is no longer an experiment (#917)", () => {
    expect(experimentNames()).toEqual([]);
    expect(Object.keys(EXPERIMENTS)).toEqual([]);
    expect(isKnownExperiment("strict_obligation_handling")).toBe(false);
  });

  it("lists names in a stable order, and every fixture entry has an intent", () => {
    expect(experimentNames(FIXTURE_REGISTRY)).toEqual(["another_rollout", "fixture_rollout"]);
    for (const name of experimentNames(FIXTURE_REGISTRY)) {
      expect(FIXTURE_REGISTRY[name]?.intent.trim().length).toBeGreaterThan(0);
    }
  });

  it("recognizes a registered name and rejects everything else", () => {
    expect(isKnownExperiment("fixture_rollout", FIXTURE_REGISTRY)).toBe(true);
    expect(isKnownExperiment("fixture_rollout ", FIXTURE_REGISTRY)).toBe(false);
    expect(isKnownExperiment("Fixture_Rollout", FIXTURE_REGISTRY)).toBe(false);
    expect(isKnownExperiment("not_an_experiment", FIXTURE_REGISTRY)).toBe(false);
    expect(isKnownExperiment("", FIXTURE_REGISTRY)).toBe(false);
    // An inherited Object property is not an experiment, however much it looks
    // like a key.
    expect(isKnownExperiment("constructor", FIXTURE_REGISTRY)).toBe(false);
    expect(isKnownExperiment("toString", FIXTURE_REGISTRY)).toBe(false);
  });

  it("names the registry contents when it refuses an unknown experiment", () => {
    expect(assertKnownExperiment("fixture_rollout", FIXTURE_REGISTRY)).toBe("fixture_rollout");
    expect(() => assertKnownExperiment("not_an_experiment", FIXTURE_REGISTRY)).toThrow(
      "unknown experiment: not_an_experiment (known: another_rollout, fixture_rollout)"
    );
    expect(() => assertKnownExperiment("not_an_experiment")).toThrow(
      "unknown experiment: not_an_experiment (known: none)"
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
