import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardTimingRecorder } from "../dashboard/timing.js";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import { createDashboardTimingMcpServer } from "./dashboard-timing-mcp.js";

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("dashboard timing MCP", () => {
  it("returns aggregate-only timing summaries for a fixed label", async () => {
    const summary = vi.fn(() => ({
      since: "2026-10-05T11:00:00.000Z",
      sampleCount: 1,
      droppedSinceStart: 0,
      clientServerCoverage: {
        clientRequestIds: 0,
        serverRequestIds: 0,
        matchedRequestIds: 0,
      },
      requestCoverage: {
        correlation: { numerator: 0, denominator: 0, state: "no-referenced-request" as const },
        measurement: { numerator: 0, denominator: 0, state: "no-referenced-request" as const },
      },
      pairedRequestDurations: [],
      serverPhases: [],
      serverPopulations: [],
      groups: [],
      window: {
        requestedSince: "2026-10-05T10:00:00.000Z",
        oldestRecordAt: null,
        newestRecordAt: null,
        recordsRead: 0,
        readCap: 20_000,
        capReached: false,
        retentionMs: 7 * 24 * 60 * 60 * 1000,
        retentionLimited: false,
        unreadableRecords: 0,
      },
    }));
    const client = await connect(createDashboardTimingMcpServer({ summary }));

    const result = (await client.callTool({
      name: "dashboard_timing_summary",
      arguments: { hours: 2, label: "mesh_threads" },
    })) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(summary).toHaveBeenCalledWith(
      expect.objectContaining({ label: "mesh_threads", since: expect.any(Date) })
    );
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("sampleCount"),
    });
  });

  describe("retention boundary (#990)", () => {
    afterEach(() => vi.useRealTimers());

    const retentionLimited = async (hours: number, readLagMs: number) => {
      vi.useFakeTimers({ now: new Date("2026-10-10T12:00:00.000Z"), toFake: ["Date"] });
      const db = new Database(":memory:");
      runMigrations(db);
      // The recorder reads its clock a moment after the tool computes `since`.
      const recorder = new DashboardTimingRecorder(
        new MeshEventRepository(db),
        () => new Date(Date.now() + readLagMs)
      );
      const client = await connect(createDashboardTimingMcpServer(recorder));
      const result = (await client.callTool({
        name: "dashboard_timing_summary",
        arguments: { hours },
      })) as CallToolResult;
      db.close();
      const text = (result.content[0] as { text: string }).text;
      return JSON.parse(text).window.retentionLimited as boolean;
    };

    it("flags a full-retention request whether or not the clock moved between reads", async () => {
      expect(await retentionLimited(168, 0)).toBe(true);
      expect(await retentionLimited(168, 5)).toBe(true);
    });

    it("does not flag a request an hour inside retention", async () => {
      expect(await retentionLimited(167, 0)).toBe(false);
      expect(await retentionLimited(167, 5)).toBe(false);
    });
  });

  it("refuses an arbitrary label rather than exposing unbounded data", async () => {
    const client = await connect(createDashboardTimingMcpServer({ summary: vi.fn() }));
    const result = (await client.callTool({
      name: "dashboard_timing_summary",
      arguments: { label: "raw_url" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
  });
});
