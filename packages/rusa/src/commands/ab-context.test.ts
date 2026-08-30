import { describe, expect, it } from "vitest";
import type { MeshActor } from "../actor/actor-mesh.js";
import { ActorMesh } from "../actor/actor-mesh.js";
import { InMemoryThreadRegistry } from "../actor/thread-registry.js";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import { adoptRigHolder, RIG_HOLDER_ID, reportedModels } from "./ab-context.js";

const ROOT_ID = "root";

/** Inert stand-in — these tests exercise the ownership tree, never a provider run. */
const stubActor = (id: string): MeshActor => ({
  id,
  isRunning: false,
  isQueued: false,
  requestRun: () => {},
  declareYield: () => {},
  markUnkillable: () => {},
  close: () => {},
});

function setup() {
  const registry = new InMemoryThreadRegistry();
  let seq = 0;
  const mesh = new ActorMesh({
    registry,
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

  it("keeps the arms out of the live root's subtree", () => {
    const { mesh } = setup();
    const arms = spawnArms(mesh, adoptRigHolder(mesh));

    // The authority lever: `retire_thread` permits a retire only when the caller is an
    // ancestor, and `isAncestorOf` walks `parentId` upward. Root is no longer on that path.
    expect(mesh.isAncestorOf(ROOT_ID, arms.native)).toBe(false);
    expect(mesh.isAncestorOf(ROOT_ID, arms.portable)).toBe(false);
    expect(mesh.isAncestorOf(RIG_HOLDER_ID, arms.native)).toBe(true);
    expect(mesh.isAncestorOf(RIG_HOLDER_ID, arms.portable)).toBe(true);
  });

  it("makes the arms invisible to root's list_threads — the deduping STIMULUS is gone", () => {
    const { mesh } = setup();
    const arms = spawnArms(mesh, adoptRigHolder(mesh));

    // `list_threads` is exactly this filter (agent-exec-mcp.ts). Root never sees two
    // identically chartered children, so it has nothing to deduplicate — which is the
    // actual fix; the authority block above is only the belt.
    const rootChildren = mesh.list().filter((r) => r.parentId === ROOT_ID);
    expect(rootChildren.map((r) => r.id)).not.toContain(arms.native);
    expect(rootChildren.map((r) => r.id)).not.toContain(arms.portable);
    expect(rootChildren).toHaveLength(0);
  });

  it("is a real change: parenting the arms to root puts them back in reach", () => {
    // The counter-test. Without it, both assertions above would still pass against a
    // mesh where `isAncestorOf` was simply broken.
    const { mesh } = setup();
    const arms = spawnArms(mesh, ROOT_ID);
    expect(mesh.isAncestorOf(ROOT_ID, arms.native)).toBe(true);
    expect(mesh.list().filter((r) => r.parentId === ROOT_ID)).toHaveLength(2);
  });

  it("adopts the holder as its own tree root, with no provider to burn quota on", () => {
    const { mesh, registry } = setup();
    adoptRigHolder(mesh);
    const rec = registry.get(RIG_HOLDER_ID);
    expect(rec?.parentId).toBeNull();
    expect(rec?.isRoot).toBe(false);
    expect(rec?.status).toBe("active");
    expect(rec?.provider).toBeUndefined();
  });

  it("keeps the parentless holder as an immovable ownership boundary", () => {
    const { mesh, registry } = setup();
    const holderId = adoptRigHolder(mesh);
    const arms = spawnArms(mesh, holderId);

    expect(() => mesh.reparentThread(holderId, ROOT_ID)).toThrow(
      `Cannot give the top-level thread ${holderId} a parent`
    );
    expect(registry.get(holderId)?.parentId).toBeNull();
    expect(mesh.isAncestorOf(ROOT_ID, arms.native)).toBe(false);
    expect(mesh.isAncestorOf(ROOT_ID, arms.portable)).toBe(false);
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
      reportedModels(
        [
          event({ payload: JSON.stringify({ model: "gpt-5.1-codex" }) }),
          event({ payload: JSON.stringify({ model: "gpt-5.5-codex" }) }),
        ],
        "native"
      )
    ).toEqual(["gpt-5.1-codex", "gpt-5.5-codex"]);
  });

  it("collapses repeats — a steady arm reports one model, however many runs it took", () => {
    // Distinct values only. Counting occurrences would make every multi-step arm look
    // like it changed models and void every run the gate exists to let through.
    expect(
      reportedModels(
        [
          event({ payload: JSON.stringify({ model: "gpt-5.5-codex" }) }),
          event({ payload: JSON.stringify({ model: "gpt-5.5-codex" }) }),
          event({ payload: JSON.stringify({ model: "gpt-5.5-codex" }) }),
        ],
        "native"
      )
    ).toEqual(["gpt-5.5-codex"]);
  });

  it("skips a silent run rather than letting it erase the reading", () => {
    // Only codex reports, and it reports nothing whenever its rollout cannot be read
    // back. A silent run is not evidence the arm stopped running that model — it is
    // evidence nobody looked on that run, so it must not discard the runs that did.
    expect(
      reportedModels(
        [
          event({ payload: JSON.stringify({ model: "gpt-5.5-codex" }) }),
          event({ payload: null }),
          event({ payload: JSON.stringify({ model: "gpt-5.5-codex" }) }),
        ],
        "native"
      )
    ).toEqual(["gpt-5.5-codex"]);
  });

  it("reads only this arm's own run_end events", () => {
    // The other arm's model must never leak across: that would manufacture agreement
    // between the two arms, which is precisely the claim this feeds.
    const events = [
      event({ actorId: "portable", payload: JSON.stringify({ model: "kimi-k2.5" }) }),
      event({ actorId: "native", kind: "run_start", payload: JSON.stringify({ model: "wrong" }) }),
    ];
    expect(reportedModels(events, "native")).toEqual([]);
    expect(reportedModels(events, "portable")).toEqual(["kimi-k2.5"]);
  });

  it("is empty when the arm never reported one", () => {
    expect(reportedModels([], "native")).toEqual([]);
    expect(reportedModels([event({ payload: null })], "native")).toEqual([]);
  });
});
