import type { spawn } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type GitSeam, StepError } from "../../update/orchestrator.js";
import { runTimedStep } from "../../update/runner.js";
import { isFullCommitSha, isSafeFollowerBranch } from "./follower-update-validation.js";
import type { FollowerUpdateStatusEvent, FollowerUpdateStep } from "./protocol.js";

export interface FollowerGitSeam extends GitSeam {
  /** True only when `ancestor` is reachable from the fetched remote branch. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

export interface FollowerBuildSeam {
  build(sha: string): Promise<void>;
  /** Restore the artifact retained by a completed build promotion. */
  rollback(): Promise<void> | void;
}

export interface FollowerDrainSeam {
  drain(timeoutMs: number): Promise<{ quiesced: boolean; waitedMs: number }>;
}

export interface FollowerStatusEmitter {
  emitStatus(event: FollowerUpdateStatusEvent): void;
}

export interface FollowerUpdateDeps {
  git: FollowerGitSeam;
  build: FollowerBuildSeam;
  drain: FollowerDrainSeam;
  emitter: FollowerStatusEmitter;
  exit: (code: number) => Promise<void> | void;
  log?: (msg: string) => void;
}

export interface FollowerUpdatePlan {
  updateId: string;
  targetSha?: string;
  branch?: string;
  drainTimeoutMs?: number;
}

export interface FollowerUpdateResult {
  ok: boolean;
  failedStep?: FollowerUpdateStep;
  error?: string;
  oldSha?: string;
  newSha?: string;
  alreadyCurrent?: boolean;
  restarting?: boolean;
  rollbackFailed?: boolean;
}

export interface FollowerBuildFilesystem {
  exists(path: string): boolean;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

const productionFilesystem: FollowerBuildFilesystem = {
  exists: existsSync,
  rename: renameSync,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};

/**
 * Promote a green follower artifact while restoring the previous artifact if
 * promotion fails after the live directory has been moved aside.
 */
export function swapFollowerBuildDirectories(
  live: string,
  staging: string,
  filesystem: FollowerBuildFilesystem = productionFilesystem
): void {
  const previous = `${live}.old`;
  filesystem.remove(previous);
  const hadLive = filesystem.exists(live);
  try {
    if (hadLive) filesystem.rename(live, previous);
    filesystem.rename(staging, live);
  } catch (error) {
    if (hadLive && !filesystem.exists(live) && filesystem.exists(previous)) {
      try {
        filesystem.rename(previous, live);
      } catch (restoreError) {
        const restoreMessage =
          restoreError instanceof Error ? restoreError.message : String(restoreError);
        throw new Error(
          `Follower build promotion failed and the previous artifact could not be restored: ${restoreMessage}`,
          { cause: error }
        );
      }
    }
    throw error;
  }
}

/** Restore the last promoted follower artifact after a later update step fails. */
export function restoreFollowerBuildDirectories(
  live: string,
  filesystem: FollowerBuildFilesystem = productionFilesystem
): void {
  const previous = `${live}.old`;
  const failed = `${live}.failed`;
  if (!filesystem.exists(previous)) {
    throw new Error("Follower build rollback is unavailable: no previous artifact exists");
  }
  filesystem.remove(failed);
  if (filesystem.exists(live)) filesystem.rename(live, failed);
  try {
    filesystem.rename(previous, live);
  } catch (error) {
    // Preserve the newer artifact for diagnosis if restoring the old one failed.
    if (!filesystem.exists(live) && filesystem.exists(failed)) {
      try {
        filesystem.rename(failed, live);
      } catch {}
    }
    throw error;
  }
}

export class FollowerBuildRunner implements FollowerBuildSeam {
  constructor(
    private readonly packageDir: string,
    private readonly timeouts: { installMs: number; buildMs: number } = {
      installMs: 120_000,
      buildMs: 120_000,
    },
    private readonly log: (msg: string) => void = () => {},
    private readonly pnpm = "pnpm",
    private readonly spawnImpl?: typeof spawn,
    private readonly filesystem: FollowerBuildFilesystem = productionFilesystem
  ) {}

  async build(sha: string): Promise<void> {
    const live = join(this.packageDir, "build", "follower");
    const staging = `${live}.new`;

    // Start with a clean staging directory. Live build remains untouched.
    this.filesystem.remove(staging);
    const env = { ...process.env, RUSA_FOLLOWER_DIST_DIR: staging };
    const common = { cwd: this.packageDir, log: this.log, spawnImpl: this.spawnImpl, env };

    try {
      await runTimedStep("install", this.pnpm, ["install", "--frozen-lockfile"], {
        ...common,
        timeoutMs: this.timeouts.installMs,
      });
      await runTimedStep("build:follower", this.pnpm, ["run", "build:follower"], {
        ...common,
        timeoutMs: this.timeouts.buildMs,
      });
    } catch (err) {
      this.filesystem.remove(staging);
      if (err instanceof StepError) {
        const step: FollowerUpdateStep = err.step === "install" ? "install" : "build";
        throw new StepError(step, err.message, err.timedOut);
      }
      throw err;
    }

    swapFollowerBuildDirectories(live, staging, this.filesystem);
    this.log(`[follower-update] atomically swapped follower build → ${sha.slice(0, 7)}`);
  }

  rollback(): void {
    const live = join(this.packageDir, "build", "follower");
    restoreFollowerBuildDirectories(live, this.filesystem);
  }
}

let isFollowerUpdating = false;

function stepFromError(error: StepError, fallback: FollowerUpdateStep): FollowerUpdateStep {
  switch (error.step) {
    case "pull":
    case "install":
    case "build":
    case "drain":
      return error.step;
    default:
      return fallback;
  }
}

export async function executeFollowerUpdate(
  plan: FollowerUpdatePlan,
  deps: FollowerUpdateDeps
): Promise<FollowerUpdateResult> {
  const log = deps.log ?? (() => {});
  if (isFollowerUpdating) {
    const error = "Follower update already in progress";
    log(`[follower-update] refused: ${error}`);
    deps.emitter.emitStatus({
      type: "update_status",
      updateId: plan.updateId,
      status: "failed",
      error,
    });
    return { ok: false, error };
  }

  isFollowerUpdating = true;
  let step: FollowerUpdateStep = "pull";
  let oldSha = "";
  let newSha = "";
  let movedToNew = false;
  let promotedBuild = false;
  let rollbackFailed = false;

  try {
    // ── 1. Pull & Resolve Commit ──
    step = "pull";
    oldSha = await deps.git.headSha();
    const branch = plan.branch ?? "staging";
    if (!isSafeFollowerBranch(branch)) {
      const error = "Invalid update branch";
      deps.emitter.emitStatus({
        type: "update_status",
        updateId: plan.updateId,
        status: "failed",
        error,
      });
      return { ok: false, error };
    }
    if (plan.targetSha !== undefined && !isFullCommitSha(plan.targetSha)) {
      const error = "Invalid target SHA";
      deps.emitter.emitStatus({
        type: "update_status",
        updateId: plan.updateId,
        status: "failed",
        error,
      });
      return { ok: false, error };
    }
    log(`[follower-update] current sha ${oldSha.slice(0, 7)} — fetching origin/${branch}`);
    deps.emitter.emitStatus({
      type: "update_status",
      updateId: plan.updateId,
      status: "fetching",
      step: "pull",
      oldSha,
    });

    await deps.git.fetch(branch);
    newSha = plan.targetSha ?? (await deps.git.remoteSha(branch));

    if (!(await deps.git.isAncestor(newSha, `origin/${branch}`))) {
      throw new StepError(
        "pull",
        `Refusing target ${newSha}: it is not reachable from fetched origin/${branch}`
      );
    }

    if (newSha === oldSha) {
      log(`[follower-update] already at target SHA ${newSha.slice(0, 7)}`);
      deps.emitter.emitStatus({
        type: "update_status",
        updateId: plan.updateId,
        status: "already_current",
        oldSha,
        newSha,
      });
      return { ok: true, alreadyCurrent: true, oldSha, newSha };
    }

    log(`[follower-update] resetting checkout to ${newSha.slice(0, 7)}`);
    await deps.git.resetHard(newSha);
    movedToNew = true;
    await deps.git.updateSubmodules();

    // ── 2. Build (isolated staging + atomic swap) ──
    step = "build";
    log(`[follower-update] building ${newSha.slice(0, 7)}…`);
    deps.emitter.emitStatus({
      type: "update_status",
      updateId: plan.updateId,
      status: "building",
      step: "build",
      oldSha,
      newSha,
    });

    await deps.build.build(newSha);
    promotedBuild = true;
    log(`[follower-update] build green`);

    // ── 3. Drain in-flight actors ──
    step = "drain";
    log(`[follower-update] draining follower actors…`);
    deps.emitter.emitStatus({
      type: "update_status",
      updateId: plan.updateId,
      status: "draining",
      step: "drain",
      oldSha,
      newSha,
    });

    const drain = await deps.drain.drain(plan.drainTimeoutMs ?? 5000);
    log(
      `[follower-update] drained after ${drain.waitedMs}ms` +
        (drain.quiesced ? " (quiesced)" : " (timeout — restart may interrupt remaining actors)")
    );

    // ── 4. Restart onto fresh build ──
    log(`[follower-update] restarting onto ${newSha.slice(0, 7)}`);
    deps.emitter.emitStatus({
      type: "update_status",
      updateId: plan.updateId,
      status: "restarting",
      oldSha,
      newSha,
    });

    await deps.exit(0);
    return {
      ok: true,
      oldSha,
      newSha,
      restarting: true,
    };
  } catch (err) {
    const isStep = err instanceof StepError;
    const failedStep = isStep ? stepFromError(err, step) : step;
    const error = err instanceof Error ? err.message : String(err);
    log(`[follower-update] FAILED at ${failedStep}: ${error}`);

    // The build promotion precedes draining, so a drain or restart failure must
    // restore both the checkout and the previous boot artifact.
    if (promotedBuild) {
      try {
        await deps.build.rollback();
        log("[follower-update] restored previous follower build artifact");
      } catch (rbErr) {
        rollbackFailed = true;
        const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
        log(`[follower-update] WARNING: artifact rollback failed: ${rbMsg}`);
      }
    }

    // Roll back checkout if moved.
    if (movedToNew && oldSha) {
      try {
        await deps.git.resetHard(oldSha);
        await deps.git.updateSubmodules();
        log(`[follower-update] rolled checkout back to ${oldSha.slice(0, 7)}`);
      } catch (rbErr) {
        rollbackFailed = true;
        const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
        log(`[follower-update] WARNING: rollback to ${oldSha.slice(0, 7)} failed: ${rbMsg}`);
      }
    }

    deps.emitter.emitStatus({
      type: "update_status",
      updateId: plan.updateId,
      status: "failed",
      step: failedStep,
      error,
      oldSha,
      newSha,
      rollbackFailed,
    });

    return {
      ok: false,
      failedStep,
      error,
      oldSha,
      newSha,
      rollbackFailed,
    };
  } finally {
    isFollowerUpdating = false;
  }
}
