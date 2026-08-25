/**
 * Pure orchestrator for the in-process `update` MCP tool (ISSUE_NUM redesign). It runs
 * INSIDE root's own process during root's run; all side effects are behind injected
 * seams so the gate/drain/exit logic is unit-tested without real git, builds, the
 * mesh, or a real `process.exit`.
 *
 * Flow — the mesh stays fully LIVE through the (slow) build; only a GREEN build
 * ever touches run-state:
 *
 *   Pull → Build ──red/timeout──▶ roll back to old sha, report ❌  (mesh UNTOUCHED:
 *                │                                                 no drain, no exit)
 *                └─green────────▶ engage gracefulShutdown (direct, in-process) →
 *                                 drain (self-excluding, bounded) → exit(0)
 *                                 → systemd restarts onto the fresh build
 *
 * On green we emit a mechanical "updating" ping at the point of no return, then
 * exit and let the startup path emit "back online" after the mesh is live. A
 * red/hung build never exits, so root's run survives and the tool returns the
 * failure to root.
 */

/** The ordered steps; a failure is reported against the granular step that threw. */
export type UpdateStep = "pull" | "install" | "typecheck" | "build" | "drain";

/** A git/build step that failed or — critically — HUNG past its hard timeout. */
export class StepError extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly timedOut = false
  ) {
    super(message);
    this.name = "StepError";
  }
}

/** Move the deploy checkout. Implemented over `git` (each call bounded). */
export interface GitSeam {
  headSha(): Promise<string>;
  subject(sha: string): Promise<string>;
  fetch(branch: string): Promise<void>;
  remoteSha(branch: string): Promise<string>;
  resetHard(ref: string): Promise<void>;
  /**
   * Materialize git submodules to the checked-out commit (`git submodule update
   * --init --recursive`). Runs before EVERY build (the build is unconditional — we
   * rebuild + restart even when already at the target sha): `resetHard` moves a
   * submodule's gitlink but not its working tree, and an already-current box may
   * never have inited the submodule, yet `flutter build web` needs the path-deps
   * (repo-root third_party/glass_goals) on disk either way. Idempotent +
   * a fast no-op when in sync.
   */
  updateSubmodules(): Promise<void>;
}

/** Install + build with per-step hard timeouts; manages the build-complete sentinel. */
export interface BuildSeam {
  /** Build the checkout at `sha`. Throws {@link StepError} on failure/timeout. */
  build(sha: string): Promise<void>;
}

/** The in-memory graceful-shutdown brake + a self-excluding, bounded drain. */
export interface DrainSeam {
  /** Engage `gracefulShutdown` (direct call) so the mesh stops STARTING new runs. */
  engage(reason: string): void;
  /** Lift it again — only used if we abort after engaging. */
  cancel(): void;
  /**
   * Wait until no OTHER actor is executing a run (self-excluded — the tool runs in
   * root's own run, so "wait until empty" would deadlock on self), or until
   * `timeoutMs`. Always resolves by the deadline.
   */
  waitForQuiescence(timeoutMs: number): Promise<{ quiesced: boolean; waitedMs: number }>;
}

/** Outbound failure notice sink (best-effort; never sinks the result). */
export interface NotifySeam {
  notify(text: string): Promise<void>;
}

export interface UpdateDeps {
  git: GitSeam;
  build: BuildSeam;
  drain: DrainSeam;
  /** Best-effort failure notice (root also gets the result string). Optional. */
  notify?: NotifySeam;
  /**
   * Chat-INDEPENDENT durable alert sink (a marker file) for the worst, unrecoverable
   * states — e.g. a failed rollback that leaves the system restart-fragile. Wired in
   * `start.ts` to `<mcHome>/alerts/last-failure.txt` (the same file the boot-flap
   * alert writes), so a signal survives even if chat creds/network are down. Optional.
   */
  alertMarker?: (text: string) => void;
  /** Durable record for executed actions (provenance). */
  recordAction?: (text: string) => void;
  /** Injected `process.exit` seam so tests assert the exit without dying. */
  exit: (code: number) => void;
  log?: (msg: string) => void;
}

export interface UpdatePlan {
  /** The only branch we ever deploy. */
  branch: string;
  /** Bounded drain wait, in ms. */
  drainTimeoutMs: number;
}

export interface UpdateResult {
  ok: boolean;
  failedStep?: UpdateStep;
  error?: string;
  timedOut?: boolean;
  oldSha: string;
  newSha?: string;
  subject?: string;
  alreadyCurrent?: boolean;
  /** True once we've engaged drain + called exit(0) (the restart path). */
  restarting: boolean;
  /**
   * Set when the post-failure git rollback ALSO failed — git HEAD ≠ the live
   * dist/sentinel, so the next restart would refuse boot. Surfaced loudly (journal +
   * marker + chat) and reported so the caller knows the system is restart-fragile.
   */
  rollbackFailed?: boolean;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function updateStatusText(sha: string, subject: string): string {
  return `🔄 Updating → ${shortSha(sha)} (${subject}) — draining + restarting`;
}

let isUpdating = false;

/**
 * Run the update. Returns a structured result (never throws): a failed/hung build
 * rolls the checkout back to the old sha, reports ❌, and leaves the mesh running
 * on the old in-memory code. A green build engages the brake, drains, and exits.
 */
export async function executeUpdate(plan: UpdatePlan, deps: UpdateDeps): Promise<UpdateResult> {
  if (isUpdating) {
    return {
      ok: false,
      failedStep: "pull",
      error: "Refused: update already in progress.",
      oldSha: await deps.git.headSha(),
      restarting: false,
    };
  }
  isUpdating = true;
  const log = deps.log ?? (() => {});
  let step: UpdateStep = "pull";
  let oldSha = "";
  let movedToNew = false;
  let rollbackFailed = false;

  try {
    // ── 1. PULL (mesh fully LIVE) ─────────────────────────────────────────
    step = "pull";
    oldSha = await deps.git.headSha();
    log(`[update] current sha ${shortSha(oldSha)} — fetching origin ${plan.branch}`);
    await deps.git.fetch(plan.branch);
    const newSha = await deps.git.remoteSha(plan.branch);
    const alreadyCurrent = newSha === oldSha;
    if (alreadyCurrent) {
      log(`[update] already at origin/${plan.branch} @ ${shortSha(newSha)}`);
      return {
        ok: false,
        failedStep: "pull",
        error: `Refused: already deployed (origin/${plan.branch} tip ${newSha} matches deployed SHA ${oldSha})`,
        oldSha,
        alreadyCurrent: true,
        restarting: false,
      };
    } else {
      const recordMsg = `update authorized/attempted by root (trigger: MCP tool, target SHA: ${newSha})`;
      deps.recordAction?.(recordMsg);
      log(`[update] resetting checkout to ${shortSha(newSha)}`);
      await deps.git.resetHard(newSha);
      movedToNew = true;
      if (deps.notify) {
        try {
          await deps.notify.notify(`🚀 ${recordMsg}`);
        } catch {}
      }
    }
    // Materialize submodules before EVERY build — the build below is unconditional
    // (we rebuild + restart even when already-current), so its prerequisite must be
    // too. `resetHard` moves a submodule's gitlink but not its working tree, and an
    // already-current box may never have inited the submodule; either way
    // `flutter build web` needs repo-root third_party/glass_goals on disk. Idempotent + a fast
    // no-op when in sync.
    await deps.git.updateSubmodules();
    log(`[update] submodules updated (--init --recursive)`);
    const subject = await deps.git.subject(newSha);

    // ── 2. BUILD (still LIVE; per-step hard timeouts; sentinel managed) ───
    step = "build";
    log(`[update] building ${shortSha(newSha)} (mesh stays live)…`);
    await deps.build.build(newSha);
    log(`[update] build green`);

    // ── 3. GATE passed → quiesce + restart. Only now do we touch run-state. ─
    step = "drain";
    if (deps.notify) {
      try {
        await deps.notify.notify(updateStatusText(newSha, subject));
      } catch (nErr) {
        log(`[update] notify failed: ${nErr instanceof Error ? nErr.message : String(nErr)}`);
      }
    }
    deps.drain.engage("update: draining for restart");
    log(`[update] gracefulShutdown engaged — draining other actors`);
    const drain = await deps.drain.waitForQuiescence(plan.drainTimeoutMs);
    log(
      `[update] drained after ${drain.waitedMs}ms` +
        (drain.quiesced ? " (quiesced)" : " (timeout — proceeding)")
    );

    // ── 4. EXIT — systemd restarts onto the fresh build. ─────────────────
    log(`[update] exit(0) → systemd restart onto ${shortSha(newSha)} (${subject})`);
    deps.exit(0);
    return {
      ok: true,
      oldSha,
      newSha,
      subject,
      alreadyCurrent,
      restarting: true,
    };
  } catch (err) {
    const isStep = err instanceof StepError;
    const failedStep = (isStep ? (err.step as UpdateStep) : step) ?? step;
    const timedOut = isStep ? err.timedOut : false;
    const error = err instanceof Error ? err.message : String(err);
    log(`[update] FAILED at ${failedStep}${timedOut ? " (timeout)" : ""}: ${error}`);

    // Fail-safe: roll the checkout back so a retry starts clean from old code.
    if (movedToNew && oldSha) {
      try {
        await deps.git.resetHard(oldSha);
        log(`[update] rolled checkout back to ${shortSha(oldSha)}`);
      } catch (rbErr) {
        const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
        log(`[update] WARNING: rollback to ${shortSha(oldSha)} failed: ${rbMsg}`);
        rollbackFailed = true;
        // The last silent-failure path: git is now at the new sha while the live
        // dist+sentinel are still old → sentinel ≠ HEAD → the next restart REFUSES
        // boot (the fragility window reopened). The process is still alive, so SHOUT
        // — the same loud, chat-independent path as the boot-flap alert.
        const alert =
          `⚠️ update rollback FAILED (${rbMsg}) — git HEAD≠dist/sentinel; ` +
          `system is restart-fragile, recover before any restart`;
        console.error(`[update] ${alert}`); // journal ERROR — always, chat-independent
        try {
          deps.alertMarker?.(alert); // durable marker file
        } catch {
          /* best-effort */
        }
        if (deps.notify) {
          try {
            await deps.notify.notify(alert); // best-effort chat
          } catch {
            /* best-effort */
          }
        }
      }
    }
    const msg = `❌ update failed at ${failedStep}${timedOut ? " (timed out)" : ""}: ${error} — staying on ${shortSha(oldSha)}`;
    if (deps.notify) {
      try {
        await deps.notify.notify(msg);
      } catch (nErr) {
        log(`[update] notify failed: ${nErr instanceof Error ? nErr.message : String(nErr)}`);
      }
    }
    return {
      ok: false,
      failedStep,
      error,
      timedOut,
      oldSha,
      restarting: false,
      rollbackFailed,
    };
  } finally {
    isUpdating = false;
  }
}
