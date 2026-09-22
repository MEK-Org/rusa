import type { spawn } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type GitSeam, StepError } from "../../update/orchestrator.js";
import { runTimedStep } from "../../update/runner.js";
import {
  type FollowerUpdateStatusEvent,
  type FollowerUpdateStep,
  INSTANCE_PROTOCOL_VERSION,
} from "./protocol.js";

export interface FollowerBuildSeam {
  build(sha: string): Promise<void>;
}

export interface FollowerDrainSeam {
  drain(timeoutMs: number): Promise<void>;
}

export interface FollowerStatusEmitter {
  emitStatus(event: FollowerUpdateStatusEvent): void;
}

export interface FollowerUpdateDeps {
  git: GitSeam;
  build: FollowerBuildSeam;
  drain: FollowerDrainSeam;
  emitter: FollowerStatusEmitter;
  exit: (code: number) => void;
  log?: (msg: string) => void;
}

export interface FollowerUpdatePlan {
  updateId: string;
  targetSha?: string;
  branch?: string;
  protocolVersion?: number;
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

export class FollowerBuildRunner implements FollowerBuildSeam {
  constructor(
    private readonly packageDir: string,
    private readonly timeouts: { installMs: number; buildMs: number } = {
      installMs: 120_000,
      buildMs: 120_000,
    },
    private readonly log: (msg: string) => void = () => {},
    private readonly pnpm = "pnpm",
    private readonly spawnImpl?: typeof spawn
  ) {}

  async build(sha: string): Promise<void> {
    const live = join(this.packageDir, "build", "follower");
    const staging = `${live}.new`;
    const previous = `${live}.old`;

    // Start with a clean staging directory. Live build remains untouched.
    rmSync(staging, { recursive: true, force: true });
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
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }

    // Atomic swap: move old out of the way, promote staging
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(live)) renameSync(live, previous);
    renameSync(staging, live);
    this.log(`[follower-update] atomically swapped follower build → ${sha.slice(0, 7)}`);
  }
}

let isFollowerUpdating = false;

export function isFollowerUpdateInProgress(): boolean {
  return isFollowerUpdating;
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
  let rollbackFailed = false;

  try {
    // ── Version & Compatibility Fencing ──
    if (plan.protocolVersion !== undefined && plan.protocolVersion !== INSTANCE_PROTOCOL_VERSION) {
      const error = `Incompatible protocol version: target ${plan.protocolVersion} !== follower ${INSTANCE_PROTOCOL_VERSION}`;
      log(`[follower-update] fenced: ${error}`);
      deps.emitter.emitStatus({
        type: "update_status",
        updateId: plan.updateId,
        status: "failed",
        error,
      });
      return { ok: false, error };
    }

    // ── 1. Pull & Resolve Commit ──
    step = "pull";
    oldSha = await deps.git.headSha();
    const branch = plan.branch ?? "staging";
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

    await deps.drain.drain(plan.drainTimeoutMs ?? 5000);

    // ── 4. Restart onto fresh build ──
    log(`[follower-update] restarting onto ${newSha.slice(0, 7)}`);
    deps.emitter.emitStatus({
      type: "update_status",
      updateId: plan.updateId,
      status: "restarting",
      oldSha,
      newSha,
    });

    deps.exit(0);
    return {
      ok: true,
      oldSha,
      newSha,
      restarting: true,
    };
  } catch (err) {
    const isStep = err instanceof StepError;
    const failedStep = (isStep ? (err.step as FollowerUpdateStep) : step) ?? step;
    const error = err instanceof Error ? err.message : String(err);
    log(`[follower-update] FAILED at ${failedStep}: ${error}`);

    // Roll back checkout if moved
    if (movedToNew && oldSha) {
      try {
        await deps.git.resetHard(oldSha);
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
