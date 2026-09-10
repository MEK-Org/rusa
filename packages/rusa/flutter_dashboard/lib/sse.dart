import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import 'mesh_stream.dart';
import 'models.dart';

/// Browser `EventSource` implementation of [MeshStreamSource].
///
/// Each SSE frame is a *named* event (`mesh_event` / `live_output` / `elided`),
/// so we must `addEventListener` per name — `onmessage` only fires for the
/// default (unnamed) event and would receive nothing. EventSource auto-reconnects
/// on drop; the store de-dupes by event id, so a reconnect replaying the seam is
/// safe. The `: connected` / `: heartbeat` comment frames are ignored by the
/// browser automatically.
class WebEventSourceStream implements MeshStreamSource {
  final _mesh = StreamController<MeshEvent>.broadcast();
  final _live = StreamController<LiveOutputChunk>.broadcast();
  final _elided = StreamController<void>.broadcast();
  final _runtimeHello = StreamController<RuntimeHello>.broadcast();
  final _runtimeStates = StreamController<ActorRuntimeStateDelta>.broadcast();
  web.EventSource? _es;

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
  void connect(List<String> actors) {
    _es?.close();
    final qs = actors.isEmpty
        ? ''
        : '?actors=${Uri.encodeQueryComponent(actors.join(','))}';
    final es = web.EventSource('/api/mesh/stream$qs');
    es.addEventListener(
      'mesh_event',
      _listener((data) {
        _mesh.add(MeshEvent.fromJson(jsonDecode(data) as Map<String, dynamic>));
      }),
    );
    es.addEventListener(
      'live_output',
      _listener((data) {
        _live.add(
          LiveOutputChunk.fromJson(jsonDecode(data) as Map<String, dynamic>),
        );
      }),
    );
    es.addEventListener('elided', _listener((_) => _elided.add(null)));
    es.addEventListener(
      'hello',
      _listener((data) {
        _runtimeHello.add(
          RuntimeHello.fromJson(jsonDecode(data) as Map<String, dynamic>),
        );
      }),
    );
    es.addEventListener(
      'actor_runtime_state',
      _listener((data) {
        _runtimeStates.add(
          ActorRuntimeStateDelta.fromJson(
            jsonDecode(data) as Map<String, dynamic>,
          ),
        );
      }),
    );
    _es = es;
  }

  /// Wrap a data handler as a JS event listener, pulling the SSE frame's text
  /// payload out of the MessageEvent and swallowing malformed frames.
  web.EventListener _listener(void Function(String data) onData) {
    return (web.Event e) {
      final data = (e as web.MessageEvent).data;
      if (data == null) return;
      try {
        onData((data as JSString).toDart);
      } catch (_) {
        // Ignore a malformed frame rather than tear down the stream.
      }
    }.toJS;
  }

  @override
  void dispose() {
    _es?.close();
    _es = null;
    _mesh.close();
    _live.close();
    _elided.close();
    _runtimeHello.close();
    _runtimeStates.close();
  }
}
