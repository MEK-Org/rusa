import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ActorMesh } from "../actor/actor-mesh.js";
import { InMemoryThreadRegistry, type ThreadRecord } from "../actor/thread-registry.js";
import { MeshEventEmitter } from "../dashboard/mesh-event-emitter.js";
import { SseHub } from "../dashboard/sse.js";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import type { SpeechClient } from "./gemini-speech.js";
import { handleVoiceApiRequest, type VoiceApiDeps } from "./voice-api.js";
import { VOICE_MEMO_PREFIX, VoiceService } from "./voice-service.js";
import { attachVoiceOutbound } from "./wiring.js";

const UUID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const UUID_B = "bbbbbbbb-0000-4000-8000-000000000002";

class MockReq extends EventEmitter {
  method = "GET";
  headers: Record<string, string> = {};
  url = "";
}

class MockRes extends EventEmitter {
  req = new EventEmitter();
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  writes: Array<string | Buffer> = [];
  ended = false;

  headWritten = false;
  writeHead(status: number, headers?: Record<string, string>): this {
    if (this.headWritten) throw new Error("ERR_HTTP_HEADERS_SENT");
    this.headWritten = true;
    this.statusCode = status;
    this.headers = headers ?? {};
    return this;
  }
  write(chunk: string | Buffer): boolean {
    this.writes.push(chunk);
    return true;
  }
  end(body?: string): this {
    if (body) this.body += body;
    this.ended = true;
    return this;
  }
  /** Frames written on the SSE socket (SSE never calls end). */
  frames(): string[] {
    return this.writes.map(String).filter((w) => w.startsWith("event:"));
  }
}

function call(
  deps: VoiceApiDeps | null,
  method: string,
  path: string,
  opts: { body?: Buffer | string; contentType?: string } = {}
): { handled: boolean; res: MockRes; req: MockReq } {
  const req = new MockReq();
  req.method = method;
  req.url = path;
  if (opts.contentType) req.headers["content-type"] = opts.contentType;
  const res = new MockRes();
  const handled = handleVoiceApiRequest(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    new URL(path, "http://localhost"),
    deps
  );
  if (opts.body !== undefined) {
    process.nextTick(() => {
      if (opts.body?.length) req.emit("data", Buffer.from(opts.body));
      req.emit("end");
    });
  }
  return { handled, res, req };
}

/** Wait until the (async) route settles the mock response. */
async function settled(res: MockRes): Promise<void> {
  await vi.waitFor(() => expect(res.ended).toBe(true));
}

function rec(id: string, status: "active" | "retired"): ThreadRecord {
  return {
    id,
    charter: `charter ${id}`,
    parentId: null,
    status,
    createdAt: "2026-07-17T00:00:00.000Z",
  };
}

function replyEvent(overrides: Partial<MeshEvent> = {}): MeshEvent {
  return {
    id: "e1",
    ts: "t",
    kind: "message_sent",
    actorId: UUID_A,
    detail: "sess",
    body: "short reply",
    payload: JSON.stringify({ to: HUMAN_OPERATOR }),
    success: null,
    ...overrides,
  };
}

function fakeStreamSpeech(): SpeechClient {
  return {
    transcribe: async () => "",
    synthesize: async () => ({ pcm: Buffer.from([1, 2, 3, 4]), sampleRate: 24_000 }),
    streamSynthesize: async () => ({
      sampleRate: 24_000,
      pcmStream: (async function* () {
        yield Buffer.from("chunk1");
      })(),
    }),
  };
}

function makeStreamingService(home: string, startNow: number) {
  let now = startNow;
  const chunks: Buffer[] = [];
  const listeners = new Set<{ onData: (c: Buffer) => void; onEnd: () => void }>();

  const service = new VoiceService({
    home,
    speech: fakeStreamSpeech(),
    now: () => now,
    encodeStream: async (pcmStream, _rate, basePath) => {
      const path = `${basePath}.mp3`;
      (async () => {
        for await (const chunk of pcmStream) {
          const out = Buffer.from(`${chunk.toString()}-mp3`);
          chunks.push(out);
          for (const l of listeners) l.onData(out);
        }
        for (const l of listeners) l.onEnd();
      })();
      return {
        path,
        mime: "audio/mpeg",
        subscribe: (onData: (c: Buffer) => void, onEnd: () => void) => {
          for (const c of chunks) onData(c);
          listeners.add({ onData, onEnd });
          return true;
        },
      };
    },
  });

  return {
    service,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function findLatencyLog(calls: unknown[]): {
  level: string;
  latencyMs: number | null;
  latencySuspect?: boolean;
} | null {
  for (const call of calls) {
    const args = call as string[];
    const text = args[0];
    if (typeof text !== "string") continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed.msg === "First MP3 byte flushed to client") {
        return parsed;
      }
    } catch {
      // ignore non-JSON
    }
  }
  return null;
}

describe("handleVoiceApiRequest", () => {
  let home: string;
  let registry: InMemoryThreadRegistry;
  let service: VoiceService;
  let hub: SseHub;
  let emitter: MeshEventEmitter;
  let sendHumanMessage: ReturnType<typeof vi.fn>;
  let deps: VoiceApiDeps;
  let transcribe: Mock<(audio: Buffer, mimeType: string) => Promise<string>>;
  let now: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "voice-api-"));
    registry = new InMemoryThreadRegistry();
    registry.upsert(rec(UUID_A, "active"));
    registry.upsert(rec(UUID_B, "retired"));
    transcribe = vi.fn(async (_audio: Buffer, _mimeType: string) => "pick up milk on the way home");
    const speech: SpeechClient = {
      transcribe,
      synthesize: async () => ({ pcm: Buffer.from([1, 2, 3, 4]), sampleRate: 24_000 }),
      streamSynthesize: async () => ({
        sampleRate: 24_000,
        pcmStream: (async function* () {
          yield Buffer.from([1, 2, 3, 4]);
        })(),
      }),
    };
    now = 1_752_700_000_000;
    service = new VoiceService({
      home,
      speech,
      now: () => now,
      encode: async (pcm, _rate, basePath) => {
        const path = `${basePath}.mp3`;
        await writeFile(path, pcm);
        return { path, mime: "audio/mpeg" };
      },
      encodeStream: async (pcmStream, _rate, basePath) => {
        const path = `${basePath}.mp3`;
        const chunks: Buffer[] = [];
        for await (const chunk of pcmStream) chunks.push(chunk);
        await writeFile(path, Buffer.concat(chunks));
        return { path, mime: "audio/mpeg", subscribe: () => false };
      },
    });
    emitter = new MeshEventEmitter();
    hub = new SseHub(emitter);
    sendHumanMessage = vi.fn(() => ({ delivered: true }));
    deps = {
      registry,
      sseHub: hub,
      mesh: { sendHumanMessage } as unknown as ActorMesh,
      service,
    };
  });

  it("ignores non-voice paths (returns false)", () => {
    expect(call(deps, "GET", "/api/mesh/threads").handled).toBe(false);
    expect(call(deps, "POST", `/api/mesh/actors/${UUID_A}/chat`).handled).toBe(false);
  });

  it("503s every voice route when no mesh is bound", () => {
    const { handled, res } = call(null, "GET", `/api/mesh/actors/${UUID_A}/voice/backlog`);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
  });

  it("503s with a clear error when geminiApiKey is not configured", () => {
    const { res } = call(
      { ...deps, service: null },
      "POST",
      `/api/mesh/actors/${UUID_A}/voice-memo`
    );
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toContain("geminiApiKey");
  });

  describe("POST /api/mesh/actors/:id/voice-memo", () => {
    it("stores audio, transcribes, and delivers the marked transcript", async () => {
      const audio = Buffer.from("webm-bytes");
      const { res } = call(deps, "POST", `/api/mesh/actors/${UUID_A}/voice-memo?sessionId=sess-9`, {
        body: audio,
        contentType: "audio/webm",
      });
      await settled(res);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        ok: true,
        transcript: "pick up milk on the way home",
        delivered: true,
      });
      expect(sendHumanMessage).toHaveBeenCalledWith(
        UUID_A,
        `${VOICE_MEMO_PREFIX}pick up milk on the way home`,
        "sess-9"
      );
      expect(transcribe).toHaveBeenCalledWith(audio, "audio/webm");
      const inbox = readdirSync(join(home, "voice", "inbox"));
      expect(inbox).toHaveLength(1);
      expect(inbox[0].endsWith(".webm")).toBe(true);
    });

    it("defaults the sessionId to a random UUID when the query param is absent", async () => {
      const { res } = call(deps, "POST", `/api/mesh/actors/${UUID_A}/voice-memo`, {
        body: Buffer.from("x"),
        contentType: "audio/ogg",
      });
      await settled(res);
      expect(res.statusCode).toBe(200);
      const sessionId = sendHumanMessage.mock.calls[0][2];
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("reports delivered: false for a non-live actor (memo still transcribed)", async () => {
      sendHumanMessage.mockReturnValue({ delivered: false, status: "active" });
      const { res } = call(deps, "POST", `/api/mesh/actors/${UUID_A}/voice-memo`, {
        body: Buffer.from("x"),
        contentType: "audio/webm",
      });
      await settled(res);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ ok: true, delivered: false });
    });

    it("404s an unknown actor", () => {
      const { res } = call(deps, "POST", "/api/mesh/actors/does-not-exist/voice-memo");
      expect(res.statusCode).toBe(404);
    });

    it("400s a retired actor", () => {
      const { res } = call(deps, "POST", `/api/mesh/actors/${UUID_B}/voice-memo`);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "actor is retired", chatDisabled: true });
    });

    it("400s a non-audio content type", () => {
      const { res } = call(deps, "POST", `/api/mesh/actors/${UUID_A}/voice-memo`, {
        contentType: "application/json",
      });
      expect(res.statusCode).toBe(400);
    });

    it("400s an empty audio body", async () => {
      const { res } = call(deps, "POST", `/api/mesh/actors/${UUID_A}/voice-memo`, {
        body: Buffer.alloc(0),
        contentType: "audio/webm",
      });
      await settled(res);
      expect(res.statusCode).toBe(400);
      expect(sendHumanMessage).not.toHaveBeenCalled();
    });

    it("502s a transcription failure — with the audio already saved", async () => {
      transcribe.mockRejectedValue(new Error("model unavailable"));
      const { res } = call(deps, "POST", `/api/mesh/actors/${UUID_A}/voice-memo`, {
        body: Buffer.from("precious-audio"),
        contentType: "audio/webm",
      });
      await settled(res);

      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.body);
      expect(body.audioSaved).toBe(true);
      expect(body.error).toContain("model unavailable");
      expect(readdirSync(join(home, "voice", "inbox"))).toHaveLength(1);
      expect(sendHumanMessage).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/mesh/voice/stream (presence + push)", () => {
    it("400s without an actors filter", () => {
      const { res } = call(deps, "GET", "/api/mesh/voice/stream");
      expect(res.statusCode).toBe(400);
    });

    it("a connected subscription is presence; replies stream as voice frames", async () => {
      const detach = attachVoiceOutbound(emitter, service, hub);
      const { res } = call(deps, "GET", `/api/mesh/voice/stream?actors=${UUID_A}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Type"]).toContain("text/event-stream");
      expect(service.hasPresence(UUID_A)).toBe(true);

      emitter.emitMeshEvent(replyEvent());
      await vi.waitFor(() => expect(res.frames()).toHaveLength(1));
      const frame = res.frames()[0];
      expect(frame).toContain("event: voice");
      const payload = JSON.parse(frame.split("\ndata: ")[1]);
      expect(payload.actorId).toBe(UUID_A);
      expect(payload.text).toBe("short reply");
      expect(payload.mime).toBe("audio/mpeg");
      expect(payload.audioUrl).toBe(`/api/mesh/voice/audio/${payload.id}`);
      detach();
    });

    it("does not deliver frames for actors outside the filter", async () => {
      registry.upsert(rec("cccccccc-0000-4000-8000-000000000003", "active"));
      const detach = attachVoiceOutbound(emitter, service, hub);
      const { res } = call(deps, "GET", `/api/mesh/voice/stream?actors=${UUID_A}`);
      service.presenceConnect(["cccccccc-0000-4000-8000-000000000003"]);

      emitter.emitMeshEvent(replyEvent({ actorId: "cccccccc-0000-4000-8000-000000000003" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(res.frames()).toHaveLength(0);
      detach();
    });

    it("disconnect starts the grace window; replies still render into the backlog", async () => {
      const { res } = call(deps, "GET", `/api/mesh/voice/stream?actors=${UUID_A}`);
      expect(service.hasPresence(UUID_A)).toBe(true);
      res.req.emit("close");

      // Within grace: still present, reply renders (queued for reconnect).
      now += 60_000;
      expect(service.hasPresence(UUID_A)).toBe(true);
      expect(await service.handleMeshEvent(replyEvent())).not.toBeNull();
      expect(service.backlog(UUID_A)).toHaveLength(1);

      // Beyond grace: presence expired, nothing renders.
      now += 120_000;
      expect(service.hasPresence(UUID_A)).toBe(false);
      expect(await service.handleMeshEvent(replyEvent())).toBeNull();
    });

    it("keeps the voice channel off the dashboard stream and vice versa", async () => {
      const detach = attachVoiceOutbound(emitter, service, hub);
      const dashboard = new MockRes();
      hub.addConnection(dashboard as unknown as ServerResponse, new Set([UUID_A]));
      const { res: voice } = call(deps, "GET", `/api/mesh/voice/stream?actors=${UUID_A}`);

      emitter.emitMeshEvent(replyEvent());
      await vi.waitFor(() => expect(voice.frames()).toHaveLength(1));
      // The dashboard client got the mesh_event but never a voice frame...
      expect(dashboard.frames().some((f) => f.startsWith("event: voice"))).toBe(false);
      expect(dashboard.frames().some((f) => f.startsWith("event: mesh_event"))).toBe(true);
      // ...and the voice client never receives mesh frames.
      expect(voice.frames().some((f) => f.startsWith("event: mesh_event"))).toBe(false);
      detach();
    });
  });

  describe("audio / backlog / ack", () => {
    async function seedAnnouncement(body = "short reply") {
      service.presenceConnect([UUID_A]);
      const announcement = await service.handleMeshEvent(replyEvent({ body }));
      if (!announcement) throw new Error("seed failed");
      return announcement;
    }

    it("serves stored audio by announcement id with its mime", async () => {
      const announcement = await seedAnnouncement();
      const { res } = call(deps, "GET", `/api/mesh/voice/audio/${announcement.id}`);
      await settled(res);
      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Type"]).toBe("audio/mpeg");
      const served = Buffer.concat(
        res.writes.map((w) => (Buffer.isBuffer(w) ? w : Buffer.from(w)))
      );
      expect(served.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    });

    it("streams first MP3 chunk to response before full synthesis completes", async () => {
      let streamSynthesizeResolve: () => void;
      const firstChunkPromise = new Promise<void>((r) => (streamSynthesizeResolve = r));
      let yieldSecondChunk: (() => void) | undefined;
      const secondChunkPromise = new Promise<void>((r) => (yieldSecondChunk = r));

      const speech: SpeechClient = {
        transcribe: async () => "",
        synthesize: async () => ({ pcm: Buffer.from([]), sampleRate: 24_000 }),
        streamSynthesize: async () => {
          streamSynthesizeResolve();
          return {
            sampleRate: 24_000,
            pcmStream: (async function* () {
              yield Buffer.from("chunk1");
              await secondChunkPromise;
              yield Buffer.from("chunk2");
            })(),
          };
        },
      };

      const testService = new VoiceService({
        home,
        speech,
        now: () => now,
        encodeStream: async (pcmStream, _rate, basePath) => {
          const path = `${basePath}.mp3`;
          let mp3Chunks: Buffer[] | null = [];
          const listeners = new Set<{ onData: (c: Buffer) => void; onEnd: () => void }>();
          let isDone = false;

          (async () => {
            for await (const chunk of pcmStream) {
              const out = Buffer.from(`${chunk.toString()}-mp3`);
              if (mp3Chunks) mp3Chunks.push(out);
              for (const l of listeners) l.onData(out);
            }
            isDone = true;
            mp3Chunks = null;
            for (const l of listeners) l.onEnd();
          })();

          return {
            path,
            mime: "audio/mpeg",
            subscribe: (onData, onEnd) => {
              if (isDone) return false;
              for (const chunk of mp3Chunks || []) onData(chunk);
              listeners.add({ onData, onEnd });
              return true;
            },
          };
        },
      });

      deps.service = testService;

      testService.presenceConnect([UUID_A]);
      const announcementPromise = testService.handleMeshEvent(replyEvent({ body: "stream test" }));
      await firstChunkPromise;

      const announcement = await announcementPromise;
      expect(announcement).not.toBeNull();

      const logSpy = vi.fn();
      deps.log = logSpy;
      const { res } = call(deps, "GET", `/api/mesh/voice/audio/${announcement?.id}`);

      await vi.waitFor(() => expect(res.writes.length).toBeGreaterThan(0));
      expect(findLatencyLog(logSpy.mock.calls)).not.toBeNull();
      expect(res.writes[0].toString()).toContain("chunk1-mp3");
      expect(res.ended).toBe(false);

      yieldSecondChunk?.();
      await settled(res);
      expect(res.writes[1].toString()).toContain("chunk2-mp3");
      expect(res.ended).toBe(true);
    });

    it("measures first-byte latency from the stream request baseline", async () => {
      const { service: testService, advance } = makeStreamingService(home, 1_000);
      deps.service = testService;
      testService.presenceConnect([UUID_A]);

      const announcement = await testService.handleMeshEvent(replyEvent({ body: "latency test" }));
      expect(announcement).not.toBeNull();

      // Simulate time passing between the stream request and the first chunk flush.
      advance(5_678);

      const logSpy = vi.fn();
      deps.log = logSpy;
      const { res } = call(deps, "GET", `/api/mesh/voice/audio/${announcement?.id}`);
      await vi.waitFor(() => expect(res.writes.length).toBeGreaterThan(0));

      const log = findLatencyLog(logSpy.mock.calls);
      expect(log).not.toBeNull();
      expect(log?.latencyMs).toBe(5_678);
      expect(log?.level).toBe("info");
      expect(log?.latencySuspect).toBe(false);
    });

    it("warns with latencySuspect and null latencyMs when the request baseline is missing", async () => {
      const { service: testService, advance } = makeStreamingService(home, 1_000);
      deps.service = testService;
      testService.presenceConnect([UUID_A]);

      const announcement = await testService.handleMeshEvent(replyEvent({ body: "missing base" }));
      expect(announcement).not.toBeNull();
      (announcement as { streamRequestedAt?: number }).streamRequestedAt = undefined;

      advance(5_000);

      const logSpy = vi.fn();
      deps.log = logSpy;
      const { res } = call(deps, "GET", `/api/mesh/voice/audio/${announcement?.id}`);
      await vi.waitFor(() => expect(res.writes.length).toBeGreaterThan(0));

      const log = findLatencyLog(logSpy.mock.calls);
      expect(log).not.toBeNull();
      expect(log?.latencyMs).toBeNull();
      expect(log?.level).toBe("warn");
      expect(log?.latencySuspect).toBe(true);
    });

    it("warns with latencySuspect when first-byte latency exceeds 60 seconds", async () => {
      const { service: testService, advance } = makeStreamingService(home, 1_000);
      deps.service = testService;
      testService.presenceConnect([UUID_A]);

      const announcement = await testService.handleMeshEvent(replyEvent({ body: "slow flush" }));
      expect(announcement).not.toBeNull();

      advance(70_000);

      const logSpy = vi.fn();
      deps.log = logSpy;
      const { res } = call(deps, "GET", `/api/mesh/voice/audio/${announcement?.id}`);
      await vi.waitFor(() => expect(res.writes.length).toBeGreaterThan(0));

      const log = findLatencyLog(logSpy.mock.calls);
      expect(log).not.toBeNull();
      expect(log?.latencyMs).toBe(70_000);
      expect(log?.level).toBe("warn");
      expect(log?.latencySuspect).toBe(true);
    });

    it("re-fetch of the same announcement logs a latency tied to its own flush time", async () => {
      const { service: testService, advance } = makeStreamingService(home, 1_000);
      deps.service = testService;
      testService.presenceConnect([UUID_A]);

      const announcement = await testService.handleMeshEvent(replyEvent({ body: "re-fetch test" }));
      expect(announcement).not.toBeNull();

      const logSpy = vi.fn();
      deps.log = logSpy;

      // First fetch flushes at +5s.
      advance(5_000);
      const first = call(deps, "GET", `/api/mesh/voice/audio/${announcement?.id}`);
      await vi.waitFor(() => expect(first.res.writes.length).toBeGreaterThan(0));

      // Second fetch, 2s later, must get its own flush-time latency, not the first one.
      advance(2_000);
      const second = call(deps, "GET", `/api/mesh/voice/audio/${announcement?.id}`);
      await vi.waitFor(() => expect(second.res.writes.length).toBeGreaterThan(0));

      const logs = logSpy.mock.calls
        .map((call) => {
          try {
            const parsed = JSON.parse((call as string[])[0]);
            return parsed.msg === "First MP3 byte flushed to client" ? parsed : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      expect(logs).toHaveLength(2);
      expect(logs[0].latencyMs).toBe(5_000);
      expect(logs[1].latencyMs).toBe(7_000);
    });

    it("does not write to console.log when deps.log is omitted", async () => {
      const { service: testService, advance } = makeStreamingService(home, 1_000);
      deps.service = testService;
      delete deps.log;
      testService.presenceConnect([UUID_A]);

      const announcement = await testService.handleMeshEvent(replyEvent({ body: "silent test" }));
      expect(announcement).not.toBeNull();

      advance(1_000);
      const consoleSpy = vi.spyOn(console, "log");
      const { res } = call(deps, "GET", `/api/mesh/voice/audio/${announcement?.id}`);
      await vi.waitFor(() => expect(res.writes.length).toBeGreaterThan(0));

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("falls back to static file correctly when subscribeStream returns false, without double writeHead", async () => {
      const speech: SpeechClient = {
        transcribe: async () => "",
        synthesize: async () => ({ pcm: Buffer.from([]), sampleRate: 24_000 }),
        streamSynthesize: async () => ({
          sampleRate: 24_000,
          pcmStream: (async function* () {})(),
        }),
      };

      const testService = new VoiceService({
        home,
        speech,
        now: () => now,
        encodeStream: async (_pcmStream, _rate, basePath) => {
          const path = `${basePath}.mp3`;
          await writeFile(path, Buffer.from("static-mp3-fallback"));
          return {
            path,
            mime: "audio/mpeg",
            subscribe: (_onData, _onEnd) => false,
          };
        },
      });

      deps.service = testService;
      testService.presenceConnect([UUID_A]);
      const announcement = await testService.handleMeshEvent(replyEvent({ body: "fallback" }));
      expect(announcement).not.toBeNull();

      const { res } = call(deps, "GET", `/api/mesh/voice/audio/${announcement?.id}`);
      await settled(res);

      expect(res.statusCode).toBe(200);
      expect(res.writes.length).toBe(1);
      expect(res.writes[0].toString()).toBe("static-mp3-fallback");
    });

    it("404s unknown announcement ids (registry lookup only, no paths)", () => {
      const { res } = call(deps, "GET", "/api/mesh/voice/audio/not-an-id");
      expect(res.statusCode).toBe(404);
      const traversal = call(deps, "GET", "/api/mesh/voice/audio/..%2F..%2Fetc%2Fpasswd");
      expect(traversal.res.statusCode).toBe(404);
    });

    it("backlog lists unplayed announcements oldest first; ack clears them", async () => {
      const first = await seedAnnouncement("first");
      const second = await seedAnnouncement("second");

      let res = call(deps, "GET", `/api/mesh/actors/${UUID_A}/voice/backlog`).res;
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).announcements.map((a: { id: string }) => a.id)).toEqual([
        first.id,
        second.id,
      ]);

      const ack = call(deps, "POST", "/api/mesh/voice/ack", {
        body: JSON.stringify({ id: first.id }),
      });
      await settled(ack.res);
      expect(ack.res.statusCode).toBe(200);

      res = call(deps, "GET", `/api/mesh/actors/${UUID_A}/voice/backlog`).res;
      expect(JSON.parse(res.body).announcements.map((a: { id: string }) => a.id)).toEqual([
        second.id,
      ]);
    });

    it("backlog is empty for an actor with no announcements", () => {
      const { res } = call(deps, "GET", `/api/mesh/actors/${UUID_B}/voice/backlog`);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).announcements).toEqual([]);
    });

    it("ack 404s unknown ids and 400s malformed bodies", async () => {
      const unknown = call(deps, "POST", "/api/mesh/voice/ack", {
        body: JSON.stringify({ id: "nope" }),
      });
      await settled(unknown.res);
      expect(unknown.res.statusCode).toBe(404);

      const malformed = call(deps, "POST", "/api/mesh/voice/ack", { body: "not json" });
      await settled(malformed.res);
      expect(malformed.res.statusCode).toBe(400);
    });
  });

  it("keeps inbox files under the voice home (never client-named)", async () => {
    const { res } = call(deps, "POST", `/api/mesh/actors/${UUID_A}/voice-memo`, {
      body: Buffer.from("x"),
      contentType: 'audio/webm; codecs="opus"',
    });
    await settled(res);
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(home, "voice", "inbox"))).toBe(true);
    expect(transcribe).toHaveBeenCalledWith(expect.any(Buffer), "audio/webm");
  });
});
