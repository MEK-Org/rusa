import { EventEmitter } from "node:events";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";

/**
 * A chunk of an actor's streamed model output, broadcast live to the dashboard.
 * `actorId` is the producing actor; `text` is the raw stdout/stderr chunk from
 * the provider's firehose (`Actor.log`).
 */
export interface LiveOutputChunk {
  actorId: string;
  text: string;
}

/** The channels the dashboard SSE stream multiplexes. */
export interface MeshEventEmitterEvents {
  /** A freshly-recorded mesh event (topology, messages, run lifecycle). */
  mesh_event: [MeshEvent];
  /** A live model-output chunk from a running actor. */
  live_output: [LiveOutputChunk];
}

/**
 * A small, typed pub/sub hub bridging the in-process actor mesh to any connected
 * dashboard SSE clients. The mesh process owns one instance: the `meshEvents`
 * sink broadcasts every recorded event on `mesh_event`, and each actor's `log`
 * firehose broadcasts its chunks on `live_output`. The SSE endpoint subscribes
 * and relays frames to browsers (with a bounded circular buffer for initial context);
 * a slow client only ever misses live frames (it can re-fetch history via the JSON endpoints).
 *
 * Listener count is unbounded by design — one SSE connection adds two listeners
 * (one per channel) and removes them on disconnect, so we disable the default
 * max-listeners warning rather than leak a cap into normal operation.
 */
export class MeshEventEmitter {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Each connected dashboard tab registers a pair of listeners; the count
    // tracks live viewers, not a leak, so the 10-listener warning is noise.
    this.emitter.setMaxListeners(0);
  }

  emitMeshEvent(event: MeshEvent): void {
    this.emitter.emit("mesh_event", event);
  }

  emitLiveOutput(chunk: LiveOutputChunk): void {
    this.emitter.emit("live_output", chunk);
  }

  onMeshEvent(listener: (event: MeshEvent) => void): () => void {
    this.emitter.on("mesh_event", listener);
    return () => this.emitter.off("mesh_event", listener);
  }

  onLiveOutput(listener: (chunk: LiveOutputChunk) => void): () => void {
    this.emitter.on("live_output", listener);
    return () => this.emitter.off("live_output", listener);
  }

  /** Current number of SSE subscribers (max across the two channels). */
  listenerCount(): number {
    return Math.max(
      this.emitter.listenerCount("mesh_event"),
      this.emitter.listenerCount("live_output")
    );
  }
}
