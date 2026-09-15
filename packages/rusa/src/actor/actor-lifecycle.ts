import type { RawProviderModelConfig } from "../providers/model-config.js";
import type { RunResult } from "../providers/types.js";
import type { InjectRecord } from "./portable-context.js";
import type { ActorRunMode } from "./trigger-runner.js";

/** The closed v1 observation contract for one actor and its runs. */
export interface ActorLifecycleListener {
  onSpawn?(event: ActorLifecycleActorEvent): void | Promise<void>;
  onQueued?(event: ActorLifecycleQueuedEvent): void | Promise<void>;
  onStart?(event: ActorLifecycleStartEvent): void | Promise<void>;
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
}

export interface ActorLifecycleErrorEvent extends ActorLifecycleRunEvent {
  error: unknown;
}

export type ActorLifecycleTerminal =
  | { kind: "result"; result: RunResult }
  | { kind: "abandoned"; reason: string; started: boolean };

export interface ActorLifecycleEndEvent extends ActorLifecycleRunEvent {
  /** Every queued run has exactly one terminal event, including an abandonment. */
  terminal: ActorLifecycleTerminal;
}

export type ActorLifecycleEventName = keyof ActorLifecycleListener;

export interface ActorLifecycleListenerFailure {
  event: ActorLifecycleEventName;
  listener: ActorLifecycleListener;
  error: unknown;
}

type ActorLifecycleEvent =
  | ActorLifecycleActorEvent
  | ActorLifecycleQueuedEvent
  | ActorLifecycleStartEvent
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

  async emit<K extends ActorLifecycleEventName>(
    event: K,
    payload: Parameters<NonNullable<ActorLifecycleListener[K]>>[0]
  ): Promise<void> {
    for (const listener of this.listeners) {
      const handler = listener[event];
      if (!handler) continue;
      try {
        await (handler as (value: ActorLifecycleEvent) => void | Promise<void>).call(
          listener,
          payload as ActorLifecycleEvent
        );
      } catch (error) {
        try {
          this.onListenerError({ event, listener, error });
        } catch {
          // Reporting must not turn a failed observer into an actor failure.
        }
      }
    }
  }
}

export function createActorLifecycle(
  listeners: readonly ActorLifecycleListener[] = [],
  onListenerError?: (failure: ActorLifecycleListenerFailure) => void
): ActorLifecycle {
  return new ActorLifecycle(listeners, onListenerError);
}
