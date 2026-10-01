import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { QuotaCoordinatorClient } from "../quota/coordinator-client.js";
import { isProviderScopedWindow } from "../quota/window-scope.js";
import type { ProviderQuotaSnapshot, QuotaLimit } from "./quota-mcp.js";
import { toolError } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const QUOTA_MANUAL_MCP_NAME = "quota-manual";

export interface QuotaManualMcpDeps {
  /** The leader's coordinator client; `null` when no coordinator socket is configured. */
  client: Pick<QuotaCoordinatorClient, "postManualReading"> | null;
}

/**
 * The replay key for one reading. A retried call for the same reading carries
 * the same key, so the coordinator answers `duplicate: true` instead of
 * counting it twice; a different reading at the same instant is an
 * `idempotency_conflict` the coordinator reports.
 */
export function manualReadingIdempotencyKey(
  provider: string,
  generation: number,
  observedAt: string
): string {
  return `manual-reading:${provider}:${generation}:${observedAt}`;
}

/**
 * The snapshot status the route requires, derived the way a scrape derives it
 * (`quota-mcp.ts`): exhausted when any provider-wide window shows nothing
 * left, available otherwise. A model-scoped window at zero does not mark the
 * whole provider exhausted. The caller states only the windows it read.
 */
export function manualReadingStatus(limits: readonly QuotaLimit[]): "available" | "exhausted" {
  return limits.some((limit) => isProviderScopedWindow(limit) && limit.percentLeft <= 0)
    ? "exhausted"
    : "available";
}

const limitSchema = z.object({
  label: z.string().describe('The row label as the source shows it, e.g. "Weekly".'),
  kind: z.enum(["session", "five_hour", "weekly", "other"]).optional(),
  percentLeft: z.number().describe("Percentage of the limit still available (0-100)."),
  resetAtIso: z.string().optional().describe("ISO-8601 instant the window resets, if shown."),
  scope: z
    .object({ provider: z.string(), models: z.array(z.string()).optional() })
    .optional()
    .describe("Omit for a provider-wide window."),
});

/**
 * The `quota-manual` grantable capability (#690): lets the actor that takes a
 * manual quota reading submit it in the same run, so the manual loop needs one
 * paced admission instead of two. It runs in the leader, which holds the
 * coordinator socket; a follower-hosted grantee reaches it through the
 * follower hub's per-actor MCP proxy like any other leader endpoint.
 *
 * It only writes. The coordinator owns acceptance: the tool passes `observedAt`
 * through as the reading's `scrapedAt` untouched and returns the service's
 * envelope verbatim, so a stale, out-of-mode, or superseded-generation reading
 * is refused by the coordinator rather than filtered here.
 */
export function createQuotaManualServer(
  deps: QuotaManualMcpDeps,
  options?: { isFenced?: () => boolean }
): McpServer {
  const server = createMcpServer(
    { name: QUOTA_MANUAL_MCP_NAME, version: "0.1.0" },
    { isFenced: options?.isFenced }
  );

  server.registerTool(
    "submit_manual_reading",
    {
      title: "Submit a manual quota reading",
      description:
        "Submit one quota reading you took yourself to the quota coordinator, for a provider the operator has put in manual reading mode. Call it in the same run that took the reading. observedAt is when you read the source, never when you call this. Returns the coordinator's response unchanged: an accepted reading, a duplicate replay, or a refusal such as stale_observation, manual_mode_required or mode_generation_mismatch.",
      inputSchema: {
        provider: z.string().min(1).describe('Provider id, e.g. "kimi".'),
        generation: z
          .number()
          .int()
          .describe("The generation the reading-mode switch to manual returned."),
        observedAt: z
          .string()
          .min(1)
          .max(64)
          .describe("ISO-8601 instant you read the source, e.g. 2026-10-01T11:51:42Z."),
        limits: z.array(limitSchema).min(1).describe("Every window the source shows."),
      },
    },
    async ({ provider, generation, observedAt, limits }): Promise<CallToolResult> => {
      if (!deps.client) {
        return toolError("No quota coordinator is configured on this instance");
      }
      const snapshot: ProviderQuotaSnapshot = {
        provider,
        status: manualReadingStatus(limits),
        scrapedAt: observedAt,
        limits,
      };
      const result = await deps.client.postManualReading({
        provider,
        generation,
        snapshot,
        idempotencyKey: manualReadingIdempotencyKey(provider, generation, observedAt),
      });
      if (!result.reached) {
        return toolError(`Quota coordinator unreachable: ${result.error}`);
      }
      return {
        ...(result.statusCode === 200 ? {} : { isError: true }),
        content: [{ type: "text", text: result.body }],
      };
    }
  );

  return server;
}
