/**
 * Walkie-talkie HTTP surface , dispatched ahead of the general
 * `/api/mesh/*` handler:
 *
 *   POST /api/mesh/actors/:id/voice-memo    raw audio → transcript → chat
 *   GET  /api/mesh/voice/stream?actors=     `voice` SSE channel (= presence)
 *   GET  /api/mesh/voice/audio/:id          stored TTS audio by announcement id
 *   GET  /api/mesh/actors/:id/voice/backlog unplayed announcements, oldest first
 *   POST /api/mesh/voice/ack                {id} → mark played
 *
 * All routes 503 with a clear error when voice is unconfigured (no
 * `geminiApiKey`) — the walkie client treats that as "mode unavailable".
 */

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ActorMesh } from "../actor/actor-mesh.js";
import type { SseHub } from "../dashboard/sse.js";
import type { ActorRepository } from "../repositories/actor-repository.js";
import { toFrame, VOICE_MEMO_PREFIX, type VoiceService } from "./voice-service.js";

/** Everything the voice routes need, injected by the server wiring. */
export interface VoiceApiDeps {
  actors: ActorRepository;
  sseHub: SseHub;
  /** The live ActorMesh instance (memo delivery). */
  mesh?: ActorMesh;
  /** Null when voice is unconfigured (no geminiApiKey) → routes 503. */
  service: VoiceService | null;
  /** Optional logger for route events (silenced under tests when omitted). */
  log?: (message: string) => void;
}

const MEMO_ROUTE = /^\/api\/mesh\/actors\/([^/]+)\/voice-memo$/;
const BACKLOG_ROUTE = /^\/api\/mesh\/actors\/([^/]+)\/voice\/backlog$/;
const AUDIO_ROUTE = /^\/api\/mesh\/voice\/audio\/([^/]+)$/;
const STREAM_ROUTE = "/api/mesh/voice/stream";
const ACK_ROUTE = "/api/mesh/voice/ack";

/** Cap inbound memo audio well above any realistic tap-to-talk clip. */
const MAX_MEMO_BYTES = 25 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Same `actors` filter shape as the dashboard stream (`/api/mesh/stream`). */
function parseActors(url: URL): Set<string> {
  const seen = new Set<string>();
  for (const part of (url.searchParams.get("actors") ?? "").split(",")) {
    const id = part.trim();
    if (id) seen.add(id);
  }
  return seen;
}

/** Is this pathname one of the walkie-talkie routes? */
function isVoicePath(pathname: string): boolean {
  return (
    pathname === STREAM_ROUTE ||
    pathname === ACK_ROUTE ||
    AUDIO_ROUTE.test(pathname) ||
    MEMO_ROUTE.test(pathname) ||
    BACKLOG_ROUTE.test(pathname)
  );
}

/**
 * Dispatch a walkie-talkie route. Returns true when it owned the request
 * (responded or took over the socket for SSE), false to fall through to the
 * general mesh handler. Must run BEFORE `handleMeshApiRequest`, which owns
 * every other `/api/mesh/*` path.
 */
export function handleVoiceApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: VoiceApiDeps | null
): boolean {
  const { pathname } = url;
  if (!isVoicePath(pathname)) return false;

  if (!deps) {
    sendJson(res, 503, { error: "mesh data API unavailable (no live mesh bound)" });
    return true;
  }
  const service = deps.service;
  if (!service) {
    sendJson(res, 503, {
      error: "voice unavailable: geminiApiKey is not configured on this instance",
    });
    return true;
  }

  // POST /api/mesh/actors/:id/voice-memo — raw audio bytes in, transcript into
  // the actor's chat via the same sendHumanMessage path as typed messages.
  const memoMatch = req.method === "POST" ? pathname.match(MEMO_ROUTE) : null;
  if (memoMatch) {
    const actorId = memoMatch[1];
    const rec = deps.actors.get(actorId);
    if (!rec) {
      sendJson(res, 404, { error: "actor not found" });
      return true;
    }
    if (rec.status === "retired") {
      sendJson(res, 400, { error: "actor is retired", chatDisabled: true });
      return true;
    }
    const contentType = (req.headers["content-type"] ?? "audio/webm").split(";")[0].trim();
    if (!contentType.startsWith("audio/")) {
      sendJson(res, 400, { error: "Content-Type must be audio/*" });
      return true;
    }
    const mesh = deps.mesh;
    if (!mesh) {
      sendJson(res, 500, { error: "ActorMesh instance not bound to deps" });
      return true;
    }
    const sessionId = url.searchParams.get("sessionId") ?? randomUUID();

    void (async () => {
      const audio = await readRawBody(req, MAX_MEMO_BYTES);
      if (audio.length === 0) {
        sendJson(res, 400, { error: "empty audio body" });
        return;
      }
      // Persist FIRST: the raw memo must survive a transcription failure so
      // nothing Operator said is ever lost.
      await service.saveMemo(audio, contentType);
      let transcript: string;
      try {
        transcript = await service.transcribeMemo(audio, contentType);
      } catch (err) {
        sendJson(res, 502, {
          error: `transcription failed: ${err instanceof Error ? err.message : String(err)}`,
          audioSaved: true,
        });
        return;
      }
      // A memo to a non-live actor still transcribes and records (the mesh
      // event is durable), mirroring chat semantics — `delivered` tells the
      // client whether the actor was actually woken.
      const result = mesh.sendHumanMessage(actorId, VOICE_MEMO_PREFIX + transcript, sessionId);
      sendJson(res, 200, { ok: true, transcript, delivered: result.delivered });
    })().catch((err) => {
      sendJson(res, 500, { error: String(err) });
    });
    return true;
  }

  // GET /api/mesh/voice/stream?actors=a,b — the `voice` SSE channel. A
  // connected subscription IS the walkie-mode presence signal for its actors;
  // teardown starts the reply-TTS grace window.
  if (req.method === "GET" && pathname === STREAM_ROUTE) {
    const actors = parseActors(url);
    if (actors.size === 0) {
      sendJson(res, 400, { error: "actors query param is required (comma-separated actor ids)" });
      return true;
    }
    service.presenceConnect(actors);
    const attached = deps.sseHub.addVoiceConnection(res, actors, () =>
      service.presenceDisconnect(actors)
    );
    if (!attached) service.presenceDisconnect(actors);
    return true;
  }

  // GET /api/mesh/voice/audio/:id — announcement audio. Lookup is by registry
  // id ONLY (never a path from the client), so there is no traversal surface.
  const audioMatch = req.method === "GET" ? pathname.match(AUDIO_ROUTE) : null;
  if (audioMatch) {
    const announcement = service.get(audioMatch[1]);
    if (!announcement) {
      sendJson(res, 404, { error: "unknown announcement id" });
      return true;
    }
    void (async () => {
      if (announcement.subscribeStream) {
        let headWritten = false;
        let firstChunk = true;
        const attached = announcement.subscribeStream(
          (chunk) => {
            if (!headWritten) {
              res.writeHead(200, {
                "Content-Type": announcement.mime,
                "Transfer-Encoding": "chunked",
                "Cache-Control": "no-store",
              });
              headWritten = true;
            }
            if (firstChunk) {
              firstChunk = false;
              const now = service.currentTime();
              const latency =
                announcement.streamRequestedAt === undefined
                  ? null
                  : now - announcement.streamRequestedAt;
              const latencySuspect =
                latency === null || !Number.isFinite(latency) || latency < 0 || latency > 60_000;
              deps.log?.(
                JSON.stringify({
                  level: latencySuspect ? "warn" : "info",
                  msg: "First MP3 byte flushed to client",
                  latencyMs: latency,
                  latencySuspect,
                  announcementId: announcement.id,
                  mime: announcement.mime,
                })
              );
            }
            res.write(chunk);
          },
          () => {
            if (!headWritten) {
              res.writeHead(200, {
                "Content-Type": announcement.mime,
                "Transfer-Encoding": "chunked",
                "Cache-Control": "no-store",
              });
              headWritten = true;
            }
            res.end();
          }
        );
        if (attached) return; // Served via stream
      }

      const info = await stat(announcement.audioPath);
      res.writeHead(200, {
        "Content-Type": announcement.mime,
        "Content-Length": String(info.size),
        "Cache-Control": "no-store",
      });
      const stream = createReadStream(announcement.audioPath);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    })().catch(() => {
      sendJson(res, 404, { error: "announcement audio missing" });
    });
    return true;
  }

  // GET /api/mesh/actors/:id/voice/backlog — unplayed announcements for the
  // actor, oldest first (bounded by the in-memory ring).
  const backlogMatch = req.method === "GET" ? pathname.match(BACKLOG_ROUTE) : null;
  if (backlogMatch) {
    sendJson(res, 200, { announcements: service.backlog(backlogMatch[1]).map(toFrame) });
    return true;
  }

  // POST /api/mesh/voice/ack — {id} → playedAt set.
  if (req.method === "POST" && pathname === ACK_ROUTE) {
    void (async () => {
      const body = (await readRawBody(req, 64 * 1024)).toString("utf-8");
      let id: unknown;
      try {
        id = (JSON.parse(body) as { id?: unknown }).id;
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }
      if (typeof id !== "string" || !id) {
        sendJson(res, 400, { error: "Missing id" });
        return;
      }
      if (!service.ack(id)) {
        sendJson(res, 404, { error: "unknown announcement id" });
        return;
      }
      sendJson(res, 200, { ok: true });
    })().catch((err) => {
      sendJson(res, 500, { error: String(err) });
    });
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
