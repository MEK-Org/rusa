/**
 * An in-memory, process-local "stop starting new runs" brake — distinct from the
 * file-backed {@link HaltSwitch} operator halt . Where HALT is a durable
 * operator emergency-brake that *survives* a restart (a halted system stays
 * halted until someone resumes it), `GracefulShutdown` is the opposite by design:
 * it exists only in this process's memory and is gone the instant the process
 * restarts.
 *
 * That asymmetry is the whole point. `rusa redeploy` engages it to quiesce
 * the mesh before bouncing the systemd service, and because it is in-memory the
 * freshly-booted process comes up with it `false` — there is **nothing to clear
 * on restart** and the operator HALT is never touched. The run-gate consults both
 * independently: `shouldRun = !isHalted() && !isShuttingDown() && <lease>`, so the
 * dashboard's HALTED indicator (derived from the HALT file) never conflates an
 * operator halt with a transient deploy drain.
 *
 * Enforcement mirrors HALT exactly: a gated run is skipped, and a skipped run does
 * not self-continue, so the mesh quiesces within one run-cycle. In-flight runs are
 * allowed to finish — this brakes *starting* work, not a kill.
 */
export class GracefulShutdown {
  private shuttingDown = false;
  private why = "";

  /** True once a graceful shutdown has been requested (and not cancelled). */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** The reason recorded at request time, if any. */
  reason(): string {
    return this.why;
  }

  /** Request graceful shutdown: new runs stop at their next turn boundary. Idempotent. */
  request(reason = ""): void {
    this.shuttingDown = true;
    this.why = reason;
  }

  /**
   * Cancel a pending graceful shutdown — the mesh resumes starting runs. Used by
   * `redeploy --dry-run`, which engages the brake only to validate the drain and
   * must hand the live mesh back exactly as it found it (no restart to reset the
   * flag). Idempotent.
   */
  cancel(): void {
    this.shuttingDown = false;
    this.why = "";
  }
}
