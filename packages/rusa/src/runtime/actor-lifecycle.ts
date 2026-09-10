import type { RunResult } from "../providers/types.js";

/**
 * The actor lifecycle, as a small closed set of events.
 *
 * This replaces the earlier `ActorTerminalLifecycle` bag of named hooks, which
 * review on #380 correctly called out as over-indexed on one implementation of
 * "what happens at the end of a run" — it accepted `logRunEnd` and
 * `recordRunEnd` as two identically shaped callbacks purely because
 * `commands/start.ts` happens to call a logger and a repository in that order.
 *
 * Here there is one `onEnd` event and many listeners. Logging, run accounting,
 * mesh event recording, portable-context compaction, and failure routing are
 * all just listeners, and none of them is named in this interface.
 *
 * The run id is minted by the run owner and carried on the event, rather than
 * returned by one privileged listener. That is the change that lets logging and
 * persistence become peers: today `commands/start.ts` derives the run id from
 * `completeActorRun(...)` and feeds it to `logRunEnd(...)`, so adopting this
 * shape means run accounting accepts an externally minted id instead of
 * choosing one. Flagged as a real (small) change to the accounting seam.
 *
 * Deliberately no `after*` variants: ordering is listener registration order,
 * which composition already controls.
 */
export interface ActorLifecycleListener {
  /** An actor record came into existence. Emitted by the mesh, not by a run. */
  onSpawn?(event: ActorEvent): void | Promise<void>;
  /** Work is pending for this actor and a run is waiting on admission. */
  onQueued?(event: ActorEvent): void | Promise<void>;
  /** A run was admitted and is about to execute. */
  onStart?(event: RunEvent): void | Promise<void>;
  /** A run threw rather than producing a result. */
  onError?(event: RunErrorEvent): void | Promise<void>;
  /** A run produced a result, successful or not. */
  onEnd?(event: RunEndEvent): void | Promise<void>;
  /** An actor record was retired. Emitted by the mesh, not by a run. */
  onRetire?(event: ActorEvent): void | Promise<void>;
}

export interface ActorEvent {
  actorId: string;
}

export interface RunEvent extends ActorEvent {
  runId: string;
}

export interface RunEndEvent extends RunEvent {
  result: RunResult;
}

export interface RunErrorEvent extends RunEvent {
  error: unknown;
}

/**
 * Fans one event out to every listener in registration order, awaiting each.
 *
 * A listener that throws is reported and skipped: lifecycle notification is
 * observation, and one observer must not be able to take down a run or starve
 * the observers registered behind it.
 */
export async function emitLifecycle<K extends keyof ActorLifecycleListener>(
  listeners: readonly ActorLifecycleListener[],
  event: K,
  payload: Parameters<NonNullable<ActorLifecycleListener[K]>>[0],
  onListenerError: (error: unknown) => void = () => {}
): Promise<void> {
  for (const listener of listeners) {
    const handler = listener[event];
    if (!handler) continue;
    try {
      await (handler as (arg: typeof payload) => void | Promise<void>).call(listener, payload);
    } catch (error) {
      onListenerError(error);
    }
  }
}
