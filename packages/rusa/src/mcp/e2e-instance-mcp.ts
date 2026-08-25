import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { E2EInstanceStatus } from "../actor/e2e-instance-manager.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const E2E_INSTANCE_MCP_NAME = "e2e-instance";

export interface E2EInstanceController {
  up(actorId: string, worktree: string): E2EInstanceStatus | Promise<E2EInstanceStatus>;
  down(actorId: string): E2EInstanceStatus;
  status(): E2EInstanceStatus;
}

export interface E2EInstanceMcpDeps {
  manager: E2EInstanceController;
}

export function createE2EInstanceServer(
  deps: E2EInstanceMcpDeps,
  selfId: string,
  options?: { isFenced?: () => boolean }
): McpServer {
  const server = createMcpServer(
    { name: E2E_INSTANCE_MCP_NAME, version: "0.1.0" },
    { isFenced: options?.isFenced }
  );

  const up = async ({ worktree }: { worktree: string }) => {
    try {
      return toolOk(await deps.manager.up(selfId, worktree));
    } catch (err) {
      return toolError(err);
    }
  };
  const down = async () => {
    try {
      return toolOk(deps.manager.down(selfId));
    } catch (err) {
      return toolError(err);
    }
  };

  server.registerTool(
    "up",
    {
      title: "Start the live e2e instance",
      description:
        "Start the mesh-wide singleton e2e dashboard on port 8083 from a rusa worktree inside this actor's own workdir. It watches and rebuilds as that worktree changes.",
      inputSchema: {
        worktree: z.string().min(1).describe("Absolute path to my rusa worktree."),
      },
    },
    up
  );
  server.registerTool(
    "start",
    {
      title: "Start the live e2e instance (alias)",
      description: "Alias of up.",
      inputSchema: {
        worktree: z.string().min(1).describe("Absolute path to my rusa worktree."),
      },
    },
    up
  );
  server.registerTool(
    "status",
    {
      title: "Show the live e2e instance",
      description:
        "Show whether the singleton is up and, when known, who holds it and which worktree it serves.",
      inputSchema: {},
    },
    async () => toolOk(deps.manager.status())
  );
  server.registerTool(
    "down",
    {
      title: "Stop my live e2e instance",
      description: "Stop the singleton when this actor is its current holder.",
      inputSchema: {},
    },
    down
  );
  server.registerTool(
    "stop",
    {
      title: "Stop my live e2e instance (alias)",
      description: "Alias of down.",
      inputSchema: {},
    },
    down
  );
  return server;
}
