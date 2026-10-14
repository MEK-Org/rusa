// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { configureGeminiUsage, type GeminiUsageRecord } from "../observability/gemini-usage.js";
import { createLogger, nullLogger } from "../observability/logger.js";
import { createGeminiSpeechClient } from "./gemini-speech.js";

function capture() {
  const records: GeminiUsageRecord[] = [];
  configureGeminiUsage(
    createLogger({
      format: "json",
      destination: {
        write(line) {
          records.push(JSON.parse(line).usage);
        },
      },
    }),
    "/synthetic/speech"
  );
  return records;
}
function chunk(input: number, response: number, audio = true) {
  return {
    modelVersion: "actual-tts-model",
    usageMetadata: {
      promptTokenCount: input,
      candidatesTokenCount: response,
      totalTokenCount: input + response,
    },
    candidates: [
      {
        content: {
          parts: audio
            ? [
                {
                  inlineData: {
                    mimeType: "audio/L16;rate=24000",
                    data: Buffer.from("pcm").toString("base64"),
                  },
                },
              ]
            : [{ text: "no audio" }],
        },
      },
    ],
  };
}
function streamClient(events: unknown[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events)
        controller.enqueue(
          Buffer.from(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\r\n\r\n`)
        );
      controller.close();
    },
  });
  return {
    body,
    client: createGeminiSpeechClient({
      apiKey: "synthetic-key",
      fetchImpl: (async () => new Response(body)) as typeof fetch,
    }),
  };
}
afterEach(() => configureGeminiUsage(nullLogger, "/synthetic/test"));

describe("speech usage at the REST boundary", () => {
  it("records the final cumulative snapshot once after fully consuming the stream", async () => {
    const records = capture();
    const { client } = streamClient([
      chunk(100, 10),
      chunk(100, 20),
      { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 } },
      "[DONE]",
    ]);
    const result = await client.streamSynthesize("private speech text");
    expect(records).toEqual([]);
    const audio: Buffer[] = [];
    for await (const data of result.pcmStream) audio.push(data);
    expect(audio).toHaveLength(2);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      purpose: "speech_synthesis",
      model: "actual-tts-model",
      outcome: "response",
      partial: false,
      usage: "complete",
      counts: { input: 100, response: 30, total: 130, thinking: null },
    });
    expect(JSON.stringify(records)).not.toContain("private speech text");
  });

  it("records consumer cancellation as one partial observation and releases the reader", async () => {
    const records = capture();
    const { body, client } = streamClient([chunk(100, 10), chunk(100, 20)]);
    const result = await client.streamSynthesize("speech");
    for await (const _data of result.pcmStream) break;
    expect(body.locked).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "cancelled",
      partial: true,
      usage: "partial",
      counts: { input: 100, response: 10 },
    });
  });

  it("keeps the last usage on malformed stream data and releases the reader before first audio too", async () => {
    const records = capture();
    const { body, client } = streamClient([chunk(100, 10), "broken-json"]);
    const result = await client.streamSynthesize("speech");
    await expect(
      (async () => {
        for await (const _data of result.pcmStream) {
          /* consume */
        }
      })()
    ).rejects.toThrow();
    expect(body.locked).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "error", partial: true, counts: { response: 10 } });
    const broken = streamClient(["broken-json"]);
    await expect(broken.client.streamSynthesize("speech")).rejects.toThrow();
    expect(broken.body.locked).toBe(false);
    expect(records[1]).toMatchObject({ outcome: "error", usage: "missing" });
  });

  it("captures no-audio response usage before validation rejects it", async () => {
    const records = capture();
    const { client } = streamClient([chunk(100, 10, false)]);
    await expect(client.streamSynthesize("speech")).rejects.toThrow("no audio");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "response",
      partial: false,
      counts: { response: 10 },
    });
  });

  it("captures transcription and non-streaming synthesis, including validation and transport errors", async () => {
    const records = capture();
    const client = createGeminiSpeechClient({
      apiKey: "synthetic-key",
      fetchImpl: (async () => Response.json(chunk(100, 10, false))) as typeof fetch,
    });
    expect(await client.transcribe(Buffer.from("audio"), "audio/webm")).toBe("no audio");
    await expect(client.synthesize("speech")).rejects.toThrow("no audio");
    const failed = createGeminiSpeechClient({
      apiKey: "synthetic-key",
      fetchImpl: (async () => {
        throw new Error("transport failure");
      }) as typeof fetch,
    });
    await expect(failed.transcribe(Buffer.from("audio"), "audio/webm")).rejects.toThrow(
      "transport failure"
    );
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      purpose: "speech_transcription",
      outcome: "response",
      counts: { input: 100 },
    });
    expect(records[1]).toMatchObject({
      purpose: "speech_synthesis",
      outcome: "response",
      counts: { input: 100 },
    });
    expect(records[2]).toMatchObject({
      purpose: "speech_transcription",
      outcome: "error",
      usage: "missing",
    });
  });
});
