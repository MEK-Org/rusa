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

/**
 * A dropped EventSource is allowed a short window to reconnect without releasing
 * the actor's walkie authority. #186 specifies a short reconnect lease, but its
 * approved product record does not select a duration or contain reconnect
 * measurements. Thirty seconds is therefore an explicitly provisional default,
 * not a claim about browser or mobile recovery behavior. Keep it injectable so
 * tests and a later evidence-backed policy can choose the budget directly.
 *
 * This deliberately does not reuse {@link VOICE_PRESENCE_GRACE_MS}: that
 * two-minute grace protects TTS delivery. Immediate expiry would defeat the
 * accepted reconnect lease; an unbounded lease would hold ordinary work forever.
 */
export const VOICE_SESSION_LEASE_MS = 30 * 1000;

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
  /**
   * Resolve the voice to synthesize this actor's replies with — the per-actor
   * voice selection, looked up fresh before every render. Return undefined to
   * use the speech client's instance-wide default (actors with no persisted
   * voice setting, and every pre-migration actor). Transcription never consults
   * this: it stays instance-wide.
   */
  voiceNameFor?: (actorId: string) => string | undefined;
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
  /** Test seam for the explicit walkie reconnect allowance. */
  sessionLeaseMs?: number;
  /** Called once when an explicit session ends or expires. */
  onSessionEnded?: (actorId: string) => void;
}

interface VoiceSession {
  actorId: string;
  /** Number of open SSE connections carrying this stable session id. */
  connections: number;
  /** Null while a stream remains open; otherwise the reconnect deadline. */
  expiresAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
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
  private readonly sessionLeaseMs: number;
  private readonly voiceNameFor: ((actorId: string) => string | undefined) | undefined;

  /** Live `voice` SSE subscription count per actor. */
  private readonly liveSubscriptions = new Map<string, number>();
  /** Epoch ms of the last disconnect per actor (starts the grace window). */
  private readonly lastSeen = new Map<string, number>();
  /** Explicit dashboard-owned session authority, keyed by stable session UUID. */
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly onSessionEnded?: (actorId: string) => void;
  private onSessionTransferred?: (sessionId: string, targetActorId: string) => void;
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
    this.sessionLeaseMs = options.sessionLeaseMs ?? VOICE_SESSION_LEASE_MS;
    if (!Number.isFinite(this.sessionLeaseMs) || this.sessionLeaseMs <= 0) {
      throw new Error("sessionLeaseMs must be a positive finite number");
    }
    this.voiceNameFor = options.voiceNameFor;
    this.onSessionEnded = options.onSessionEnded;
  }

  // ── Explicit leased walkie sessions ────────────────────────────────────

  /**
   * Attach one voice SSE connection to a dashboard's stable session UUID. A UUID
   * remains bound to its first actor for this session's lifetime; a different
   * actor is a protocol error rather than an implicit transfer (transfers are
   * slice B). Any live connection holds authority indefinitely.
   */
  openSession(sessionId: string, actorId: string): void {
    const existing = this.validateSession(sessionId, actorId);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = null;
      existing.expiresAt = null;
      existing.connections++;
      return;
    }
    this.sessions.set(sessionId, {
      actorId,
      connections: 1,
      expiresAt: null,
      timer: null,
    });
  }

  /** Validate a pending stream without granting authority until it is attached. */
  validateSession(sessionId: string, actorId: string): VoiceSession | undefined {
    if (!sessionId.trim()) throw new Error("sessionId is required");
    if (!actorId.trim()) throw new Error("actorId is required");
    this.expireSessions();
    const existing = this.sessions.get(sessionId);
    if (existing && existing.actorId !== actorId) {
      throw new Error("sessionId is already bound to a different actor");
    }
    return existing;
  }

  /**
   * Detach one SSE connection. Only the final drop starts the reconnect timer;
   * another open stream retains authority without a deadline.
   */
  disconnectSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.connections === 0) return false;
    session.connections--;
    if (session.connections > 0) return true;

    const expiresAt = this.now() + this.sessionLeaseMs;
    session.expiresAt = expiresAt;
    session.timer = this.scheduleSessionExpiry(sessionId, expiresAt);
    return true;
  }

  /** Explicit mode exit. Returns false when it was already absent (idempotent). */
  closeSession(sessionId: string): boolean {
    return this.endSession(sessionId);
  }

  /** True while an explicit session belongs to this actor and is live or unexpired. */
  hasActiveSession(actorId: string): boolean {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (session.actorId === actorId && (session.expiresAt === null || session.expiresAt > now)) {
        return true;
      }
    }
    return false;
  }

  /** Testable expiry sweep; production timers invoke this at each lease boundary. */
  expireSessions(): void {
    const now = this.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt !== null && session.expiresAt <= now) this.endSession(sessionId);
    }
  }

  /** Whether this stable UUID currently authorizes voice memos for its actor. */
  hasSession(sessionId: string, actorId: string): boolean {
    const session = this.sessions.get(sessionId);
    return (
      session?.actorId === actorId && (session.expiresAt === null || session.expiresAt > this.now())
    );
  }

  /** The caller's sole active session UUID, or an error when transfer is ambiguous. */
  activeSessionIdFor(actorId: string): string {
    this.expireSessions();
    const active = [...this.sessions.entries()].filter(
      ([, session]) =>
        session.actorId === actorId &&
        (session.expiresAt === null || session.expiresAt > this.now())
    );
    if (active.length === 0) throw new Error("caller does not hold an active voice session");
    if (active.length > 1) {
      throw new Error("caller holds multiple active voice sessions; transfer is ambiguous");
    }
    return active[0][0];
  }

  /**
   * Rebind this actor's one active leased session to a different active actor.
   * The session UUID, open connection count, and reconnect lease remain intact;
   * only its authority changes. The mesh releases the old holder only after it
   * has durably accepted the recipient's handoff, allowing a failed write to
   * be rolled back without prematurely admitting ordinary source work.
   */
  transferActiveSession(fromActorId: string, targetActorId: string): string {
    if (!fromActorId.trim()) throw new Error("source actor id is required");
    if (!targetActorId.trim()) throw new Error("target actor id is required");
    if (fromActorId === targetActorId) throw new Error("cannot transfer a voice session to itself");
    this.expireSessions();

    const sessionId = this.activeSessionIdFor(fromActorId);
    if (this.hasActiveSession(targetActorId)) {
      throw new Error("target actor already holds an active voice session");
    }

    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("active voice session disappeared before transfer");
    session.actorId = targetActorId;
    return sessionId;
  }

  /** Undo a rebind that could not be paired with a durable mesh handoff. */
  revertActiveSessionTransfer(sessionId: string, fromActorId: string, targetActorId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.actorId !== targetActorId) {
      throw new Error("voice session cannot be restored after transfer");
    }
    session.actorId = fromActorId;
  }

  /** Deliver a post-rebind dashboard control frame when a voice UI is bound. */
  notifySessionTransferred(sessionId: string, targetActorId: string): void {
    this.onSessionTransferred?.(sessionId, targetActorId);
  }

  /** Wire or clear the live dashboard notifier after its SSE hub is constructed. */
  setSessionTransferNotifier(
    notifier: ((sessionId: string, targetActorId: string) => void) | undefined
  ): void {
    this.onSessionTransferred = notifier;
  }

  private scheduleSessionExpiry(
    sessionId: string,
    expiresAt: number
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(
      () => {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        if (session.expiresAt !== expiresAt) return;
        this.expireSessions();
      },
      Math.max(0, expiresAt - this.now())
    );
    timer.unref?.();
    return timer;
  }

  private endSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.timer) clearTimeout(session.timer);
    this.sessions.delete(sessionId);
    this.onSessionEnded?.(session.actorId);
    return true;
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

    // Per-actor voice selection happens here, once per reply, before synthesis
    // — an actor whose voice the operator just changed speaks with the new one
    // on the very next reply. No persisted setting → undefined → the speech
    // client's instance-wide default, which is the pre-existing behavior.
    const voiceName = this.voiceNameFor?.(senderId);

    const streamRequestedAt = this.now();
    const streamInfo = await this.speech.streamSynthesize(text, voiceName);
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
