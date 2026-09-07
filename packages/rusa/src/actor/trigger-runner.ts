export type RunPriority = "normal" | "responsive";
export type ActorRunMode = "ordinary" | "yield-elicitation";

/**
 * Content-free scheduling metadata. Durable inbox entries answer what work
 * exists; a nudge only controls when and how quickly the actor should inspect
 * that worklist.
 */
export interface RunNudge {
  priority?: RunPriority;
  mode?: ActorRunMode;
  /** Voice keeps its quick-start/coalesce timing without carrying transcript content. */
  voiceTimestamp?: number;
}

export function isResponsiveNudge(nudge: RunNudge): boolean {
  return nudge.priority === "responsive" || nudge.voiceTimestamp !== undefined;
}

export interface TriggerRunnerOptions {
  /** Run once for the current dirty state; no work content crosses this seam. */
  run: (nudge: RunNudge) => Promise<void>;
  /** Debounce window for coalescing event bursts while idle (default 0). */
  debounceMs?: number;
  /**
   * Consulted after a run completes when no new external nudge is pending.
   * Used only for private control flow such as corrective yield elicitation.
   */
  onIdle?: () => RunNudge | null | undefined;
  isKillable?: () => boolean;
  abortRun?: (coalesceCount: number, coalesceAgeMs: number) => void;
  voiceCoalesceMaxAgeMs?: number;
  log?: (msg: string) => void;
}

/**
 * Single-flight debounce + dirty-bit primitive.
 *
 * Repeated nudges coalesce without retaining their bodies, senders, ids, or
 * instructions. Responsive/voice hints may quick-start a pending run, and a
 * nudge during execution causes exactly one follow-up.
 */
export class TriggerRunner {
  private readonly run: (nudge: RunNudge) => Promise<void>;
  private readonly debounceMs: number;
  private readonly onIdle?: () => RunNudge | null | undefined;
  private readonly log: (msg: string) => void;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private dirty = false;
  private pendingNudge: RunNudge | null = null;
  private currentNudge: RunNudge | null = null;

  constructor(private readonly opts: TriggerRunnerOptions) {
    this.run = opts.run;
    this.debounceMs = opts.debounceMs ?? 0;
    this.onIdle = opts.onIdle;
    this.log = opts.log ?? (() => {});
  }

  /** Request a content-free run. Coalesced per the debounce + dirty-bit rules. */
  requestRun(nudge: RunNudge = {}): void {
    this.pendingNudge = mergeNudges(this.pendingNudge, nudge);

    if (nudge.voiceTimestamp !== undefined) {
      if (this.running) {
        if (this.opts.isKillable?.()) {
          const oldest = this.currentNudge?.voiceTimestamp;
          const maxAge = this.opts.voiceCoalesceMaxAgeMs ?? 8000;
          if (oldest !== undefined && nudge.voiceTimestamp - oldest >= maxAge) {
            this.dirty = true;
            this.log("voice nudge — run in flight, max coalesce age reached, marked dirty");
            return;
          }

          this.log("voice nudge — coalesce-killing current run");
          const age = oldest === undefined ? 0 : nudge.voiceTimestamp - oldest;
          this.pendingNudge = mergeNudges(this.currentNudge, this.pendingNudge);
          this.currentNudge = null;
          this.dirty = true;
          this.opts.abortRun?.(2, age);
          return;
        }
        this.dirty = true;
        this.log("voice nudge — run unkillable, marked dirty");
        return;
      }

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
        this.log("voice nudge — quick-start, bypassing debounce");
      } else {
        this.log("voice nudge — quick-start");
      }
      void this.startRun();
      return;
    }

    if (isResponsiveNudge(nudge)) {
      if (this.running) {
        this.dirty = true;
        this.log("responsive nudge — run in flight, marked dirty");
        return;
      }
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
        this.log("responsive nudge — quick-start, bypassing debounce");
      } else {
        this.log("responsive nudge — quick-start");
      }
      void this.startRun();
      return;
    }

    if (this.running) {
      this.dirty = true;
      this.log("nudge — run in flight, marked dirty");
      return;
    }
    if (this.debounceTimer) {
      this.log("nudge — coalesced into pending debounce window");
      return;
    }
    this.log(`nudge — run scheduled in ${this.debounceMs / 1000}s`);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.startRun();
    }, this.debounceMs);
  }

  /** True while a run is active or a debounce is pending. */
  get isBusy(): boolean {
    return this.running || this.debounceTimer !== null;
  }

  /** Cancel a pending debounce and clear pending nudges. Does not interrupt an in-flight run. */
  close(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.dirty = false;
    this.pendingNudge = null;
  }

  /** Cancel any pending debounce timer and clear dirty / pending nudges. */
  cancelPending(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.dirty = false;
    this.pendingNudge = null;
  }

  /**
   * Return a copy of the scheduling metadata for the run currently awaiting
   * completion. Callers that cancel a queued admission use this to retain the
   * opportunity's priority and mode for a later replay.
   */
  currentNudgeSnapshot(): RunNudge {
    return this.currentNudge ? { ...this.currentNudge } : {};
  }

  /**
   * Re-admit the in-progress scheduling opportunity once its current attempt
   * unwinds. This keeps its original priority and mode instead of manufacturing
   * a fresh ordinary nudge.
   */
  requeueCurrentRun(): void {
    this.pendingNudge = mergeNudges(this.pendingNudge, this.currentNudge);
    this.dirty = true;
  }

  private async startRun(): Promise<void> {
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.dirty = false;
        const nudge = this.pendingNudge ?? {};
        this.pendingNudge = null;
        this.currentNudge = nudge;
        try {
          await this.run(nudge);
        } catch (err) {
          this.log(`run error: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          this.currentNudge = null;
        }
        if (!this.dirty) {
          const continuation = this.onIdle?.();
          if (continuation) {
            this.pendingNudge = mergeNudges(this.pendingNudge, continuation);
            this.dirty = true;
          }
        }
      } while (this.dirty);
    } finally {
      this.running = false;
    }
  }
}

function mergeNudges(left: RunNudge | null, right: RunNudge | null): RunNudge {
  if (!left) return right ? { ...right } : {};
  if (!right) return { ...left };
  const ordinary = left.mode !== "yield-elicitation" || right.mode !== "yield-elicitation";
  return {
    priority: isResponsiveNudge(left) || isResponsiveNudge(right) ? "responsive" : "normal",
    mode: ordinary ? "ordinary" : "yield-elicitation",
    ...(left.voiceTimestamp !== undefined || right.voiceTimestamp !== undefined
      ? {
          voiceTimestamp: Math.min(
            left.voiceTimestamp ?? Infinity,
            right.voiceTimestamp ?? Infinity
          ),
        }
      : {}),
  };
}
