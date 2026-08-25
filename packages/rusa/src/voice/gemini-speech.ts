/**
 * Gemini speech endpoints for walkie-talkie mode : audio transcription
 * (voice memo → text) and text-to-speech (actor reply → PCM audio).
 *
 * Thin REST client over `generativelanguage.googleapis.com`, ported from the
 * field-proven `~/.rusa/tts.mjs` recipe. Host-side only — the key never
 * reaches workers (consistent with the quota/avatar Gemini usage). Injectable
 * `fetchImpl` so tests never hit the network.
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export const DEFAULT_TRANSCRIPTION_MODEL = "gemini-2.5-flash";
export const DEFAULT_TTS_MODEL = "gemini-3.1-flash-tts-preview";
export const DEFAULT_VOICE_NAME = "Laomedeia";

/** Instruction sent alongside the audio bytes for a verbatim transcript. */
const TRANSCRIBE_INSTRUCTION =
  "Transcribe this audio verbatim. Reply with ONLY the transcript text — " +
  "no preamble, no quotes, no commentary. If the audio contains no speech, reply with an empty string.";

/** Raw synthesized audio: 16-bit mono PCM plus its sample rate. */
export interface SynthesizedPcm {
  pcm: Buffer;
  sampleRate: number;
}

/**
 * The speech surface `VoiceService` depends on. Production uses the Gemini
 * client below; tests inject fakes.
 */
export interface SpeechClient {
  /** Transcribe an audio blob (any `audio/*` mime) to plain text. */
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
  /** Render text to raw PCM via the TTS model. */
  synthesize(text: string): Promise<SynthesizedPcm>;
  /** Render text to raw PCM stream via the TTS model. */
  streamSynthesize(text: string): Promise<{ sampleRate: number; pcmStream: AsyncIterable<Buffer> }>;
}

export interface GeminiSpeechOptions {
  apiKey: string;
  /** Audio-capable model for transcription. Default {@link DEFAULT_TRANSCRIPTION_MODEL}. */
  transcriptionModel?: string;
  /** TTS model. Default {@link DEFAULT_TTS_MODEL}. */
  ttsModel?: string;
  /** Prebuilt Gemini voice. Default {@link DEFAULT_VOICE_NAME}. */
  voiceName?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiGenerateResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
}

async function generateContent(
  fetchImpl: typeof fetch,
  model: string,
  apiKey: string,
  body: unknown
): Promise<GeminiGenerateResponse> {
  const response = await fetchImpl(
    `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`Gemini ${model} HTTP ${response.status}: ${detail}`);
  }
  return (await response.json()) as GeminiGenerateResponse;
}

/** Parse the sample rate out of a PCM mime like `audio/L16;codec=pcm;rate=24000`. */
export function pcmRateFromMime(mime: string | undefined): number {
  const match = mime?.match(/rate=(\d+)/);
  const rate = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : 24_000;
}

/** Production {@link SpeechClient} against the Gemini REST API. */
export function createGeminiSpeechClient(options: GeminiSpeechOptions): SpeechClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const transcriptionModel = options.transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL;
  const ttsModel = options.ttsModel ?? DEFAULT_TTS_MODEL;
  const voiceName = options.voiceName ?? DEFAULT_VOICE_NAME;

  return {
    async transcribe(audio: Buffer, mimeType: string): Promise<string> {
      const result = await generateContent(fetchImpl, transcriptionModel, options.apiKey, {
        contents: [
          {
            parts: [
              { text: TRANSCRIBE_INSTRUCTION },
              // snake_case per the REST API's accepted form (mirrors the
              // documented inline_data audio recipe).
              { inline_data: { mime_type: mimeType, data: audio.toString("base64") } },
            ],
          },
        ],
      });
      const parts = result.candidates?.[0]?.content?.parts ?? [];
      const transcript = parts
        .map((part) => part.text ?? "")
        .join("")
        .trim();
      if (!transcript) {
        throw new Error("Gemini transcription returned no text");
      }
      return transcript;
    },

    async synthesize(text: string): Promise<SynthesizedPcm> {
      const result = await generateContent(fetchImpl, ttsModel, options.apiKey, {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
      });
      const parts = result.candidates?.[0]?.content?.parts ?? [];
      const audioPart = parts.find((part) => part.inlineData?.data);
      if (!audioPart?.inlineData?.data) {
        throw new Error("Gemini TTS returned no audio");
      }
      return {
        pcm: Buffer.from(audioPart.inlineData.data, "base64"),
        sampleRate: pcmRateFromMime(audioPart.inlineData.mimeType),
      };
    },

    async streamSynthesize(
      text: string
    ): Promise<{ sampleRate: number; pcmStream: AsyncIterable<Buffer> }> {
      const response = await fetchImpl(
        `${GEMINI_BASE}/${ttsModel}:streamGenerateContent?alt=sse&key=${encodeURIComponent(options.apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
            },
          }),
        }
      );
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        throw new Error(`Gemini ${ttsModel} HTTP ${response.status}: ${detail}`);
      }
      if (!response.body) throw new Error("No response body");
      const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      let sampleRate = 24000;
      let firstAudioBuffer: Buffer | null = null;
      let foundFirst = false;

      async function nextSseData(): Promise<string | null> {
        while (true) {
          const match = buffer.match(/\r?\n\r?\n/);
          if (match && match.index !== undefined) {
            const eventStr = buffer.slice(0, match.index).trim();
            buffer = buffer.slice(match.index + match[0].length);
            if (eventStr.startsWith("data: ")) {
              const data = eventStr.slice(6);
              if (data !== "[DONE]") return data;
            }
            continue;
          }
          const { done, value } = await reader.read();
          if (done) {
            const eventStr = buffer.trim();
            buffer = "";
            if (eventStr.startsWith("data: ")) {
              const data = eventStr.slice(6);
              if (data !== "[DONE]") return data;
            }
            return null;
          }
          buffer += decoder.decode(value, { stream: true });
        }
      }

      while (!foundFirst) {
        const data = await nextSseData();
        if (!data) break;
        const result = JSON.parse(data) as GeminiGenerateResponse;
        const parts = result.candidates?.[0]?.content?.parts ?? [];
        const audioPart = parts.find((part) => part.inlineData?.data);
        if (audioPart?.inlineData?.data) {
          sampleRate = pcmRateFromMime(audioPart.inlineData.mimeType);
          firstAudioBuffer = Buffer.from(audioPart.inlineData.data, "base64");
          foundFirst = true;
        }
      }

      if (!foundFirst) {
        throw new Error("Gemini TTS stream ended with no audio");
      }

      const asyncIterable = {
        async *[Symbol.asyncIterator]() {
          try {
            if (firstAudioBuffer) yield firstAudioBuffer;
            while (true) {
              const data = await nextSseData();
              if (!data) break;
              const result = JSON.parse(data) as GeminiGenerateResponse;
              const parts = result.candidates?.[0]?.content?.parts ?? [];
              const audioPart = parts.find((part) => part.inlineData?.data);
              if (audioPart?.inlineData?.data) {
                yield Buffer.from(audioPart.inlineData.data, "base64");
              }
            }
          } finally {
            reader.releaseLock();
          }
        },
      };

      return { sampleRate, pcmStream: asyncIterable };
    },
  };
}
