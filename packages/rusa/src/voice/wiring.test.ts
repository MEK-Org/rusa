import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceConfigDocument } from "./voice-config.js";
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

  it("falls back default and Google voices to ElevenLabs pool when Google key is missing", async () => {
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
    // Legacy/pre-migration actor with Google voice falls back to ElevenLabs pool
    await expect(service.handleMeshEvent(event)).rejects.toThrow("elevenlabs render");
    expect(clients.elevenlabs.streamSynthesize).toHaveBeenCalledWith("Hello", "chris-voice-id");

    // Unset actor voice (instance default) also falls back to ElevenLabs pool
    config = undefined;
    await expect(service.handleMeshEvent(event)).rejects.toThrow("elevenlabs render");
    expect(clients.elevenlabs.streamSynthesize).toHaveBeenLastCalledWith("Hello", "chris-voice-id");
  });
});
