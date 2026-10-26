import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

import 'io_session.dart';
import 'mesh_stream.dart';
import 'models.dart';
import 'session.dart';

/// Dart IO implementation of [MeshStreamSource] for Android / VM environments.
/// Streams Server-Sent Events (SSE) over standard HTTP chunked transfer.
class IoEventSourceStream implements MeshStreamSource {
  IoEventSourceStream({
    required DashboardSession session,
    required this.baseUrl,
    http.Client? client,
  })  : _session = session,
        _client = client ?? http.Client();

  final DashboardSession _session;
  final Uri baseUrl;
  final http.Client _client;

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
    _closeActiveStream();
    if (_disposed) return;
    _openStream();
  }

  void _closeActiveStream() {
    _lineSubscription?.cancel();
    _lineSubscription = null;
    _activeStreamClient?.close();
    _activeStreamClient = null;
  }

  Future<void> _openStream() async {
    if (_disposed) return;

    final qs = _currentActors.isEmpty
        ? ''
        : '?actors=${Uri.encodeQueryComponent(_currentActors.join(','))}';
    final streamUri = baseUrl.resolve('/api/mesh/stream$qs');
    final origin =
        '${baseUrl.scheme}://${baseUrl.host}${baseUrl.hasPort ? ':${baseUrl.port}' : ''}';

    final client = _client;
    _activeStreamClient = client;

    try {
      final request = http.Request('GET', streamUri);
      request.headers['Accept'] = 'text/event-stream';
      request.headers['Cache-Control'] = 'no-cache';
      request.headers['Origin'] = origin;

      final session = _session;
      if (session is IoDashboardSession) {
        final cookie = session.cookieJar.buildCookieHeader();
        if (cookie != null) {
          request.headers['Cookie'] = cookie;
        }
      }

      final response = await client.send(request);

      if (_disposed || _activeStreamClient != client) {
        client.close();
        return;
      }

      if (response.statusCode == 401) {
        await _session.requireAuthentication();
        _scheduleReconnect();
        return;
      }

      if (response.statusCode != 200) {
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
          _session.idleFromServer();
          break;
        case 'auth_required':
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
    _closeActiveStream();
    _client.close();
    _mesh.close();
    _live.close();
    _elided.close();
    _runtimeHello.close();
    _runtimeStates.close();
    _avatarUpdates.close();
  }
}
