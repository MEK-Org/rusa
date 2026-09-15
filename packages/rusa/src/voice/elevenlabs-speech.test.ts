import { describe, expect, it, vi } from "vitest";
import { createElevenLabsSpeechClient } from "./elevenlabs-speech.js";

describe("ElevenLabs speech", () => {
  it("uploads the original memo with Scribe and disables audio event tags", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: " hello " }));
    const client = createElevenLabsSpeechClient({ apiKey: "test-key", fetchImpl });
    expect(await client.transcribe(Buffer.from("audio"), "audio/webm")).toBe("hello");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init?.headers).toEqual({ "xi-api-key": "test-key" });
    const form = init?.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("tag_audio_events")).toBe("false");
    expect(await (form.get("file") as Blob).text()).toBe("audio");
  });

  it("streams 24kHz PCM using the selected voice and model", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4])));
    const client = createElevenLabsSpeechClient({
      apiKey: "key",
      ttsModel: "custom-model",
      fetchImpl,
    });
    const result = await client.synthesize("Hello", "voice/id");
    expect(result).toEqual({ sampleRate: 24000, pcm: Buffer.from([1, 2, 3, 4]) });
    expect(fetchImpl.mock.calls[0][0]).toContain("voice%2Fid/stream?output_format=pcm_24000");
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({
      text: "Hello",
      model_id: "custom-model",
    });
  });

  it("accepts silence but rejects malformed transcripts and provider errors", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ text: "" }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(new Response("private content", { status: 401 }));
    const client = createElevenLabsSpeechClient({ apiKey: "key", fetchImpl });
    expect(await client.transcribe(Buffer.alloc(0), "audio/wav")).toBe("");
    await expect(client.transcribe(Buffer.alloc(0), "audio/wav")).rejects.toThrow("no transcript");
    await expect(client.transcribe(Buffer.alloc(0), "audio/wav")).rejects.toThrow(
      "ElevenLabs HTTP 401"
    );
  });

  it("fails locally for missing credentials or voice IDs", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createElevenLabsSpeechClient({ apiKey: "", fetchImpl });
    await expect(client.transcribe(Buffer.alloc(0), "audio/wav")).rejects.toThrow(
      "elevenlabsApiKey"
    );
    await expect(client.synthesize("hello")).rejects.toThrow("voiceId");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
