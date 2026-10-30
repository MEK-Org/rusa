import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import 'api.dart';
import 'assistant_platform.dart';
import 'io_session.dart';
import 'io_session_events.dart';
import 'models.dart';
import 'session.dart';
import 'session_client.dart';
import 'voice_platform.dart';

/// Device implementations of the `voice_platform.dart` seams, the Android
/// counterparts of `voice_web.dart`: microphone capture through `record`,
/// announcement playback through `audioplayers`, the screen wake lock through
/// `wakelock_plus`, and the `voice` stream over an [IoSessionEventSource].
/// Imported only from the IO bootstrap.

/// Wire the real device deps once at startup. [transport] is the session's
/// own device transport (every IO session carries one). The assist screen
/// passes a [headset] so its recordings use a connected headset microphone.
WalkieDeps ioWalkieDeps(
  DashboardApi api,
  DashboardSession session,
  IoSessionTransport transport, {
  HeadsetRoute? headset,
}) => WalkieDeps(
  api: api,
  recorder: IoVoiceRecorder(headset: headset),
  player: IoVoicePlayer(
    client: transport.client,
    baseUrl: transport.baseUrl,
    session: session,
  ),
  wakeLock: IoScreenWakeLock(),
  createStream: () =>
      IoVoiceStream(session: session, baseUrl: transport.baseUrl),
);

/// AAC in an MPEG-4 container: every Android device can encode it, and the
/// server stores `audio/mp4` memos as `.m4a`, as it does Safari's recordings.
const _kRecordConfig = RecordConfig(encoder: AudioEncoder.aacLc);
const _kRecordMime = 'audio/mp4';

/// Capture from a routed headset: the HFP voice path is narrowband mono and is
/// served to the communication source. The plugin's own Bluetooth handling
/// stays off so it cannot race [HeadsetRoute] for the SCO link.
const _kHeadsetRecordConfig = RecordConfig(
  encoder: AudioEncoder.aacLc,
  bitRate: 32000,
  sampleRate: 16000,
  numChannels: 1,
  androidConfig: AndroidRecordConfig(
    manageBluetooth: false,
    audioSource: AndroidAudioSource.voiceCommunication,
  ),
);

class IoVoiceRecorder implements VoiceRecorder {
  IoVoiceRecorder({
    AudioRecorder Function()? createRecorder,
    Future<Directory> Function()? temporaryDirectory,
    HeadsetRoute? headset,
  }) : _createRecorder = createRecorder ?? AudioRecorder.new,
       _temporaryDirectory = temporaryDirectory ?? getTemporaryDirectory,
       _headset = headset;

  final AudioRecorder Function() _createRecorder;
  final Future<Directory> Function() _temporaryDirectory;
  final HeadsetRoute? _headset;

  /// The start generation holding the headset route, so a superseded start
  /// never releases a route a newer session acquired.
  int? _routeGeneration;

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
      final headset = _headset;
      if (headset != null) {
        // Held from the request, so a cancel while the route is still
        // pending releases it at once rather than when it settles.
        _routeGeneration = generation;
        if (!await headset.acquire() && _routeGeneration == generation) {
          _routeGeneration = null;
        }
      }
      if (generation != _generation) {
        throw StateError('recording superseded before it started');
      }
      await recorder.start(
        _routeGeneration == generation ? _kHeadsetRecordConfig : _kRecordConfig,
        path: path,
      );
      if (generation != _generation) {
        await recorder.cancel();
        throw StateError('recording superseded by a newer session');
      }
      _recorder = recorder;
      _path = path;
    } catch (_) {
      if (_recorder != recorder) {
        await recorder.dispose();
        await _releaseRoute(generation);
      }
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
    File? file;
    try {
      final path = await recorder.stop() ?? expectedPath;
      if (path == null) throw StateError('recording produced no file');
      file = File(path);
      final bytes = await file.readAsBytes();
      return RecordedAudio(bytes: bytes, mimeType: _kRecordMime);
    } finally {
      if (file != null) {
        try {
          await file.delete();
        } catch (_) {}
      }
      await recorder.dispose();
      await _releaseRoute();
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
    if (recorder != null) {
      try {
        // The plugin deletes the partial file on cancel.
        await recorder.cancel();
      } catch (_) {}
      await recorder.dispose();
    }
    await _releaseRoute();
  }

  /// Release the headset route held by [generation], or by any session when
  /// none is given.
  Future<void> _releaseRoute([int? generation]) async {
    final owner = _routeGeneration;
    if (owner == null || (generation != null && generation != owner)) return;
    _routeGeneration = null;
    await _headset?.release();
  }
}

/// Announcement audio is a dashboard route, so it is fetched with the session
/// client (which carries the session cookie) and played from memory; the
/// platform player never sees a URL or a cookie.
class IoVoicePlayer implements VoicePlayer {
  IoVoicePlayer({
    required http.Client client,
    required Uri baseUrl,
    SessionRequestState? session,
    AudioPlayer Function()? createPlayer,
  }) : _client = session == null ? client : SessionClient(client, session),
       _baseUrl = baseUrl,
       _createPlayer = createPlayer ?? AudioPlayer.new;

  final http.Client _client;
  final Uri _baseUrl;
  final AudioPlayer Function() _createPlayer;
  _IoPlayback? _active;

  /// A device app has no autoplay policy to unlock.
  @override
  Future<void> prime() async {}

  @override
  Future<void> play(String url) async {
    stop();
    final playback = _IoPlayback();
    _active = playback;
    AudioPlayer? player;
    StreamSubscription<void>? completion;
    Future<void>? nativePlay;
    try {
      final response = await _client.get(_baseUrl.resolve(url));
      // Stopped while fetching: a skipped announcement still counts as played.
      if (playback.done.isCompleted) return;
      if (response.statusCode != 200) {
        throw StateError(
          'announcement audio unavailable (${response.statusCode})',
        );
      }
      final ownedPlayer = _createPlayer();
      player = ownedPlayer;
      playback.player = ownedPlayer;
      void fail(Object error, [StackTrace? stackTrace]) {
        playback.fail(error, stackTrace);
      }

      // This player belongs to exactly this announcement. A skipped A can
      // finish preparing late, but it can never resume, stop, or complete B.
      completion = ownedPlayer.onPlayerComplete.listen(
        (_) => playback.complete(),
        onError: fail,
      );
      final started = ownedPlayer.play(
        BytesSource(
          response.bodyBytes,
          mimeType: response.headers['content-type'],
        ),
      );
      nativePlay = started;
      unawaited(
        started.then((_) {
          // Some Android players drop a stop during resume. Reissue it for this
          // announcement only, before its player is disposed.
          if (playback.stopped) _ignore(ownedPlayer.stop());
        }, onError: fail),
      );
      await playback.done.future;
    } finally {
      await completion?.cancel();
      if (_active == playback) _active = null;
      if (player != null) {
        unawaited(_disposePlayer(player, nativePlay, playback.stopped));
      }
    }
  }

  @override
  void stop() {
    _active?.stop();
  }

  Future<void> _disposePlayer(
    AudioPlayer player,
    Future<void>? nativePlay,
    bool stopped,
  ) async {
    // A stop may resolve this wrapper before the plugin's source/resume future
    // settles. Keep ownership until then, then reissue that play's stop and
    // release its native resources. No later announcement shares this player.
    try {
      await nativePlay;
    } catch (_) {}
    if (stopped) await _ignore(player.stop());
    await _ignore(player.dispose());
  }
}

class _IoPlayback {
  final done = Completer<void>();
  AudioPlayer? player;
  bool stopped = false;

  void complete() {
    if (!done.isCompleted) done.complete();
  }

  void fail(Object error, [StackTrace? stackTrace]) {
    if (!done.isCompleted) done.completeError(error, stackTrace);
  }

  void stop() {
    stopped = true;
    final current = player;
    if (current != null) _ignore(current.stop());
    complete();
  }
}

Future<void> _ignore(Future<void> future) async {
  try {
    await future;
  } catch (_) {}
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
