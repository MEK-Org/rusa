import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { GeminiRecording } from "./gemini.mjs";

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  terminate() {
    this.close();
  }
}
function fixture(options = {}) {
  const socket = new Socket();
  const recording = new GeminiRecording({
    apiKey: "synthetic-test-key",
    socketFactory: () => socket,
    ...options,
  });
  const events = [];
  recording.on("update", (e) => events.push(e));
  socket.emit("open");
  socket.emit("message", JSON.stringify({ setupComplete: {} }));
  return { socket, recording, events, receive: (m) => socket.emit("message", JSON.stringify(m)) };
}
test("silence and repeated hypotheses stay live; Stop needs final text + generation + matching end offset", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 300; i++) f.recording.audio(Buffer.alloc(3200));
    f.receive({ serverContent: { interimInputTranscription: { text: "blue" } } });
    f.receive({ serverContent: { interimInputTranscription: { text: "blue blue" } } });
    assert.equal(f.recording.phase, "recording");
    assert.equal(f.socket.sent.filter((m) => m.realtimeInput?.activityEnd).length, 0);
    f.recording.stop(480000);
    f.receive({ serverContent: { generationComplete: true } });
    f.receive({ voiceActivity: { type: "ACTIVITY_END", audioOffset: "30s" } });
    assert.equal(f.recording.phase, "finalizing");
    f.receive({ serverContent: { inputTranscription: { text: "blue blue" } } });
    assert.equal(f.recording.phase, "done");
    assert.equal(f.events.at(-1).text, "blue blue");
    assert.equal(f.events.filter((e) => e.type === "complete").length, 1);
    f.receive({ serverContent: { inputTranscription: { text: "late" } } });
    assert.equal(f.events.at(-1).text, "blue blue");
  } finally {
    f.recording.cancel();
  }
});
test("mismatched boundary and bare connection closure never label text complete", () => {
  const f = fixture();
  f.recording.audio(Buffer.alloc(3200));
  f.recording.stop(1600);
  f.receive({
    serverContent: { inputTranscription: { text: "text" }, generationComplete: true },
    voiceActivity: { type: "ACTIVITY_END", audioOffset: "0.05s" },
  });
  assert.equal(f.events.at(-1).type, "error");
  assert.match(f.events.at(-1).message, /boundary/);
  const fractional = fixture();
  fractional.recording.audio(Buffer.alloc(2));
  fractional.recording.stop(1);
  fractional.receive({
    serverContent: { inputTranscription: { text: "verified" }, generationComplete: true },
    voiceActivity: { type: "ACTIVITY_END", audioOffset: "0.000062500s" },
  });
  assert.equal(fractional.recording.phase, "done");
  for (const audioOffset of [undefined, "invalid", `${"9".repeat(400)}s`, "0.100062500s"]) {
    const invalid = fixture();
    invalid.recording.audio(Buffer.alloc(3200));
    invalid.recording.stop(1600);
    invalid.receive({
      serverContent: { inputTranscription: { text: "unverified" }, generationComplete: true },
      voiceActivity: { type: "ACTIVITY_END", audioOffset },
    });
    assert.equal(invalid.recording.phase, "error");
    assert.equal(
      invalid.events.some((e) => e.type === "complete"),
      false
    );
    invalid.recording.cancel();
  }
  const g = fixture();
  g.recording.audio(Buffer.alloc(3200));
  g.recording.stop(1600);
  g.receive({ serverContent: { inputTranscription: { text: "unacknowledged" } } });
  g.socket.close();
  assert.equal(g.events.at(-1).type, "error");
  assert.equal(
    g.events.some((e) => e.type === "complete"),
    false
  );
});
test("missing finalization acknowledgement fails on timeout, including silence-only input", async () => {
  const f = fixture({ finalMs: 10 });
  f.recording.audio(Buffer.alloc(3200));
  f.recording.stop(1600);
  f.receive({ voiceActivity: { type: "ACTIVITY_END", audioOffset: "0.1s" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.recording.phase, "error");
  assert.match(f.events.at(-1).message, /timed out/);
});
test("Cancel while finalizing wins over late responses and emits no completion", () => {
  const f = fixture();
  f.recording.audio(Buffer.alloc(3200));
  f.recording.stop(1600);
  f.recording.cancel();
  f.receive({
    serverContent: { inputTranscription: { text: "late" }, generationComplete: true },
    voiceActivity: { type: "ACTIVITY_END", audioOffset: "0.1s" },
  });
  assert.equal(f.recording.phase, "cancelled");
  assert.equal(
    f.events.some((e) => e.type === "complete"),
    false
  );
});
test("audio gap, overflow, premature final and duplicate final fail visibly", () => {
  const f = fixture();
  f.recording.audio(Buffer.alloc(2));
  f.recording.stop(0);
  assert.match(f.events.at(-1).message, /mismatch/);
  const g = fixture();
  g.socket.bufferedAmount = 200000;
  g.recording.audio(Buffer.alloc(3200));
  assert.equal(g.recording.phase, "error");
  const h = fixture();
  h.receive({ serverContent: { inputTranscription: { text: "premature" } } });
  assert.equal(h.recording.phase, "error");
  const j = fixture();
  j.recording.audio(Buffer.alloc(2));
  j.recording.stop(1);
  j.receive({ serverContent: { inputTranscription: { text: "first" } } });
  j.receive({ serverContent: { inputTranscription: { text: "second" } } });
  assert.equal(j.recording.phase, "error");
});
