/**
 * Centralized attribution for provider runs that end in SIGTERM.
 *
 * The actor uses an AbortController to name the cause of a kill:
 * - `"stall-watchdog"` — no output for WATCHDOG_STALL_TIMEOUT_MS.
 * - `"run-ceiling"`    — the absolute wall-clock timeoutMs expired.
 *
 * Anything else (external SIGTERM, generic abort, etc.) is reported honestly
 * as unattributed rather than guessed as a user cancellation.
 */

export const STALL_WATCHDOG_ABORT_REASON = "stall-watchdog";
export const RUN_CEILING_ABORT_REASON = "run-ceiling";
export const INTERRUPT_ABORT_REASON_PREFIX = "interrupt:";

export type AbortReason =
  | typeof STALL_WATCHDOG_ABORT_REASON
  | typeof RUN_CEILING_ABORT_REASON
  | `${typeof INTERRUPT_ABORT_REASON_PREFIX}${string}`
  | "unknown";

export function createInterruptAbortReason(by: string): string {
  return `${INTERRUPT_ABORT_REASON_PREFIX}${by}`;
}

export function isInterruptAbortReason(reason: unknown): boolean {
  return typeof reason === "string" && reason.startsWith(INTERRUPT_ABORT_REASON_PREFIX);
}

export function parseInterruptSource(reason: string): string | undefined {
  if (!isInterruptAbortReason(reason)) return undefined;
  return reason.slice(INTERRUPT_ABORT_REASON_PREFIX.length).trim() || undefined;
}

export interface TerminationAttribution {
  output: string;
  exitCode: number;
  cancelled: boolean;
  interrupted?: boolean;
  interruptSource?: string;
  abortReason: AbortReason;
}

/**
 * Extract the typed AbortReason from an AbortSignal without string formatting.
 */
export function extractAbortReason(signal?: AbortSignal): AbortReason {
  const reason = signal?.aborted ? signal.reason : undefined;
  if (isInterruptAbortReason(reason)) {
    return reason as AbortReason;
  }
  if (reason === STALL_WATCHDOG_ABORT_REASON) {
    return STALL_WATCHDOG_ABORT_REASON;
  }
  if (reason === RUN_CEILING_ABORT_REASON) {
    return RUN_CEILING_ABORT_REASON;
  }
  return "unknown";
}

/**
 * Produce the worker-visible attribution for a run that exited with SIGTERM.
 * `baseOutput` is the captured stdout/stderr up to the termination point.
 */
export function formatSigtermResult(
  baseOutput: string,
  signal?: AbortSignal
): TerminationAttribution {
  const reason = signal?.aborted ? signal.reason : undefined;

  if (isInterruptAbortReason(reason)) {
    const by = parseInterruptSource(reason) ?? "operator";
    return {
      output: `${baseOutput}\n[Task interrupted by ${by}]`,
      exitCode: 143, // 128 + SIGTERM (15)
      cancelled: true,
      interrupted: true,
      interruptSource: by,
      abortReason: reason as AbortReason,
    };
  }

  if (reason === STALL_WATCHDOG_ABORT_REASON) {
    return {
      output: `${baseOutput}\n[Task killed by stall watchdog (no output for 15 minutes)]`,
      exitCode: 143, // 128 + SIGTERM (15)
      cancelled: true,
      abortReason: STALL_WATCHDOG_ABORT_REASON,
    };
  }

  if (reason === RUN_CEILING_ABORT_REASON) {
    return {
      output: `${baseOutput}\n[Task killed by run ceiling timeout]`,
      exitCode: 143, // 128 + SIGTERM (15)
      cancelled: true,
      abortReason: RUN_CEILING_ABORT_REASON,
    };
  }

  return {
    output: `${baseOutput}\n[Task terminated by SIGTERM (source unattributed)]`,
    exitCode: 143, // 128 + SIGTERM (15)
    cancelled: true,
    abortReason: "unknown",
  };
}
