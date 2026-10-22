import { describe, expect, it, vi } from "vitest";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import type { Actor } from "./actor.js";
import { ActorMesh } from "./actor-mesh.js";
import type { ActorRecord } from "./actor-record.js";
import { OBLIGATIONS_ADMIN_CAPABILITY } from "./administrative-capabilities.js";
import { InMemoryCapabilityGrantStore } from "./capability-grants.js";
import type { MeshEventInput } from "./mesh-events.js";
import {
  OperatorActorControl,
  type OperatorObligationsAdminAudit,
  type OperatorReparentAudit,
  type OperatorRetireAudit,
} from "./operator-actor-control.js";

const OPERATOR = "00000000-0000-4000-8000-000000000001";

function record(id: string, parentId: string | null): ActorRecord {
  return {
    id,
    charter: id,
    parentId,
    ...(parentId === null ? { executionConfig: { unsandboxed: true } } : {}),
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Two forests: imported → steward → worker, and other → other-child. */
function setup() {
  const actors = new InMemoryActorRepository();
  const grants = new InMemoryCapabilityGrantStore();
  const events: MeshEventInput[] = [];
  for (const [id, parentId] of [
    ["imported", null],
    ["steward", "imported"],
    ["worker", "steward"],
    ["other", null],
    ["other-child", "other"],
  ] as const) {
    actors.upsert(record(id, parentId));
  }
  const mesh = new ActorMesh({
    actors,
    rootId: "imported",
    createActor: () => ({ run: vi.fn() }) as unknown as Actor,
    events: (event) => events.push(event),
  });
  const audits = (): OperatorReparentAudit[] =>
    events
      .filter((event) => event.kind === "operator_actor_reparent")
      .map((event) => JSON.parse(event.payload ?? "{}") as OperatorReparentAudit);
  const obligationAudits = (): OperatorObligationsAdminAudit[] =>
    events
      .filter((event) => event.kind === "operator_obligations_admin")
      .map((event) => JSON.parse(event.payload ?? "{}") as OperatorObligationsAdminAudit);
  const retirementAudits = (): OperatorRetireAudit[] =>
    events
      .filter((event) => event.kind === "operator_actor_retire")
      .map((event) => JSON.parse(event.payload ?? "{}") as OperatorRetireAudit);
  return {
    actors,
    events,
    grants,
    audits,
    obligationAudits,
    retirementAudits,
    mesh,
    control: new OperatorActorControl(mesh, grants, "imported", () => "2026-10-16T05:30:00.000Z"),
  };
}

describe("OperatorActorControl (#1003)", () => {
  it("detaches, reattaches across forests and moves the formerly configured actor, auditing each", () => {
    const { actors, events, audits, control } = setup();

    control.reparent("worker", null, OPERATOR);
    expect(actors.get("worker")?.parentId).toBeNull();

    control.reparent("worker", "other-child", OPERATOR);
    expect(actors.get("worker")?.parentId).toBe("other-child");

    // The formerly configured actor is no longer special: it can be demoted
    // beneath another forest, its subtree riding along.
    control.reparent("imported", "other", OPERATOR);
    expect(actors.get("imported")?.parentId).toBe("other");
    expect(actors.get("steward")?.parentId).toBe("imported");

    expect(audits()).toEqual([
      {
        principal: OPERATOR,
        actorId: "worker",
        fromParentId: "steward",
        toParentId: null,
        outcome: "ok",
      },
      {
        principal: OPERATOR,
        actorId: "worker",
        fromParentId: null,
        toParentId: "other-child",
        outcome: "ok",
      },
      {
        principal: OPERATOR,
        actorId: "imported",
        fromParentId: null,
        toParentId: "other",
        outcome: "ok",
      },
    ]);
    // Each audit is keyed by the moved actor, beside its own edge-change event.
    expect(
      events.filter((e) => e.kind === "operator_actor_reparent").map((e) => e.actorId)
    ).toEqual(["worker", "worker", "imported"]);
    expect(events.filter((e) => e.kind === "actor_reparented")).toHaveLength(3);
  });

  it("audits denied moves and leaves the tree unchanged", () => {
    const { actors, audits, control } = setup();
    actors.patch("other-child", { status: "retired" });

    const attempts: Array<[string, string | null, RegExp]> = [
      ["imported", "worker", /cycle/],
      ["steward", "steward", /to itself/],
      ["other", null, /already top-level/],
      ["steward", "other-child", /non-active parent/],
      ["other-child", null, /non-active thread/],
      ["ghost", "other", /unknown thread/],
      ["steward", "ghost", /unknown parent/],
    ];
    for (const [actorId, to, reason] of attempts) {
      expect(() => control.reparent(actorId, to, OPERATOR), `${actorId} -> ${to}`).toThrow(reason);
    }

    expect(actors.get("imported")?.parentId).toBeNull();
    expect(actors.get("steward")?.parentId).toBe("imported");
    expect(actors.get("other")?.parentId).toBeNull();
    expect(actors.get("other-child")?.parentId).toBe("other");
    expect(audits()).toHaveLength(attempts.length);
    audits().forEach((audit, index) => {
      const [actorId, to, reason] = attempts[index] as [string, string | null, RegExp];
      expect(audit).toMatchObject({
        principal: OPERATOR,
        actorId,
        toParentId: to,
        outcome: "denied",
      });
      expect(audit.reason).toMatch(reason);
    });
    expect(audits()[0]?.fromParentId).toBeNull();
    expect(audits()[1]?.fromParentId).toBe("imported");
  });

  it("refuses the root LLM principal the human operator's reach", () => {
    const { actors, audits, control } = setup();

    expect(() => control.reparent("worker", null, "root-llm")).toThrow(/human operator/);
    expect(actors.get("worker")?.parentId).toBe("steward");
    expect(audits()).toEqual([
      expect.objectContaining({ principal: "root-llm", actorId: "worker", outcome: "denied" }),
    ]);
  });

  it("retires a detached actor through the authenticated operator boundary and audits it", () => {
    const { actors, events, retirementAudits, control } = setup();

    control.reparent("worker", null, OPERATOR);
    control.retire("worker", OPERATOR);

    expect(actors.get("worker")?.status).toBe("retired");
    expect(retirementAudits()).toEqual([{ principal: OPERATOR, actorId: "worker", outcome: "ok" }]);
    expect(events.filter((event) => event.kind === "operator_actor_retire")).toHaveLength(1);
  });

  it("refuses and audits root-LLM, configured root, unknown, already-retired, and mutation-time blocked operator retirement requests", () => {
    const { actors, retirementAudits, control, mesh } = setup();
    actors.patch("other-child", { status: "retired" });

    expect(() => control.retire("worker", "root-llm")).toThrow(/human operator/);
    control.reparent("root", "other", OPERATOR);
    expect(() => control.retire("root", OPERATOR)).toThrow(/configured root actor/);
    expect(actors.get("imported")?.parentId).toBe("other");
    expect(() => control.retire("ghost", OPERATOR)).toThrow(/unknown actor/);
    expect(() => control.retire("other-child", OPERATOR)).toThrow(/not active/);
    expect(actors.get("imported")?.status).toBe("active");
    expect(actors.get("worker")?.status).toBe("active");

    vi.spyOn(mesh, "retire").mockImplementationOnce(() => {
      throw new Error("actor has in-flight run");
    });
    expect(() => control.retire("worker", OPERATOR)).toThrow("actor has in-flight run");
    expect(actors.get("worker")?.status).toBe("active");

    expect(retirementAudits()).toEqual([
      expect.objectContaining({ principal: "root-llm", actorId: "worker", outcome: "denied" }),
      expect.objectContaining({
        principal: OPERATOR,
        actorId: "imported",
        outcome: "denied",
        reason: "configured root actor may not be retired through the operator retire boundary",
      }),
      expect.objectContaining({ principal: OPERATOR, actorId: "ghost", outcome: "denied" }),
      expect.objectContaining({ principal: OPERATOR, actorId: "other-child", outcome: "denied" }),
      expect.objectContaining({
        principal: OPERATOR,
        actorId: "worker",
        outcome: "denied",
        reason: "actor has in-flight run",
      }),
    ]);
  });

  it("provisions, reads back, revokes, and audits obligations administration separately", () => {
    const { control, grants, obligationAudits } = setup();

    expect(control.setObligationsAdmin("worker", true, OPERATOR)).toEqual({
      actorId: "worker",
      capability: OBLIGATIONS_ADMIN_CAPABILITY,
      active: true,
    });
    expect(grants.activeFor("worker")).toEqual([OBLIGATIONS_ADMIN_CAPABILITY]);
    expect(grants.list()).toMatchObject([
      {
        actorId: "worker",
        capability: OBLIGATIONS_ADMIN_CAPABILITY,
        grantedBy: `operator:${OPERATOR}`,
        grantedAt: "2026-10-16T05:30:00.000Z",
      },
    ]);

    expect(control.setObligationsAdmin("worker", false, OPERATOR)).toEqual({
      actorId: "worker",
      capability: OBLIGATIONS_ADMIN_CAPABILITY,
      active: false,
    });
    expect(grants.activeFor("worker")).toEqual([]);
    expect(obligationAudits()).toEqual([
      expect.objectContaining({
        principal: OPERATOR,
        actorId: "worker",
        enabled: true,
        outcome: "ok",
      }),
      expect.objectContaining({
        principal: OPERATOR,
        actorId: "worker",
        enabled: false,
        outcome: "ok",
      }),
    ]);
  });

  it("uses durable actor IDs when the legacy root alias crosses an operator boundary", () => {
    const { actors, audits, control, grants, obligationAudits, retirementAudits } = setup();

    control.reparent("root", "other", OPERATOR);
    expect(actors.get("imported")?.parentId).toBe("other");
    expect(audits()).toEqual([
      {
        principal: OPERATOR,
        actorId: "imported",
        fromParentId: null,
        toParentId: "other",
        outcome: "ok",
      },
    ]);

    expect(control.setObligationsAdmin("root", true, OPERATOR)).toEqual({
      actorId: "imported",
      capability: OBLIGATIONS_ADMIN_CAPABILITY,
      active: true,
    });
    expect(grants.activeFor("imported")).toEqual([OBLIGATIONS_ADMIN_CAPABILITY]);
    expect(obligationAudits()).toEqual([
      expect.objectContaining({ actorId: "imported", outcome: "ok" }),
    ]);

    control.retire("other-child", OPERATOR);
    expect(actors.get("other-child")?.status).toBe("retired");
    expect(retirementAudits()).toEqual([
      expect.objectContaining({ actorId: "other-child", outcome: "ok" }),
    ]);
  });

  it("denies and audits root-LLM and unknown-target obligations-admin requests", () => {
    const { control, grants, obligationAudits } = setup();

    expect(() => control.setObligationsAdmin("worker", true, "root-llm")).toThrow(/human operator/);
    expect(() => control.setObligationsAdmin("ghost", true, OPERATOR)).toThrow(/unknown actor/);
    expect(grants.list()).toEqual([]);
    expect(obligationAudits()).toEqual([
      expect.objectContaining({
        principal: "root-llm",
        actorId: "worker",
        enabled: true,
        outcome: "denied",
      }),
      expect.objectContaining({
        principal: OPERATOR,
        actorId: "ghost",
        enabled: true,
        outcome: "denied",
      }),
    ]);
  });
});
