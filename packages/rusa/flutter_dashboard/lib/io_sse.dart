import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

import 'io_session.dart';
import 'io_session_client.dart';
import 'mesh_stream.dart';
import 'models.dart';
import 'session.dart';

/// Dart IO implementation of [MeshStreamSource] for Android / VM environments.
/// Streams Server-Sent Events (SSE) over standard HTTP chunked transfer.
///
/// Each connection owns a fresh [http.Client] created by the factory so a
/// reconnect never reuses a closed one. The default factory builds an
/// [IoSessionClient] sharing the session's cookie jar (Origin + cookies are
/// its job, not this class's); tests inject a factory returning their mock.
///
/// Reconnect policy mirrors the web [SessionEventSource]: transport drops and
/// non-401 refusals retry on a timer, while `session_idle`, `auth_required`
/// and `401` close the stream and wait for the session or the store instead
/// of blind reconnects.
class IoEventSourceStream implements MeshStreamSource {
  IoEventSourceStream({
    required DashboardSession session,
    required this.baseUrl,
    http.Client Function()? clientFactory,
  })  : _session = session,
        _clientFactory = clientFactory {
    _session.addListener(_onSessionChanged);
    _wasIdle = _session.isIdle;
  }

  final DashboardSession _session;
  final Uri baseUrl;
  final http.Client Function()? _clientFactory;

  final _mesh = StreamController<MeshEvent>.broadcast();
  final _live = StreamController<LiveOutputChunk>.broadcast();
  final _elided = StreamController<void>.broadcast();
  final _runtimeHello = StreamController<RuntimeHello>.broadcast();
  final _runtimeStates = StreamController<ActorRuntimeStateDelta>.broadcast();
  final _avatarUpdates = StreamController<AvatarGenerationUpdate>.broadcast();

  http.Client? _activeStreamClient;
  StreamSubscription<String>? _lineSubscription;
  Timer? _reconnectTimer;
  bool _disposed = false;
  bool _wasIdle = false;
  List<String> _currentActors = const [];

  @override
  Stream<MeshEvent> get meshEvents => _mesh.stream;
  @override
  Stream<LiveOutputChunk> get liveOutput => _live.stream;
  @override
  Stream<void> get elided => _elided.stream;
  @override
  Stream<RuntimeHello> get runtimeHello => _runtimeHello.stream;
  @override
  Stream<ActorRuntimeStateDelta> get runtimeStates => _runtimeStates.stream;
  @override
  Stream<AvatarGenerationUpdate> get avatarUpdates => _avatarUpdates.stream;

  @override
  void connect(List<String> actors) {
    _currentActors = List.unmodifiable(actors);
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _closeActiveStream();
    if (_disposed || _session.isIdle) return;
    unawaited(_openStream());
  }

  /// Mirrors the web SessionEventSource: an idle session closes every stream,
  /// and becoming active again (visit) reopens them.
  void _onSessionChanged() {
    final isIdle = _session.isIdle;
    if (isIdle == _wasIdle) return;
    _wasIdle = isIdle;
    if (isIdle) {
      _reconnectTimer?.cancel();
      _reconnectTimer = null;
      _closeActiveStream();
    } else {
      connect(_currentActors);
    }
  }

  void _closeActiveStream() {
    _lineSubscription?.cancel();
    _lineSubscription = null;
    _activeStreamClient?.close();
    _activeStreamClient = null;
  }

  http.Client _newConnectionClient() {
    final factory = _clientFactory;
    if (factory != null) return factory();
    final session = _session;
    if (session is IoDashboardSession) {
      return IoSessionClient(baseUrl: baseUrl, cookieJar: session.cookieJar);
    }
    return http.Client();
  }

  Future<void> _openStream() async {
    if (_disposed || _session.isIdle) return;

    final qs = _currentActors.isEmpty
        ? ''
        : '?actors=${Uri.encodeQueryComponent(_currentActors.join(','))}';
    final streamUri = baseUrl.resolve('/api/mesh/stream$qs');

    final client = _newConnectionClient();
    _activeStreamClient = client;

    try {
      final request = http.Request('GET', streamUri);
      request.headers['Accept'] = 'text/event-stream';
      request.headers['Cache-Control'] = 'no-cache';

      final response = await client.send(request);

      if (_disposed || _activeStreamClient != client) {
        client.close();
        return;
      }

      if (response.statusCode == 401) {
        // A dead session is settled by requireAuthentication, not by retrying:
        // the next connect() (selection change or re-login) reopens the stream.
        _reconnectTimer?.cancel();
        _reconnectTimer = null;
        _closeActiveStream();
        unawaited(_session.requireAuthentication());
        return;
      }

      if (response.statusCode != 200) {
        client.close();
        _activeStreamClient = null;
        _scheduleReconnect();
        return;
      }

      String? currentEvent;
      final currentDataLines = <String>[];

      _lineSubscription = response.stream
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen(
        (line) {
          final trimmed = line.trim();
          if (trimmed.isEmpty) {
            // Empty line marks end of event
            if (currentEvent != null && currentDataLines.isNotEmpty) {
              final data = currentDataLines.join('\n');
              _dispatchEvent(currentEvent!, data);
            }
            currentEvent = null;
            currentDataLines.clear();
            return;
          }

          if (trimmed.startsWith(':')) {
            // Heartbeat / comment frame, ignore
            return;
          }

          if (trimmed.startsWith('event:')) {
            currentEvent = trimmed.substring('event:'.length).trim();
          } else if (trimmed.startsWith('data:')) {
            currentDataLines.add(trimmed.substring('data:'.length).trim());
          }
        },
        onError: (_) {
          _scheduleReconnect();
        },
        onDone: () {
          _scheduleReconnect();
        },
        cancelOnError: true,
      );
    } catch (_) {
      if (_disposed || _activeStreamClient != client) {
        client.close();
        return;
      }
      _scheduleReconnect();
    }
  }

  void _dispatchEvent(String event, String data) {
    try {
      switch (event) {
        case 'mesh_event':
          final json = jsonDecode(data) as Map<String, dynamic>;
          _mesh.add(MeshEvent.fromJson(json));
          break;
        case 'live_output':
          final json = jsonDecode(data) as Map<String, dynamic>;
          _live.add(LiveOutputChunk.fromJson(json));
          break;
        case 'elided':
          _elided.add(null);
          break;
        case 'hello':
          final json = jsonDecode(data) as Map<String, dynamic>;
          _runtimeHello.add(RuntimeHello.fromJson(json));
          break;
        case 'actor_runtime_state':
          final json = jsonDecode(data) as Map<String, dynamic>;
          _runtimeStates.add(ActorRuntimeStateDelta.fromJson(json));
          break;
        case 'avatar':
          final json = jsonDecode(data) as Map<String, dynamic>;
          _avatarUpdates.add(AvatarGenerationUpdate.fromJson(json));
          break;
        case 'session_idle':
          // The session listener closes the stream synchronously; no reconnect.
          _session.idleFromServer();
          break;
        case 'auth_required':
          // Same as the web transport: disconnect and prompt, never retry blind.
          _reconnectTimer?.cancel();
          _reconnectTimer = null;
          _closeActiveStream();
          unawaited(_session.requireAuthentication());
          break;
      }
    } catch (_) {
      // Ignore a malformed frame rather than teardown
    }
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _closeActiveStream();
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(const Duration(seconds: 2), () {
      if (!_disposed) {
        _openStream();
      }
    });
  }

  @override
  void dispose() {
    _disposed = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _session.removeListener(_onSessionChanged);
    _closeActiveStream();
    _mesh.close();
    _live.close();
    _elided.close();
    _runtimeHello.close();
    _runtimeStates.close();
    _avatarUpdates.close();
  }
}
