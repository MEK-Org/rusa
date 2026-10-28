import type { RawProviderModelConfig } from "../providers/model-config.js";
import type { RunTokenUsage } from "../providers/token-accounting.js";
import type { RunResult, RunTermination } from "../providers/types.js";
import type { InjectRecord } from "./portable-context.js";
import type { ActorRunMode } from "./trigger-runner.js";

/** The closed v1 observation contract for one actor and its runs. */
export interface ActorLifecycleListener {
  onSpawn?(event: ActorLifecycleActorEvent): void | Promise<void>;
  onQueued?(event: ActorLifecycleQueuedEvent): void | Promise<void>;
  onStart?(event: ActorLifecycleStartEvent): void | Promise<void>;
  onPrompt?(event: ActorLifecyclePromptEvent): void | Promise<void>;
  onError?(event: ActorLifecycleErrorEvent): void | Promise<void>;
  onEnd?(event: ActorLifecycleEndEvent): void | Promise<void>;
  onRetire?(event: ActorLifecycleActorEvent): void | Promise<void>;
}

export interface ActorLifecycleActorEvent {
  actorId: string;
}

export interface ActorLifecycleRunEvent extends ActorLifecycleActorEvent {
  /** Minted by the execution coordinator before the run is admitted. */
  runId: string;
}

export interface ActorLifecycleQueuedEvent extends ActorLifecycleRunEvent {
  responsive: boolean;
  mode: ActorRunMode;
}

export interface ActorLifecycleStartEvent extends ActorLifecycleQueuedEvent {
  injectRecord?: InjectRecord;
  selected: RawProviderModelConfig;
  /**
   * Set when the run's prompts and output are retained on its execution host
   * (#1020): `host` is the follower that started it, where they are read from.
   */
  material?: { version: 1; host: string };
  /**
   * The execution instance that owes this run a durable terminal receipt
   * (#1020). Absent for local runs and for hosts that did not negotiate one.
   */
  durableHost?: string;
}

/** Internal observation only: never added to mesh_events or run logs. */
export interface ActorLifecyclePromptEvent extends ActorLifecycleRunEvent {
  prompt: string;
  /**
   * The prompt's durably reserved retention key on a run bound to its host
   * (#1020). The host sends it onward only when it falls back to full text.
   */
  attempt?: number;
}

export interface ActorLifecycleErrorEvent extends ActorLifecycleRunEvent {
  error: unknown;
}

/**
 * `host-unavailable` and `termination-unresolved` are leader-side only
 * (#1020): the leader released its claim on a receipt-backed remote run
 * without observed termination, because the host went away or reported a
 * result whose provider exit nobody observed. Its outcome is unknown, not
 * failed; only the host's durable receipt records a terminal.
 */
export type ActorLifecycleAbandonmentReason =
  | "start-cancelled"
  | "coalesced"
  | "unreported"
  | "host-unavailable"
  | "termination-unresolved";

export type ActorLifecycleTerminal =
  | { kind: "result"; result: RunResult }
  | {
      kind: "abandoned";
      reason: ActorLifecycleAbandonmentReason;
      started: boolean;
      /**
       * Termination evidence from the provider call this run settled, if it
       * settled one (#1119). Absent means nothing observed a provider end.
       */
      termination?: RunTermination;
      /**
       * Set by the leader when this releases a receipt-backed remote run's
       * claim with its termination unresolved (#1119 ruling): both durable
       * rows stay open for the host's receipt, and `cause` is diagnosis,
       * never an outcome. `tokenUsage` is what the provider reported before
       * that unproven end: consumption so far, not final usage.
       */
      unresolved?: { cause: string; tokenUsage?: RunTokenUsage };
    };

export interface ActorLifecycleEndEvent extends ActorLifecycleRunEvent {
  /** Every queued run has exactly one terminal event, including an abandonment. */
  terminal: ActorLifecycleTerminal;
}

export type ActorLifecycleEventName = keyof ActorLifecycleListener;

export interface ActorLifecycleListenerFailure {
  event: ActorLifecycleEventName;
  listener: ActorLifecycleListener;
  error: unknown;
  actorId?: string;
  runId?: string;
}

type ActorLifecycleEvent =
  | ActorLifecycleActorEvent
  | ActorLifecycleQueuedEvent
  | ActorLifecycleStartEvent
  | ActorLifecyclePromptEvent
  | ActorLifecycleErrorEvent
  | ActorLifecycleEndEvent;

/**
 * Ordered lifecycle fanout. Listener failures are observation failures: they
 * are reported and cannot prevent later observers or change actor execution.
 */
export class ActorLifecycle {
  private readonly listeners: ActorLifecycleListener[];

  constructor(
    listeners: readonly ActorLifecycleListener[] = [],
    private readonly onListenerError: (failure: ActorLifecycleListenerFailure) => void = () => {}
  ) {
    this.listeners = [...listeners];
  }

  /** Add an observer at the end of the explicit registration order. */
  add(listener: ActorLifecycleListener): void {
    this.listeners.push(listener);
  }

  emit<K extends ActorLifecycleEventName>(
    event: K,
    payload: Parameters<NonNullable<ActorLifecycleListener[K]>>[0]
  ): void | Promise<void> {
    for (let i = 0; i < this.listeners.length; i++) {
      const listener = this.listeners[i];
      if (!listener) continue;
      const handler = listener[event];
      if (!handler) continue;
      try {
        const result = (handler as (value: ActorLifecycleEvent) => void | Promise<void>).call(
          listener,
          payload as ActorLifecycleEvent
        );
        if (result && typeof (result as Promise<void>).then === "function") {
          return (async () => {
            try {
              await result;
            } catch (error) {
              this.reportListenerError(event, listener, payload, error);
            }
            for (let j = i + 1; j < this.listeners.length; j++) {
              const remainingListener = this.listeners[j];
              if (!remainingListener) continue;
              const remainingHandler = remainingListener[event];
              if (!remainingHandler) continue;
              try {
                await (
                  remainingHandler as (value: ActorLifecycleEvent) => void | Promise<void>
                ).call(remainingListener, payload as ActorLifecycleEvent);
              } catch (error) {
                this.reportListenerError(event, remainingListener, payload, error);
              }
            }
          })();
        }
      } catch (error) {
        this.reportListenerError(event, listener, payload, error);
      }
    }
  }

  private reportListenerError(
    event: ActorLifecycleEventName,
    listener: ActorLifecycleListener,
    payload: unknown,
    error: unknown
  ): void {
    try {
      const eventPayload = payload as Partial<ActorLifecycleRunEvent> | undefined;
      this.onListenerError({
        event,
        listener,
        error,
        actorId: eventPayload?.actorId,
        runId: eventPayload?.runId,
      });
    } catch {
      // Reporting must not turn a failed observer into an actor failure.
    }
  }
}

export function createActorLifecycle(
  listeners: readonly ActorLifecycleListener[] = [],
  onListenerError?: (failure: ActorLifecycleListenerFailure) => void
): ActorLifecycle {
  return new ActorLifecycle(listeners, onListenerError);
}
