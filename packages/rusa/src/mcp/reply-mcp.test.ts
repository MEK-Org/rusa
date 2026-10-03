import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Actor } from "../actor/actor.js";
import { ActorMesh } from "../actor/actor-mesh.js";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import { PrincipalRepository } from "../db/repositories/principal-repository.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import { createAgentExecMcpServer } from "./agent-exec-mcp.js";
import { HUMAN_OPERATOR } from "./stamp.js";

function testHumanId(mesh: ActorMesh): string {
  const user = mesh.principals?.listUsers()[0];
  if (!user) throw new Error("missing synthetic durable user");
  return user.id;
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function setupTestMesh() {
  const registry = new InMemoryActorRepository();
  const db = new Database(":memory:");
  runMigrations(db);
  const principals = new PrincipalRepository(db);
  const inboxStore = new SqliteInboxRepository(db);
  const chatStore = new MeshChatRepository(db);
  principals.ensureImplicitUser("2026-01-01T00:00:00Z");
  onTestFinished(() => {
    db.close();
  });
  const recordedEvents: {
    kind: string;
    actorId?: string;
    detail?: string;
    body?: string;
  }[] = [];
  const mesh = new ActorMesh({
    principals,
    inboxStore,
    recordChat: (entry) => chatStore.record(entry),
    actors: registry,
    events: (e) => recordedEvents.push(e),
    grantableCapabilities: new Set(),
    idgen: () => "id",
    now: () => "2026-07-05T00:00:00Z",
    createActor: () => ({}) as unknown as Actor,
  });

  // Adopt standard active threads
  registry.upsert({
    id: "actor-A",
    charter: "A",
    parentId: null,
    status: "active",
    createdAt: "2026-07-05T00:00:00Z",
  });
  registry.upsert({
    id: "actor-B",
    charter: "B",
    parentId: null,
    status: "active",
    createdAt: "2026-07-05T00:00:00Z",
  });

  return { registry, mesh, inboxStore, recordedEvents };
}

describe("Mesh Chat Security Invariant Tests", () => {
  describe("Negative Test #1: Provenance Invariant Lock", () => {
    it("throws if mesh.sendMessage is called directly with a human: prefix in fromId", () => {
      const { mesh } = setupTestMesh();
      expect(() => {
        mesh.sendMessage("actor-A", "hello", HUMAN_OPERATOR);
      }).toThrow(
        /Invalid sender ID: actor-facing send path structurally cannot claim human origin/
      );
    });

    it("rejects sending message if the actor-facing server has a human selfId (tool boundary check)", async () => {
      const { mesh } = setupTestMesh();
      // Even if someone managed to construct a server with selfId="human:operator"
      const server = createAgentExecMcpServer(mesh, HUMAN_OPERATOR, "root");
      const client = await connect(server);

      const res = (await client.callTool({
        name: "send_message",
        arguments: { thread_id: "actor-A", body: "spoofed" },
      })) as CallToolResult;

      expect(res.isError).toBe(true);
      const textObj = res.content[0];
      expect(textObj.type === "text" ? textObj.text : "").toContain(
        "actor-facing send path structurally cannot claim human origin"
      );
    });
  });

  describe("Negative Test #2: Reply Tool Scoped by Mount/Construction", () => {
    it("hides the reply tool until the operator has pinged the actor, and scopes reply to the actor's thread", async () => {
      const { mesh, inboxStore, recordedEvents } = setupTestMesh();

      // Before human messages actor-A, its server has no reply tool
      const serverBefore = createAgentExecMcpServer(mesh, "actor-A", "root");
      const clientBefore = await connect(serverBefore);
      const { tools: toolsBefore } = await clientBefore.listTools();
      expect(toolsBefore.map((t) => t.name)).not.toContain("reply");

      const actor = mesh.actors.get("actor-A");
      if (!actor) throw new Error("missing synthetic actor");
      mesh.adopt(actor, {
        id: "actor-A",
        requestRun: () => {},
        markUnkillable: () => {},
        close: () => {},
        isRunning: false,
        preemptForResponsive: () => ({ preempted: false as const }),
      } as unknown as Actor);
      expect(
        mesh.sendHumanMessage("actor-A", "operator ping", "session-XYZ", {
          fromId: testHumanId(mesh),
        }).delivered
      ).toBe(true);
      const [input] = inboxStore.list("actor-A").entries;
      if (!input) throw new Error("missing accepted human input");

      // Now the server should have the reply tool
      const serverAfter = createAgentExecMcpServer(mesh, "actor-A", "root");
      const clientAfter = await connect(serverAfter);
      const { tools: toolsAfter } = await clientAfter.listTools();
      expect(toolsAfter.map((t) => t.name)).toContain("reply");

      // Verify input schema has no session/thread ID parameter
      const replyTool = toolsAfter.find((t) => t.name === "reply");
      expect(replyTool).toBeDefined();
      if (!replyTool) throw new Error("Reply tool not found");
      expect(replyTool.inputSchema.properties?.sessionId).toBeUndefined();
      expect(replyTool.inputSchema.properties?.session_id).toBeUndefined();
      expect(replyTool.inputSchema.properties?.threadId).toBeUndefined();

      // Clear recorded events to verify only the reply event
      recordedEvents.length = 0;

      const missingRef = (await clientAfter.callTool({
        name: "reply",
        arguments: { message: "unbound reply" },
      })) as CallToolResult;
      expect(missingRef.isError).toBe(true);
      expect(recordedEvents).toHaveLength(0);

      // Call reply tool on actor-A and verify the recorded event
      const res = (await clientAfter.callTool({
        name: "reply",
        arguments: { message: "reply from actor-A", input_ref: input.id },
      })) as CallToolResult;

      expect(res.isError).toBeFalsy();
      expect(recordedEvents).toHaveLength(2);
      expect(recordedEvents[0]).toMatchObject({
        kind: "message_sent",
        actorId: "actor-A",
      });
      expect(recordedEvents[1]).toMatchObject({
        kind: "message_received",
        actorId: testHumanId(mesh),
      });

      // Verify actor-B (who was never pinged) still does not have the reply tool
      const serverB = createAgentExecMcpServer(mesh, "actor-B", "root");
      const clientB = await connect(serverB);
      const { tools: toolsB } = await clientB.listTools();
      expect(toolsB.map((t) => t.name)).not.toContain("reply");
    });
  });
});
