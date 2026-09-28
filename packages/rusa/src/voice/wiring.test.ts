import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../observability/logger.js";
import type { VoiceConfigDocument } from "./voice-config.js";
import {
  createVoiceService,
  LEGACY_VOICE_ACTOR_SAMPLE_LIMIT,
  warnLegacyVoiceGaps,
} from "./wiring.js";

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
    const google = createVoiceService({ home: "/unused", apiKey: "key" });
    const elevenlabs = createVoiceService({
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
      home: "/unused",
      apiKey: "key",
      elevenlabsApiKey: "key",
      voiceConfigFor: () => config,
    });
    service.presenceConnect(["actor"]);
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
      payload: JSON.stringify({ to: "human:operator" }),
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
    service.presenceConnect(["actor"]);
    const event = {
      id: "event",
      ts: "now",
      kind: "message_sent",
      actorId: "actor",
      detail: null,
      body: "Hello",
      payload: JSON.stringify({ to: "human:operator" }),
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
      home: "/unused",
      apiKey: "google-key",
      elevenlabsApiKey: "",
      voiceConfigFor: () => ({
        schemaVersion: 1,
        provider: "elevenlabs",
        config: { voiceId: "chris-voice-id" },
      }),
    });
    googleOnlyService.presenceConnect(["actor"]);
    await expect(googleOnlyService.handleMeshEvent(event)).rejects.toThrow(
      "ElevenLabs TTS: elevenlabsApiKey is not configured; select an available actor voice"
    );
  });
});

describe("legacy voice startup diagnostic (#544)", () => {
  const elevenlabsVoice: VoiceConfigDocument = {
    schemaVersion: 1,
    provider: "elevenlabs",
    config: { voiceId: "assigned" },
  };
  const recorder = () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    return { warn, logger };
  };

  it("names active actors without a stored voice when Google TTS is unavailable", () => {
    const { warn, logger } = recorder();
    warnLegacyVoiceGaps(
      [
        { id: "legacy", status: "active" },
        { id: "assigned", status: "active", voiceConfig: elevenlabsVoice },
        { id: "retired", status: "retired" },
      ],
      { apiKey: " " },
      logger
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith("voice_legacy_actors_unconfigured", {
      count: 1,
      actorIds: ["legacy"],
    });
  });

  it("bounds the named actors while reporting the exact count", () => {
    const { warn, logger } = recorder();
    const actors = Array.from({ length: LEGACY_VOICE_ACTOR_SAMPLE_LIMIT + 3 }, (_, i) => ({
      id: `legacy-${i}`,
      status: "active" as const,
    }));
    warnLegacyVoiceGaps(actors, { apiKey: "" }, logger);
    const fields = warn.mock.calls[0]?.[1];
    expect(fields.count).toBe(LEGACY_VOICE_ACTOR_SAMPLE_LIMIT + 3);
    expect(fields.actorIds).toHaveLength(LEGACY_VOICE_ACTOR_SAMPLE_LIMIT);
  });

  it("stays silent when Google TTS is configured or every active actor has a voice", () => {
    const { warn, logger } = recorder();
    warnLegacyVoiceGaps([{ id: "legacy", status: "active" }], { apiKey: "key" }, logger);
    warnLegacyVoiceGaps(
      [{ id: "assigned", status: "active", voiceConfig: elevenlabsVoice }],
      { apiKey: "" },
      logger
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
