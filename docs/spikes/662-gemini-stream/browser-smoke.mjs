import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chromium } from "@playwright/test";
import { createSpike } from "./server.mjs";

// Scripted provider responses exercise the real browser audio path without API calls.
class ScriptedRecording extends EventEmitter {
  samples = 0;
  constructor() {
    super();
    setImmediate(() =>
      this.emit("update", { type: "ready", model: "scripted-provider", maxSeconds: 240 })
    );
  }
  audio(bytes) {
    this.samples += bytes.length / 2;
    if (this.samples === 1600)
      this.emit("update", { type: "partial", text: "blue", firstPartialMs: 0 });
    if (this.samples === 3200)
      this.emit("update", { type: "partial", text: "blue blue", firstPartialMs: 0 });
  }
  stop(samples) {
    assert.equal(samples, this.samples);
    // Emit after Cancel too; socket closure keeps this response from reaching the page.
    this.timer = setTimeout(
      () =>
        this.emit("update", {
          type: "complete",
          text: "blue blue",
          samples,
          firstPartialMs: 0,
          stopToFinalMs: 1500,
        }),
      1500
    );
  }
  cancel() {}
}
const recordings = [];
const spike = createSpike({
  apiKey: "synthetic-test-key",
  recordingFactory: () => {
    const r = new ScriptedRecording();
    recordings.push(r);
    return r;
  },
});
await new Promise((resolve) => spike.server.listen(0, "127.0.0.1", resolve));
let browser;
const checks = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    acceptDownloads: true,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.micCalls = 0;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (options) => {
      window.micCalls++;
      window.micStream = await original(options);
      return window.micStream;
    };
  });
  await page.goto(`http://127.0.0.1:${spike.server.address().port}/#${spike.token}`);
  await page.waitForFunction(() => !document.querySelector(".actor").disabled);
  assert.equal(await page.locator("#access").isVisible(), false);
  assert.equal(await page.evaluate(() => location.hash), "");
  const start = async () => {
    await page.locator('[data-target="blue-kite"]').click();
    await page.waitForFunction(
      () => document.querySelector("#transcript").textContent === "blue blue"
    );
  };
  await start();
  assert.equal(await page.locator('[data-target="orange-boat"]').isVisible(), false);
  assert.equal(await page.evaluate(() => window.micCalls), 1);
  await page.locator('[data-target="blue-kite"]').click();
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.startsWith("Stopped")
  );
  assert.equal(await page.locator("#transcript").textContent(), "blue blue");
  assert.equal(await page.locator('[data-target="orange-boat"]').isVisible(), true);
  checks.push(
    "actual native16k AudioWorklet frames; one mic acquisition; actor focus/stop/grid restore"
  );
  await start();
  await page.locator("#stop").click();
  await page.locator("#cancel").click();
  await page.waitForTimeout(1700);
  assert.equal(await page.locator("#status").textContent(), "Cancelled — no message sent");
  assert.match(await page.locator("#transcript").textContent(), /discarded/);
  checks.push("Cancel during finalization closes the connection and restores the grid");
  await start();
  await page.evaluate(() => {
    const track = window.micStream.getAudioTracks()[0];
    // stop() alone does not emit ended; model a device/permission loss notification.
    track.stop();
    track.dispatchEvent(new Event("ended"));
  });
  await page.waitForFunction(
    () =>
      document.querySelector("#status").textContent ===
      "Microphone ended unexpectedly; transcript is incomplete"
  );
  assert.equal(await page.locator("#stop").isEnabled(), false);
  assert.equal(await page.locator('[data-target="orange-boat"]').isVisible(), true);
  checks.push("unexpected microphone end fails visibly and restores the grid");
  await start();
  recordings.at(-1).emit("update", { type: "error", message: "Synthetic provider disconnect" });
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "Synthetic provider disconnect"
  );
  assert.equal(await page.locator("#stop").isEnabled(), false);
  assert.equal(await page.locator('[data-target="orange-boat"]').isVisible(), true);
  checks.push("provider disconnect visible; grid restored");
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Synthetic denial", "NotAllowedError");
    };
  });
  await page.locator('[data-target="blue-kite"]').click();
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "Microphone or audio capture failed"
  );
  assert.equal(await page.locator("#stop").isEnabled(), false);
  checks.push("mic denial restores controls");
  const pending = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await pending;
  assert.equal(download.suggestedFilename(), "662-gemini-stream-report.json");
  assert.deepEqual(errors, []);
  checks.push("diagnostic download; no browser errors");
  console.log(
    JSON.stringify({
      result: "PASS",
      kind: "scripted provider; actual Chromium audio path; real Gemini/phone UNTESTED by this command",
      checks,
    })
  );
} finally {
  for (const r of recordings) clearTimeout(r.timer);
  await browser?.close();
  await spike.close();
}
