import type { ServerResponse } from "node:http";
import type { ActorRuntimeStateDelta, ActorRuntimeStateSnapshot } from "../actor/actor-mesh.js";
import type { LiveOutputChunk, MeshEventEmitter } from "./mesh-event-emitter.js";

/**
 * Max frames we buffer per client once it stops draining. live_output is a tail
 * view, so dropping the oldest buffered frames under backpressure is acceptable
 * — far better than letting a paused browser tab grow an unbounded buffer inside
 * the live mesh process.
 */
const DEFAULT_MAX_QUEUE = 1000;
/** Heartbeat comment cadence; keeps proxies (tailscale serve) from idling us out. */
const HEARTBEAT_MS = 20_000;
/** Hard ceiling on simultaneous SSE connections. */
const DEFAULT_MAX_CLIENTS = 64;
/** Default maximum number of live_output chunks buffered per actor. */
export const DEFAULT_MAX_CHUNKS_PER_ACTOR = 500;

interface BufferedLiveOutputChunk extends LiveOutputChunk {
  seq: number;
}

export interface LiveOutputBufferOptions {
  /** Maximum number of chunks to preserve per actor (default: 500). */
  maxChunksPerActor?: number;
}

/**
 * Bounded per-actor circular buffer for recent live_output chunks.
 *
 * Each actor maintains a FIFO ring buffer of up to `maxChunksPerActor` chunks.
 * When a dashboard client connects and requests specific actors, the hub replays
 * their recent chunks in chronological order so the user sees run context even
 * if the actor is currently idle or waiting for input.
 */
export class LiveOutputBuffer {
  private readonly buffers = new Map<string, BufferedLiveOutputChunk[]>();
  private readonly maxChunks: number;
  private nextSeq = 0;

  constructor(opts: LiveOutputBufferOptions = {}) {
    this.maxChunks = opts.maxChunksPerActor ?? DEFAULT_MAX_CHUNKS_PER_ACTOR;
  }

  push(chunk: LiveOutputChunk): void {
    let buf = this.buffers.get(chunk.actorId);
    if (!buf) {
      buf = [];
      this.buffers.set(chunk.actorId, buf);
    }
    if (buf.length >= this.maxChunks) {
      buf.shift();
    }
    buf.push({ ...chunk, seq: this.nextSeq++ });
  }

  getForActors(actorIds: Set<string>): LiveOutputChunk[] {
    const chunks: BufferedLiveOutputChunk[] = [];
    for (const actorId of actorIds) {
      const buf = this.buffers.get(actorId);
      if (buf) {
        chunks.push(...buf);
      }
    }
    if (actorIds.size > 1) {
      chunks.sort((a, b) => a.seq - b.seq);
    }
    return chunks.map(({ actorId, text }) => ({ actorId, text }));
  }

  clear(): void {
    this.buffers.clear();
  }
}

/** Serialize a value as one SSE frame for the given event name. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Emitted after a drop-oldest gap so the browser can show elided live output. */
const ELIDED_FRAME = frame("elided", { dropped: true });

/**
 * One connected dashboard stream. Owns a bounded outbound queue and honors TCP
 * backpressure: while the socket is not draining we buffer (drop-oldest) instead
 * of calling `res.write` again, so a slow client can never balloon memory in the
 * actor runtime. Every write is best-effort; a dead socket silently closes the
 * client and never throws back into the caller (which may be an actor's
 * synchronous log callback).
 */
class SseClient {
  private readonly queue: string[] = [];
  private paused = false;
  private droppedSinceFlush = false;
  private closed = false;

  /**
   * `actors` filters the high-volume live_output channel to the actors this
   * client is viewing; `null` means no live_output (the client opened the stream
   * without selecting any). mesh_event is always delivered (low volume).
   *
   * `channel` separates the dashboard stream ("mesh": mesh_event + live_output)
   * from the walkie-talkie stream ("voice": reply-TTS announcements only, ISSUE_NUM)
   * — a voice client never receives mesh frames and vice versa.
   */
  constructor(
    private readonly res: ServerResponse,
    readonly actors: Set<string> | null,
    readonly channel: "mesh" | "voice",
    private readonly maxQueue = DEFAULT_MAX_QUEUE,
    /** Invoked exactly once when this client closes, so the hub can unregister
     * it deterministically even on the write-throw path (no req close event). */
    private readonly onClose?: () => void
  ) {}

  wantsLiveOutput(actorId: string): boolean {
    return this.actors?.has(actorId) ?? false;
  }

  send(text: string): void {
    if (this.closed) return;
    if (this.paused) {
      this.enqueue(text);
      return;
    }
    try {
      const ok = this.res.write(text);
      if (!ok) this.pauseUntilDrain();
    } catch {
      this.close();
    }
  }

  private enqueue(text: string): void {
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.droppedSinceFlush = true;
    }
    this.queue.push(text);
  }

  private pauseUntilDrain(): void {
    this.paused = true;
    this.res.once("drain", () => this.flush());
  }

  private flush(): void {
    if (this.closed) return;
    this.paused = false;
    if (this.droppedSinceFlush) {
      this.droppedSinceFlush = false;
      // A *named* event (not a `:`-comment, which EventSource silently drops) so
      // the browser can surface the gap in the live tail.
      this.queue.unshift(ELIDED_FRAME);
    }
    while (!this.paused && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === undefined) break;
      try {
        const ok = this.res.write(next);
        if (!ok) {
          this.pauseUntilDrain();
          return;
        }
      } catch {
        this.close();
        return;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    try {
      this.res.end();
    } catch {
      // already torn down
    }
    this.onClose?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export interface SseHubOptions {
  maxClients?: number;
  maxQueuePerClient?: number;
  maxChunksPerActor?: number;
  runtimeState?: {
    runtimeStateSnapshot(): ActorRuntimeStateSnapshot;
    onRuntimeStateDelta(listener: (delta: ActorRuntimeStateDelta) => void): () => void;
  };
}

/**
 * Fans the in-process {@link MeshEventEmitter} out to all connected SSE clients
 * with a single subscription per channel (not one listener per client). Owns the
 * client set, the heartbeat timer, per-client backpressure isolation, and a
 * bounded circular buffer of recent live_output chunks per actor.
 */
export class SseHub {
  private readonly clients = new Set<SseClient>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly liveBuffer: LiveOutputBuffer;
  private readonly runtimeState: SseHubOptions["runtimeState"];

  private readonly maxClients: number;
  private readonly maxQueuePerClient: number;

  constructor(
    private readonly emitter: MeshEventEmitter,
    opts: SseHubOptions = {}
  ) {
    this.maxClients = opts.maxClients ?? DEFAULT_MAX_CLIENTS;
    this.maxQueuePerClient = opts.maxQueuePerClient ?? DEFAULT_MAX_QUEUE;
    this.runtimeState = opts.runtimeState;
    this.liveBuffer = new LiveOutputBuffer({ maxChunksPerActor: opts.maxChunksPerActor });
    // One subscription per channel; fan out to the client set. Each per-client
    // write is isolated so one dead socket can't break the emit (which runs
    // synchronously inside an actor's log callback for live_output).
    this.unsubscribers.push(
      this.emitter.onMeshEvent((event) => {
        const text = frame("mesh_event", event);
        for (const client of this.clients) {
          if (client.channel !== "mesh") continue;
          try {
            client.send(text);
          } catch {
            this.remove(client);
          }
        }
      })
    );
    this.unsubscribers.push(
      this.emitter.onLiveOutput((chunk) => {
        this.liveBuffer.push(chunk);
        const text = frame("live_output", chunk);
        for (const client of this.clients) {
          if (client.channel !== "mesh") continue;
          if (!client.wantsLiveOutput(chunk.actorId)) continue;
          try {
            client.send(text);
          } catch {
            this.remove(client);
          }
        }
      })
    );
    if (opts.runtimeState) {
      this.unsubscribers.push(
        opts.runtimeState.onRuntimeStateDelta((delta) => {
          const text = frame("actor_runtime_state", delta);
          for (const client of this.clients) {
            if (client.channel !== "mesh") continue;
            try {
              client.send(text);
            } catch {
              this.remove(client);
            }
          }
        })
      );
    }
  }

  /** Number of live connections (for tests / a future stats line). */
  get connectionCount(): number {
    return this.clients.size;
  }

  /**
   * Attach a new SSE connection. Writes the SSE headers, registers the client,
   * and wires teardown on socket close/error/abort. Returns false (and 503s) if
   * the connection cap is reached.
   */
  addConnection(res: ServerResponse, actors: Set<string> | null): boolean {
    return this.attach(res, actors, "mesh");
  }

  /**
   * Attach a walkie-talkie `voice` subscription . Receives ONLY `voice`
   * frames (reply-TTS announcements) for the actors in its filter. A connected
   * voice subscription is the presence signal that walkie mode is active for
   * those actors; `onClose` fires exactly once on teardown so the caller can
   * start the presence grace window.
   */
  addVoiceConnection(res: ServerResponse, actors: Set<string>, onClose?: () => void): boolean {
    return this.attach(res, actors, "voice", onClose);
  }

  /** Push a reply-TTS announcement to every voice client watching its actor. */
  pushVoice(announcement: { actorId: string }): void {
    const text = frame("voice", announcement);
    for (const client of this.clients) {
      if (client.channel !== "voice") continue;
      if (!client.actors?.has(announcement.actorId)) continue;
      try {
        client.send(text);
      } catch {
        this.remove(client);
      }
    }
  }

  private attach(
    res: ServerResponse,
    actors: Set<string> | null,
    channel: "mesh" | "voice",
    onClose?: () => void
  ): boolean {
    if (this.clients.size >= this.maxClients) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Too many dashboard stream connections");
      return false;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Defeat proxy buffering (tailscale serve / nginx) so frames flush live.
      "X-Accel-Buffering": "no",
    });
    // An initial comment opens the stream immediately for the client.
    res.write(": connected\n\n");

    // The onClose callback makes unregistration deterministic even on the
    // write-throw path (where no req close/error event fires). `remove` is
    // idempotent, so the req handlers below remain a correct fallback.
    const client: SseClient = new SseClient(res, actors, channel, this.maxQueuePerClient, () => {
      this.remove(client);
      onClose?.();
    });
    if (channel === "mesh" && this.runtimeState) {
      client.send(frame("hello", { streamId: this.runtimeState.runtimeStateSnapshot().streamId }));
    }
    this.clients.add(client);
    this.ensureHeartbeat();

    // Replay recent live_output context for the requested actors so the client
    // sees prior run output even if the actor is currently idle/waiting.
    if (channel === "mesh" && actors && actors.size > 0) {
      const history = this.liveBuffer.getForActors(actors);
      for (const chunk of history) {
        client.send(frame("live_output", chunk));
      }
    }

    const req = res.req;
    const teardown = () => this.remove(client);
    req.on("close", teardown);
    req.on("error", teardown);
    req.on("aborted", teardown);
    return true;
  }

  private remove(client: SseClient): void {
    if (!this.clients.has(client)) return;
    this.clients.delete(client);
    client.close();
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.send(": heartbeat\n\n");
        } catch {
          this.remove(client);
        }
      }
    }, HEARTBEAT_MS);
    // Don't keep the process alive just for heartbeats.
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /** Tear down every connection and the emitter subscriptions. */
  close(): void {
    this.stopHeartbeat();
    for (const client of this.clients) client.close();
    this.clients.clear();
    this.liveBuffer.clear();
    for (const off of this.unsubscribers.splice(0)) off();
  }
}
