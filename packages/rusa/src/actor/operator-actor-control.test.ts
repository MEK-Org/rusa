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
  return {
    actors,
    events,
    grants,
    audits,
    obligationAudits,
    control: new OperatorActorControl(mesh, grants, () => "2026-10-16T05:30:00.000Z"),
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
