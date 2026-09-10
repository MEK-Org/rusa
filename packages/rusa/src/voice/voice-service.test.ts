import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MeshEventEmitter } from "../dashboard/mesh-event-emitter.js";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import type { SpeechClient } from "./gemini-speech.js";
import { VOICE_PRESENCE_GRACE_MS, VoiceService } from "./voice-service.js";
import { attachVoiceOutbound } from "./wiring.js";

const ACTOR = "aaaaaaaa-0000-4000-8000-000000000001";

function fakeSpeech(overrides: Partial<SpeechClient> = {}): SpeechClient {
  return {
    transcribe: async () => "hello from the road",
    synthesize: async () => ({ pcm: Buffer.from([1, 2, 3, 4]), sampleRate: 24_000 }),
    streamSynthesize: async () => ({
      sampleRate: 24_000,
      pcmStream: (async function* () {
        yield Buffer.from([1, 2, 3, 4]);
      })(),
    }),
    ...overrides,
  };
}

function makeService(
  opts: {
    now?: () => number;
    speech?: SpeechClient;
    max?: number;
    sessionLeaseMs?: number;
    onSessionEnded?: (actorId: string) => void;
    voiceNameFor?: (actorId: string) => string | undefined;
  } = {}
) {
  const home = mkdtempSync(join(tmpdir(), "voice-service-"));
  const service = new VoiceService({
    home,
    speech: opts.speech ?? fakeSpeech(),
    now: opts.now,
    maxAnnouncements: opts.max,
    sessionLeaseMs: opts.sessionLeaseMs,
    onSessionEnded: opts.onSessionEnded,
    voiceNameFor: opts.voiceNameFor,
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
  return { home, service };
}

function replyEvent(overrides: Partial<MeshEvent> = {}): MeshEvent {
  return {
    id: "e1",
    ts: "2026-07-17T00:00:00.000Z",
    kind: "message_sent",
    actorId: ACTOR,
    detail: "sess-1",
    body: "On it — ETA five minutes.",
    payload: JSON.stringify({ to: HUMAN_OPERATOR }),
    success: null,
    ...overrides,
  };
}

describe("VoiceService presence & grace", () => {
  it("is inactive with no subscription, active while one is connected", () => {
    const { service } = makeService();
    expect(service.hasPresence(ACTOR)).toBe(false);
    service.presenceConnect([ACTOR]);
    expect(service.hasPresence(ACTOR)).toBe(true);
  });

  it("stays active within the grace window after disconnect, then expires", () => {
    let now = 1_000_000;
    const { service } = makeService({ now: () => now });
    service.presenceConnect([ACTOR]);
    service.presenceDisconnect([ACTOR]);

    now += VOICE_PRESENCE_GRACE_MS - 1;
    expect(service.hasPresence(ACTOR)).toBe(true);

    now += 2;
    expect(service.hasPresence(ACTOR)).toBe(false);
  });

  it("keeps presence while any of several subscriptions remains connected", () => {
    let now = 0;
    const { service } = makeService({ now: () => now });
    service.presenceConnect([ACTOR]);
    service.presenceConnect([ACTOR]);
    service.presenceDisconnect([ACTOR]);
    now += VOICE_PRESENCE_GRACE_MS * 10; // grace irrelevant: one is still live
    expect(service.hasPresence(ACTOR)).toBe(true);
  });
});

describe("VoiceService leased sessions", () => {
  it("holds authority while connections remain and expires only after the final drop", () => {
    let now = 1_000_000;
    const ended: string[] = [];
    const leaseMs = 30_000;
    const { service } = makeService({
      now: () => now,
      sessionLeaseMs: leaseMs,
      onSessionEnded: (actorId) => ended.push(actorId),
    });
    const sessions = service as unknown as {
      openSession(sessionId: string, actorId: string): void;
      disconnectSession(sessionId: string): boolean;
      closeSession(sessionId: string): boolean;
      hasActiveSession(actorId: string): boolean;
      expireSessions(): void;
    };

    sessions.openSession("session-a", ACTOR);
    expect(sessions.hasActiveSession(ACTOR)).toBe(true);

    // One open stream holds authority beyond the reconnect allowance.
    now += leaseMs * 2;
    sessions.expireSessions();
    expect(sessions.hasActiveSession(ACTOR)).toBe(true);

    // A second connection and one drop still leave the first holding authority.
    sessions.openSession("session-a", ACTOR);
    expect(sessions.disconnectSession("session-a")).toBe(true);
    now += leaseMs * 2;
    sessions.expireSessions();
    expect(sessions.hasActiveSession(ACTOR)).toBe(true);

    // Only the final drop starts the reconnect expiry.
    expect(sessions.disconnectSession("session-a")).toBe(true);
    now += leaseMs - 1;
    sessions.expireSessions();
    expect(sessions.hasActiveSession(ACTOR)).toBe(true);
    now += 1;
    sessions.expireSessions();
    expect(sessions.hasActiveSession(ACTOR)).toBe(false);
    expect(ended).toEqual([ACTOR]);
    expect(sessions.closeSession("session-a")).toBe(false);
    expect(ended).toEqual([ACTOR]);

    // Explicit disable remains idempotent for a newly opened session.
    sessions.openSession("session-a", ACTOR);
    expect(sessions.closeSession("session-a")).toBe(true);
    expect(sessions.closeSession("session-a")).toBe(false);
    expect(ended).toEqual([ACTOR, ACTOR]);
  });
});

describe("VoiceService outbound reply TTS", () => {
  it("renders, stores, and registers a reply to human:operator from a present actor", async () => {
    const { service, home } = makeService();
    service.presenceConnect([ACTOR]);

    const announcement = await service.handleMeshEvent(replyEvent());
    expect(announcement).not.toBeNull();
    expect(announcement?.actorId).toBe(ACTOR);
    expect(announcement?.text).toBe("On it — ETA five minutes.");
    expect(announcement?.mime).toBe("audio/mpeg");
    expect(announcement?.playedAt).toBeNull();
    expect(announcement?.audioPath.startsWith(join(home, "voice", "outbox"))).toBe(true);
    expect((await readFile(announcement?.audioPath ?? "")).length).toBeGreaterThan(0);
    expect(service.backlog(ACTOR)).toHaveLength(1);
  });

  it("renders nothing without presence (reply stays text-only)", async () => {
    const synthesize = vi.fn();
    const { service } = makeService({ speech: fakeSpeech({ synthesize }) });
    expect(await service.handleMeshEvent(replyEvent())).toBeNull();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("still renders within the grace window after disconnect", async () => {
    let now = 0;
    const { service } = makeService({ now: () => now });
    service.presenceConnect([ACTOR]);
    service.presenceDisconnect([ACTOR]);
    now += VOICE_PRESENCE_GRACE_MS - 1;
    expect(await service.handleMeshEvent(replyEvent())).not.toBeNull();
  });

  it("renders nothing outside the grace window", async () => {
    let now = 0;
    const { service } = makeService({ now: () => now });
    service.presenceConnect([ACTOR]);
    service.presenceDisconnect([ACTOR]);
    now += VOICE_PRESENCE_GRACE_MS + 1;
    expect(await service.handleMeshEvent(replyEvent())).toBeNull();
  });

  it("ignores events that are not replies to human:operator", async () => {
    const { service } = makeService();
    service.presenceConnect([ACTOR]);
    // Inbound memo delivery: recipient is the actor, sender is the operator.
    expect(
      await service.handleMeshEvent(
        replyEvent({ payload: JSON.stringify({ to: ACTOR, from: HUMAN_OPERATOR }) })
      )
    ).toBeNull();
    expect(await service.handleMeshEvent(replyEvent({ kind: "run_start" }))).toBeNull();
    expect(await service.handleMeshEvent(replyEvent({ body: null }))).toBeNull();
    expect(await service.handleMeshEvent(replyEvent({ payload: null }))).toBeNull();
  });

  it("bounds the announcement registry to a ring of the newest entries", async () => {
    const { service } = makeService({ max: 3 });
    service.presenceConnect([ACTOR]);
    for (let i = 0; i < 5; i++) {
      await service.handleMeshEvent(replyEvent({ body: `reply ${i}` }));
    }
    const backlog = service.backlog(ACTOR);
    expect(backlog.map((a) => a.text)).toEqual(["reply 2", "reply 3", "reply 4"]);
  });
});

describe("VoiceService per-actor voice selection", () => {
  it("passes the actor's resolved voice to synthesis, looked up per reply", async () => {
    const streamSynthesize = vi.fn(async () => ({
      sampleRate: 24_000,
      pcmStream: (async function* () {})(),
    }));
    const voiceNameFor = vi.fn((actorId: string): string | undefined =>
      actorId === ACTOR ? "Charon" : undefined
    );
    const { service } = makeService({
      speech: fakeSpeech({ streamSynthesize }),
      voiceNameFor,
    });
    service.presenceConnect([ACTOR]);

    await service.handleMeshEvent(replyEvent());
    expect(streamSynthesize).toHaveBeenCalledWith("On it — ETA five minutes.", "Charon");
    expect(voiceNameFor).toHaveBeenCalledWith(ACTOR);

    // Resolved again for the next reply, so a mid-conversation voice change
    // takes effect immediately.
    voiceNameFor.mockReturnValue("Kore");
    await service.handleMeshEvent(replyEvent({ body: "Second reply." }));
    expect(streamSynthesize).toHaveBeenLastCalledWith("Second reply.", "Kore");
  });

  it("passes undefined for an actor with no voice setting — the instance default", async () => {
    const streamSynthesize = vi.fn(async () => ({
      sampleRate: 24_000,
      pcmStream: (async function* () {})(),
    }));
    const { service } = makeService({
      speech: fakeSpeech({ streamSynthesize }),
      voiceNameFor: () => undefined,
    });
    service.presenceConnect([ACTOR]);

    await service.handleMeshEvent(replyEvent());
    expect(streamSynthesize).toHaveBeenCalledWith("On it — ETA five minutes.", undefined);
  });

  it("uses the instance default when no voice resolver is installed", async () => {
    const streamSynthesize = vi.fn(async () => ({
      sampleRate: 24_000,
      pcmStream: (async function* () {})(),
    }));
    const { service } = makeService({ speech: fakeSpeech({ streamSynthesize }) });
    service.presenceConnect([ACTOR]);

    await service.handleMeshEvent(replyEvent());
    expect(streamSynthesize).toHaveBeenCalledWith("On it — ETA five minutes.", undefined);
  });

  it("never consults the voice resolver for a non-reply event", async () => {
    const voiceNameFor = vi.fn(() => "Charon");
    const { service } = makeService({ voiceNameFor });
    service.presenceConnect([ACTOR]);
    expect(await service.handleMeshEvent(replyEvent({ kind: "run_start" }))).toBeNull();
    expect(voiceNameFor).not.toHaveBeenCalled();
  });
});

describe("VoiceService backlog & ack", () => {
  it("lists only unplayed announcements oldest first; ack removes from backlog", async () => {
    const { service } = makeService();
    service.presenceConnect([ACTOR]);
    const first = await service.handleMeshEvent(replyEvent({ body: "first" }));
    const second = await service.handleMeshEvent(replyEvent({ body: "second" }));
    expect(service.backlog(ACTOR).map((a) => a.text)).toEqual(["first", "second"]);

    expect(service.ack(first?.id ?? "")).toBe(true);
    expect(service.backlog(ACTOR).map((a) => a.text)).toEqual(["second"]);
    expect(service.get(first?.id ?? "")?.playedAt).not.toBeNull();
    expect(second?.playedAt).toBeNull();
  });

  it("ack returns false for unknown ids", () => {
    const { service } = makeService();
    expect(service.ack("nope")).toBe(false);
  });
});

describe("attachVoiceOutbound", () => {
  it("bridges emitter events to a voice push and detaches cleanly", async () => {
    const { service } = makeService();
    service.presenceConnect([ACTOR]);
    const emitter = new MeshEventEmitter();
    const pushVoice = vi.fn();
    const detach = attachVoiceOutbound(emitter, service, { pushVoice });

    emitter.emitMeshEvent(replyEvent());
    await vi.waitFor(() => expect(pushVoice).toHaveBeenCalledTimes(1));
    const frame = pushVoice.mock.calls[0][0];
    expect(frame.actorId).toBe(ACTOR);
    expect(frame.audioUrl).toBe(`/api/mesh/voice/audio/${frame.id}`);
    expect(frame.mime).toBe("audio/mpeg");

    detach();
    emitter.emitMeshEvent(replyEvent({ body: "after detach" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pushVoice).toHaveBeenCalledTimes(1);
  });

  it("swallows TTS failures without breaking the emitter", async () => {
    const { service } = makeService({
      speech: fakeSpeech({
        synthesize: async () => {
          throw new Error("tts down");
        },
        streamSynthesize: async () => {
          throw new Error("tts down");
        },
      }),
    });
    service.presenceConnect([ACTOR]);
    const emitter = new MeshEventEmitter();
    const pushVoice = vi.fn();
    attachVoiceOutbound(emitter, service, { pushVoice });
    expect(() => emitter.emitMeshEvent(replyEvent())).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pushVoice).not.toHaveBeenCalled();
  });
});
