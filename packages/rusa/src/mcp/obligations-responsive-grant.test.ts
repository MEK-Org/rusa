import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ActorMesh } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import {
  ACTOR_ADMIN_CAPABILITY,
  ADMINISTRATIVE_CAPABILITIES,
  CAPABILITY_ADMIN_CAPABILITY,
  seedConfiguredActorGrants,
} from "../actor/administrative-capabilities.js";
import { InMemoryCapabilityGrantStore } from "../actor/capability-grants.js";
import { runMigrations } from "../db/migrations/runner.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { canManageObligation } from "../obligations/owner.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import { createObligationsMcpServer, OBLIGATION_RESPONSIVE_CAPABILITY } from "./obligations-mcp.js";

/**
 * #1026: starting a responsive branch is an explicitly grantable capability.
 * The worker server below uses the same two authorization options start.ts
 * composes (owner resolution and event hooks are omitted), so these tests
 * exercise the real grant store → mesh → tool authorization path: a
 * `capability-admin` holder grants or revokes the row, and the tool consults
 * it on every call.
 */

function record(id: string, parentId: string | null): ActorRecord {
  return {
    id,
    charter: id,
    parentId,
    ...(parentId === null ? { executionConfig: { unsandboxed: true } } : {}),
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function setup() {
  const actors = new InMemoryActorRepository();
  const grants = new InMemoryCapabilityGrantStore();
  const mesh = new ActorMesh({
    actors,
    rootId: "configured",
    capabilityGrants: grants,
    grantableCapabilities: new Set([
      "understanding-write",
      OBLIGATION_RESPONSIVE_CAPABILITY,
      ...ADMINISTRATIVE_CAPABILITIES,
    ]),
    now: () => "2026-01-01T00:00:00Z",
    createActor: (ctx) => ({
      id: ctx.record.id,
      requestRun: () => {},
      markUnkillable: () => {},
      close: () => {},
      preemptForResponsive: () => ({ preempted: false }),
      isRunning: false,
    }),
  });
  actors.upsert(record("configured", null));
  actors.upsert(record("steward", "configured"));
  actors.upsert(record("steward-child", "steward"));
  actors.upsert(record("sibling", "configured"));
  seedConfiguredActorGrants(grants, "configured", () => "2026-01-01T00:00:00Z");

  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const repository = new ObligationRepository(db);

  const workerServer = (id: string) =>
    createObligationsMcpServer(repository, id, {
      canManage: (callerId, obligation) =>
        canManageObligation(callerId, obligation, mesh.isAncestorOf.bind(mesh)),
      canSetResponsive: () => mesh.hasActiveCapability(id, OBLIGATION_RESPONSIVE_CAPABILITY),
    });
  return { db, mesh, repository, workerServer };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function errorText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return JSON.stringify(result.content);
}

describe("grantable responsive-obligation authority (#1026)", () => {
  it("is granted and revoked by a capability-admin holder and by no one else", async () => {
    const { mesh } = setup();
    expect(mesh.hasActiveCapability("steward", OBLIGATION_RESPONSIVE_CAPABILITY)).toBe(false);

    // A parent without capability-admin cannot hand it to its own child…
    expect(() =>
      mesh.grantCapability("steward-child", OBLIGATION_RESPONSIVE_CAPABILITY, "steward")
    ).toThrow(/capability-admin/);

    mesh.grantCapability("steward", OBLIGATION_RESPONSIVE_CAPABILITY, "configured");
    expect(mesh.hasActiveCapability("steward", OBLIGATION_RESPONSIVE_CAPABILITY)).toBe(true);

    // …and holding it confers no grant authority or other administration.
    expect(() =>
      mesh.grantCapability("steward-child", OBLIGATION_RESPONSIVE_CAPABILITY, "steward")
    ).toThrow(/capability-admin/);
    expect(mesh.hasActiveCapability("steward", CAPABILITY_ADMIN_CAPABILITY)).toBe(false);
    expect(mesh.hasActiveCapability("steward", ACTOR_ADMIN_CAPABILITY)).toBe(false);
    expect(mesh.activeCapabilitiesFor("steward")).toEqual([OBLIGATION_RESPONSIVE_CAPABILITY]);

    await mesh.revokeCapability("steward", OBLIGATION_RESPONSIVE_CAPABILITY, "configured");
    expect(mesh.hasActiveCapability("steward", OBLIGATION_RESPONSIVE_CAPABILITY)).toBe(false);
  });

  it("lets a granted actor create and mark responsive work, and stops the moment it is revoked", async () => {
    const { db, mesh, repository, workerServer } = setup();
    const ordinary = repository.create({ ownerId: "steward", title: "ordinary" });
    const child = repository.create({
      ownerId: "steward",
      title: "child",
      parentId: ordinary.id,
    });
    const loose = repository.create({ ownerId: "steward", title: "loose" });
    // One live session across grant and revoke: authority is read per call.
    const steward = await connect(workerServer("steward"));

    const beforeGrant = db.serialize();
    expect(
      errorText(
        await call(steward, "create_obligation", {
          owner_id: "steward",
          title: "urgent",
          responsive: true,
        })
      )
    ).toContain(OBLIGATION_RESPONSIVE_CAPABILITY);
    expect(
      errorText(await call(steward, "mark_obligation_responsive", { id: ordinary.id }))
    ).toContain(OBLIGATION_RESPONSIVE_CAPABILITY);
    expect(db.serialize().equals(beforeGrant)).toBe(true);

    mesh.grantCapability("steward", OBLIGATION_RESPONSIVE_CAPABILITY, "configured");

    const created = await call(steward, "create_obligation", {
      owner_id: "steward",
      title: "urgent",
      responsive: true,
    });
    expect(created.isError).toBeFalsy();
    const { obligation: urgent } = JSON.parse(
      (created.content as Array<{ text: string }>)[0]?.text ?? "{}"
    );
    expect(urgent).toMatchObject({ responsive: true, effectiveResponsive: true });

    const marked = await call(steward, "mark_obligation_responsive", { id: ordinary.id });
    expect(marked.isError).toBeFalsy();
    expect(repository.require(ordinary.id)).toMatchObject({ responsive: true });
    expect(repository.require(child.id).effectiveResponsive).toBe(true);

    // Reparenting ordinary work under a responsive branch is a promotion too.
    expect(
      (await call(steward, "reparent_obligation", { id: loose.id, parent_id: urgent.id })).isError
    ).toBeFalsy();
    expect(repository.require(loose.id).effectiveResponsive).toBe(true);

    await mesh.revokeCapability("steward", OBLIGATION_RESPONSIVE_CAPABILITY, "configured");

    const later = repository.create({ ownerId: "steward", title: "later" });
    const afterRevoke = db.serialize();
    expect(
      errorText(
        await call(steward, "create_obligation", {
          owner_id: "steward",
          title: "urgent again",
          responsive: true,
        })
      )
    ).toContain(OBLIGATION_RESPONSIVE_CAPABILITY);
    expect(
      errorText(await call(steward, "mark_obligation_responsive", { id: later.id }))
    ).toContain(OBLIGATION_RESPONSIVE_CAPABILITY);
    expect(
      errorText(await call(steward, "reparent_obligation", { id: later.id, parent_id: urgent.id }))
    ).toContain(OBLIGATION_RESPONSIVE_CAPABILITY);
    expect(db.serialize().equals(afterRevoke)).toBe(true);
  });

  it("keeps ordinary ownership boundaries for a granted actor", async () => {
    const { db, mesh, repository, workerServer } = setup();
    mesh.grantCapability("steward", OBLIGATION_RESPONSIVE_CAPABILITY, "configured");
    const descendants = repository.create({ ownerId: "steward-child", title: "descendant's" });
    const siblings = repository.create({ ownerId: "sibling", title: "sibling's" });
    const ownBranch = repository.create({ ownerId: "steward", title: "own", responsive: true });
    const steward = await connect(workerServer("steward"));

    const before = db.serialize();
    expect(
      errorText(await call(steward, "mark_obligation_responsive", { id: siblings.id }))
    ).toMatch(/not authorized/);
    expect(
      errorText(await call(steward, "set_checkpoint", { id: siblings.id, checkpoint: "mine now" }))
    ).toMatch(/not authorized/);
    // The grant reaches neither a new responsive branch for an owner it cannot
    // manage, nor a promotion of that owner's work under its own branch.
    expect(
      errorText(
        await call(steward, "create_obligation", {
          owner_id: "sibling",
          title: "for sibling",
          responsive: true,
        })
      )
    ).toMatch(/not authorized/);
    expect(
      errorText(
        await call(steward, "reparent_obligation", { id: siblings.id, parent_id: ownBranch.id })
      )
    ).toMatch(/not authorized/);
    expect(db.serialize().equals(before)).toBe(true);
    expect(repository.require(siblings.id).effectiveResponsive).toBe(false);

    // Work it already manages through ownership ancestry stays in reach.
    expect(
      (await call(steward, "mark_obligation_responsive", { id: descendants.id })).isError
    ).toBeFalsy();
    expect(repository.require(descendants.id).effectiveResponsive).toBe(true);
    expect(
      (
        await call(steward, "create_obligation", {
          owner_id: "steward-child",
          title: "for child",
          responsive: true,
        })
      ).isError
    ).toBeFalsy();
  });

  it("leaves ungranted actors with the existing restriction and inherited responsiveness", async () => {
    const { db, mesh, repository, workerServer } = setup();
    mesh.grantCapability("steward", OBLIGATION_RESPONSIVE_CAPABILITY, "configured");
    const urgent = repository.create({
      ownerId: "steward-child",
      title: "urgent",
      responsive: true,
    });
    const ordinary = repository.create({ ownerId: "steward-child", title: "ordinary" });
    // The grant is per actor: a granted parent confers nothing on its child.
    const worker = await connect(workerServer("steward-child"));

    for (const responsive of [undefined, true]) {
      const result = await call(worker, "create_obligation", {
        owner_id: "steward-child",
        title: "inherits",
        parent_id: urgent.id,
        responsive,
      });
      expect(result.isError).toBeFalsy();
    }

    const before = db.serialize();
    expect(
      errorText(
        await call(worker, "create_obligation", {
          owner_id: "steward-child",
          title: "promotion",
          parent_id: ordinary.id,
          responsive: true,
        })
      )
    ).toContain("only root");
    expect(
      errorText(await call(worker, "mark_obligation_responsive", { id: ordinary.id }))
    ).toContain("only root");
    expect(
      errorText(
        await call(worker, "reparent_obligation", { id: ordinary.id, parent_id: urgent.id })
      )
    ).toContain("only root");
    expect(db.serialize().equals(before)).toBe(true);
  });

  it("leaves inherited filing and reassignment to unmanaged owners as they were", async () => {
    // Scope (a): the authority gates starting or promoting a branch only. The
    // existing delegation paths keep their own authorization, even when the
    // owner receiving responsive attention is one the caller cannot manage.
    const { repository, workerServer } = setup();
    const urgent = repository.create({
      ownerId: "steward-child",
      title: "urgent",
      responsive: true,
    });
    const handoff = repository.create({
      ownerId: "steward-child",
      title: "handoff",
      parentId: urgent.id,
    });
    const worker = await connect(workerServer("steward-child"));

    const filed = await call(worker, "create_obligation", {
      owner_id: "sibling",
      title: "for sibling",
      parent_id: urgent.id,
    });
    expect(filed.isError).toBeFalsy();
    const { obligation } = JSON.parse((filed.content as Array<{ text: string }>)[0]?.text ?? "{}");
    expect(repository.require(obligation.id)).toMatchObject({
      ownerId: "sibling",
      effectiveResponsive: true,
    });

    const moved = await call(worker, "reassign_obligation", {
      id: handoff.id,
      owner_id: "sibling",
    });
    expect(moved.isError).toBeFalsy();
    expect(repository.require(handoff.id)).toMatchObject({
      ownerId: "sibling",
      effectiveResponsive: true,
    });
  });
});
