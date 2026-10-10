import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type DashboardTimingRecorder, isDashboardTimingLabel } from "../dashboard/timing.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const DASHBOARD_TIMING_MCP_NAME = "dashboard-timing";

/**
 * Read-only aggregate dashboard timing surface. Raw timing rows and their
 * correlation UUIDs intentionally remain in the private durable log.
 */
export function createDashboardTimingMcpServer(
  timings: Pick<DashboardTimingRecorder, "summary">
): McpServer {
  const server = createMcpServer({ name: DASHBOARD_TIMING_MCP_NAME, version: "0.1.0" });
  server.registerTool(
    "dashboard_timing_summary",
    {
      title: "Summarize dashboard timing",
      description:
        "Read content-free dashboard timing aggregates for a 1h–7d window. Returns percentiles, status/outcome buckets, exact-ID correlation and paired request/server coverage, and measured server phases (auth, route, enrichment, serialization, compression) with per-phase coverage. Phases overlap and are never summed; absent phases were not measured. serverPopulations splits server requests by label, operation and method into finished success (<400), finished failure (>=400) and closed-before-finish (abort, client timeout or network drop, indistinguishable), each with its own count and percentiles; method and closedBeforeFinish are unknown for rows recorded before that split existed. window reports the rows actually read against the request: capReached means older rows in the window were not counted, retentionLimited means the window reaches the retention horizon, so its earliest rows may have been pruned. groups, serverPhases, pairing and coverage count finished responses only. Never returns raw telemetry rows or identifiers.",
      inputSchema: {
        hours: z
          .number()
          .int()
          .min(1)
          .max(7 * 24)
          .default(24),
        label: z.string().optional(),
      },
    },
    async ({ hours, label }) => {
      if (label !== undefined && !isDashboardTimingLabel(label)) {
        return toolError(
          new Error("label must be one of the documented fixed dashboard timing labels")
        );
      }
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      return toolOk(timings.summary({ since, ...(label ? { label } : {}) }));
    }
  );
  return server;
}
