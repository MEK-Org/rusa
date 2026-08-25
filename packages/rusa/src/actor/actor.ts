import type { ExhaustionClassifier } from "../providers/exhaustion-classifier.js";
import { teardownFlutterOverlay } from "../providers/sandbox.js";
import {
  createInterruptAbortReason,
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
import { RunStartCancelledError, type RunStartHandle } from "./concurrency-limiter.js";
import type { InjectRecord } from "./portable-context.js";
import {
  type ActorRunMode,
  isResponsiveNudge,
  type RunNudge,
  TriggerRunner,
} from "./trigger-runner.js";

export const WATCHDOG_STALL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
export const WATCHDOG_CEILING_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
export const DEFAULT_YIELD_GRACE_MS = 10 * 1000; // 10 seconds
const YIELD_ELICITATION_MAX = 1;

/**
 * What {@link ActorOptions.buildPrompt} returns: the assembled prompt, plus —
 * for portable-context actors (design ISSUE_NUM) — the inject record describing the
 * mesh-portable context folded into this run's prompt. The Actor forwards that
 * record to {@link ActorOptions.onRunStart}, where admission-time prompt state
 * belongs.
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
  /** The resolved coding provider this actor runs on. */
  provider: CodingProvider;
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
  /** Firehose: receives the agent's streamed output. */
  log?: (chunk: string) => void;
  /** Optional model fallback for provider capacity/quota exhaustion. */
  fallback?: {
    models: string[];
    resolveProvider: (model: string) => CodingProvider;
    classify: ExhaustionClassifier;
  };
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
    fn: () => Promise<T>,
    provider: string,
    responsive: boolean
  ) => Promise<T> | RunStartHandle<T>;
  /**
   * Optional pre-run check (e.g. budget/lease). Return `false` to skip this run
   * (the wake is dropped). Defaults to always-run.
   */
  beforeRun?: (context: { mode: ActorRunMode }) => boolean | Promise<boolean>;
  /**
   * General lifecycle notification after {@link beforeRun} passes and before the
   * provider/concurrency scheduler. No work content or prompt state crosses it.
   */
  onQueued?: (context: { responsive: boolean; mode: ActorRunMode }) => void;
  /**
   * Optional hook fired when a run is aborted due to a voice quick-start coalesce.
   */
  onCoalesceAborted?: (count: number, ageMs: number) => void;
  /**
   * Optional hook fired INSIDE {@link gate}, at the moment the provider invoke
   * actually begins — the same point the watchdog timers start , so a run
   * queued behind the concurrency cap never fires it.
   *
   * Paired with {@link onQueued} this separates a run that never started from
   * one that started and went quiet: no start = it was still queued behind
   * a start slot; started = the provider invoke was live, so silence
   * after this point belongs to the provider rather than the mesh.
   *
   * It deliberately stops short of saying *why* a started run went quiet —
   * telling "the provider never answered" apart from a genuine mid-run stall
   * needs a first-chunk timestamp, which {@link onFirstChunk} carries.
   */
  onRunStart?: (responsive: boolean, injectRecord?: InjectRecord) => void;
  /**
   * Optional hook fired ONCE per run, on the first chunk the provider emits —
   * the moment it starts answering, as distinct from the moment we asked .
   *
   * This is the third timestamp that makes a quiet run classifiable instead of
   * guessable. With {@link onQueued} and {@link onRunStart}: queued but never
   * started = it was waiting to start; started but no first chunk ever
   * = the provider never answered; first chunk then silence = a genuine mid-run
   * stall. Only the last of those is what "stall" means, and before this hook we
   * had no way to tell the three apart — every watchdog kill on record is the
   * middle case, which is a provider that hadn't answered yet.
   *
   * Fires on the FIRST chunk only, so its cost is one boolean per run rather
   * than per chunk. A run killed before the provider answers never fires it, and
   * that absence is the signal — do not synthesize one on the kill path.
   */
  onFirstChunk?: () => void;
  /** Optional post-run hook (completion review, budget accounting, firehose tap). */
  onRunEnd?: (result: RunResult) => void | Promise<void>;
  /**
   * The other terminal hook: the run opportunity ended WITHOUT reporting a
   * result, so {@link onRunEnd} never fired. `reason` says which path took it.
   *
   * Every {@link onQueued} is followed by exactly one of the two, because this
   * one fires from the same `finally` that clears `queued`/`executing` rather
   * than from each early-return site. That is the whole point of it: the two
   * paths that terminate without a result (a cancelled queued start and a
   * coalesce-abort) each returned early, and anything downstream that opened
   * state on `onQueued` and closed it on `onRunEnd` leaked once per occurrence
   * . A new early return inherits this hook by construction instead of
   * having to remember to fire it.
   *
   * An abandoned run carries no result: it produced no output, no exit code and
   * no outcome to judge, so this hook takes none. Handing it a synthesized
   * failure result would put a run that never ran into failure accounting.
   */
  onRunAbandoned?: (abandon: RunAbandon) => void;
}

/** What ended without a result, and which brackets it closes. */
export interface RunAbandon {
  reason: RunAbandonReason;
  /**
   * Whether {@link ActorOptions.onRunStart} already fired for this run.
   *
   * There are TWO nested brackets around a run and they do not close together.
   * The outer one — opened by {@link ActorOptions.onQueued} — is always closed by
   * a terminal hook. The inner one is opened by `onRunStart`, which fires INSIDE
   * the gate at the provider invoke, so a run cancelled while still queued behind
   * the concurrency cap never opens it at all.
   *
   * A reader that tracks started-but-unfinished runs therefore cannot treat every
   * abandonment as closing a start: counting a start-cancelled abandonment against
   * an unrelated live run reports the actor idle while it is mid-run. It also
   * cannot infer this from {@link reason}, because `unreported` is by definition
   * a path nobody has classified. So the actor — which is the only party that
   * knows — states it.
   */
  started: boolean;
}

/**
 * Why a run opportunity ended without a result.
 *
 * `unreported` is the catch-all, and it is deliberately reachable: it is what a
 * terminal path nobody has classified yet reports. Accounting stays correct
 * whatever produced it, and the unfamiliar reason in the event log is the signal
 * to come back and name it.
 */
export type RunAbandonReason = "start-cancelled" | "coalesced" | "unreported";

/**
 * Compose the failure report for a fallback that ran but failed for a reason
 * that is *not* exhaustion .
 *
 * The primary's exhaustion is the load-bearing fact — it is why recovery was
 * attempted at all, and it is the condition that actually resolves on a timer.
 * The fallback's failure only explains why recovery didn't happen. Reporting the
 * latter alone converts a self-healing wait into an error naming a model nobody
 * configured, which is what made ISSUE_NUM cost two separate diagnoses.
 *
 * The primary's exhaustion is carried as a *named condition*, never as its raw
 * output: ISSUE_NUM deliberately scrubs raw provider output out of synthesized
 * failures because a provider echoes the prompt, and the prompt carries secrets.
 * The fallback's raw output is kept because this path already returned it
 * verbatim before this function existed; withholding it would lose the config
 * diagnostics (`invalid --model ...`) that make a wiring bug findable.
 */
export function formatFallbackRecoveryFailure(input: {
  primaryName: string;
  fallbackModel: string;
  fallbackOutput: string;
}): string {
  return [
    `primary ${input.primaryName} exhausted; recovery onto fallback ${input.fallbackModel} failed for an unrelated reason.`,
    "",
    `The exhaustion of ${input.primaryName} is what caused this run to fail, and it clears on a timer. The fallback error below explains only why recovery was unavailable — it is context, not the cause.`,
    "",
    `--- fallback ${input.fallbackModel} (recovery failed) ---`,
    input.fallbackOutput,
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
  private yieldGraceTimer?: NodeJS.Timeout;
  private readonly yieldGraceMs: number;
  private currentRunStartTime: Date | null = null;
  private interruptedWatermark: Date | null = null;

  constructor(private readonly opts: ActorOptions) {
    this.id = opts.id;
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
    if (this.queued) return;
    this.runner.requestRun(nudge);
  }

  /**
   * The actor signalled it has nothing more to do *right now* — its current
   * objective is complete, or it's blocked waiting on someone else. Called via
   * the mesh when the actor invokes its yield tool. Starts the supervisor grace
   * period timer to forcefully kill the process if it does not exit promptly.
   * Stops the corrective run path; the actor next runs on a real external trigger.
   */
  declareYield(status?: string): void {
    this.yielded = true;
    this.yieldStatus = status ?? "complete";
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
    // The wake was gated off (lease/budget) — treat it as a dropped trigger, not
    // a run that fell short, so we don't spin re-checking the same closed gate.
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

  /** Cancel a provider start that is still queued, retaining one dirty flag. */
  cancelQueuedRun(): boolean {
    if (!this.pendingStart?.cancel?.()) return false;
    this.cancelledQueuedRun = true;
    return true;
  }

  /** Replay the content-free dirty state retained by {@link cancelQueuedRun}. */
  resumeCancelledRun(): boolean {
    if (!this.cancelledQueuedRun) return false;
    this.cancelledQueuedRun = false;
    this.requestRun();
    return true;
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

  /** Update the active coding provider in-place for subsequent runs . */
  setProvider(provider: CodingProvider): void {
    this.opts.provider = provider;
  }

  close(): void {
    this.closed = true;
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

  private async runOnce(nudge: RunNudge): Promise<void> {
    if (this.closed) {
      this.lastRunSkipped = true;
      return;
    }
    if (this.opts.beforeRun && !(await this.opts.beforeRun({ mode: nudge.mode ?? "ordinary" }))) {
      this.lastRunSkipped = true;
      return;
    }
    this.lastRunSkipped = false;
    // A yield only counts for the run it was declared in; clear any prior flag.
    this.yielded = false;
    this.yieldStatus = undefined;
    this.runEndReported = false;
    this.runStartReported = false;
    this.currentRunStartTime = new Date();
    // The run is queued until invoke() is selected by both gates.
    this.queued = true;
    try {
      try {
        this.opts.onQueued?.({
          responsive: isResponsiveNudge(nudge),
          mode: nudge.mode ?? "ordinary",
        });
      } catch (err) {
        this.opts.log?.(`onQueued failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
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
      // Close the opportunity this `finally` just opened flags for. It lives here,
      // beside the flag clears, for the same reason they do: `executeTurn` has
      // terminal paths that return early, and a signal emitted at each of them is
      // one a new path can silently omit. Anything that opens state on onQueued
      // and closes it on onRunEnd — the mesh's in-flight run accounting, ISSUE_NUM —
      // depends on the pairing being total, not on the current list of exits.
      if (!this.runEndReported) this.reportAbandonedRun();
    }
  }

  /** The terminal hook for a run that ended without reporting a result. */
  private reportAbandonedRun(): void {
    // `coalesceAborted` and `lastRunSkipped` are still set from the path that
    // took us here. Neither is required to be: an unclassified terminal path
    // still reports, as `unreported`, because the accounting must not depend on
    // recognizing why.
    const reason: RunAbandonReason = this.coalesceAborted
      ? "coalesced"
      : this.lastRunSkipped
        ? "start-cancelled"
        : "unreported";
    try {
      this.opts.onRunAbandoned?.({ reason, started: this.runStartReported });
    } catch (err) {
      // Swallowing here matches onQueued: an observability sink must not be able
      // to break the run loop from inside a `finally`.
      this.opts.log?.(
        `onRunAbandoned failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  /** The genuine-execution body of a run (everything after the beforeRun gate). */
  private async executeTurn(nudge: RunNudge): Promise<void> {
    const isCorrectiveRun = nudge.mode === "yield-elicitation";
    const responsive = isResponsiveNudge(nudge);
    const sessionId = this.opts.loadSessionId();
    // The provider treats the actor's cwd as its private directory and shadows
    // everything beside it (see buildActorBwrapArgs). This object is just the
    // opt-in signal.
    const sandbox: SandboxOptions | undefined = this.opts.sandbox
      ? {
          worktreePath: this.opts.cwd,
          isE2eRoot: this.opts.isE2eRoot,
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
    const runProvider = (provider: CodingProvider): Promise<RunResult> =>
      provider.run({
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
          // Once per RUN, not per provider attempt: `runWithFallback` can call
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
    const invoke = (): Promise<RunResult> => {
      // Both queues have selected this run. From this point a later responsive
      // wake obeys per-actor serialization; v1 never cancels a live provider.
      this.pendingStart = undefined;
      this.queued = false;
      if (this.closed) {
        throw new RunStartCancelledError();
      }
      this.executing = true;
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
      // Inside the gate: the provider is starting. The hook fires here rather than
      // beside onQueued so a run queued behind the concurrency cap is
      // distinguishable from one that started and went quiet — same reason the
      // watchdog timers moved in here .
      this.opts.onRunStart?.(responsive, built.injectRecord);
      // AFTER the hook, not before: this flag means "a start was announced", so a
      // hook that threw before announcing must not leave a bracket a reader will
      // wait forever to see closed. (The mirror of `runEndReported`, which is set
      // BEFORE its hook for the opposite reason — there the risk is reporting the
      // same run's outcome twice, here it is claiming a start nobody saw.)
      this.runStartReported = true;
      startWatchdogTimers();
      return this.runWithFallback(runProvider);
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
        const gated = this.opts.gate(invoke, this.opts.provider.providerName, responsive);
        const start: RunStartHandle<RunResult> =
          gated instanceof Promise
            ? { result: gated, started: false, promote: () => {}, cancel: () => false }
            : gated;
        this.pendingStart = start;
        result = await start.result;
      } else {
        result = await invoke();
      }
    } catch (err) {
      if (err instanceof RunStartCancelledError) {
        this.lastRunSkipped = true;
        return;
      }
      if (this.coalesceAborted) return;
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

    if (result.sessionId && result.sessionId !== sessionId) {
      this.opts.saveSessionId(result.sessionId);
    }

    const wasGraceKilled =
      (abortController.signal.aborted &&
        abortController.signal.reason === YIELD_GRACE_ABORT_REASON) ||
      result.graceKilled === true;

    if (this.yielded) {
      result.yieldStatus = this.yieldStatus ?? "complete";
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
    await this.opts.onRunEnd?.(result);
  }

  private async runWithFallback(
    runProvider: (provider: CodingProvider) => Promise<RunResult>
  ): Promise<RunResult> {
    const primary = this.opts.provider;
    const result = await runProvider(primary);
    const fallback = this.opts.fallback;
    if (result.success || !fallback || fallback.models.length === 0) return result;

    if (!(await fallback.classify(result)).exhausted) return result;

    const primaryName = primary.model ?? primary.name;
    for (const model of fallback.models) {
      const provider = fallback.resolveProvider(model);
      this.opts.log?.(
        `\n[Fallback] primary ${primaryName} exhausted; continuing on fallback ${model}\n`
      );
      const fallbackResult = await runProvider(provider);
      if (fallbackResult.success) return fallbackResult;
      if (!(await fallback.classify(fallbackResult)).exhausted) {
        // We only reach here because the primary was classified exhausted, so
        // returning the fallback's error bare would report a soft, timer-bound
        // condition as an unrelated hard failure . Keep the fallback's
        // exitCode/sessionId — the fallback attempt is the live session — but
        // lead the output with the exhaustion that actually caused this run.
        return {
          ...fallbackResult,
          output: formatFallbackRecoveryFailure({
            primaryName,
            fallbackModel: model,
            fallbackOutput: fallbackResult.output,
          }),
        };
      }
    }

    return {
      success: false,
      output: `both tiers exhausted: primary ${primaryName} and fallback ${fallback.models.join(", ")} have no capacity available`,
      exitCode: result.exitCode || 1,
      sessionId: result.sessionId,
    };
  }
}
