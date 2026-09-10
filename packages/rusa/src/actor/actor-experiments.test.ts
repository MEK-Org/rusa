import { describe, expect, it } from "vitest";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import type { Actor } from "./actor.js";
import { ActorMesh } from "./actor-mesh.js";
import {
  HEAD_OBLIGATION_CLOSURE_EXPERIMENT,
  InMemoryExperimentEnrollmentStore,
} from "./experiments.js";
import type { MeshEventInput } from "./mesh-events.js";

const EXPERIMENT = HEAD_OBLIGATION_CLOSURE_EXPERIMENT;

/**
 * A mesh over a fixed topology: root, a worker, the worker's parent, and a
 * sibling of the worker. Records are written straight to the repository so the
 * suite exercises enrollment authority rather than the run machinery.
 */
function setup(
  opts: {
    events?: (event: MeshEventInput) => void;
    experimentEnrollments?: InMemoryExperimentEnrollmentStore;
    workerStatus?: "active" | "retired";
  } = {}
) {
  const registry = new InMemoryActorRepository();
  registry.upsert({
    id: "root",
    charter: "root",
    parentId: null,
    isRoot: true,
    status: "active",
    createdAt: "2026-09-10T00:00:00Z",
  });
  registry.upsert({
    id: "parent",
    charter: "parent",
    parentId: "root",
    status: "active",
    createdAt: "2026-09-10T00:00:00Z",
  });
  registry.upsert({
    id: "worker",
    charter: "worker",
    parentId: "parent",
    status: opts.workerStatus ?? "active",
    createdAt: "2026-09-10T00:00:00Z",
  });
  registry.upsert({
    id: "sibling",
    charter: "sibling",
    parentId: "parent",
    status: "active",
    createdAt: "2026-09-10T00:00:00Z",
  });
  const enrollments = opts.experimentEnrollments ?? new InMemoryExperimentEnrollmentStore();
  const mesh = new ActorMesh({
    actors: registry,
    rootId: "root",
    createActor: () => ({}) as unknown as Actor,
    experimentEnrollments: enrollments,
    events: opts.events,
    now: () => "2026-09-10T00:00:00Z",
  });
  return { mesh, registry, enrollments };
}

describe("actor experiment enrollment", () => {
  it("enrolls an actor, evaluates it at runtime, and unenrolls it again", () => {
    const { mesh } = setup();
    expect(mesh.isEnrolledInExperiment("worker", EXPERIMENT)).toBe(false);

    expect(mesh.enrollActorInExperiment("worker", EXPERIMENT, "root")).toBe(true);
    expect(mesh.isEnrolledInExperiment("worker", EXPERIMENT)).toBe(true);
    expect(mesh.listExperimentEnrollments()).toEqual([
      {
        actorId: "worker",
        experiment: EXPERIMENT,
        enrolledBy: "root",
        enrolledAt: "2026-09-10T00:00:00Z",
      },
    ]);
    // Enrollment is per actor: nobody else is swept in.
    expect(mesh.isEnrolledInExperiment("sibling", EXPERIMENT)).toBe(false);

    expect(mesh.unenrollActorFromExperiment("worker", EXPERIMENT, "root")).toBe(true);
    expect(mesh.isEnrolledInExperiment("worker", EXPERIMENT)).toBe(false);
    expect(mesh.listExperimentEnrollments()).toEqual([]);
  });

  it("is idempotent in both directions, with deterministic readback", () => {
    const { mesh } = setup();
    expect(mesh.enrollActorInExperiment("worker", EXPERIMENT, "root")).toBe(true);
    expect(mesh.enrollActorInExperiment("worker", EXPERIMENT, "root")).toBe(false);
    expect(mesh.isEnrolledInExperiment("worker", EXPERIMENT)).toBe(true);
    expect(mesh.listExperimentEnrollments()).toHaveLength(1);

    expect(mesh.unenrollActorFromExperiment("worker", EXPERIMENT, "root")).toBe(true);
    expect(mesh.unenrollActorFromExperiment("worker", EXPERIMENT, "root")).toBe(false);
    expect(mesh.isEnrolledInExperiment("worker", EXPERIMENT)).toBe(false);
    expect(mesh.listExperimentEnrollments()).toEqual([]);
  });

  it("records one mesh event per real change and none for a repeat", () => {
    const events: MeshEventInput[] = [];
    const { mesh } = setup({ events: (event) => events.push(event) });

    mesh.enrollActorInExperiment("worker", EXPERIMENT, "root");
    mesh.enrollActorInExperiment("worker", EXPERIMENT, "root");
    mesh.unenrollActorFromExperiment("worker", EXPERIMENT, "root");
    mesh.unenrollActorFromExperiment("worker", EXPERIMENT, "root");

    expect(events.filter((event) => event.kind.startsWith("experiment_"))).toEqual([
      {
        kind: "experiment_enrolled",
        actorId: "worker",
        detail: EXPERIMENT,
        payload: JSON.stringify({ enrolledBy: "root" }),
      },
      {
        kind: "experiment_unenrolled",
        actorId: "worker",
        detail: EXPERIMENT,
        payload: JSON.stringify({ unenrolledBy: "root" }),
      },
    ]);
  });

  it("rejects an unknown experiment name rather than persisting it", () => {
    const { mesh, enrollments } = setup();
    expect(() => mesh.enrollActorInExperiment("worker", "not_an_experiment", "root")).toThrow(
      "unknown experiment: not_an_experiment"
    );
    expect(mesh.unenrollActorFromExperiment("worker", "not_an_experiment", "root")).toBe(false);
    expect(enrollments.list()).toEqual([]);
    // An unregistered name can never have been enrolled, so evaluating one is
    // deterministically false rather than an error at the read site.
    expect(mesh.isEnrolledInExperiment("worker", "not_an_experiment")).toBe(false);
  });

  it("allows root to unenroll a stale or unregistered experiment without throwing", () => {
    const { mesh, enrollments } = setup();
    // A stale row directly in store (e.g. experiment removed from registry)
    enrollments.enroll({
      actorId: "worker",
      experiment: "retired_experiment",
      enrolledBy: "root",
      enrolledAt: "2026-09-10T00:00:00Z",
    });
    expect(enrollments.list()).toHaveLength(1);
    expect(mesh.unenrollActorFromExperiment("worker", "retired_experiment", "root")).toBe(true);
    expect(enrollments.list()).toHaveLength(0);
  });

  it("admits only root: the actor itself, its parent, and a sibling are all refused", () => {
    const { mesh, enrollments } = setup();
    for (const caller of ["worker", "parent", "sibling", "ghost-caller"]) {
      expect(() => mesh.enrollActorInExperiment("worker", EXPERIMENT, caller)).toThrow(
        "only the root may enroll an actor in an experiment"
      );
    }
    expect(enrollments.list()).toEqual([]);

    // …and the same callers cannot undo root's enrollment either.
    mesh.enrollActorInExperiment("worker", EXPERIMENT, "root");
    for (const caller of ["worker", "parent", "sibling", "ghost-caller"]) {
      expect(() => mesh.unenrollActorFromExperiment("worker", EXPERIMENT, caller)).toThrow(
        "only the root may unenroll an actor from an experiment"
      );
    }
    expect(mesh.isEnrolledInExperiment("worker", EXPERIMENT)).toBe(true);
  });

  it("refuses an unknown target actor", () => {
    const { mesh, enrollments } = setup();
    expect(() => mesh.enrollActorInExperiment("ghost", EXPERIMENT, "root")).toThrow(
      "unknown thread id: ghost"
    );
    expect(() => mesh.unenrollActorFromExperiment("ghost", EXPERIMENT, "root")).toThrow(
      "unknown thread id: ghost"
    );
    expect(enrollments.list()).toEqual([]);
  });

  it("refuses to enroll a retired actor but still lets root unenroll one", () => {
    const enrollments = new InMemoryExperimentEnrollmentStore();
    const live = setup({ experimentEnrollments: enrollments });
    live.mesh.enrollActorInExperiment("worker", EXPERIMENT, "root");

    const retired = setup({ experimentEnrollments: enrollments, workerStatus: "retired" });
    // The enrollment outlives retirement, so a revived actor keeps its rollout.
    expect(retired.mesh.isEnrolledInExperiment("worker", EXPERIMENT)).toBe(true);
    expect(() => retired.mesh.enrollActorInExperiment("worker", EXPERIMENT, "root")).toThrow(
      "Cannot enroll a retired thread: worker"
    );
    expect(retired.mesh.unenrollActorFromExperiment("worker", EXPERIMENT, "root")).toBe(true);
    expect(retired.mesh.isEnrolledInExperiment("worker", EXPERIMENT)).toBe(false);
  });

  it("keeps enrollments across a mesh restart when the store is durable", () => {
    const enrollments = new InMemoryExperimentEnrollmentStore();
    const first = setup({ experimentEnrollments: enrollments });
    first.mesh.enrollActorInExperiment("worker", EXPERIMENT, "root");
    first.mesh.enrollActorInExperiment("sibling", EXPERIMENT, "root");
    first.mesh.unenrollActorFromExperiment("sibling", EXPERIMENT, "root");

    // A second mesh over the same durable store is what a restart looks like
    // from the mesh's side: no in-process state carries over.
    const second = setup({ experimentEnrollments: enrollments });
    expect(second.mesh.isEnrolledInExperiment("worker", EXPERIMENT)).toBe(true);
    expect(second.mesh.isEnrolledInExperiment("sibling", EXPERIMENT)).toBe(false);
  });

  it("defaults to an in-memory store when the wiring supplies none", () => {
    const registry = new InMemoryActorRepository();
    registry.upsert({
      id: "root",
      charter: "root",
      parentId: null,
      isRoot: true,
      status: "active",
      createdAt: "2026-09-10T00:00:00Z",
    });
    const mesh = new ActorMesh({
      actors: registry,
      rootId: "root",
      createActor: () => ({}) as unknown as Actor,
    });
    expect(mesh.enrollActorInExperiment("root", EXPERIMENT, "root")).toBe(true);
    expect(mesh.isEnrolledInExperiment("root", EXPERIMENT)).toBe(true);
  });
});
