import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInProcessMeshWriter,
  type MeshObligationWriter,
} from "../db/mesh-write-operations.js";
import { runMigrations } from "../db/migrations/runner.js";
import { Repositories } from "../db/repositories/index.js";
import type { Actor } from "./actor.js";
import { ActorMesh } from "./actor-mesh.js";
import type { ActorRecord } from "./actor-record.js";
import { CAPABILITY_ADMIN_CAPABILITY } from "./administrative-capabilities.js";

// Where a grant's event and hook land relative to other writes' ordered effect
// delivery, on the real in-process writer (#1289 D1, #1309 review). They are
// that grant's writer effect, so they follow the sequencer's contract
// (mesh-writer.ts): top-level writes are delivered in commit order, and a write
// made during a delivery is nested, delivered at once inside it.

const AT = "2026-11-12T00:00:00.000Z";
const CAP = "understanding-write";

function record(id: string, parentId: string | null): ActorRecord {
  return { id, charter: id, parentId, status: "active", createdAt: AT };
}

describe("grant events and hooks in ordered writer delivery", () => {
  let db: Database.Database;
  let repos: Repositories;
  let writer: MeshObligationWriter;
  let mesh: ActorMesh;
  let log: string[];

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    repos = new Repositories(db);
    writer = createInProcessMeshWriter(db, repos.meshWriteRepos());
    for (const [id, parent] of [
      ["root", null],
      ["a", "root"],
      ["b", "root"],
    ] as const) {
      repos.actors.upsert(record(id, parent));
    }
    repos.capabilityGrants.grant({
      actorId: "root",
      capability: CAPABILITY_ADMIN_CAPABILITY,
      grantedBy: "test",
      grantedAt: AT,
    });
    log = [];
    mesh = new ActorMesh({
      actors: repos.actors,
      rootId: "root",
      capabilityGrants: repos.capabilityGrants,
      grantableCapabilities: new Set([CAP]),
      writer,
      events: (event) => {
        if (event.kind.startsWith("capability_")) log.push(`event:${event.kind}:${event.actorId}`);
      },
      onCapabilityGranted: (actorId) => log.push(`hook:granted:${actorId}`),
      onCapabilityRevoked: (actorId) => {
        log.push(`hook:revoked:${actorId}`);
      },
      now: () => AT,
      createActor: () => ({}) as unknown as Actor,
    });
  });

  afterEach(() => db.close());

  it("a grant's hook runs before a later write's ready-head delivery", async () => {
    repos.obligations.setReadyHeadListener((change) => {
      log.push(`ready-head:${change.ownerId}`);
    });
    const granting = mesh.grantCapability("a", CAP, "root");
    const creating = writer.write("obligations.create", {
      obligation: { ownerId: "a", title: "later" },
    });
    await Promise.all([granting, creating]);
    expect(log).toEqual(["event:capability_granted:a", "hook:granted:a", "ready-head:a"]);
  });

  it("a revoke's hook runs before a later write's ready-head delivery", async () => {
    repos.capabilityGrants.grant({
      actorId: "a",
      capability: CAP,
      grantedBy: "root",
      grantedAt: AT,
    });
    repos.obligations.setReadyHeadListener((change) => {
      log.push(`ready-head:${change.ownerId}`);
    });
    const revoking = mesh.revokeCapability("a", CAP, "root");
    const creating = writer.write("obligations.create", {
      obligation: { ownerId: "a", title: "later" },
    });
    await Promise.all([revoking, creating]);
    expect(log).toEqual(["event:capability_revoked:a", "hook:revoked:a", "ready-head:a"]);
  });

  it("a grant nested in an open delivery is announced inside it, before an earlier top-level grant", async () => {
    let release = () => {};
    const barrier = new Promise<void>((resolve) => (release = resolve));
    let nested: Promise<void> | undefined;
    repos.obligations.setReadyHeadListener(async () => {
      await barrier;
      // A write made inside the delivery is nested: delivered at once.
      nested = mesh.grantCapability("b", CAP, "root");
      await nested;
    });
    const holding = writer.write("obligations.create", {
      obligation: { ownerId: "root", title: "hold" },
    });
    // Commits now, before b; its delivery queues behind the open one.
    const topLevel = mesh.grantCapability("a", CAP, "root");
    expect(repos.capabilityGrants.activeFor("a")).toEqual([CAP]);
    expect(log).toEqual([]);
    release();
    await Promise.all([holding, topLevel]);
    await nested;
    // b is nested in the open delivery, so it is delivered there, ahead of a,
    // although a committed first. This is the documented nesting contract.
    expect(log).toEqual([
      "event:capability_granted:b",
      "hook:granted:b",
      "event:capability_granted:a",
      "hook:granted:a",
    ]);
  });
});
