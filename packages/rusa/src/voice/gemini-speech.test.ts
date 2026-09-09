import { describe, expect, it } from "vitest";
import { createGeminiSpeechClient } from "./gemini-speech.js";

describe("createGeminiSpeechClient", () => {
  describe("streamSynthesize", () => {
    it("should correctly parse CRLF-framed SSE and yield PCM audio", async () => {
      // Create a mock fetch that yields SSE parts framed by \r\n\r\n
      const mockFetch = async () => {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const part1 = JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: "audio/L16;codec=pcm;rate=24000",
                          data: Buffer.from("test1").toString("base64"),
                        },
                      },
                    ],
                  },
                },
              ],
            });
            const part2 = JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: "audio/L16;codec=pcm;rate=24000",
                          data: Buffer.from("test2").toString("base64"),
                        },
                      },
                    ],
                  },
                },
              ],
            });
            controller.enqueue(encoder.encode(`data: ${part1}\r\n\r\n`));
            controller.enqueue(encoder.encode(`data: ${part2}\r\n\r\n`));
            controller.enqueue(encoder.encode(`data: [DONE]\r\n\r\n`));
            controller.close();
          },
        });
        return {
          ok: true,
          body: stream,
        };
      };

      const client = createGeminiSpeechClient({
        apiKey: "fake-key",
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      const result = await client.streamSynthesize("hello");
      expect(result.sampleRate).toBe(24000);
      const buffers = [];
      for await (const buf of result.pcmStream) {
        buffers.push(buf.toString("utf8"));
      }
      expect(buffers).toEqual(["test1", "test2"]);
    });

    it("should correctly parse LF-framed SSE and yield PCM audio", async () => {
      const mockFetch = async () => {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const part1 = JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: "audio/L16;codec=pcm;rate=24000",
                          data: Buffer.from("test1").toString("base64"),
                        },
                      },
                    ],
                  },
                },
              ],
            });
            controller.enqueue(encoder.encode(`data: ${part1}\n\n`));
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
            controller.close();
          },
        });
        return {
          ok: true,
          body: stream,
        };
      };

      const client = createGeminiSpeechClient({
        apiKey: "fake-key",
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      const result = await client.streamSynthesize("hello");
      const buffers = [];
      for await (const buf of result.pcmStream) {
        buffers.push(buf.toString("utf8"));
      }
      expect(buffers).toEqual(["test1"]);
    });

    it("should throw if the stream ends with no audio", async () => {
      const mockFetch = async () => {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            // Valid SSE response but missing audio part
            const part1 = JSON.stringify({
              candidates: [{ content: { parts: [{ text: "no audio here" }] } }],
            });
            controller.enqueue(encoder.encode(`data: ${part1}\r\n\r\n`));
            controller.enqueue(encoder.encode(`data: [DONE]\r\n\r\n`));
            controller.close();
          },
        });
        return {
          ok: true,
          body: stream,
        };
      };

      const client = createGeminiSpeechClient({
        apiKey: "fake-key",
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      await expect(client.streamSynthesize("hello")).rejects.toThrow(
        "Gemini TTS stream ended with no audio"
      );
    });

    it("sends the per-call voiceName override and falls back to the configured default", async () => {
      const requests: Array<Record<string, unknown>> = [];
      const mockFetch = async (_url: string, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const part = JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: "audio/L16;codec=pcm;rate=24000",
                          data: Buffer.from("test1").toString("base64"),
                        },
                      },
                    ],
                  },
                },
              ],
            });
            controller.enqueue(encoder.encode(`data: ${part}\r\n\r\n`));
            controller.enqueue(encoder.encode(`data: [DONE]\r\n\r\n`));
            controller.close();
          },
        });
        return { ok: true, body: stream };
      };

      const client = createGeminiSpeechClient({
        apiKey: "fake-key",
        voiceName: "Laomedeia",
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      await drain(await client.streamSynthesize("hello", "Charon"));
      await drain(await client.streamSynthesize("hello"));

      const voiceOf = (body: Record<string, unknown>) => {
        const config = body.generationConfig as {
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
        };
        return config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
      };
      expect(voiceOf(requests[0])).toBe("Charon");
      expect(voiceOf(requests[1])).toBe("Laomedeia");
    });
  });
});

async function drain(result: { pcmStream: AsyncIterable<Buffer> }): Promise<void> {
  for await (const _chunk of result.pcmStream) {
    // discard
  }
}
