import type { Logger } from "./logger.js";

/**
 * Where an actor's raw model output goes.
 *
 * This is the one place raw agent prose and structured application diagnostics
 * meet, and they are kept apart on purpose: the application logger describes
 * what the mesh *did*, while these sinks carry what an actor *said*. Naming each
 * sink turns what used to be an anonymous inline closure into a list that can be
 * added to, removed from, and tested — a destination is now a reviewed decision
 * rather than a line buried in a 3000-line boot function.
 *
 * The service's own stdout is deliberately not on that list. Actor prose is
 * attacker-shaped text as far as the log is concerned: an actor that prints a
 * source file containing a mesh log string, or that runs `journalctl` and echoes
 * the result, injects lines indistinguishable from records the service wrote
 * itself — prefix included, so a tighter grep does not help. Once the mirror is
 * gone, `journalctl -u rusa` is sound as an observation plane by construction,
 * and the prose keeps both of the durable homes it already had.
 */

/** One chunk of streamed model output from a running actor. */
export interface ActorOutputChunk {
  actorId: string;
  text: string;
}

/** A named destination for actor output. */
export interface ActorOutputSink {
  /** Stable identifier, used in the diagnostic when this sink throws. */
  name: string;
  deliver: (chunk: ActorOutputChunk) => void;
}

/**
 * Fan one chunk out to every sink.
 *
 * Delivery runs inside the provider's synchronous `onChunk` callback, so a sink
 * that throws — a disconnected browser tab, a closed stream — must not reach
 * back into the run. The throw is contained and recorded at `debug`: the
 * recovery is genuinely routine, and the control flow is unchanged from when
 * this was an empty `catch`. It is simply no longer invisible.
 */
export function composeActorOutputSinks(
  sinks: readonly ActorOutputSink[],
  logger: Logger
): (chunk: ActorOutputChunk) => void {
  return (chunk) => {
    for (const sink of sinks) {
      try {
        sink.deliver(chunk);
      } catch (err) {
        logger.debug("actor_output_sink_failed", {
          sink: sink.name,
          actorId: chunk.actorId,
          bytes: chunk.text.length,
          err,
        });
      }
    }
  };
}

/**
 * The reviewed list of destinations actor output reaches.
 *
 * Two homes, both of which outlive the chunk: the dashboard's live-output SSE
 * fan-out (which `rusa logs --actor <id>` also follows, so a terminal tail and a
 * browser tab read the same bytes), and the run transcript recorded at `run_end`
 * in `mesh_events`. The transcript is written by the run boundary rather than by
 * a sink here, so it is not in this list — but it is the reason removing the
 * stdout mirror loses nothing.
 */
export function actorOutputSinks(deps: {
  emitLiveOutput: (chunk: ActorOutputChunk) => void;
}): ActorOutputSink[] {
  return [{ name: "dashboard-live-output", deliver: deps.emitLiveOutput }];
}
