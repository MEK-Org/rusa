import { Actor } from "../../actor/actor.js";
import { createActorLifecycle } from "../../actor/actor-lifecycle.js";
import {
  RunStartCancelledError,
  type RunStartHandle,
  RunStartStaleProviderError,
} from "../../actor/concurrency-limiter.js";
import type { ActorRunMode } from "../../actor/trigger-runner.js";
import type { ProviderModelConfig, RawProviderModelConfig } from "../../providers/model-config.js";
import type { CodingProvider, McpServerSpec } from "../../providers/types.js";
import {
  type ActorEvent,
  type Bootstrap,
  COORDINATOR_ADMISSION_CANCELLED_ERROR,
  COORDINATOR_MODEL_CONFIG_CHANGED_ERROR,
  COORDINATOR_RECONNECTED_ERROR,
  type LeaderCommand,
  type ProviderFactory,
  type Request,
  type RunSnapshot,
} from "./protocol.js";

type AdmitRequest = Extract<Request, { op: "admit" }>;

/** One ordinary Actor inside the follower process. No process-global handlers or exits. */
export function createActorRuntime(
  createProvider: ProviderFactory,
  send: (message: ActorEvent) => void,
  onClosed: () => void
) {
  let actor: Actor | undefined;
  let sequence = 0;
  let stopping = false;
  let activeGates = 0;
  let closed = false;
  let sessionId: string | undefined;
  // `beforeRun` belongs to the same serialized Actor opportunity as its later
  // provider gate. Carry its mode to the leader's final admission boundary.
  let pendingRunMode: ActorRunMode = "ordinary";
  let lastRuntimeState: "queued" | "running" | "winding_down" | "idle" = "idle";
  /** The admission request in flight, which a reconnecting leader can resume. */
  let pendingAdmission: { id: number; request: AdmitRequest } | undefined;
  /**
   * True only while a leader cancel command runs. The admission is the
   * leader's resource, so only the leader can make its pending start
   * cancellable; the Actor's own preempt and close paths still see an
   * uncancellable start, as before.
   */
  let leaderCancelling = false;
  /**
   * The leader forwards an interrupt once it has admitted the start, so the
   * command can land while that admission's reply is still unwinding toward
   * the provider launch. The Actor then sees a queued start it cannot cancel;
   * this refuses the start instead of letting the interrupted run launch.
   */
  let interruptedAdmission = false;
  const mcpServers: McpServerSpec[] = [];
  function finishClose(): void {
    if (stopping && !closed && activeGates === 0) {
      closed = true;
      onClosed();
    }
  }
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  function request<T>(payload: Request): { id: number; result: Promise<T> } {
    const id = ++sequence;
    if (stopping) return { id, result: Promise.reject(new Error("Actor is stopping")) };
    const result = new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      send({ type: "request", requestId: id, request: payload });
    });
    return { id, result };
  }

  async function initialize(bootstrap: Bootstrap): Promise<void> {
    if (stopping) return;
    if (actor) {
      // The leader can keep one unstarted admission across a transport loss.
      // That request is still pending here, so re-announcing it is what claims
      // the ticket; anything else the old connection owed is unrecoverable.
      const resumed =
        bootstrap.resumeAdmission && pendingAdmission && pending.has(pendingAdmission.id)
          ? pendingAdmission
          : undefined;
      for (const [id, call] of pending) {
        if (id === resumed?.id) continue;
        call.reject(new Error(COORDINATOR_RECONNECTED_ERROR));
        pending.delete(id);
      }
      if (bootstrap.mcpServers) {
        mcpServers.splice(0, mcpServers.length, ...bootstrap.mcpServers);
      }
      if (bootstrap.modelConfig?.length) {
        actor.setModelConfig(bootstrap.modelConfig as ProviderModelConfig[]);
      }
      if (bootstrap.sessionId) {
        sessionId = bootstrap.sessionId;
      }
      send({ type: "ready", pid: process.pid });
      // Claim the retained admission before reporting state: the leader drops
      // an unclaimed ticket at its first post-reattach state report.
      if (resumed) {
        send({
          type: "request",
          requestId: resumed.id,
          request: { ...resumed.request, resume: true },
        });
      }
      send({ type: "state", state: lastRuntimeState, yielded: actor.isYielded });
      return;
    }
    let snapshot: RunSnapshot;
    sessionId = bootstrap.sessionId;
    const bridge = {
      sendMessage: (to: string, body: string) => request({ op: "sendMessage", to, body }).result,
      yieldRun: (status?: string, note?: string) => {
        if (!actor) throw new Error("Actor is not initialized");
        actor.declareYield(status, note);
      },
    };
    const providerOptions = bootstrap.providerOptions ?? {};
    mcpServers.splice(0, mcpServers.length, ...(bootstrap.mcpServers ?? []));
    const modelConfig = bootstrap.modelConfig?.length
      ? [...bootstrap.modelConfig]
      : [{ provider: String(providerOptions.name ?? "unknown") }];
    const providers = new Map<string, CodingProvider>();
    const resolveProvider = (selected: RawProviderModelConfig): CodingProvider => {
      const key = JSON.stringify(selected);
      let provider = providers.get(key);
      if (!provider) {
        provider = createProvider(bridge, providerOptions, selected);
        providers.set(key, provider);
      }
      return provider;
    };
    // Construct the bootstrap tuple before ready so a bad follower provider
    // still rejects startup. Later runs resolve their own admitted tuple.
    resolveProvider(modelConfig[0]);
    if (stopping) return;
    actor = new Actor({
      ...bootstrap.actorOptions,
      id: bootstrap.id,
      cwd: bootstrap.cwd,
      modelConfig,
      resolveProvider,
      mcpServers,
      debounceMs: bootstrap.actorOptions?.debounceMs ?? 10,
      loadSessionId: () => sessionId,
      saveSessionId: (id) => {
        sessionId = id;
        send({ type: "session", sessionId: id });
      },
      buildPrompt: () => snapshot.promptBuild ?? { prompt: snapshot.prompt },
      prepareUnderstandingMount: () => request<string | undefined>({ op: "prepareMount" }).result,
      beforeRun: async ({ mode }) => {
        pendingRunMode = mode;
        try {
          const reply = await request<{ allowed: boolean; sessionId?: string }>({
            op: "beforeRun",
            mode,
          }).result;
          sessionId = reply.sessionId;
          return reply.allowed;
        } catch (err) {
          if (
            err instanceof Error &&
            (err.message.includes("Coordinator reconnected") ||
              err.message.includes("Coordinator disconnected"))
          ) {
            return false;
          }
          throw err;
        }
      },
      gate: <T>(
        fn: (selected: RawProviderModelConfig) => Promise<T>,
        candidates: readonly RawProviderModelConfig[],
        responsive: boolean
      ): RunStartHandle<T> => {
        activeGates++;
        // A new admission is a new opportunity; an older interrupt is not about it.
        interruptedAdmission = false;
        const admitRequest: AdmitRequest = {
          op: "admit",
          candidates: [...candidates],
          responsive,
          mode: pendingRunMode,
        };
        const admission = request<RunSnapshot | { deferred: true }>(admitRequest);
        pendingAdmission = { id: admission.id, request: admitRequest };
        const result = (async () => {
          try {
            let admitted: RunSnapshot | { deferred: true };
            try {
              admitted = await admission.result;
            } catch (err) {
              if (
                err instanceof Error &&
                err.message.includes(COORDINATOR_MODEL_CONFIG_CHANGED_ERROR)
              ) {
                // The leader cancelled a stale reservation after changing this
                // Actor's pool. Actor's retry loop re-runs the same opportunity
                // against the pool set by the preceding modelConfig command.
                throw new RunStartStaleProviderError();
              }
              if (
                err instanceof Error &&
                (err.message.includes(COORDINATOR_RECONNECTED_ERROR) ||
                  err.message.includes(COORDINATOR_ADMISSION_CANCELLED_ERROR) ||
                  err.message.includes("Coordinator disconnected"))
              ) {
                throw new RunStartCancelledError();
              }
              throw err;
            }
            if ("deferred" in admitted) throw new RunStartCancelledError();
            snapshot = admitted;
            if (stopping) throw new Error("Actor stopped before admission");
            // The leader's admission decision, not wake ordering, sets the run's priority.
            if (admitted.responsive && !responsive) actor?.promoteQueuedRun();
            sessionId = snapshot.record.sessionId;
            if (snapshot.mcpServers) {
              // Actor holds the array by reference, matching the in-process tool refresh path.
              mcpServers.splice(0, mcpServers.length, ...snapshot.mcpServers);
            }
            if (interruptedAdmission) {
              interruptedAdmission = false;
              throw new RunStartCancelledError();
            }
            // The leader's pacing gate owns selection; the follower runs what it reserved.
            return await fn(snapshot.selected ?? candidates[0]);
          } finally {
            if (pendingAdmission?.id === admission.id) pendingAdmission = undefined;
            send({ type: "release", requestId: admission.id });
            activeGates--;
            finishClose();
          }
        })();
        return {
          result,
          started: false,
          promote: () => {},
          // Settle the start here rather than waiting for the leader's error
          // reply, so Actor.cancelQueuedRun keeps this opportunity for resume.
          cancel: () => {
            const call = leaderCancelling ? pending.get(admission.id) : undefined;
            if (!call) return false;
            pending.delete(admission.id);
            call.reject(new RunStartCancelledError());
            return true;
          },
        };
      },
      lifecycle: createActorLifecycle([
        {
          onQueued: (event) =>
            send({
              type: "queued",
              responsive: event.responsive,
              mode: event.mode,
              runId: event.runId,
            }),
          onStart: (event) =>
            send({
              type: "runStart",
              responsive: event.responsive,
              injectRecord: event.injectRecord,
              selected: event.selected,
              runId: event.runId,
            }),
          onError: (event) =>
            send({
              type: "error",
              error: event.error instanceof Error ? event.error.message : String(event.error),
            }),
          onEnd: (event) => {
            if (event.terminal.kind === "abandoned") {
              send({
                type: "abandoned",
                abandon: {
                  reason: event.terminal.reason,
                  started: event.terminal.started,
                },
              });
              return;
            }
            if (!stopping)
              return request<void>({ op: "complete", result: event.terminal.result }).result;
          },
        },
      ]),
      onFirstChunk: () => send({ type: "firstChunk" }),
      onCoalesceAborted: (count, ageMs) => send({ type: "coalesced", count, ageMs }),
      onRuntimeStateChanged: (state) => {
        lastRuntimeState = state;
        send({ type: "state", state, yielded: actor?.isYielded ?? false });
      },
      log: (chunk) => send({ type: "log", chunk }),
    });
    send({ type: "ready", pid: process.pid });
    if (bootstrap.reconnect) {
      send({ type: "state", state: "idle", yielded: false });
    }
  }

  function stop(): void {
    if (stopping) return;
    stopping = true;
    actor?.interrupt("instance-actor-retirement");
    actor?.close();
    for (const call of pending.values())
      call.reject(new Error("Coordinator disconnected or stopped actor"));
    pending.clear();
    finishClose();
  }

  function dispatch(message: LeaderCommand): void {
    switch (message.type) {
      case "init":
        void initialize(message.bootstrap).catch((error) => {
          send({ type: "fatal", error: String(error) });
          stop();
        });
        break;
      case "modelConfig":
        actor?.setModelConfig(message.modelConfig as ProviderModelConfig[]);
        break;
      case "reply": {
        const call = pending.get(message.requestId);
        pending.delete(message.requestId);
        if (message.error) call?.reject(new Error(message.error));
        else call?.resolve(message.value);
        break;
      }
      case "wake":
        if (!stopping) actor?.requestRun(message.nudge);
        break;
      case "preempt": {
        // The leader can only report this as effective after this reply: the
        // leader-side handle has no direct visibility into the follower's
        // Actor state or its provider abort signal.
        const result = actor?.preemptForResponsive() ?? { preempted: false as const };
        send({ type: "preempted", requestId: message.requestId, ...result });
        break;
      }
      case "interrupt":
        if (actor?.interrupt(message.by).wasQueued && pendingAdmission) interruptedAdmission = true;
        break;
      case "cancelQueued":
        leaderCancelling = true;
        try {
          actor?.cancelQueuedRun();
        } finally {
          leaderCancelling = false;
        }
        break;
      case "resumeCancelled":
        // A start the leader cancelled before this Actor could retain it (a
        // lease flap, for one) still owes the actor its scheduling opportunity.
        if (!stopping && actor && !actor.resumeCancelledRun()) actor.requestRun(message.nudge);
        break;
      case "yield":
        actor?.declareYield(message.status, message.note);
        break;
      case "unkillable":
        actor?.markUnkillable();
        break;
      case "stop":
        stop();
        break;
    }
  }
  return { dispatch, close: stop };
}
