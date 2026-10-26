import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'io_session_events.dart';
import 'mesh_stream.dart';
import 'models.dart';
import 'session.dart';

/// Dart IO implementation of [MeshStreamSource] for Android / VM environments:
/// the `/api/mesh/stream` events over an [IoSessionEventSource], which owns
/// the per-connection clients and the web-mirrored reconnect policy.
class IoEventSourceStream implements MeshStreamSource {
  IoEventSourceStream({
    required DashboardSession session,
    required this.baseUrl,
    http.Client Function()? clientFactory,
  }) : _session = session,
       _clientFactory = clientFactory;

  final DashboardSession _session;
  final Uri baseUrl;
  final http.Client Function()? _clientFactory;

  final _mesh = StreamController<MeshEvent>.broadcast();
  final _live = StreamController<LiveOutputChunk>.broadcast();
  final _elided = StreamController<void>.broadcast();
  final _runtimeHello = StreamController<RuntimeHello>.broadcast();
  final _runtimeStates = StreamController<ActorRuntimeStateDelta>.broadcast();
  final _avatarUpdates = StreamController<AvatarGenerationUpdate>.broadcast();

  IoSessionEventSource? _source;
  bool _disposed = false;

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
    _source?.close();
    _source = null;
    if (_disposed) return;
    final qs = actors.isEmpty
        ? ''
        : '?actors=${Uri.encodeQueryComponent(actors.join(','))}';
    _source = IoSessionEventSource(
      url: baseUrl.resolve('/api/mesh/stream$qs'),
      baseUrl: baseUrl,
      session: _session,
      onEvent: _dispatchEvent,
      clientFactory: _clientFactory,
    );
  }

  void _dispatchEvent(String event, String data) {
    switch (event) {
      case 'mesh_event':
        final json = jsonDecode(data) as Map<String, dynamic>;
        _mesh.add(MeshEvent.fromJson(json));
      case 'live_output':
        final json = jsonDecode(data) as Map<String, dynamic>;
        _live.add(LiveOutputChunk.fromJson(json));
      case 'elided':
        _elided.add(null);
      case 'hello':
        final json = jsonDecode(data) as Map<String, dynamic>;
        _runtimeHello.add(RuntimeHello.fromJson(json));
      case 'actor_runtime_state':
        final json = jsonDecode(data) as Map<String, dynamic>;
        _runtimeStates.add(ActorRuntimeStateDelta.fromJson(json));
      case 'avatar':
        final json = jsonDecode(data) as Map<String, dynamic>;
        _avatarUpdates.add(AvatarGenerationUpdate.fromJson(json));
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _source?.close();
    _source = null;
    _mesh.close();
    _live.close();
    _elided.close();
    _runtimeHello.close();
    _runtimeStates.close();
    _avatarUpdates.close();
  }
}
