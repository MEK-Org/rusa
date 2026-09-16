import { randomUUID } from "node:crypto";
import type { ActorOptions } from "../../actor/actor.js";
import type { ActorLifecycleAbandonmentReason } from "../../actor/actor-lifecycle.js";
import type { ActorFactoryContext, ActorRuntimeState, MeshActor } from "../../actor/actor-mesh.js";
import type { RunStartHandle } from "../../actor/concurrency-limiter.js";
import type { ActorRunMode, RunNudge } from "../../actor/trigger-runner.js";
import { type Logger, nullLogger } from "../../observability/logger.js";
import type { RunResult } from "../../providers/types.js";
import type { ActorChannel } from "./actor-channel.js";
import type { ActorEvent, Bootstrap, LeaderCommand, RunSnapshot } from "./protocol.js";

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
  private gates = new Map<number, { handle: RunStartHandle<void>; release: () => void }>();
  private startupTimer?: ReturnType<typeof setTimeout>;
  /** True between the leader admitting a run and that same run's terminal accounting. */
  private runOpen = false;
  /** Identity minted by the leader-side execution coordinator before admission. */
  private queuedRunId: string | undefined;
  private startedRunId: string | undefined;
  private queuedMode: ActorRunMode | undefined;
  private receiveChain: Promise<void> | undefined;

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

  private bindChannel(channel: ActorChannel): void {
    let resolveReady!: (pid: number) => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Factories are synchronous; boot failure can arrive before the caller awaits ready.
    void this.ready.catch(() => {});
    clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(
      () => this.fail(new Error("Remote actor startup timed out")),
      10_000
    );
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
        if (!this.closed) this.fail(error);
        this.releaseGates();
        this.state = "idle";
        this.opts.context.onRuntimeStateChanged("idle");
        resolve();
      })
    );
  }

  attachHost(newChannel: ActorChannel): void {
    this.channel.removeAllListeners();
    this.channel = newChannel;
    this.closed = false;
    this.bindChannel(newChannel);
    const freshSnapshot = this.opts.snapshot();
    const sessionId = freshSnapshot.record.sessionId ?? this.opts.bootstrap.sessionId;
    this.send({
      type: "init",
      bootstrap: {
        ...this.opts.bootstrap,
        ...(sessionId ? { sessionId } : {}),
        modelConfig: freshSnapshot.record.modelConfig ?? this.opts.bootstrap.modelConfig,
        mcpServers: freshSnapshot.mcpServers,
        reconnect: true,
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
    if (this.closed) return;
    void this.ready
      .then(() => {
        if (!this.closed) this.send({ type: "wake", nudge });
      })
      .catch(() => {});
  }
  declareYield(status?: string, note?: string): void {
    // Fence parent-hosted tools immediately when the mesh accepts yield_run.
    this.yielded = true;
    this.send({ type: "yield", status, note });
  }
  markUnkillable(): void {
    this.send({ type: "unkillable" });
  }
  // The synchronous preemption contract cannot truthfully acknowledge child execution.
  // Keep responsive preemption unsupported until that contract becomes asynchronous.
  preemptForResponsive(): { preempted: false } {
    return { preempted: false };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.startupTimer);
    // Keep running slots occupied until the remote actor releases them or exits.
    for (const gate of this.gates.values()) gate.handle.cancel?.();
    this.send({ type: "stop" });
  }

  private releaseGates(): void {
    for (const gate of this.gates.values()) {
      gate.handle.cancel?.();
      gate.release();
    }
    this.gates.clear();
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
    this.close();
    this.opts.onFailure(error);
    // A connection or startup failure is not itself a run outcome. Only a run
    // the leader actually admitted is terminated here, so an idle disconnect or
    // a boot timeout books nothing.
    const terminate = () => {
      if (this.runOpen) {
        void this.endRun({ success: false, output: error.message, exitCode: -1 });
      } else if (this.queuedRunId) {
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

  private send(message: LeaderCommand): void {
    if (this.channel.connected)
      this.channel.send(message, (error) => {
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
      case "state":
        this.state = message.state;
        this.yielded = message.yielded;
        ctx.onRuntimeStateChanged(message.state);
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
              return (async () => {
                // A remote actor's provider gate lives here, not inside the
                // follower. Recheck host authority immediately before reserving
                // capacity so ordinary work queued before voice opens cannot
                // cross the boundary after it changes.
                if (
                  !(await (ctx.admitRun?.({
                    responsive: request.responsive,
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
                const handle = ctx.gate(
                  async (selected) => {
                    // Provider pacing can delay this callback after the first
                    // preflight above. Recheck the live host authority at the
                    // actual admission boundary before exposing a snapshot to
                    // the follower, so no ordinary provider launch can cross a
                    // newly opened voice session.
                    if (
                      !(await (ctx.admitRun?.({
                        responsive: request.responsive,
                        mode: request.mode,
                      }) ?? true))
                    ) {
                      this.send({ type: "reply", requestId, value: { deferred: true } });
                      return;
                    }
                    if (this.closed) throw new Error("Actor closed before admission");
                    // Selection is decided here and carried to the follower, so the
                    // remote run uses the candidate the leader actually reserved.
                    this.send({
                      type: "reply",
                      requestId,
                      value: { ...this.opts.snapshot(), selected },
                    });
                    await finished;
                  },
                  request.candidates,
                  request.responsive
                );
                this.gates.set(requestId, { handle, release });
                void handle.result.catch((error: Error) => {
                  this.gates.delete(requestId);
                  this.send({ type: "reply", requestId, error: error.message });
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
