import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import { ActorMesh } from "./actor-mesh.js";
import type { ActorRecord } from "./actor-record.js";
import {
  ACTOR_ADMIN_CAPABILITY,
  ADMINISTRATIVE_CAPABILITIES,
  CAPABILITY_ADMIN_CAPABILITY,
  EXPERIMENT_ADMIN_CAPABILITY,
  HOST_MAINTENANCE_CAPABILITIES,
  MODEL_ADMIN_CAPABILITY,
  seedConfiguredActorGrants,
} from "./administrative-capabilities.js";
import { InMemoryCapabilityGrantStore } from "./capability-grants.js";
import { STRICT_OBLIGATION_HANDLING_EXPERIMENT } from "./experiments.js";

/**
 * Authority over other actors is grant-derived (#549). These characterizations
 * pin the boundary: an opaque-id actor holding a grant may administer its
 * subtree; a parentless actor, an `isRoot: true` record, or the literal `root`
 * address without a grant may not; revocation withdraws authority immediately.
 */

// The generic `secret` base is grantable (#542); the parent-grantable path
// below needs the named key file to pass containment, so stage one.
const GRANTABLE = new Set(["understanding-write", "secret"]);
const secretsDir = mkdtempSync(join(tmpdir(), "rusa-actor-mesh-administration-secrets-"));
writeFileSync(join(secretsDir, "gemini-api-key"), "synthetic-gemini-value");

afterAll(() => {
  rmSync(secretsDir, { recursive: true, force: true });
});

function record(
  id: string,
  parentId: string | null,
  extra: Partial<ActorRecord> = {}
): ActorRecord {
  return {
    id,
    charter: id,
    parentId,
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

function setup() {
  const actors = new InMemoryActorRepository();
  const grants = new InMemoryCapabilityGrantStore();
  const mesh = new ActorMesh({
    actors,
    rootId: "configured",
    capabilityGrants: grants,
    secretsDir,
    grantableCapabilities: new Set([
      ...GRANTABLE,
      ...ADMINISTRATIVE_CAPABILITIES,
      ...HOST_MAINTENANCE_CAPABILITIES,
    ]),
    now: () => "2026-01-01T00:00:00Z",
    createActor: (ctx) => ({
      id: ctx.record.id,
      requestRun: () => {},
      declareYield: () => {},
      markUnkillable: () => {},
      close: () => {},
      preemptForResponsive: () => ({ preempted: false }),
      isRunning: false,
    }),
  });
  // The configured actor: parentless and flagged, exactly as the wiring adopts it.
  actors.upsert(record("configured", null, { isRoot: true }));
  // A second parentless, flagged actor with its own subtree and no grants.
  actors.upsert(record("other-parentless", null, { isRoot: true }));
  actors.upsert(record("other-child", "other-parentless"));
  // An opaque-id steward under the configured actor, with a child of its own.
  actors.upsert(record("0b2c3d4e-steward", "configured"));
  actors.upsert(record("steward-child", "0b2c3d4e-steward"));
  actors.upsert(record("sibling", "configured"));
  return { actors, grants, mesh };
}

describe("capability administration is grant-derived", () => {
  it("lets a capable opaque-id actor grant within its subtree and refuses it outside", async () => {
    const { grants, mesh } = setup();
    grants.grant({
      actorId: "0b2c3d4e-steward",
      capability: CAPABILITY_ADMIN_CAPABILITY,
      grantedBy: "test",
      grantedAt: "2026-01-01T00:00:00Z",
    });

    expect(() =>
      mesh.grantCapability("steward-child", "understanding-write", "0b2c3d4e-steward")
    ).not.toThrow();
    expect(mesh.activeCapabilitiesFor("steward-child")).toContain("understanding-write");
    await expect(
      mesh.revokeCapability("steward-child", "understanding-write", "0b2c3d4e-steward")
    ).resolves.toBeUndefined();
    expect(mesh.activeCapabilitiesFor("steward-child")).not.toContain("understanding-write");

    // Subtree boundary: a sibling and another top-level tree are out of reach.
    expect(() =>
      mesh.grantCapability("sibling", "understanding-write", "0b2c3d4e-steward")
    ).toThrow(/own subtree/);
    expect(() =>
      mesh.grantCapability("other-child", "understanding-write", "0b2c3d4e-steward")
    ).toThrow(/own subtree/);
  });

  it("refuses an ungranted parentless isRoot record and the literal root address", () => {
    const { mesh } = setup();
    expect(() =>
      mesh.grantCapability("other-child", "understanding-write", "other-parentless")
    ).toThrow(/capability-admin/);
    expect(() => mesh.grantCapability("sibling", "understanding-write", "configured")).toThrow(
      /capability-admin/
    );
    expect(() => mesh.grantCapability("sibling", "understanding-write", "root")).toThrow(
      /capability-admin/
    );
    expect(mesh.activeCapabilitiesFor("sibling")).toEqual([]);
  });

  it("keeps the parent-grantable secret path for an ungranted parent", () => {
    const { mesh } = setup();
    expect(() =>
      mesh.grantCapability("steward-child", "secret:gemini-api-key", "0b2c3d4e-steward")
    ).not.toThrow();
    expect(() =>
      mesh.grantCapability("steward-child", "understanding-write", "0b2c3d4e-steward")
    ).toThrow(/capability-admin/);
  });

  it("withdraws grant authority the moment capability-admin is revoked", async () => {
    const { grants, mesh } = setup();
    grants.grant({
      actorId: "0b2c3d4e-steward",
      capability: CAPABILITY_ADMIN_CAPABILITY,
      grantedBy: "test",
      grantedAt: "2026-01-01T00:00:00Z",
    });
    // A holder may revoke its own grant; nothing restores it afterwards.
    await mesh.revokeCapability(
      "0b2c3d4e-steward",
      CAPABILITY_ADMIN_CAPABILITY,
      "0b2c3d4e-steward"
    );
    expect(() =>
      mesh.grantCapability("steward-child", "understanding-write", "0b2c3d4e-steward")
    ).toThrow(/capability-admin/);
  });

  it("lets a capability-admin holder delegate an administrative capability into its subtree", () => {
    const { grants, mesh } = setup();
    seedConfiguredActorGrants(grants, "configured", () => "2026-01-01T00:00:00Z");
    mesh.grantCapability("0b2c3d4e-steward", EXPERIMENT_ADMIN_CAPABILITY, "configured");
    expect(mesh.hasActiveCapability("0b2c3d4e-steward", EXPERIMENT_ADMIN_CAPABILITY)).toBe(true);
    expect(mesh.hasActiveCapability("steward-child", EXPERIMENT_ADMIN_CAPABILITY)).toBe(false);
  });

  // Host maintenance (`update`, `pnpm-hardlinks`) acts on the whole daemon, so
  // the subtree boundary that bounds every other delegation cannot bound it. A
  // holder may hold, revoke and re-grant it to itself; it may not hand it down.
  it("refuses to delegate a host-maintenance capability below the holder", async () => {
    const { grants, mesh } = setup();
    seedConfiguredActorGrants(grants, "configured", () => "2026-01-01T00:00:00Z");
    for (const capability of HOST_MAINTENANCE_CAPABILITIES) {
      expect(() => mesh.grantCapability("0b2c3d4e-steward", capability, "configured")).toThrow(
        /not delegable/
      );
      expect(mesh.hasActiveCapability("0b2c3d4e-steward", capability)).toBe(false);
    }
    // Revoking from itself and restoring to itself stays possible, so a
    // revocation is not a one-way door that only a database edit reopens.
    await mesh.revokeCapability("configured", "update", "configured");
    expect(mesh.hasActiveCapability("configured", "update")).toBe(false);
    expect(() => mesh.grantCapability("configured", "update", "configured")).not.toThrow();
    expect(mesh.hasActiveCapability("configured", "update")).toBe(true);
  });
});

describe("experiment administration is grant-derived", () => {
  it("authorizes a capable opaque-id actor over its subtree only", () => {
    const { grants, mesh } = setup();
    grants.grant({
      actorId: "0b2c3d4e-steward",
      capability: EXPERIMENT_ADMIN_CAPABILITY,
      grantedBy: "test",
      grantedAt: "2026-01-01T00:00:00Z",
    });
    expect(
      mesh.enrollActorInExperiment(
        "steward-child",
        STRICT_OBLIGATION_HANDLING_EXPERIMENT,
        "0b2c3d4e-steward"
      )
    ).toEqual({ actorId: "steward-child", changed: true });
    expect(() =>
      mesh.enrollActorInExperiment(
        "sibling",
        STRICT_OBLIGATION_HANDLING_EXPERIMENT,
        "0b2c3d4e-steward"
      )
    ).toThrow(/own subtree/);
    expect(
      mesh.unenrollActorFromExperiment(
        "steward-child",
        STRICT_OBLIGATION_HANDLING_EXPERIMENT,
        "0b2c3d4e-steward"
      )
    ).toEqual({ actorId: "steward-child", changed: true });
  });

  it("refuses an ungranted parentless isRoot record", () => {
    const { mesh } = setup();
    expect(() =>
      mesh.enrollActorInExperiment(
        "other-child",
        STRICT_OBLIGATION_HANDLING_EXPERIMENT,
        "other-parentless"
      )
    ).toThrow(/experiment-admin/);
    expect(() =>
      mesh.enrollActorInExperiment("sibling", STRICT_OBLIGATION_HANDLING_EXPERIMENT, "configured")
    ).toThrow(/experiment-admin/);
  });
});

describe("model administration is grant-derived", () => {
  const pool = { provider: "claude", model: "claude-sonnet-4-6" };

  it("lets a model-admin holder set any subtree model including its own, and nothing outside", () => {
    const { grants, mesh } = setup();
    grants.grant({
      actorId: "0b2c3d4e-steward",
      capability: MODEL_ADMIN_CAPABILITY,
      grantedBy: "test",
      grantedAt: "2026-01-01T00:00:00Z",
    });
    expect(() => mesh.setActorModel("steward-child", pool, "0b2c3d4e-steward")).not.toThrow();
    expect(() => mesh.setActorModel("0b2c3d4e-steward", pool, "0b2c3d4e-steward")).not.toThrow();
    expect(() => mesh.setActorModel("sibling", pool, "0b2c3d4e-steward")).toThrow(/subtree/);
    expect(() => mesh.setActorModel("other-child", pool, "0b2c3d4e-steward")).toThrow(/subtree/);
  });

  it("keeps the ordinary parent path and refuses an ungranted parentless actor its own model", () => {
    const { mesh } = setup();
    // An ungranted parent may still set a descendant's model.
    expect(() => mesh.setActorModel("steward-child", pool, "0b2c3d4e-steward")).not.toThrow();
    // Being parentless and flagged is not model authority over oneself.
    expect(() => mesh.setActorModel("configured", pool, "configured")).toThrow(/own model/);
    expect(() => mesh.setActorModel("other-parentless", pool, "other-parentless")).toThrow(
      /own model/
    );
  });
});

describe("the configured actor's seeded access", () => {
  it("preserves every current administrative operation after the one-time seed", async () => {
    const { grants, mesh } = setup();
    seedConfiguredActorGrants(grants, "configured", () => "2026-01-01T00:00:00Z");
    expect(() =>
      mesh.grantCapability("sibling", "understanding-write", "configured")
    ).not.toThrow();
    await expect(
      mesh.revokeCapability("sibling", "understanding-write", "root")
    ).resolves.toBeUndefined();
    expect(
      mesh.enrollActorInExperiment("steward-child", STRICT_OBLIGATION_HANDLING_EXPERIMENT, "root")
    ).toEqual({ actorId: "steward-child", changed: true });
    expect(() =>
      mesh.setActorModel(
        "configured",
        { provider: "claude", model: "claude-sonnet-4-6" },
        "configured"
      )
    ).not.toThrow();
    for (const capability of ADMINISTRATIVE_CAPABILITIES) {
      expect(mesh.hasActiveCapability("root", capability)).toBe(true);
    }
    expect(mesh.hasActiveCapability("other-parentless", ACTOR_ADMIN_CAPABILITY)).toBe(false);
  });

  it("does not reach into another top-level tree even when seeded", () => {
    const { grants, mesh } = setup();
    seedConfiguredActorGrants(grants, "configured", () => "2026-01-01T00:00:00Z");
    expect(() => mesh.grantCapability("other-child", "understanding-write", "configured")).toThrow(
      /own subtree/
    );
  });
});
