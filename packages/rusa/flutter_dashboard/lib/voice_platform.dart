import 'dart:typed_data';

import 'api.dart';
import 'models.dart';

/// Thin injectable seams over the browser voice APIs (MediaRecorder,
/// HTMLAudioElement, Wake Lock, the `voice` EventSource) so the walkie-talkie
/// controller (`walkie_controller.dart`) and its tests never import
/// `package:web`. The real implementations live in `voice_web.dart`; tests use
/// the fakes in `test/fakes.dart`. Mirrors the `MeshStreamSource` pattern.

/// The captured clip handed back by [VoiceRecorder.stop].
class RecordedAudio {
  const RecordedAudio({required this.bytes, required this.mimeType});

  final Uint8List bytes;

  /// e.g. `audio/webm;codecs=opus` — sent verbatim as the memo Content-Type
  /// (the server keeps only the part before `;`).
  final String mimeType;
}

/// Microphone capture (MediaRecorder on web). One recording at a time.
abstract interface class VoiceRecorder {
  /// Start capturing (may prompt for mic permission). Throws when the mic is
  /// unavailable or permission is denied.
  Future<void> start();

  /// Stop capturing and return the clip.
  Future<RecordedAudio> stop();

  /// Abort an in-progress recording, discarding the audio.
  Future<void> cancel();
}

/// Sequential announcement playback (HTMLAudioElement on web).
abstract interface class VoicePlayer {
  /// Best-effort autoplay unlock — called from the mode-entry tap (the user
  /// gesture). Plays a zero-length silent clip; never throws.
  Future<void> prime();

  /// Play [url]; the future completes when playback ends (or [stop] is
  /// called), and throws when the audio can't be fetched/decoded.
  Future<void> play(String url);

  /// Stop the current playback; a pending [play] future completes normally
  /// (the skip semantics — a skipped announcement still counts as played).
  void stop();
}

/// Screen wake lock while walkie mode is on. Implementations must no-op
/// gracefully where the platform doesn't support it.
abstract interface class ScreenWakeLock {
  Future<void> acquire();
  Future<void> release();
}

/// Connection-level signal from the `voice` SSE stream.
enum VoiceStreamStatus { connected, reconnecting }

/// The `voice` SSE channel (`GET /api/mesh/voice/stream?actors=…`). The open
/// connection IS the walkie presence signal, so implementations must only hold
/// it open between [connect] and [dispose]. Browser EventSource auto-reconnects
/// on blips; [status] surfaces those transitions so the controller can re-fetch
/// the backlog after a gap.
abstract interface class VoiceStreamSource {
  Stream<VoiceAnnouncement> get frames;
  Stream<VoiceStreamStatus> get status;

  /// Open the stream for [actors] (≥1 required by the server).
  void connect(List<String> actors);

  /// Close the connection (drops walkie presence) and the streams.
  void dispose();
}

/// Everything the walkie-talkie feature needs, bundled once at app startup
/// (`webWalkieDeps` in `voice_web.dart`) and carried on the store. Null on the
/// store means the feature is absent (headless harnesses).
class WalkieDeps {
  WalkieDeps({
    required this.api,
    required this.recorder,
    required this.player,
    required this.wakeLock,
    required this.createStream,
  });

  final DashboardApi api;
  final VoiceRecorder recorder;
  final VoicePlayer player;
  final ScreenWakeLock wakeLock;

  /// Fresh stream per mode entry — the controller owns and disposes it, so
  /// toggling OFF reliably drops the presence connection.
  final VoiceStreamSource Function() createStream;

  /// Instance-wide probe cache: false once any voice route answered 503 (voice
  /// unconfigured — no `geminiApiKey`), true once one succeeded, null before
  /// the first probe. Shared across actor switches so the toggle's
  /// disabled/enabled state doesn't flap per chat.
  bool? voiceAvailable;
}
