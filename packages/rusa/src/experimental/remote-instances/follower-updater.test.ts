import { describe, expect, it, vi } from "vitest";
import type { GitSeam } from "../../update/orchestrator.js";
import { StepError } from "../../update/orchestrator.js";
import {
  executeFollowerUpdate,
  type FollowerBuildSeam,
  type FollowerDrainSeam,
  type FollowerStatusEmitter,
  type FollowerUpdateDeps,
  type FollowerUpdatePlan,
} from "./follower-updater.js";
import { type FollowerUpdateStatusEvent, INSTANCE_PROTOCOL_VERSION } from "./protocol.js";

function makeFakeGit(overrides: Partial<GitSeam> = {}): GitSeam {
  return {
    headSha: vi.fn().mockResolvedValue("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    subject: vi.fn().mockResolvedValue("test commit"),
    fetch: vi.fn().mockResolvedValue(undefined),
    remoteSha: vi.fn().mockResolvedValue("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    resetHard: vi.fn().mockResolvedValue(undefined),
    updateSubmodules: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<FollowerUpdateDeps> = {}): {
  deps: FollowerUpdateDeps;
  emitted: FollowerUpdateStatusEvent[];
  exitedWith: number | null;
} {
  const emitted: FollowerUpdateStatusEvent[] = [];
  let exitedWith: number | null = null;

  const git = makeFakeGit();
  const build: FollowerBuildSeam = {
    build: vi.fn().mockResolvedValue(undefined),
  };
  const drain: FollowerDrainSeam = {
    drain: vi.fn().mockResolvedValue(undefined),
  };
  const emitter: FollowerStatusEmitter = {
    emitStatus: (event) => emitted.push(event),
  };
  const exit = (code: number) => {
    exitedWith = code;
  };

  const deps: FollowerUpdateDeps = {
    git,
    build,
    drain,
    emitter,
    exit,
    log: () => {},
    ...overrides,
  };

  return { deps, emitted, exitedWith };
}

describe("executeFollowerUpdate", () => {
  it("happy path: pulls, builds, drains, and exits 0 onto new SHA", async () => {
    const { deps, emitted } = makeDeps();
    const plan: FollowerUpdatePlan = {
      updateId: "update-1",
      targetSha: "cccccccccccccccccccccccccccccccccccccccc",
      branch: "staging",
      protocolVersion: INSTANCE_PROTOCOL_VERSION,
    };

    let exitedCode: number | null = null;
    deps.exit = (code) => {
      exitedCode = code;
    };

    const result = await executeFollowerUpdate(plan, deps);

    expect(result.ok).toBe(true);
    expect(result.restarting).toBe(true);
    expect(result.newSha).toBe("cccccccccccccccccccccccccccccccccccccccc");
    expect(exitedCode).toBe(0);

    expect(deps.git.fetch).toHaveBeenCalledWith("staging");
    expect(deps.git.resetHard).toHaveBeenCalledWith("cccccccccccccccccccccccccccccccccccccccc");
    expect(deps.git.updateSubmodules).toHaveBeenCalled();
    expect(deps.build.build).toHaveBeenCalledWith("cccccccccccccccccccccccccccccccccccccccc");
    expect(deps.drain.drain).toHaveBeenCalled();

    expect(emitted.map((e) => e.status)).toEqual([
      "fetching",
      "building",
      "draining",
      "restarting",
    ]);
  });

  it("detects already_current commit and skips build/drain/restart", async () => {
    const currentSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const git = makeFakeGit({
      headSha: vi.fn().mockResolvedValue(currentSha),
      remoteSha: vi.fn().mockResolvedValue(currentSha),
    });
    const { deps, emitted } = makeDeps({ git });

    const plan: FollowerUpdatePlan = {
      updateId: "update-current",
      targetSha: currentSha,
    };

    const result = await executeFollowerUpdate(plan, deps);

    expect(result.ok).toBe(true);
    expect(result.alreadyCurrent).toBe(true);
    expect(deps.build.build).not.toHaveBeenCalled();
    expect(deps.drain.drain).not.toHaveBeenCalled();
    expect(emitted.map((e) => e.status)).toEqual(["fetching", "already_current"]);
  });

  it("fences incompatible protocol version without pulling or building", async () => {
    const { deps, emitted } = makeDeps();
    const plan: FollowerUpdatePlan = {
      updateId: "update-fenced",
      protocolVersion: INSTANCE_PROTOCOL_VERSION + 99,
    };

    const result = await executeFollowerUpdate(plan, deps);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Incompatible protocol version");
    expect(deps.git.fetch).not.toHaveBeenCalled();
    expect(deps.build.build).not.toHaveBeenCalled();
    expect(emitted.map((e) => e.status)).toEqual(["failed"]);
  });

  it("rolls back git checkout cleanly when build fails, keeping live follower unharmed", async () => {
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const git = makeFakeGit({
      headSha: vi.fn().mockResolvedValue(oldSha),
      remoteSha: vi.fn().mockResolvedValue(newSha),
    });
    const build: FollowerBuildSeam = {
      build: vi.fn().mockRejectedValue(new StepError("build", "compile syntax error")),
    };

    const { deps, emitted } = makeDeps({ git, build });
    const plan: FollowerUpdatePlan = {
      updateId: "update-build-fail",
      targetSha: newSha,
    };

    const result = await executeFollowerUpdate(plan, deps);

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("build");
    expect(result.rollbackFailed).toBe(false);

    // Verified rollback to oldSha
    expect(git.resetHard).toHaveBeenCalledWith(oldSha);
    expect(deps.drain.drain).not.toHaveBeenCalled();

    const lastEvent = emitted.at(-1);
    expect(lastEvent?.status).toBe("failed");
    expect(lastEvent?.step).toBe("build");
    expect(lastEvent?.error).toContain("compile syntax error");
    expect(lastEvent?.rollbackFailed).toBe(false);
  });

  it("reports rollbackFailed when git reset fails during post-build recovery", async () => {
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let resetCount = 0;
    const git = makeFakeGit({
      headSha: vi.fn().mockResolvedValue(oldSha),
      remoteSha: vi.fn().mockResolvedValue(newSha),
      resetHard: vi.fn().mockImplementation(async (_ref: string) => {
        resetCount++;
        if (resetCount > 1) {
          throw new Error("git lockfile present");
        }
      }),
    });
    const build: FollowerBuildSeam = {
      build: vi.fn().mockRejectedValue(new StepError("build", "build error")),
    };

    const { deps, emitted } = makeDeps({ git, build });
    const plan: FollowerUpdatePlan = {
      updateId: "update-rollback-fail",
      targetSha: newSha,
    };

    const result = await executeFollowerUpdate(plan, deps);

    expect(result.ok).toBe(false);
    expect(result.rollbackFailed).toBe(true);

    const lastEvent = emitted.at(-1);
    expect(lastEvent?.status).toBe("failed");
    expect(lastEvent?.rollbackFailed).toBe(true);
  });
});
