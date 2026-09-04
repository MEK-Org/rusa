import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import {
  createStuckLoopDetectorMcpServer,
  STUCK_LOOP_DETECTOR_MCP_NAME,
} from "./stuck-loop-detector-mcp.js";

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function dataOf(result: CallToolResult): unknown {
  const first = result.content[0];
  const text = first && first.type === "text" ? first.text : "";
  return JSON.parse(text);
}

describe("stuck-loop-detector MCP", () => {
  it("exposes list_open_commitments as the read-only projection tool", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const meshEvents = new MeshEventRepository(db);
    const registry = new InMemoryActorRepository();
    registry.upsert({
      id: "worker-1",
      charter: "worker",
      parentId: "steward",
      status: "active",
      createdAt: "2026-06-30T10:00:00.000Z",
    });
    meshEvents.record({
      kind: "run_yielded",
      actorId: "worker-1",
      detail: "blocked",
      body: "in progress\nWaiting-on: steward retire",
      ts: "2026-06-29T23:00:00.000Z",
      id: "yield-note",
    });
    meshEvents.record({
      kind: "run_start",
      actorId: "worker-1",
      ts: "2026-06-30T00:00:00.000Z",
      id: "start-1",
    });
    meshEvents.record({
      kind: "run_end",
      actorId: "worker-1",
      success: false,
      ts: "2026-06-30T00:30:00.000Z",
      id: "run-end-1",
    });

    const client = await connect(
      createStuckLoopDetectorMcpServer({ actors: registry, meshEvents })
    );
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["list_open_commitments"]);
    expect(tools[0].description).toContain("commitment-ledger rows");

    const result = (await client.callTool({
      name: "list_open_commitments",
      arguments: {
        now: "2026-06-30T12:00:00.000Z",
        min_confidence: 0.8,
        owner_actor_id: "steward",
        thresholds_minutes: { failed_run: 60 },
      },
    })) as CallToolResult;

    const report = dataOf(result) as {
      rows: {
        kind: string;
        owner_actor_id: string;
        subject_actor_id: string;
        source_artifact_ref: string;
        waiting_on: string;
        owner_expects_retirement: boolean | null;
      }[];
    };
    expect(report.rows).toEqual([
      expect.objectContaining({
        kind: "failed_run",
        owner_actor_id: "steward",
        subject_actor_id: "worker-1",
        source_artifact_ref: "run-end-1",
        waiting_on: "steward retire",
        owner_expects_retirement: null,
      }),
    ]);
  });

  it("lists message-tracked Operator-ask commitments through the MCP edge", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const meshEvents = new MeshEventRepository(db);
    const registry = new InMemoryActorRepository();
    meshEvents.record({
      id: "issue-531-tracking",
      kind: "message_sent",
      actorId: "root",
      body: "Tracking: Operator ask: can we mark an issue complete? | owner=root | done-when=an issue closed",
      ts: "2026-06-30T18:40:00.000Z",
    });

    const client = await connect(
      createStuckLoopDetectorMcpServer({ actors: registry, meshEvents })
    );
    const result = (await client.callTool({
      name: "list_open_commitments",
      arguments: {
        now: "2026-07-01T22:10:00.000Z",
      },
    })) as CallToolResult;

    const report = dataOf(result) as {
      rows: {
        kind: string;
        owner_actor_id: string;
        subject_actor_id: string;
        source_artifact_type: string;
        source_artifact_ref: string;
        confidence: number;
      }[];
    };
    expect(report.rows).toEqual([
      expect.objectContaining({
        kind: "request_commitment",
        owner_actor_id: "root",
        subject_actor_id: "Operator ask: can we mark an issue complete?",
        source_artifact_type: "message",
        source_artifact_ref: "issue-531-tracking",
        confidence: 1,
      }),
    ]);
  });

  it("resolves owner=<configured root handle> to root when rootHandle is threaded in ", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const meshEvents = new MeshEventRepository(db);
    const registry = new InMemoryActorRepository();
    meshEvents.record({
      id: "issue-664-tracking",
      kind: "message_sent",
      actorId: "root",
      body: "Tracking: Operator ask: staging identity check | owner=ember-familiar | done-when=configured handle resolved",
      ts: "2026-06-30T18:40:00.000Z",
    });

    const client = await connect(
      createStuckLoopDetectorMcpServer({
        actors: registry,
        meshEvents,
        rootHandle: "ember-familiar",
      })
    );
    const result = (await client.callTool({
      name: "list_open_commitments",
      arguments: { now: "2026-07-01T22:10:00.000Z" },
    })) as CallToolResult;

    const report = dataOf(result) as { rows: { owner_actor_id: string }[] };
    expect(report.rows).toEqual([expect.objectContaining({ owner_actor_id: "root" })]);
  });

  it("uses the expected server name for shared internal-ops wiring", () => {
    expect(STUCK_LOOP_DETECTOR_MCP_NAME).toBe("stuck-loop-detector");
  });
});
