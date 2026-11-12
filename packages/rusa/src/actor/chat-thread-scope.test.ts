import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInProcessMeshWriter,
  type MeshObligationWriter,
} from "../db/mesh-write-operations.js";
import { runMigrations } from "../db/migrations/runner.js";
import { Repositories } from "../db/repositories/index.js";
import { EventManager, HierarchicalEventSourceResolver } from "../runtime/event-manager.js";
import type { Actor } from "./actor.js";
import { ActorMesh } from "./actor-mesh.js";
import type { ActorRecord } from "./actor-record.js";
import { CAPABILITY_ADMIN_CAPABILITY } from "./administrative-capabilities.js";
import { parentOf } from "./event-subscriptions.js";

// Thread-scoped Google Chat write grants and thread delegation (#1311), on the
// real SQLite stores, in-process writer and routing kernel the daemon
// assembles, reopened from disk to show grants and routing are durable.

const AT = "2026-11-12T00:00:00.000Z";
const SPACE = "spaces/AAA";
const T1 = `${SPACE}/threads/T1`;
const T2 = `${SPACE}/threads/T2`;
const SPACE_WRITE = `chat-write:${SPACE}`;
const T1_WRITE = `chat-write:${T1}`;

function record(id: string, parentId: string | null): ActorRecord {
  return { id, charter: id, parentId, status: "active", createdAt: AT };
}

interface Host {
  db: Database.Database;
  repos: Repositories;
  writer: MeshObligationWriter;
  mesh: ActorMesh;
}

/** One daemon boot over the database at `path`: stores, writer, routing kernel, mesh. */
function boot(path: string): Host {
  const db = new Database(path);
  runMigrations(db);
  const repos = new Repositories(db);
  const writer = createInProcessMeshWriter(db, repos.meshWriteRepos());
  let mesh!: ActorMesh;
  const resolver = new HierarchicalEventSourceResolver({
    ports: {
      parentOf,
      isLive: (actorId) => mesh.isLiveActor(actorId),
      activeDelegationsFor: (resource) => repos.eventSourceOwners.activeForResource(resource),
      directSubscribersFor: (resource) => repos.eventSourceSubscriptions.subscribersOf(resource),
      eventSourceConfigFor: (resource) => repos.eventSourceOwners.getConfig(resource),
    },
  });
  mesh = new ActorMesh({
    actors: repos.actors,
    rootId: "root",
    capabilityGrants: repos.capabilityGrants,
    grantableCapabilities: new Set(["chat-write"]),
    writer,
    inboxStore: repos.inbox,
    eventSourceOwners: repos.eventSourceOwners,
    eventSourceSubscriptions: repos.eventSourceSubscriptions,
    eventManager: new EventManager({ inboxStore: repos.inbox, resolver }),
    now: () => AT,
    createActor: () => ({}) as unknown as Actor,
  });
  mesh.rehydrateAll();
  return { db, repos, writer, mesh };
}

/** A Google Chat message as the Chat source delivers it to the mesh. */
function chatMessage(message: string, thread: string) {
  return {
    sourceType: "chat" as const,
    rawPayload: {
      name: `${SPACE}/messages/${message}`,
      spaceName: SPACE,
      threadName: thread,
      senderName: "users/123",
      createTime: AT,
    },
  };
}

describe("thread-scoped Chat write grants and thread delegation (#1311)", () => {
  let dir: string;
  let path: string;
  let host: Host;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rusa-chat-thread-scope-"));
    path = join(dir, "mesh.db");
    const seed = new Database(path);
    runMigrations(seed);
    const repos = new Repositories(seed);
    // steward holds the whole space; worker is in another branch, not its child;
    // stranger holds another space; wildcard holds every space; helper is
    // steward's own child. Nobody here holds capability-admin.
    for (const [id, parent] of [
      ["root", null],
      ["steward", "root"],
      ["helper", "steward"],
      ["worker", "root"],
      ["watcher", "root"],
      ["stranger", "root"],
      ["wildcard", "root"],
    ] as const) {
      repos.actors.upsert(record(id, parent));
    }
    for (const [actorId, capability] of [
      ["steward", SPACE_WRITE],
      ["stranger", "chat-write:spaces/BBB"],
      ["wildcard", "chat-write:*"],
    ] as const) {
      repos.capabilityGrants.grant({ actorId, capability, grantedBy: "test", grantedAt: AT });
    }
    seed.close();
    host = boot(path);
  });

  afterEach(() => {
    host.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function grantAdmin(actorId: string): void {
    host.repos.capabilityGrants.grant({
      actorId,
      capability: CAPABILITY_ADMIN_CAPABILITY,
      grantedBy: "test",
      grantedAt: AT,
    });
  }

  function reboot(): Host {
    host.db.close();
    host = boot(path);
    return host;
  }

  describe("grant authority", () => {
    it("a space writer grants one of its threads to an actor outside its subtree", async () => {
      await host.mesh.grantCapability("worker", T1_WRITE, "steward");

      expect(host.mesh.activeCapabilitiesFor("worker")).toContain(T1_WRITE);
      expect(host.repos.capabilityGrants.list()).toContainEqual(
        expect.objectContaining({ actorId: "worker", capability: T1_WRITE, grantedBy: "steward" })
      );
      // The narrower grant confers nothing wider.
      expect(host.mesh.hasActiveCapability("worker", SPACE_WRITE)).toBe(false);
    });

    it("also accepts a legacy bare space id as the grantor's space write", async () => {
      host.repos.capabilityGrants.grant({
        actorId: "watcher",
        capability: "chat-write:AAA",
        grantedBy: "test",
        grantedAt: AT,
      });
      await host.mesh.grantCapability("worker", T1_WRITE, "watcher");
      expect(host.mesh.hasActiveCapability("worker", T1_WRITE)).toBe(true);
    });

    it("lets a chat-write:* holder grant a thread like a space holder", async () => {
      await host.mesh.grantCapability("worker", T1_WRITE, "wildcard");
      expect(host.mesh.hasActiveCapability("worker", T1_WRITE)).toBe(true);
      expect(host.mesh.hasActiveCapability("worker", SPACE_WRITE)).toBe(false);
      // Wildcard is never a whole space to hand on, and the grantee cannot re-grant.
      await expect(host.mesh.grantCapability("worker", SPACE_WRITE, "wildcard")).rejects.toThrow(
        /capability-admin/
      );
      await expect(host.mesh.grantCapability("watcher", T1_WRITE, "worker")).rejects.toThrow(
        /capability-admin/
      );

      // Nor does wildcard possession authorize revoking it.
      await expect(host.mesh.revokeCapability("worker", T1_WRITE, "wildcard")).rejects.toThrow(
        /capability-admin/
      );
      expect(host.mesh.hasActiveCapability("worker", T1_WRITE)).toBe(true);
    });

    it("refuses a thread grant from anyone not holding that space", async () => {
      await host.mesh.grantCapability("worker", T1_WRITE, "steward");

      for (const grantor of ["stranger", "worker", "helper"]) {
        await expect(
          host.mesh.grantCapability("watcher", T1_WRITE, grantor),
          `${grantor} must not grant ${T1_WRITE}`
        ).rejects.toThrow(/capability-admin/);
      }
      expect(host.mesh.hasActiveCapability("watcher", T1_WRITE)).toBe(false);
    });

    it("refuses a space writer widening a grantee to the whole space", async () => {
      await expect(host.mesh.grantCapability("worker", SPACE_WRITE, "steward")).rejects.toThrow(
        /capability-admin/
      );
      await expect(
        host.mesh.grantCapability("worker", "chat-write:spaces/BBB/threads/T1", "steward")
      ).rejects.toThrow(/capability-admin/);
    });

    it("refuses a malformed thread scope before deciding authority", async () => {
      for (const capability of [
        `chat-write:${SPACE}/threads/`,
        `chat-write:${T1}/messages/M1`,
        `chat-write:${SPACE}/threads`,
        "chat-write:threads/T1",
      ]) {
        await expect(
          host.mesh.grantCapability("worker", capability, "steward"),
          capability
        ).rejects.toThrow(/must name '\*', a space .* or one thread in it/);
      }
    });

    it("decides the grant inside the write, against the transaction's own grants", async () => {
      const write = (by: string) =>
        host.writer.write("grants.grant", {
          grant: { actorId: "worker", capability: T1_WRITE, grantedBy: by, grantedAt: AT },
          policy: null,
        });
      await write("steward");
      expect(host.repos.capabilityGrants.activeFor("worker")).toContain(T1_WRITE);

      host.repos.capabilityGrants.revoke("worker", T1_WRITE, AT);
      host.repos.capabilityGrants.revoke("steward", SPACE_WRITE, AT);
      await expect(write("steward")).rejects.toThrow(/capability-admin/);
      expect(host.repos.capabilityGrants.activeFor("worker")).not.toContain(T1_WRITE);
    });

    it("keeps the ordinary revoke authority: space possession does not revoke", async () => {
      await host.mesh.grantCapability("worker", T1_WRITE, "steward");

      // Not even the grantor's own grant: #1311 commissions granting only.
      for (const revoker of ["steward", "stranger", "worker"]) {
        await expect(
          host.mesh.revokeCapability("worker", T1_WRITE, revoker),
          `${revoker} must not revoke ${T1_WRITE}`
        ).rejects.toThrow(/capability-admin/);
      }
      expect(host.mesh.hasActiveCapability("worker", T1_WRITE)).toBe(true);

      // A capability-admin over the grantee revokes it as any other grant.
      grantAdmin("root");
      await host.mesh.revokeCapability("worker", T1_WRITE, "root");
      expect(host.mesh.hasActiveCapability("worker", T1_WRITE)).toBe(false);
    });

    it("keeps a thread grant after its grantor loses the space", async () => {
      await host.mesh.grantCapability("worker", T1_WRITE, "steward");
      host.repos.capabilityGrants.revoke("steward", SPACE_WRITE, AT);

      // As any grant outlives its grantor's authority; revoking it is explicit.
      expect(host.mesh.hasActiveCapability("worker", T1_WRITE)).toBe(true);
    });

    it("keeps a thread grant across a restart", async () => {
      await host.mesh.grantCapability("worker", T1_WRITE, "steward");

      const after = reboot();
      expect(after.mesh.activeCapabilitiesFor("worker")).toContain(T1_WRITE);
      // And it is still revocable through the ordinary path after the restart.
      grantAdmin("root");
      await after.mesh.revokeCapability("worker", T1_WRITE, "root");
      expect(after.mesh.hasActiveCapability("worker", T1_WRITE)).toBe(false);
    });
  });

  describe("thread delegation", () => {
    beforeEach(() => {
      host.mesh.subscribeEventSource(`gchat:${SPACE}`, "steward", "root");
      host.mesh.addEventSourceSubscriber(`gchat:${SPACE}`, "watcher", "root");
    });

    async function deliver(h: Host, message: string, thread: string) {
      const delivery = await h.mesh.deliverExternalEvent(chatMessage(message, thread));
      return {
        owners: delivery.ownerIds,
        subscribers: delivery.entries
          .filter((entry) => entry.payload.deliveryRole === "subscriber")
          .map((entry) => entry.actorId),
        sources: delivery.entries.map((entry) => entry.source),
      };
    }

    it("routes a delegated thread to its holder ahead of the space owner", async () => {
      host.mesh.delegateEventSource(`gchat:${T1}`, "worker", "steward");

      const inThread = await deliver(host, "R1", T1);
      expect(inThread.owners).toEqual(["worker"]);
      // A space subscriber still hears every thread of the space.
      expect(inThread.subscribers).toEqual(["watcher"]);
      expect(new Set(inThread.sources)).toEqual(new Set([`gchat:${T1}`]));

      // A sibling thread and a new top-level message stay with the space owner.
      expect((await deliver(host, "R2", T2)).owners).toEqual(["steward"]);
      expect((await deliver(host, "T3", `${SPACE}/threads/T3`)).owners).toEqual(["steward"]);
    });

    it("keeps thread routing across a restart, and reclaim returns it to the space owner", async () => {
      host.mesh.delegateEventSource(`gchat:${T1}`, "worker", "steward");

      const after = reboot();
      expect((await deliver(after, "R1", T1)).owners).toEqual(["worker"]);
      expect((await deliver(after, "R2", T2)).owners).toEqual(["steward"]);

      after.mesh.reclaimEventSource(`gchat:${T1}`, "steward");
      expect((await deliver(after, "R3", T1)).owners).toEqual(["steward"]);
    });

    it("lets only the effective owner delegate a thread", () => {
      for (const delegator of ["stranger", "worker", "wildcard"]) {
        expect(
          () => host.mesh.delegateEventSource(`gchat:${T1}`, "watcher", delegator),
          delegator
        ).toThrow(/not the current effective owner/);
      }
    });

    it("keeps routing and write authority separate", async () => {
      // Delegating a thread grants no write; granting a thread routes nothing.
      host.mesh.delegateEventSource(`gchat:${T1}`, "worker", "steward");
      await host.mesh.grantCapability("helper", `chat-write:${T2}`, "steward");

      expect(host.mesh.activeCapabilitiesFor("worker")).not.toContainEqual(
        expect.stringMatching(/^chat-write:/)
      );
      expect((await deliver(host, "R2", T2)).owners).toEqual(["steward"]);
    });
  });
});
