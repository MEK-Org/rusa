import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:web/web.dart' as web;

import 'api.dart';
import 'models.dart';
import 'voice_platform.dart';

/// Browser implementations of the `voice_platform.dart` seams :
/// MediaRecorder capture, HTMLAudioElement playback, the Screen Wake Lock API,
/// and the `voice` EventSource. Imported only from `main.dart` (the web
/// entrypoint) — everything else stays headless-testable.

/// Wire the real web deps once at startup.
WalkieDeps webWalkieDeps(DashboardApi api) => WalkieDeps(
  api: api,
  recorder: WebVoiceRecorder(),
  player: WebVoicePlayer(),
  wakeLock: WebScreenWakeLock(),
  createStream: WebVoiceStream.new,
);

/// Recording mime preference: webm/opus where supported (Chrome, Firefox),
/// falling back to whatever the browser can produce (Safari records mp4/aac —
/// the server accepts any `audio/*`).
const _kPreferredMimes = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

class WebVoiceRecorder implements VoiceRecorder {
  web.MediaRecorder? _recorder;
  web.MediaStream? _mediaStream;
  List<web.Blob> _chunks = [];

  @override
  Future<void> start() async {
    await cancel(); // drop any stale session
    final stream = await web.window.navigator.mediaDevices
        .getUserMedia(web.MediaStreamConstraints(audio: true.toJS))
        .toDart;
    _mediaStream = stream;
    String mime = '';
    for (final candidate in _kPreferredMimes) {
      if (web.MediaRecorder.isTypeSupported(candidate)) {
        mime = candidate;
        break;
      }
    }
    final recorder = mime.isEmpty
        ? web.MediaRecorder(stream)
        : web.MediaRecorder(stream, web.MediaRecorderOptions(mimeType: mime));
    _chunks = [];
    recorder.addEventListener(
      'dataavailable',
      (web.Event e) {
        final data = (e as web.BlobEvent).data;
        if (data.size > 0) _chunks.add(data);
      }.toJS,
    );
    recorder.start();
    _recorder = recorder;
  }

  @override
  Future<RecordedAudio> stop() async {
    final recorder = _recorder;
    if (recorder == null) throw StateError('not recording');
    final stopped = Completer<void>();
    recorder.addEventListener(
      'stop',
      (web.Event _) {
        if (!stopped.isCompleted) stopped.complete();
      }.toJS,
    );
    recorder.stop();
    await stopped.future;
    _stopTracks();
    _recorder = null;
    final type = recorder.mimeType.isNotEmpty
        ? recorder.mimeType
        : 'audio/webm';
    final blob = web.Blob(_chunks.toJS, web.BlobPropertyBag(type: type));
    _chunks = [];
    final buffer = await blob.arrayBuffer().toDart;
    return RecordedAudio(bytes: buffer.toDart.asUint8List(), mimeType: type);
  }

  @override
  Future<void> cancel() async {
    final recorder = _recorder;
    _recorder = null;
    _chunks = [];
    if (recorder != null && recorder.state != 'inactive') {
      try {
        recorder.stop();
      } catch (_) {}
    }
    _stopTracks();
  }

  void _stopTracks() {
    final stream = _mediaStream;
    _mediaStream = null;
    if (stream == null) return;
    final tracks = stream.getTracks().toDart;
    for (final track in tracks) {
      track.stop();
    }
  }
}

/// 44-byte RIFF header + zero samples: the shortest valid WAV, used to unlock
/// autoplay inside the mode-entry tap's user gesture.
const _kSilentWavDataUri =
    'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

class WebVoicePlayer implements VoicePlayer {
  web.HTMLAudioElement? _element;
  Completer<void>? _done;

  @override
  Future<void> prime() async {
    try {
      final el = web.HTMLAudioElement()..src = _kSilentWavDataUri;
      await el.play().toDart;
    } catch (_) {
      // Autoplay policy said no — actual playback may still work because the
      // toggle tap counts as interaction; nothing useful to do here.
    }
  }

  @override
  Future<void> play(String url) {
    stop();
    final el = web.HTMLAudioElement()..src = url;
    _element = el;
    final done = Completer<void>();
    _done = done;
    el.addEventListener(
      'ended',
      (web.Event _) {
        if (!done.isCompleted) done.complete();
      }.toJS,
    );
    el.addEventListener(
      'error',
      (web.Event _) {
        if (!done.isCompleted) {
          done.completeError(StateError('audio element error for $url'));
        }
      }.toJS,
    );
    // A rejected play() promise (autoplay blocked / decode failure) must fail
    // the future too — 'error' doesn't fire for autoplay rejections.
    el.play().toDart.then(
      (_) {},
      onError: (Object e) {
        if (!done.isCompleted) done.completeError(e);
      },
    );
    return done.future;
  }

  @override
  void stop() {
    final el = _element;
    _element = null;
    if (el != null) {
      try {
        el.pause();
        el.src = '';
      } catch (_) {}
    }
    final done = _done;
    _done = null;
    if (done != null && !done.isCompleted) done.complete();
  }
}

class WebScreenWakeLock implements ScreenWakeLock {
  web.WakeLockSentinel? _sentinel;
  bool _wanted = false;
  JSFunction? _visibilityListener;

  bool get _supported => (web.window.navigator as JSObject).has('wakeLock');

  @override
  Future<void> acquire() async {
    _wanted = true;
    if (!_supported) return; // graceful no-op
    await _request();
    // The browser silently releases the lock when the tab is hidden; re-grab
    // it when the driver glances back at the screen.
    if (_visibilityListener == null) {
      final listener = (web.Event _) {
        if (_wanted && web.document.visibilityState == 'visible') {
          unawaited(_request());
        }
      }.toJS;
      _visibilityListener = listener;
      web.document.addEventListener('visibilitychange', listener);
    }
  }

  Future<void> _request() async {
    try {
      _sentinel = await web.window.navigator.wakeLock.request('screen').toDart;
    } catch (_) {
      // Permission/policy denial — keep the mode usable without the lock.
    }
  }

  @override
  Future<void> release() async {
    _wanted = false;
    final listener = _visibilityListener;
    _visibilityListener = null;
    if (listener != null) {
      web.document.removeEventListener('visibilitychange', listener);
    }
    final sentinel = _sentinel;
    _sentinel = null;
    if (sentinel != null) {
      try {
        await sentinel.release().toDart;
      } catch (_) {}
    }
  }
}

/// Browser EventSource on `/api/mesh/voice/stream`. The open connection is the
/// walkie presence signal, so this object lives exactly as long as the mode is
/// ON (the controller creates one per mode entry and disposes it on exit).
/// EventSource auto-reconnects on blips; `open`/`error` events surface as
/// [VoiceStreamStatus] so the controller can re-fetch the backlog after a gap.
class WebVoiceStream implements VoiceStreamSource {
  final _frames = StreamController<VoiceAnnouncement>.broadcast();
  final _status = StreamController<VoiceStreamStatus>.broadcast();
  web.EventSource? _es;

  @override
  Stream<VoiceAnnouncement> get frames => _frames.stream;
  @override
  Stream<VoiceStreamStatus> get status => _status.stream;

  @override
  void connect(List<String> actors) {
    _es?.close();
    final qs = Uri.encodeQueryComponent(actors.join(','));
    final es = web.EventSource('/api/mesh/voice/stream?actors=$qs');
    es.addEventListener(
      'voice',
      (web.Event e) {
        final data = (e as web.MessageEvent).data;
        if (data == null) return;
        try {
          _frames.add(
            VoiceAnnouncement.fromJson(
              jsonDecode((data as JSString).toDart) as Map<String, dynamic>,
            ),
          );
        } catch (_) {
          // Swallow a malformed frame rather than tear down the stream.
        }
      }.toJS,
    );
    es.addEventListener(
      'open',
      (web.Event _) {
        _status.add(VoiceStreamStatus.connected);
      }.toJS,
    );
    es.addEventListener(
      'error',
      (web.Event _) {
        _status.add(VoiceStreamStatus.reconnecting);
      }.toJS,
    );
    _es = es;
  }

  @override
  void dispose() {
    _es?.close();
    _es = null;
    _frames.close();
    _status.close();
  }
}
