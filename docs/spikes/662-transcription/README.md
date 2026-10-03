# #662 synthetic transcription feasibility spike

This standalone diagnostic implements the bounded spike authorized in
[#662 comment 5968301600](https://github.com/MEK-Org/rusa/issues/662#issuecomment-5968301600),
addressing [architectural feedback 5968236865](https://github.com/MEK-Org/rusa/issues/662#issuecomment-5968236865).
It does not implement Room transcription or choose its architecture. Room-first scope,
one-on-one deferral and the eventual dashboard appearance review remain in force.

## Run on the target Android PWA

Serve **only this directory**, from the repository root:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory docs/spikes/662-transcription
```

Connect an operator-owned Android device with USB debugging enabled and authorized.
On the machine running the server:

```sh
adb reverse tcp:8765 tcp:8765
```

Open `http://localhost:8765/` in Android Chrome. Wait for the service worker to register,
install using Chrome's menu, then launch the installed app. Check the report's
`secureContext: true` and `displayMode: standalone`. A browser tab or a home-screen
shortcut still reporting `browser` does not satisfy installed-PWA acceptance. Record
device model, Android version and the full Chrome version from the device's settings
and `chrome://version` (do not export device serials, accounts or profile paths).
The localhost forwarding route follows Chrome's
[local-server debugging workflow](https://developer.chrome.com/docs/devtools/remote-debugging/local-server).
Alternatively serve this directory from an operator-controlled HTTPS origin; that
deployment is outside this preparation. No dashboard deployment is needed.

Use only the displayed invented sentence. Never use an operator's actual memo.
Browser-default recognition may send this synthetic speech to a browser-managed
recognition service. Recorder-only mode invokes no recognizer. Local-required mode
sets `processLocally = true` when supported and fails without remote fallback when
the property is absent. Merely having the property does not prove language support.
**Probe local support** queries `available({langs, processLocally:true})`. **Install**
is an explicit language-pack download button, never automatic.

For each trial, press **Mark speech onset, then speak** just before the first word.
That marker gives a human-timed approximation, not an acoustic measurement.
`firstPartialMs` is elapsed from Start; `firstPartialFromManualOnsetMs` is elapsed
from that marker. `recognition-speechstart` is a separate recognizer event and must
not be relabeled as ground-truth speech onset. Null means no measurement, not zero.

Run the following matrix in the installed app and also in a Chrome tab:

| Trial | Required receipt |
| --- | --- |
| Recorder only, 3 full phrases | Download/listen to each clip, including its last words; baseline duration and decoded RMS/peak |
| Browser-default + recorder, 3 full phrases | First partial **before Stop**, result snapshots/revisions, audible complete independent audio |
| Stop mid-phrase | Compare `previewAtStop`, later result events and `finalRecognition`; keep all final revisions visible after Stop |
| Cancel mid-phrase, then immediate Start | Cancelled trial has no playable/downloadable clip; next trial acquires mic and records normally |
| Cancel while mic permission/acquisition is pending | Later acquired tracks are stopped and recording does not resume |
| Silence, denied permission, recognition error/early end | Explicit events/failures; recognizer end leaves recorder running without silent auto-restart |
| Background/resume, lock/unlock | Visibility and track events, recognition gaps, complete/not-complete audio; page close cancels capture |
| Local-required, online then offline | Exact local property/probe/install result; offline successful recognition or concrete error, no remote fallback |

Each trial is bounded to 60 seconds and recognition drains for at most 5 seconds
after Stop. A `drain-timeout`, remaining interim text or dropped-event count is an
incomplete-evidence result, not an accepted final. Up to 20 trials and 500 logged
events per trial are retained in memory. Download the report before reloading.
Reports contain transcript snapshots and manually entered notes; inspect them for
public safety before sharing. Cancel discards audio but keeps diagnostic text/events.
Only the latest completed clip is available: download it before starting the next
trial. The service worker caches static assets only; it stores no clips/reports.

## Pair preview with the existing batch transcript

For a completed trial, download its exact audio clip and retain its report SHA-256.
Listen to it and annotate audible completeness; decoding/nonzero RMS alone cannot
establish that all words survived concurrent microphone use. Under separate
authorization, transcribe **that same clip** using the configured server adapter in
an isolated fixture, then paste its returned text and provider/model/evidence source
into the harness. Save notes, export JSON, and compare:

1. The preview visible when Stop was pressed (`previewAtStop`).
2. The recognizer's final result after its end event (`finalRecognition`).
3. The batch transcript for that exact clip (`batchTranscript`, `batchSource`).

The harness has no credentials, voice-memo upload, actor selection or delivery call.
It does not call the live `POST /api/mesh/actors/:id/voice-memo` comparison route:
that route also delivers a message. A batch transcription or actor delivery not
performed remains **UNTESTED**. No fake batch text is prefilled.

At baseline staging `53b52993`,
[WebVoiceRecorder](../../../packages/rusa/flutter_dashboard/lib/voice_web.dart)
uses `getUserMedia` and a non-timesliced `MediaRecorder`, then returns full audio on
Stop. This harness uses that capture sequence, starting a separate recognizer after
recorder start to examine concurrent acquisition. It is a separate page, so success
here still requires verification in the actual Room before feature acceptance.
[voice-api.ts](../../../packages/rusa/src/voice/voice-api.ts) saves the clip, calls
`service.transcribeMemo` and then `mesh.sendHumanMessage` (baseline lines 199–222).
[voice-service.ts](../../../packages/rusa/src/voice/voice-service.ts) delegates the
batch to its selected speech adapter (lines 480–481). Browser preview and server
batch are two sessions; even equal samples cannot guarantee their text always matches.

## Processing-path evidence

The [Web Speech draft](https://webaudio.github.io/web-speech-api/#speechrecognition)
allows local and remote implementations. `processLocally = false` does **not**
identify the actual recipient; `true` requires local processing under that API
contract. The [on-device explainer](https://github.com/WebAudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md)
describes language-pack capability probing and installation. These are documented
contracts, not observations of the operator's Chrome build. Record the target
device's property, local availability, successful/failed local-required trial and
offline repeat. For browser-default mode, record concrete browser/service diagnostic
evidence where available; page network logs may omit browser-owned transport.
If the actual service cannot be identified, report **UNKNOWN**, not “local”.

## Observed local validation (2026-10-03)

From the repository root, with existing development dependencies installed:

```sh
node --check docs/spikes/662-transcription/spike.mjs
node --check docs/spikes/662-transcription/sw.js
node docs/spikes/662-transcription/smoke.mjs
pnpm exec biome check docs/spikes/662-transcription/spike.mjs docs/spikes/662-transcription/sw.js docs/spikes/662-transcription/smoke.mjs
```

The smoke runner starts/stops its own loopback server and real headless Chrome,
generates a disposable 440 Hz WAV as a fake microphone, and scripts recognizer
events. It never invokes real recognition or downloads a language pack. Set
`CHROME_BIN` if Chrome is installed elsewhere. This is a manual diagnostic check,
outside the standard runtime/Flutter suites.

| Evidence | Observed result |
| --- | --- |
| Runtime | Linux, Chrome **146.0.7680.164**, headless, `displayMode: browser`, secure loopback |
| Real API surface | MediaRecorder, SpeechRecognition, processLocally, available and install exposed |
| Real local probe | `available({langs:["en-US"],processLocally:true})` returned **downloadable**; install/recognition not invoked |
| Real recorder, generated tone | **5126 bytes**, WebM/Opus; decoded **0.299977 s**, mono, 44100 Hz, RMS **0.229146**, peak **0.389070** in one observed run |
| Scripted recognizer | Three start/stop cycles: “eleven boats” at Stop, post-stop final “eleven paper boats”; interim removal handled; all assertions passed |
| Lifecycle | Cancel discards clip; early recognition end keeps recorder alive; absent local-required support fails before capture; cancel during acquisition releases late tracks |
| Offline fixture | Service worker served the harness on offline reload |
| Initial red receipt | First smoke run failed early-end status assertion; explicit rerender repaired the harness; subsequent smoke exited **0 / PASS** |
| Actor delivery | None attempted; harness has no delivery path |

`adb` is unavailable on this worker (`command -v adb` has no executable). No target
Android device was accessed. Installed-PWA device/OS/Chrome versions, actual first
partial latency, real hypothesis revisions, concurrent **speech** integrity, device
start/stop/cancel, paired preview/batch samples and actual processing path are all
**UNTESTED**. The scripted text changes and 300 ms tone capture are not recognition
latency measurements. The earlier 100–300 ms / 800–1500 ms proposal estimates are
unsupported and are not used to select an approach.

## Architecture still to decide

The requested goal is seeing misunderstandings before dispatch. Prefer investigating
a single authoritative session whose final revisions can be reviewed before delivery.
The current batch upload/delivery API does not provide that interaction. A browser
preview paired with independent batch STT is advisory, even with the same vendor.
Neither path is commissioned by this harness. After target-device results, revise
the proposal with measured tradeoffs; if it introduces a new audio recipient or
keeps an advisory preview, bring that concrete choice and an alternative to the
operator before enabling their recordings. No schema, migration, backend or
dashboard appearance change is included here; #662 stays open.
