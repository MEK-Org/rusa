import type { DrainSeam, NotifySeam } from "./orchestrator.js";

export type TimeoutBehavior = "cancel" | "terminate";

export interface MaintenanceShutdownOptions {
  /** Maximum seconds to wait for active runs to finish (default: 60). */
  timeoutSeconds?: number;
  /** What to do if active runs do not finish within timeout (default: "cancel"). */
  timeoutBehavior?: TimeoutBehavior;
  /** Reason for the maintenance shutdown. */
  reason?: string;
  /** If called by an actor in a run, its thread ID. */
  selfId?: string;
}

export interface MaintenanceShutdownDeps {
  drain: DrainSeam;
  notify?: NotifySeam;
  recordAction?: (text: string) => void;
  exit: (code: number) => void;
  log?: (msg: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  defaultTimeoutSeconds?: number;
}

export interface MaintenanceShutdownOutcome {
  status: "quiesced" | "cancelled" | "terminated";
  reason: "quiesced" | "timeout" | "explicit" | "error";
  waitedMs: number;
}

export interface MaintenanceShutdownRequestResult {
  ok: boolean;
  message: string;
  completion?: Promise<MaintenanceShutdownOutcome>;
}

export interface MaintenanceShutdownCancelResult {
  ok: boolean;
  message: string;
}

interface ActiveShutdownRequest {
  reason: string;
  startedAt: number;
  timeoutSeconds: number;
  timeoutBehavior: TimeoutBehavior;
  cancelRequested?: boolean;
  cancelReason?: string;
  resolve: (outcome: MaintenanceShutdownOutcome) => void;
  promise: Promise<MaintenanceShutdownOutcome>;
}

/**
 * Coordinates graceful drain and shutdown of the mesh for maintenance (e.g. config-only
 * restart) without pulling or rebuilding code.
 *
 * Requirements:
 * 1. Process-local admission brake: engages `GracefulShutdown` so new runs stop starting,
 *    while preserving operator HALT state independently without file collisions.
 * 2. Request-time notification: posts a mechanical notice to the configured error chat
 *    at request time so operators know draining has begun.
 * 3. Self-request return: requesting actor can return its tool turn cleanly without
 *    deadlocking its own drain barrier.
 * 4. Active runs finish: existing in-flight runs are allowed to finish.
 * 5. Pending work stays blocked: new runs are refused while draining.
 * 6. Explicit timeout/cancel: if active runs do not finish within `timeoutSeconds`,
 *    applies explicit `timeoutBehavior`:
 *    - "cancel" (default): aborts shutdown, lifts admission brake, notifies error chat,
 *      and resumes normal operation without killing active runs.
 *    - "terminate": notifies error chat and calls exit to terminate.
 * 7. Operator cancel: explicit cancellation lifts the brake and resumes normal operations.
 */
export class MaintenanceShutdownCoordinator {
  private activeRequest: ActiveShutdownRequest | null = null;

  constructor(private readonly deps: MaintenanceShutdownDeps) {}

  isPending(): boolean {
    return this.activeRequest !== null;
  }

  currentReason(): string | undefined {
    return this.activeRequest?.reason;
  }

  async request(opts: MaintenanceShutdownOptions = {}): Promise<MaintenanceShutdownRequestResult> {
    if (this.activeRequest) {
      return {
        ok: false,
        message: `A graceful shutdown is already in progress (${this.activeRequest.reason}).`,
      };
    }

    const timeoutSeconds = Math.max(
      1,
      opts.timeoutSeconds ?? this.deps.defaultTimeoutSeconds ?? 60
    );
    const timeoutBehavior: TimeoutBehavior =
      opts.timeoutBehavior === "terminate" ? "terminate" : "cancel";
    const reason = opts.reason?.trim() || "maintenance shutdown";
    const timeoutMs = timeoutSeconds * 1000;
    const now = this.deps.now ? this.deps.now() : Date.now();

    // 1. Emit notification to configured error chat AT REQUEST TIME
    const requestNotice = `🛑 Graceful shutdown requested: ${reason}. Admission stopped; draining active runs (timeout: ${timeoutSeconds}s, on timeout: ${timeoutBehavior}).`;
    if (this.deps.notify) {
      try {
        await this.deps.notify.notify(requestNotice);
      } catch (err) {
        this.deps.log?.(
          `[maintenance-shutdown] error-chat notification failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // 2. Engage admission brake (GracefulShutdown.request)
    this.deps.drain.engage(reason);
    try {
      this.deps.recordAction?.(
        `shutdown requested: ${reason} [timeout: ${timeoutSeconds}s, on timeout: ${timeoutBehavior}]`
      );
    } catch {}

    let resolveCompletion!: (outcome: MaintenanceShutdownOutcome) => void;
    const completionPromise = new Promise<MaintenanceShutdownOutcome>((resolve) => {
      resolveCompletion = resolve;
    });

    const active: ActiveShutdownRequest = {
      reason,
      startedAt: now,
      timeoutSeconds,
      timeoutBehavior,
      resolve: resolveCompletion,
      promise: completionPromise,
    };
    this.activeRequest = active;

    // 3. Start drain watcher in the background
    void (async () => {
      const startDrainTime = this.deps.now ? this.deps.now() : Date.now();
      try {
        // Wait for all active runs to complete
        const drainResult = await (this.deps.drain.waitForAllQuiescence
          ? this.deps.drain.waitForAllQuiescence(timeoutMs, {
              intervalMs: this.deps.intervalMs,
              sleep: this.deps.sleep,
              now: this.deps.now,
            })
          : this.deps.drain.waitForQuiescence(timeoutMs));

        const waitedMs = drainResult.waitedMs;

        // Check if cancel was requested during the drain wait
        if (active.cancelRequested) {
          this.activeRequest = null;
          active.resolve({ status: "cancelled", reason: "explicit", waitedMs });
          return;
        }

        if (drainResult.quiesced) {
          this.deps.log?.(`[maintenance-shutdown] drained after ${waitedMs}ms (quiesced)`);
          try {
            this.deps.recordAction?.(
              `shutdown committed: drained in ${waitedMs}ms (${reason}) — exiting`
            );
          } catch {}
          this.activeRequest = null;
          active.resolve({ status: "quiesced", reason: "quiesced", waitedMs });
          this.deps.exit(0);
          return;
        }

        // Timed out!
        this.deps.log?.(`[maintenance-shutdown] drain timed out after ${waitedMs}ms`);
        if (timeoutBehavior === "cancel") {
          this.deps.drain.cancel();
          const cancelMsg = `⚠️ Graceful shutdown cancelled: drain timed out after ${timeoutSeconds}s with active runs remaining. Admission resumed.`;
          if (this.deps.notify) {
            try {
              await this.deps.notify.notify(cancelMsg);
            } catch {}
          }
          try {
            this.deps.recordAction?.(
              `shutdown cancelled: drain timed out after ${timeoutSeconds}s (${reason})`
            );
          } catch {}
          this.activeRequest = null;
          active.resolve({ status: "cancelled", reason: "timeout", waitedMs });
        } else {
          // terminate
          const termMsg = `⚠️ Graceful shutdown drain timed out after ${timeoutSeconds}s. Terminating remaining active runs.`;
          if (this.deps.notify) {
            try {
              await this.deps.notify.notify(termMsg);
            } catch {}
          }
          try {
            this.deps.recordAction?.(
              `shutdown terminated after timeout: ${timeoutSeconds}s (${reason}) — exiting`
            );
          } catch {}
          this.activeRequest = null;
          active.resolve({ status: "terminated", reason: "timeout", waitedMs });
          this.deps.exit(0);
        }
      } catch (err) {
        this.deps.log?.(
          `[maintenance-shutdown] drain error: ${err instanceof Error ? err.message : String(err)}`
        );
        this.deps.drain.cancel();
        this.activeRequest = null;
        active.resolve({
          status: "cancelled",
          reason: "error",
          waitedMs: (this.deps.now ? this.deps.now() : Date.now()) - startDrainTime,
        });
      }
    })();

    const message = `Graceful shutdown initiated (${reason}). Admission stopped; draining active runs with ${timeoutSeconds}s timeout (on timeout: ${timeoutBehavior}). Active runs will finish before shutdown.`;
    return {
      ok: true,
      message,
      completion: completionPromise,
    };
  }

  cancel(cancelReason?: string): MaintenanceShutdownCancelResult {
    if (!this.activeRequest) {
      return {
        ok: false,
        message: "No graceful shutdown is currently pending.",
      };
    }

    const active = this.activeRequest;
    active.cancelRequested = true;
    active.cancelReason = cancelReason;

    this.deps.drain.cancel();
    const reasonText = cancelReason ? `: ${cancelReason}` : "";
    const notice = `⚠️ Graceful shutdown cancelled by operator${reasonText}. Admission resumed.`;
    if (this.deps.notify) {
      try {
        void this.deps.notify.notify(notice);
      } catch {}
    }
    try {
      this.deps.recordAction?.(`shutdown cancelled by operator${reasonText}`);
    } catch {}
    this.activeRequest = null;
    active.resolve({
      status: "cancelled",
      reason: "explicit",
      waitedMs: (this.deps.now ? this.deps.now() : Date.now()) - active.startedAt,
    });

    return {
      ok: true,
      message: `Graceful shutdown cancelled${reasonText}. Admission resumed.`,
    };
  }
}
