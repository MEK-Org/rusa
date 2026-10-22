import { randomUUID } from "node:crypto";
import {
  describeModelConfigEntry,
  type ProviderModelConfig,
  type RawProviderModelConfig,
} from "../providers/model-config.js";
import { teardownFlutterOverlay } from "../providers/sandbox.js";
import {
  createInterruptAbortReason,
  extractAbortReason,
  formatSigtermResult,
  RUN_CEILING_ABORT_REASON,
  STALL_WATCHDOG_ABORT_REASON,
} from "../providers/termination-attribution.js";
import type {
  CodingProvider,
  McpServerSpec,
  RunResult,
  RunTermination,
  SandboxOptions,
} from "../providers/types.js";
import {
  type ActorLifecycle,
  type ActorLifecycleAbandonmentReason,
  createActorLifecycle,
} from "./actor-lifecycle.js";
import {
  PoolExhaustedError,
  RunStartCancelledError,
  type RunStartHandle,
  RunStartStaleProviderError,
} from "./concurrency-limiter.js";
import { FAILURE_DIAGNOSTIC_BUDGET, failureDiagnostic } from "./failure-sink.js";
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
export const RESPONSIVE_PREEMPTION_SOURCE = "responsive-notification";

/**
 * What {@link ActorOptions.buildPrompt} returns: the assembled prompt, plus —
 * for portable-context actors (design ISSUE_NUM) — the inject record describing the
 * mesh-portable context folded into this run's prompt.
 */
export interface PromptBuild {
  prompt: string;
  /** Portable-context inject record for this run, or undefined when nothing was injected. */
  injectRecord?: InjectRecord;
  /**
   * Portable actors only: every actor_run id read for this prompt's run
   * history (at most the portable run window), oldest first, captured before
   * budget selection (#1024). Unlike
   * `injectRecord.sourceEventIds` it includes runs dropped for budget, and it
   * is set even when nothing was injected: `[]` means no runs were read, while
   * absent means unknown (a native actor, or a leader that predates the field).
   */
  readRunIds?: string[];
}

/**
 * The normalized identity of one provider invocation.  This deliberately
 * contains only the values consumers such as write attribution need, so a
 * remote runtime can forward its actual attempt without pretending to own a
 * full provider implementation.
 */
export interface ProviderAttempt {
  providerName: string;
  model?: string;
  effort?: string;
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
   * Prepares run-scoped MCP entries before a remote follower receives its
   * admission snapshot. Local actors mount the same entries from `onStart`.
   */
  prepareRunMcp?: (runId: string) => void;
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
   * Recover a failed run onto the remaining entries of this actor's declared
   * {@link modelConfig} pool, in order, at most once per entry, each entry
   * keeping its own provider/model/effort tuple (#1150). Any failed run that
   * was not stopped on purpose qualifies; nothing guesses its cause. Set only
   * for the configured root. A worker's failed run is reported as-is: its
   * parent decides whether to retry, change models, hold a provider or
   * escalate.
   */
  recoverFailedRuns?: boolean;
  /**
   * Structured, bounded diagnostic for each pool-fallback transition: the
   * invocation on `failed` failed, so recovery is moving to `next`. Carries
   * configured entry tuples and counts only — never provider output, which
   * echoes the prompt and can hold secrets.
   */
  onPoolFallback?: (diagnostic: PoolFallbackDiagnostic) => void;
  /**
   * Non-blocking, synchronous probe to verify candidate eligibility during
   * in-run recovery. Represents the non-blocking half of the admission gate
   * contract (submitPoolGate's isHalted check plus ProviderPacer.quote), not a
   * new scheduler: checks whether the candidate provider is halted,
   * coordinator-reported exhausted, or currently pace-deferred without entering
   * an asynchronous wait queue. When omitted, candidates are treated as
   * eligible.
   */
  recoveryEligibility?: (
    entry: RawProviderModelConfig
  ) => { eligible: true } | { eligible: false; reason: "halted" | "pacing" | "exhausted" };
  /** Debounce window for coalescing wake bursts (default: TriggerRunner default). */
  debounceMs?: number;
  /** Per-run provider timeout. */
  timeoutMs?: number;
  /** Max age of coalesced voice events before the run becomes unkillable (default 8000). */
  voiceCoalesceMaxAgeMs?: number;
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
   * Returns whether computer-use capability is admitted for the upcoming/active run.
   * Called before every provider attempt, including pool fallback. Local callers
   * intersect the run's lock admission with the live grant: revokes deny, while
   * grants after a skipped lock wait for the next run.
   */
  isComputerUseAdmitted?: () => boolean;
  /**
   * Called immediately before each provider attempt with the instance that will
   * run. Unlike onRunStart, this includes fallbacks without changing run
   * lifecycle accounting. Its model and effort are the instantiated values, not
   * the pre-normalization request. The provider is not invoked until a returned
   * promise settles, so a hook that publishes the attempt elsewhere can confirm
   * it is installed before the provider can act under it.
   */
  onProviderAttempt?: (provider: ProviderAttempt) => void | Promise<void>;
  /**
   * Prepare one provider invocation after its prompt is assembled, before
   * `onProviderAttempt` and the adapter. A rejection prevents that provider
   * from starting.
   * The returned prompt attempt, when present, is carried to the launched
   * prompt observer without changing the provider-facing prompt.
   */
  beforeProviderAttempt?: (context: {
    runId: string;
  }) => number | undefined | Promise<number | undefined>;
  /**
   * Optional hook fired ONCE per run, on the first chunk the provider emits —
   * the moment it starts answering, as distinct from the moment we asked.
   */
  onFirstChunk?: () => void;
  /** Publish the actor's derived runtime state after each real flag mutation cluster. */
  onRuntimeStateChanged?: (state: "queued" | "running" | "idle") => void;
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
  /**
   * The settled provider call's termination evidence, when one settled
   * (#1119); a leader reads it only for a receipt-backed run.
   */
  termination?: RunTermination;
}

/** Why a run opportunity ended without a result. */
export type RunAbandonReason = ActorLifecycleAbandonmentReason;

/**
 * One pool-fallback transition within a run: the invocation on {@link failed}
 * failed, so recovery is moving to {@link next}. Emitted
 * through {@link ActorOptions.onPoolFallback} before each recovery attempt.
 */
export interface PoolFallbackDiagnostic {
  /** Lifecycle run id the transition belongs to, for run-scoped records. */
  runId: string;
  /** 1-based invocation index in this run's chain: 1 is the gated primary attempt. */
  attempt: number;
  /** Configured pool entry whose invocation just failed. */
  failed: RawProviderModelConfig;
  /** Configured pool entry recovery will try next (or evaluated next). */
  next: RawProviderModelConfig;
  /** Configured entries still untried after {@link next}. */
  remainingAfter: number;
  /**
   * When this candidate was skipped rather than attempted (e.g. because it was
   * halted, coordinator-reported exhausted, or pacing-deferred), the reason for
   * skipping. Omitted on live attempts.
   */
  skipReason?: "halted" | "pacing" | "exhausted";
}

/**
 * The primary entry's resolver refused it, so no provider was invoked (#980).
 * Raised only at that boundary: a recovery entry that cannot be prepared is
 * recorded as that entry's failed attempt, and recovery moves on.
 */
class ProviderSelectionError extends Error {
  constructor(override readonly cause: unknown) {
    super("provider selection failed");
    this.name = "ProviderSelectionError";
  }
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
  /**
   * Termination evidence from the provider call this run settled, carried to
   * the abandonment hook (#1119). Unset when no provider call settled.
   */
  private runTermination?: RunTermination;
  /** Handle for this actor's provider run while it is waiting to start. */
  private pendingStart?: RunStartHandle<RunResult>;
  /** True when the last wake was gated off by {@link ActorOptions.beforeRun} (nothing ran). */
  private lastRunSkipped = false;
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
  private currentRunStartTime: Date | null = null;
  private interruptedWatermark: Date | null = null;
  private lastPublishedRuntimeState: "queued" | "running" | "idle" = "idle";

  constructor(private readonly opts: ActorOptions) {
    this.id = opts.id;
    this.lifecycle =
      opts.lifecycle ??
      createActorLifecycle([], (failure) => {
        this.opts.log?.(
          `lifecycle ${failure.event} listener failed: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}\n`
        );
      });
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
   * The {@link TriggerRunner.onIdle} policy: under #664, a provider CLI run
   * settles when the local or remote CLI returns.
   */
  private continueOrIdle(): RunNudge | null {
    return null;
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

  /**
   * Cancel a provider start that is still queued. By default (`retain: true`),
   * retains its scheduling opportunity for resume (used by halt/concurrency).
   * When `retain: false`, drops the opportunity so empty-inbox cancellations
   * leave the actor idle without waiting for a resume replay.
   */
  cancelQueuedRun(opts?: { retain?: boolean }): boolean {
    const retain = opts?.retain ?? true;
    // A re-quote has already cancelled the provider reservation but has not
    // unwound into its fresh admission yet. A halt in that window must claim
    // the queued work and clear the dirty replay, otherwise the fresh
    // beforeRun would skip it without leaving anything for /resume to replay.
    if (this.reschedulingQueuedRun) {
      if (retain) {
        this.cancelledQueuedNudge = this.runner.currentNudgeSnapshot();
        this.cancelledQueuedRun = true;
      } else {
        this.cancelledQueuedNudge = undefined;
        this.cancelledQueuedRun = false;
      }
      this.reschedulingQueuedRun = false;
      // A re-admission can be paused in beforeRun after the old reservation
      // has unwound. Invalidate that admission too, so its eventual preflight
      // result cannot proceed after this halt has parked the opportunity.
      this.admissionEpoch++;
      this.runner.cancelPending();
      return true;
    }
    if (!this.pendingStart?.cancel?.()) return false;
    if (retain) {
      this.cancelledQueuedNudge = mergeNudges(
        this.runner.currentNudgeSnapshot(),
        this.nudgeWhileQueued ?? null
      );
      this.cancelledQueuedRun = true;
      this.nudgeWhileQueued = undefined;
    } else {
      this.cancelledQueuedNudge = undefined;
      this.cancelledQueuedRun = false;
      // Leave this.nudgeWhileQueued intact: if new work arrived while queued,
      // runOnce's finally block will request a fresh run for it.
    }
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
  preemptForResponsive(): { preempted: false } | { preempted: true; phase: "running" | "queued" } {
    this.admissionEpoch++;
    const phase = this.executing
      ? "running"
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
  interrupt(by: string): {
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
    this.runEndReported = false;
    this.runStartReported = false;
    this.runTermination = undefined;
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
      terminal: {
        kind: "abandoned",
        reason,
        started: this.runStartReported,
        ...(this.runTermination ? { termination: this.runTermination } : {}),
      },
    });
  }

  /** The genuine-execution body of a run (everything after the beforeRun gate). */
  private async executeTurn(nudge: RunNudge): Promise<void> {
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
    // The run's controller carries only stops someone chose: an operator
    // interrupt, a responsive preemption, a voice coalesce. Each provider
    // attempt gets its own controller, linked to this one, which the watchdog
    // timers abort instead; a watchdog kill therefore ends that attempt
    // without marking the whole run stopped, and a recovery attempt starts on
    // a live signal (#1150).
    const abortController = new AbortController();
    this.coalesceAbortController = abortController;
    let attemptController: AbortController | undefined;
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
    };

    const resetStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
      }
      stallTimer = setTimeout(() => {
        this.opts.log?.(`\n[Watchdog] Run stalled (no output for 15 minutes). Terminating...\n`);
        attemptController?.abort(STALL_WATCHDOG_ABORT_REASON);
      }, WATCHDOG_STALL_TIMEOUT_MS);
    };

    // Both timers measure EXECUTION, not queueing, so they must not start until
    // the gate actually starts the provider. Provider pacing and the normal-only
    // mesh FIFO can hold a run behind others for far longer than either timeout. A
    // run that hasn't started has by construction produced no output, so a stall
    // timer spanning the gate reads "queued" as "stalled" and kills it at 5:00 of
    // *waiting*. That abort is also the only one the run ever gets — abort() is
    // idempotent — so the run then spawns on a dead signal and executes to the
    // provider backstop with nothing watching it. They restart for each provider
    // attempt, so a recovery attempt never runs out its predecessor's clock.
    const startWatchdogTimers = () => {
      ceilingTimer = setTimeout(() => {
        this.opts.log?.(
          `\n[Watchdog] Run ceiling timeout reached (${runTimeoutMs}ms). Terminating...\n`
        );
        attemptController?.abort(RUN_CEILING_ABORT_REASON);
      }, runTimeoutMs);
      resetStallTimer();
    };

    // Assigned inside the try below (buildPrompt sits within the terminal-failure
    // boundary), then read by this closure when the gated invoke actually runs.
    let built: PromptBuild;
    const runProvider = async (
      provider: CodingProvider,
      recoveryContext?: string
    ): Promise<RunResult> => {
      const runId = this.currentRunId;
      // Unreachable, type narrowing only: currentRunId is set in executeTurn before runProvider is called.
      if (!runId) throw new Error(`actor ${this.id} started without a lifecycle run id`);
      const prompt = recoveryContext ? `${recoveryContext}\n\n${built.prompt}` : built.prompt;
      const attempt = new AbortController();
      attemptController = attempt;
      const stop = () => attempt.abort(abortController.signal.reason);
      if (abortController.signal.aborted) stop();
      else abortController.signal.addEventListener("abort", stop, { once: true });
      startWatchdogTimers();
      try {
        const promptAttempt = await this.opts.beforeProviderAttempt?.({ runId });
        await this.opts.onProviderAttempt?.(provider);
        const result = await provider.run({
          prompt,
          onPromptLaunched: (prompt) => {
            void this.lifecycle.emit("onPrompt", {
              actorId: this.id,
              runId,
              prompt,
              ...(promptAttempt === undefined ? {} : { attempt: promptAttempt }),
            });
          },
          cwd: this.opts.cwd,
          // Continue this actor's own session (id undefined on first run → created).
          session: { id: sessionId },
          mcpServers: this.opts.mcpServers,
          addDirs: this.opts.addDirs,
          sandbox,
          computerUse: this.opts.isComputerUseAdmitted?.() === true,
          // timeoutMs: provider OS-level timeout is the actor ceiling plus a grace
          // margin. The AbortController is the primary kill path; Node's spawn
          // timeout is only a backstop for the rare case our abort fails to land.
          timeoutMs: runTimeoutMs + 30_000,
          signal: attempt.signal,
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
        // A watchdog kill is attributed to its own attempt here, so a recovery
        // account names it; a chosen stop is attributed once, to the run, below.
        if (attempt.signal.aborted && !abortController.signal.aborted) {
          attributeAbort(result, attempt.signal);
        }
        return result;
      } finally {
        clearTimers();
        abortController.signal.removeEventListener("abort", stop);
      }
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
        // The same refusal drops a run whose inbox was handled to empty while
        // it waited; newly delivered work requests a fresh run.
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
      built = this.opts.buildPrompt();
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
      return this.runWithPoolFallback(runId, selected, runProvider);
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
      const cause = err instanceof ProviderSelectionError ? err.cause : err;
      const runId = this.currentRunId;
      if (runId) await this.lifecycle.emit("onError", { actorId: this.id, runId, error: cause });
      result = { ...thrownRunResult(err), sessionId };
    } finally {
      this.pendingStart = undefined;
      clearTimers();
    }

    this.runTermination = result.termination;
    if (this.coalesceAborted) return;
    this.coalesceAbortController = undefined;

    if (abortController.signal.aborted) attributeAbort(result, abortController.signal);

    if (result.sessionId && result.sessionId !== sessionId) {
      this.opts.saveSessionId(result.sessionId);
    }

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
    const state = this.executing ? "running" : this.queued ? "queued" : "idle";
    if (state === this.lastPublishedRuntimeState) return;
    this.lastPublishedRuntimeState = state;
    this.opts.onRuntimeStateChanged?.(state);
  }

  /**
   * Run the gated primary entry, then — only for an actor with
   * {@link ActorOptions.recoverFailedRuns} — recover a failed run onto the
   * remaining entries of the declared modelConfig pool, in configured order,
   * without retrying the failed entry (#1150). Each entry gets at most one
   * attempt and keeps its own provider/model/effort tuple: the chain never
   * reinterprets a model under a different provider. Recovery is gated on the
   * run having failed, not on a guess at why; a run stopped on purpose (an
   * operator interrupt, a responsive preemption, a voice coalesce) is never
   * retried. A provider's own stall watchdog or run ceiling is a failure, not
   * a stop, so it is recovered like any other.
   *
   * Each replacement receives the original prompt behind a factual account of
   * the earlier attempts, so it can check what they already did instead of
   * blindly repeating it. When every entry has failed or been skipped, the
   * run's result accumulates each attempt's bounded diagnostic.
   *
   * Recovery honors current halt and pacing eligibility non-blockingly via
   * {@link ActorOptions.recoveryEligibility}, evaluated per candidate at the
   * moment the chain reaches it. Ineligible candidates are skipped with a
   * bounded diagnostic, and recovery never sleeps in a pacer queue mid-run while
   * holding an active execution slot.
   */
  private async runWithPoolFallback(
    runId: string,
    selected: RawProviderModelConfig,
    runProvider: (provider: CodingProvider, recoveryContext?: string) => Promise<RunResult>
  ): Promise<RunResult> {
    if (!this.opts.recoverFailedRuns) {
      // Without recovery a throw is the run's own: executeTurn's terminal
      // boundary synthesizes and reports it.
      let primary: CodingProvider;
      try {
        primary = this.opts.resolveProvider(selected);
      } catch (err) {
        throw new ProviderSelectionError(err);
      }
      return runProvider(primary);
    }
    // A run's termination is observed only if every provider process it
    // launched was (#1119): a recovery attempt does not prove that an earlier
    // one ended. An entry that could not be constructed launched nothing, so
    // it does not bear on the evidence.
    let unproven = false;
    const attemptProvider = async (
      entry: RawProviderModelConfig,
      recoveryContext?: string
    ): Promise<RunResult> => {
      const attempt = await this.attemptPoolEntry(runId, entry, runProvider, recoveryContext);
      // A provider-selection failure never entered runProvider, so it cannot
      // make an otherwise fully observed chain unproven; missing evidence
      // from a process that did run stays unproven.
      if (attempt.termination !== "observed" && attempt.failure?.stage !== "provider-selection") {
        unproven = true;
      }
      return attempt;
    };
    const withEvidence = (composed: RunResult): RunResult => ({
      ...composed,
      termination: unproven ? "unproven" : "observed",
    });

    const result = await attemptProvider(selected);
    if (result.success || this.stoppedOnPurpose(result)) return result;
    // The chain excludes the failed entry by value, not by position: the gate
    // may have launched a later pool entry (earliest-available-first), and
    // recovery must never retry the entry that just failed, wherever it sits
    // in the declared order.
    const chain = this.opts.modelConfig.filter((entry) => !sameModelConfigEntry(entry, selected));
    // A single-entry pool has nowhere to recover to: its own result is the
    // whole account.
    if (chain.length === 0) return result;

    let failed = selected;
    let lastResult = result;
    const failures: FailedPoolAttempt[] = [{ entry: { ...selected }, result }];
    const skipped: PoolSkippedEntry[] = [];

    for (const [index, entry] of chain.entries()) {
      const attempt = index + 2; // attempt 1 was the gated primary
      const remainingAfter = chain.length - index - 1;

      const eligibility = this.opts.recoveryEligibility?.(entry) ?? { eligible: true };
      if (!eligibility.eligible) {
        this.opts.onPoolFallback?.({
          runId,
          attempt,
          failed: { ...failed },
          next: { ...entry },
          remainingAfter,
          skipReason: eligibility.reason,
        });
        this.opts.log?.(
          `\n[PoolFallback] ${describeModelConfigEntry(entry)} is ineligible (${eligibility.reason}); skipping\n`
        );
        skipped.push({ entry: { ...entry }, reason: eligibility.reason });
        continue;
      }

      this.opts.onPoolFallback?.({
        runId,
        attempt,
        failed: { ...failed },
        next: { ...entry },
        remainingAfter,
      });
      this.opts.log?.(
        `\n[PoolFallback] ${describeModelConfigEntry(failed)} failed; trying next configured pool entry ${describeModelConfigEntry(entry)}\n`
      );
      const recoveryResult = await attemptProvider(
        entry,
        formatRecoveryContext({ runId, entry, failures })
      );
      if (recoveryResult.success || this.stoppedOnPurpose(recoveryResult))
        return withEvidence(recoveryResult);
      failures.push({ entry: { ...entry }, result: recoveryResult });
      failed = entry;
      lastResult = recoveryResult;
    }

    // The notice's lead line names the run's selected entry, so the exhausted
    // chain stays typed only when that entry made the sole attempt (every
    // other entry skipped). Otherwise each attempt's typed fact stays on its
    // own line: typing the aggregate would pin a later entry's capacity
    // rejection on the selected one.
    const sole = failures.length === 1 ? failures[0]?.result.failure : undefined;
    return withEvidence({
      success: false,
      output: formatRecoveryChainFailure({ failures, skipped }),
      exitCode: lastResult.exitCode || 1,
      sessionId: lastResult.sessionId,
      ...(sole?.kind === "provider-capacity" ? { failure: sole } : {}),
    });
  }

  /**
   * One recovering run's attempt on one pool entry. Whatever ends the attempt —
   * a returned failure, an entry that cannot be built (its provider dropped
   * from config after the pool was persisted), or a provider that throws — is
   * that entry's result, so the chain keeps every earlier failure and the
   * remaining entries still get their attempts.
   */
  private async attemptPoolEntry(
    runId: string,
    entry: RawProviderModelConfig,
    runProvider: (provider: CodingProvider, recoveryContext?: string) => Promise<RunResult>,
    recoveryContext?: string
  ): Promise<RunResult> {
    try {
      let provider: CodingProvider;
      try {
        provider = this.opts.resolveProvider(entry);
      } catch (err) {
        throw new ProviderSelectionError(err);
      }
      return await runProvider(provider, recoveryContext);
    } catch (err) {
      const cause = err instanceof ProviderSelectionError ? err.cause : err;
      await this.lifecycle.emit("onError", { actorId: this.id, runId, error: cause });
      return thrownRunResult(err);
    }
  }

  /**
   * Whether this run was stopped on purpose rather than failing: this run's
   * own abort signal fired (operator interrupt, responsive preemption, voice
   * coalesce), or the result attributes an interrupt. Mechanical — read from
   * the signal and typed result fields, never from output. A provider-internal
   * stall-watchdog or run-ceiling kill is `cancelled` too, but nobody chose
   * it, so it does not count: it aborts only its own attempt's signal.
   */
  private stoppedOnPurpose(result: RunResult): boolean {
    return Boolean(result.interrupted || this.coalesceAbortController?.signal.aborted);
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
 * The failed result for a run or attempt that threw instead of returning:
 * the record keeps the stack, the notice uses the message (#980).
 */
function thrownRunResult(err: unknown): RunResult {
  const selection = err instanceof ProviderSelectionError;
  const cause = selection ? err.cause : err;
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    success: false,
    // A PoolExhaustedError carries the operator-facing pool summary as its
    // message; pasting a stack here would bury it (#655).
    output:
      cause instanceof PoolExhaustedError
        ? cause.message
        : cause instanceof Error
          ? (cause.stack ?? cause.message)
          : String(cause),
    exitCode: 1,
    failure: { ...(selection ? { stage: "provider-selection" as const } : {}), message },
  };
}

/** Attribute an aborted signal's SIGTERM to the result it ended, in place. */
function attributeAbort(result: RunResult, signal: AbortSignal): void {
  if (!result.cancelled) {
    result.success = false;
    Object.assign(result, formatSigtermResult(result.output, signal));
  } else if (!result.abortReason) {
    result.abortReason = extractAbortReason(signal);
  }
}

/** A configured pool entry skipped during recovery without an attempt. */
export interface PoolSkippedEntry {
  entry: RawProviderModelConfig;
  reason: "halted" | "pacing" | "exhausted";
}

/** One configured pool entry's failed attempt within a recovering run. */
export interface FailedPoolAttempt {
  entry: RawProviderModelConfig;
  /** What the attempt returned; a `provider-selection` failure was never invoked. */
  result: RunResult;
}

/**
 * One attempt's factual line: its tuple, exit, and the same sanitized,
 * clipped diagnostic a failure notice carries (#980). `session` adds the
 * attempt's provider session as a work reference for a replacement; it stays
 * out of operator-facing reports.
 */
function formatFailedAttempt(
  index: number,
  { entry, result }: FailedPoolAttempt,
  budget: number,
  session: boolean
): string {
  const exit = [
    `exit ${result.exitCode}`,
    ...(result.abortReason ? [result.abortReason] : []),
    ...(session && result.sessionId ? [`session ${result.sessionId}`] : []),
  ].join(", ");
  const facts =
    result.failure?.stage === "provider-selection"
      ? "could not prepare this entry; provider was not invoked. "
      : result.failure?.kind === "provider-capacity"
        ? "provider reported a temporary capacity rejection. "
        : "";
  const diagnostic = failureDiagnostic(result, budget) || "(no diagnostic output)";
  return `- attempt ${index + 1} on ${describeModelConfigEntry(entry)} (${exit}): ${facts}${diagnostic}`;
}

/**
 * The account a replacement attempt reads ahead of the original prompt
 * (#1150): which run this is, which entries already failed and what each
 * reported, and that their side effects may already exist. Facts only — it
 * names no cause, because none was established.
 */
export function formatRecoveryContext(input: {
  runId: string;
  entry: RawProviderModelConfig;
  failures: readonly FailedPoolAttempt[];
}): string {
  return [
    `[run recovery] Run ${input.runId}: attempt ${input.failures.length + 1}, now on configured pool entry ${describeModelConfigEntry(input.entry)}. Earlier attempts of this same run failed:`,
    ...input.failures.map((failure, index) =>
      formatFailedAttempt(index, failure, FAILURE_DIAGNOSTIC_BUDGET, true)
    ),
    "",
    "The original task follows unchanged. An earlier attempt may already have changed files, branches, pull requests, messages or tracker state before it failed: check what actually happened before repeating any step, and continue from there. If the failure needs a person's judgment, report that the ordinary way.",
    "",
    "--- original task ---",
  ].join("\n");
}

/**
 * The terminal report when every configured pool entry was attempted and
 * failed, or was skipped as currently ineligible (halted, coordinator-reported
 * exhausted, or pacing). It accumulates each attempt's sanitized, clipped
 * diagnostic in attempt order and names no cause. Each diagnostic gets an
 * equal share of half the failure notice's budget, leaving the rest for the
 * attempt lines themselves; with an unusually long pool the notice's own clip
 * still keeps the first and last attempts.
 */
export function formatRecoveryChainFailure(input: {
  failures: readonly FailedPoolAttempt[];
  skipped: readonly PoolSkippedEntry[];
}): string {
  const total = input.failures.length + input.skipped.length;
  const budget = Math.floor(FAILURE_DIAGNOSTIC_BUDGET / (2 * input.failures.length));
  const lines = [
    `run recovery exhausted the configured model pool: ${input.failures.length} of ${total} configured pool ${total === 1 ? "entry" : "entries"} attempted and failed${input.skipped.length > 0 ? `; ${input.skipped.length} skipped as currently ineligible` : ""}.`,
    ...input.failures.map((failure, index) => formatFailedAttempt(index, failure, budget, false)),
  ];
  if (input.skipped.length > 0) {
    lines.push(
      `Skipped in order: ${input.skipped.map((s) => `${describeModelConfigEntry(s.entry)} (${s.reason})`).join(", ")}.`
    );
  }
  return lines.join("\n");
}

/**
 * The admission-time report when every configured pool entry is currently
 * ineligible (#655: every lane already reported exhausted or halted), so no
 * attempt was made. Only configured entry tuples are named.
 */
export function formatPoolExhaustedFailure(input: {
  /** Every configured entry, with the reason it is currently ineligible. */
  skipped: readonly PoolSkippedEntry[];
}): string {
  const total = input.skipped.length;
  return [
    total === 1
      ? "model pool exhausted: the configured pool entry is currently ineligible; none was attempted."
      : `model pool exhausted: all ${total} configured pool entries are currently ineligible; none was attempted.`,
    `Skipped in order: ${input.skipped.map((s) => `${describeModelConfigEntry(s.entry)} (${s.reason})`).join(", ")}.`,
    "The exhaustion and pacing states are provider-side conditions that clear on reset timers or operator unhalt; no configured entry has capacity right now. Wait for a quota reset, unhalt the provider, or configure an additional pool entry that has capacity so recovery has somewhere to go.",
  ].join("\n");
}
