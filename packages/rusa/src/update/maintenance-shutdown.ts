import type { DrainSeam, NotifySeam } from "./orchestrator.js";

export interface MaintenanceShutdownOptions {
  /** Maximum seconds to wait for active runs to finish before cancelling (default: 300). */
  timeoutSeconds?: number;
  /** Reason for the maintenance shutdown. */
  reason?: string;
}

export interface MaintenanceShutdownDeps {
  drain: DrainSeam;
  notify?: NotifySeam;
  recordAction?: (text: string) => void;
  exit: (code: number) => Promise<void> | void;
  log?: (msg: string) => void;
  now?: () => number;
  defaultTimeoutSeconds?: number;
  isBusy?: () => boolean;
  onResumeWork?: () => void;
}

export interface MaintenanceShutdownOutcome {
  status: "quiesced" | "cancelled";
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
  abortController: AbortController;
  onCancel: () => void;
  resolve: (outcome: MaintenanceShutdownOutcome) => void;
}

/**
 * Coordinates graceful drain and shutdown of the mesh for maintenance (e.g. config-only
 * restart) without pulling or rebuilding code (#1225).
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
 *    aborts shutdown, lifts admission brake, notifies error chat, and resumes normal
 *    mesh operation (replaying/re-admitting gated work) without killing active runs.
 * 7. Operator cancel: explicit cancellation lifts the brake and resumes normal operations.
 * 8. Clean exit behavior: under production systemd unit (Restart=always), exit(0) restarts
 *    the service onto updated configurations.
 */
export class MaintenanceShutdownCoordinator {
  private activeRequest: ActiveShutdownRequest | null = null;

  constructor(private readonly deps: MaintenanceShutdownDeps) {}

  isPending(): boolean {
    return this.activeRequest !== null;
  }

  async request(opts: MaintenanceShutdownOptions = {}): Promise<MaintenanceShutdownRequestResult> {
    if (this.activeRequest) {
      return {
        ok: false,
        message: `A graceful shutdown is already in progress (${this.activeRequest.reason}).`,
      };
    }

    if (this.deps.isBusy?.()) {
      return {
        ok: false,
        message: "An update is currently in progress — refusing graceful shutdown.",
      };
    }

    const timeoutSeconds = Math.max(
      1,
      opts.timeoutSeconds ?? this.deps.defaultTimeoutSeconds ?? 300
    );
    const reason = opts.reason?.trim() || "maintenance shutdown";
    const timeoutMs = timeoutSeconds * 1000;
    const now = this.deps.now ? this.deps.now() : Date.now();

    // 1. Engage admission brake and set activeRequest synchronously BEFORE notification await
    // This prevents concurrent requests from both passing the guard and ensures admission
    // is stopped before the error-chat notification is posted.
    this.deps.drain.engage(reason);
    try {
      this.deps.recordAction?.(`shutdown requested: ${reason} [timeout: ${timeoutSeconds}s]`);
    } catch {}

    const abortController = new AbortController();
    let resolveCompletion!: (outcome: MaintenanceShutdownOutcome) => void;
    const completionPromise = new Promise<MaintenanceShutdownOutcome>((resolve) => {
      resolveCompletion = resolve;
    });

    let cancelResolve: (() => void) | undefined;
    const cancelPromise = new Promise<void>((resolve) => {
      cancelResolve = resolve;
    });

    const active: ActiveShutdownRequest = {
      reason,
      startedAt: now,
      abortController,
      onCancel: () => cancelResolve?.(),
      resolve: resolveCompletion,
    };
    this.activeRequest = active;

    // 2. Emit notification to configured error chat AT REQUEST TIME
    const requestNotice = `🛑 Graceful shutdown requested: ${reason}. Admission stopped; draining active runs (timeout: ${timeoutSeconds}s). Note: clean exit under systemd restarts service.`;
    if (this.deps.notify) {
      this.deps.notify.notify(requestNotice).catch((err) => {
        this.deps.log?.(
          `[maintenance-shutdown] error-chat notification failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }

    // 3. Start drain watcher in the background
    void (async () => {
      const startDrainTime = this.deps.now ? this.deps.now() : Date.now();
      try {
        const drainPromise = this.deps.drain.waitForQuiescence(timeoutMs, {
          signal: active.abortController.signal,
        });
        const raced = await Promise.race([
          drainPromise.then((res) => ({ cancelled: false as const, drainResult: res })),
          cancelPromise.then(() => ({ cancelled: true as const, drainResult: null })),
        ]);

        if (
          raced.cancelled ||
          !raced.drainResult ||
          active.abortController.signal.aborted ||
          this.activeRequest !== active
        ) {
          // Cancel was handled synchronously by cancel(); exit watcher without touching state
          return;
        }

        const drainResult = raced.drainResult;
        const waitedMs = drainResult.waitedMs;

        if (drainResult.quiesced) {
          this.deps.log?.(`[maintenance-shutdown] drained after ${waitedMs}ms (quiesced)`);
          try {
            this.deps.recordAction?.(
              `shutdown committed: drained in ${waitedMs}ms (${reason}) — exiting`
            );
          } catch {}

          // Attempt shutdown commit / exit
          try {
            await this.deps.exit(0);
            this.activeRequest = null;
            active.resolve({ status: "quiesced", reason: "quiesced", waitedMs });
            return;
          } catch (exitErr) {
            // A failed commit must NOT strand the brake!
            this.deps.log?.(
              `[maintenance-shutdown] shutdown commit failed: ${exitErr instanceof Error ? exitErr.message : String(exitErr)}`
            );
            this.deps.drain.cancel();
            try {
              this.deps.onResumeWork?.();
            } catch {}
            this.activeRequest = null;

            const abortNotice = `⚠️ Graceful shutdown aborted before commit: exit failed (${exitErr instanceof Error ? exitErr.message : String(exitErr)}). Admission resumed.`;
            if (this.deps.notify) {
              this.deps.notify.notify(abortNotice).catch((notifyErr) => {
                this.deps.log?.(
                  `[maintenance-shutdown] error-chat notification failed: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`
                );
              });
            }
            try {
              this.deps.recordAction?.(
                `shutdown aborted before commit: exit failed (${exitErr instanceof Error ? exitErr.message : String(exitErr)})`
              );
            } catch {}

            active.resolve({ status: "cancelled", reason: "error", waitedMs });
            return;
          }
        }

        // Timed out!
        this.deps.log?.(`[maintenance-shutdown] drain timed out after ${waitedMs}ms`);
        this.deps.drain.cancel();
        try {
          this.deps.onResumeWork?.();
        } catch {}
        this.activeRequest = null;

        const cancelMsg = `⚠️ Graceful shutdown cancelled: drain timed out after ${timeoutSeconds}s with active runs remaining. Admission resumed.`;
        if (this.deps.notify) {
          this.deps.notify.notify(cancelMsg).catch((notifyErr) => {
            this.deps.log?.(
              `[maintenance-shutdown] error-chat notification failed: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`
            );
          });
        }
        try {
          this.deps.recordAction?.(
            `shutdown cancelled: drain timed out after ${timeoutSeconds}s (${reason})`
          );
        } catch {}

        active.resolve({ status: "cancelled", reason: "timeout", waitedMs });
      } catch (err) {
        if (active.abortController.signal.aborted || this.activeRequest !== active) {
          return;
        }
        this.deps.log?.(
          `[maintenance-shutdown] drain error: ${err instanceof Error ? err.message : String(err)}`
        );
        this.deps.drain.cancel();
        try {
          this.deps.onResumeWork?.();
        } catch {}
        this.activeRequest = null;
        active.resolve({
          status: "cancelled",
          reason: "error",
          waitedMs: (this.deps.now ? this.deps.now() : Date.now()) - startDrainTime,
        });
      }
    })();

    const message = `Graceful shutdown initiated (${reason}). Admission stopped; draining active runs with ${timeoutSeconds}s timeout. Active runs will finish before shutdown. Note: clean exit under systemd restarts service.`;
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
    this.activeRequest = null;
    active.abortController.abort();
    active.onCancel();

    this.deps.drain.cancel();
    try {
      this.deps.onResumeWork?.();
    } catch {}

    const reasonText = cancelReason ? `: ${cancelReason}` : "";
    const notice = `⚠️ Graceful shutdown cancelled by operator${reasonText}. Admission resumed.`;
    if (this.deps.notify) {
      this.deps.notify.notify(notice).catch((err) => {
        this.deps.log?.(
          `[maintenance-shutdown] error-chat notification failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
    try {
      this.deps.recordAction?.(`shutdown cancelled by operator${reasonText}`);
    } catch {}

    active.resolve({
      status: "cancelled",
      reason: "explicit",
      waitedMs: (this.deps.now ? this.deps.now() : Date.now()) - active.startedAt,
    });

    return {
      ok: true,
      message: `Graceful shutdown cancelled by operator${reasonText}. Admission resumed.`,
    };
  }
}
