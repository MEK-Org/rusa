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
