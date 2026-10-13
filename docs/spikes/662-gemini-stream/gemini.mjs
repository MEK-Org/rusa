import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

export const MODEL = "gemini-3.5-transcribe-live";
export const MAX_SECONDS = 240;
const MAX_BUFFER = 128 * 1024;

// One manual activity per recording: partial hypotheses replace, one final replaces them.
export class GeminiRecording extends EventEmitter {
  constructor({
    apiKey,
    socketFactory = (url) => new WebSocket(url, { maxPayload: 65536 }),
    finalMs = 15000,
  }) {
    super();
    this.phase = "connecting";
    this.samples = 0;
    this.finalMs = finalMs;
    this.finalText = null;
    this.generationComplete = false;
    this.endOffset = null;
    this.started = performance.now();
    this.firstPartial = null;
    this.ws = socketFactory(
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`
    );
    this.timer = setTimeout(() => this.fail("Provider setup timed out"), 10000);
    this.ws.on("open", () =>
      this.send({
        setup: {
          model: `models/${MODEL}`,
          generationConfig: { responseModalities: ["TEXT"] },
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
          inputAudioTranscription: { mode: "VERBATIM", languageCodes: ["en-US"] },
        },
      })
    );
    this.ws.on("message", (bytes) => {
      try {
        this.receive(JSON.parse(bytes.toString()));
      } catch {
        this.fail("Invalid provider response");
      }
    });
    // Do not echo errors: WebSocket errors may contain the credential-bearing URL.
    this.ws.on("error", () => this.fail("Provider connection failed"));
    this.ws.on("close", () => {
      if (!["done", "cancelled", "error"].includes(this.phase))
        this.fail("Provider disconnected before completion");
    });
  }
  send(message) {
    if (this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > MAX_BUFFER) {
      this.fail("Provider audio queue overflow or disconnected");
      return false;
    }
    this.ws.send(JSON.stringify(message));
    return true;
  }
  receive(message) {
    if (["done", "cancelled", "error"].includes(this.phase)) return;
    if (message.error || message.goAway) return this.fail("Provider rejected or ended the session");
    if (message.setupComplete && this.phase === "connecting") {
      clearTimeout(this.timer);
      this.phase = "recording";
      this.send({ realtimeInput: { activityStart: {} } });
      this.timer = setTimeout(
        () => this.fail("Four-minute prototype limit reached; recording is incomplete"),
        MAX_SECONDS * 1000
      );
      this.emit("update", { type: "ready", model: MODEL, maxSeconds: MAX_SECONDS });
    }
    const content = message.serverContent;
    if (content?.interimInputTranscription) {
      const text = content.interimInputTranscription.text;
      if (typeof text !== "string" || text.length > 32768)
        return this.fail("Transcript exceeds prototype limit");
      this.firstPartial ??= performance.now() - this.started;
      this.emit("update", { type: "partial", text, firstPartialMs: Math.round(this.firstPartial) });
    }
    if (content?.inputTranscription) {
      if (this.phase !== "finalizing" || this.finalText !== null)
        return this.fail("Unexpected transcription boundary; completeness is unverified");
      const text = content.inputTranscription.text;
      if (typeof text !== "string" || text.length > 32768)
        return this.fail("Invalid final transcript");
      this.finalText = text;
      this.emit("update", { type: "final-text", text });
    }
    if (this.phase === "finalizing") {
      if (content?.generationComplete) this.generationComplete = true;
      if (message.voiceActivity?.type === "ACTIVITY_END") {
        const raw = message.voiceActivity.audioOffset;
        this.endOffset =
          typeof raw === "string" && /^\d+(\.\d+)?s$/.test(raw) ? Number(raw.slice(0, -1)) : NaN;
        if (!Number.isFinite(this.endOffset))
          return this.fail("Invalid provider final audio boundary");
      }
      // The STT model emits no turnComplete. Require all three observed signals,
      // in any order, and the terminal audio offset matching every accepted sample.
      if (this.finalText !== null && this.generationComplete && this.endOffset !== null) {
        // Seconds use decimal floating point; compare the nearest PCM sample.
        if (Math.round(this.endOffset * 16000) !== this.samples)
          return this.fail("Provider final boundary does not cover accepted audio");
        this.phase = "done";
        clearTimeout(this.timer);
        this.emit("update", {
          type: "complete",
          text: this.finalText,
          samples: this.samples,
          stopToFinalMs: Math.round(performance.now() - this.stopped),
          firstPartialMs: this.firstPartial === null ? null : Math.round(this.firstPartial),
        });
        this.ws.close();
      }
    }
  }
  audio(bytes) {
    if (this.phase !== "recording" || !bytes.length || bytes.length > 3200 || bytes.length % 2)
      return this.fail("Invalid audio frame or recording phase");
    if (this.samples + bytes.length / 2 > MAX_SECONDS * 16000)
      return this.fail("Four-minute prototype audio limit reached");
    this.samples += bytes.length / 2;
    this.send({
      realtimeInput: {
        audio: { data: bytes.toString("base64"), mimeType: "audio/pcm;rate=16000" },
      },
    });
  }
  stop(samples) {
    if (this.phase !== "recording" || !Number.isSafeInteger(samples) || samples !== this.samples)
      return this.fail("Stop audio boundary mismatch");
    this.phase = "finalizing";
    this.stopped = performance.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.fail("Final transcript acknowledgement timed out; recording is incomplete"),
      this.finalMs
    );
    this.send({ realtimeInput: { activityEnd: {} } });
  }
  cancel() {
    if (["done", "cancelled", "error"].includes(this.phase)) return;
    this.phase = "cancelled";
    clearTimeout(this.timer);
    this.ws.close();
  }
  fail(reason) {
    if (["done", "cancelled", "error"].includes(this.phase)) return;
    this.phase = "error";
    clearTimeout(this.timer);
    this.emit("update", { type: "error", message: reason });
    if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
    else this.ws.close();
  }
}
