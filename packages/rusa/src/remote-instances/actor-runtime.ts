import { Actor } from "../actor/actor.js";
import { type ActorLifecycleStartEvent, createActorLifecycle } from "../actor/actor-lifecycle.js";
import type { ComputerUseLock } from "../actor/computer-use-lock.js";
import {
  RunStartCancelledError,
  type RunStartHandle,
  RunStartStaleProviderError,
} from "../actor/concurrency-limiter.js";
import { composeHostContextIntoPrompt, portableContextMaxRuns } from "../actor/portable-context.js";
import { projectActorRunLaunchConfig } from "../actor/run-accounting.js";
import type { ActorRunMode } from "../actor/trigger-runner.js";
import type { FollowerRepositories } from "../db/repositories/index.js";
import type { ProviderModelConfig, RawProviderModelConfig } from "../providers/model-config.js";
import type { CodingProvider, McpServerSpec, RunResult } from "../providers/types.js";
import {
  type ActorEvent,
  BOUNDED_EXECUTION_CAPABILITY,
  type Bootstrap,
  COORDINATOR_ADMISSION_CANCELLED_ERROR,
  COORDINATOR_MODEL_CONFIG_CHANGED_ERROR,
  COORDINATOR_RECONNECTED_ERROR,
  type LeaderCommand,
  type ProviderFactory,
  type Request,
  type RunSnapshot,
} from "./protocol.js";
import {
  boundedCompleteFits,
  boundRunResult,
  RunMaterialReservationError,
  type RunMaterialStore,
} from "./run-material.js";

/** This host's run material store and whether the current leader negotiated bounded execution (#1020). */
export interface RunMaterialOptions {
  store: RunMaterialStore;
  enabled: () => boolean;
}

type AdmitRequest = Extract<Request, { op: "admit" }>;

/** One ordinary Actor inside the follower process. No process-global handlers or exits. */
export function createActorRuntime(
  createProvider: ProviderFactory,
  send: (message: ActorEvent) => void,
  onClosed: () => void,
  computerUseLock?: ComputerUseLock,
  repositories?: FollowerRepositories,
  material?: RunMaterialOptions
) {
  let actor: Actor | undefined;
  let sequence = 0;
  let stopping = false;
  let activeGates = 0;
  // A gate releases as soon as the provider returns, but terminal persistence
  // happens immediately afterwards in Actor.executeTurn. Keep the runtime
  // owned until that local accounting has completed during shutdown.
  let terminalAccountingPending = false;
  let closed = false;
  let sessionId: string | undefined;
  // `beforeRun` belongs to the same serialized Actor opportunity as its later
  // provider gate. Carry its mode to the leader's final admission boundary.
  let pendingRunMode: ActorRunMode = "ordinary";
  let lastRuntimeState: "queued" | "running" | "idle" = "idle";
  /** The leader's number for the pool the Actor holds; `admit` echoes it (#725). */
  let modelConfigGeneration: number | undefined;
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
  /** Runs bound to this host at start: their material is retained here (#1020). */
  const boundRuns = new Set<string>();
  /**
   * First prompt attempt reservation result for a negotiated run, established in
   * `onStart` so `runStart` is sent on time.
   */
  const firstReservations = new Map<string, { attempt?: number; error?: unknown }>();
  function finishClose(): void {
    if (stopping && !closed && activeGates === 0 && !terminalAccountingPending) {
      closed = true;
      onClosed();
    }
  }
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      removeAbortListener?: () => void;
    }
  >();

  function takePending(id: number) {
    const call = pending.get(id);
    if (!call) return undefined;
    pending.delete(id);
    call.removeAbortListener?.();
    return call;
  }

  function rejectPending(id: number, error: Error): void {
    takePending(id)?.reject(error);
  }

  function cancellationError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new Error("Provider attempt acknowledgement cancelled");
  }

  function reportLocalAccountingFailure(
    phase: "start" | "prompt" | "terminal",
    runId: string,
    error: unknown
  ): void {
    send({
      type: "error",
      error: `Local ${phase} accounting failed for run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  /**
   * A bound run's material went to the leader in full. The event itself says
   * so (`runPrompt.attempt`, or a `complete` without `outputBound`); this
   * reports why.
   */
  function reportMaterialFallback(
    item: "prompt" | "output" | "envelope",
    runId: string,
    error?: unknown
  ): void {
    const reason =
      item === "envelope"
        ? "the bounded completion exceeds its envelope"
        : `retaining the ${item} failed: ${error instanceof Error ? error.message : String(error)}`;
    send({
      type: "error",
      error: `Run material fallback for run ${runId}: ${reason}; sent in full`,
    });
  }

  function sendRunStart(event: ActorLifecycleStartEvent, bound: boolean): void {
    send({
      type: "runStart",
      responsive: event.responsive,
      injectRecord: event.injectRecord,
      selected: event.selected,
      runId: event.runId,
      ...(bound ? { material: BOUNDED_EXECUTION_CAPABILITY } : {}),
    });
  }

  /** Retain a bound run's output and bound its result, or keep the full result. */
  function completionFor(actorId: string, runId: string, result: RunResult): RunResult {
    if (!material) return result;
    try {
      const bounded = boundRunResult(
        result,
        material.store.putOutput(actorId, runId, result.output)
      );
      // A leader that stopped negotiating since the run started gets the
      // full result; the original is retained here regardless.
      if (!material.enabled()) return result;
      if (boundedCompleteFits(bounded)) return bounded;
      reportMaterialFallback("envelope", runId);
    } catch (error) {
      reportMaterialFallback("output", runId, error);
    }
    return result;
  }

  function request<T>(payload: Request, signal?: AbortSignal): { id: number; result: Promise<T> } {
    const id = ++sequence;
    if (stopping) return { id, result: Promise.reject(new Error("Actor is stopping")) };
    if (signal?.aborted) return { id, result: Promise.reject(cancellationError(signal)) };
    const result = new Promise<T>((resolve, reject) => {
      const call: {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        removeAbortListener?: () => void;
      } = { resolve: (value: unknown) => resolve(value as T), reject };
      pending.set(id, call);
      if (signal) {
        const cancel = () => rejectPending(id, cancellationError(signal));
        call.removeAbortListener = () => signal.removeEventListener("abort", cancel);
        signal.addEventListener("abort", cancel, { once: true });
        // An abort can race with listener installation. Do not send a request
        // that the Actor has already cancelled.
        if (signal.aborted) {
          cancel();
          return;
        }
      }
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
      for (const [id] of pending) {
        if (id === resumed?.id) continue;
        rejectPending(id, new Error(COORDINATOR_RECONNECTED_ERROR));
      }
      if (bootstrap.mcpServers) {
        mcpServers.splice(0, mcpServers.length, ...bootstrap.mcpServers);
      }
      if (bootstrap.modelConfig?.length) {
        actor.setModelConfig(bootstrap.modelConfig as ProviderModelConfig[]);
      }
      modelConfigGeneration = bootstrap.modelConfigGeneration;
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
      send({ type: "state", state: lastRuntimeState });
      return;
    }
    let snapshot: RunSnapshot;
    sessionId = bootstrap.sessionId;
    modelConfigGeneration = bootstrap.modelConfigGeneration;
    const bridge = {
      sendMessage: (to: string, body: string) => request({ op: "sendMessage", to, body }).result,
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
    let currentRunComputerUse = false;
    actor = new Actor({
      ...bootstrap.actorOptions,
      id: bootstrap.id,
      cwd: bootstrap.cwd,
      modelConfig,
      resolveProvider,
      mcpServers,
      isComputerUseAdmitted: () => currentRunComputerUse,
      debounceMs: bootstrap.actorOptions?.debounceMs ?? 10,
      loadSessionId: () => sessionId,
      saveSessionId: (id) => {
        sessionId = id;
        send({ type: "session", sessionId: id });
      },
      buildPrompt: () => {
        const baseBuild = snapshot.promptBuild ?? { prompt: snapshot.prompt };
        // Host-local runs are prompt memory only for a portable actor. A native
        // actor's history is its leader-selected provider session.
        if (!repositories || snapshot.record.context?.type !== "portable") return baseBuild;
        // Without the leader's read window this follower cannot tell a run the
        // leader dropped for budget from one it never saw. Rendered ids would
        // misfile every dropped run as local, so an older leader's prompt is
        // used unchanged and host history waits for the leader upgrade.
        const leaderReadRunIds = baseBuild.readRunIds;
        if (!leaderReadRunIds) return baseBuild;
        const { prompt, portable } = composeHostContextIntoPrompt({
          basePrompt: baseBuild.prompt,
          localRuns: repositories.actorRuns
            .listRecentCompleted(bootstrap.id, portableContextMaxRuns())
            .map((run) => ({ id: run.id, ts: run.endedAt ?? run.startedAt, body: run.output })),
          // Follower run ids are the leader's actor_run ids, so the leader's
          // read window names exactly which of these runs it already had.
          leaderReadRunIds,
        });
        if (!portable) return baseBuild;
        return {
          ...baseBuild,
          prompt,
          // This is the exact, bounded host contribution appended above;
          // retaining a leader record here would claim its bytes/hash for
          // different text delivered by this follower.
          injectRecord: portable.record,
        };
      },
      prepareUnderstandingMount: () => request<string | undefined>({ op: "prepareMount" }).result,
      beforeProviderAttempt: ({ runId }) => {
        const first = firstReservations.get(runId);
        if (first) {
          firstReservations.delete(runId);
          if (first.error) {
            const error = first.error;
            throw new RunMaterialReservationError(
              `Run material admission failed for run ${runId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              error
            );
          }
          return first.attempt;
        }
        // A run that began unnegotiated remains legacy for its lifetime.
        if (!material || !boundRuns.has(runId)) return undefined;
        try {
          return material.store.reservePromptAttempt(bootstrap.id, runId);
        } catch (error) {
          throw new RunMaterialReservationError(
            `Run material admission failed for run ${runId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            error
          );
        }
      },
      beforeRun: async ({ mode }) => {
        currentRunComputerUse = false;
        pendingRunMode = mode;
        try {
          const reply = await request<{
            allowed: boolean;
            sessionId?: string;
          }>({
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
      gate: (fn, candidates, responsive) => {
        // `candidates` is the pool the Actor held at this call, which the
        // computer-use lock can hand to leaderGate later.
        const quotedGeneration = modelConfigGeneration;
        let providerStarted = false;
        // This must be set by the leader's selected-provider reply, not by
        // beforeRun: a durable grant can change while provider pacing waits.
        let computerUseAtAdmission = false;
        const leaderGate = <T>(
          start: (selected: RawProviderModelConfig) => Promise<T>
        ): RunStartHandle<T> => {
          activeGates++;
          // A new admission is a new opportunity; an older interrupt is not about it.
          interruptedAdmission = false;
          const admitRequest: AdmitRequest = {
            op: "admit",
            candidates: [...candidates],
            responsive,
            mode: pendingRunMode,
            modelConfigGeneration: quotedGeneration,
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
              computerUseAtAdmission = admitted.computerUse === true;
              currentRunComputerUse = computerUseAtAdmission;
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
              providerStarted = true;
              return await start(snapshot.selected ?? candidates[0]);
            } finally {
              if (pendingAdmission?.id === admission.id) pendingAdmission = undefined;
              send({ type: "release", requestId: admission.id });
              activeGates--;
              finishClose();
            }
          })();
          return {
            result,
            get started() {
              return providerStarted;
            },
            promote: () => {},
            // Settle the start here rather than waiting for the leader's error
            // reply, so Actor.cancelQueuedRun keeps this opportunity for resume.
            cancel: () => {
              if (providerStarted) return false;
              const call = leaderCancelling ? takePending(admission.id) : undefined;
              if (!call) return false;
              call.reject(new RunStartCancelledError());
              return true;
            },
          };
        };
        return computerUseLock
          ? computerUseLock.gateAfterProvider(
              bootstrap.id,
              responsive,
              leaderGate,
              fn,
              () => computerUseAtAdmission,
              () => actor?.preemptForResponsive(),
              () => actor?.requestRun()
            )
          : leaderGate(fn);
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
          onStart: (event) => {
            terminalAccountingPending = true;
            if (repositories) {
              try {
                const launchConfig = projectActorRunLaunchConfig(event.selected);
                repositories.actorRuns.start({
                  id: event.runId,
                  actorId: bootstrap.id,
                  modelConfig: launchConfig,
                });
              } catch (error) {
                reportLocalAccountingFailure("start", event.runId, error);
              }
            }
            // A negotiated run reserves attempt 1 here so runStart is sent on
            // time, bound when the reservation succeeded and unbound when it failed.
            const bound = material?.enabled() === true;
            if (bound) {
              try {
                const attempt = material.store.reservePromptAttempt(bootstrap.id, event.runId);
                boundRuns.add(event.runId);
                material.store.openRun(bootstrap.id, event.runId);
                firstReservations.set(event.runId, { attempt });
                sendRunStart(event, true);
              } catch (error) {
                firstReservations.set(event.runId, { error });
                sendRunStart(event, false);
              }
            } else {
              sendRunStart(event, false);
            }
          },
          onPrompt: (event) => {
            if (material && boundRuns.has(event.runId)) {
              const { attempt } = event;
              try {
                if (attempt === undefined) {
                  throw new RunMaterialReservationError(
                    "Provider launched without a durable prompt reservation"
                  );
                }
                const ref = material.store.putPrompt(
                  bootstrap.id,
                  event.runId,
                  attempt,
                  event.prompt
                );
                send(
                  material.enabled()
                    ? { type: "runPromptRef", runId: event.runId, attempt, ...ref }
                    : { type: "runPrompt", runId: event.runId, prompt: event.prompt, attempt }
                );
              } catch (error) {
                send({
                  type: "runPrompt",
                  runId: event.runId,
                  prompt: event.prompt,
                  ...(attempt === undefined ? {} : { attempt }),
                });
                reportMaterialFallback("prompt", event.runId, error);
              }
            } else {
              send({
                type: "runPrompt",
                runId: event.runId,
                prompt: event.prompt,
              });
            }
            if (repositories) {
              try {
                repositories.runPrompts.recordForActor(bootstrap.id, event.runId, event.prompt);
              } catch (error) {
                reportLocalAccountingFailure("prompt", event.runId, error);
              }
            }
          },
          onError: (event) =>
            send({
              type: "error",
              error: event.error instanceof Error ? event.error.message : String(event.error),
            }),
          onEnd: (event) => {
            firstReservations.delete(event.runId);
            const bound = boundRuns.delete(event.runId);
            try {
              if (event.terminal.kind === "abandoned") {
                if (repositories && event.terminal.started) {
                  try {
                    if (repositories.runReceipts) {
                      // The evidence is the provider call's own settlement,
                      // never this hook's: an abandoned run whose provider
                      // was not observed to exit stays unresolved (#1119).
                      repositories.runReceipts.abandon(
                        event.runId,
                        bootstrap.id,
                        event.terminal.reason,
                        event.terminal.termination
                      );
                    } else {
                      repositories.actorRuns.abandon(event.runId, event.terminal.reason);
                    }
                  } catch (error) {
                    reportLocalAccountingFailure("terminal", event.runId, error);
                  }
                }
                send({
                  type: "abandoned",
                  abandon: {
                    reason: event.terminal.reason,
                    started: event.terminal.started,
                    ...(event.terminal.termination
                      ? { termination: event.terminal.termination }
                      : {}),
                  },
                });
                return;
              }
              if (repositories) {
                try {
                  const terminal = {
                    success: event.terminal.result.success,
                    exitCode: event.terminal.result.exitCode,
                    output: event.terminal.result.output,
                  };
                  // With receipts (#1020), the local terminal and the receipt
                  // the leader is owed commit together, and only when the
                  // provider's exit was observed (#1119).
                  if (repositories.runReceipts) {
                    repositories.runReceipts.complete(
                      event.runId,
                      bootstrap.id,
                      terminal,
                      event.terminal.result.termination
                    );
                  } else {
                    repositories.actorRuns.complete(event.runId, terminal);
                  }
                } catch (error) {
                  reportLocalAccountingFailure("terminal", event.runId, error);
                }
              }
              const result = bound
                ? completionFor(bootstrap.id, event.runId, event.terminal.result)
                : event.terminal.result;
              if (!stopping) return request<void>({ op: "complete", result }).result;
            } finally {
              if (bound) material?.store.closeRun(bootstrap.id, event.runId);
              terminalAccountingPending = false;
              finishClose();
            }
          },
        },
      ]),
      onFirstChunk: () => send({ type: "firstChunk" }),
      // The leader owns public write attribution, while this follower owns the
      // actual provider invocation, whose model and effort its own config may
      // fill in. Events reach the leader on a batched, retried path and the
      // provider's MCP writes on another, so wait for the leader to confirm the
      // attempt before the Actor invokes the provider. A leader reconnect while
      // this is pending rejects it and fails the admitted run before launch, by
      // design: the provider's writes go through that leader, so launching
      // anyway would lose their attribution.
      onProviderAttempt: (provider, signal) =>
        request<void>(
          {
            op: "providerAttempt",
            attempt: {
              provider: provider.providerName,
              model: provider.model,
              effort: provider.effort,
            },
          },
          signal
        ).result,
      onCoalesceAborted: (count, ageMs) => send({ type: "coalesced", count, ageMs }),
      onRuntimeStateChanged: (state) => {
        lastRuntimeState = state;
        send({ type: "state", state });
      },
      log: (chunk) => send({ type: "log", chunk }),
    });
    send({ type: "ready", pid: process.pid });
    if (bootstrap.reconnect) {
      send({ type: "state", state: "idle" });
    }
  }

  function stop(): void {
    if (stopping) return;
    stopping = true;
    actor?.interrupt("instance-actor-retirement");
    actor?.close();
    for (const id of [...pending.keys()])
      rejectPending(id, new Error("Coordinator disconnected or stopped actor"));
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
        modelConfigGeneration = message.generation;
        break;
      case "reply": {
        const call = takePending(message.requestId);
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
          actor?.cancelQueuedRun({ retain: message.retain });
        } finally {
          leaderCancelling = false;
        }
        break;
      case "resumeCancelled":
        // A start the leader cancelled before this Actor could retain it (a
        // lease flap, for one) still owes the actor its scheduling opportunity.
        if (!stopping && actor && !actor.resumeCancelledRun()) actor.requestRun(message.nudge);
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
