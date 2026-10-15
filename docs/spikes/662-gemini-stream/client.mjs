const $ = (selector) => document.querySelector(selector);
const actors = [...document.querySelectorAll(".actor")];
let authorized = false;
let current = null;
const report = {
  fixture: "662-gemini-stream-v1",
  at: new Date().toISOString(),
  capabilities: {
    userAgent: navigator.userAgent,
    secureContext: isSecureContext,
    audioWorklet: typeof AudioWorkletNode !== "undefined",
    displayMode: matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser",
  },
  device: "UNTESTED: enter actual OS/device in the accompanying trial note",
  trials: [],
};
const status = (text, error = false) => {
  $("#status").textContent = text;
  $("#status").className = error ? "error" : "";
};
const terminal = (run) => ["done", "cancelled", "error"].includes(run.phase);
const log = (run, type, detail = {}) => {
  if (run.events.length < 1000)
    run.events.push({ ms: Math.round(performance.now() - run.started), type, ...detail });
  else run.logTruncated = true;
  $("#events").textContent = JSON.stringify(run.events.slice(-15), null, 2);
};
function render() {
  const busy = current && !terminal(current);
  $("#actors").classList.toggle("focused", Boolean(busy));
  for (const actor of actors) {
    actor.hidden = Boolean(busy && actor.dataset.target !== current.target);
    actor.classList.toggle("active", Boolean(busy && actor.dataset.target === current.target));
    actor.disabled = !authorized || Boolean(busy && current.phase !== "recording");
  }
  $("#stop").disabled = !busy || current.phase !== "recording";
  $("#cancel").disabled = !busy;
}
async function release(run) {
  for (const track of run.stream?.getTracks() ?? []) {
    track.onended = null;
    track.stop();
  }
  run.node?.disconnect();
  run.source?.disconnect();
  if (run.context && run.context.state !== "closed") await run.context.close().catch(() => {});
}
async function fail(run, message) {
  if (run !== current || terminal(run)) return;
  run.phase = "error";
  log(run, "error", { message });
  status(message, true);
  run.socket?.close();
  await release(run);
  render();
}
function sendFrame(run, bytes) {
  if (run !== current || !["recording", "flushing"].includes(run.phase)) return;
  if (run.socket.readyState !== WebSocket.OPEN || run.socket.bufferedAmount > 64000) {
    void fail(run, "Audio connection is too slow or disconnected; transcript is incomplete");
    return;
  }
  run.samples += bytes.byteLength / 2;
  run.frames++;
  run.socket.send(bytes);
  $("#frames").textContent = `${run.frames} audio frames`;
  // RMS on the actual transported PCM, without a second microphone capture.
  const view = new DataView(bytes);
  let power = 0;
  for (let i = 0; i < bytes.byteLength; i += 2) power += (view.getInt16(i, true) / 32768) ** 2;
  $("#level").style.width = `${Math.min(100, Math.sqrt(power / (bytes.byteLength / 2)) * 400)}%`;
}
async function capture(run) {
  if (run.captureStarting) return;
  run.captureStarting = true;
  try {
    run.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    if (run !== current || run.phase !== "connecting") {
      await release(run);
      return;
    }
    const tracks = run.stream.getAudioTracks();
    if (!tracks.length || tracks.some((track) => track.readyState !== "live"))
      throw new Error("Microphone already ended");
    for (const track of tracks)
      track.onended = () => {
        void fail(run, "Microphone ended unexpectedly; transcript is incomplete");
      };
    run.captureRate = tracks[0].getSettings().sampleRate ?? null;
    if (run.context.sampleRate !== 16000) throw new Error("Unsupported AudioContext sample rate");
    await run.context.audioWorklet.addModule("/capture.mjs");
    if (run !== current || run.phase !== "connecting") {
      await release(run);
      return;
    }
    run.node = new AudioWorkletNode(run.context, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
    });
    run.node.port.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) sendFrame(run, data);
      else if (data.flushed) run.flushResolve?.(data.samples);
    };
    run.source = run.context.createMediaStreamSource(run.stream);
    run.source.connect(run.node);
    // The worklet produces silence at its output, so this cannot echo the microphone.
    run.node.connect(run.context.destination);
    run.phase = "recording";
    run.recordingAt = performance.now();
    log(run, "capture-start", {
      inputSampleRate: run.captureRate,
      processingSampleRate: run.context.sampleRate,
      outputSampleRate: 16000,
      microphoneAcquisitions: 1,
    });
    status("Recording — pauses keep listening. Tap the actor again to stop.");
    render();
  } catch {
    await fail(run, "Microphone or audio capture failed");
  }
}
async function start(target) {
  if (!authorized || (current && !terminal(current))) return;
  const run = {
    target,
    phase: "connecting",
    started: performance.now(),
    events: [],
    samples: 0,
    frames: 0,
  };
  current = run;
  report.trials.push(run);
  // Only retain a bounded number of trials; explicit downloads contain private text.
  if (report.trials.length > 10) report.trials.shift();
  $("#transcript").textContent = "Connecting…";
  $("#transcript").classList.add("partial");
  $("#latency").textContent = "First text: — · Stop to final: —";
  $("#frames").textContent = "0 audio frames";
  status("Opening transcription connection");
  render();
  try {
    if (
      !isSecureContext ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioWorkletNode === "undefined"
    )
      throw new Error("unsupported");
    // Open/resume in the user gesture, before network and permission awaits.
    run.context = new AudioContext({ sampleRate: 16000 });
    await run.context.resume();
    if (run !== current || terminal(run)) return;
    run.socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/record`
    );
    run.socket.binaryType = "arraybuffer";
    run.socket.onopen = () => log(run, "socket-open");
    run.socket.onmessage = ({ data }) => {
      if (run !== current || terminal(run)) return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        void fail(run, "Invalid transcription response");
        return;
      }
      log(run, message.type, message);
      if (message.type === "ready") {
        run.model = message.model;
        run.maxSeconds = message.maxSeconds;
        void capture(run);
      }
      if (message.type === "partial" || message.type === "final-text") {
        run.preview = message.text;
        $("#transcript").textContent = message.text || "Listening…";
        if (message.firstPartialMs !== undefined) {
          run.firstPartialMs ??= message.firstPartialMs;
          $("#latency").textContent = `First text: ${run.firstPartialMs} ms · Stop to final: —`;
        }
      }
      if (message.type === "complete") {
        if (run.phase !== "finalizing" || message.samples !== run.samples) {
          void fail(run, "Final recording boundary mismatch");
          return;
        }
        run.phase = "done";
        run.finalText = message.text;
        run.stopToFinalMs = message.stopToFinalMs;
        $("#transcript").textContent = message.text || "No speech transcribed";
        $("#transcript").classList.remove("partial");
        $("#latency").textContent =
          `First text: ${message.firstPartialMs ?? "—"} ms · Stop to final: ${message.stopToFinalMs} ms`;
        status("Stopped — final transcript received. Prototype delivery is disabled.");
        render();
      }
      if (message.type === "error") void fail(run, message.message);
    };
    run.socket.onerror = () => {
      void fail(
        run,
        "Transcription connection failed; reconnect with the launch code if access expired"
      );
    };
    run.socket.onclose = () => {
      if (!terminal(run))
        void fail(run, "Connection closed before a final transcript acknowledgement");
    };
  } catch {
    await fail(run, "This browser cannot open microphone streaming");
  }
}
async function stop() {
  const run = current;
  if (!run || run.phase !== "recording") return;
  if (run.stream.getAudioTracks().some((track) => track.readyState !== "live")) {
    await fail(run, "Microphone ended unexpectedly; transcript is incomplete");
    return;
  }
  run.phase = "flushing";
  status("Stopping capture and finalizing transcription…");
  render();
  log(run, "stop");
  try {
    const samples = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("flush timeout")), 2000);
      run.flushResolve = (count) => {
        clearTimeout(timer);
        resolve(count);
      };
      run.node.port.postMessage("flush");
    });
    if (run.stream.getAudioTracks().some((track) => track.readyState !== "live")) {
      await fail(run, "Microphone ended unexpectedly; transcript is incomplete");
      return;
    }
    await release(run);
    if (run !== current || terminal(run)) return;
    if (samples !== run.samples) throw new Error("sample count mismatch");
    run.phase = "finalizing";
    run.socket.send(JSON.stringify({ type: "stop", samples }));
  } catch {
    await fail(run, "Audio flush failed; final transcript is incomplete");
  }
}
async function cancel() {
  const run = current;
  if (!run || terminal(run)) return;
  run.phase = "cancelled";
  log(run, "cancel");
  if (run.socket?.readyState === WebSocket.OPEN)
    run.socket.send(JSON.stringify({ type: "cancel" }));
  run.socket?.close();
  await release(run);
  run.preview = "";
  run.finalText = "";
  $("#transcript").textContent = "Recording discarded. Tap an actor to start again.";
  status("Cancelled — no message sent");
  render();
}
for (const actor of actors)
  actor.onclick = () =>
    current?.phase === "recording" ? void stop() : void start(actor.dataset.target);
$("#stop").onclick = () => {
  void stop();
};
$("#cancel").onclick = () => {
  void cancel();
};
$("#access").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const response = await fetch("/session", { method: "POST", body: $("#code").value });
    if (!response.ok) throw new Error("denied");
    authorized = true;
    $("#code").value = "";
    $("#access").hidden = true;
    status("Ready — tap an actor to record");
    render();
  } catch {
    status("Access code rejected", true);
  }
};
if (location.hash.length > 1) {
  $("#code").value = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  $("#access").requestSubmit();
}
$("#download").onclick = () => {
  const clean = {
    ...report,
    trials: report.trials.map((run) => {
      const { context, stream, node, source, socket, flushResolve, ...data } = run;
      return data;
    }),
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(clean, null, 2)], { type: "application/json" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "662-gemini-stream-report.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
setInterval(() => {
  if (!current) return;
  const seconds = Math.floor((performance.now() - (current.recordingAt ?? current.started)) / 1000);
  if (!terminal(current))
    $("#elapsed").textContent =
      `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} / 4:00 limit`;
}, 200);
window.addEventListener("pagehide", () => {
  if (current && !terminal(current)) {
    current.socket?.close();
    for (const track of current.stream?.getTracks() ?? []) track.stop();
  }
});
