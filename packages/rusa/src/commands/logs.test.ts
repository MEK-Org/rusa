import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MeshEventEmitter } from "../dashboard/mesh-event-emitter.js";
import { SseHub } from "../dashboard/sse.js";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import {
  ActorStreamUnavailable,
  actorStreamUrl,
  followActorOutput,
  frameLiveOutput,
  splitSseFrames,
} from "./logs.js";

/**
 * `rusa logs --actor <id>` exists because the service log no longer carries
 * actor prose. Two properties make it a real replacement: the terminal tail
 * carries the actor's words and nothing else (so it can be piped), and those
 * words are the same bytes a dashboard tab is reading off the same stream.
 */

describe("actorStreamUrl", () => {
  it("adds the actor filter to the shared loopback-resolved dashboard URL", () => {
    expect(actorStreamUrl("http://127.0.0.1:8080", "worker-7")).toBe(
      "http://127.0.0.1:8080/api/mesh/stream?actors=worker-7"
    );
  });

  it("keeps the base URL and escapes the actor id", () => {
    expect(actorStreamUrl("http://[fd00::1]:9090", "a b/c")).toBe(
      "http://[fd00::1]:9090/api/mesh/stream?actors=a%20b%2Fc"
    );
  });
});

describe("SSE frame reading", () => {
  it("holds back a partial frame until the rest of it arrives", () => {
    const first = splitSseFrames('event: live_output\ndata: {"actorId":"a","text":"hi');
    expect(first.frames).toEqual([]);

    const second = splitSseFrames(`${first.rest}"}\n\n: heartbeat\n\n`);
    expect(second.frames).toEqual([
      'event: live_output\ndata: {"actorId":"a","text":"hi"}',
      ": heartbeat",
    ]);
    expect(second.rest).toBe("");
  });

  it("reads the actor's words out of a live_output frame", () => {
    expect(frameLiveOutput('event: live_output\ndata: {"actorId":"a","text":"thinking"}')).toEqual({
      actorId: "a",
      text: "thinking",
    });
  });

  it("treats every other frame as not-prose", () => {
    expect(frameLiveOutput(": heartbeat")).toBeNull();
    expect(frameLiveOutput('event: mesh_event\ndata: {"kind":"run_start"}')).toBeNull();
    expect(frameLiveOutput('event: elided\ndata: {"dropped":true}')).toBeNull();
    expect(frameLiveOutput("event: live_output\ndata: not json")).toBeNull();
  });
});

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The dashboard's own view: raw SSE frames off the same endpoint. */
async function readDashboardFrames(url: string, signal: AbortSignal): Promise<string[]> {
  const frames: string[] = [];
  const response = await fetch(url, { signal });
  const body = response.body as unknown as AsyncIterable<Uint8Array>;
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const bytes of body) {
        buffer += decoder.decode(bytes, { stream: true });
        const split = splitSseFrames(buffer);
        buffer = split.rest;
        frames.push(...split.frames);
      }
    } catch {
      // The abort at the end of the test tears the socket down; nothing to do.
    }
  })();
  return frames;
}

describe("followActorOutput", () => {
  let server: Server | undefined;
  let hub: SseHub | undefined;

  afterEach(async () => {
    hub?.close();
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    hub = undefined;
  });

  it("prints the actor's prose and nothing the dashboard treats as chrome", async () => {
    const emitter = new MeshEventEmitter();
    hub = new SseHub(emitter);
    const liveHub = hub;
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const actors = (url.searchParams.get("actors") ?? "").split(",").filter(Boolean);
      liveHub.addConnection(res, actors.length > 0 ? new Set(actors) : null);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const url = actorStreamUrl(`http://127.0.0.1:${port}`, "worker-7");

    const controller = new AbortController();
    const printed: string[] = [];
    const notices: string[] = [];
    const dashboardFrames = await readDashboardFrames(url, controller.signal);
    const following = followActorOutput({
      url,
      actorId: "worker-7",
      write: (text) => printed.push(text),
      notify: (text) => notices.push(text),
      signal: controller.signal,
    }).catch(() => {
      // Aborting is how this tail ends; the rejection is the Ctrl-C.
    });
    await waitFor(() => liveHub.connectionCount === 2, "both stream clients to connect");

    // An actor that prints something shaped like a service record: this is the
    // text that used to reach journald and forge a mesh line.
    emitter.emitLiveOutput({ actorId: "worker-7", text: "[mesh] not a mesh line\n" });
    emitter.emitLiveOutput({ actorId: "worker-7", text: "second chunk" });
    emitter.emitLiveOutput({ actorId: "other-actor", text: "someone else's run" });
    emitter.emitMeshEvent({
      id: 1,
      kind: "run_start",
      actorId: "worker-7",
    } as unknown as MeshEvent);

    await waitFor(() => printed.join("").includes("second chunk"), "the actor's output");
    await waitFor(
      () => dashboardFrames.some((frame) => frame.includes("second chunk")),
      "the dashboard's frames"
    );
    controller.abort();
    await following;

    expect(printed.join("")).toBe("[mesh] not a mesh line\nsecond chunk");
    expect(notices).toEqual([]);
    // The tail carries prose only: no heartbeat comments, no mesh events, and
    // no other actor's run leaking into this one's.
    expect(printed.join("")).not.toContain("heartbeat");
    expect(printed.join("")).not.toContain("run_start");
    expect(printed.join("")).not.toContain("someone else's run");

    // Same bytes as the dashboard: what a browser tab renders off this stream
    // is exactly what the terminal printed.
    const dashboardProse = dashboardFrames
      .map((frame) => frameLiveOutput(frame))
      .filter((chunk) => chunk !== null)
      .map((chunk) => chunk.text)
      .join("");
    expect(dashboardProse).toBe(printed.join(""));
  });

  it("reports a graceful stream EOF after printing only the requested actor", async () => {
    // The endpoint filters by `actors`, so this frame should never arrive. The
    // command's contract is a single actor's prose, and a contract that only
    // holds while a remote filter is correct is not one a pipe can rely on.
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.write(
        'event: live_output\ndata: {"actorId":"other-actor","text":"someone else\'s run\\n"}\n\n'
      );
      res.write('event: live_output\ndata: {"actorId":"worker-7","text":"mine\\n"}\n\n');
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const printed: string[] = [];
    const notices: string[] = [];
    await followActorOutput({
      url: actorStreamUrl(`http://127.0.0.1:${port}`, "worker-7"),
      actorId: "worker-7",
      write: (text) => printed.push(text),
      notify: (text) => notices.push(text),
    });

    expect(printed.join("")).toBe("mine\n");
    expect(notices).toEqual(["[rusa] actor output stream ended.\n"]);
  });

  it("ends the follow when the service drops the stream, rather than crashing", async () => {
    let live: import("node:http").ServerResponse | undefined;
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.write(": connected\n\n");
      res.write('event: live_output\ndata: {"actorId":"worker-7","text":"one line\\n"}\n\n');
      live = res;
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const printed: string[] = [];
    const notices: string[] = [];
    const following = followActorOutput({
      url: actorStreamUrl(`http://127.0.0.1:${port}`, "worker-7"),
      write: (text) => printed.push(text),
      notify: (text) => notices.push(text),
    });
    await waitFor(() => printed.length > 0, "the first chunk");
    live?.destroy();

    await expect(following).resolves.toBeUndefined();
    expect(printed.join("")).toBe("one line\n");
    expect(notices.join("")).toContain("stream ended");
  });

  it("says the service is unreachable rather than raising a transport stack trace", async () => {
    // A closed port is what a stopped service looks like from here. `fetch`
    // rejects before any response exists, so this is a different path from the
    // HTTP-status check below — and the one an operator hits most often.
    const idle = createServer(() => {});
    await new Promise<void>((resolve) => idle.listen(0, "127.0.0.1", resolve));
    const port = (idle.address() as AddressInfo).port;
    await new Promise<void>((resolve) => idle.close(() => resolve()));

    await expect(
      followActorOutput({
        url: actorStreamUrl(`http://127.0.0.1:${port}`, "worker-7"),
        write: () => {},
      })
    ).rejects.toThrow(ActorStreamUnavailable);
  });

  it("says so when the service is not serving the stream", async () => {
    server = createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("nope");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    await expect(
      followActorOutput({
        url: actorStreamUrl(`http://127.0.0.1:${port}`, "worker-7"),
        write: () => {},
      })
    ).rejects.toThrow(/HTTP 404/);
  });
});
