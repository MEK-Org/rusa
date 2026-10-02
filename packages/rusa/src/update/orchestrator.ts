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
export type UpdateStep = "pull" | "install" | "typecheck" | "build" | "coordinator" | "drain";

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
   * --init --recursive`). Runs before EVERY build: `resetHard` moves a
   * submodule's gitlink but not its working tree, and an already-current box may
   * never have inited the submodule, yet `flutter build web` needs the path-deps
   * (repo-root third_party/glass_goals_devkit) on disk either way. Idempotent +
   * a fast no-op when in sync.
   */
  updateSubmodules(): Promise<void>;
}

/** Install + build with per-step hard timeouts; manages the build-complete sentinel. */
export interface BuildSeam {
  /** Build the checkout at `sha`. Throws {@link StepError} on failure/timeout. */
  build(sha: string): Promise<void>;
  /**
   * Restore the previously bootable dist after a post-build deployment failure.
   * Production BuildRunner supplies this. Isolated legacy seams that cannot
   * promote a dist leave it absent and fail closed if a post-build rollback is
   * ever needed.
   */
  rollback?(): Promise<void>;
}

/** The installed pool coordinator unit that this checkout's build runs. */
export interface CoordinatorTarget {
  unit: string;
  /** The coordinator's own home, read from its effective unit settings. */
  home: string;
  /** The socket that coordinator listens on, resolved from its own home. */
  socketPath: string;
}

/**
 * Whether this deployment built what the pool unit launches. Only `owner`
 * refreshes; `not-owner` is a client of a coordinator another checkout owns;
 * `unknown` is reported as such and never treated as either.
 */
export type CoordinatorOwnership =
  | { ownership: "owner"; target: CoordinatorTarget }
  | { ownership: "not-owner" | "unknown"; reason: string };

/**
 * Refresh the single pool coordinator when, and only when, this deployment
 * owns its executable. Restarting a coordinator this update did not build
 * would load an artifact nobody verified.
 */
export interface CoordinatorRestartSeam {
  /** Who owns the launched executable. Total: undecidable ownership is `unknown`. */
  resolve(): Promise<CoordinatorOwnership>;
  /**
   * The revision recorded by the artifact the owned unit would launch now —
   * this checkout's live dist sentinel — or null when it records none.
   */
  artifactRevision(): string | null;
  /** The revision the running coordinator reports loaded, or null when it cannot say. */
  loadedRevision(target: CoordinatorTarget): Promise<string | null>;
  /**
   * The revision reported by the coordinator this instance dials, for the
   * report when it does not own the unit. Never an input to ownership; null
   * when it dials none or that coordinator cannot say.
   */
  dialedRevision(): Promise<string | null>;
  /** The runbook's pre-restart database backup. Throws to refuse the restart. */
  backup(target: CoordinatorTarget): Promise<void>;
  /** Restart the unit and require its readyz to report `expectedRevision`. */
  restart(target: CoordinatorTarget, expectedRevision: string): Promise<void>;
}

/** What the update did about the pool coordinator, for the result and the action log. */
export type CoordinatorRefresh =
  | {
      outcome: "not-owner" | "unknown";
      reason: string;
      /** What the dialed coordinator reports loaded; a difference from this build is drift. */
      loadedRevision: string | null;
    }
  | {
      /**
       * The owned coordinator's loaded artifact is not the one the build would
       * retain, or either cannot be identified, so a failed refresh could not
       * return to it. The update stopped before building or restarting.
       */
      outcome: "rollback-unavailable";
      reason: string;
      loadedRevision: string | null;
      /** The live dist sentinel the build would retain as its rollback artifact. */
      artifactRevision: string | null;
    }
  | {
      /**
       * `refreshed`: confirmed on the new build. `restored`: confirmed back on
       * the artifact it had loaded before. `degraded`: confirmed on the
       * retained artifact, which no longer matched what it had loaded before.
       */
      outcome: "refreshed" | "restored" | "degraded";
      /** What the coordinator reported before this update restarted it (null: it could not say). */
      previousLoadedRevision: string | null;
      /** What readyz confirmed after the restart. */
      loadedRevision: string;
    };

function describeCoordinator(refresh: CoordinatorRefresh): string {
  if (refresh.outcome === "rollback-unavailable") {
    const id = (sha: string | null) => (sha ? shortSha(sha) : "unknown");
    return (
      `not refreshed, rollback protection unavailable: ${refresh.reason}; ` +
      `loaded ${id(refresh.loadedRevision)}, retained artifact ${id(refresh.artifactRevision)}`
    );
  }
  if ("reason" in refresh) {
    const why = refresh.outcome === "not-owner" ? "not owned" : "ownership unknown";
    const loaded = refresh.loadedRevision
      ? `loaded ${shortSha(refresh.loadedRevision)}`
      : "loaded revision unknown";
    return `not refreshed, ${why}: ${refresh.reason}; ${loaded}`;
  }
  const was = refresh.previousLoadedRevision ? shortSha(refresh.previousLoadedRevision) : "unknown";
  return `${refresh.outcome} to ${shortSha(refresh.loadedRevision)} (previously loaded ${was})`;
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
  /** Required in deployed startup wiring; optional for isolated legacy callers. */
  coordinator?: CoordinatorRestartSeam;
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
  /**
   * Fires after the update is committed and drained, immediately before the restart exit.
   *
   * Deliberately not at build-green: a failure in a later step rolls the checkout back to
   * `oldSha`, and anything persisted at build time would then point at a revision this
   * leader reverted. By the time this runs there is no rollback left to contradict it.
   */
  onCommitted?: (newSha: string, branch: string) => Promise<void> | void;
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
  /** The pool coordinator outcome, when the update reached that step. */
  coordinator?: CoordinatorRefresh;
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

export interface FormatFailureParams {
  failedStep: string;
  timedOut: boolean;
  error: string;
  movedToNew: boolean;
  rollbackFailed: boolean;
  oldSha?: string;
  newSha?: string;
}

export function formatFailureOutcome(params: FormatFailureParams): string {
  const { failedStep, timedOut, error, movedToNew, rollbackFailed, oldSha, newSha } = params;
  let locationSummary: string;
  if (movedToNew) {
    if (rollbackFailed) {
      locationSummary = `rollback FAILED, checkout state UNKNOWN/UNSAFE (update target ${newSha ? shortSha(newSha) : "unknown"}; attempted rollback to ${oldSha ? shortSha(oldSha) : "unknown"})`;
    } else {
      locationSummary = `rolled back, staying on ${oldSha ? shortSha(oldSha) : "unknown"}`;
    }
  } else {
    locationSummary = `no rollback needed, staying on ${oldSha ? shortSha(oldSha) : "unknown"}`;
  }
  return `update failed at ${failedStep}${timedOut ? " (timeout)" : ""}: ${error} [${locationSummary}]`;
}

let isUpdating = false;

/**
 * Run the update. Returns a structured result (never throws): a failed/hung build
 * rolls the checkout back to the old sha, reports ❌, and leaves the mesh running
 * on the old in-memory code. A green build engages the brake, drains, and exits.
 */
export async function executeUpdate(plan: UpdatePlan, deps: UpdateDeps): Promise<UpdateResult> {
  if (isUpdating) {
    const head = await deps.git.headSha();
    const refusalMsg = `update refused: already in progress (current SHA: ${shortSha(head)})`;
    try {
      deps.recordAction?.(refusalMsg);
    } catch (recErr) {
      const log = deps.log ?? (() => {});
      log(
        `[update] recordAction failed: ${recErr instanceof Error ? recErr.message : String(recErr)}`
      );
    }
    return {
      ok: false,
      failedStep: "pull",
      error: "Refused: update already in progress.",
      oldSha: head,
      restarting: false,
    };
  }
  isUpdating = true;
  const log = deps.log ?? (() => {});
  let step: UpdateStep = "pull";
  let oldSha = "";
  let newSha = "";
  let movedToNew = false;
  let builtNew = false;
  let coordinatorTarget: CoordinatorTarget | undefined;
  let coordinatorRestarted = false;
  let previousLoadedRevision: string | null = null;
  let coordinator: CoordinatorRefresh | undefined;
  let rollbackFailed = false;

  try {
    // ── 1. PULL (mesh fully LIVE) ─────────────────────────────────────────
    step = "pull";
    oldSha = await deps.git.headSha();
    log(`[update] current sha ${shortSha(oldSha)} — fetching origin ${plan.branch}`);
    await deps.git.fetch(plan.branch);
    newSha = await deps.git.remoteSha(plan.branch);
    const alreadyCurrent = newSha === oldSha;
    if (alreadyCurrent) {
      log(`[update] already at origin/${plan.branch} @ ${shortSha(newSha)}`);
      const refusalMsg = `update refused: already deployed (origin/${plan.branch} tip ${shortSha(newSha)} matches deployed SHA ${shortSha(oldSha)})`;
      try {
        deps.recordAction?.(refusalMsg);
      } catch (recErr) {
        log(
          `[update] recordAction failed: ${recErr instanceof Error ? recErr.message : String(recErr)}`
        );
      }
      return {
        ok: false,
        failedStep: "pull",
        error: `Refused: already deployed (origin/${plan.branch} tip ${newSha} matches deployed SHA ${oldSha}; note: a green update restarts the daemon, causing an expected MCP transport disconnect)`,
        oldSha,
        alreadyCurrent: true,
        restarting: false,
      };
    } else {
      const recordMsg = `update authorized/attempted by root (trigger: MCP tool, target SHA: ${newSha})`;
      try {
        deps.recordAction?.(recordMsg);
      } catch (recErr) {
        log(
          `[update] recordAction failed: ${recErr instanceof Error ? recErr.message : String(recErr)}`
        );
      }
      // The coordinator decision comes before anything destructive. The build's
      // swap retires the live dist to dist.old and deletes the previous
      // dist.old, so the live dist is the only artifact a failed refresh can
      // return to. Unless it is verifiably the artifact the coordinator has
      // loaded, stop here: nothing has been moved, built, or restarted.
      if (deps.coordinator) {
        step = "coordinator";
        const resolved = await deps.coordinator.resolve();
        if (resolved.ownership !== "owner") {
          coordinator = {
            outcome: resolved.ownership,
            reason: resolved.reason,
            loadedRevision: await deps.coordinator.dialedRevision(),
          };
          log(
            `[update] pool coordinator ${describeCoordinator(coordinator)}` +
              (coordinator.loadedRevision && coordinator.loadedRevision !== newSha
                ? ` (drift from this build ${shortSha(newSha)}; not a rollback trigger)`
                : "")
          );
        } else {
          const retained = deps.coordinator.artifactRevision();
          previousLoadedRevision = await deps.coordinator.loadedRevision(resolved.target);
          if (!previousLoadedRevision || retained !== previousLoadedRevision) {
            coordinator = {
              outcome: "rollback-unavailable",
              reason: !previousLoadedRevision
                ? "the running coordinator does not report its loaded revision"
                : retained
                  ? "the live dist is not the artifact the coordinator has loaded"
                  : "the live dist records no valid revision",
              loadedRevision: previousLoadedRevision,
              artifactRevision: retained,
            };
            throw new Error(`rollback protection unavailable: ${coordinator.reason}`);
          }
          coordinatorTarget = resolved.target;
        }
        step = "pull";
      }
      log(`[update] resetting checkout to ${shortSha(newSha)}`);
      await deps.git.resetHard(newSha);
      movedToNew = true;
      if (deps.notify) {
        try {
          await deps.notify.notify(`🚀 ${recordMsg}`);
        } catch {}
      }
    }
    // Materialize submodules before EVERY build: `resetHard` moves a
    // submodule's gitlink but not its working tree, and an
    // already-current box may never have inited the submodule; either way
    // `flutter build web` needs repo-root third_party/glass_goals_devkit on disk. Idempotent + a fast
    // no-op when in sync.
    await deps.git.updateSubmodules();
    log(`[update] submodules updated (--init --recursive)`);
    const subject = await deps.git.subject(newSha);

    // ── 2. BUILD (still LIVE; per-step hard timeouts; sentinel managed) ───
    step = "build";
    log(`[update] building ${shortSha(newSha)} (mesh stays live)…`);
    await deps.build.build(newSha);
    builtNew = true;
    log(`[update] build green`);

    // The coordinator is a distinct, pool-owned process. Its module cache does
    // not change when this instance's checkout moves, so refresh it before the
    // mesh drain. The seam verifies the coordinator reports the build revision
    // it loaded; a successful systemctl invocation alone is not sufficient.
    if (deps.coordinator && coordinatorTarget) {
      step = "coordinator";
      const target = coordinatorTarget;
      const built = deps.coordinator.artifactRevision();
      if (built !== newSha) {
        throw new Error(
          `the coordinator artifact records ${built ? shortSha(built) : "no valid revision"}, ` +
            `not the built ${shortSha(newSha)}; refusing to restart onto it`
        );
      }
      // The preflight's assurance holds only while the coordinator still runs
      // the artifact now retained at dist.old.
      const loadedNow = await deps.coordinator.loadedRevision(target);
      if (loadedNow !== previousLoadedRevision) {
        throw new Error(
          `the coordinator's loaded revision changed during the build ` +
            `(${loadedNow ? shortSha(loadedNow) : "unknown"}, was ${shortSha(previousLoadedRevision ?? "")}); ` +
            `refusing to restart it`
        );
      }
      await deps.coordinator.backup(target);
      log(`[update] pre-restart quota backup taken; restarting ${target.unit}`);
      coordinatorRestarted = true;
      await deps.coordinator.restart(target, built);
      coordinator = { outcome: "refreshed", previousLoadedRevision, loadedRevision: built };
      log(`[update] pool coordinator ${describeCoordinator(coordinator)}`);
    }

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
    const drainSummary = drain.quiesced ? "quiesced" : `timeout after ${drain.waitedMs}ms`;
    try {
      deps.recordAction?.(
        `update committed: ${shortSha(oldSha)} → ${shortSha(newSha)} (${subject}) [drain: ${drainSummary}]` +
          (coordinator ? ` [coordinator: ${describeCoordinator(coordinator)}]` : "") +
          " — restarting"
      );
    } catch (recErr) {
      log(
        `[update] recordAction failed: ${recErr instanceof Error ? recErr.message : String(recErr)}`
      );
    }
    if (deps.onCommitted) {
      // Best-effort: the restart is already committed and irreversible, so a failure here
      // costs one skipped automatic reconciliation, not a failed update. The manual
      // follower-update path stays available either way.
      try {
        await deps.onCommitted(newSha, plan.branch);
      } catch (hookErr) {
        log(
          `[update] onCommitted hook failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`
        );
      }
    }

    log(`[update] exit(0) → systemd restart onto ${shortSha(newSha)} (${subject})`);
    deps.exit(0);
    return {
      ok: true,
      oldSha,
      newSha,
      subject,
      alreadyCurrent,
      coordinator,
      restarting: true,
    };
  } catch (err) {
    const isStep = err instanceof StepError;
    const failedStep = (isStep ? (err.step as UpdateStep) : step) ?? step;
    const timedOut = isStep ? err.timedOut : false;
    const error = err instanceof Error ? err.message : String(err);
    log(`[update] FAILED at ${failedStep}${timedOut ? " (timeout)" : ""}: ${error}`);

    // Fail-safe: restore the bootable dist before moving checkout HEAD back.
    // A green build has already atomically promoted a matching dist/sentinel;
    // resetting only git after a coordinator restart failure would leave the
    // next systemd boot correctly refusing the mismatched pair.
    if (movedToNew && oldSha) {
      try {
        if (builtNew) {
          if (!deps.build.rollback) {
            throw new Error("cannot restore previous dist: build seam has no post-build rollback");
          }
          await deps.build.rollback();
          log(`[update] restored previous dist before checkout rollback`);
        }
        await deps.git.resetHard(oldSha);
        log(`[update] rolled checkout back to ${shortSha(oldSha)}`);

        // A restart command can fail after it has stopped or even started the
        // unit. Once dist and checkout are restored, restart the coordinator onto
        // the restored artifact so the pool does not keep a new in-memory
        // coordinator beside an old deploy. The preflight established that this
        // artifact is the one the coordinator had loaded; readyz must confirm
        // the restored dist's own sentinel. Should that sentinel no longer
        // match, the restart onto it is degraded recovery, never a restore, and
        // is surfaced as rollback-unsafe. An artifact with no identity cannot be
        // verified, so it is not restarted onto at all. Any failure is surfaced
        // as rollback-unsafe; that includes a new build that already migrated
        // the quota schema, whose recovery is the runbook's restore from the
        // pre-restart backup.
        if (coordinatorRestarted && coordinatorTarget && deps.coordinator) {
          const restored = deps.coordinator.artifactRevision();
          if (!restored) {
            throw new Error(
              "coordinator rollback not attempted: the restored dist records no valid revision"
            );
          }
          try {
            await deps.coordinator.restart(coordinatorTarget, restored);
          } catch (restoreCoordinatorErr) {
            throw new Error(
              `coordinator rollback to ${shortSha(restored)} failed: ` +
                `${restoreCoordinatorErr instanceof Error ? restoreCoordinatorErr.message : String(restoreCoordinatorErr)}`
            );
          }
          const outcome = restored === previousLoadedRevision ? "restored" : "degraded";
          coordinator = { outcome, previousLoadedRevision, loadedRevision: restored };
          log(`[update] pool coordinator ${describeCoordinator(coordinator)}`);
          if (outcome === "degraded") {
            throw new Error(
              `coordinator recovered onto retained ${shortSha(restored)}, not the previously ` +
                `loaded ${previousLoadedRevision ? shortSha(previousLoadedRevision) : "unknown"}`
            );
          }
        }
      } catch (rbErr) {
        const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
        log(`[update] WARNING: rollback to ${shortSha(oldSha)} failed: ${rbMsg}`);
        rollbackFailed = true;
        // The last silent-failure path: either the checkout/dist pair or the
        // separately restarted coordinator may now disagree with the restored
        // deployment. The process is still alive, so SHOUT — the same loud,
        // chat-independent path as the boot-flap alert.
        const alert =
          `⚠️ update rollback FAILED (${rbMsg}) — deployment state may be split; ` +
          `system is restart-fragile, recover before any restart`;
        console.error(`[update] ${alert}`); // journal ERROR — always, chat-independent
        try {
          deps.alertMarker?.(alert); // durable marker file
        } catch {
          /* best-effort marker */
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
    const failureSummary =
      formatFailureOutcome({
        failedStep,
        timedOut,
        error,
        movedToNew,
        rollbackFailed,
        oldSha,
        newSha,
      }) + (coordinator ? ` [coordinator: ${describeCoordinator(coordinator)}]` : "");
    try {
      deps.recordAction?.(failureSummary);
    } catch (recErr) {
      log(
        `[update] recordAction failed: ${recErr instanceof Error ? recErr.message : String(recErr)}`
      );
    }
    const msg = `❌ ${failureSummary}`;
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
      coordinator,
      restarting: false,
      rollbackFailed,
    };
  } finally {
    isUpdating = false;
  }
}
