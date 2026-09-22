import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StepError } from "../../update/orchestrator.js";
import {
  executeFollowerUpdate,
  FollowerBuildRunner,
  type FollowerBuildSeam,
  type FollowerDrainSeam,
  type FollowerGitSeam,
  type FollowerStatusEmitter,
  type FollowerUpdateDeps,
  type FollowerUpdatePlan,
  swapFollowerBuildDirectories,
} from "./follower-updater.js";
import type { FollowerUpdateStatusEvent } from "./protocol.js";

function makeFakeGit(overrides: Partial<FollowerGitSeam> = {}): FollowerGitSeam {
  return {
    headSha: vi.fn().mockResolvedValue("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    subject: vi.fn().mockResolvedValue("test commit"),
    fetch: vi.fn().mockResolvedValue(undefined),
    remoteSha: vi.fn().mockResolvedValue("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    isAncestor: vi.fn().mockResolvedValue(true),
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
    rollback: vi.fn().mockResolvedValue(undefined),
  };
  const drain: FollowerDrainSeam = {
    drain: vi.fn().mockResolvedValue({ quiesced: true, waitedMs: 0 }),
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
  it("promotes with the production build runner and can restore its prior artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-follower-build-"));
    const live = join(root, "build", "follower");
    const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    try {
      mkdirSync(live, { recursive: true });
      writeFileSync(join(live, "artifact"), "old");
      const spawnImpl = ((_cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        spawned.push({ args, env: options.env });
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          stderr: EventEmitter;
          kill: () => void;
        };
        child.pid = 12345;
        child.stderr = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => {
          if (args[1] === "build:follower") {
            const staging = options.env?.RUSA_FOLLOWER_DIST_DIR;
            if (!staging) throw new Error("missing follower staging directory");
            mkdirSync(staging, { recursive: true });
            writeFileSync(join(staging, "artifact"), "new");
          }
          child.emit("close", 0);
        });
        return child;
      }) as never;
      const runner = new FollowerBuildRunner(
        root,
        { installMs: 1000, buildMs: 1000 },
        () => {},
        "pnpm",
        spawnImpl
      );

      await runner.build("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      expect(readFileSync(join(live, "artifact"), "utf8")).toBe("new");
      expect(readFileSync(`${live}.old/artifact`, "utf8")).toBe("old");
      expect(spawned).toHaveLength(2);
      expect(spawned[1].env?.RUSA_FOLLOWER_DIST_DIR).toBe(`${live}.new`);

      runner.rollback();
      expect(readFileSync(join(live, "artifact"), "utf8")).toBe("old");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps the runner's install and build subprocess failures to protocol steps", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-follower-step-"));
    try {
      const spawnFailure = (failedArgs: string[]) =>
        ((_: string, args: string[]) => {
          const child = new EventEmitter() as EventEmitter & {
            pid: number;
            stderr: EventEmitter;
            kill: () => void;
          };
          child.pid = 12345;
          child.stderr = new EventEmitter();
          child.kill = () => {};
          queueMicrotask(() =>
            child.emit("close", args.join(" ") === failedArgs.join(" ") ? 1 : 0)
          );
          return child;
        }) as never;

      const installRunner = new FollowerBuildRunner(
        root,
        { installMs: 1000, buildMs: 1000 },
        () => {},
        "pnpm",
        spawnFailure(["install", "--frozen-lockfile"])
      );
      await expect(
        installRunner.build("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
      ).rejects.toMatchObject({
        step: "install",
      });

      const buildRunner = new FollowerBuildRunner(
        root,
        { installMs: 1000, buildMs: 1000 },
        () => {},
        "pnpm",
        spawnFailure(["run", "build:follower"])
      );
      await expect(
        buildRunner.build("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
      ).rejects.toMatchObject({
        step: "build",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores the live build if promotion fails after the old build moved aside", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-follower-swap-"));
    const live = join(root, "follower");
    const staging = `${live}.new`;
    try {
      mkdirSync(live);
      mkdirSync(staging);
      writeFileSync(join(live, "artifact"), "old");
      writeFileSync(join(staging, "artifact"), "new");

      expect(() =>
        swapFollowerBuildDirectories(live, staging, {
          exists: existsSync,
          remove: (path) => rmSync(path, { recursive: true, force: true }),
          rename: (from, to) => {
            if (from === staging && to === live) throw new Error("simulated promotion failure");
            renameSync(from, to);
          },
        })
      ).toThrow("simulated promotion failure");

      expect(readFileSync(join(live, "artifact"), "utf8")).toBe("old");
      expect(readFileSync(join(staging, "artifact"), "utf8")).toBe("new");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("happy path: pulls, builds, drains, and exits 0 onto new SHA", async () => {
    const { deps, emitted } = makeDeps();
    const plan: FollowerUpdatePlan = {
      updateId: "update-1",
      targetSha: "cccccccccccccccccccccccccccccccccccccccc",
      branch: "staging",
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

  it("rejects a target outside the fetched branch before checkout", async () => {
    const git = makeFakeGit({ isAncestor: vi.fn().mockResolvedValue(false) });
    const { deps, emitted } = makeDeps({ git });

    const result = await executeFollowerUpdate(
      {
        updateId: "unreachable-target",
        targetSha: "cccccccccccccccccccccccccccccccccccccccc",
        branch: "staging",
      },
      deps
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not reachable");
    expect(git.resetHard).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toMatchObject({ status: "failed", step: "pull" });
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
      rollback: vi.fn().mockResolvedValue(undefined),
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
      rollback: vi.fn().mockResolvedValue(undefined),
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

  it("restores both checkout and artifact when draining fails after promotion", async () => {
    const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const git = makeFakeGit({
      headSha: vi.fn().mockResolvedValue(oldSha),
      remoteSha: vi.fn().mockResolvedValue(newSha),
    });
    const build: FollowerBuildSeam = {
      build: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    };
    const drain: FollowerDrainSeam = {
      drain: vi.fn().mockRejectedValue(new StepError("drain", "quiescence failed")),
    };
    const { deps, emitted } = makeDeps({ git, build, drain });

    const result = await executeFollowerUpdate({ updateId: "drain-fail", targetSha: newSha }, deps);

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("drain");
    expect(build.rollback).toHaveBeenCalledOnce();
    expect(git.resetHard).toHaveBeenLastCalledWith(oldSha);
    expect(emitted.at(-1)).toMatchObject({ status: "failed", step: "drain" });
  });
});
