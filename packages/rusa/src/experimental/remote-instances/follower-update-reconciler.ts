import { type Logger, nullLogger } from "../../observability/logger.js";
import type { FollowerInfo } from "./follower-hub.js";
import type {
  FollowerUpdateAttempt,
  FollowerUpdateTrigger,
  FollowerUpdateTriggerStore,
} from "./follower-update-trigger-store.js";
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
  /** "none" = no trigger was ever written; "active" = outstanding; "completed" = closed out. */
  state: "none" | "active" | "completed";
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
   * `state` distinguishes the three situations that a single `completed` boolean used to
   * collapse: no trigger was ever written, a trigger is still outstanding, or one was
   * explicitly closed out. `allConnectedCurrent` is an observation about the followers the
   * leader can currently see — it is deliberately not a claim about every enrolled
   * follower, because the leader has no durable roster.
   */
  getStatus(): ReconciliationStatus {
    const trigger = this.store.getActiveTrigger();
    if (!trigger) {
      return {
        state: this.store.load() ? "completed" : "none",
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

    const followers = this.hub.list();
    for (const follower of followers) {
      this.reconcileFollower(follower, trigger);
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

    // Follower already on the target SHA
    if (follower.commitSha && follower.commitSha === activeTrigger.targetSha) {
      if (!this.store.hasSucceeded(follower.id, activeTrigger.targetSha)) {
        this.store.recordSuccess(follower.id, activeTrigger.targetSha);
        this.log.info("follower_already_on_target_sha", {
          followerId: follower.id,
          targetSha: activeTrigger.targetSha,
        });
        this.reportIfAllCurrent();
      }
      return false;
    }

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

    // Dispatch first, then record what actually happened. Recording `pending` up front
    // stranded a follower whose dispatch threw: not failed, so not suppressed; not
    // succeeded, so never current; and the document asserted an attempt that never left.
    try {
      this.hub.updateFollower(follower.id, {
        targetSha: activeTrigger.targetSha,
        branch: activeTrigger.branch,
      });
      const attempt: FollowerUpdateAttempt = {
        status: "pending",
        targetSha: activeTrigger.targetSha,
        lastAttemptAt: new Date().toISOString(),
      };
      this.store.recordAttempt(follower.id, attempt);
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
    this.reconcileFollower(follower);
  }

  onFollowerUpdateStatus(followerId: string, status: FollowerUpdateStatus): void {
    const trigger = this.store.getActiveTrigger();
    if (!trigger) return;

    const targetSha = status.newSha ?? trigger.targetSha;

    if (status.status === "failed") {
      this.store.recordFailure(followerId, targetSha, status.error);
      this.log.warn("follower_update_reconciliation_failure", {
        followerId,
        targetSha,
        error: status.error,
      });
    } else if (status.status === "already_current") {
      this.store.recordSuccess(followerId, targetSha);
      this.log.info("follower_update_reconciliation_already_current", {
        followerId,
        targetSha,
      });
      this.reportIfAllCurrent();
    }
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
