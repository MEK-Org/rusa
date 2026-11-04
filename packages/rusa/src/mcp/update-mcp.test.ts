import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { MaintenanceShutdownCoordinator } from "../update/maintenance-shutdown.js";
import type {
  BuildSeam,
  DrainSeam,
  GitSeam,
  UpdateDeps,
  UpdatePlan,
} from "../update/orchestrator.js";
import {
  createUpdateMcpServer,
  runCancelShutdownTool,
  runShutdownTool,
  runUpdateTool,
  UPDATE_MCP_NAME,
  type UpdateToolDeps,
} from "./update-mcp.js";

/** Records every side effect so we can assert a rejected caller touches nothing. */
function trackingDeps() {
  const touched = { fetched: false, built: false, drained: false, exited: false, git: false };
  const git: GitSeam = {
    async headSha() {
      return "oldsha";
    },
    async subject() {
      return "subj";
    },
    async fetch() {
      touched.fetched = true;
    },
    async remoteSha() {
      return "newsha";
    },
    async resetHard() {
      touched.git = true;
    },
    async updateSubmodules() {},
  };
  const build: BuildSeam = {
    async build() {
      touched.built = true;
    },
  };
  const drain: DrainSeam = {
    engage() {
      touched.drained = true;
    },
    cancel() {},
    async waitForQuiescence() {
      return { quiesced: true, waitedMs: 0 };
    },
  };
  const deps: UpdateDeps = {
    git,
    build,
    drain,
    exit: () => {
      touched.exited = true;
    },
  };
  return { deps, touched };
}

const plan: UpdatePlan = { branch: "master", drainTimeoutMs: 1000 };

/** Only the actor named `granted` holds the `update` capability. */
const holderOnly =
  (granted: string) =>
  (actorId: string, capability: string): boolean =>
    actorId === granted && capability === UPDATE_MCP_NAME;

function createTestToolDeps(opts?: {
  granted?: string;
  drain?: DrainSeam;
  exit?: (code: number) => void;
}) {
  const { deps, touched } = trackingDeps();
  if (opts?.drain) deps.drain = opts.drain;
  if (opts?.exit) deps.exit = opts.exit;
  const maintenanceShutdown = new MaintenanceShutdownCoordinator({
    drain: deps.drain,
    exit: deps.exit,
  });
  const toolDeps: UpdateToolDeps = {
    plan,
    deps,
    hasCapability: opts?.granted !== undefined ? holderOnly(opts.granted) : () => false,
    maintenanceShutdown,
  };
  return { toolDeps, deps, touched, maintenanceShutdown };
}

describe("runUpdateTool — capability guard (#549)", () => {
  it("REFUSES a worker caller and performs ZERO side effects", async () => {
    const { toolDeps, touched } = createTestToolDeps({ granted: "root" });

    const outcome = await runUpdateTool(toolDeps, "worker-7");

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/requires the 'update' capability/);
    // The security-critical assertion: nothing happened — no pull, build, drain, exit.
    expect(touched).toEqual({
      fetched: false,
      built: false,
      drained: false,
      exited: false,
      git: false,
    });
    expect(outcome.result).toBeUndefined();
  });

  it("RUNS for a granted opaque-id actor (reaches the orchestrator → builds + restarts)", async () => {
    const { toolDeps, touched } = createTestToolDeps({ granted: "0b2c3d4e-steward" });

    const outcome = await runUpdateTool(toolDeps, "0b2c3d4e-steward");

    expect(outcome.ok).toBe(true);
    expect(touched.built).toBe(true);
    expect(touched.exited).toBe(true); // green build → drained → exit(0)
    expect(outcome.result?.restarting).toBe(true);
  });

  it("REFUSES a parentless caller that holds no grant (topology is not authority)", async () => {
    const { toolDeps, touched } = createTestToolDeps();

    const outcome = await runUpdateTool(toolDeps, "root");

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/requires the 'update' capability/);
    expect(touched.built).toBe(false);
    expect(touched.exited).toBe(false);
  });

  it("surfaces a build failure to the caller (not ok) without restarting", async () => {
    const { toolDeps, deps, touched } = createTestToolDeps({ granted: "root" });
    deps.build = {
      async build() {
        throw new Error("build broke");
      },
    };
    const outcome = await runUpdateTool(toolDeps, "root");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("update failed");
    expect(touched.exited).toBe(false); // never restart onto a broken build
  });

  it("REFUSES update when maintenance shutdown is in progress", async () => {
    const { toolDeps, maintenanceShutdown } = createTestToolDeps({ granted: "root" });
    await maintenanceShutdown.request({ timeoutSeconds: 60 });
    expect(maintenanceShutdown.isPending()).toBe(true);

    const outcome = await runUpdateTool(toolDeps, "root");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(
      "A maintenance shutdown is currently in progress — refusing update."
    );
  });
});

describe("runShutdownTool & runCancelShutdownTool (#1225)", () => {
  it("REFUSES shutdown for an actor without the 'update' capability", async () => {
    const { toolDeps, touched } = createTestToolDeps({ granted: "root" });

    const outcome = await runShutdownTool(toolDeps, "worker-1");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/requires the 'update' capability/);
    expect(touched.drained).toBe(false);
    expect(touched.exited).toBe(false);
  });

  it("RUNS shutdown for a granted actor", async () => {
    const { toolDeps, touched } = createTestToolDeps({ granted: "root" });

    const outcome = await runShutdownTool(toolDeps, "root", { reason: "config restart" });
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("Graceful shutdown initiated");
    expect(touched.drained).toBe(true);

    // Wait for the background drain watcher to quiesce and trigger exit
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(touched.exited).toBe(true);
  });

  it("REFUSES cancel_shutdown for an actor without the 'update' capability", () => {
    const { toolDeps } = createTestToolDeps({ granted: "root" });

    const outcome = runCancelShutdownTool(toolDeps, "worker-1");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/requires the 'update' capability/);
  });

  it("RUNS cancel_shutdown for a granted actor", async () => {
    let cancelled = false;
    const drain: DrainSeam = {
      engage() {},
      cancel() {
        cancelled = true;
      },
      async waitForQuiescence(_timeoutMs, opts) {
        return new Promise<{ quiesced: boolean; waitedMs: number }>((resolve) => {
          opts?.signal?.addEventListener("abort", () => {
            resolve({ quiesced: false, waitedMs: 0 });
          });
        });
      },
    };
    const { toolDeps } = createTestToolDeps({ granted: "root", drain });

    await runShutdownTool(toolDeps, "root", { timeoutSeconds: 60 });
    const cancelOutcome = runCancelShutdownTool(toolDeps, "root", "test cancel");
    expect(cancelOutcome.ok).toBe(true);
    expect(cancelOutcome.message).toContain("Graceful shutdown cancelled");
    expect(cancelled).toBe(true);
  });

  it("createUpdateMcpServer exposes and wires update, shutdown, and cancel_shutdown tools", async () => {
    let cancelled = false;
    const drain: DrainSeam = {
      engage() {},
      cancel() {
        cancelled = true;
      },
      async waitForQuiescence(_timeoutMs, opts) {
        return new Promise<{ quiesced: boolean; waitedMs: number }>((resolve) => {
          opts?.signal?.addEventListener("abort", () => {
            resolve({ quiesced: false, waitedMs: 0 });
          });
        });
      },
    };
    const { toolDeps } = createTestToolDeps({ granted: "root", drain });
    const server = createUpdateMcpServer(toolDeps, "root");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
      const toolsResult = await client.listTools();
      const toolNames = toolsResult.tools.map((t) => t.name);
      expect(toolNames).toContain("update");
      expect(toolNames).toContain("shutdown");
      expect(toolNames).toContain("cancel_shutdown");

      // Verify shutdown tool schema and invocation wiring with omitted timeout_seconds (defaults to 300)
      const shutdownDefaultRes = (await client.callTool({
        name: "shutdown",
        arguments: {
          reason: "mcp test shutdown default timeout",
        },
      })) as CallToolResult;
      expect(shutdownDefaultRes.isError).toBeFalsy();
      const shutdownDefaultText = (shutdownDefaultRes.content[0] as { text: string }).text;
      expect(shutdownDefaultText).toContain("Graceful shutdown initiated");
      expect(shutdownDefaultText).toContain("300s timeout");

      // Verify cancel_shutdown tool schema and invocation wiring
      const cancelRes = (await client.callTool({
        name: "cancel_shutdown",
        arguments: {
          reason: "mcp test cancel",
        },
      })) as CallToolResult;
      expect(cancelRes.isError).toBeFalsy();
      const cancelText = (cancelRes.content[0] as { text: string }).text;
      expect(cancelText).toContain("Graceful shutdown cancelled");
      expect(cancelled).toBe(true);

      // Verify shutdown tool schema and invocation wiring with explicit timeout_seconds
      const shutdownRes = (await client.callTool({
        name: "shutdown",
        arguments: {
          timeout_seconds: 45,
          reason: "mcp test shutdown explicit",
        },
      })) as CallToolResult;
      expect(shutdownRes.isError).toBeFalsy();
      const shutdownText = (shutdownRes.content[0] as { text: string }).text;
      expect(shutdownText).toContain("Graceful shutdown initiated");
      expect(shutdownText).toContain("45s timeout");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
