import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ActorMesh, type MeshActor } from "../actor/actor-mesh.js";
import {
  ACTOR_ADMIN_CAPABILITY,
  ADMINISTRATIVE_CAPABILITIES,
  seedConfiguredActorGrants,
} from "../actor/administrative-capabilities.js";
import { InMemoryCapabilityGrantStore } from "../actor/capability-grants.js";
import { runMigrations } from "../db/migrations/runner.js";
import { DbEventSourceOwnerStore } from "../db/repositories/event-source-owner-repository.js";
import { DbEventSourceSubscriptionStore } from "../db/repositories/event-source-subscription-repository.js";
import { SqliteActorRepository } from "../db/repositories/sqlite-actor-repository.js";
import { createAgentExecMcpServer } from "./agent-exec-mcp.js";

type OwnerEntry = {
  actorId: string;
  resource: string;
  unsubscribedAt?: string | null;
};

type SubEntry = {
  actorId: string;
  resource: string;
};

describe("list_subscriptions performance and event loop safety (#687)", () => {
  it("proves the synchronous bottleneck on a production-sized fixture", async () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const actorRepo = new SqliteActorRepository(db);
    const ownerStore = new DbEventSourceOwnerStore(db);
    const subStore = new DbEventSourceSubscriptionStore(db);
    const capabilityGrants = new InMemoryCapabilityGrantStore();

    seedConfiguredActorGrants(capabilityGrants, "root", () => "2026-01-01T00:00:00Z");

    // 1. Setup actors: root -> stewards -> workers
    actorRepo.upsert({
      id: "root",
      charter: "root",
      parentId: null,
      isRoot: true,
      status: "active",
      createdAt: new Date().toISOString(),
    });

    const stewards = ["steward-1", "steward-2", "steward-3"];
    for (const s of stewards) {
      actorRepo.upsert({
        id: s,
        charter: s,
        parentId: "root",
        status: "active",
        createdAt: new Date().toISOString(),
      });
    }

    const workers: string[] = [];
    for (let i = 0; i < 50; i++) {
      const w = `worker-${i}`;
      workers.push(w);
      actorRepo.upsert({
        id: w,
        charter: w,
        parentId: stewards[i % stewards.length],
        status: i < 30 ? "retired" : "active",
        createdAt: new Date().toISOString(),
      });
    }

    // 2. Populate mesh_chat with 5,000 rows (simulating production chat log)
    const insertChat = db.prepare(
      "INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id) VALUES (?, ?, ?, ?, ?, ?)"
    );
    db.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        const recipient = i % 2 === 0 ? "root" : workers[i % workers.length];
        insertChat.run(
          `chat-${i}`,
          new Date(Date.now() - (5000 - i) * 1000).toISOString(),
          "human:operator",
          recipient,
          `Hello ${i}`,
          `session-${i % 10}`
        );
      }
    })();

    // 3. Populate 990 event source owners (matching prod row count)
    for (let i = 0; i < 990; i++) {
      const actorId = i < 300 ? "root" : workers[i % workers.length];
      const isUnsubscribed = i % 3 === 0;
      const resource = `github:MEK-Org/rusa/issues/${i + 1}`;
      ownerStore.subscribe({
        resource,
        actorId,
        subscribedBy: "root",
        subscribedAt: new Date(Date.now() - 100000).toISOString(),
      });
      if (isUnsubscribed) {
        ownerStore.unsubscribe(resource, actorId, new Date().toISOString());
      }
    }

    // 4. Populate 166 event source subscriptions (matching prod row count)
    for (let i = 0; i < 166; i++) {
      const actorId = workers[i % workers.length];
      subStore.subscribe({
        resource: `github:MEK-Org/rusa/pulls/${i + 1}`,
        actorId,
        subscribedBy: "root",
        subscribedAt: new Date().toISOString(),
      });
    }

    const mesh = new ActorMesh({
      actors: actorRepo,
      rootId: "root",
      eventSourceOwners: ownerStore,
      eventSourceSubscriptions: subStore,
      capabilityGrants,
      grantableCapabilities: new Set(ADMINISTRATIVE_CAPABILITIES),
      createActor: () =>
        ({
          dispatch: () => true,
          close: () => {},
          retire: () => {},
        }) as unknown as MeshActor,
    });

    const server = createAgentExecMcpServer(mesh, "root", "root");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    let getCallCount = 0;
    const origGet = actorRepo.get.bind(actorRepo);
    actorRepo.get = (id: string) => {
      getCallCount++;
      return origGet(id);
    };

    const t0 = performance.now();
    const res = (await client.callTool({
      name: "list_subscriptions",
      arguments: {},
    })) as CallToolResult;
    const elapsed = performance.now() - t0;

    console.log(
      `[PERF PROOF] list_subscriptions elapsed: ${elapsed.toFixed(1)} ms, actorRepo.get calls: ${getCallCount}`
    );

    expect(res.isError).toBeFalsy();
    expect(getCallCount).toBe(0);
    const data = JSON.parse((res.content[0] as { type: "text"; text: string }).text) as {
      owners: OwnerEntry[];
      subscribers: SubEntry[];
    };
    expect(data.owners).toHaveLength(990);
    expect(data.subscribers).toHaveLength(166);

    // Verify tombstones are included
    const tombstones = data.owners.filter((o) => o.unsubscribedAt);
    expect(tombstones.length).toBeGreaterThan(0);
  });

  it("preserves subtree filtering and tombstone semantics for non-root caller", async () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const actorRepo = new SqliteActorRepository(db);
    const ownerStore = new DbEventSourceOwnerStore(db);
    const subStore = new DbEventSourceSubscriptionStore(db);
    const capabilityGrants = new InMemoryCapabilityGrantStore();

    seedConfiguredActorGrants(capabilityGrants, "root", () => "2026-01-01T00:00:00Z");
    capabilityGrants.grant({
      actorId: "steward-1",
      capability: ACTOR_ADMIN_CAPABILITY,
      grantedBy: "root",
      grantedAt: "2026-01-01T00:00:00Z",
    });

    actorRepo.upsert({
      id: "root",
      charter: "root",
      parentId: null,
      isRoot: true,
      status: "active",
      createdAt: new Date().toISOString(),
    });

    actorRepo.upsert({
      id: "steward-1",
      charter: "steward-1",
      parentId: "root",
      status: "active",
      createdAt: new Date().toISOString(),
    });

    actorRepo.upsert({
      id: "steward-2",
      charter: "steward-2",
      parentId: "root",
      status: "active",
      createdAt: new Date().toISOString(),
    });

    actorRepo.upsert({
      id: "worker-s1",
      charter: "worker-s1",
      parentId: "steward-1",
      status: "active",
      createdAt: new Date().toISOString(),
    });

    actorRepo.upsert({
      id: "worker-s2",
      charter: "worker-s2",
      parentId: "steward-2",
      status: "active",
      createdAt: new Date().toISOString(),
    });

    // Subscriptions:
    // 1. root claim
    ownerStore.subscribe({
      resource: "github:MEK-Org/rusa/issues/1",
      actorId: "root",
      subscribedBy: "root",
      subscribedAt: new Date().toISOString(),
    });
    // 2. steward-1 claim
    ownerStore.subscribe({
      resource: "github:MEK-Org/rusa/issues/2",
      actorId: "steward-1",
      subscribedBy: "root",
      subscribedAt: new Date().toISOString(),
    });
    // 3. worker-s1 claim (active)
    ownerStore.subscribe({
      resource: "github:MEK-Org/rusa/issues/3",
      actorId: "worker-s1",
      subscribedBy: "steward-1",
      subscribedAt: new Date().toISOString(),
    });
    // 4. worker-s1 tombstone
    ownerStore.subscribe({
      resource: "github:MEK-Org/rusa/issues/4",
      actorId: "worker-s1",
      subscribedBy: "steward-1",
      subscribedAt: new Date().toISOString(),
    });
    ownerStore.unsubscribe("github:MEK-Org/rusa/issues/4", "worker-s1", new Date().toISOString());
    // 5. steward-2 claim (outside steward-1 subtree)
    ownerStore.subscribe({
      resource: "github:MEK-Org/rusa/issues/5",
      actorId: "steward-2",
      subscribedBy: "root",
      subscribedAt: new Date().toISOString(),
    });
    // 6. worker-s2 claim (outside steward-1 subtree)
    ownerStore.subscribe({
      resource: "github:MEK-Org/rusa/issues/6",
      actorId: "worker-s2",
      subscribedBy: "steward-2",
      subscribedAt: new Date().toISOString(),
    });

    // Direct subscribers:
    subStore.subscribe({
      resource: "github:MEK-Org/rusa/pulls/1",
      actorId: "worker-s1",
      subscribedBy: "steward-1",
      subscribedAt: new Date().toISOString(),
    });
    subStore.subscribe({
      resource: "github:MEK-Org/rusa/pulls/2",
      actorId: "worker-s2",
      subscribedBy: "steward-2",
      subscribedAt: new Date().toISOString(),
    });

    const mesh = new ActorMesh({
      actors: actorRepo,
      rootId: "root",
      eventSourceOwners: ownerStore,
      eventSourceSubscriptions: subStore,
      capabilityGrants,
      grantableCapabilities: new Set(ADMINISTRATIVE_CAPABILITIES),
      createActor: () =>
        ({
          dispatch: () => true,
          close: () => {},
          retire: () => {},
        }) as unknown as MeshActor,
    });

    // Call list_subscriptions as steward-1
    const server = createAgentExecMcpServer(mesh, "steward-1", "root");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const res = (await client.callTool({
      name: "list_subscriptions",
      arguments: {},
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content[0] as { type: "text"; text: string }).text) as {
      owners: OwnerEntry[];
      subscribers: SubEntry[];
    };

    // Only steward-1 and worker-s1 rows are returned; root, steward-2, worker-s2 are filtered out
    const ownerActorIds = data.owners.map((o) => o.actorId);
    expect(ownerActorIds).toContain("steward-1");
    expect(ownerActorIds).toContain("worker-s1");
    expect(ownerActorIds).not.toContain("root");
    expect(ownerActorIds).not.toContain("steward-2");
    expect(ownerActorIds).not.toContain("worker-s2");

    // Both active claim and tombstone for worker-s1 must be present
    const s1Issues = data.owners.map((o) => o.resource);
    expect(s1Issues).toContain("github:MEK-Org/rusa/issues/3");
    expect(s1Issues).toContain("github:MEK-Org/rusa/issues/4");

    // Subscriber for worker-s1 is returned, worker-s2 is filtered out
    const subscriberActorIds = data.subscribers.map((s) => s.actorId);
    expect(subscriberActorIds).toEqual(["worker-s1"]);
  });
});
