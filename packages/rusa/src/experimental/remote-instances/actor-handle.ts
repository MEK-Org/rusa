import type { ActorOptions } from "../../actor/actor.js";
import type { ActorFactoryContext, ActorRuntimeState, MeshActor } from "../../actor/actor-mesh.js";
import type { RunStartHandle } from "../../actor/concurrency-limiter.js";
import type { RunNudge } from "../../actor/trigger-runner.js";
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
  onFailure: (error: Error) => void;
  actorOptions?: ActorOptions;
}

/** MeshActor compatibility handle; connection/lifetime belongs to RemoteInstance. */
export class ActorHandle implements MeshActor {
  readonly id: string;
  readonly channel: ActorChannel;
  readonly ready: Promise<number>;
  readonly exited: Promise<void>;
  private state: ActorRuntimeState = "idle";
  private yielded = false;
  private closed = false;
  private gates = new Map<number, { handle: RunStartHandle<void>; release: () => void }>();
  private startupTimer: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: ActorHandleOptions) {
    this.id = opts.bootstrap.id;
    this.channel = opts.host;
    let resolveReady!: (pid: number) => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Factories are synchronous; boot failure can arrive before the caller awaits ready.
    void this.ready.catch(() => {});
    this.startupTimer = setTimeout(
      () => this.fail(new Error("Remote actor startup timed out")),
      10_000
    );
    this.channel.on("message", (raw) => {
      const message = raw as ActorEvent;
      if (message.type === "ready") {
        clearTimeout(this.startupTimer);
        resolveReady(message.pid);
      }
      void this.receive(message).catch((error) => this.fail(error));
    });
    this.channel.on("error", (error) => {
      rejectReady(error);
      this.fail(error);
    });
    this.exited = new Promise((resolve) =>
      this.channel.once("exit", (code, signal) => {
        clearTimeout(this.startupTimer);
        const error = new Error(`Remote actor exited (${signal ?? code})`);
        rejectReady(error);
        if (!this.closed) this.fail(error);
        this.releaseGates();
        this.state = "idle";
        opts.context.onRuntimeStateChanged("idle");
        resolve();
      })
    );
    this.send({ type: "init", bootstrap: opts.bootstrap });
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

  private fail(error: Error): void {
    if (this.closed) return;
    this.close();
    this.opts.onFailure(error);
  }

  private send(message: LeaderCommand): void {
    if (this.channel.connected)
      this.channel.send(message, (error) => {
        if (error) this.fail(error);
      });
  }

  private async receive(message: ActorEvent): Promise<void> {
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
        ctx.onQueued(message);
        break;
      case "result":
        await ctx.onRunEnd(message.result);
        break;
      case "runStart":
        hooks?.onRunStart?.(message.responsive, message.injectRecord, message.selected);
        break;
      case "firstChunk":
        hooks?.onFirstChunk?.();
        break;
      case "abandoned":
        hooks?.onRunAbandoned?.(message.abandon);
        break;
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
            case "beforeRun":
              this.send({
                type: "reply",
                requestId,
                value: {
                  allowed: await (hooks?.beforeRun?.(request) ?? ctx.beforeRun(request)),
                  sessionId: hooks?.loadSessionId() ?? ctx.getRecord()?.sessionId,
                },
              });
              break;
            case "prepareMount":
              this.send({
                type: "reply",
                requestId,
                value: await hooks?.prepareUnderstandingMount?.(),
              });
              break;
            case "complete":
              this.opts.onEvent?.({ type: "result", result: request.result });
              await ctx.onRunEnd(request.result);
              this.send({ type: "reply", requestId });
              break;
            case "sendMessage":
              // Bind sender identity here; the remote actor cannot choose a different actor.
              this.send({
                type: "reply",
                requestId,
                value: ctx.mesh.sendMessage(request.to, request.body, this.id),
              });
              break;
            case "admit": {
              let release!: () => void;
              const finished = new Promise<void>((resolve) => {
                release = resolve;
              });
              const handle = ctx.gate(
                async (selected) => {
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
              break;
            }
          }
        } catch (error) {
          this.send({ type: "reply", requestId, error: String(error) });
        }
      }
    }
  }
}
