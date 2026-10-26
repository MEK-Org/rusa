import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import 'api.dart';
import 'io_session.dart';
import 'io_session_events.dart';
import 'models.dart';
import 'session.dart';
import 'voice_platform.dart';

/// Device implementations of the `voice_platform.dart` seams, the Android
/// counterparts of `voice_web.dart`: microphone capture through `record`,
/// announcement playback through `audioplayers`, the screen wake lock through
/// `wakelock_plus`, and the `voice` stream over an [IoSessionEventSource].
/// Imported only from the IO bootstrap.

/// Wire the real device deps once at startup.
WalkieDeps ioWalkieDeps(DashboardApi api, IoDashboardSession session) =>
    WalkieDeps(
      api: api,
      recorder: IoVoiceRecorder(),
      player: IoVoicePlayer(client: session.client, baseUrl: session.baseUrl),
      wakeLock: IoScreenWakeLock(),
      createStream: () =>
          IoVoiceStream(session: session, baseUrl: session.baseUrl),
    );

/// AAC in an MPEG-4 container: every Android device can encode it, and the
/// server stores `audio/mp4` memos as `.m4a`, as it does Safari's recordings.
const _kRecordConfig = RecordConfig(encoder: AudioEncoder.aacLc);
const _kRecordMime = 'audio/mp4';

class IoVoiceRecorder implements VoiceRecorder {
  IoVoiceRecorder({
    AudioRecorder Function()? createRecorder,
    Future<Directory> Function()? temporaryDirectory,
  }) : _createRecorder = createRecorder ?? AudioRecorder.new,
       _temporaryDirectory = temporaryDirectory ?? getTemporaryDirectory;

  final AudioRecorder Function() _createRecorder;
  final Future<Directory> Function() _temporaryDirectory;

  AudioRecorder? _recorder;
  String? _path;

  /// Ownership token, as in the web recorder: [cancel] bumps it so a start
  /// still awaiting permission or the encoder becomes stale and releases only
  /// what it acquired.
  int _generation = 0;

  @override
  Future<void> start() async {
    final generation = ++_generation;
    await _release(); // drop any stale session
    final recorder = _createRecorder();
    try {
      if (!await recorder.hasPermission()) {
        throw StateError('microphone permission denied');
      }
      final directory = await _temporaryDirectory();
      final path =
          '${directory.path}/walkie-${DateTime.now().microsecondsSinceEpoch}.m4a';
      if (generation != _generation) {
        throw StateError('recording superseded before it started');
      }
      await recorder.start(_kRecordConfig, path: path);
      if (generation != _generation) {
        await recorder.cancel();
        throw StateError('recording superseded by a newer session');
      }
      _recorder = recorder;
      _path = path;
    } catch (_) {
      if (_recorder != recorder) await recorder.dispose();
      rethrow;
    }
  }

  @override
  Future<RecordedAudio> stop() async {
    _generation++;
    final recorder = _recorder;
    if (recorder == null) throw StateError('not recording');
    _recorder = null;
    final expectedPath = _path;
    _path = null;
    try {
      final path = await recorder.stop() ?? expectedPath;
      if (path == null) throw StateError('recording produced no file');
      final file = File(path);
      final bytes = await file.readAsBytes();
      await file.delete();
      return RecordedAudio(bytes: bytes, mimeType: _kRecordMime);
    } finally {
      await recorder.dispose();
    }
  }

  @override
  Future<void> cancel() async {
    _generation++;
    await _release();
  }

  Future<void> _release() async {
    final recorder = _recorder;
    _recorder = null;
    _path = null;
    if (recorder == null) return;
    try {
      // The plugin deletes the partial file on cancel.
      await recorder.cancel();
    } catch (_) {}
    await recorder.dispose();
  }
}

/// Announcement audio is a dashboard route, so it is fetched with the session
/// client (which carries the session cookie) and played from memory; the
/// platform player never sees a URL or a cookie.
class IoVoicePlayer implements VoicePlayer {
  IoVoicePlayer({
    required http.Client client,
    required Uri baseUrl,
    AudioPlayer Function()? createPlayer,
  }) : _client = client,
       _baseUrl = baseUrl,
       _createPlayer = createPlayer ?? AudioPlayer.new;

  final http.Client _client;
  final Uri _baseUrl;
  final AudioPlayer Function() _createPlayer;
  AudioPlayer? _player;
  Completer<void>? _done;

  /// A device app has no autoplay policy to unlock.
  @override
  Future<void> prime() async {}

  @override
  Future<void> play(String url) async {
    stop();
    final done = Completer<void>();
    _done = done;
    try {
      final response = await _client.get(_baseUrl.resolve(url));
      // Stopped while fetching: a skipped announcement still counts as played.
      if (done.isCompleted) return;
      if (response.statusCode != 200) {
        throw StateError(
          'announcement audio unavailable (${response.statusCode})',
        );
      }
      final player = _player ??= _createPlayer();
      void fail(Object error, [StackTrace? stackTrace]) {
        if (!done.isCompleted) done.completeError(error, stackTrace);
      }

      // Native decode/playback failures arrive on the player's event stream.
      final completion = player.onPlayerComplete.listen((_) {
        if (!done.isCompleted) done.complete();
      }, onError: fail);
      try {
        // Raced against [done] so a stop while the source is still preparing
        // returns at once instead of after the plugin's prepare timeout.
        unawaited(
          player
              .play(
                BytesSource(
                  response.bodyBytes,
                  mimeType: response.headers['content-type'],
                ),
              )
              .then((_) {
                // The plugin drops a stop that lands while its resume call is
                // in flight (it re-marks the player as playing afterwards), so
                // re-issue it unless a newer announcement has the player.
                if (done.isCompleted && _done == null) {
                  unawaited(player.stop().catchError((_) {}));
                }
              }, onError: fail),
        );
        await done.future;
      } finally {
        await completion.cancel();
      }
    } finally {
      if (_done == done) _done = null;
    }
  }

  @override
  void stop() {
    final player = _player;
    if (player != null) unawaited(player.stop().catchError((_) {}));
    final done = _done;
    _done = null;
    if (done != null && !done.isCompleted) done.complete();
  }
}

/// Keeps the screen on while walkie mode is on. Android keeps the flag for
/// the activity across backgrounding, so no re-acquire is needed.
class IoScreenWakeLock implements ScreenWakeLock {
  @override
  Future<void> acquire() async {
    try {
      await WakelockPlus.enable();
    } catch (_) {
      // Keep the mode usable without the lock.
    }
  }

  @override
  Future<void> release() async {
    try {
      await WakelockPlus.disable();
    } catch (_) {}
  }
}

/// The `voice` stream over [IoSessionEventSource]. Its stable session UUID is
/// the walkie authority, so this object lives exactly as long as the mode is
/// ON. Each opened connection reports [VoiceStreamStatus.connected] and each
/// drop [VoiceStreamStatus.reconnecting], as the browser's `open`/`error` do,
/// so the controller re-fetches the backlog after a gap.
class IoVoiceStream implements VoiceStreamSource {
  IoVoiceStream({
    required DashboardSession session,
    required this.baseUrl,
    http.Client Function()? clientFactory,
  }) : _session = session,
       _clientFactory = clientFactory;

  final DashboardSession _session;
  final Uri baseUrl;
  final http.Client Function()? _clientFactory;
  final _frames = StreamController<VoiceAnnouncement>.broadcast();
  final _status = StreamController<VoiceStreamStatus>.broadcast();
  final _controls = StreamController<VoiceSessionControl>.broadcast();
  IoSessionEventSource? _source;

  @override
  Stream<VoiceAnnouncement> get frames => _frames.stream;
  @override
  Stream<VoiceStreamStatus> get status => _status.stream;
  @override
  Stream<VoiceSessionControl> get controls => _controls.stream;

  @override
  void connect(List<String> actors, String? sessionId) {
    _source?.close();
    final qs = Uri.encodeQueryComponent(actors.join(','));
    final session = sessionId == null
        ? ''
        : '&sessionId=${Uri.encodeQueryComponent(sessionId)}';
    _source = IoSessionEventSource(
      url: baseUrl.resolve('/api/mesh/voice/stream?actors=$qs$session'),
      baseUrl: baseUrl,
      session: _session,
      clientFactory: _clientFactory,
      onOpen: () => _status.add(VoiceStreamStatus.connected),
      onError: () => _status.add(VoiceStreamStatus.reconnecting),
      onEvent: _dispatch,
    );
  }

  void _dispatch(String event, String data) {
    switch (event) {
      case 'voice':
        _frames.add(
          VoiceAnnouncement.fromJson(jsonDecode(data) as Map<String, dynamic>),
        );
      case 'voice_control':
        final json = jsonDecode(data);
        if (json is Map<String, dynamic> && json['targetActorId'] is String) {
          _controls.add(
            VoiceSessionControl(targetActorId: json['targetActorId'] as String),
          );
        }
    }
  }

  @override
  void dispose() {
    _source?.close();
    _source = null;
    _frames.close();
    _status.close();
    _controls.close();
  }
}
