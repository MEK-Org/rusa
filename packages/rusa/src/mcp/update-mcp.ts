import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
  /** The id that is allowed to run `update` — root, and only root. */
  rootId: string;
}

export interface UpdateToolOutcome {
  ok: boolean;
  message: string;
  result?: UpdateResult;
}

/**
 * The `update` tool body, factored out so the root-only guard + orchestration are
 * unit-testable without the MCP transport.
 *
 * Root-only (elder fix #3): self-update bounces the whole daemon, so only the
 * human-facing root may trigger it. The server is mounted ONLY on root's tool set
 * in `start.ts` (never the worker set, exactly like chat); this `selfId === rootId`
 * check is the belt-and-suspenders second layer, matching the per-endpoint identity
 * model — `selfId` is the unspoofable endpoint identity, not a tool argument. A
 * worker that somehow reached this endpoint is refused before any side effect.
 */
export async function runUpdateTool(
  toolDeps: UpdateToolDeps,
  selfId: string
): Promise<UpdateToolOutcome> {
  if (selfId !== toolDeps.rootId) {
    return {
      ok: false,
      message: `'update' is a root-only tool — refusing to run it for '${selfId}'.`,
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
 * In-process MCP server exposing the self-update as a single `update` tool.
 * **One instance, mounted only on root's tool set**, with `selfId` baked into the
 * endpoint (like every mesh endpoint), so "who is acting" is unspoofable.
 */
export function createUpdateMcpServer(toolDeps: UpdateToolDeps, selfId: string): McpServer {
  const server = createMcpServer({ name: UPDATE_MCP_NAME, version: "0.1.0" });

  server.registerTool(
    "update",
    {
      title: `Update & restart onto the latest ${toolDeps.plan.branch}`,
      description: `Redeploy this running system to the latest origin/${toolDeps.plan.branch}: pull, install, and build IN PLACE (the mesh stays live and responsive throughout), and ONLY if the build is fully green, drain in-flight runs and restart onto the fresh code. A failed or hung build aborts safely and leaves the current build running — you get the error back. Use this to make a freshly-merged change go live. Root-only. Authorized by the master merge.`,
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

  return server;
}
