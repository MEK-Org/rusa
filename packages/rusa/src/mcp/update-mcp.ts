import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MaintenanceShutdownCoordinator } from "../update/maintenance-shutdown.js";
import {
  executeUpdate,
  shortSha,
  type UpdateDeps,
  type UpdatePlan,
  type UpdateResult,
} from "../update/orchestrator.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const UPDATE_MCP_NAME = "update";

export interface UpdateToolDeps {
  plan: UpdatePlan;
  deps: UpdateDeps;
  /**
   * Whether `actorId` currently holds `capability` as an active grant. The
   * `update` tool runs only for a holder of the capability named after this
   * server ({@link UPDATE_MCP_NAME}); no actor id or topology stands in for it.
   */
  hasCapability: (actorId: string, capability: string) => boolean;
  /** Shared maintenance shutdown coordinator (#1225). */
  maintenanceShutdown: MaintenanceShutdownCoordinator;
}

export interface UpdateToolOutcome {
  ok: boolean;
  message: string;
  result?: UpdateResult;
}

export interface ShutdownToolOutcome {
  ok: boolean;
  message: string;
}

/**
 * The `update` tool body, factored out so the capability guard + orchestration
 * are unit-testable without the MCP transport.
 *
 * Grant-gated (#549): self-update bounces the whole daemon, so only an actor
 * holding the `update` capability may trigger it. The server is mounted through
 * the grantable-server composition for exactly the actors that hold that grant;
 * this live check is the belt-and-suspenders second layer, matching the
 * per-endpoint identity model — `selfId` is the unspoofable endpoint identity,
 * not a tool argument — and it is what makes a revocation fail closed on an
 * already-open session. A caller without the grant is refused before any side
 * effect.
 */
export async function runUpdateTool(
  toolDeps: UpdateToolDeps,
  selfId: string
): Promise<UpdateToolOutcome> {
  if (!toolDeps.hasCapability(selfId, UPDATE_MCP_NAME)) {
    return {
      ok: false,
      message: `'update' requires the '${UPDATE_MCP_NAME}' capability — refusing to run it for '${selfId}'.`,
    };
  }
  if (toolDeps.maintenanceShutdown.isPending()) {
    return {
      ok: false,
      message: "A maintenance shutdown is currently in progress — refusing update.",
    };
  }
  const result = await executeUpdate(toolDeps.plan, toolDeps.deps);
  if (result.restarting) {
    // The process is exiting; this response may never reach root (the daemon dies
    // and systemd restarts). Returned for completeness + tests.
    return {
      ok: true,
      message: `Build green @ ${shortSha(result.newSha ?? "")} (${result.subject ?? ""}). Drained and exiting — systemd will restart onto the new code.`,
      result,
    };
  }
  return {
    ok: false,
    message: `❌ update failed at ${result.failedStep}${result.timedOut ? " (timed out)" : ""}: ${result.error} — still running the previous build.`,
    result,
  };
}

/**
 * Standalone graceful drain and shutdown maintenance request without pulling or
 * building code (#1225).
 *
 * Grant-gated identically to `update`: only holders of the `update` capability
 * may trigger maintenance shutdown.
 */
export async function runShutdownTool(
  toolDeps: UpdateToolDeps,
  selfId: string,
  opts?: { timeoutSeconds?: number; reason?: string }
): Promise<ShutdownToolOutcome> {
  if (!toolDeps.hasCapability(selfId, UPDATE_MCP_NAME)) {
    return {
      ok: false,
      message: `'shutdown' requires the '${UPDATE_MCP_NAME}' capability — refusing to run it for '${selfId}'.`,
    };
  }
  const outcome = await toolDeps.maintenanceShutdown.request({
    timeoutSeconds: opts?.timeoutSeconds,
    reason: opts?.reason,
  });
  return {
    ok: outcome.ok,
    message: outcome.message,
  };
}

/**
 * Cancel a pending graceful shutdown request, lifting the admission brake and
 * resuming normal execution (#1225).
 */
export function runCancelShutdownTool(
  toolDeps: UpdateToolDeps,
  selfId: string,
  reason?: string
): ShutdownToolOutcome {
  if (!toolDeps.hasCapability(selfId, UPDATE_MCP_NAME)) {
    return {
      ok: false,
      message: `'cancel_shutdown' requires the '${UPDATE_MCP_NAME}' capability — refusing to run it for '${selfId}'.`,
    };
  }
  const outcome = toolDeps.maintenanceShutdown.cancel(reason);
  return {
    ok: outcome.ok,
    message: outcome.message,
  };
}

/**
 * In-process MCP server exposing host maintenance operations:
 * - `update`: pull, build, drain, and restart (existing)
 * - `shutdown`: graceful drain and shutdown for maintenance without pulling/rebuilding (#1225)
 * - `cancel_shutdown`: cancel a pending graceful shutdown request (#1225)
 *
 * **One instance per granted actor**, with `selfId` baked into the endpoint
 * (like every mesh endpoint), so "who is acting" is unspoofable.
 */
export function createUpdateMcpServer(toolDeps: UpdateToolDeps, selfId: string): McpServer {
  const server = createMcpServer({ name: UPDATE_MCP_NAME, version: "0.1.0" });

  server.registerTool(
    "update",
    {
      title: `Update & restart onto the latest ${toolDeps.plan.branch}`,
      description: `Redeploy this running system to the latest origin/${toolDeps.plan.branch}: pull, install, and build IN PLACE (the mesh stays live and responsive throughout), and ONLY if the build is fully green, drain in-flight runs and restart onto the fresh code. A failed or hung build aborts safely and leaves the current build running — you get the error back. Use this to make a freshly-merged change go live. Requires the 'update' capability. Authorized by the master merge.`,
      inputSchema: {},
    },
    async () => {
      try {
        const outcome = await runUpdateTool(toolDeps, selfId);
        return outcome.ok ? toolOk(outcome.message) : toolError(outcome.message);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "shutdown",
    {
      title: "Graceful drain and shutdown",
      description:
        "Gracefully quiesce and shut down the mesh for maintenance (e.g. config-only restart). Stops admitting new runs, emits a notification to the configured error chat, allows active in-flight runs to finish, and shuts down the process once drained. Does not pull git or rebuild code. Preserves operator HALT state. Requires the 'update' capability. Note: under the production systemd unit (Restart=always), a clean exit (code 0) triggers an immediate service restart.",
      inputSchema: {
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .max(3600)
          .optional()
          .describe(
            "Maximum seconds to wait for active runs to finish before cancelling shutdown (default: 300, max: 3600)"
          ),
        reason: z
          .string()
          .optional()
          .describe(
            "Maintenance reason for the shutdown, included in error-chat notification and audit logs"
          ),
      },
    },
    async (args) => {
      try {
        const outcome = await runShutdownTool(toolDeps, selfId, {
          timeoutSeconds: args.timeout_seconds,
          reason: args.reason,
        });
        return outcome.ok ? toolOk(outcome.message) : toolError(outcome.message);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "cancel_shutdown",
    {
      title: "Cancel pending graceful shutdown",
      description:
        "Cancel a pending graceful shutdown request, lifting the admission brake and resuming normal execution. Requires the 'update' capability. Note: callable by in-flight runs (such as the calling turn before completion or concurrent runs) while new runs are barred from starting.",
      inputSchema: {
        reason: z
          .string()
          .optional()
          .describe("Reason for cancellation, included in error-chat notification and audit logs"),
      },
    },
    async (args) => {
      try {
        const outcome = runCancelShutdownTool(toolDeps, selfId, args.reason);
        return outcome.ok ? toolOk(outcome.message) : toolError(outcome.message);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
