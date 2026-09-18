import { describe, expect, it } from "vitest";
import type {
  BuildSeam,
  DrainSeam,
  GitSeam,
  UpdateDeps,
  UpdatePlan,
} from "../update/orchestrator.js";
import { runUpdateTool, UPDATE_MCP_NAME, type UpdateToolDeps } from "./update-mcp.js";

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

describe("runUpdateTool — capability guard (#549)", () => {
  it("REFUSES a worker caller and performs ZERO side effects", async () => {
    const { deps, touched } = trackingDeps();
    const toolDeps: UpdateToolDeps = { plan, deps, hasCapability: holderOnly("root") };

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
    const { deps, touched } = trackingDeps();
    const toolDeps: UpdateToolDeps = {
      plan,
      deps,
      hasCapability: holderOnly("0b2c3d4e-steward"),
    };

    const outcome = await runUpdateTool(toolDeps, "0b2c3d4e-steward");

    expect(outcome.ok).toBe(true);
    expect(touched.built).toBe(true);
    expect(touched.exited).toBe(true); // green build → drained → exit(0)
    expect(outcome.result?.restarting).toBe(true);
  });

  it("REFUSES a parentless caller that holds no grant (topology is not authority)", async () => {
    const { deps, touched } = trackingDeps();
    const toolDeps: UpdateToolDeps = { plan, deps, hasCapability: () => false };

    const outcome = await runUpdateTool(toolDeps, "root");

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/requires the 'update' capability/);
    expect(touched.built).toBe(false);
    expect(touched.exited).toBe(false);
  });

  it("surfaces a build failure to the caller (not ok) without restarting", async () => {
    const { deps, touched } = trackingDeps();
    deps.build = {
      async build() {
        throw new Error("build broke");
      },
    };
    const outcome = await runUpdateTool({ plan, deps, hasCapability: holderOnly("root") }, "root");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("update failed");
    expect(touched.exited).toBe(false); // never restart onto a broken build
  });
});
