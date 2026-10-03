// Synthetic harness validation only: fake Chrome microphone + scripted recognizer.
// No remote recognizer, real speech, Android device or actor delivery is exercised.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const require = createRequire(resolve("packages/rusa/package.json"));
const { chromium } = require("@playwright/test");
const scratch = await mkdtemp(resolve(tmpdir(), "662-synthetic-"));
// Four seconds of generated 440 Hz tone, mono signed 16-bit PCM; no human voice.
const wav = Buffer.alloc(44 + 16000 * 4 * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24);
wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 64000; i++)
  wav.writeInt16LE(Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), 44 + i * 2);
const fakeAudio = resolve(scratch, "tone.wav");
await writeFile(fakeAudio, wav);
const types = {
  ".html": "text/html",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
};
const files = ["index.html", "spike.mjs", "sw.js", "manifest.webmanifest", "icon.svg"];
const server = createServer(async (req, res) => {
  const name = req.url === "/" ? "index.html" : req.url.slice(1);
  if (!files.includes(name)) {
    res.writeHead(404).end();
    return;
  }
  const ext = name.slice(name.lastIndexOf("."));
  res.setHeader("Content-Type", types[ext]);
  res.end(await readFile(new URL(name, import.meta.url)));
});
await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
const url = `http://127.0.0.1:${server.address().port}/`;
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    args: [
      "--no-sandbox",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${fakeAudio}`,
    ],
  });
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.click("#probe");
  await page.waitForFunction(() =>
    document.getElementById("support").textContent.includes("available")
  );
  const snapshot = () => page.locator("#report").textContent().then(JSON.parse);
  const completed = () =>
    page.waitForFunction(() => document.getElementById("status").textContent.includes("completed"));
  await page.click("#start");
  await page.locator("#stop").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.getElementById("stop").disabled);
  await page.waitForTimeout(300);
  await page.click("#stop");
  await completed();
  await page.waitForFunction(
    () =>
      typeof JSON.parse(document.getElementById("report").textContent).trials[0].audio?.decode ===
      "object"
  );
  const baseline = await snapshot();
  assert.ok(baseline.trials[0].audio.bytes > 0);
  assert.ok(baseline.trials[0].audio.decode.durationSeconds > 0);
  assert.ok(baseline.trials[0].audio.decode.rms > 0.1);
  assert.equal(baseline.actorDispatches, 0);
  const baselineReceipt = {
    browser: browser.version(),
    capabilities: baseline.capabilities,
    audio: baseline.trials[0].audio,
    localProbe: baseline.localProbe,
  };
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() =>
    document.getElementById("report").textContent.includes("662-spike-v1")
  );
  await context.close();

  // Use a fresh document so the module captures the fake constructor.
  const fakeContext = await browser.newContext({ permissions: ["microphone"] });
  await fakeContext.addInitScript(() => {
    class FakeRecognition extends EventTarget {
      constructor() {
        super();
        if (!window.omitLocalSupport) this.processLocally = false;
        window.fakeRecognition = this;
      }
      start() {
        this.dispatchEvent(new Event("start"));
      }
      result(text, final = false) {
        const e = new Event("result");
        const item = [{ transcript: text }];
        item.isFinal = final;
        e.results = text ? [item] : [];
        e.resultIndex = 0;
        this.dispatchEvent(e);
      }
      stop() {
        setTimeout(() => this.result("eleven paper boats", true), 10);
        setTimeout(() => this.dispatchEvent(new Event("end")), 20);
      }
      abort() {
        this.dispatchEvent(new Event("end"));
      }
    }
    window.SpeechRecognition = FakeRecognition;
  });
  const fakePage = await fakeContext.newPage();
  fakePage.on("pageerror", (error) => errors.push(error.message));
  await fakePage.goto(url);
  const fakeSnapshot = () => fakePage.locator("#report").textContent().then(JSON.parse);
  await fakePage.selectOption("#mode", "browser");
  for (let i = 0; i < 3; i++) {
    await fakePage.click("#start");
    await fakePage.waitForFunction(() => !document.getElementById("stop").disabled);
    await fakePage.click("#mark");
    await fakePage.evaluate(() => window.fakeRecognition.result("seven paper boats"));
    assert.equal(await fakePage.locator("#preview").textContent(), "seven paper boats");
    await fakePage.evaluate(() => window.fakeRecognition.result(""));
    assert.equal(await fakePage.locator("#preview").textContent(), "No transcript yet");
    await fakePage.evaluate(() => window.fakeRecognition.result("eleven boats"));
    await fakePage.click("#stop");
    await fakePage.waitForFunction(() =>
      document.getElementById("status").textContent.includes("completed")
    );
    const r = (await fakeSnapshot()).trials.at(-1);
    assert.equal(r.previewAtStop, "eleven boats");
    assert.equal(r.finalRecognition, "eleven paper boats");
    assert.equal(r.resultEventsAfterStop, 1);
    assert.equal(r.firstPartialBeforeStop, true);
    assert.ok(r.firstPartialFromManualOnsetMs >= 0);
  }
  await fakePage.click("#start");
  await fakePage.waitForFunction(() => !document.getElementById("stop").disabled);
  await fakePage.click("#cancel");
  await fakePage.waitForFunction(() =>
    document.getElementById("status").textContent.includes("cancelled")
  );
  assert.equal((await fakeSnapshot()).trials.at(-1).audio, null);
  assert.equal(await fakePage.locator("#clip").isVisible(), false);
  // Early recognition termination must leave the independent recorder alive.
  await fakePage.click("#start");
  await fakePage.waitForFunction(() => !document.getElementById("stop").disabled);
  await fakePage.evaluate(() => window.fakeRecognition.dispatchEvent(new Event("end")));
  assert.ok((await fakeSnapshot()).trials.at(-1).phase.includes("recorder continues"));
  assert.equal(await fakePage.locator("#stop").isEnabled(), true);
  await fakePage.click("#stop");
  await fakePage.waitForFunction(() =>
    document.getElementById("status").textContent.includes("completed")
  );
  // A missing local-required property must fail before microphone acquisition.
  await fakePage.evaluate(() => {
    window.omitLocalSupport = true;
  });
  await fakePage.selectOption("#mode", "local");
  await fakePage.click("#start");
  await fakePage.waitForFunction(() =>
    document.getElementById("status").textContent.includes("cancelled")
  );
  const unsupported = (await fakeSnapshot()).trials.at(-1);
  assert.ok(
    unsupported.events.some(
      (e) => e.type === "start-error" && e.error.includes("no remote fallback")
    )
  );
  assert.equal(unsupported.recorderStartMs, undefined);
  // Cancel during microphone acquisition: release any late stream, no revival.
  await fakePage.evaluate(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (options) => {
      const stream = await getUserMedia(options);
      window.delayedStream = stream;
      return new Promise((release) => {
        window.releaseMic = () => release(stream);
      });
    };
  });
  await fakePage.selectOption("#mode", "recorder");
  await fakePage.click("#start");
  await fakePage.waitForFunction(() => Boolean(window.releaseMic));
  await fakePage.click("#cancel");
  await fakePage.evaluate(() => window.releaseMic());
  await fakePage.waitForFunction(() =>
    window.delayedStream.getTracks().every((t) => t.readyState === "ended")
  );
  const stale = (await fakeSnapshot()).trials.at(-1);
  assert.equal(stale.cancelled, true);
  assert.equal(stale.audio, null);
  assert.ok(stale.events.some((e) => e.type === "stale-acquisition-released"));
  const fakeReceipt = await fakeSnapshot();
  assert.ok(fakeReceipt.trials.every((r) => r.actorDispatches === 0));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        scope: "synthetic desktop harness only",
        baseline: baselineReceipt,
        scriptedTrials: fakeReceipt.trials.length,
        assertions: [
          "real MediaRecorder nonempty/decodable fake-mic clip",
          "3 start/stop cycles",
          "interim removal",
          "post-stop final revision",
          "cancel discards clip",
          "early recognition end keeps recording",
          "local-required unsupported fails closed",
          "cancel during acquisition releases late stream",
          "zero actor dispatch",
          "service worker serves harness on offline reload",
        ],
      },
      null,
      2
    )
  );
} finally {
  await browser?.close();
  await new Promise((resolveClosed) => server.close(resolveClosed));
  await rm(scratch, { recursive: true, force: true });
}
