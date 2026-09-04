import { describe, expect, it } from "vitest";
import type { MeshActor } from "../actor/actor-mesh.js";
import { ActorMesh } from "../actor/actor-mesh.js";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import { adoptRigHolder, armRunModels, RIG_HOLDER_ID } from "./ab-context.js";

const ROOT_ID = "root";

/** Inert stand-in — these tests exercise the ownership tree, never a provider run. */
const stubActor = (id: string): MeshActor => ({
  id,
  isRunning: false,
  isQueued: false,
  requestRun: () => {},
  declareYield: () => {},
  markUnkillable: () => {},
  preemptForResponsive: () => ({ preempted: false }),
  close: () => {},
});

function setup() {
  const registry = new InMemoryActorRepository();
  let seq = 0;
  const mesh = new ActorMesh({
    actors: registry,
    idgen: () => `t${++seq}`,
    now: () => "2026-01-01T00:00:00Z",
    log: () => {},
    createActor: (ctx) => stubActor(ctx.record.id),
  });
  // The instance's live autonomous root, seeded exactly as `start.ts` seeds it.
  mesh.adopt(
    {
      id: ROOT_ID,
      charter: "root",
      parentId: null,
      isRoot: true,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    },
    stubActor(ROOT_ID)
  );
  return { mesh, registry };
}

describe("A/B arm parenting ", () => {
  const spawnArms = (mesh: ActorMesh, parentId: string) => ({
    native: mesh.spawn({
      charter: "harness",
      parentId,
      provider: "claude",
      model: "claude-sonnet-4-6",
      title: "ab-native",
    }),
    portable: mesh.spawn({
      charter: "harness",
      parentId,
      provider: "claude",
      model: "claude-sonnet-4-6",
      title: "ab-portable",
    }),
  });

  it("puts the arms two hops below root — real ancestor authority, but invisible to root's direct list_threads", () => {
    const { mesh } = setup();
    const arms = spawnArms(mesh, adoptRigHolder(mesh, ROOT_ID));

    // The holder is now an ordinary child of the real root (not a second parentless
    // actor — the corrected schema caps that shape to one row), so root genuinely is
    // an ancestor of the arms via the holder. That is fine: the fix never depended on
    // an authority trick, only on the arms not being root's DIRECT children (below).
    expect(mesh.isAncestorOf(ROOT_ID, arms.native)).toBe(true);
    expect(mesh.isAncestorOf(ROOT_ID, arms.portable)).toBe(true);
    expect(mesh.isAncestorOf(RIG_HOLDER_ID, arms.native)).toBe(true);
    expect(mesh.isAncestorOf(RIG_HOLDER_ID, arms.portable)).toBe(true);
  });

  it("makes the arms invisible to root's list_threads — the deduping STIMULUS is gone", () => {
    const { mesh } = setup();
    const arms = spawnArms(mesh, adoptRigHolder(mesh, ROOT_ID));

    // `list_threads` is exactly this filter (agent-exec-mcp.ts). Root never sees two
    // identically chartered DIRECT children, so it has nothing to deduplicate — the
    // arms being root's grandchildren via the holder is what fixes this.
    const rootChildren = mesh.list().filter((r) => r.parentId === ROOT_ID);
    expect(rootChildren.map((r) => r.id)).not.toContain(arms.native);
    expect(rootChildren.map((r) => r.id)).not.toContain(arms.portable);
    expect(rootChildren.map((r) => r.id)).toEqual([RIG_HOLDER_ID]);
  });

  it("is a real change: parenting the arms directly to root puts them back in reach", () => {
    // The counter-test. Without it, the assertion above would still pass against a
    // mesh where the list_threads filter was simply broken.
    const { mesh } = setup();
    const arms = spawnArms(mesh, ROOT_ID);
    expect(mesh.isAncestorOf(ROOT_ID, arms.native)).toBe(true);
    expect(mesh.list().filter((r) => r.parentId === ROOT_ID)).toHaveLength(2);
  });

  it("adopts the holder as root's own child, with no provider to burn quota on", () => {
    const { mesh, registry } = setup();
    adoptRigHolder(mesh, ROOT_ID);
    const rec = registry.get(RIG_HOLDER_ID);
    expect(rec?.parentId).toBe(ROOT_ID);
    expect(rec?.isRoot).toBe(false);
    expect(rec?.status).toBe("active");
    expect(rec?.provider).toBeUndefined();
  });

  it("does not create a second parentless top-level actor", () => {
    // The corrected actor schema derives root authority from parent_id IS NULL and caps
    // it to one row via a partial unique index; a parentless holder (the old shape)
    // would either collide with that index or read back as a second apparent root.
    const { mesh, registry } = setup();
    adoptRigHolder(mesh, ROOT_ID);
    expect(
      registry
        .list()
        .filter((r) => r.parentId === null)
        .map((r) => r.id)
    ).toEqual([ROOT_ID]);
  });
});

describe("the model an arm actually ran", () => {
  const event = (partial: Partial<MeshEvent>): MeshEvent => ({
    id: "e",
    ts: "2026-01-01T00:00:00Z",
    kind: "run_end",
    actorId: "native",
    detail: null,
    body: null,
    payload: null,
    success: true,
    ...partial,
  });

  it("keeps BOTH models when an arm was re-pinned mid-run", () => {
    // The reading this replaced answered with the last reporting run, which described a
    // six-step arm by the model it finished on. `checkModelIdentity` then compared that
    // one value against the other arm and could return `same ✓` for a run in which half
    // the steps ran something else. Order is first-seen, so the report shows the move.
    expect(
      armRunModels(
        [
          event({ payload: JSON.stringify({ model: "gpt-5.1-codex" }) }),
          event({ payload: JSON.stringify({ model: "gpt-5.5-codex" }) }),
        ],
        "native"
      ).models
    ).toEqual(["gpt-5.1-codex", "gpt-5.5-codex"]);
  });

  it("collapses repeats — a steady arm reports one model, however many runs it took", () => {
    // Distinct values only. Counting occurrences would make every multi-step arm look
    // like it changed models and void every run the gate exists to let through.
    expect(
      armRunModels(
        [
          event({ payload: JSON.stringify({ model: "gpt-5.5-codex" }) }),
          event({ payload: JSON.stringify({ model: "gpt-5.5-codex" }) }),
          event({ payload: JSON.stringify({ model: "gpt-5.5-codex" }) }),
        ],
        "native"
      ).models
    ).toEqual(["gpt-5.5-codex"]);
  });

  it("skips a silent run rather than letting it erase the reading", () => {
    // Only codex reports, and it reports nothing whenever its rollout cannot be read
    // back. A silent run is not evidence the arm stopped running that model — it is
    // evidence nobody looked on that run, so it must not discard the runs that did.
    expect(
      armRunModels(
        [
          event({ payload: JSON.stringify({ model: "gpt-5.5-codex" }) }),
          event({ payload: null }),
          event({ payload: JSON.stringify({ model: "gpt-5.5-codex" }) }),
        ],
        "native"
      ).models
    ).toEqual(["gpt-5.5-codex"]);
  });

  it("reads only this arm's own run_end events", () => {
    // The other arm's model must never leak across: that would manufacture agreement
    // between the two arms, which is precisely the claim this feeds.
    const events = [
      event({ actorId: "portable", payload: JSON.stringify({ model: "kimi-k2.5" }) }),
      event({ actorId: "native", kind: "run_start", payload: JSON.stringify({ model: "wrong" }) }),
    ];
    expect(armRunModels(events, "native").models).toEqual([]);
    expect(armRunModels(events, "portable").models).toEqual(["kimi-k2.5"]);
  });

  it("is empty when the arm never reported one", () => {
    expect(armRunModels([], "native").models).toEqual([]);
    expect(armRunModels([event({ payload: null })], "native").models).toEqual([]);
  });

  it("counts the runs it skipped, so the reading's width is visible", () => {
    // The models list alone cannot distinguish "every run said X" from "one run out of
    // six said X and the rest said nothing" — both read `["gpt-5.5-codex"]`. The count
    // is the difference, and it is what the `same` verdict's wording is measured against.
    const { models, coverage } = armRunModels(
      [
        event({ payload: JSON.stringify({ model: "gpt-5.5-codex" }) }),
        event({ payload: null }),
        event({ payload: JSON.stringify({ graceKilled: true }) }),
      ],
      "native"
    );

    expect(models).toEqual(["gpt-5.5-codex"]);
    expect(coverage).toEqual({ reported: 1, total: 3 });
  });

  it("counts over the same runs the models come from, never another arm's", () => {
    // The count is offered as coverage OF this list, so it has to be drawn from exactly
    // the population the list is. A total that swept in the other arm's runs, or the
    // arm's own run_start events, would understate coverage against runs that were never
    // candidates to report.
    const events = [
      event({ actorId: "portable", payload: JSON.stringify({ model: "kimi-k2.5" }) }),
      event({ actorId: "native", kind: "run_start", payload: null }),
      event({ actorId: "native", payload: JSON.stringify({ model: "gpt-5.5-codex" }) }),
    ];

    expect(armRunModels(events, "native").coverage).toEqual({ reported: 1, total: 1 });
    expect(armRunModels(events, "portable").coverage).toEqual({ reported: 1, total: 1 });
  });

  it("reports zero of zero for an arm that never ran", () => {
    // Not the same fact as "ran and stayed silent" (0 of 6), and the verdict message
    // distinguishes them. Both are still NOT a pass — that is `checkModelIdentity`'s
    // call, made on the empty models list, not on this count.
    expect(armRunModels([], "native").coverage).toEqual({ reported: 0, total: 0 });
  });
});
