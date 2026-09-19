import { randomUUID } from "node:crypto";
import type { ExhaustionClassifier } from "../providers/exhaustion-classifier.js";
import {
  describeModelConfigEntry,
  type ProviderModelConfig,
  type RawProviderModelConfig,
} from "../providers/model-config.js";
import { teardownFlutterOverlay } from "../providers/sandbox.js";
import {
  createInterruptAbortReason,
  formatSigtermResult,
  RUN_CEILING_ABORT_REASON,
  STALL_WATCHDOG_ABORT_REASON,
  YIELD_GRACE_ABORT_REASON,
} from "../providers/termination-attribution.js";
import type {
  CodingProvider,
  McpServerSpec,
  RunResult,
  SandboxOptions,
} from "../providers/types.js";
import {
  type ActorLifecycle,
  type ActorLifecycleAbandonmentReason,
  createActorLifecycle,
} from "./actor-lifecycle.js";
import {
  RunStartCancelledError,
  type RunStartHandle,
  RunStartStaleProviderError,
} from "./concurrency-limiter.js";
import type { InjectRecord } from "./portable-context.js";
import {
  type ActorRunMode,
  isResponsiveNudge,
  mergeNudges,
  type RunNudge,
  TriggerRunner,
} from "./trigger-runner.js";

export const WATCHDOG_STALL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
export const WATCHDOG_CEILING_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
export const DEFAULT_YIELD_GRACE_MS = 10 * 1000; // 10 seconds
export const RESPONSIVE_PREEMPTION_SOURCE = "responsive-notification";
const YIELD_ELICITATION_MAX = 1;

/**
 * What {@link ActorOptions.buildPrompt} returns: the assembled prompt, plus —
 * for portable-context actors (design ISSUE_NUM) — the inject record describing the
 * mesh-portable context folded into this run's prompt.
 */
export interface PromptBuild {
  prompt: string;
  /** Portable-context inject record for this run, or undefined when nothing was injected. */
  injectRecord?: InjectRecord;
}

export interface ActorOptions {
  /** Stable actor id (the thread handle). */
  id: string;
  /** Working directory for this actor's agent runs (its own dir/worktree). */
  cwd: string;
  /**
   * The declared candidate pool this actor runs on (design MEK-Org/rusa#169).
   * A single fixed-model actor still declares a one-element pool. In-process
   * actors receive validated entries; the raw shape remains at this transport
   * boundary so a remote actor can report a malformed selection as a run fault.
   */
  modelConfig: RawProviderModelConfig[];
  /** Resolve one declared candidate into the coding provider that will run it. */
  resolveProvider: (config: RawProviderModelConfig) => CodingProvider;
  /** MCP servers attached as this actor's tools. */
  mcpServers: McpServerSpec[];
  /**
   * Run this actor's agent under the bwrap sandbox. The sandbox is rooted at the
   * actor's `cwd` and grants git + gh (we don't restrict those); callers just
   * opt in. Used for agy workers, which need a per-invocation MCP config.
   */
  sandbox?: boolean;
  /**
   * True only for the sandboxed E2E root-agent double.
   * Lets the sandbox layer apply the root-agent cred layout without inspecting
   * the directory basename.
   */
  isE2eRoot?: boolean;
  /**
   * Optional factory to prepare and return a host directory containing the
   * Integrated Understanding snapshot to mount into the sandbox at /tmp/understanding.
   * Called per launch when sandboxed.
   */
  prepareUnderstandingMount?: () => Promise<string | undefined> | string | undefined;
  /** Extra repos granted via `--add-dir`. */
  addDirs?: string[];
  /** Load this actor's persisted working-memory session id (undefined on first run). */
  loadSessionId: () => string | undefined;
  /** Persist the session id returned by a run, so the next wake resumes it. */
  saveSessionId: (id: string) => void;
  /**
   * Build the ordinary run prompt after scheduler admission. Called fresh so it
   * can read the current charter, inbox contract, and portable context.
   */
  buildPrompt: () => PromptBuild;
  /**
   * The sole run/actor observation seam. Logging, durable accounting, mesh
   * events, compaction, and failure routing subscribe here as peers.
   */
  lifecycle?: ActorLifecycle;
  /** Firehose: receives the agent's streamed output. */
  log?: (chunk: string) => void;
  /**
   * Eligibility classifier for pool-chain fallback after a failed invocation
   * (MEK-Org/rusa#450). When set, an invocation that fails with a classified
   * capacity/quota exhaustion recovers onto the remaining entries of this
   * actor's declared {@link modelConfig} pool, in order, each entry keeping
   * its own provider/model/effort tuple. When unset (every worker), a failed
   * invocation is reported as-is — exhaustion is a signal to the parent, not
   * something the actor self-heals out of.
   */
  classifyExhaustion?: ExhaustionClassifier;
  /**
   * Structured, bounded diagnostic for each pool-fallback transition: the
   * invocation on `failed` was classified exhausted, so recovery is moving to
   * `next`. Carries configured entry tuples and counts only — never provider
   * output, which echoes the prompt and can hold secrets.
   */
  onPoolFallback?: (diagnostic: PoolFallbackDiagnostic) => void;
  /** Debounce window for coalescing wake bursts (default: TriggerRunner default). */
  debounceMs?: number;
  /** Per-run provider timeout. */
  timeoutMs?: number;
  /** Grace period in ms between yield declaration and supervisor SIGKILL (default 10,000ms). */
  yieldGraceMs?: number;
  /** Max age of coalesced voice events before the run becomes unkillable (default 8000). */
  voiceCoalesceMaxAgeMs?: number;
  /**
   * Deprecated compatibility knob. Actors now get exactly one corrective run
   * when they finish without calling {@link declareYield}; if they still do not
   * yield, the run is classified failed.
   */
  maxContinuations?: number;
  /** Observability: a corrective yield-elicitation run was scheduled (`n` = 1). */
  onContinue?: (n: number) => void;
  /** Observability: the corrective yield-elicitation budget was exhausted. */
  onContinuationCapped?: (n: number) => void;
  /**
   * Provider pacing plus normal-run mesh scheduling. Responsive runs may bypass
   * both queues; the returned handle can promote a queued normal run.
   */
  gate?: <T>(
    fn: (selected: RawProviderModelConfig) => Promise<T>,
    candidates: readonly RawProviderModelConfig[],
    responsive: boolean
  ) => Promise<T> | RunStartHandle<T>;
  /**
   * Optional pre-run check (e.g. halted provider, mesh shutdown). Return `false`
   * to skip this run (the wake is dropped). Defaults to always-run.
   */
  beforeRun?: (context: { mode: ActorRunMode }) => boolean | Promise<boolean>;
  /**
   * Final scheduler-admission check, after a gate selects this run but before
   * the provider starts. Returning false defers the content-free opportunity.
   */
  admitRun?: (context: { responsive: boolean; mode: ActorRunMode }) => boolean | Promise<boolean>;
  /**
   * Optional hook fired when a run is aborted due to a voice quick-start coalesce.
   */
  onCoalesceAborted?: (count: number, ageMs: number) => void;
  /**
   * Called immediately before each provider attempt with the instance that will
   * run. Unlike onRunStart, this includes fallbacks without changing run
   * lifecycle accounting. Its model and effort are the instantiated values, not
   * the pre-normalization request.
   */
  onProviderAttempt?: (provider: CodingProvider) => void;
  /**
   * Optional hook fired ONCE per run, on the first chunk the provider emits —
   * the moment it starts answering, as distinct from the moment we asked.
   */
  onFirstChunk?: () => void;
  /** Publish the actor's derived runtime state after each real flag mutation cluster. */
  onRuntimeStateChanged?: (state: "queued" | "running" | "winding_down" | "idle") => void;
  /**
   * Fires when a genuinely queued (not yet started) run is actually
   * cancelled — from {@link cancelQueuedRun} or a successful cancel inside
   * {@link preemptForResponsive} — so a caller tracking queued-selection
   * state (which lane a queued run reserved) can clear it. Never fires once
   * the run has started; onEnd covers that.
   */
  onQueuedRunCancelled?: () => void;
}

/** What ended without a result, and which brackets it closes. */
export interface RunAbandon {
  reason: RunAbandonReason;
  /**
   * Whether the inner start bracket already opened for this run.
   */
  started: boolean;
}

/** Why a run opportunity ended without a result. */
export type RunAbandonReason = ActorLifecycleAbandonmentReason;

/**
 * One pool-fallback transition within a run: the invocation on {@link failed}
 * was classified exhausted, so recovery is moving to {@link next}. Emitted
 * through {@link ActorOptions.onPoolFallback} before each recovery attempt.
 */
export interface PoolFallbackDiagnostic {
  /** Lifecycle run id the transition belongs to, for run-scoped records. */
  runId: string;
  /** 1-based invocation index in this run's chain: 1 is the gated primary attempt. */
  attempt: number;
  /** Configured pool entry whose invocation just failed. */
  failed: RawProviderModelConfig;
  /** Configured pool entry recovery will try next. */
  next: RawProviderModelConfig;
  /** Configured entries still untried after {@link next}. */
  remainingAfter: number;
}

/**
 * Compose the failure report for a pool recovery attempt that failed for a reason
 * that is *not* exhaustion .
 *
 * The primary's exhaustion is the load-bearing fact — it is why recovery was
 * attempted at all, and it is the condition that actually resolves on a timer.
 * The recovery failure only explains why recovery didn't happen. Reporting the
 * latter alone converts a self-healing wait into an error naming a model nobody
 * configured, which is what made ISSUE_NUM cost two separate diagnoses.
 *
 * The primary's exhaustion is carried as a *named condition*, never as its raw
 * output: ISSUE_NUM deliberately scrubs raw provider output out of synthesized
 * failures because a provider echoes the prompt, and the prompt carries secrets.
 * The recovery's raw output is kept because this path already returned it
 * verbatim before this function existed; withholding it would lose the config
 * diagnostics (`invalid --model ...`) that make a wiring bug findable.
 */
export function formatPoolRecoveryFailure(input: {
  primaryName: string;
  recoveryEntry: string;
  recoveryOutput: string;
}): string {
  return [
    `primary ${input.primaryName} exhausted; recovery onto pool entry ${input.recoveryEntry} failed for an unrelated reason.`,
    "",
    `The exhaustion of ${input.primaryName} is what caused this run to fail, and it clears on a timer. The recovery error below explains only why recovery was unavailable — it is context, not the cause.`,
    "",
    `--- pool entry ${input.recoveryEntry} (recovery failed) ---`,
    input.recoveryOutput,
  ].join("\n");
}

/**
 * The unit of the actor mesh: an inbox (the {@link TriggerRunner} loop), its own
 * working memory (a provider session), access to MCP tools, and a
 * charter. The root and every worker are the same class — they differ only in
 * configuration (charter, tools, and how their *outbox* is routed, which lives
 * in the mesh, not here). A worker may itself spawn sub-workers with the same
 * machinery (B.4).
 *
 * Inbox delivery calls {@link requestRun}; each ordinary run re-derives work
 * from its durable inbox. The session id captured from a run is persisted
 * via {@link ActorOptions.saveSessionId} so the next wake continues it.
 */
export class Actor {
  readonly id: string;
  readonly lifecycle: ActorLifecycle;
  private readonly runner: TriggerRunner;
  private closed = false;
  private killable = true;
  private coalesceAborted = false;
  private coalesceAbortController?: AbortController;
  /** Handle for this actor's provider run while it is waiting to start. */
  private pendingStart?: RunStartHandle<RunResult>;
  /** Consecutive corrective yield-elicitation runs since the last external wake or yield. */
  private continuations = 0;
  /** Set within a run when the actor calls its yield tool; read after the run. */
  private yielded = false;
  /** Status ('complete' | 'blocked') set when the actor calls its yield tool. */
  private yieldStatus?: string;
  private yieldNote?: string;
  /** True when the last wake was gated off by {@link ActorOptions.beforeRun} (nothing ran). */
  private lastRunSkipped = false;
  /** True when the last run ended in a failure result (non-zero / threw). */
  private lastRunFailed = false;
  /** True only while the provider run and its post-run hook are active. */
  private executing = false;
  /** True while the run is waiting in provider pacing or the mesh concurrency queue. */
  private queued = false;
  /** Actor-level dirty state retained when /halt cancels a queued provider start. */
  private cancelledQueuedRun = false;
  /** Scheduling metadata retained with a cancelled queued opportunity for its replay. */
  private cancelledQueuedNudge?: RunNudge;
  /** A model re-quote has cancelled its old reservation and is awaiting its one dirty-bit replay. */
  private reschedulingQueuedRun = false;
  private preemptedQueuedRun = false;
  /** Scheduling metadata delivered while queued for admission; replayed if the queued opportunity fails or is cancelled before start. */
  private nudgeWhileQueued?: RunNudge;
  /**
   * Set within a run at the moment it commits to reporting its result through
   * `onRunEnd`. Read by the terminal hook in `runOnce`'s `finally` to decide
   * which of the two terminal hooks this run already fired.
   */
  private runEndReported = false;
  /**
   * Set within a run once `onRunStart` has fired — i.e. once the inner,
   * start-to-finish bracket is actually OPEN. Carried on the abandon hook as
   * {@link RunAbandon.started} so a reader tracking started runs knows whether
   * this abandonment closes one. See that field for why the reason can't say.
   */
  private runStartReported = false;
  /** Identity is minted when the queued opportunity opens, before admission. */
  private currentRunId: string | undefined;
  private yieldGraceTimer?: NodeJS.Timeout;
  private readonly yieldGraceMs: number;
  private currentRunStartTime: Date | null = null;
  private interruptedWatermark: Date | null = null;
  private lastPublishedRuntimeState: "queued" | "running" | "winding_down" | "idle" = "idle";

  constructor(private readonly opts: ActorOptions) {
    this.id = opts.id;
    this.lifecycle =
      opts.lifecycle ??
      createActorLifecycle([], (failure) => {
        this.opts.log?.(
          `lifecycle ${failure.event} listener failed: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}\n`
        );
      });
    this.yieldGraceMs = opts.yieldGraceMs ?? DEFAULT_YIELD_GRACE_MS;
    this.runner = new TriggerRunner({
      debounceMs: opts.debounceMs,
      log: opts.log ? (m) => opts.log?.(`${m}\n`) : undefined,
      run: (nudge) => this.runOnce(nudge),
      onIdle: () => this.continueOrIdle(),
      isKillable: () => this.killable && this.pendingStart === undefined,
      voiceCoalesceMaxAgeMs: opts.voiceCoalesceMaxAgeMs ?? 8000,
      abortRun: (count, ageMs) => {
        this.opts.onCoalesceAborted?.(count, ageMs);
        this.coalesceAborted = true;
        this.coalesceAbortController?.abort();
      },
    });
  }

  /** The admission gate raised this queued run to responsive priority; report the run as such. */
  promoteQueuedRun(): void {
    this.pendingStart?.promote();
  }

  /** Wake this actor with content-free scheduling metadata. */
  requestRun(nudge: RunNudge = {}): void {
    if (this.closed) return;
    if (nudge.mode !== "yield-elicitation") {
      this.continuations = 0;
    }
    if (isResponsiveNudge(nudge)) {
      this.pendingStart?.promote();
    }
    // Work delivered while queued joins the accepted execution opportunity. The
    // provider will list the live inbox only after admission, so no follow-up is
    // necessary. Running actors still flow through TriggerRunner's dirty bit.
    if (this.queued) {
      this.nudgeWhileQueued = mergeNudges(this.nudgeWhileQueued ?? null, nudge);
      return;
    }
    this.runner.requestRun(nudge);
  }

  /**
   * The actor signalled it has nothing more to do *right now* — its current
   * objective is complete, or it's blocked waiting on someone else. Called via
   * the mesh when the actor invokes its yield tool. Starts the supervisor grace
   * period timer to forcefully kill the process if it does not exit promptly.
   * Stops the corrective run path; the actor next runs on a real external trigger.
   */
  declareYield(status?: string, note?: string): void {
    this.yielded = true;
    this.yieldStatus = status ?? "complete";
    this.yieldNote = note;
    this.publishRuntimeStateIfChanged();
    if (this.executing && !this.yieldGraceTimer) {
      this.yieldGraceTimer = setTimeout(() => {
        this.yieldGraceTimer = undefined;
        if (this.executing) {
          this.opts.log?.(
            `\n[Supervisor] Actor ${this.id} did not exit within ${this.yieldGraceMs}ms grace period after yield. Terminating...\n`
          );
          this.coalesceAbortController?.abort(YIELD_GRACE_ABORT_REASON);
        }
      }, this.yieldGraceMs);
      this.yieldGraceTimer.unref?.();
    }
  }

  get isYielded(): boolean {
    return this.yielded;
  }

  /**
   * The {@link TriggerRunner.onIdle} policy: decide whether to run the one
   * corrective yield-elicitation prompt after a successful run that did not
   * call yield_run.
   */
  private continueOrIdle(): RunNudge | null {
    // The wake was gated off (beforeRun returned false) — treat it as a dropped
    // trigger, not a run that fell short, so we don't spin re-checking the same
    // closed gate.
    if (this.lastRunSkipped) {
      this.continuations = 0;
      return null;
    }
    if (this.yielded) {
      this.continuations = 0;
      return null;
    }
    // A failed run never gets a corrective yield prompt. On failure we
    // mechanically stop and let the failure forward up to the parent (the onRun
    // → failure-sink path), which applies judgment about what to do next.
    if (this.lastRunFailed) {
      this.continuations = 0;
      return null;
    }
    if (this.continuations >= YIELD_ELICITATION_MAX) return null;
    this.continuations += 1;
    this.opts.onContinue?.(this.continuations);
    return { mode: "yield-elicitation", priority: "responsive" };
  }

  get isBusy(): boolean {
    return this.runner.isBusy;
  }

  /**
   * True only after the scheduler starts the provider run, through its post-run
   * hook. Queueing is exposed separately by {@link isQueued}.
   */
  get isRunning(): boolean {
    return this.executing;
  }

  /** True while a run is waiting in provider pacing or the mesh concurrency queue. */
  get isQueued(): boolean {
    return this.queued;
  }

  markUnkillable(): void {
    this.killable = false;
  }

  /** Cancel a provider start that is still queued, retaining its scheduling opportunity. */
  cancelQueuedRun(): boolean {
    // A re-quote has already cancelled the provider reservation but has not
    // unwound into its fresh admission yet. A halt in that window must claim
    // the queued work and clear the dirty replay, otherwise the fresh
    // beforeRun would skip it without leaving anything for /resume to replay.
    if (this.reschedulingQueuedRun) {
      this.cancelledQueuedNudge = this.runner.currentNudgeSnapshot();
      this.reschedulingQueuedRun = false;
      // A re-admission can be paused in beforeRun after the old reservation
      // has unwound. Invalidate that admission too, so its eventual preflight
      // result cannot proceed after this halt has parked the opportunity.
      this.admissionEpoch++;
      this.runner.cancelPending();
      this.cancelledQueuedRun = true;
      return true;
    }
    if (!this.pendingStart?.cancel?.()) return false;
    this.cancelledQueuedNudge = mergeNudges(
      this.runner.currentNudgeSnapshot(),
      this.nudgeWhileQueued ?? null
    );
    this.nudgeWhileQueued = undefined;
    this.cancelledQueuedRun = true;
    this.opts.onQueuedRunCancelled?.();
    return true;
  }

  /**
   * Replace a not-yet-started reservation after its next-run configuration
   * changes. The runner is already single-flight, so request the replacement
   * through its dirty bit: the cancelled opportunity unwinds first, then one
   * fresh admission re-quotes the current candidate pool. Unlike a halt
   * cancellation, this work is immediately eligible to run and must not wait
   * for `resumeCancelledRun()`.
   */
  rescheduleQueuedRun(): boolean {
    // Repeated model updates before the cancelled start unwinds share the
    // already-recorded dirty replay; its beforeRun reads the final replacement
    // pool, so another cancellation would only create duplicate bookkeeping.
    if (this.reschedulingQueuedRun) return true;
    if (!this.pendingStart?.cancel?.()) return false;
    this.reschedulingQueuedRun = true;
    this.opts.onQueuedRunCancelled?.();
    this.runner.requeueCurrentRun();
    return true;
  }

  /** Replay the content-free scheduling opportunity retained by {@link cancelQueuedRun}. */
  resumeCancelledRun(): boolean {
    if (!this.cancelledQueuedRun) return false;
    const nudge = this.cancelledQueuedNudge ?? {};
    this.cancelledQueuedRun = false;
    this.cancelledQueuedNudge = undefined;
    if (nudge.mode !== "yield-elicitation") {
      this.continuations = 0;
    }
    // Bypass Actor.requestRun's queued fast-path: a halt can lift while the
    // cancelled gate is still unwinding, and TriggerRunner will coalesce this
    // retained opportunity into that exact one replay.
    this.runner.requestRun(nudge);
    return true;
  }

  /**
   * Replace the current execution opportunity with newly delivered responsive work.
   *
   * Unlike a manual {@link interrupt}, this deliberately sets no inbox watermark:
   * the replacement run must see both the responsive entry and any earlier work the
   * interrupted run had not committed as handled. A queued start is cancelled
   * without retaining the halt/resume dirty flag because the caller immediately
   * requests its responsive replacement.
   */
  preemptForResponsive():
    | { preempted: false }
    | { preempted: true; phase: "running" | "winding_down" | "queued" } {
    this.admissionEpoch++;
    const phase = this.executing
      ? this.yielded
        ? "winding_down"
        : "running"
      : this.pendingStart || this.queued || this.runner.isBusy
        ? "queued"
        : undefined;
    if (!phase) return { preempted: false };

    // Drop any previously coalesced follow-up. The responsive inbox delivery that
    // caused this call is the one replacement opportunity we want to retain.
    this.runner.cancelPending();

    if (this.executing && this.coalesceAbortController) {
      if (this.coalesceAbortController.signal.aborted) return { preempted: false };
      this.coalesceAbortController.abort(createInterruptAbortReason(RESPONSIVE_PREEMPTION_SOURCE));
      return { preempted: true, phase };
    }
    this.queued = false;
    this.publishRuntimeStateIfChanged();

    if (this.pendingStart) {
      if (this.pendingStart.cancel) {
        if (this.pendingStart.cancel()) {
          this.opts.onQueuedRunCancelled?.();
        } else {
          this.preemptedQueuedRun = true;
          return { preempted: true, phase: "queued" };
        }
      }
    }

    return { preempted: true, phase: "queued" };
  }

  /**
   * Interrupt this actor if it has an in-flight run (executing or queued).
   * Sets the interrupted watermark to the run's start time so older inbox items
   * do not immediately re-schedule the actor.
   */
  interrupt(by: string = "human:operator"): {
    interrupted: boolean;
    runStartTime?: Date;
    wasQueued?: boolean;
  } {
    this.admissionEpoch++;
    const now = new Date();
    this.runner.cancelPending();
    if (this.executing && this.coalesceAbortController) {
      const runStartTime = this.currentRunStartTime ?? now;
      this.interruptedWatermark = runStartTime;
      this.coalesceAbortController.abort(createInterruptAbortReason(by));
      return { interrupted: true, runStartTime, wasQueued: false };
    }
    if (this.pendingStart || this.queued || this.runner.isBusy) {
      this.interruptedWatermark = now;
      if (this.pendingStart) {
        this.cancelQueuedRun();
      }
      this.queued = false;
      this.publishRuntimeStateIfChanged();
      return { interrupted: true, runStartTime: now, wasQueued: true };
    }
    return { interrupted: false };
  }

  getInterruptedWatermark(): Date | null {
    return this.interruptedWatermark;
  }

  clearInterruptWatermark(): void {
    this.interruptedWatermark = null;
  }

  /**
   * Adopt a staged modelConfig pool replacement (`set_actor_model`) on the live
   * actor, so the very next run gates against the new declared pool instead of
   * waiting for a full actor rebuild.
   */
  setModelConfig(modelConfig: ProviderModelConfig[]): void {
    this.opts.modelConfig = modelConfig;
  }

  close(): void {
    this.closed = true;
    this.nudgeWhileQueued = undefined;
    this.runner.close();
    this.pendingStart?.cancel?.();
    if (this.opts.sandbox) {
      teardownFlutterOverlay(this.opts.cwd);
    }
    if (this.yieldGraceTimer) {
      clearTimeout(this.yieldGraceTimer);
      this.yieldGraceTimer = undefined;
    }
  }

  private admissionEpoch = 0;

  private async runOnce(nudge: RunNudge): Promise<void> {
    if (this.closed) {
      this.lastRunSkipped = true;
      return;
    }
    const epoch = this.admissionEpoch;
    if (this.opts.beforeRun && !(await this.opts.beforeRun({ mode: nudge.mode ?? "ordinary" }))) {
      // The replacement admission has reached its preflight after the old
      // reservation unwound. A halt/shutdown that closes this gate must retain
      // the same work for resume; otherwise its runner dirty bit would be
      // consumed as a dropped wake with no cancelled-run record.
      if (this.reschedulingQueuedRun) {
        this.reschedulingQueuedRun = false;
        this.cancelledQueuedNudge = this.runner.currentNudgeSnapshot();
        this.cancelledQueuedRun = true;
      }
      this.lastRunSkipped = true;
      return;
    }
    if (this.admissionEpoch !== epoch) {
      // Preempted or interrupted during async beforeRun
      this.lastRunSkipped = true;
      return;
    }
    // The re-admission has passed its only preflight boundary. From this
    // point a normal queued-start cancellation owns the fresh reservation.
    this.reschedulingQueuedRun = false;
    this.lastRunSkipped = false;
    // A yield only counts for the run it was declared in; clear any prior flag.
    this.yielded = false;
    this.yieldStatus = undefined;
    this.yieldNote = undefined;
    this.runEndReported = false;
    this.runStartReported = false;
    const runId = randomUUID();
    this.currentRunId = runId;
    this.currentRunStartTime = new Date();
    // The run is queued until invoke() is selected by both gates.
    this.queued = true;
    this.publishRuntimeStateIfChanged();
    try {
      await this.lifecycle.emit("onQueued", {
        actorId: this.id,
        runId,
        responsive: isResponsiveNudge(nudge),
        mode: nudge.mode ?? "ordinary",
      });
      await this.executeTurn(nudge);
    } finally {
      if (this.opts.sandbox) {
        teardownFlutterOverlay(this.opts.cwd);
      }
      if (this.yieldGraceTimer) {
        clearTimeout(this.yieldGraceTimer);
        this.yieldGraceTimer = undefined;
      }
      this.currentRunStartTime = null;
      this.queued = false;
      this.executing = false;
      this.publishRuntimeStateIfChanged();
      // Close the opportunity this `finally` just opened flags for. It lives here,
      // beside the flag clears, for the same reason they do: `executeTurn` has
      // terminal paths that return early, and a signal emitted at each of them is
      // one a new path can silently omit. Anything that opens state on onQueued
      // and closes it on onRunEnd — the mesh's in-flight run accounting, ISSUE_NUM —
      // depends on the pairing being total, not on the current list of exits.
      if (!this.runEndReported) await this.reportAbandonedRun();
      this.currentRunId = undefined;
      if (!this.runStartReported && this.nudgeWhileQueued) {
        const replay = this.nudgeWhileQueued;
        this.nudgeWhileQueued = undefined;
        this.runner.requestRun(replay);
      }
    }
  }

  /** The terminal hook for a run that ended without reporting a result. */
  private async reportAbandonedRun(): Promise<void> {
    // `coalesceAborted` and `lastRunSkipped` are still set from the path that
    // took us here. Neither is required to be: an unclassified terminal path
    // still reports, as `unreported`, because the accounting must not depend on
    // recognizing why.
    const reason: RunAbandonReason = this.coalesceAborted
      ? "coalesced"
      : this.lastRunSkipped
        ? "start-cancelled"
        : "unreported";
    const runId = this.currentRunId;
    if (!runId) return;
    // Claim the terminal transition before observer fanout. An observer failure
    // is contained, and a compatibility hook throw cannot produce a duplicate.
    this.runEndReported = true;
    await this.lifecycle.emit("onEnd", {
      actorId: this.id,
      runId,
      terminal: { kind: "abandoned", reason, started: this.runStartReported },
    });
  }

  /** The genuine-execution body of a run (everything after the beforeRun gate). */
  private async executeTurn(nudge: RunNudge): Promise<void> {
    const isCorrectiveRun = nudge.mode === "yield-elicitation";
    let responsive = isResponsiveNudge(nudge);
    const sessionId = this.opts.loadSessionId();
    // The provider treats the actor's cwd as its private directory and shadows
    // everything beside it (see buildActorBwrapArgs). This object is just the
    // opt-in signal.
    let understandingMount: string | undefined;
    if (this.opts.sandbox && this.opts.prepareUnderstandingMount) {
      understandingMount = await this.opts.prepareUnderstandingMount();
    }
    const sandbox: SandboxOptions | undefined = this.opts.sandbox
      ? {
          worktreePath: this.opts.cwd,
          isE2eRoot: this.opts.isE2eRoot,
          understandingMount,
        }
      : undefined;

    this.killable = true;
    this.coalesceAborted = false;
    const abortController = new AbortController();
    this.coalesceAbortController = abortController;
    let stallTimer: NodeJS.Timeout | undefined;
    let ceilingTimer: NodeJS.Timeout | undefined;
    let firstChunkSeen = false;
    const runTimeoutMs = this.opts.timeoutMs ?? WATCHDOG_CEILING_TIMEOUT_MS;

    const clearTimers = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
      if (ceilingTimer) {
        clearTimeout(ceilingTimer);
        ceilingTimer = undefined;
      }
      if (this.yieldGraceTimer) {
        clearTimeout(this.yieldGraceTimer);
        this.yieldGraceTimer = undefined;
      }
    };

    const resetStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
      }
      stallTimer = setTimeout(() => {
        this.opts.log?.(`\n[Watchdog] Run stalled (no output for 15 minutes). Terminating...\n`);
        abortController.abort(STALL_WATCHDOG_ABORT_REASON);
      }, WATCHDOG_STALL_TIMEOUT_MS);
    };

    // Both timers measure EXECUTION, not queueing, so they must not start until
    // the gate actually starts the provider. Provider pacing and the normal-only
    // mesh FIFO can hold a run behind others for far longer than either timeout. A
    // run that hasn't started has by construction produced no output, so a stall
    // timer spanning the gate reads "queued" as "stalled" and kills it at 5:00 of
    // *waiting*. That abort is also the only one the run ever gets — abort() is
    // idempotent — so the run then spawns on a dead signal and executes to the
    // provider backstop with nothing watching it.
    const startWatchdogTimers = () => {
      ceilingTimer = setTimeout(() => {
        this.opts.log?.(
          `\n[Watchdog] Run ceiling timeout reached (${runTimeoutMs}ms). Terminating...\n`
        );
        abortController.abort(RUN_CEILING_ABORT_REASON);
      }, runTimeoutMs);
      resetStallTimer();
    };

    // Assigned inside the try below (buildPrompt sits within the terminal-failure
    // boundary), then read by this closure when the gated invoke actually runs.
    let built: PromptBuild;
    const runProvider = (provider: CodingProvider): Promise<RunResult> => {
      this.opts.onProviderAttempt?.(provider);
      return provider.run({
        prompt: built.prompt,
        cwd: this.opts.cwd,
        // Continue this actor's own session (id undefined on first run → created).
        session: { id: sessionId },
        mcpServers: this.opts.mcpServers,
        addDirs: this.opts.addDirs,
        sandbox,
        // timeoutMs: provider OS-level timeout is the actor ceiling plus a grace
        // margin. The AbortController is the primary kill path; Node's spawn
        // timeout is only a backstop for the rare case our abort fails to land.
        timeoutMs: runTimeoutMs + 30_000,
        signal: abortController.signal,
        onChunk: (chunk: string) => {
          // Once per RUN, not per provider attempt: `runWithPoolFallback` can call
          // runProvider again on a different model, and the question this answers
          // is "when did this wake start producing output", not "when did each
          // attempt". The flag lives in the run scope for that reason.
          if (!firstChunkSeen) {
            firstChunkSeen = true;
            this.opts.onFirstChunk?.();
          }
          resetStallTimer();
          this.opts.log?.(chunk);
        },
      });
    };
    const invoke = async (selected: RawProviderModelConfig): Promise<RunResult> => {
      // Both queues have selected this run. From this point a later responsive
      // wake obeys per-actor serialization; v1 never cancels a live provider.
      this.pendingStart = undefined;
      this.queued = false;
      this.nudgeWhileQueued = undefined;
      if (this.closed || this.preemptedQueuedRun) {
        this.preemptedQueuedRun = false;
        throw new RunStartCancelledError();
      }
      if (
        this.opts.admitRun &&
        !(await this.opts.admitRun({
          responsive,
          mode: nudge.mode ?? "ordinary",
        }))
      ) {
        // A normal run can wait in provider pacing after its initial preflight.
        // Do not let that stale opportunity cross a newer host-owned authority
        // boundary; the authority release supplies its own durable-work nudge.
        this.lastRunSkipped = true;
        throw new RunStartCancelledError();
      }
      this.executing = true;
      this.publishRuntimeStateIfChanged();
      if (
        this.interruptedWatermark &&
        this.currentRunStartTime &&
        this.currentRunStartTime > this.interruptedWatermark
      ) {
        this.interruptedWatermark = null;
      }
      built = isCorrectiveRun
        ? {
            prompt:
              "Yield required: your previous run ended without calling yield_run. " +
              "End this run correctly now by calling yield_run with status complete or blocked. " +
              "Do not do additional work in this corrective run.",
          }
        : this.opts.buildPrompt();
      const runId = this.currentRunId;
      if (!runId) throw new Error(`actor ${this.id} started without a lifecycle run id`);
      // Inside the gate: the provider is starting. The hook fires here rather than
      // beside onQueued so a run queued behind the concurrency cap is
      // distinguishable from one that started and went quiet — same reason the
      // watchdog timers moved in here .
      await this.lifecycle.emit("onStart", {
        actorId: this.id,
        runId,
        responsive,
        mode: nudge.mode ?? "ordinary",
        injectRecord: built.injectRecord,
        selected,
      });
      // AFTER the hook, not before: this flag means "a start was announced", so a
      // hook that threw before announcing must not leave a bracket a reader will
      // wait forever to see closed. (The mirror of `runEndReported`, which is set
      // BEFORE its hook for the opposite reason — there the risk is reporting the
      // same run's outcome twice, here it is claiming a start nobody saw.)
      this.runStartReported = true;
      startWatchdogTimers();
      return this.runWithPoolFallback(
        runId,
        selected,
        this.opts.resolveProvider(selected),
        runProvider
      );
    };

    // The post-run hook is the single choke point for failure forwarding, so it
    // must fire on *every* terminal outcome — including a provider that throws
    // before returning a result (e.g. a sandbox that can't even spawn the CLI).
    // Synthesize a failure result in that case rather than letting it escape.
    //
    // Admission-time prompt assembly runs INSIDE this boundary: it can
    // throw (the portable-context path reads mesh events / parses run_end bodies),
    // and a build-throw must be caught + synthesized + forwarded exactly like a
    // provider throw — not escape after `executing=true` with the parent never
    // told the worker died.
    let result: RunResult;
    try {
      if (this.opts.gate) {
        // A staged modelConfig swap can land while this request is genuinely
        // queued behind a specific lane's pacer/capacity. `gate` rejects with
        // RunStartStaleProviderError in that case rather than starting under
        // a stale pool snapshot; re-reading `this.opts.modelConfig` (now
        // live, via the same applyPendingModel call that raised the
        // rejection) and re-gating re-selects the correct lane instead of
        // losing the run.
        for (;;) {
          const gated = this.opts.gate(invoke, this.opts.modelConfig, responsive);
          const gatedStart: RunStartHandle<RunResult> =
            gated instanceof Promise
              ? { result: gated, started: false, promote: () => {}, cancel: () => false }
              : gated;
          // A responsive nudge can arrive after ordinary admission has reserved
          // a lane but before it invokes the provider. Keep run-start telemetry
          // aligned with that promoted priority while delegating the actual
          // queue bypass to the gate's existing handle.
          const start: RunStartHandle<RunResult> = {
            result: gatedStart.result,
            get started() {
              return gatedStart.started;
            },
            promote: () => {
              if (!gatedStart.started) responsive = true;
              gatedStart.promote();
            },
            cancel: gatedStart.cancel
              ? () => gatedStart.cancel?.call(gatedStart) ?? false
              : undefined,
          };
          this.pendingStart = start;
          try {
            result = await start.result;
            break;
          } catch (err) {
            if (err instanceof RunStartStaleProviderError) {
              // The pool that just became live (via the same
              // applyPendingModel call that raised this rejection) may have
              // every candidate durably halted — the pacer only
              // re-validated lane membership, not halt state, since halting
              // is a separate concern from provider pacing. Re-run the same
              // admission gate this run already passed once on its original
              // pool; if the newly-live pool is fully halted, this is
              // exactly a queued run cancelled out from under it, so retain
              // the same replay flag `cancelQueuedRun` sets, letting
              // `resumeCancelledRun` (already the production halt/resume
              // replay path) relaunch it once the halt clears — no parallel
              // lifecycle construct.
              if (
                this.opts.beforeRun &&
                !(await this.opts.beforeRun({ mode: nudge.mode ?? "ordinary" }))
              ) {
                this.cancelledQueuedRun = true;
                this.lastRunSkipped = true;
                return;
              }
              continue;
            }
            throw err;
          }
        }
      } else {
        result = await invoke(this.opts.modelConfig[0]);
      }
    } catch (err) {
      if (err instanceof RunStartCancelledError) {
        this.lastRunSkipped = true;
        return;
      }
      if (this.coalesceAborted) return;
      const runId = this.currentRunId;
      if (runId) await this.lifecycle.emit("onError", { actorId: this.id, runId, error: err });
      result = {
        success: false,
        output: err instanceof Error ? (err.stack ?? err.message) : String(err),
        exitCode: 1,
        sessionId,
      };
    } finally {
      this.pendingStart = undefined;
      clearTimers();
    }

    if (this.coalesceAborted) return;
    this.coalesceAbortController = undefined;

    if (abortController.signal.aborted && !result.cancelled) {
      result.success = false;
      Object.assign(result, formatSigtermResult(result.output, abortController.signal));
    }

    if (result.sessionId && result.sessionId !== sessionId) {
      this.opts.saveSessionId(result.sessionId);
    }

    const wasGraceKilled =
      (abortController.signal.aborted &&
        abortController.signal.reason === YIELD_GRACE_ABORT_REASON) ||
      result.graceKilled === true;

    if (this.yielded) {
      result.yieldStatus = this.yieldStatus ?? "complete";
      result.yieldNote = this.yieldNote;
      if (wasGraceKilled) {
        // Fix ISSUE_NUM: when the supervisor's grace-kill follows a successful yield
        // in the same run, the run-end record must KEEP the yield's status
        // (complete/blocked) and carry the overrun as an attributed annotation
        // (graceKilled: true), NOT flip the run to failed.
        result.success = true;
        result.graceKilled = true;
      }
    }

    if (result.success && !this.yielded && isCorrectiveRun) {
      this.opts.onContinuationCapped?.(YIELD_ELICITATION_MAX);
      const reason =
        "Run failed: actor ended the corrective yield-elicitation run without calling yield_run.";
      result = {
        ...result,
        success: false,
        exitCode: result.exitCode === 0 ? 1 : result.exitCode,
        output: result.output ? `${reason}\n\n${result.output}` : reason,
        capped: true,
      };
    }
    // Read by continueOrIdle: a failed run stops yield elicitation and delegates
    // up rather than retrying. Set before onRun so the post-run hook (failure
    // forwarding) and the continuation decision see a consistent outcome.
    this.lastRunFailed = !result.success;
    // Set BEFORE the await, not after: from here this run has reported its
    // outcome. If the hook itself throws partway, the run must not ALSO be
    // reported abandoned — one opportunity, one terminal signal.
    this.runEndReported = true;
    const runId = this.currentRunId;
    if (!runId) throw new Error(`actor ${this.id} ended without a lifecycle run id`);
    await this.lifecycle.emit("onEnd", {
      actorId: this.id,
      runId,
      terminal: { kind: "result", result },
    });
  }

  /**
   * Derive the narrow public runtime state from the actor's own flags. Keeping
   * this beside the mutations prevents audit-hook ordering from becoming a
   * second, fallible state machine.
   */
  private publishRuntimeStateIfChanged(): void {
    const state = this.executing
      ? this.yielded
        ? "winding_down"
        : "running"
      : this.queued
        ? "queued"
        : "idle";
    if (state === this.lastPublishedRuntimeState) return;
    this.lastPublishedRuntimeState = state;
    this.opts.onRuntimeStateChanged?.(state);
  }

  /**
   * Run the gated primary entry, then — only when this actor has an
   * exhaustion classifier and the primary's failure is classified as provider
   * capacity/quota exhaustion — recover onto the remaining entries of the
   * declared modelConfig pool, in configured order, without retrying the
   * failed entry (MEK-Org/rusa#450). Each entry keeps its own
   * provider/model/effort tuple: the chain never reinterprets a model under a
   * different provider. The classifier is wired only for the root, so a
   * worker's failures still report as-is.
   *
   * The recovery chain bypasses admission-time provider pacing: the run is
   * already actively executing under its watchdog timer and allocated
   * concurrency slot. Putting an active run to sleep in an asynchronous pacer
   * queue mid-run would tie up concurrency and risk run timeouts. In-run
   * fallback is emergency capacity recovery where an immediate live attempt on
   * configured alternatives takes precedence over potentially stale or lagging
   * quota-coordinator pacing forecasts ("a live attempt beats a stale forecast").
   */
  private async runWithPoolFallback(
    runId: string,
    selected: RawProviderModelConfig,
    primary: CodingProvider,
    runProvider: (provider: CodingProvider) => Promise<RunResult>
  ): Promise<RunResult> {
    const result = await runProvider(primary);
    const classify = this.opts.classifyExhaustion;
    if (result.success || !classify) return result;
    // A supervisor grace-kill (#257) is cleanup after the actor already yielded,
    // not a capacity failure, and the kill has already aborted this run's
    // signal — so there is nothing left to retry: every fallback attempt would
    // short-circuit to an instantly-killed result. Deterministically, without
    // this guard such a run is still handed to the exhaustion classifier, an
    // LLM judgment over its own transcript tail. Conditionally, if that returns
    // exhausted, the chain then runs to its end and replaces the termination
    // diagnostic with a pool-exhausted summary that never happened.
    if (result.graceKilled) return result;

    if (!(await classify(result)).exhausted) return result;

    const primaryName = describeModelConfigEntry(selected);
    // The chain excludes the failed entry by value, not by position: the gate
    // may have launched a later pool entry (earliest-available-first), and
    // recovery must never retry the entry that just failed, wherever it sits
    // in the declared order.
    const chain = this.opts.modelConfig.filter((entry) => !sameModelConfigEntry(entry, selected));
    let failed = selected;
    let lastResult = result;
    for (const [index, entry] of chain.entries()) {
      const attempt = index + 2; // attempt 1 was the gated primary
      this.opts.onPoolFallback?.({
        runId,
        attempt,
        failed: { ...failed },
        next: { ...entry },
        remainingAfter: chain.length - index - 1,
      });
      this.opts.log?.(
        `\n[PoolFallback] ${describeModelConfigEntry(failed)} exhausted; trying next configured pool entry ${describeModelConfigEntry(entry)}\n`
      );
      let provider: CodingProvider;
      try {
        provider = this.opts.resolveProvider(entry);
      } catch (err) {
        // The entry could not even be built — e.g. its provider was dropped
        // from config after this pool was persisted. That is a configuration
        // failure, and it must stay one rather than be retried under some
        // other tuple; but the run still failed because the primary was
        // exhausted, so report it the same way as a recovery attempt that
        // failed for a non-exhaustion reason below: exhaustion first, the
        // resolver error as context. Letting it escape would reach the
        // terminal boundary as a bare stack with no mention of the exhaustion.
        return {
          success: false,
          output: formatPoolRecoveryFailure({
            primaryName,
            recoveryEntry: describeModelConfigEntry(entry),
            recoveryOutput: err instanceof Error ? err.message : String(err),
          }),
          exitCode: lastResult.exitCode || 1,
          sessionId: lastResult.sessionId,
        };
      }
      const recoveryResult = await runProvider(provider);
      if (recoveryResult.success) return recoveryResult;
      if (!(await classify(recoveryResult)).exhausted) {
        // We only reach here because the primary was classified exhausted, so
        // returning the entry's error bare would report a soft, timer-bound
        // condition as an unrelated hard failure . Keep the entry's
        // exitCode/sessionId — the recovery attempt is the live session — but
        // lead the output with the exhaustion that actually caused this run.
        return {
          ...recoveryResult,
          output: formatPoolRecoveryFailure({
            primaryName,
            recoveryEntry: describeModelConfigEntry(entry),
            recoveryOutput: recoveryResult.output,
          }),
        };
      }
      failed = entry;
      lastResult = recoveryResult;
    }

    return {
      success: false,
      output: formatPoolExhaustedFailure({ attempted: [selected, ...chain] }),
      exitCode: lastResult.exitCode || 1,
      sessionId: lastResult.sessionId,
    };
  }
}

/**
 * Same configured tuple, modulo an absent model/effort spelling.
 *
 * Value comparison is used rather than reference identity (`entry !== selected`)
 * because `selected` may originate from deserialized event payloads, test
 * harnesses, or cloned pool snapshots (`[...modelConfig]`), or a concurrent
 * `setModelConfig`/`applyPendingModel` swap may have produced fresh object
 * references while the run was queued. Matching on the validated tuple values
 * (`provider`, `model`, `effort`) reliably excludes the failed candidate across
 * mutation and cloning boundaries.
 */
function sameModelConfigEntry(a: RawProviderModelConfig, b: RawProviderModelConfig): boolean {
  return (
    a.provider === b.provider &&
    (a.model ?? "") === (b.model ?? "") &&
    (a.effort ?? "") === (b.effort ?? "")
  );
}

/**
 * The terminal report when every configured pool entry was tried and each
 * failed with classified capacity/quota exhaustion. Actionable on purpose:
 * it names the condition, lists what was attempted in order, says what clears
 * it (the providers' reset timers), and what an operator can do about it.
 * Only configured entry tuples are named — raw provider output is never
 * pasted here, because a provider echoes the prompt and the prompt carries
 * secrets.
 */
export function formatPoolExhaustedFailure(input: {
  /** Every entry attempted, launch first, then the chain in tried order. */
  attempted: readonly RawProviderModelConfig[];
}): string {
  const isSingle = input.attempted.length === 1;
  return [
    `model pool exhausted: all ${input.attempted.length} configured pool ${isSingle ? "entry" : "entries"} reported provider capacity/quota exhaustion.`,
    `Attempted in order: ${input.attempted.map(describeModelConfigEntry).join(" -> ")}.`,
    isSingle
      ? "The exhaustion is a provider-side condition that clears on the provider's reset timer. Wait for a quota reset, or switch to a portable actor (context.type: portable) and configure an ordered model pool so recovery has fallback candidates."
      : "The exhaustion is a provider-side condition that clears on the providers' reset timers; no configured entry has capacity right now. Wait for a quota reset, or configure an additional pool entry that has capacity so recovery has somewhere to go.",
  ].join("\n");
}
