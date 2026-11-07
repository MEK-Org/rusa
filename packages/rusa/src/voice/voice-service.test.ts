import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MeshEventEmitter } from "../dashboard/mesh-event-emitter.js";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";

import type { Logger } from "../observability/logger.js";
import type { SpeechClient } from "./gemini-speech.js";
import {
  ANDROID_ASSISTANT_SESSION_PREFIX,
  VOICE_PRESENCE_GRACE_MS,
  VoiceService,
  type VoiceServiceOptions,
} from "./voice-service.js";
import { attachVoiceOutbound } from "./wiring.js";

const ACTOR = "aaaaaaaa-0000-4000-8000-000000000001";
const TARGET = "bbbbbbbb-0000-4000-8000-000000000002";
const ANDROID_SESSION = `${ANDROID_ASSISTANT_SESSION_PREFIX}aaaaaaaa-0000-4000-8000-000000000009`;

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
    isHumanRecipient?: (principalId: string) => boolean;
    speechFor?: VoiceServiceOptions["speechFor"];
    meshChat?: VoiceServiceOptions["meshChat"];
    logger?: Logger;
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
    isHumanRecipient: opts.isHumanRecipient ?? ((id) => id === TEST_USER_ID),
    speechFor: opts.speechFor,
    meshChat: opts.meshChat,
    logger: opts.logger,
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
    payload: JSON.stringify({ to: TEST_USER_ID }),
    success: null,
    ...overrides,
  };
}

describe("VoiceService presence & grace", () => {
  it("is inactive with no subscription, active while one is connected", () => {
    const { service } = makeService();
    expect(service.hasPresence(ACTOR, TEST_USER_ID)).toBe(false);
    service.presenceConnect([ACTOR], TEST_USER_ID);
    expect(service.hasPresence(ACTOR, TEST_USER_ID)).toBe(true);
  });

  it("stays active within the grace window after disconnect, then expires", () => {
    let now = 1_000_000;
    const { service } = makeService({ now: () => now });
    service.presenceConnect([ACTOR], TEST_USER_ID);
    service.presenceDisconnect([ACTOR], TEST_USER_ID);

    now += VOICE_PRESENCE_GRACE_MS - 1;
    expect(service.hasPresence(ACTOR, TEST_USER_ID)).toBe(true);

    now += 2;
    expect(service.hasPresence(ACTOR, TEST_USER_ID)).toBe(false);
  });

  it("keeps presence while any of several subscriptions remains connected", () => {
    let now = 0;
    const { service } = makeService({ now: () => now });
    service.presenceConnect([ACTOR], TEST_USER_ID);
    service.presenceConnect([ACTOR], TEST_USER_ID);
    service.presenceDisconnect([ACTOR], TEST_USER_ID);
    now += VOICE_PRESENCE_GRACE_MS * 10; // grace irrelevant: one is still live
    expect(service.hasPresence(ACTOR, TEST_USER_ID)).toBe(true);
  });
});

describe("VoiceService durable reply recovery", () => {
  it("uses the durable mesh message id as the notification announcement id", async () => {
    const { service } = makeService();
    service.presenceConnect([ACTOR], TEST_USER_ID);

    const announcement = await service.handleMeshEvent(
      replyEvent({ payload: JSON.stringify({ to: TEST_USER_ID, messageId: "durable-reply" }) })
    );

    expect(announcement?.id).toBe("durable-reply");
  });

  it("rebuilds a notification-targeted reply after its in-memory registry is gone", async () => {
    const messageId = "reply-message";
    const { service } = makeService({
      meshChat: {
        getById: (id) =>
          id === messageId
            ? {
                id,
                ts: "2026-11-06T00:00:00.000Z",
                senderId: ACTOR,
                recipientId: TEST_USER_ID,
                body: "Your reply is ready.",
                sessionId: "walkie-session",
                responsive: null,
              }
            : null,
      },
    });

    const first = await service.recoverAnnouncement(messageId, ACTOR, TEST_USER_ID);

    expect(first).toMatchObject({
      id: messageId,
      actorId: ACTOR,
      recipientId: TEST_USER_ID,
      sessionId: "walkie-session",
      text: "Your reply is ready.",
    });
  });

  it("rejects a foreign recovery while a valid recovery is rendering", async () => {
    const messageId = "reply-message";
    const { service } = makeService({
      meshChat: {
        getById: () => ({
          id: messageId,
          ts: "2026-11-06T00:00:00.000Z",
          senderId: ACTOR,
          recipientId: TEST_USER_ID,
          body: "private reply",
          sessionId: null,
          responsive: null,
        }),
      },
    });

    const valid = service.recoverAnnouncement(messageId, ACTOR, TEST_USER_ID);
    await expect(
      service.recoverAnnouncement(messageId, TARGET, TEST_USER_ID)
    ).resolves.toBeUndefined();
    await expect(valid).resolves.toMatchObject({ id: messageId, actorId: ACTOR });
  });

  it("keeps one announcement when a notification tap races the live render", async () => {
    const messageId = "reply-message";
    const { service } = makeService({
      meshChat: {
        getById: () => ({
          id: messageId,
          ts: "2026-11-06T00:00:00.000Z",
          senderId: ACTOR,
          recipientId: TEST_USER_ID,
          body: "Your reply is ready.",
          sessionId: "walkie-session",
          responsive: null,
        }),
      },
    });
    service.presenceConnect([ACTOR], TEST_USER_ID);

    const recovered = service.recoverAnnouncement(messageId, ACTOR, TEST_USER_ID);
    const live = service.handleMeshEvent(
      replyEvent({ payload: JSON.stringify({ to: TEST_USER_ID, messageId }) })
    );
    const [recoveredAnnouncement, liveAnnouncement] = await Promise.all([recovered, live]);

    // A duplicate ring entry would survive `ack` and replay as backlog on the
    // next connection, because `ack` updates only the first entry with this id.
    expect(liveAnnouncement).toBe(recoveredAnnouncement);
    expect(service.ack(messageId)).toBe(true);
    expect(service.backlog(ACTOR, TEST_USER_ID)).toEqual([]);
  });

  it("fails closed when a durable row belongs to another actor or principal", async () => {
    const { service } = makeService({
      meshChat: {
        getById: () => ({
          id: "reply-message",
          ts: "2026-11-06T00:00:00.000Z",
          senderId: ACTOR,
          recipientId: TEST_USER_ID,
          body: "private reply",
          sessionId: null,
          responsive: null,
        }),
      },
    });

    await expect(
      service.recoverAnnouncement("reply-message", TARGET, TEST_USER_ID)
    ).resolves.toBeUndefined();
    await expect(
      service.recoverAnnouncement("reply-message", ACTOR, "other-user")
    ).resolves.toBeUndefined();
  });
});

describe("VoiceService Android reply notification correlation", () => {
  it("accepts only replies from the durable Android assistant conversation", () => {
    const { service } = makeService();
    const payload = JSON.stringify({ to: TEST_USER_ID, messageId: "announcement-1" });

    expect(service.pushTargetForMeshEvent(replyEvent({ payload }))).toBeNull();
    expect(
      service.pushTargetForMeshEvent(replyEvent({ detail: ANDROID_SESSION, payload }))
    ).toEqual({ actorId: ACTOR, announcementId: "announcement-1", recipientId: TEST_USER_ID });
  });

  it("keeps a delayed Android reply eligible after its stream lease expires", () => {
    let now = 0;
    const { service } = makeService({ now: () => now, sessionLeaseMs: 10 });
    const payload = JSON.stringify({ to: TEST_USER_ID, messageId: "delayed-reply" });
    service.openSession(ANDROID_SESSION, ACTOR, TEST_USER_ID);
    service.disconnectSession(ANDROID_SESSION);
    now = 11;
    service.expireSessions();

    expect(service.hasActiveSession(ACTOR)).toBe(false);
    expect(
      service.pushTargetForMeshEvent(replyEvent({ detail: ANDROID_SESSION, payload }))
    ).toEqual({ actorId: ACTOR, announcementId: "delayed-reply", recipientId: TEST_USER_ID });
  });
});

describe("VoiceService leased sessions", () => {
  it("binds a session to its user and preserves that user across transfers", () => {
    const { service } = makeService();
    const other = "11111111-0000-4000-8000-000000000001";
    service.openSession("session-a", ACTOR, TEST_USER_ID);
    expect(() => service.openSession("session-a", ACTOR, other)).toThrow("different actor or user");
    expect(service.activeSessionFor(ACTOR)).toEqual({
      sessionId: "session-a",
      principalId: TEST_USER_ID,
    });
    expect(service.closeSession("session-a", other)).toBe(false);
    service.transferActiveSession(ACTOR, TARGET);
    expect(service.activeSessionFor(TARGET)).toEqual({
      sessionId: "session-a",
      principalId: TEST_USER_ID,
    });
    service.closeSession("session-a", TEST_USER_ID);
  });

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
      openSession(sessionId: string, actorId: string, principalId: string): void;
      disconnectSession(sessionId: string): boolean;
      closeSession(sessionId: string): boolean;
      hasActiveSession(actorId: string): boolean;
      expireSessions(): void;
    };

    sessions.openSession("session-a", ACTOR, TEST_USER_ID);
    expect(sessions.hasActiveSession(ACTOR)).toBe(true);

    // One open stream holds authority beyond the reconnect allowance.
    now += leaseMs * 2;
    sessions.expireSessions();
    expect(sessions.hasActiveSession(ACTOR)).toBe(true);

    // A second connection and one drop still leave the first holding authority.
    sessions.openSession("session-a", ACTOR, TEST_USER_ID);
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
    sessions.openSession("session-a", ACTOR, TEST_USER_ID);
    expect(sessions.closeSession("session-a")).toBe(true);
    expect(sessions.closeSession("session-a")).toBe(false);
    expect(ended).toEqual([ACTOR, ACTOR]);
  });

  it("atomically rebinds the same active session and can restore it before mesh delivery", () => {
    const ended: string[] = [];
    const controls: Array<[string, string]> = [];
    const { service } = makeService({ onSessionEnded: (actorId) => ended.push(actorId) });
    service.setSessionTransferNotifier((sessionId, targetActorId) =>
      controls.push([sessionId, targetActorId])
    );
    service.openSession("session-a", ACTOR, TEST_USER_ID);

    expect(service.activeSessionFor(ACTOR).sessionId).toBe("session-a");
    expect(service.transferActiveSession(ACTOR, TARGET)).toBe("session-a");
    expect(service.activeSessionFor(TARGET).sessionId).toBe("session-a");
    expect(service.hasActiveSession(ACTOR)).toBe(false);
    expect(service.hasActiveSession(TARGET)).toBe(true);
    expect(ended).toEqual([]);

    service.revertActiveSessionTransfer("session-a", ACTOR, TARGET);
    expect(service.activeSessionFor(ACTOR).sessionId).toBe("session-a");
    expect(service.hasActiveSession(TARGET)).toBe(false);

    expect(service.transferActiveSession(ACTOR, TARGET)).toBe("session-a");

    service.notifySessionTransferred("session-a", TARGET);
    expect(controls).toEqual([["session-a", TARGET]]);
    expect(() => service.transferActiveSession(ACTOR, TARGET)).toThrow("does not hold");
  });

  it("dispatches a transfer control after a same-turn source reply frame", async () => {
    let resolveSynthesis!: (value: Awaited<ReturnType<SpeechClient["streamSynthesize"]>>) => void;
    const pendingSynthesis = new Promise<Awaited<ReturnType<SpeechClient["streamSynthesize"]>>>(
      (resolve) => {
        resolveSynthesis = resolve;
      }
    );
    const logs: Array<Record<string, unknown>> = [];
    let logger!: Logger;
    const write = (level: string, event: string, fields: Record<string, unknown> = {}) => {
      logs.push({ level, event, ...fields });
    };
    logger = {
      debug: (event, fields) => write("debug", event, fields),
      info: (event, fields) => write("info", event, fields),
      warn: (event, fields) => write("warn", event, fields),
      error: (event, fields) => write("error", event, fields),
      child: () => logger,
    };
    const { service } = makeService({
      speech: fakeSpeech({ streamSynthesize: () => pendingSynthesis }),
      logger,
    });
    const frames: string[] = [];
    const controls: Array<[string, string]> = [];
    service.setSessionTransferNotifier((sessionId, targetActorId) =>
      controls.push([sessionId, targetActorId])
    );
    service.presenceConnect([ACTOR], TEST_USER_ID);
    service.openSession("session-a", ACTOR, TEST_USER_ID);

    const reply = service.handleMeshEvent(replyEvent(), (announcement) =>
      frames.push(announcement.id)
    );
    expect(service.transferActiveSession(ACTOR, TARGET)).toBe("session-a");
    service.notifySessionTransferred("session-a", TARGET);
    expect(controls).toEqual([]);

    resolveSynthesis({
      sampleRate: 24_000,
      pcmStream: (async function* () {
        yield Buffer.from([1, 2, 3, 4]);
      })(),
    });
    await reply;

    expect(frames).toHaveLength(1);
    await vi.waitFor(() => expect(controls).toEqual([["session-a", TARGET]]));
    expect(logs).toContainEqual({
      level: "info",
      event: "voice_session_control_dispatched",
      sessionId: "session-a",
      targetActorId: TARGET,
    });
    expect(JSON.stringify(logs)).not.toContain("On it — ETA five minutes.");
  });
});

describe("VoiceService outbound reply TTS", () => {
  it("renders, stores, and registers a reply to a durable user from a present actor", async () => {
    const { service, home } = makeService();
    service.presenceConnect([ACTOR], TEST_USER_ID);

    const announcement = await service.handleMeshEvent(replyEvent());
    expect(announcement).not.toBeNull();
    expect(announcement?.actorId).toBe(ACTOR);
    expect(announcement?.text).toBe("On it — ETA five minutes.");
    expect(announcement?.mime).toBe("audio/mpeg");
    expect(announcement?.playedAt).toBeNull();
    expect(announcement?.audioPath.startsWith(join(home, "voice", "outbox"))).toBe(true);
    expect((await readFile(announcement?.audioPath ?? "")).length).toBeGreaterThan(0);
    expect(service.backlog(ACTOR, TEST_USER_ID)).toHaveLength(1);
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
    service.presenceConnect([ACTOR], TEST_USER_ID);
    service.presenceDisconnect([ACTOR], TEST_USER_ID);
    now += VOICE_PRESENCE_GRACE_MS - 1;
    expect(await service.handleMeshEvent(replyEvent())).not.toBeNull();
  });

  it("renders nothing outside the grace window", async () => {
    let now = 0;
    const { service } = makeService({ now: () => now });
    service.presenceConnect([ACTOR], TEST_USER_ID);
    service.presenceDisconnect([ACTOR], TEST_USER_ID);
    now += VOICE_PRESENCE_GRACE_MS + 1;
    expect(await service.handleMeshEvent(replyEvent())).toBeNull();
  });

  it("renders a reply to a durable user principal once storage says the recipient is a person", async () => {
    const USER = "11111111-0000-4000-8000-000000000001";
    const spoken = makeService({ isHumanRecipient: (id) => id === USER });
    spoken.service.presenceConnect([ACTOR], USER);
    expect(
      await spoken.service.handleMeshEvent(replyEvent({ payload: JSON.stringify({ to: USER }) }))
    ).not.toBeNull();

    // Without principal storage a bare id is just another actor, so it stays silent.
    const silent = makeService();
    silent.service.presenceConnect([ACTOR], TEST_USER_ID);
    expect(
      await silent.service.handleMeshEvent(replyEvent({ payload: JSON.stringify({ to: USER }) }))
    ).toBeNull();
  });

  it("ignores events that are not replies to a known user", async () => {
    const { service } = makeService();
    service.presenceConnect([ACTOR], TEST_USER_ID);
    // Inbound memo delivery: recipient is the actor, sender is the operator.
    expect(
      await service.handleMeshEvent(
        replyEvent({ payload: JSON.stringify({ to: ACTOR, from: TEST_USER_ID }) })
      )
    ).toBeNull();
    expect(await service.handleMeshEvent(replyEvent({ kind: "run_start" }))).toBeNull();
    expect(await service.handleMeshEvent(replyEvent({ body: null }))).toBeNull();
    expect(await service.handleMeshEvent(replyEvent({ payload: null }))).toBeNull();
  });

  it("bounds the announcement registry to a ring of the newest entries", async () => {
    const { service } = makeService({ max: 3 });
    service.presenceConnect([ACTOR], TEST_USER_ID);
    for (let i = 0; i < 5; i++) {
      await service.handleMeshEvent(replyEvent({ body: `reply ${i}` }));
    }
    const backlog = service.backlog(ACTOR, TEST_USER_ID);
    expect(backlog.map((a) => a.text)).toEqual(["reply 2", "reply 3", "reply 4"]);
  });
});

describe("VoiceService per-actor voice selection", () => {
  it("passes the actor's resolved voice to synthesis, looked up per reply", async () => {
    const streamSynthesize = vi.fn(async () => ({
      sampleRate: 24_000,
      pcmStream: (async function* () {})(),
    }));
    const speech = fakeSpeech({ streamSynthesize });
    const speechFor = vi.fn((actorId: string) =>
      actorId === ACTOR ? { speech, voiceName: "Charon" } : undefined
    );
    const { service } = makeService({
      speech,
      speechFor,
    });
    service.presenceConnect([ACTOR], TEST_USER_ID);

    await service.handleMeshEvent(replyEvent());
    expect(streamSynthesize).toHaveBeenCalledWith("On it — ETA five minutes.", "Charon");
    expect(speechFor).toHaveBeenCalledWith(ACTOR);

    // Resolved again for the next reply, so a mid-conversation voice change
    // takes effect immediately.
    speechFor.mockReturnValue({ speech, voiceName: "Kore" });
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
      speechFor: () => undefined,
    });
    service.presenceConnect([ACTOR], TEST_USER_ID);

    await service.handleMeshEvent(replyEvent());
    expect(streamSynthesize).toHaveBeenCalledWith("On it — ETA five minutes.", undefined);
  });

  it("uses the instance default when no voice resolver is installed", async () => {
    const streamSynthesize = vi.fn(async () => ({
      sampleRate: 24_000,
      pcmStream: (async function* () {})(),
    }));
    const { service } = makeService({ speech: fakeSpeech({ streamSynthesize }) });
    service.presenceConnect([ACTOR], TEST_USER_ID);

    await service.handleMeshEvent(replyEvent());
    expect(streamSynthesize).toHaveBeenCalledWith("On it — ETA five minutes.", undefined);
  });

  it("never consults the speech resolver for a non-reply event", async () => {
    const speechFor = vi.fn(() => ({ speech: fakeSpeech(), voiceName: "Charon" }));
    const { service } = makeService({ speechFor });
    service.presenceConnect([ACTOR], TEST_USER_ID);
    expect(await service.handleMeshEvent(replyEvent({ kind: "run_start" }))).toBeNull();
    expect(speechFor).not.toHaveBeenCalled();
  });
});

describe("VoiceService backlog & ack", () => {
  it("lists only unplayed announcements oldest first; ack removes from backlog", async () => {
    const { service } = makeService();
    service.presenceConnect([ACTOR], TEST_USER_ID);
    const first = await service.handleMeshEvent(replyEvent({ body: "first" }));
    const second = await service.handleMeshEvent(replyEvent({ body: "second" }));
    expect(service.backlog(ACTOR, TEST_USER_ID).map((a) => a.text)).toEqual(["first", "second"]);

    expect(service.ack(first?.id ?? "")).toBe(true);
    expect(service.backlog(ACTOR, TEST_USER_ID).map((a) => a.text)).toEqual(["second"]);
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
    service.presenceConnect([ACTOR], TEST_USER_ID);
    const emitter = new MeshEventEmitter();
    const pushVoice = vi.fn();
    const detach = attachVoiceOutbound(emitter, service, { pushVoice });

    emitter.emitMeshEvent(
      replyEvent({
        detail: ANDROID_SESSION,
        payload: JSON.stringify({ to: TEST_USER_ID, messageId: "announcement-1" }),
      })
    );
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
    service.presenceConnect([ACTOR], TEST_USER_ID);
    const emitter = new MeshEventEmitter();
    const pushVoice = vi.fn();
    attachVoiceOutbound(emitter, service, { pushVoice });
    expect(() => emitter.emitMeshEvent(replyEvent())).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pushVoice).not.toHaveBeenCalled();
  });

  it("dispatches a durable reply notification without SSE presence or TTS", async () => {
    const { service } = makeService({
      speech: fakeSpeech({
        streamSynthesize: async () => {
          throw new Error("tts down");
        },
      }),
    });
    const emitter = new MeshEventEmitter();
    const pushVoice = vi.fn();
    const deliver = vi.fn(async () => undefined);
    attachVoiceOutbound(emitter, service, { pushVoice }, undefined, { deliver }, ACTOR);

    emitter.emitMeshEvent(
      replyEvent({
        detail: ANDROID_SESSION,
        payload: JSON.stringify({ to: TEST_USER_ID, messageId: "announcement-1" }),
      })
    );

    await vi.waitFor(() =>
      expect(deliver).toHaveBeenCalledWith({
        actorId: ACTOR,
        announcementId: "announcement-1",
        recipientId: TEST_USER_ID,
      })
    );
    expect(pushVoice).not.toHaveBeenCalled();
  });

  it("does not notify for a non-root transferred voice actor", async () => {
    const { service } = makeService();
    const emitter = new MeshEventEmitter();
    const pushVoice = vi.fn();
    const deliver = vi.fn(async () => undefined);
    attachVoiceOutbound(emitter, service, { pushVoice }, undefined, { deliver }, TARGET);

    emitter.emitMeshEvent(
      replyEvent({
        detail: ANDROID_SESSION,
        payload: JSON.stringify({ to: TEST_USER_ID, messageId: "announcement-1" }),
      })
    );

    expect(deliver).not.toHaveBeenCalled();
  });
});

const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";
