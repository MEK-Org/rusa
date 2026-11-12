import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../actor/actor.js";
import { ActorMesh } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import { CAPABILITY_ADMIN_CAPABILITY } from "../actor/administrative-capabilities.js";
import {
  createInProcessMeshWriter,
  type MeshObligationWriter,
} from "../db/mesh-write-operations.js";
import { runMigrations } from "../db/migrations/runner.js";
import { Repositories } from "../db/repositories/index.js";
import {
  type GrantableServerFactory,
  handleCapabilityRevoked,
  mountGrantedServers,
} from "./grantable-servers.js";
import { McpHttpServer } from "./http-server.js";
import { toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

// #1309 review (Seat 2 Q1), #1289 D1: a revocation's unmount hook runs in its
// writer effect delivery, so it waits behind an earlier write's open delivery
// while the revocation is already durable. This holds such a delivery open on
// the real in-process writer, revokes through the mesh with start.ts's revoke
// wiring, and asks the actual mounted endpoint whether it still serves in that
// window. Admission is decided per request against the actor's effective
// capabilities, so the endpoint refuses before the hook runs. A request
// already running is not cancelled, and this is not a worker-path proof.
//
// The hold stands in for a delivery that awaits real time: in-process today
// every awaited listener settles without I/O, so the hold is what makes the
// window reachable by an HTTP request here (as under the worker at F).

const AT = "2026-11-12T00:00:00.000Z";
const CAPABILITY = "understanding-write";
/** A fixture parameterized capability: one endpoint for every granted scope. */
const SCOPED = "fixture-scoped";

function record(id: string, parentId: string | null): ActorRecord {
  return { id, charter: id, parentId, status: "active", createdAt: AT };
}

describe("a revoked grant's mounted endpoint while an earlier delivery is open (#1309)", () => {
  let db: Database.Database;
  let repos: Repositories;
  let writer: MeshObligationWriter;
  let http: McpHttpServer;
  let mesh: ActorMesh;
  let pingCalls: number;
  let hookEntered: boolean;
  let releaseDelivery: () => void;
  let delivering: Promise<void>;
  let grantableServers: Map<string, GrantableServerFactory>;
  const clients: Client[] = [];

  beforeEach(async () => {
    db = new Database(":memory:");
    runMigrations(db);
    repos = new Repositories(db);
    writer = createInProcessMeshWriter(db, repos.meshWriteRepos());
    repos.actors.upsert(record("root", null));
    repos.actors.upsert(record("worker", "root"));
    repos.capabilityGrants.grant({
      actorId: "root",
      capability: CAPABILITY_ADMIN_CAPABILITY,
      grantedBy: "test",
      grantedAt: AT,
    });
    repos.capabilityGrants.grant({
      actorId: "worker",
      capability: CAPABILITY,
      grantedBy: "root",
      grantedAt: AT,
    });

    pingCalls = 0;
    hookEntered = false;
    grantableServers = new Map<string, GrantableServerFactory>();
    // A fixture server under a real grantable capability name; the endpoint,
    // its routing and its teardown are McpHttpServer's own.
    grantableServers.set(CAPABILITY, () => {
      const server = createMcpServer({ name: "fixture", version: "0.0.0" });
      server.registerTool("ping", { inputSchema: {} }, async () => {
        pingCalls += 1;
        return toolOk({ pong: true });
      });
      return server;
    });
    grantableServers.set(SCOPED, (_actorId, params) => {
      const server = createMcpServer({ name: "scoped-fixture", version: "0.0.0" });
      server.registerTool("scopes", { inputSchema: {} }, async () => toolOk({ scopes: params }));
      return server;
    });
    http = new McpHttpServer({ servers: {} });
    await http.start();

    mesh = new ActorMesh({
      actors: repos.actors,
      rootId: "root",
      capabilityGrants: repos.capabilityGrants,
      grantableCapabilities: new Set([CAPABILITY]),
      writer,
      now: () => AT,
      createActor: () => ({}) as unknown as Actor,
      // start.ts's wiring, less the next-run config refresh.
      onCapabilityRevoked: async (actorId, capability) => {
        hookEntered = true;
        await handleCapabilityRevoked(
          actorId,
          capability,
          () => mesh.activeCapabilitiesFor(actorId),
          grantableServers,
          http
        );
      },
    });

    // An earlier top-level write whose delivery stays open: the worker's
    // ready head changes, and the ready-head listener awaits a barrier.
    const barrier = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let listenerEntered = false;
    repos.obligations.setReadyHeadListener(async () => {
      listenerEntered = true;
      await barrier;
    });
    delivering = writer
      .write("obligations.create", { obligation: { ownerId: "worker", title: "earlier" } })
      .then(() => undefined);
    expect(listenerEntered).toBe(true);
  });

  afterEach(async () => {
    releaseDelivery();
    await delivering;
    for (const client of clients.splice(0)) await client.close().catch(() => {});
    await http.close();
    db.close();
  });

  async function connect(url: string): Promise<Client> {
    const client = new Client({ name: "probe", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    clients.push(client);
    return client;
  }

  async function ping(client: Client): Promise<CallToolResult> {
    return (await client.callTool({ name: "ping", arguments: {} })) as CallToolResult;
  }

  /** Mount the worker's granted endpoints as start.ts does; returns `name`'s URL. */
  function mount(name = CAPABILITY): string {
    const spec = mountGrantedServers(
      "worker",
      () => mesh.activeCapabilitiesFor("worker"),
      grantableServers,
      http
    ).find((candidate) => candidate.name === name);
    if (!spec) throw new Error(`${name} not mounted`);
    return spec.url;
  }

  async function scopes(client: Client): Promise<unknown> {
    const result = (await client.callTool({ name: "scopes", arguments: {} })) as CallToolResult;
    return result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text);
  }

  it("refuses a new session once the revocation is durable, before the hook runs", async () => {
    const url = mount();
    const revoking = mesh.revokeCapability("worker", CAPABILITY, "root");
    // The commit is synchronous: durable before the caller resumes.
    expect(repos.capabilityGrants.activeFor("worker")).toEqual([]);
    // Let any microtask continuation run; the delivery is still held.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hookEntered).toBe(false);

    await expect(connect(url)).rejects.toThrow();
    expect(pingCalls).toBe(0);

    releaseDelivery();
    await revoking;
    expect(hookEntered).toBe(true);
  });

  it("refuses a call on a session opened before the revocation, before the hook runs", async () => {
    const url = mount();
    const open = await connect(url);
    expect((await ping(open)).isError).toBeFalsy();
    expect(pingCalls).toBe(1);

    const revoking = mesh.revokeCapability("worker", CAPABILITY, "root");
    expect(repos.capabilityGrants.activeFor("worker")).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hookEntered).toBe(false);

    await expect(ping(open)).rejects.toThrow();
    expect(pingCalls).toBe(1);

    releaseDelivery();
    await revoking;
    expect(hookEntered).toBe(true);
  });

  it("refuses stale broader authority on a parameterized endpoint, then serves only the kept scope", async () => {
    for (const scope of ["A", "B"]) {
      repos.capabilityGrants.grant({
        actorId: "worker",
        capability: `${SCOPED}:${scope}`,
        grantedBy: "root",
        grantedAt: AT,
      });
    }
    const url = mount(SCOPED);
    const open = await connect(url);
    expect(await scopes(open)).toEqual({ scopes: ["A", "B"] });

    const revoking = mesh.revokeCapability("worker", `${SCOPED}:B`, "root");
    expect(mesh.activeCapabilitiesFor("worker")).toContain(`${SCOPED}:A`);
    expect(mesh.activeCapabilitiesFor("worker")).not.toContain(`${SCOPED}:B`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hookEntered).toBe(false);

    // The endpoint was built from A and B; B is gone, so neither the open
    // session nor a new one may use it until the hook re-mounts it narrowed.
    await expect(scopes(open)).rejects.toThrow();
    await expect(connect(url)).rejects.toThrow();

    // A refresh mounts the same name again from the A-only view before the
    // hook runs (a nested grant's refresh does this). It keeps the path and
    // the open session, whose server was built from A and B, so that session
    // stays refused; a session opened after the refresh is built from A alone.
    expect(mount(SCOPED)).toBe(url);
    await expect(scopes(open)).rejects.toThrow();
    const refreshed = await connect(url);
    expect(await scopes(refreshed)).toEqual({ scopes: ["A"] });

    releaseDelivery();
    await revoking;
    expect(hookEntered).toBe(true);

    // The hook re-mounted it from A alone under a fresh path (start.ts then
    // refreshes the actor's config); the broader endpoint's path stays dead.
    await expect(connect(url)).rejects.toThrow();
    const narrowedUrl = http.urlFor(`worker:${SCOPED}`);
    expect(narrowedUrl).not.toBe(url);
    const narrowed = await connect(narrowedUrl);
    expect(await scopes(narrowed)).toEqual({ scopes: ["A"] });

    // The narrowed mount refuses in turn once A is revoked, before its hook.
    let releaseAgain = () => {};
    const heldAgain = new Promise<void>((resolve) => {
      releaseAgain = resolve;
    });
    let heldAgainEntered = false;
    repos.obligations.setReadyHeadListener(async () => {
      heldAgainEntered = true;
      await heldAgain;
    });
    // root's ready head changes; the worker's already has one.
    const holdingAgain = writer.write("obligations.create", {
      obligation: { ownerId: "root", title: "earlier again" },
    });
    expect(heldAgainEntered).toBe(true);
    hookEntered = false;
    const revokingA = mesh.revokeCapability("worker", `${SCOPED}:A`, "root");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hookEntered).toBe(false);
    await expect(scopes(narrowed)).rejects.toThrow();
    releaseAgain();
    await Promise.all([holdingAgain, revokingA]);
    expect(hookEntered).toBe(true);
  });
});
