import { fork } from "node:child_process";
import type { ActorOptions } from "../../actor/actor.js";
import type { ActorFactoryContext, ActorRuntimeState, MeshActor } from "../../actor/actor-mesh.js";
import type { RunStartHandle } from "../../actor/concurrency-limiter.js";
import type { RunNudge } from "../../actor/trigger-runner.js";
import type { CodingProvider } from "../../providers/types.js";
import type { ActorHost } from "./actor-host.js";
import type { Bootstrap, ChildMessage, ParentMessage, RunSnapshot } from "./protocol.js";

export interface ProcessActorOptions {
  host?: ActorHost;
  childEntry: string | URL;
  bootstrap: Bootstrap;
  context: ActorFactoryContext;
  // Read only after central scheduler admission, so queued runs get fresh work.
  snapshot: () => RunSnapshot;
  saveSession: (sessionId: string) => void;
  onEvent?: (event: ChildMessage) => void;
  onFailure: (error: Error) => void;
  actorOptions?: ActorOptions;
}

/** Experimental MeshActor adapter. One real Actor lives in each child process. */
export class ProcessActor implements MeshActor {
  readonly id: string;
  readonly process: ActorHost;
  readonly ready: Promise<number>;
  readonly exited: Promise<void>;
  private state: ActorRuntimeState = "idle";
  private yielded = false;
  private closed = false;
  private gates = new Map<number, { handle: RunStartHandle<void>; release: () => void }>();
  private startupTimer: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: ProcessActorOptions) {
    this.id = opts.bootstrap.id;
    this.process =
      opts.host ??
      fork(opts.childEntry, [], {
        cwd: opts.bootstrap.cwd,
        execArgv: [],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
    let resolveReady!: (pid: number) => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Factories are synchronous; boot failure can arrive before the caller awaits ready.
    void this.ready.catch(() => {});
    this.startupTimer = setTimeout(
      () => this.fail(new Error("Actor child startup timed out")),
      10_000
    );
    this.process.on("message", (raw) => {
      const message = raw as ChildMessage;
      if (message.type === "ready") {
        clearTimeout(this.startupTimer);
        resolveReady(message.pid);
      }
      void this.receive(message).catch((error) => this.fail(error));
    });
    this.process.on("error", (error) => {
      rejectReady(error);
      this.fail(error);
    });
    this.exited = new Promise((resolve) =>
      this.process.once("exit", (code, signal) => {
        clearTimeout(this.startupTimer);
        clearTimeout(this.killTimer);
        const error = new Error(`Actor child exited (${signal ?? code})`);
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
  getProvider(): CodingProvider {
    if (!this.opts.actorOptions)
      throw new Error("Provider metadata unavailable in standalone demo");
    return this.opts.actorOptions.provider;
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
    // Keep running slots occupied until the child releases them or exits.
    for (const gate of this.gates.values()) gate.handle.cancel?.();
    this.send({ type: "stop" });
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.killTimer = setTimeout(() => this.process.kill("SIGKILL"), 1500);
      this.killTimer.unref();
    }
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

  private send(message: ParentMessage): void {
    if (this.process.connected)
      this.process.send(message, (error) => {
        if (error) this.fail(error);
      });
  }

  private async receive(message: ChildMessage): Promise<void> {
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
        hooks?.onRunStart?.(message.responsive, message.injectRecord);
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
              // Bind sender identity here; the child cannot choose a different actor.
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
                async () => {
                  if (this.closed) throw new Error("Actor closed before admission");
                  this.send({ type: "reply", requestId, value: this.opts.snapshot() });
                  await finished;
                },
                request.provider,
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
