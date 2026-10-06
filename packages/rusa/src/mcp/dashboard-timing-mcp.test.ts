import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
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
      clientServerCoverage: { clientRequestIds: 0, serverRequestIds: 1, matchedRequestIds: 0 },
      requestCoverage: {
        correlation: { numerator: 0, denominator: 0, state: "no-referenced-request" as const },
        measurement: { numerator: 0, denominator: 0, state: "no-referenced-request" as const },
      },
      pairedRequestDurations: {
        sampleCount: 0,
        clientRequestMs: { p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null },
        serverDurationMs: { p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null },
      },
      groups: [],
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

  it("refuses an arbitrary label rather than exposing unbounded data", async () => {
    const client = await connect(createDashboardTimingMcpServer({ summary: vi.fn() }));
    const result = (await client.callTool({
      name: "dashboard_timing_summary",
      arguments: { label: "raw_url" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
  });
});
