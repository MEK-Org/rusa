// Standalone feasibility evidence, outside the rusa dashboard and delivery path.
const $ = (id) => document.getElementById(id);
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const trials = [];
let active = null;
let audioUrl = null;
let support = {};
const displayMode = () =>
  ["standalone", "fullscreen", "minimal-ui", "browser"].find(
    (mode) => matchMedia(`(display-mode: ${mode})`).matches
  ) || "unknown";
const capabilities = () => {
  const recognition = Recognition ? new Recognition() : null;
  return {
    secureContext: isSecureContext,
    userAgent: navigator.userAgent,
    displayMode: displayMode(),
    mediaRecorder: typeof MediaRecorder !== "undefined",
    recognition: Boolean(recognition),
    processLocally: recognition ? "processLocally" in recognition : false,
    available: typeof Recognition?.available === "function",
    install: typeof Recognition?.install === "function",
    // A property probe proves support surface, not processing location.
    processingPath: "UNTESTED: requires local-required/offline or service evidence",
  };
};
const initialCapabilities = capabilities();
function render() {
  const r = trials.at(-1);
  $("start").disabled = Boolean(active) || trials.length >= 20;
  $("cancel").disabled = !active || active.stopping;
  $("stop").disabled = !active?.recorder || active.stopping;
  $("mark").disabled = !active?.recorder || active.stopping;
  for (const id of ["mode", "order", "language", "probe", "install"])
    $(id).disabled = Boolean(active);
  $("status").textContent = r ? `Trial ${r.id}: ${r.phase}` : "Idle";
  $("preview").textContent = r?.preview || "No transcript yet";
  $("report").textContent = JSON.stringify(report(), null, 2);
}
function report() {
  return {
    format: "662-spike-v1",
    fixtureVersion: self.FIXTURE_VERSION,
    servedCheckoutSha: $("revision").value || "UNTESTED",
    device: $("device").value || "UNTESTED",
    network: $("network").value,
    capabilities: { ...initialCapabilities, displayMode: displayMode() },
    localProbe: support,
    actorDispatches: 0,
    trials,
  };
}
function event(s, type, data = {}) {
  const entry = { ms: Math.round(performance.now() - s.origin), type, ...data };
  if (s.r.events.length < 500) s.r.events.push(entry);
  else s.r.droppedEvents++;
  render();
  return entry.ms;
}
async function probe(install = false) {
  const method = install ? "install" : "available";
  const options = { langs: [$("language").value], processLocally: true };
  try {
    support = {
      options,
      [method]: Recognition?.[method] ? await Recognition[method](options) : "unsupported",
    };
  } catch (error) {
    support = { options, [method]: `ERROR: ${error.name}: ${error.message}` };
  }
  $("support").textContent = JSON.stringify(support, null, 2);
  render();
}
function stopTracks(s) {
  for (const track of s.stream?.getTracks() || []) track.stop();
}
function maybeFinish(s) {
  if (!s.stopping || !s.recorderEnded || !s.recognitionEnded || s.finishing) return;
  s.finishing = true;
  clearTimeout(s.deadline);
  clearTimeout(s.drain);
  clearTimeout(s.recorderDrain);
  stopTracks(s);
  s.r.finalRecognition = s.r.results
    .filter((v) => v.final)
    .map((v) => v.text)
    .join(" ");
  s.r.pendingInterimAtEnd = s.r.results
    .filter((v) => !v.final)
    .map((v) => v.text)
    .join(" ");
  s.r.phase = s.r.cancelled
    ? "cancelled: clip discarded"
    : s.r.recognitionIncomplete ||
        s.r.recorderTimedOut ||
        s.r.pendingInterimAtEnd ||
        s.r.droppedEvents
      ? "incomplete: deadline/error; review diagnostics"
      : "completed: review final revisions";
  if (!s.r.cancelled && !s.r.recorderTimedOut && s.chunks.length) {
    const blob = new Blob(s.chunks, { type: s.recorder.mimeType });
    s.r.audio = {
      bytes: blob.size,
      mimeType: blob.type,
      listeningCheck: "UNTESTED",
      decode: "UNTESTED",
    };
    audioUrl = URL.createObjectURL(blob);
    $("audio").src = audioUrl;
    $("clip").href = audioUrl;
    $("clip").download = `662-trial-${s.r.id}.${blob.type.includes("mp4") ? "mp4" : "webm"}`;
    $("clip").hidden = false;
    // Decoder/hash failures are evidence, not a claim of corrupt audio.
    void inspectAudio(s, blob);
  }
  s.chunks = [];
  active = null;
  render();
}
async function inspectAudio(s, blob) {
  let context;
  try {
    const bytes = await blob.arrayBuffer();
    s.r.audio.sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    context = new AudioContext();
    const audio = await context.decodeAudioData(bytes);
    const channel = audio.getChannelData(0);
    let sum = 0;
    let peak = 0;
    for (const sample of channel) {
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    s.r.audio.decode = {
      durationSeconds: audio.duration,
      sampleRate: audio.sampleRate,
      channels: audio.numberOfChannels,
      rms: Math.sqrt(sum / channel.length),
      peak,
    };
  } catch (error) {
    s.r.audio.decode = `ERROR: ${error.name}: ${error.message}`;
  } finally {
    await context?.close();
    render();
  }
}
function stop(cancelled = false, reason = "user") {
  const s = active;
  if (!s || s.stopping) return;
  s.stopping = true;
  s.r.cancelled = cancelled;
  s.r.previewAtStop = s.r.preview;
  s.r.stopMs = event(s, cancelled ? "cancel" : "stop", { reason });
  s.r.phase = cancelled ? "cancelling" : "awaiting recorder stop and recognition end";
  // The recorder's own stop event is authoritative; bound a separate failure.
  s.recorderDrain = setTimeout(() => {
    if (s.recorderEnded) return;
    s.r.recorderTimedOut = true;
    s.chunks = [];
    s.recorderEnded = true;
    event(s, "recorder-stop-timeout", { audioDiscarded: true });
    stopTracks(s);
    maybeFinish(s);
  }, 10000);
  s.drain = setTimeout(() => {
    if (s.recognitionEnded) return;
    s.r.recognitionIncomplete = true;
    s.r.phase = "incomplete: recognition deadline; awaiting recorder";
    closeRecognition(s, "drain-timeout");
    event(s, "drain-timeout", { recorderEnded: s.recorderEnded });
    try {
      s.recognition?.abort();
    } catch {
      /* The accepted summary is already frozen. */
    }
    maybeFinish(s);
  }, 5000);
  if (!s.recorder)
    s.recorderEnded = true; // Pending acquisition releases its stale stream below.
  else if (s.recorder.state !== "inactive") s.recorder.stop();
  if (!s.recognitionEnded) {
    try {
      cancelled ? s.recognition.abort() : s.recognition.stop();
    } catch (error) {
      s.r.recognitionIncomplete = true;
      closeRecognition(s, "stop-error");
      event(s, "recognition-stop-error", { error: error.message });
    }
  }
  maybeFinish(s);
  render();
}
function closeRecognition(s, reason) {
  s.acceptingResults = false;
  s.recognitionEnded = true;
  s.r.recognitionSummaryBoundary = { reason, ms: Math.round(performance.now() - s.origin) };
}
function attachRecognition(s) {
  const r = s.r;
  for (const type of [
    "start",
    "audiostart",
    "soundstart",
    "speechstart",
    "speechend",
    "soundend",
    "audioend",
    "nomatch",
  ]) {
    s.recognition.addEventListener(type, () => event(s, `recognition-${type}`));
  }
  s.recognition.addEventListener("result", (e) => {
    const accepted = s.acceptingResults;
    const ms = event(s, accepted ? "recognition-result" : "late-recognition-result", {
      resultIndex: e.resultIndex,
      results: Array.from(e.results, (v) => ({ text: v[0].transcript, final: v.isFinal })),
    });
    if (!accepted) return;
    // Each event is the COMPLETE current result list. Interim entries can be removed/revised.
    r.results = Array.from(e.results, (v) => ({ text: v[0].transcript, final: v.isFinal }));
    r.preview = r.results.map((v) => v.text).join(" ");
    r.firstResultMs ??= ms;
    if (r.results.some((v) => !v.final) && r.firstPartialMs === null) {
      r.firstPartialMs = ms;
      r.firstPartialBeforeStop = !s.stopping;
      if (r.manualSpeechOnsetMs !== null)
        r.firstPartialFromManualOnsetMs = ms - r.manualSpeechOnsetMs;
    }
    if (s.stopping) r.resultEventsAfterStop++;
    render();
  });
  s.recognition.addEventListener("error", (e) => {
    if (s.acceptingResults) r.recognitionIncomplete = true;
    event(s, "recognition-error", { code: e.error, message: e.message });
  });
  s.recognition.addEventListener("end", () => {
    if (!s.acceptingResults) {
      event(s, "late-recognition-end");
      return;
    }
    closeRecognition(s, "end");
    r.recognitionEndMs = event(s, "recognition-end");
    if (!s.stopping) r.phase = "recognition ended early; recorder continues (no auto-restart)";
    maybeFinish(s);
    render();
  });
}
function startRecognition(s) {
  const r = s.r;
  try {
    s.recognitionEnded = false;
    s.acceptingResults = true;
    r.recognitionStartCallMs = event(s, "recognition-start-call");
    s.recognition.start();
  } catch (error) {
    s.r.recognitionIncomplete = true;
    closeRecognition(s, "start-error");
    event(s, "recognition-start-error", { error: error.message });
    r.phase = "recognition unavailable; recorder continues";
  }
}
async function start() {
  if (active || trials.length >= 20) return;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  $("audio").removeAttribute("src");
  $("clip").hidden = true;
  $("integrity").value = "UNTESTED";
  for (const id of ["notes", "batch", "batchSource"]) $(id).value = "";
  const r = {
    id: trials.length + 1,
    startedAt: new Date().toISOString(),
    mode: $("mode").value,
    language: $("language").value,
    acquisitionOrder: $("order").value,
    fixtureVersion: self.FIXTURE_VERSION,
    servedCheckoutSha: $("revision").value || "UNTESTED",
    device: $("device").value || "UNTESTED",
    network: $("network").value,
    navigatorOnline: navigator.onLine,
    localProbe: structuredClone(support),
    displayMode: displayMode(),
    phase: "acquiring microphone",
    results: [],
    preview: "",
    previewAtStop: null,
    finalRecognition: null,
    firstResultMs: null,
    firstPartialMs: null,
    manualSpeechOnsetMs: null,
    firstPartialFromManualOnsetMs: null,
    firstPartialBeforeStop: null,
    resultEventsAfterStop: 0,
    droppedEvents: 0,
    events: [],
    audio: null,
    batchTranscript: "UNTESTED",
    batchSource: "UNTESTED",
    processingPath: "UNTESTED",
    actorDispatches: 0,
  };
  trials.push(r);
  const s = {
    r,
    origin: performance.now(),
    chunks: [],
    recognitionEnded: true,
    recorderEnded: false,
  };
  active = s;
  render();
  s.deadline = setTimeout(() => stop(false, "60-second bound"), 60000);
  try {
    if (r.mode !== "recorder") {
      if (!Recognition)
        throw new Error("SpeechRecognition unsupported; run recorder-only baseline");
      s.recognition = new Recognition();
      if (r.mode === "local" && !("processLocally" in s.recognition)) {
        throw new Error("Local-required recognition unsupported; no remote fallback attempted");
      }
      s.recognition.lang = r.language;
      s.recognition.continuous = true;
      s.recognition.interimResults = true;
      if ("processLocally" in s.recognition) s.recognition.processLocally = r.mode === "local";
      r.processLocally =
        "processLocally" in s.recognition ? s.recognition.processLocally : "unsupported";
    }
    if (s.recognition) {
      attachRecognition(s);
      if (r.acquisitionOrder === "recognizer-first") startRecognition(s);
    }
    r.recorderAcquireCallMs = event(s, "recorder-acquire-call");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (active !== s || s.stopping) {
      for (const track of stream.getTracks()) track.stop();
      event(s, "stale-acquisition-released");
      return;
    }
    s.stream = stream;
    for (const track of stream.getTracks()) {
      for (const type of ["mute", "unmute", "ended"])
        track.addEventListener(type, () => event(s, `track-${type}`));
    }
    const mimeType = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ].find((mime) => MediaRecorder.isTypeSupported(mime));
    s.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    s.recorder.addEventListener("dataavailable", (e) => {
      if (!s.finishing && !r.cancelled && e.data.size) s.chunks.push(e.data);
      event(s, "recorder-data", { bytes: e.data.size });
    });
    s.recorder.addEventListener("error", (e) => {
      event(s, "recorder-error", { error: e.error?.message || "unspecified" });
      stop(true, "recorder-error");
    });
    s.recorder.addEventListener("stop", () => {
      s.recorderEnded = true;
      event(s, "recorder-end");
      maybeFinish(s);
    });
    s.recorder.start(); // Same non-timesliced capture as WebVoiceRecorder.
    r.recorderStartMs = event(s, "recorder-start");
    r.phase =
      s.recognition && s.recognitionEnded && r.recognitionStartCallMs !== undefined
        ? "recognition ended early; recorder continues (no auto-restart)"
        : "recording";
    if (s.recognition && r.acquisitionOrder === "recorder-first") startRecognition(s);
    render();
  } catch (error) {
    event(s, "start-error", { error: `${error.name}: ${error.message}` });
    if (active === s) stop(true, "start-error");
  }
}
$("start").onclick = start;
$("stop").onclick = () => stop();
$("cancel").onclick = () => stop(true);
$("mark").onclick = () => {
  if (active && active.r.manualSpeechOnsetMs === null)
    active.r.manualSpeechOnsetMs = event(active, "manual-speech-onset");
};
$("probe").onclick = () => probe();
$("install").onclick = () => probe(true);
$("annotate").onclick = () => {
  if (active) return;
  const r = trials.at(-1);
  if (!r) return;
  if (r.audio) r.audio.listeningCheck = $("integrity").value;
  r.notes = $("notes").value;
  r.batchTranscript = $("batch").value || "UNTESTED";
  r.batchSource = $("batchSource").value || "UNTESTED";
  render();
};
$("export").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report(), null, 2)], { type: "application/json" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "662-synthetic-report.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.addEventListener("visibilitychange", () => {
  if (active) event(active, "visibilitychange", { visibility: document.visibilityState });
});
window.addEventListener("pagehide", () => {
  const s = active;
  if (s) {
    stop(true, "pagehide");
    stopTracks(s);
  }
});
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((error) => {
    $("support").textContent = `Service worker registration failed: ${error.message}`;
  });
}
$("fixture-version").textContent = self.FIXTURE_VERSION;
render();
