import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../actor/actor.js";
import { ActorMesh } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import {
  CAPABILITY_ADMIN_CAPABILITY,
  CONFIGURED_ACTOR_BOOTSTRAP_GRANTOR,
  EXPERIMENT_ADMIN_CAPABILITY,
} from "../actor/administrative-capabilities.js";
import type { CapabilityPolicy } from "../actor/capability-grants.js";
import type { MeshEventInput } from "../actor/mesh-events.js";
import { createInProcessMeshWriter, type MeshObligationWriter } from "./mesh-write-operations.js";
import { runMigrations } from "./migrations/runner.js";
import { Repositories } from "./repositories/index.js";

// Grant and experiment authority is decided inside the writer's transaction
// (#1289 D1): a revocation or reparent that commits before the write executes
// refuses it, with no row and no effect, even when the mesh's advisory check
// passed first.

const AT = "2026-11-12T00:00:00.000Z";
const EXPERIMENT = "fixture_rollout";

function record(
  id: string,
  parentId: string | null,
  extra: Partial<ActorRecord> = {}
): ActorRecord {
  return { id, charter: id, parentId, status: "active", createdAt: AT, ...extra };
}

describe("grant and experiment writes decide authority in the transaction (#1289 D1)", () => {
  let db: Database.Database;
  let repos: Repositories;
  let writer: MeshObligationWriter;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    repos = new Repositories(db);
    writer = createInProcessMeshWriter(db, repos.meshWriteRepos());
    // root → steward → worker, and a second tree other → other-child.
    for (const [id, parentId] of [
      ["root", null],
      ["steward", "root"],
      ["worker", "steward"],
      ["other", null],
      ["other-child", "other"],
    ] as const) {
      repos.actors.upsert(record(id, parentId));
    }
    for (const capability of [CAPABILITY_ADMIN_CAPABILITY, EXPERIMENT_ADMIN_CAPABILITY]) {
      repos.capabilityGrants.grant({
        actorId: "root",
        capability,
        grantedBy: "test",
        grantedAt: AT,
      });
      repos.capabilityGrants.grant({
        actorId: "steward",
        capability,
        grantedBy: "root",
        grantedAt: AT,
      });
    }
  });

  afterEach(() => {
    db.close();
  });

  const grant = (actorId: string, capability: string, grantedBy: string) =>
    writer.write("grants.grant", {
      grant: { actorId, capability, grantedBy, grantedAt: AT },
      policy: null,
    });

  it("grants for an authorized grantor, and refuses once its authority is revoked, writing nothing", async () => {
    await grant("worker", "understanding-write", "steward");
    expect(repos.capabilityGrants.activeFor("worker")).toEqual(["understanding-write"]);

    await writer.write("grants.revoke", {
      actorId: "steward",
      capability: CAPABILITY_ADMIN_CAPABILITY,
      revokedBy: "root",
      at: AT,
      policy: null,
    });
    await expect(grant("worker", "drive-read", "steward")).rejects.toThrow(
      "only a capability-admin holder may grant drive-read"
    );
    expect(repos.capabilityGrants.activeFor("worker")).toEqual(["understanding-write"]);
  });

  it("refuses a parent's grant and revocation once the grantee is reparented away", async () => {
    await writer.write("grants.revoke", {
      actorId: "steward",
      capability: CAPABILITY_ADMIN_CAPABILITY,
      revokedBy: "root",
      at: AT,
      policy: null,
    });
    // A parent without capability-admin may delegate the LLM keys to its child.
    await grant("worker", "secret:gemini-api-key", "steward");
    repos.actors.patch("worker", { parentId: "root" });

    await expect(grant("worker", "secret:mistral-api-key", "steward")).rejects.toThrow(
      "worker is not a child of steward"
    );
    await expect(
      writer.write("grants.revoke", {
        actorId: "worker",
        capability: "secret:gemini-api-key",
        revokedBy: "steward",
        at: AT,
        policy: null,
      })
    ).rejects.toThrow("worker is not a child of steward");
    expect(repos.capabilityGrants.activeFor("worker")).toEqual(["secret:gemini-api-key"]);
  });

  it("refuses a capability-admin grant outside the grantor's subtree after a reparent", async () => {
    repos.actors.patch("worker", { parentId: "other" });
    await expect(grant("worker", "understanding-write", "steward")).rejects.toThrow(
      "steward may only grant capabilities in its own subtree (cannot grant worker)"
    );
    expect(repos.capabilityGrants.activeFor("worker")).toEqual([]);
  });

  it("decides role-derived authority from the policy and ignores bootstrap rows it replaces", async () => {
    repos.actors.upsert(record("default", null));
    repos.actors.upsert(record("default-child", "default"));
    repos.capabilityGrants.grant({
      actorId: "other",
      capability: CAPABILITY_ADMIN_CAPABILITY,
      grantedBy: CONFIGURED_ACTOR_BOOTSTRAP_GRANTOR,
      grantedAt: AT,
    });
    const policy: CapabilityPolicy = {
      recipientId: "default",
      capabilities: [CAPABILITY_ADMIN_CAPABILITY],
      ignoredGrantor: CONFIGURED_ACTOR_BOOTSTRAP_GRANTOR,
    };
    const grantWith = (actorId: string, grantedBy: string) =>
      writer.write("grants.grant", {
        grant: { actorId, capability: "understanding-write", grantedBy, grantedAt: AT },
        policy,
      });

    await grantWith("default-child", "default");
    expect(repos.capabilityGrants.activeFor("default-child")).toEqual(["understanding-write"]);
    // A former default's bootstrap row confers nothing under the policy.
    await expect(grantWith("other-child", "other")).rejects.toThrow(
      "only a capability-admin holder may grant understanding-write"
    );
    expect(repos.capabilityGrants.activeFor("other-child")).toEqual([]);
  });

  it("enrolls for an experiment-admin, and refuses once that is revoked or the target retires", async () => {
    const enroll = (actorId: string, enrolledBy: string) =>
      writer.write("experiments.enroll", {
        enrollment: { actorId, experiment: EXPERIMENT, enrolledBy, enrolledAt: AT },
        policy: null,
      });
    expect(await enroll("worker", "steward")).toBe(true);

    repos.actors.patch("steward", { status: "retired" });
    await expect(enroll("steward", "root")).rejects.toThrow(
      "Cannot enroll a retired thread: steward"
    );
    repos.actors.patch("steward", { status: "active" });

    await writer.write("grants.revoke", {
      actorId: "steward",
      capability: EXPERIMENT_ADMIN_CAPABILITY,
      revokedBy: "root",
      at: AT,
      policy: null,
    });
    await expect(
      writer.write("experiments.unenroll", {
        actorId: "worker",
        experiment: EXPERIMENT,
        unenrolledBy: "steward",
        policy: null,
      })
    ).rejects.toThrow("only an experiment-admin holder may unenroll");
    expect(repos.experimentEnrollments.isEnrolled("worker", EXPERIMENT)).toBe(true);
  });

  it("sets an operator-provisioned grant only for an actor that exists, answering the committed state", async () => {
    const set = (actorId: string, active: boolean) =>
      writer.write("grants.setOperatorProvisioned", {
        actorId,
        capability: "obligations-admin",
        active,
        grantedBy: "operator:test",
        at: AT,
      });
    expect(await set("missing", true)).toEqual({ known: false, active: false });
    expect(repos.capabilityGrants.list().filter((g) => g.actorId === "missing")).toEqual([]);
    expect(await set("worker", true)).toEqual({ known: true, active: true });
    expect(await set("worker", false)).toEqual({ known: true, active: false });
  });

  describe("through the mesh", () => {
    /**
     * A mesh over these repositories whose grant writes can be held after its
     * advisory check passes, so a revocation commits in between.
     */
    function heldMesh() {
      let hold: Promise<void> | null = null;
      let release = () => {};
      const events: MeshEventInput[] = [];
      const granted: string[] = [];
      const mesh = new ActorMesh({
        actors: repos.actors,
        rootId: "root",
        capabilityGrants: repos.capabilityGrants,
        experimentEnrollments: repos.experimentEnrollments,
        experimentRegistry: { [EXPERIMENT]: { intent: "Exercise the rollout seam." } },
        grantableCapabilities: new Set(["understanding-write"]),
        writer: {
          write: (async (op: string, input: unknown) => {
            if (hold && (op === "grants.grant" || op === "experiments.enroll")) await hold;
            return (writer.write as (op: string, input: unknown) => Promise<unknown>)(op, input);
          }) as MeshObligationWriter["write"],
        },
        events: (event) => events.push(event),
        onCapabilityGranted: (actorId, capability) => granted.push(`${actorId}:${capability}`),
        now: () => AT,
        createActor: () => ({}) as unknown as Actor,
      });
      return {
        mesh,
        events,
        granted,
        holdWrites: () => {
          hold = new Promise<void>((resolve) => (release = resolve));
        },
        releaseWrites: () => release(),
      };
    }

    const revokeFromSteward = (capability: string) =>
      writer.write("grants.revoke", {
        actorId: "steward",
        capability,
        revokedBy: "root",
        at: AT,
        policy: null,
      });

    it("refuses a grant whose grantor is revoked after the mesh's check, with no row, event or hook", async () => {
      const { mesh, events, granted, holdWrites, releaseWrites } = heldMesh();
      holdWrites();
      const pending = mesh.grantCapability("worker", "understanding-write", "steward");
      await revokeFromSteward(CAPABILITY_ADMIN_CAPABILITY);
      releaseWrites();

      await expect(pending).rejects.toThrow(
        "only a capability-admin holder may grant understanding-write"
      );
      expect(repos.capabilityGrants.activeFor("worker")).toEqual([]);
      expect(events.filter((e) => e.kind === "capability_granted")).toEqual([]);
      expect(granted).toEqual([]);
    });

    it("refuses an enrollment whose enroller is revoked after the mesh's check", async () => {
      const { mesh, holdWrites, releaseWrites } = heldMesh();
      holdWrites();
      const pending = mesh.enrollActorInExperiment("worker", EXPERIMENT, "steward");
      await revokeFromSteward(EXPERIMENT_ADMIN_CAPABILITY);
      releaseWrites();

      await expect(pending).rejects.toThrow("only an experiment-admin holder may enroll");
      expect(repos.experimentEnrollments.isEnrolled("worker", EXPERIMENT)).toBe(false);
    });

    it("still grants and announces when nothing intervenes", async () => {
      const { mesh, events, granted } = heldMesh();
      await mesh.grantCapability("worker", "understanding-write", "steward");
      expect(repos.capabilityGrants.activeFor("worker")).toEqual(["understanding-write"]);
      expect(events.filter((e) => e.kind === "capability_granted")).toHaveLength(1);
      expect(granted).toEqual(["worker:understanding-write"]);
    });
  });
});
