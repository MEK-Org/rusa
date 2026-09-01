import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { ActorRuntimeStateDelta } from "../actor/actor-mesh.js";
import { MeshEventEmitter } from "./mesh-event-emitter.js";
import { LiveOutputBuffer, SseHub } from "./sse.js";

class MockReq extends EventEmitter {}

/**
 * A minimal ServerResponse double. `flowing` models TCP backpressure: when
 * false, `write` returns false (the socket is full) and the hub must stop
 * writing until a `drain` event.
 */
class MockRes extends EventEmitter {
  req = new MockReq();
  writes: string[] = [];
  statusCode = 0;
  headers: Record<string, string> = {};
  ended = false;
  flowing = true;
  throwOnWrite = false;

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers ?? {};
    return this;
  }

  write(chunk: string): boolean {
    if (this.throwOnWrite) throw new Error("socket gone");
    this.writes.push(chunk);
    return this.flowing;
  }

  end(): this {
    this.ended = true;
    return this;
  }

  /** Non-comment data frames (drops `:` heartbeat/elision/connected comments). */
  dataFrames(): string[] {
    return this.writes.filter((w) => w.startsWith("event:"));
  }

  drain(): void {
    this.flowing = true;
    this.emit("drain");
  }
}

function connect(hub: SseHub, actors: string[] | null): MockRes {
  const res = new MockRes();
  hub.addConnection(res as unknown as ServerResponse, actors ? new Set(actors) : null);
  return res;
}

describe("LiveOutputBuffer", () => {
  it("buffers chunks per actor and drops oldest when capacity exceeded", () => {
    const buf = new LiveOutputBuffer({ maxChunksPerActor: 3 });
    buf.push({ actorId: "a", text: "1" });
    buf.push({ actorId: "a", text: "2" });
    buf.push({ actorId: "a", text: "3" });
    buf.push({ actorId: "a", text: "4" });

    expect(buf.getForActors(new Set(["a"]))).toEqual([
      { actorId: "a", text: "2" },
      { actorId: "a", text: "3" },
      { actorId: "a", text: "4" },
    ]);
  });

  it("isolates buffers per actor", () => {
    const buf = new LiveOutputBuffer({ maxChunksPerActor: 2 });
    buf.push({ actorId: "a", text: "a1" });
    buf.push({ actorId: "b", text: "b1" });
    buf.push({ actorId: "b", text: "b2" });
    buf.push({ actorId: "b", text: "b3" });

    expect(buf.getForActors(new Set(["a"]))).toEqual([{ actorId: "a", text: "a1" }]);
    expect(buf.getForActors(new Set(["b"]))).toEqual([
      { actorId: "b", text: "b2" },
      { actorId: "b", text: "b3" },
    ]);
  });

  it("replays multi-actor chunks in strict chronological order", () => {
    const buf = new LiveOutputBuffer({ maxChunksPerActor: 10 });
    buf.push({ actorId: "a", text: "msg1" });
    buf.push({ actorId: "b", text: "msg2" });
    buf.push({ actorId: "a", text: "msg3" });
    buf.push({ actorId: "b", text: "msg4" });

    expect(buf.getForActors(new Set(["a", "b"]))).toEqual([
      { actorId: "a", text: "msg1" },
      { actorId: "b", text: "msg2" },
      { actorId: "a", text: "msg3" },
      { actorId: "b", text: "msg4" },
    ]);
  });

  it("clears all buffers", () => {
    const buf = new LiveOutputBuffer();
    buf.push({ actorId: "a", text: "test" });
    buf.clear();
    expect(buf.getForActors(new Set(["a"]))).toEqual([]);
  });
});

describe("SseHub", () => {
  it("writes SSE headers and an opening comment on connect", () => {
    const hub = new SseHub(new MeshEventEmitter());
    const res = connect(hub, ["a"]);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/event-stream");
    expect(res.headers["X-Accel-Buffering"]).toBe("no");
    expect(res.writes[0]).toBe(": connected\n\n");
    hub.close();
  });

  it("writes runtime hello before registering the client and then relays sequenced deltas", () => {
    let listener: ((delta: ActorRuntimeStateDelta) => void) | undefined;
    const runtimeState = {
      runtimeStateSnapshot: () => ({
        streamId: "epoch-a",
        revision: 4,
        states: new Map(),
      }),
      onRuntimeStateDelta: (next: typeof listener) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    const hub = new SseHub(new MeshEventEmitter(), { runtimeState });
    const res = connect(hub, ["a"]);

    expect(res.dataFrames()[0]).toBe('event: hello\ndata: {"streamId":"epoch-a"}\n\n');
    listener?.({ streamId: "epoch-a", revision: 5, actorId: "a", runState: "running" });
    expect(res.dataFrames()[1]).toContain("event: actor_runtime_state");
    expect(res.dataFrames()[1]).toContain('"revision":5');
    hub.close();
  });

  it("delivers mesh_event to every client regardless of actor filter", () => {
    const emitter = new MeshEventEmitter();
    const hub = new SseHub(emitter);
    const viewingA = connect(hub, ["a"]);
    const viewingNothing = connect(hub, null);

    emitter.emitMeshEvent({
      id: "e1",
      ts: "t",
      kind: "run_start",
      actorId: "z",
      detail: null,
      body: null,
      payload: null,
      success: null,
    });

    expect(viewingA.dataFrames()).toHaveLength(1);
    expect(viewingNothing.dataFrames()).toHaveLength(1);
    expect(viewingA.dataFrames()[0]).toContain("event: mesh_event");
    hub.close();
  });

  it("delivers live_output only to clients viewing that actor", () => {
    const emitter = new MeshEventEmitter();
    const hub = new SseHub(emitter);
    const viewingA = connect(hub, ["a"]);
    const viewingB = connect(hub, ["b"]);

    emitter.emitLiveOutput({ actorId: "a", text: "hello" });

    expect(viewingA.dataFrames()).toHaveLength(1);
    expect(viewingA.dataFrames()[0]).toContain("event: live_output");
    expect(viewingB.dataFrames()).toHaveLength(0);
    hub.close();
  });

  it("replays buffered output to newly connected clients viewing that actor", () => {
    const emitter = new MeshEventEmitter();
    const hub = new SseHub(emitter);

    // Emit live output before any client connects
    emitter.emitLiveOutput({ actorId: "a", text: "chunk 1" });
    emitter.emitLiveOutput({ actorId: "a", text: "chunk 2" });
    emitter.emitLiveOutput({ actorId: "b", text: "chunk b" });

    // Client connects viewing actor "a"
    const clientA = connect(hub, ["a"]);
    expect(clientA.dataFrames()).toHaveLength(2);
    expect(clientA.dataFrames()[0]).toContain("chunk 1");
    expect(clientA.dataFrames()[1]).toContain("chunk 2");

    // Client connects viewing actor "b"
    const clientB = connect(hub, ["b"]);
    expect(clientB.dataFrames()).toHaveLength(1);
    expect(clientB.dataFrames()[0]).toContain("chunk b");

    // Subsequent live chunk is delivered to connected client
    emitter.emitLiveOutput({ actorId: "a", text: "chunk 3" });
    expect(clientA.dataFrames()).toHaveLength(3);
    expect(clientA.dataFrames()[2]).toContain("chunk 3");
    expect(clientB.dataFrames()).toHaveLength(1);

    hub.close();
  });

  it("replays multi-actor buffered output in chronological order to new clients", () => {
    const emitter = new MeshEventEmitter();
    const hub = new SseHub(emitter);

    emitter.emitLiveOutput({ actorId: "a", text: "a1" });
    emitter.emitLiveOutput({ actorId: "b", text: "b1" });
    emitter.emitLiveOutput({ actorId: "a", text: "a2" });

    const clientAB = connect(hub, ["a", "b"]);
    expect(clientAB.dataFrames()).toHaveLength(3);
    expect(clientAB.dataFrames()[0]).toContain("a1");
    expect(clientAB.dataFrames()[1]).toContain("b1");
    expect(clientAB.dataFrames()[2]).toContain("a2");

    hub.close();
  });

  it("respects maxChunksPerActor when replaying history", () => {
    const emitter = new MeshEventEmitter();
    const hub = new SseHub(emitter, { maxChunksPerActor: 2 });

    for (let i = 0; i < 5; i++) {
      emitter.emitLiveOutput({ actorId: "a", text: `c${i}` });
    }

    const clientA = connect(hub, ["a"]);
    expect(clientA.dataFrames()).toHaveLength(2);
    expect(clientA.dataFrames()[0]).toContain("c3");
    expect(clientA.dataFrames()[1]).toContain("c4");

    hub.close();
  });

  it("respects backpressure and drops oldest queued frames, marking the gap", () => {
    const emitter = new MeshEventEmitter();
    const hub = new SseHub(emitter, { maxQueuePerClient: 2 });
    const res = connect(hub, ["a"]);
    res.writes.length = 0; // ignore the opening comment

    // Socket is now full: the first write returns false (still delivered), the
    // rest queue into a cap-2 ring buffer, dropping the oldest.
    res.flowing = false;
    for (let i = 0; i < 5; i++) emitter.emitLiveOutput({ actorId: "a", text: `c${i}` });

    // Only the first frame (c0) actually hit the socket before pausing.
    expect(res.dataFrames()).toHaveLength(1);
    expect(res.dataFrames()[0]).toContain("c0");

    // On drain, the queued tail flushes — oldest dropped, newest kept, with an
    // elision marker for the gap.
    res.drain();
    const texts = res.dataFrames().map((f) => f);
    expect(texts.some((f) => f.includes("c3"))).toBe(true);
    expect(texts.some((f) => f.includes("c4"))).toBe(true);
    expect(texts.some((f) => f.includes("c1"))).toBe(false); // dropped
    // The gap marker is a *named* event (not a :comment), so EventSource sees it.
    expect(res.dataFrames().some((f) => f.startsWith("event: elided"))).toBe(true);
    hub.close();
  });

  it("isolates a dead client: a throwing write never breaks delivery to others", () => {
    const emitter = new MeshEventEmitter();
    const hub = new SseHub(emitter);
    const dead = connect(hub, ["a"]);
    const alive = connect(hub, ["a"]);
    dead.throwOnWrite = true;

    expect(() => emitter.emitLiveOutput({ actorId: "a", text: "x" })).not.toThrow();
    expect(alive.dataFrames()).toHaveLength(1);
    expect(dead.ended).toBe(true); // dead client was closed
    // ...and deterministically unregistered from the hub on the write-throw path
    // (no req close event needed), so it won't linger against the cap/heartbeat.
    expect(hub.connectionCount).toBe(1);
    hub.close();
  });

  it("tears down a client on req close and stops delivering", () => {
    const emitter = new MeshEventEmitter();
    const hub = new SseHub(emitter);
    const res = connect(hub, ["a"]);
    expect(hub.connectionCount).toBe(1);

    res.req.emit("close");
    expect(hub.connectionCount).toBe(0);

    emitter.emitLiveOutput({ actorId: "a", text: "after close" });
    expect(res.dataFrames()).toHaveLength(0);
    hub.close();
  });

  it("503s past the connection cap", () => {
    const hub = new SseHub(new MeshEventEmitter(), { maxClients: 1 });
    connect(hub, ["a"]);
    const rejected = connect(hub, ["a"]);
    expect(rejected.statusCode).toBe(503);
    hub.close();
  });
});
