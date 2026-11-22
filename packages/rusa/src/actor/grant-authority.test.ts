import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInProcessMeshWriter } from "../db/mesh-write-operations.js";
import { runMigrations } from "../db/migrations/runner.js";
import { Repositories } from "../db/repositories/index.js";
import type { Actor } from "./actor.js";
import { ActorMesh } from "./actor-mesh.js";
import type { ActorRecord } from "./actor-record.js";
import { CAPABILITY_ADMIN_CAPABILITY } from "./administrative-capabilities.js";
import { assertGrantAuthority, type GrantAuthorityReader } from "./grant-authority.js";

const AT = "2026-11-22T00:00:00.000Z";
const ALICE_READ = "glass_goals:alice:read";
const ALICE_WRITE = "glass_goals:alice:write";
const BOB_WRITE = "glass_goals:bob:write";

function actorRecord(id: string, parentId: string | null): ActorRecord {
  return { id, charter: id, parentId, status: "active", createdAt: AT };
}

describe("assertGrantAuthority: parent-delegable glass_goals (#1344)", () => {
  function makeReader(
    actors: Record<string, { parentId: string | null }>,
    grants: Record<string, readonly { capability: string; grantedBy: string }[]>
  ): GrantAuthorityReader {
    return {
      actor: (id) => actors[id],
      capabilities: (id) => (grants[id] ?? []).map((g) => g.capability),
      activeGrants: (id) => grants[id] ?? [],
    };
  }

  const baseActors = {
    root: { parentId: null },
    steward: { parentId: "root" },
    sibling: { parentId: "root" },
    child: { parentId: "steward" },
    grandchild: { parentId: "child" },
    unrelated: { parentId: null },
  };

  it("allows a parent holding :write to grant :read and :write to a direct child", () => {
    const reader = makeReader(baseActors, {
      root: [{ capability: CAPABILITY_ADMIN_CAPABILITY, grantedBy: "root" }],
      steward: [{ capability: ALICE_WRITE, grantedBy: "root" }],
    });

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "steward",
        granteeId: "child",
        capability: ALICE_READ,
        verb: "grant",
      })
    ).not.toThrow();

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "steward",
        granteeId: "child",
        capability: ALICE_WRITE,
        verb: "grant",
      })
    ).not.toThrow();
  });

  it("allows a parent holding :read to grant :read, but refuses :write", () => {
    const reader = makeReader(baseActors, {
      root: [{ capability: CAPABILITY_ADMIN_CAPABILITY, grantedBy: "root" }],
      steward: [{ capability: ALICE_READ, grantedBy: "root" }],
    });

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "steward",
        granteeId: "child",
        capability: ALICE_READ,
        verb: "grant",
      })
    ).not.toThrow();

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "steward",
        granteeId: "child",
        capability: ALICE_WRITE,
        verb: "grant",
      })
    ).toThrow(/capability-admin/);
  });

  it("refuses a parent holding nothing or holding a different user", () => {
    const reader = makeReader(baseActors, {
      root: [{ capability: CAPABILITY_ADMIN_CAPABILITY, grantedBy: "root" }],
      steward: [{ capability: BOB_WRITE, grantedBy: "root" }],
      sibling: [],
    });

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "steward",
        granteeId: "child",
        capability: ALICE_READ,
        verb: "grant",
      })
    ).toThrow(/capability-admin/);

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "sibling",
        granteeId: "child",
        capability: ALICE_READ,
        verb: "grant",
      })
    ).toThrow(/capability-admin/);
  });

  it("refuses grants to a grandchild, sibling, or unrelated actor", () => {
    const reader = makeReader(baseActors, {
      root: [{ capability: CAPABILITY_ADMIN_CAPABILITY, grantedBy: "root" }],
      steward: [{ capability: ALICE_WRITE, grantedBy: "root" }],
    });

    for (const granteeId of ["grandchild", "sibling", "unrelated"]) {
      expect(() =>
        assertGrantAuthority(reader, {
          grantorId: "steward",
          granteeId,
          capability: ALICE_READ,
          verb: "grant",
        })
      ).toThrow(/capability-admin|direct children/);
    }
  });

  it("allows the holding parent to revoke from a direct child and refuses a non-holder", () => {
    const reader = makeReader(baseActors, {
      root: [{ capability: CAPABILITY_ADMIN_CAPABILITY, grantedBy: "root" }],
      steward: [{ capability: ALICE_WRITE, grantedBy: "root" }],
      sibling: [],
    });

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "steward",
        granteeId: "child",
        capability: ALICE_READ,
        verb: "revoke",
      })
    ).not.toThrow();

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "steward",
        granteeId: "child",
        capability: ALICE_WRITE,
        verb: "revoke",
      })
    ).not.toThrow();

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "sibling",
        granteeId: "child",
        capability: ALICE_READ,
        verb: "revoke",
      })
    ).toThrow(/capability-admin/);
  });

  it("refuses transitive re-delegation by a child that received glass_goals from a non-admin parent", () => {
    const reader = makeReader(baseActors, {
      root: [{ capability: CAPABILITY_ADMIN_CAPABILITY, grantedBy: "root" }],
      steward: [{ capability: ALICE_WRITE, grantedBy: "root" }],
      child: [{ capability: ALICE_WRITE, grantedBy: "steward" }],
    });

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "child",
        granteeId: "grandchild",
        capability: ALICE_READ,
        verb: "grant",
      })
    ).toThrow(/capability-admin/);
  });

  it("keeps refusal for computer-use, whole-space chat-write, and other custom servers", () => {
    const reader = makeReader(baseActors, {
      root: [{ capability: CAPABILITY_ADMIN_CAPABILITY, grantedBy: "root" }],
      steward: [
        { capability: "computer-use", grantedBy: "root" },
        { capability: "chat-write:spaces/AAA", grantedBy: "root" },
        { capability: "other_server:alice:write", grantedBy: "root" },
      ],
    });

    for (const capability of [
      "computer-use",
      "chat-write:spaces/AAA",
      "other_server:alice:read",
      "other_server:alice:write",
    ]) {
      expect(() =>
        assertGrantAuthority(reader, {
          grantorId: "steward",
          granteeId: "child",
          capability,
          verb: "grant",
        })
      ).toThrow(/capability-admin/);
    }
  });
});

describe("ActorMesh grantCapability/revokeCapability: parent-delegable glass_goals (#1344)", () => {
  let dir: string;
  let db: Database.Database;
  let repos: Repositories;
  let mesh: ActorMesh;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rusa-glass-goals-delegation-"));
    db = new Database(join(dir, "mesh.db"));
    runMigrations(db);
    repos = new Repositories(db);
    for (const [id, parent] of [
      ["root", null],
      ["steward", "root"],
      ["sibling", "root"],
      ["child", "steward"],
      ["grandchild", "child"],
    ] as const) {
      repos.actors.upsert(actorRecord(id, parent));
    }
    repos.capabilityGrants.grant({
      actorId: "root",
      capability: CAPABILITY_ADMIN_CAPABILITY,
      grantedBy: "root",
      grantedAt: AT,
    });
    repos.capabilityGrants.grant({
      actorId: "steward",
      capability: ALICE_WRITE,
      grantedBy: "root",
      grantedAt: AT,
    });

    const writer = createInProcessMeshWriter(db, repos.meshWriteRepos());
    mesh = new ActorMesh({
      actors: repos.actors,
      rootId: "root",
      capabilityGrants: repos.capabilityGrants,
      grantableCapabilities: new Set(["glass_goals", "computer-use", "chat-write", "other_server"]),
      customMcpUserIds: new Map([
        ["glass_goals", "alice"],
        ["other_server", "alice"],
      ]),
      writer,
      now: () => AT,
      createActor: () => ({}) as unknown as Actor,
    });
    mesh.rehydrateAll();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("grants and revokes glass_goals on a direct child, blocks transitive re-grant, and keeps child grant when parent loses its own", async () => {
    await mesh.grantCapability("child", ALICE_READ, "steward");
    await mesh.grantCapability("child", ALICE_WRITE, "steward");
    expect(repos.capabilityGrants.activeFor("child")).toEqual([ALICE_READ, ALICE_WRITE]);

    // Non-transitive: child cannot re-grant to grandchild.
    await expect(mesh.grantCapability("grandchild", ALICE_READ, "child")).rejects.toThrow(
      /capability-admin/
    );

    // Direct child only: steward cannot grant to grandchild or sibling.
    await expect(mesh.grantCapability("grandchild", ALICE_READ, "steward")).rejects.toThrow(
      /capability-admin|direct children/
    );
    await expect(mesh.grantCapability("sibling", ALICE_READ, "steward")).rejects.toThrow(
      /capability-admin|direct children/
    );

    // Parent revokes from direct child.
    await mesh.revokeCapability("child", ALICE_WRITE, "steward");
    expect(repos.capabilityGrants.activeFor("child")).toEqual([ALICE_READ]);

    // Parent loses its own capability: child's existing grant persists, and parent can no longer revoke it.
    await mesh.revokeCapability("steward", ALICE_WRITE, "root");
    expect(repos.capabilityGrants.activeFor("child")).toEqual([ALICE_READ]);
    await expect(mesh.revokeCapability("child", ALICE_READ, "steward")).rejects.toThrow(
      /capability-admin/
    );
  });
});
