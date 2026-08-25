/**
 * Walkie-talkie mode, server half : voice memos into the actor chat and
 * actor replies back out as TTS audio.
 *
 * Inbound: the memo route stores the raw audio under
 * `$RUSA_HOME/voice/inbox/` and transcribes it; the transcript rides the
 * existing `sendHumanMessage` chat path with the memo marker prefix.
 *
 * Outbound: a subscription on the dashboard's mesh-event emitter watches for
 * replies to `human:operator`. While the sending actor has a connected `voice`
 * SSE subscription — or had one within the last {@link VOICE_PRESENCE_GRACE_MS}
 * (a dropped LTE connection mid-drive must not eat a reply) — the reply body is
 * rendered to speech, stored under `$RUSA_HOME/voice/outbox/`, registered
 * in a bounded in-memory ring, and pushed on the `voice` SSE channel. No
 * presence → no TTS: the reply is just text in the chat, read later.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import {
  type EncodedAudio,
  encodePcmAudio,
  encodePcmStream,
  type StreamingEncodedAudio,
} from "./audio.js";
import type { SpeechClient } from "./gemini-speech.js";
import { speakableText } from "./tts-text.js";

/**
 * Marker prefix delivered ahead of every transcript — the walkie channel's
 * "separate communication conventions" mechanism: it rides the message (no
 * per-charter edits) and tells the actor to answer short and ear-first.
 */
export const VOICE_MEMO_PREFIX = "🎙️ [voice memo — reply for the ear]: ";

/**
 * How long after its last `voice` SSE subscription disconnects an actor still
 * counts as "in walkie mode" for reply TTS. Bridges connection blips (LTE drop
 * mid-drive) — the rendered reply waits in the backlog for the reconnect.
 */
export const VOICE_PRESENCE_GRACE_MS = 2 * 60 * 1000;

/** Ring bound on the in-memory announcement registry. */
export const MAX_ANNOUNCEMENTS = 50;

/** One rendered reply awaiting (or having finished) playback. */
export interface VoiceAnnouncement {
  id: string;
  /** The actor whose reply this is (the walkie peer, not `human:operator`). */
  actorId: string;
  /** The speakable text that was synthesized. */
  text: string;
  /** Absolute path of the stored audio file. */
  audioPath: string;
  /** `audio/mpeg` or `audio/wav`, matching what was actually encoded. */
  mime: string;
  createdAt: string;
  /** ISO timestamp of the client's playback ack, or null while unplayed. */
  playedAt: string | null;
  /** Subscribe to the active stream; if provided, bypasses the static file read. */
  subscribeStream?: (onData: (chunk: Buffer) => void, onEnd: () => void) => boolean;
  streamRequestedAt?: number;
}

/** The wire shape pushed on the `voice` SSE channel (and listed by backlog). */
export interface VoiceAnnouncementFrame {
  id: string;
  actorId: string;
  text: string;
  /** Route serving the audio bytes: `/api/mesh/voice/audio/<id>`. */
  audioUrl: string;
  mime: string;
  createdAt: string;
}

export function toFrame(announcement: VoiceAnnouncement): VoiceAnnouncementFrame {
  return {
    id: announcement.id,
    actorId: announcement.actorId,
    text: announcement.text,
    audioUrl: `/api/mesh/voice/audio/${announcement.id}`,
    mime: announcement.mime,
    createdAt: announcement.createdAt,
  };
}

/** Map an inbound `audio/*` mime to a storage extension (default webm). */
function memoExtension(mime: string): string {
  const subtype = mime
    .split(";")[0]
    .trim()
    .toLowerCase()
    .replace(/^audio\//, "");
  const known: Record<string, string> = {
    webm: "webm",
    ogg: "ogg",
    mpeg: "mp3",
    mp3: "mp3",
    mp4: "m4a",
    aac: "aac",
    wav: "wav",
    "x-wav": "wav",
    flac: "flac",
  };
  return known[subtype] ?? "webm";
}

export interface VoiceServiceOptions {
  /** `$RUSA_HOME`; audio lands under `<home>/voice/{inbox,outbox}`. */
  home: string;
  speech: SpeechClient;
  /** Injectable clock for presence/grace tests. */
  now?: () => number;
  /**
   * Injectable PCM encoder (tests avoid ffmpeg/fs churn). Defaults to
   * {@link encodePcmAudio} with its own ffmpeg resolution.
   */
  encode?: (pcm: Buffer, sampleRate: number, basePath: string) => Promise<EncodedAudio>;
  encodeStream?: (
    pcmStream: AsyncIterable<Buffer>,
    sampleRate: number,
    basePath: string
  ) => Promise<StreamingEncodedAudio>;
  maxAnnouncements?: number;
  presenceGraceMs?: number;
}

export class VoiceService {
  private readonly home: string;
  private readonly speech: SpeechClient;
  private readonly now: () => number;
  private readonly encode: (
    pcm: Buffer,
    sampleRate: number,
    basePath: string
  ) => Promise<EncodedAudio>;
  private readonly encodeStream: (
    pcmStream: AsyncIterable<Buffer>,
    sampleRate: number,
    basePath: string
  ) => Promise<StreamingEncodedAudio>;
  private readonly maxAnnouncements: number;
  private readonly presenceGraceMs: number;

  /** Live `voice` SSE subscription count per actor. */
  private readonly liveSubscriptions = new Map<string, number>();
  /** Epoch ms of the last disconnect per actor (starts the grace window). */
  private readonly lastSeen = new Map<string, number>();
  /** Insertion-ordered announcement ring, oldest first, bounded. */
  private readonly announcements: VoiceAnnouncement[] = [];

  constructor(options: VoiceServiceOptions) {
    this.home = options.home;
    this.speech = options.speech;
    this.now = options.now ?? Date.now;
    this.encode = options.encode ?? ((pcm, rate, basePath) => encodePcmAudio(pcm, rate, basePath));
    this.encodeStream =
      options.encodeStream ??
      ((pcmStream, rate, basePath) => encodePcmStream(pcmStream, rate, basePath));
    this.maxAnnouncements = options.maxAnnouncements ?? MAX_ANNOUNCEMENTS;
    this.presenceGraceMs = options.presenceGraceMs ?? VOICE_PRESENCE_GRACE_MS;
  }

  // ── Presence ────────────────────────────────────────────────────────────

  /** A `voice` SSE subscription for these actors connected. */
  presenceConnect(actorIds: Iterable<string>): void {
    for (const actorId of actorIds) {
      this.liveSubscriptions.set(actorId, (this.liveSubscriptions.get(actorId) ?? 0) + 1);
    }
  }

  /** A `voice` SSE subscription disconnected; starts the grace window. */
  presenceDisconnect(actorIds: Iterable<string>): void {
    const now = this.now();
    for (const actorId of actorIds) {
      const count = (this.liveSubscriptions.get(actorId) ?? 0) - 1;
      if (count > 0) {
        this.liveSubscriptions.set(actorId, count);
      } else {
        this.liveSubscriptions.delete(actorId);
        this.lastSeen.set(actorId, now);
      }
    }
  }

  /** Live subscription now, or one within the grace window. */
  hasPresence(actorId: string): boolean {
    if ((this.liveSubscriptions.get(actorId) ?? 0) > 0) return true;
    const lastSeen = this.lastSeen.get(actorId);
    return lastSeen !== undefined && this.now() - lastSeen < this.presenceGraceMs;
  }

  // ── Inbound: memos ──────────────────────────────────────────────────────

  /** Persist raw memo audio under `voice/inbox/`; returns the stored path. */
  async saveMemo(audio: Buffer, mime: string): Promise<string> {
    const dir = join(this.home, "voice", "inbox");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${this.now()}-${randomUUID()}.${memoExtension(mime)}`);
    await writeFile(path, audio);
    return path;
  }

  /** Transcribe memo audio to text (throws on provider failure/empty). */
  transcribeMemo(audio: Buffer, mime: string): Promise<string> {
    return this.speech.transcribe(audio, mime.split(";")[0].trim());
  }

  // ── Outbound: reply TTS ─────────────────────────────────────────────────

  /**
   * Mesh-event hook: on a reply to `human:operator` from an actor with walkie
   * presence, render TTS, store it under `voice/outbox/`, register the
   * announcement, and return it (the caller pushes the SSE frame). Returns null
   * for every event this hook doesn't own.
   */
  async handleMeshEvent(event: MeshEvent): Promise<VoiceAnnouncement | null> {
    if (event.kind !== "message_sent") return null;

    let senderId: string | null = null;
    let recipientId: string | null = null;

    if (event.payload) {
      try {
        const p = JSON.parse(event.payload);
        senderId = event.actorId ?? null;
        recipientId = p.to ?? null;
      } catch (_e) {
        // ignore
      }
    }

    if (recipientId !== HUMAN_OPERATOR) return null;
    if (!senderId || senderId === HUMAN_OPERATOR) return null;
    if (!event.body) return null;
    if (!this.hasPresence(senderId)) return null;

    const text = speakableText(event.body);
    if (!text) return null;

    const streamRequestedAt = this.now();
    const streamInfo = await this.speech.streamSynthesize(text);
    const dir = join(this.home, "voice", "outbox");
    await mkdir(dir, { recursive: true });
    const id = randomUUID();
    const encoded = await this.encodeStream(
      streamInfo.pcmStream,
      streamInfo.sampleRate,
      join(dir, `${streamRequestedAt}-${id}`)
    );

    const announcement: VoiceAnnouncement = {
      id,
      actorId: senderId,
      text,
      audioPath: encoded.path,
      mime: encoded.mime,
      createdAt: new Date(this.now()).toISOString(),
      playedAt: null,
      subscribeStream: encoded.subscribe,
      streamRequestedAt,
    };
    this.announcements.push(announcement);
    while (this.announcements.length > this.maxAnnouncements) this.announcements.shift();
    return announcement;
  }

  // ── Registry reads ──────────────────────────────────────────────────────

  /** Announcement by id, or undefined (the audio route's only lookup path). */
  get(id: string): VoiceAnnouncement | undefined {
    return this.announcements.find((announcement) => announcement.id === id);
  }

  /** Unplayed announcements for an actor, oldest first (within the ring). */
  backlog(actorId: string): VoiceAnnouncement[] {
    return this.announcements.filter(
      (announcement) => announcement.actorId === actorId && announcement.playedAt === null
    );
  }

  /** The clock used by this service for presence, storage, and latency. */
  currentTime(): number {
    return this.now();
  }

  /** Mark an announcement played. Returns false for unknown ids. */
  ack(id: string): boolean {
    const announcement = this.get(id);
    if (!announcement) return false;
    announcement.playedAt = new Date(this.now()).toISOString();
    return true;
  }
}
