import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ThreadRegistry } from "../actor/thread-registry.js";
import type { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import {
  COMMITMENT_LEDGER_BODY_KINDS,
  COMMITMENT_LEDGER_KINDS,
  type CommitmentThresholds,
  DEFAULT_COMMITMENT_THRESHOLDS,
  projectOpenCommitments,
} from "../observability/commitment-ledger.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const STUCK_LOOP_DETECTOR_MCP_NAME = "stuck-loop-detector";

export interface StuckLoopDetectorDeps {
  registry: ThreadRegistry;
  meshEvents: MeshEventRepository;
  /** This instance's configured root display handle ; see `projectOpenCommitments`. */
  rootHandle?: string;
}

const CommitmentThresholdMinutesSchema = z
  .object({
    failed_run: z.number().nonnegative().optional(),
    missed_wake: z.number().nonnegative().optional(),
    silent_actor: z.number().nonnegative().optional(),
  })
  .optional();

/**
 * Read-only internal-ops MCP exposing the commitment-ledger projection. Keep
 * the query logic in `observability/` so sibling non-human ops surfaces can
 * reuse the same pattern: deterministic core, thin MCP edge.
 */
export function createStuckLoopDetectorMcpServer(
  deps: StuckLoopDetectorDeps,
  options?: { isFenced?: () => boolean }
): McpServer {
  const server = createMcpServer(
    { name: STUCK_LOOP_DETECTOR_MCP_NAME, version: "0.1.0" },
    { isFenced: options?.isFenced }
  );

  server.registerTool(
    "list_open_commitments",
    {
      title: "List open mesh commitments",
      description:
        "Return open commitment-ledger rows projected in memory from mesh_events plus threads.json, including owner, source artifact, confidence, waiting-on, and retirement expectation.",
      inputSchema: {
        now: z
          .string()
          .datetime()
          .optional()
          .describe("ISO timestamp to evaluate against; defaults to the current time."),
        min_confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Minimum confidence to return; defaults to the projection policy."),
        owner_actor_id: z
          .string()
          .optional()
          .describe("Only return rows owned by this actor id or display handle."),
        thresholds_minutes: CommitmentThresholdMinutesSchema.describe(
          "Optional per-rule threshold overrides in minutes."
        ),
      },
    },
    async ({ now, min_confidence, owner_actor_id, thresholds_minutes }) => {
      try {
        return toolOk(
          projectOpenCommitments({
            threads: deps.registry.list(),
            events: deps.meshEvents.listByKinds(COMMITMENT_LEDGER_KINDS, {
              bodyKinds: COMMITMENT_LEDGER_BODY_KINDS,
            }),
            now: now ? new Date(now) : undefined,
            minConfidence: min_confidence,
            ownerActorId: owner_actor_id,
            thresholds: toCommitmentThresholds(thresholds_minutes),
            rootHandle: deps.rootHandle,
          })
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}

function toCommitmentThresholds(
  minutes: z.infer<typeof CommitmentThresholdMinutesSchema>
): Partial<CommitmentThresholds> | undefined {
  if (!minutes) return undefined;
  return {
    failedRunMs:
      minutes.failed_run == null
        ? DEFAULT_COMMITMENT_THRESHOLDS.failedRunMs
        : minutes.failed_run * 60_000,
    missedWakeMs:
      minutes.missed_wake == null
        ? DEFAULT_COMMITMENT_THRESHOLDS.missedWakeMs
        : minutes.missed_wake * 60_000,
    silentActorMs:
      minutes.silent_actor == null
        ? DEFAULT_COMMITMENT_THRESHOLDS.silentActorMs
        : minutes.silent_actor * 60_000,
  };
}
