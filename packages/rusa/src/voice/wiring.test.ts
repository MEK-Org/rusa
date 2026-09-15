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
    config = { schemaVersion: 1, provider: "google", config: { voiceName: "Puck" } };
    await expect(service.handleMeshEvent(event)).rejects.toThrow("google render");
    expect(clients.google.streamSynthesize).toHaveBeenCalledWith("Hello", "Puck");
  });
});
