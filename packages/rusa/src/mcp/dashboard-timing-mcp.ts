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
        "Read content-free dashboard timing aggregates for a 1h–7d window. Returns percentiles, status/outcome buckets and client/server correlation coverage; never raw telemetry rows or identifiers.",
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
