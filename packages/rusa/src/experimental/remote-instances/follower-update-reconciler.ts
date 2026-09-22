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

export class FollowerUpdateReconciler {
  private readonly log: Logger;
  private unregisterCallbacks: (() => void)[] = [];

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

  getStatus(): { activeTrigger: FollowerUpdateTrigger | null; completed: boolean } {
    const trigger = this.store.getActiveTrigger();
    return {
      activeTrigger: trigger,
      completed: trigger === null,
    };
  }

  reconcileAll(): void {
    const trigger = this.store.getActiveTrigger();
    if (!trigger || !trigger.autoReconcile) return;

    const followers = this.hub.list();
    for (const follower of followers) {
      this.reconcileFollower(follower, trigger);
    }
    this.checkCompletion();
  }

  reconcileFollower(
    follower: { id: string; commitSha?: string; updateStatus?: FollowerUpdateStatus },
    trigger?: FollowerUpdateTrigger | null
  ): boolean {
    const activeTrigger = trigger ?? this.store.getActiveTrigger();
    if (!activeTrigger || !activeTrigger.autoReconcile) return false;

    // Follower already on the target SHA
    if (follower.commitSha && follower.commitSha === activeTrigger.targetSha) {
      if (!this.store.hasSucceeded(follower.id, activeTrigger.targetSha)) {
        this.store.recordSuccess(follower.id, activeTrigger.targetSha);
        this.log.info("follower_already_on_target_sha", {
          followerId: follower.id,
          targetSha: activeTrigger.targetSha,
        });
        this.checkCompletion();
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

    // Dispatch the update
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
      this.log.warn("follower_update_reconciliation_dispatch_error", {
        followerId: follower.id,
        err,
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
      this.checkCompletion();
    }
  }

  private checkCompletion(): void {
    const followers = this.hub.list();
    if (followers.length === 0) return;
    const ids = followers.map((f) => f.id);
    const completed = this.store.checkCompletion(ids);
    if (completed) {
      this.log.info("follower_update_reconciliation_all_completed", {
        followerCount: ids.length,
      });
    }
  }
}
