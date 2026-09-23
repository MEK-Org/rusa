import { type Logger, nullLogger } from "../../observability/logger.js";
import type { FollowerInfo } from "./follower-hub.js";
import type {
  FollowerUpdateAttempt,
  FollowerUpdateTrigger,
  FollowerUpdateTriggerStore,
} from "./follower-update-trigger-store.js";
import { isFullCommitSha } from "./follower-update-validation.js";
import type { FollowerUpdateStatus } from "./protocol.js";
import { ACTIVE_UPDATE_PHASES } from "./remote-instance.js";

export interface ReconcilerHub {
  list(): FollowerInfo[];
  updateFollower(
    followerId: string,
    options?: { targetSha?: string; branch?: string }
  ): FollowerUpdateStatus;
  onRegister(
    callback: (follower: {
      id: string;
      commitSha?: string;
      updateStatus?: FollowerUpdateStatus;
    }) => void
  ): () => void;
  onUpdateStatus?(callback: (followerId: string, status: FollowerUpdateStatus) => void): () => void;
}

export interface FollowerUpdateReconcilerOptions {
  logger?: Logger;
}

export interface ReconciliationStatus {
  /** "none" = no trigger is present; "active" = outstanding. */
  state: "none" | "active";
  activeTrigger: FollowerUpdateTrigger | null;
  /** Every follower currently connected is on the target. Says nothing about offline ones. */
  allConnectedCurrent: boolean;
  /** Whether the leader has finished booting and automatic dispatch is permitted. */
  armed: boolean;
}

export class FollowerUpdateReconciler {
  private readonly log: Logger;
  private unregisterCallbacks: (() => void)[] = [];
  private armed = false;

  constructor(
    private readonly store: FollowerUpdateTriggerStore,
    private readonly hub: ReconcilerHub,
    opts?: FollowerUpdateReconcilerOptions
  ) {
    this.log = (opts?.logger ?? nullLogger).child({ component: "follower-reconciler" });

    const unreg = this.hub.onRegister((follower) => {
      this.onFollowerRegistered(follower);
    });
    this.unregisterCallbacks.push(unreg);

    if (typeof this.hub.onUpdateStatus === "function") {
      const unregStatus = this.hub.onUpdateStatus((followerId, status) => {
        this.onFollowerUpdateStatus(followerId, status);
      });
      this.unregisterCallbacks.push(unregStatus);
    }
  }

  close(): void {
    for (const unreg of this.unregisterCallbacks) {
      try {
        unreg();
      } catch {
        /* best-effort */
      }
    }
    this.unregisterCallbacks = [];
  }

  getActiveTrigger(): FollowerUpdateTrigger | null {
    return this.store.getActiveTrigger();
  }

  /**
   * Reconciliation state for operators.
   *
   * `state` distinguishes whether an active trigger is present ("active") or not ("none").
   * `allConnectedCurrent` is an observation about the followers the leader can currently
   * see — it is deliberately not a claim about every enrolled follower, because the leader
   * has no durable roster.
   */
  getStatus(): ReconciliationStatus {
    const trigger = this.store.getActiveTrigger();
    if (!trigger) {
      return {
        state: "none",
        activeTrigger: null,
        allConnectedCurrent: false,
        armed: this.armed,
      };
    }
    return {
      state: "active",
      activeTrigger: trigger,
      allConnectedCurrent: this.store.allCurrent(this.hub.list().map((f) => f.id)),
      armed: this.armed,
    };
  }

  /**
   * Allow automatic reconciliation to dispatch.
   *
   * Held back until the leader has finished booting, so an automatic update cannot move
   * followers onto a revision that killed the leader that promoted it. A follower that
   * registers before this point is not lost: arming reconciles everyone then connected.
   */
  arm(): void {
    if (this.armed) return;
    this.armed = true;
    this.log.info("follower_reconciliation_armed");
    this.reconcileAll();
  }

  reconcileAll(): void {
    if (!this.armed) {
      this.log.debug?.("follower_reconciliation_deferred_not_armed");
      return;
    }
    const trigger = this.store.getActiveTrigger();
    if (!trigger) return;

    // A normal update ends by restarting the follower, so its replacement registration
    // is the success signal. Observe those registrations before looking for work: that
    // is what releases the next follower after a successful automatic update.
    const followers = this.hub.list();
    for (const follower of followers) {
      this.recordCurrentFollower(follower, trigger);
    }

    // recordCurrentFollower() persists a terminal attempt. Reload before consulting the
    // durable gate so a replacement leader does not keep waiting on a pending attempt it
    // just resolved from the follower's registration.
    const refreshedTrigger = this.store.getActiveTrigger();
    if (!refreshedTrigger) return;

    // `pending` is durable single-flight state. It survives a leader replacement, where
    // the replacement cannot know whether the former leader's command is still draining
    // or restarting on its follower. Dispatching another automatic update there would
    // turn that uncertainty into a parallel rollout, so wait for its terminal outcome.
    const pendingFollowerId = this.pendingAutomaticFollower(refreshedTrigger);
    if (pendingFollowerId) {
      this.log.debug?.("follower_update_reconciliation_waiting_for_terminal_status", {
        followerId: pendingFollowerId,
        targetSha: refreshedTrigger.targetSha,
      });
      this.reportIfAllCurrent();
      return;
    }

    for (const follower of followers) {
      if (this.reconcileFollower(follower, refreshedTrigger)) return;
    }
    this.reportIfAllCurrent();
  }

  reconcileFollower(
    follower: { id: string; commitSha?: string; updateStatus?: FollowerUpdateStatus },
    trigger?: FollowerUpdateTrigger | null
  ): boolean {
    if (!this.armed) {
      this.log.debug?.("follower_reconciliation_deferred_not_armed", { followerId: follower.id });
      return false;
    }
    const activeTrigger = trigger ?? this.store.getActiveTrigger();
    if (!activeTrigger) return false;

    // Follower already on the target SHA.
    if (this.recordCurrentFollower(follower, activeTrigger)) return false;

    // A terminal already_current status can arrive before the next registration
    // refreshes commitSha. Its durable success record is still terminal for this target.
    if (this.store.hasSucceeded(follower.id, activeTrigger.targetSha)) return false;

    // A previous automatic command has not yet reached a terminal outcome. This canonical
    // gate check ensures single-flight serialization across all callers to reconcileFollower().
    if (this.pendingAutomaticFollower(activeTrigger)) return false;

    // Fail-stop loop prevention: do NOT retry automatically if this follower previously failed for this targetSha
    if (this.store.hasFailed(follower.id, activeTrigger.targetSha)) {
      this.log.info("follower_update_skipped_prior_failure", {
        followerId: follower.id,
        targetSha: activeTrigger.targetSha,
      });
      return false;
    }

    // Do not dispatch if an update is already actively running on the follower
    if (follower.updateStatus && ACTIVE_UPDATE_PHASES.has(follower.updateStatus.status)) {
      this.log.debug?.("follower_update_in_progress_skipped", {
        followerId: follower.id,
        status: follower.updateStatus.status,
      });
      return false;
    }

    // Record `pending` before dispatching so the durable single-flight gate is persisted
    // before the command is enqueued on the follower. If the leader crashes during or
    // immediately after dispatch, a replacement leader sees the in-flight gate and waits.
    // If dispatch throws, the catch block overwrites `pending` with `failed`.
    const attempt: FollowerUpdateAttempt = {
      status: "pending",
      targetSha: activeTrigger.targetSha,
      lastAttemptAt: new Date().toISOString(),
    };
    this.store.recordAttempt(follower.id, attempt);
    try {
      this.hub.updateFollower(follower.id, {
        targetSha: activeTrigger.targetSha,
        branch: activeTrigger.branch,
      });
      this.log.info("follower_update_reconciliation_triggered", {
        followerId: follower.id,
        targetSha: activeTrigger.targetSha,
        branch: activeTrigger.branch,
      });
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.store.recordFailure(follower.id, activeTrigger.targetSha, error);
      this.log.warn("follower_update_reconciliation_dispatch_error", {
        followerId: follower.id,
        targetSha: activeTrigger.targetSha,
        error,
      });
      return false;
    }
  }

  onFollowerRegistered(follower: {
    id: string;
    commitSha?: string;
    updateStatus?: FollowerUpdateStatus;
  }): void {
    if (!this.armed) {
      this.log.debug?.("follower_reconciliation_deferred_not_armed", { followerId: follower.id });
      return;
    }
    const trigger = this.store.getActiveTrigger();
    if (!trigger) return;

    this.recordCurrentFollower(follower, trigger);
    this.reconcileAll();
  }

  onFollowerUpdateStatus(followerId: string, status: FollowerUpdateStatus): void {
    const trigger = this.store.getActiveTrigger();
    if (!trigger) return;

    const pendingFollowerId = this.pendingAutomaticFollower(trigger);
    // A failure before fetch resolves the target reports an empty newSha. Persisting
    // that as an attempt target would invalidate the trigger document and leave the
    // single-flight gate stuck, so use the authoritative automatic target instead.
    const reportedTargetSha = status.newSha;
    const targetSha =
      reportedTargetSha !== undefined && isFullCommitSha(reportedTargetSha)
        ? reportedTargetSha
        : trigger.targetSha;
    // Manual /followers/:id/update calls intentionally do not create a pending
    // automatic attempt. When the pending automatic follower reports a terminal
    // outcome (even against an overridden target), its attempt slot is no longer
    // pending, releasing the single-flight gate to advance the queue.
    const releasesAutomaticQueue = pendingFollowerId === followerId;

    if (status.status === "failed") {
      this.store.recordFailure(followerId, targetSha, status.error);
      this.log.warn("follower_update_reconciliation_failure", {
        followerId,
        targetSha,
        error: status.error,
      });
      if (releasesAutomaticQueue) this.reconcileAll();
    } else if (status.status === "already_current") {
      this.store.recordSuccess(followerId, targetSha);
      this.log.info("follower_update_reconciliation_already_current", {
        followerId,
        targetSha,
      });
      if (releasesAutomaticQueue) this.reconcileAll();
      else this.reportIfAllCurrent();
    }
  }

  /** Records a restart-confirmed success and tells the caller whether the follower is current. */
  private recordCurrentFollower(
    follower: { id: string; commitSha?: string },
    trigger: FollowerUpdateTrigger
  ): boolean {
    if (follower.commitSha !== trigger.targetSha) return false;
    if (!this.store.hasSucceeded(follower.id, trigger.targetSha)) {
      this.store.recordSuccess(follower.id, trigger.targetSha);
      this.log.info("follower_already_on_target_sha", {
        followerId: follower.id,
        targetSha: trigger.targetSha,
      });
    }
    return true;
  }

  /** The one automatic command whose terminal outcome must be observed before another starts. */
  private pendingAutomaticFollower(trigger: FollowerUpdateTrigger): string | null {
    for (const [followerId, attempt] of Object.entries(trigger.attempts)) {
      if (attempt.status === "pending" && attempt.targetSha === trigger.targetSha) {
        return followerId;
      }
    }
    return null;
  }

  /**
   * Report — but do not act on — every currently connected follower being current.
   *
   * This deliberately does not complete the trigger. The connected set is not a subset of
   * a known roster (the leader keeps none), so treating it as exhaustive would close the
   * trigger while an offline follower still needed it, which is the one case the durable
   * document exists for. The trigger instead stays active until the next leader update
   * supersedes it.
   */
  private reportIfAllCurrent(): void {
    const followers = this.hub.list();
    if (followers.length === 0) return;
    const ids = followers.map((f) => f.id);
    if (this.store.allCurrent(ids)) {
      this.log.info("follower_reconciliation_all_connected_current", {
        followerCount: ids.length,
      });
    }
  }
}
