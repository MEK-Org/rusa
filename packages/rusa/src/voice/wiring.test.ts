import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { ChatRoomRepository } from "../db/repositories/chat-room-repository.js";
import { SqliteActorRepository } from "../db/repositories/sqlite-actor-repository.js";
import { ChatRoomService } from "./chat-room.js";
import { buildSupportedVoiceCatalog } from "./voice-catalog.js";
import { googleVoiceConfig, type VoiceConfigDocument } from "./voice-config.js";
import { createVoiceService } from "./wiring.js";

const clients = vi.hoisted(() => ({
  google: { transcribe: vi.fn(), streamSynthesize: vi.fn(), synthesize: vi.fn() },
  elevenlabs: { transcribe: vi.fn(), streamSynthesize: vi.fn(), synthesize: vi.fn() },
}));
vi.mock("./gemini-speech.js", () => ({ createGeminiSpeechClient: () => clients.google }));
vi.mock("./elevenlabs-speech.js", () => ({
  createElevenLabsSpeechClient: () => clients.elevenlabs,
}));

beforeEach(() => vi.resetAllMocks());
describe("voice provider routing", () => {
  it("defaults transcription to Google and selects ElevenLabs independently", async () => {
    clients.google.transcribe.mockResolvedValue("google");
    clients.elevenlabs.transcribe.mockResolvedValue("elevenlabs");
    const google = createVoiceService({
      isHumanRecipient: (id) => id === TEST_USER_ID,
      home: "/unused",
      apiKey: "key",
    });
    const elevenlabs = createVoiceService({
      isHumanRecipient: (id) => id === TEST_USER_ID,
      home: "/unused",
      apiKey: "key",
      elevenlabsApiKey: "key",
      voice: { transcriptionProvider: "elevenlabs" },
    });
    expect(await google.transcribeMemo(Buffer.alloc(0), "audio/webm")).toBe("google");
    expect(await elevenlabs.transcribeMemo(Buffer.alloc(0), "audio/webm")).toBe("elevenlabs");
    expect(clients.google.transcribe).toHaveBeenCalledTimes(1);
    expect(clients.elevenlabs.transcribe).toHaveBeenCalledTimes(1);
  });

  it("resolves actor provider changes before each reply", async () => {
    let config: VoiceConfigDocument = {
      schemaVersion: 1,
      provider: "elevenlabs",
      config: { voiceId: "my-voice" },
    };
    const service = createVoiceService({
      isHumanRecipient: (id) => id === TEST_USER_ID,
      home: "/unused",
      apiKey: "key",
      elevenlabsApiKey: "key",
      voiceConfigFor: () => config,
    });
    service.presenceConnect(["actor"], TEST_USER_ID);
    // Stop at the synthesis boundary, before filesystem/encoder work.
    clients.google.streamSynthesize.mockRejectedValue(new Error("google render"));
    clients.elevenlabs.streamSynthesize.mockRejectedValue(new Error("elevenlabs render"));
    const event = {
      id: "event",
      ts: "now",
      kind: "message_sent",
      actorId: "actor",
      detail: null,
      body: "Hello",
      payload: JSON.stringify({ to: "00000000-0000-4000-8000-000000000001" }),
      success: null,
    };
    await expect(service.handleMeshEvent(event)).rejects.toThrow("elevenlabs render");
    expect(clients.elevenlabs.streamSynthesize).toHaveBeenCalledWith("Hello", "my-voice");
    config = { schemaVersion: 1, provider: "google", config: { voiceName: "puck" } };
    await expect(service.handleMeshEvent(event)).rejects.toThrow("google render");
    expect(clients.google.streamSynthesize).toHaveBeenCalledWith("Hello", "Puck");
  });

  it("rejects with an explicit error when actor voice provider has no credentials", async () => {
    let config: VoiceConfigDocument | undefined = {
      schemaVersion: 1,
      provider: "google",
      config: { voiceName: "Puck" },
    };
    const service = createVoiceService({
      isHumanRecipient: (id) => id === TEST_USER_ID,
      home: "/unused",
      apiKey: "",
      elevenlabsApiKey: "eleven-key",
      voiceConfigFor: () => config,
      voice: {
        supportedVoices: [
          {
            label: "Christopher",
            voiceConfig: {
              schemaVersion: 1,
              provider: "elevenlabs",
              config: { voiceId: "chris-voice-id" },
            },
          },
        ],
      },
    });
    service.presenceConnect(["actor"], TEST_USER_ID);
    const event = {
      id: "event",
      ts: "now",
      kind: "message_sent",
      actorId: "actor",
      detail: null,
      body: "Hello",
      payload: JSON.stringify({ to: "00000000-0000-4000-8000-000000000001" }),
      success: null,
    };
    // Actor with Google voice throws explicitly when Google key is missing
    await expect(service.handleMeshEvent(event)).rejects.toThrow(
      "Google TTS: geminiApiKey is not configured; select an ElevenLabs actor voice"
    );

    // Unset actor voice (instance default) also throws explicitly when Google key is missing
    config = undefined;
    await expect(service.handleMeshEvent(event)).rejects.toThrow(
      "Google TTS: geminiApiKey is not configured; select an ElevenLabs actor voice"
    );

    // ElevenLabs actor voice throws explicitly when ElevenLabs key is missing
    const googleOnlyService = createVoiceService({
      isHumanRecipient: (id) => id === TEST_USER_ID,
      home: "/unused",
      apiKey: "google-key",
      elevenlabsApiKey: "",
      voiceConfigFor: () => ({
        schemaVersion: 1,
        provider: "elevenlabs",
        config: { voiceId: "chris-voice-id" },
      }),
    });
    googleOnlyService.presenceConnect(["actor"], TEST_USER_ID);
    await expect(googleOnlyService.handleMeshEvent(event)).rejects.toThrow(
      "ElevenLabs TTS: elevenlabsApiKey is not configured; select an available actor voice"
    );
  });

  it("speaks a Chat Room A then B reply in two different voices after B joins (#663)", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const actors = new SqliteActorRepository(db);
    for (const id of ["root", "actor-b"]) {
      // Neither has a stored voice, so both would speak the instance default.
      actors.upsert({
        id,
        charter: id,
        parentId: id === "root" ? null : "root",
        sandboxed: id !== "root",
        status: "active",
        context: { type: "native" },
        createdAt: "2026-09-30T00:00:00.000Z",
      });
    }
    new ChatRoomService({
      store: new ChatRoomRepository(db),
      actors,
      rootId: "root",
      voices: () => buildSupportedVoiceCatalog(),
      defaultVoice: googleVoiceConfig("Laomedeia"),
      isHumanPrincipal: () => false,
    }).add("actor-b", "root");

    const service = createVoiceService({
      isHumanRecipient: (id) => id === TEST_USER_ID,
      home: "/unused",
      apiKey: "key",
      voice: { voiceName: "Laomedeia" },
      voiceConfigFor: (actorId) => actors.get(actorId)?.voiceConfig,
    });
    service.presenceConnect(["root", "actor-b"], TEST_USER_ID);
    // Stop at the synthesis boundary, before filesystem/encoder work.
    clients.google.streamSynthesize.mockRejectedValue(new Error("render"));
    const reply = (id: string, actorId: string, body: string) => ({
      id,
      ts: "now",
      kind: "message_sent",
      actorId,
      detail: null,
      body,
      payload: JSON.stringify({ to: "00000000-0000-4000-8000-000000000001" }),
      success: null,
    });
    await expect(service.handleMeshEvent(reply("a", "root", "Reply A"))).rejects.toThrow();
    await expect(service.handleMeshEvent(reply("b", "actor-b", "Reply B"))).rejects.toThrow();

    expect(clients.google.streamSynthesize.mock.calls).toEqual([
      ["Reply A", "Laomedeia"],
      ["Reply B", "Achernar"],
    ]);
  });
});

const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";
