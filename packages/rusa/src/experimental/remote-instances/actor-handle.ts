import { randomUUID } from "node:crypto";
import type { ActorOptions } from "../../actor/actor.js";
import type { ActorLifecycleAbandonmentReason } from "../../actor/actor-lifecycle.js";
import type { ActorFactoryContext, ActorRuntimeState, MeshActor } from "../../actor/actor-mesh.js";
import type { RunStartHandle } from "../../actor/concurrency-limiter.js";
import type { ActorRunMode, RunNudge } from "../../actor/trigger-runner.js";
import { type Logger, nullLogger } from "../../observability/logger.js";
import type { ProviderModelConfig, RawProviderModelConfig } from "../../providers/model-config.js";
import type { RunResult } from "../../providers/types.js";
import type { ActorChannel } from "./actor-channel.js";
import {
  type ActorEvent,
  type Bootstrap,
  COORDINATOR_MODEL_CONFIG_CHANGED_ERROR,
  COORDINATOR_RECONNECTED_WITHOUT_ADMISSION_ERROR,
  type LeaderCommand,
  type RunSnapshot,
} from "./protocol.js";

export interface ActorHandleOptions {
  host: ActorChannel;
  bootstrap: Bootstrap;
  context: ActorFactoryContext;
  // Read only after central scheduler admission, so queued runs get fresh work.
  snapshot: () => RunSnapshot;
  saveSession: (sessionId: string) => void;
  onEvent?: (event: ActorEvent) => void;
  /**
   * Connection/startup failure notice. Purely informational — terminal run
   * accounting is the handle's own job, so a listener here must not synthesize
   * a run end of its own.
   */
  onFailure: (error: Error) => void;
  actorOptions?: ActorOptions;
  target?: string;
  logger?: Logger;
  startupTimeoutMs?: number;
  stateStaleTimeoutMs?: number;
}

/** MeshActor compatibility handle; connection/lifetime belongs to RemoteInstance. */
export class ActorHandle implements MeshActor {
  readonly id: string;
  channel: ActorChannel;
  ready!: Promise<number>;
  exited!: Promise<void>;
  private readonly log: Logger;
  private runStartTime?: number;
  private state: ActorRuntimeState = "idle";
  private yielded = false;
  private closed = false;
  private terminated = false;
  private gates = new Map<
    number,
    {
      handle: RunStartHandle<void>;
      release: () => void;
      /** Priority the leader actually admitted, which a promotion can raise after the request. */
      admission: { responsive: boolean };
      /** Pool revision quoted when this reservation entered the leader gate. */
      modelConfigGeneration: number;
      /** The pool changed after this reservation quoted; retry it under the new pool. */
      modelConfigStale: boolean;
    }
  >();
  private startupTimer?: ReturnType<typeof setTimeout>;
  private stateStaleTimer?: ReturnType<typeof setTimeout>;
  /** True between the leader admitting a run and that same run's terminal accounting. */
  private runOpen = false;
  /** Identity minted by the leader-side execution coordinator before admission. */
  private queuedRunId: string | undefined;
  private startedRunId: string | undefined;
  private queuedMode: ActorRunMode | undefined;
  private receiveChain: Promise<void> | undefined;
  /** Responsive displacement asked for while the follower's state was unknown. */
  private pendingPreempt = false;
  /** True from reattach until the follower reports which run, if any, survived the gap. */
  private stateStale = false;
  /**
   * The stale-state deadline released held wakes before any report arrived.
   * The leader's booked state still says nothing about the follower, so the
   * first report that does arrive keeps its reattach meaning.
   */
  private stateUnconfirmed = false;
  /**
   * Resolves with that first report. The mesh preempts before it nudges, and a
   * wake that overtook the deferred preempt would have its dirty bit cancelled
   * by it, so wakes wait here until the preempt decision has been sent.
   */
  private stateSettled: Promise<void> = Promise.resolve();
  private settleState: (() => void) | undefined;
  /** Promotion requested between the follower's queued report and its admission request. */
  private pendingQueuedPromotion = false;
  /** Incremented for each next-run pool replacement so stale gates can re-quote. */
  private modelConfigGeneration = 0;
  private preemptSequence = 0;
  /** The one unanswered preempt; later responsive items coalesce behind its answer. */
  private outstandingPreempt: number | undefined;
  /**
   * One admission the leader reserved and the follower never started, kept
   * across a transport loss. The ticket is this run's place in provider pacing
   * and concurrency; a replacement admission re-enters both at the tail.
   */
  private retainedAdmission: { requestId: number; runId: string } | undefined;

  constructor(private readonly opts: ActorHandleOptions) {
    this.id = opts.bootstrap.id;
    this.channel = opts.host;
    this.log = (opts.logger ?? nullLogger).child({
      component: "remote-instance",
      actorId: this.id,
      target: opts.target ?? opts.host.nodeId,
    });
    this.bindChannel(opts.host);
    this.send({ type: "init", bootstrap: opts.bootstrap });
  }

  private bindChannel(channel: ActorChannel, awaitStartup = true): void {
    let resolveReady!: (pid: number) => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Factories are synchronous; boot failure can arrive before the caller awaits ready.
    void this.ready.catch(() => {});
    clearTimeout(this.startupTimer);
    if (awaitStartup) {
      const startupTimeout = this.opts.startupTimeoutMs ?? 10_000;
      this.startupTimer = setTimeout(() => {
        const error = new Error("Remote actor startup timed out");
        rejectReady(error);
        this.fail(error);
      }, startupTimeout);
    }
    channel.on("message", (raw) => {
      const message = raw as ActorEvent;
      if (message.type === "ready") {
        clearTimeout(this.startupTimer);
        resolveReady(message.pid);
        return;
      }
      this.enqueueReceive(message);
    });
    channel.on("error", (error) => {
      rejectReady(error);
      this.fail(error);
    });
    this.exited = new Promise((resolve) =>
      channel.once("exit", (code, signal) => {
        clearTimeout(this.startupTimer);
        const error = new Error(`Remote actor exited (${signal ?? code})`);
        rejectReady(error);
        this.settleState?.();
        if (!this.closed) this.fail(error);
        this.releaseGates();
        this.state = "idle";
        this.opts.context.onRuntimeStateChanged("idle");
        resolve();
      })
    );
  }

  attachHost(newChannel: ActorChannel): void {
    if (this.terminated) {
      this.log.warn("remote_attach_after_close", {
        actorId: this.id,
        target: this.opts.target ?? newChannel.nodeId,
      });
      return;
    }
    this.channel.removeAllListeners();
    this.channel = newChannel;
    this.closed = false;
    // The follower kept its Actor across the gap; its first state report says
    // whether a run admitted before the loss is still in flight.
    this.stateStale = true;
    this.stateUnconfirmed = false;
    this.settleState?.();
    this.stateSettled = new Promise((resolve) => {
      this.settleState = resolve;
    });
    clearTimeout(this.stateStaleTimer);
    const staleTimeout = this.opts.stateStaleTimeoutMs ?? 10_000;
    this.stateStaleTimer = setTimeout(() => {
      if (!this.stateStale || this.closed) return;
      this.log.warn("remote_state_stale_timeout", {
        actorId: this.id,
        target: this.opts.target ?? this.channel.nodeId,
      });
      // Only wake delivery waits on this deadline. A missing report is not
      // proof the follower gave up a retained ticket: its resume claim, its
      // first report, or a fresh admission still decides that (#602/#604).
      this.stateStale = false;
      this.stateUnconfirmed = true;
      if (this.pendingPreempt) {
        this.pendingPreempt = false;
        this.applyPreempt();
      }
      this.settleState?.();
    }, staleTimeout);
    // A reconnect is transport recovery, not a fresh actor boot. Its delayed
    // state/ready report must not cancel a leader-retained admission after 10s.
    this.bindChannel(newChannel, false);
    const freshSnapshot = this.opts.snapshot();
    const sessionId = freshSnapshot.record.sessionId ?? this.opts.bootstrap.sessionId;
    if (this.retainedAdmission) {
      this.log.info("remote_admission_retained", {
        actorId: this.id,
        target: this.opts.target ?? newChannel.nodeId,
        requestId: this.retainedAdmission.requestId,
      });
    }
    this.send({
      type: "init",
      bootstrap: {
        ...this.opts.bootstrap,
        ...(sessionId ? { sessionId } : {}),
        modelConfig: freshSnapshot.record.modelConfig ?? this.opts.bootstrap.modelConfig,
        mcpServers: freshSnapshot.mcpServers,
        reconnect: true,
        // Invite the follower to re-announce the admission this handle kept.
        ...(this.retainedAdmission ? { resumeAdmission: true } : {}),
      },
    });
  }

  get isRunning(): boolean {
    return this.state === "running" || this.state === "winding_down";
  }
  get isQueued(): boolean {
    return this.state === "queued";
  }
  get isYielded(): boolean {
    return this.yielded;
  }

  requestRun(nudge?: RunNudge): void {
    void this.ready
      .then(() => this.stateSettled)
      .then(() => {
        if (this.closed || !this.send({ type: "wake", nudge })) this.reportDroppedWake(nudge);
      })
      .catch(() => this.reportDroppedWake(nudge));
  }
  declareYield(status?: string, note?: string): void {
    // Fence parent-hosted tools immediately when the mesh accepts yield_run.
    this.yielded = true;
    this.send({ type: "yield", status, note });
  }
  markUnkillable(): void {
    this.send({ type: "unkillable" });
  }
  /**
   * A follower confirms effective preemption asynchronously. Returning false
   * here keeps ActorMesh from writing `run_preempted` before that confirmation.
   * Queued admissions are a leader-owned resource, so they can be promoted
   * directly without asking the follower to guess at a promise-backed gate.
   */
  preemptForResponsive(): { preempted: false } {
    if (this.closed || !this.channel.connected || this.stateStale) {
      // A run admitted before a transport loss may still be executing on the
      // follower (#381). Decide against the state it reports after reattaching
      // rather than against the idle the leader booked at disconnect.
      this.pendingPreempt = true;
      this.log.info("remote_preempt_deferred", {
        actorId: this.id,
        target: this.opts.target ?? this.channel.nodeId,
      });
      return { preempted: false };
    }
    this.applyPreempt();
    return { preempted: false };
  }

  setModelConfig(modelConfig: ProviderModelConfig[]): void {
    if (JSON.stringify(this.opts.bootstrap.modelConfig) === JSON.stringify(modelConfig)) return;
    this.opts.bootstrap.modelConfig = [...modelConfig];
    this.modelConfigGeneration++;
    this.send({ type: "modelConfig", modelConfig: [...modelConfig] });
    // Keep remote placement at the same queued-start boundary as a local Actor:
    // update the follower's pool first, then make each stale reservation retry
    // the same opportunity through its current provider candidates. A retained
    // reservation stays untouched until attachHost can perform that re-quote.
    if (this.closed || !this.channel.connected) return;
    for (const gate of this.gates.values()) {
      if (gate.handle.started || gate.modelConfigGeneration === this.modelConfigGeneration)
        continue;
      gate.modelConfigStale = true;
      gate.handle.cancel?.();
    }
  }

  close(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.closed = true;
    clearTimeout(this.startupTimer);
    clearTimeout(this.stateStaleTimer);
    this.stateStaleTimer = undefined;
    this.pendingPreempt = false;
    this.pendingQueuedPromotion = false;
    this.outstandingPreempt = undefined;
    void this.cancelRetainedAdmission();
    // Keep running slots occupied until the remote actor releases them or exits.
    for (const gate of this.gates.values()) gate.handle.cancel?.();
    this.send({ type: "stop" });
  }

  /** A transport loss is recoverable: keep only what attachHost can still act on. */
  private disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.startupTimer);
    clearTimeout(this.stateStaleTimer);
    this.stateStaleTimer = undefined;
    // An unanswered preempt is re-decided against the follower's reattach state.
    this.pendingPreempt ||= this.outstandingPreempt !== undefined;
    this.outstandingPreempt = undefined;
    // Keep running slots occupied until the remote actor releases them or exits.
    for (const [requestId, gate] of this.gates) {
      // A ticket the follower never started still holds this run's place in
      // pacing and concurrency, and a transport loss is not a run outcome. Keep
      // it for the reattach handshake to claim instead of making the run queue
      // again as fresh work (#602).
      if (!gate.handle.started && this.queuedRunId) {
        if (!this.retainedAdmission) {
          this.retainedAdmission = { requestId, runId: this.queuedRunId };
          continue;
        }
        this.log.warn("remote_admission_multiple_unstarted", {
          actorId: this.id,
          retainedRequestId: this.retainedAdmission.requestId,
          droppedRequestId: requestId,
        });
      }
      gate.handle.cancel?.();
    }
    // A promotion asked for before the admission request arrived has nothing
    // left to apply to once that request is gone; a retained ticket keeps it
    // live, and the deferred preempt re-promotes it after reattach.
    if (!this.retainedAdmission) this.pendingQueuedPromotion = false;
  }

  private releaseGates(): void {
    for (const [requestId, gate] of this.gates) {
      // A retained admission outlives the transport that carried it: only a
      // claim, a fresh admission, or the leader giving up resolves it.
      if (requestId === this.retainedAdmission?.requestId) continue;
      gate.handle.cancel?.();
      gate.release();
      this.gates.delete(requestId);
    }
  }

  /** The follower reclaimed its ticket; the retained gate still owes the reply. */
  private claimRetainedAdmission(requestId: number): boolean {
    if (this.retainedAdmission?.requestId !== requestId) return false;
    const gate = this.gates.get(requestId);
    if (!gate) return false;
    if (gate.modelConfigGeneration !== this.modelConfigGeneration) {
      // The follower has the replacement pool from attachHost's init, while
      // this ticket was quoted under the old one. Reject it as stale so the
      // follower's Actor retries the same queued opportunity under that pool.
      this.retainedAdmission = undefined;
      gate.modelConfigStale = true;
      gate.handle.cancel?.();
      return true;
    }
    this.retainedAdmission = undefined;
    this.log.info("remote_admission_resumed", {
      actorId: this.id,
      target: this.opts.target ?? this.channel.nodeId,
      requestId,
    });
    return true;
  }

  /**
   * Give up a retained admission. The run it was holding never started, so the
   * leader books it here: the follower that would have reported that run's
   * outcome is either gone or has already moved on to other work.
   */
  private cancelRetainedAdmission(): void | Promise<void> {
    const retained = this.retainedAdmission;
    if (!retained) return;
    this.retainedAdmission = undefined;
    const gate = this.gates.get(retained.requestId);
    if (gate) {
      this.gates.delete(retained.requestId);
      gate.handle.cancel?.();
      gate.release();
    }
    this.log.info("remote_admission_dropped", {
      actorId: this.id,
      target: this.opts.target ?? this.channel.nodeId,
      requestId: retained.requestId,
    });
    // Only the run the ticket was reserved for; a later run owns its own end.
    // Under standard follower runtime initialize(), the first post-reattach state
    // report is sent synchronously and drops an unclaimed ticket while queuedRunId
    // still equals retained.runId. The direct onEnd emit below defensively handles
    // out-of-order protocol arrivals (e.g. an unannounced queued run or out-of-band
    // fresh admission) where queuedRunId advanced before this cancellation ran.
    if (this.queuedRunId === retained.runId) {
      return this.endQueuedRun("start-cancelled", false);
    }
    return this.opts.context.lifecycle.emit("onEnd", {
      actorId: this.id,
      runId: retained.runId,
      terminal: { kind: "abandoned", reason: "start-cancelled", started: false },
    });
  }

  private enqueueReceive(message: ActorEvent): void {
    const run = () => {
      try {
        const res = this.receive(message);
        if (res && typeof (res as Promise<void>).then === "function") {
          return (res as Promise<void>).catch((error) => this.fail(error));
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    if (!this.receiveChain) {
      const res = run();
      if (res) {
        this.receiveChain = res.finally(() => {
          if (this.receiveChain === res) {
            this.receiveChain = undefined;
          }
        });
      }
    } else {
      this.receiveChain = this.receiveChain.then(run);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    // Termination stays strictly reserved for a genuine actor close() (e.g. thread retirement).
    // A connection error, startup timeout, or transport loss disconnects the handle so attachHost
    // can still recover and rebind on reconnect.
    this.disconnect();
    // A retained admission still owns its run: the claim that resumes it, or the
    // cancellation that drops it, decides that run's outcome instead.
    const retained = this.retainedAdmission !== undefined;
    this.opts.onFailure(error);
    // A connection or startup failure is not itself a run outcome. Only a run
    // the leader actually admitted is terminated here, so an idle disconnect or
    // a boot timeout books nothing.
    const terminate = () => {
      if (this.runOpen) {
        void this.endRun({ success: false, output: error.message, exitCode: -1 });
      } else if (this.queuedRunId && !retained) {
        void this.endQueuedRun("start-cancelled", false);
      }
    };
    if (this.receiveChain) {
      this.receiveChain = this.receiveChain.then(terminate).catch(() => {});
    } else {
      terminate();
    }
  }

  /**
   * Close out the admitted run exactly once.
   *
   * Leader accounting opens a durable run on `runStart` and closes it against
   * that run id; closing one that was never opened throws, and closing one twice
   * double-counts. Failures arrive on their own schedule — before admission,
   * while idle, or racing a completion already in flight — so the open-run flag,
   * not the trigger, decides whether anything ends. The flag is cleared before
   * awaiting so a disconnect landing mid-completion finds nothing left to end.
   */
  private endRun(result: RunResult): void | Promise<void> {
    const runId = this.startedRunId;
    if (!this.runOpen || !runId) return;
    this.runOpen = false;
    this.startedRunId = undefined;
    this.queuedRunId = undefined;
    const elapsedMs =
      this.runStartTime !== undefined
        ? Math.round(performance.now() - this.runStartTime)
        : undefined;
    this.runStartTime = undefined;
    this.log.info("remote_run_end", {
      actorId: this.id,
      target: this.opts.target ?? this.channel.nodeId,
      success: result.success,
      exitCode: result.exitCode,
      elapsedMs,
    });
    return this.opts.context.lifecycle.emit("onEnd", {
      actorId: this.id,
      runId,
      terminal: { kind: "result", result },
    });
  }

  private endQueuedRun(
    reason: ActorLifecycleAbandonmentReason,
    started: boolean
  ): void | Promise<void> {
    const runId = started ? this.startedRunId : this.queuedRunId;
    if (!runId) return;
    this.runOpen = false;
    this.startedRunId = undefined;
    this.queuedRunId = undefined;
    return this.opts.context.lifecycle.emit("onEnd", {
      actorId: this.id,
      runId,
      terminal: { kind: "abandoned", reason, started },
    });
  }

  /**
   * The wake itself is not durable state: the inbox entry behind it is, and
   * the follower's re-register re-derives its priority from there.
   */
  private reportDroppedWake(nudge?: RunNudge): void {
    this.log.warn("remote_wake_dropped", {
      actorId: this.id,
      target: this.opts.target ?? this.channel.nodeId,
      priority: nudge?.priority ?? "normal",
    });
  }

  /** Displace whatever the follower's latest state report says is in the way. */
  private applyPreempt(): void {
    if (this.stateUnconfirmed) {
      // Nothing reported since reattach: promote a ticket the leader holds, or
      // let the follower's own Actor decide whether a run is in the way.
      if (!this.promoteQueuedAdmissions()) this.sendPreempt();
    } else if (this.isQueued) {
      if (!this.promoteQueuedAdmissions()) this.pendingQueuedPromotion = true;
    } else if (this.isRunning) {
      this.sendPreempt();
    }
  }

  /** Promote the leader's real admission handle, not the follower's async gate wrapper. */
  private promoteQueuedAdmissions(): boolean {
    let promoted = false;
    for (const gate of this.gates.values()) {
      if (gate.handle.started) continue;
      gate.admission.responsive = true;
      gate.handle.promote();
      promoted = true;
    }
    if (promoted) this.logAdmissionPromoted();
    return promoted;
  }

  private logAdmissionPromoted(): void {
    this.log.info("remote_admission_promoted", {
      actorId: this.id,
      target: this.opts.target ?? this.channel.nodeId,
    });
  }

  /** Ask once; the follower's answer to the open request covers every item behind it. */
  private sendPreempt(): void {
    if (this.outstandingPreempt !== undefined) return;
    const requestId = ++this.preemptSequence;
    if (!this.send({ type: "preempt", requestId })) {
      this.pendingPreempt = true;
      return;
    }
    this.outstandingPreempt = requestId;
    this.log.info("remote_preempt_requested", {
      actorId: this.id,
      target: this.opts.target ?? this.channel.nodeId,
      requestId,
      phase: this.state,
    });
  }

  private send(message: LeaderCommand): boolean {
    if (!this.channel.connected) return false;
    return this.channel.send(message, (error) => {
      if (error) this.fail(error);
    });
  }

  private receive(message: ActorEvent): void | Promise<void> {
    const ctx = this.opts.context;
    const hooks = this.opts.actorOptions;
    this.opts.onEvent?.(message);
    switch (message.type) {
      case "fatal":
        this.fail(new Error(message.error));
        break;
      case "state": {
        clearTimeout(this.stateStaleTimer);
        this.stateStaleTimer = undefined;
        const reattachReport = this.stateStale || this.stateUnconfirmed;
        this.state = message.state;
        this.yielded = message.yielded;
        this.stateStale = false;
        this.stateUnconfirmed = false;
        if (message.state !== "queued") this.pendingQueuedPromotion = false;
        if (this.pendingPreempt) {
          this.pendingPreempt = false;
          this.applyPreempt();
        }
        // Any wake held since reattach is now ordered behind the preempt decision.
        this.settleState?.();
        ctx.onRuntimeStateChanged(message.state);
        // The first report after a reattach is the deadline for claiming a
        // retained ticket: whatever the follower holds now, it is not the run
        // that ticket was reserved for.
        if (reattachReport) return this.cancelRetainedAdmission();
        break;
      }
      case "preempted":
        // Only the open request is answerable; an answer from before a reattach
        // describes a request this generation already re-decided.
        if (message.requestId !== this.outstandingPreempt) break;
        this.outstandingPreempt = undefined;
        if (message.preempted && message.phase) {
          ctx.mesh.recordEvent({
            kind: "run_preempted",
            actorId: this.id,
            detail: message.phase,
            payload: JSON.stringify({ reason: "responsive_notification" }),
          });
          this.log.info("remote_preempt_effective", {
            actorId: this.id,
            target: this.opts.target ?? this.channel.nodeId,
            requestId: message.requestId,
            phase: message.phase,
          });
        } else {
          this.log.info("remote_preempt_not_effective", {
            actorId: this.id,
            target: this.opts.target ?? this.channel.nodeId,
            requestId: message.requestId,
          });
        }
        break;
      case "session":
        this.opts.saveSession(message.sessionId);
        break;
      case "queued":
        this.queuedRunId = message.runId ?? randomUUID();
        this.queuedMode = message.mode;
        return ctx.lifecycle.emit("onQueued", {
          actorId: this.id,
          runId: this.queuedRunId,
          responsive: message.responsive,
          mode: message.mode,
        });
      case "result":
        return this.endRun(message.result);
      case "error": {
        const runId = this.startedRunId ?? this.queuedRunId;
        if (runId) {
          return ctx.lifecycle.emit("onError", {
            actorId: this.id,
            runId,
            error: new Error(message.error),
          });
        }
        break;
      }
      case "runStart":
        // Mark open only once the leader's own run-start accounting has taken:
        // a throw here leaves no run to close.
        this.runStartTime = performance.now();
        this.queuedRunId = message.runId ?? this.queuedRunId ?? randomUUID();
        this.startedRunId = this.queuedRunId;
        // Mark the terminal claim before awaiting observers. The first
        // lifecycle listener starts synchronously, so accounting is open; a
        // follower disconnect in an observer's await gap must still close it.
        this.runOpen = true;
        this.log.info("remote_run_start", {
          actorId: this.id,
          target: this.opts.target ?? this.channel.nodeId,
          responsive: message.responsive,
          selected: message.selected,
        });
        return ctx.lifecycle.emit("onStart", {
          actorId: this.id,
          runId: this.startedRunId,
          responsive: message.responsive,
          mode: this.queuedMode ?? "ordinary",
          injectRecord: message.injectRecord,
          selected: message.selected,
        });
      case "firstChunk":
        hooks?.onFirstChunk?.();
        break;
      case "abandoned":
        // An abandoned run is already terminal on the leader side; it has no
        // run end left to record.
        return this.endQueuedRun(message.abandon.reason, message.abandon.started);
      case "continue":
        hooks?.onContinue?.(message.count);
        break;
      case "capped":
        hooks?.onContinuationCapped?.(message.count);
        break;
      case "coalesced":
        hooks?.onCoalesceAborted?.(message.count, message.ageMs);
        break;
      case "log":
        hooks?.log?.(message.chunk);
        break;
      case "release":
        this.gates.get(message.requestId)?.release();
        this.gates.delete(message.requestId);
        break;
      case "request": {
        const { requestId, request } = message;
        try {
          if (this.closed) throw new Error("Actor is closed");
          switch (request.op) {
            case "beforeRun": {
              const beforeRunResult = hooks?.beforeRun?.(request) ?? ctx.beforeRun(request);
              if (
                beforeRunResult &&
                typeof (beforeRunResult as Promise<boolean>).then === "function"
              ) {
                return (beforeRunResult as Promise<boolean>).then((allowed) => {
                  this.send({
                    type: "reply",
                    requestId,
                    value: {
                      allowed,
                      sessionId: hooks?.loadSessionId() ?? ctx.getRecord()?.sessionId,
                    },
                  });
                });
              }
              this.send({
                type: "reply",
                requestId,
                value: {
                  allowed: beforeRunResult,
                  sessionId: hooks?.loadSessionId() ?? ctx.getRecord()?.sessionId,
                },
              });
              break;
            }
            case "prepareMount":
              return (async () => {
                this.send({
                  type: "reply",
                  requestId,
                  value: await hooks?.prepareUnderstandingMount?.(),
                });
              })();
            case "complete": {
              this.opts.onEvent?.({ type: "result", result: request.result });
              const endResult = this.endRun(request.result);
              if (endResult && typeof (endResult as Promise<void>).then === "function") {
                return (endResult as Promise<void>).then(() => {
                  this.send({ type: "reply", requestId });
                });
              }
              this.send({ type: "reply", requestId });
              break;
            }
            case "sendMessage":
              // Bind sender identity here; the remote actor cannot choose a different actor.
              this.send({
                type: "reply",
                requestId,
                value: ctx.mesh.sendMessage(request.to, request.body, this.id),
              });
              break;
            case "admit": {
              if (request.resume) {
                // A follower re-announcing its pending admission is claiming the
                // ticket this handle kept for it. The reply still comes from the
                // retained gate, when pacing and concurrency release it.
                if (!this.claimRetainedAdmission(requestId)) {
                  // Nothing left to claim: that run was already booked as
                  // abandoned here, so the follower must not run under its id.
                  this.send({
                    type: "reply",
                    requestId,
                    error: COORDINATOR_RECONNECTED_WITHOUT_ADMISSION_ERROR,
                  });
                }
                break;
              }
              return (async () => {
                // Any other admission says the retained run is not coming back.
                await this.cancelRetainedAdmission();
                // A responsive item that landed between the follower's queued
                // report and this request is admitted at the priority it asked
                // for, not the one the follower knew about when it asked.
                const admission = { responsive: request.responsive || this.pendingQueuedPromotion };
                if (this.pendingQueuedPromotion) {
                  this.pendingQueuedPromotion = false;
                  if (!request.responsive) this.logAdmissionPromoted();
                }
                // A remote actor's provider gate lives here, not inside the
                // follower. Recheck host authority immediately before reserving
                // capacity so ordinary work queued before voice opens cannot
                // cross the boundary after it changes.
                if (
                  !(await (ctx.admitRun?.({
                    responsive: admission.responsive,
                    mode: request.mode,
                  }) ?? true))
                ) {
                  this.send({ type: "reply", requestId, value: { deferred: true } });
                  return;
                }
                let release!: () => void;
                const finished = new Promise<void>((resolve) => {
                  release = resolve;
                });
                const candidates = (
                  this.opts.bootstrap.modelConfig?.length
                    ? this.opts.bootstrap.modelConfig
                    : request.candidates
                ) as RawProviderModelConfig[];
                const modelConfigGeneration = this.modelConfigGeneration;
                const handle = ctx.gate(
                  async (selected) => {
                    // Provider pacing can delay this callback after the first
                    // preflight above. Recheck the live host authority at the
                    // actual admission boundary before exposing a snapshot to
                    // the follower, so no ordinary provider launch can cross a
                    // newly opened voice session.
                    if (
                      !(await (ctx.admitRun?.({
                        responsive: admission.responsive,
                        mode: request.mode,
                      }) ?? true))
                    ) {
                      this.send({ type: "reply", requestId, value: { deferred: true } });
                      return;
                    }
                    if (this.closed) throw new Error("Actor closed before admission");
                    const gate = this.gates.get(requestId);
                    if (
                      gate?.modelConfigStale ||
                      modelConfigGeneration !== this.modelConfigGeneration
                    ) {
                      this.send({
                        type: "reply",
                        requestId,
                        error: COORDINATOR_MODEL_CONFIG_CHANGED_ERROR,
                      });
                      return;
                    }
                    // Selection is decided here and carried to the follower, so the
                    // remote run uses the candidate the leader actually reserved.
                    this.send({
                      type: "reply",
                      requestId,
                      value: {
                        ...this.opts.snapshot(),
                        selected,
                        responsive: admission.responsive,
                      },
                    });
                    await finished;
                  },
                  candidates,
                  admission.responsive
                );
                this.gates.set(requestId, {
                  handle,
                  release,
                  admission,
                  modelConfigGeneration,
                  modelConfigStale: false,
                });
                void handle.result.catch((error: Error) => {
                  const gate = this.gates.get(requestId);
                  this.gates.delete(requestId);
                  if (gate?.modelConfigStale) {
                    this.send({
                      type: "reply",
                      requestId,
                      error: COORDINATOR_MODEL_CONFIG_CHANGED_ERROR,
                    });
                    return;
                  }
                  this.send({ type: "reply", requestId, error: error.message });
                  // A retained ticket that loses its place (the leader gave up, or
                  // pacing released it into a dead channel) ends the run it held:
                  // nothing else is left to report that run's outcome.
                  if (this.retainedAdmission?.requestId === requestId) {
                    void this.cancelRetainedAdmission();
                  }
                });
              })();
            }
          }
        } catch (error) {
          this.send({ type: "reply", requestId, error: String(error) });
        }
      }
    }
  }
}
