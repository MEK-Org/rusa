import type { SpeechClient } from "./gemini-speech.js";

const BASE = "https://api.elevenlabs.io/v1";
export const ELEVENLABS_TRANSCRIPTION_MODEL = "scribe_v2";
export const ELEVENLABS_TTS_MODEL = "eleven_multilingual_v2";

/** Host-only REST adapter. PCM keeps the existing streaming playback pipeline. */
export function createElevenLabsSpeechClient(options: {
  apiKey: string;
  transcriptionModel?: string;
  ttsModel?: string;
  fetchImpl?: typeof fetch;
}): SpeechClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  async function request(path: string, init: RequestInit): Promise<Response> {
    if (!options.apiKey.trim()) throw new Error("ElevenLabs: elevenlabsApiKey is not configured");
    const response = await fetchImpl(`${BASE}/${path}`, {
      ...init,
      headers: { ...init.headers, "xi-api-key": options.apiKey },
      signal: AbortSignal.timeout(120_000),
    });
    // Do not include provider response bodies: they may echo submitted content.
    if (!response.ok) throw new Error(`ElevenLabs HTTP ${response.status}`);
    return response;
  }
  async function streamSynthesize(text: string, voiceId?: string) {
    if (!voiceId?.trim()) throw new Error("ElevenLabs TTS requires an actor voiceId");
    const response = await request(
      `text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_24000`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, model_id: options.ttsModel ?? ELEVENLABS_TTS_MODEL }),
      }
    );
    if (!response.body) throw new Error("ElevenLabs TTS returned no audio stream");
    const body = response.body;
    async function* chunks(): AsyncIterable<Buffer> {
      const reader = body.getReader();
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          yield Buffer.from(value);
        }
        if (bytes === 0 || bytes % 2 !== 0)
          throw new Error("ElevenLabs TTS returned invalid PCM audio");
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    return { sampleRate: 24_000, pcmStream: chunks() };
  }
  return {
    async transcribe(audio, mimeType) {
      const form = new FormData();
      form.set("model_id", options.transcriptionModel ?? ELEVENLABS_TRANSCRIPTION_MODEL);
      form.set("tag_audio_events", "false");
      form.set("diarize", "false");
      form.set("file", new Blob([new Uint8Array(audio)], { type: mimeType }), "memo");
      const response = await request("speech-to-text", { method: "POST", body: form });
      const result = (await response.json()) as { text?: unknown };
      if (typeof result.text !== "string")
        throw new Error("ElevenLabs STT returned no transcript text");
      const transcript = result.text.trim();
      if (!transcript) throw new Error("ElevenLabs STT returned no transcript text");
      return transcript;
    },
    streamSynthesize,
    async synthesize(text, voiceId) {
      const { sampleRate, pcmStream } = await streamSynthesize(text, voiceId);
      const chunks: Buffer[] = [];
      for await (const chunk of pcmStream) chunks.push(chunk);
      return { sampleRate, pcm: Buffer.concat(chunks) };
    },
  };
}
