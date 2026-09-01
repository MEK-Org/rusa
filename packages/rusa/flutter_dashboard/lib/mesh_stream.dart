import 'models.dart';

/// Abstraction over the live SSE feed so the store (and its headless tests) never
/// import the web-only `package:web` EventSource binding. The real
/// implementation is `WebEventSourceStream` in `sse.dart`; tests use a fake.
///
/// `mesh_event` is delivered for ALL actors (the server broadcasts the topology/
/// run-lifecycle channel unfiltered), so it drives the global run-state map and
/// the tree. `liveOutput` is server-filtered to the actors passed to
/// [connect]. `elided` signals a dropped-output gap (the named `elided` frame).
abstract interface class MeshStreamSource {
  Stream<MeshEvent> get meshEvents;
  Stream<LiveOutputChunk> get liveOutput;
  Stream<void> get elided;
  Stream<RuntimeHello> get runtimeHello;
  Stream<ActorRuntimeStateDelta> get runtimeStates;

  /// (Re)open the stream filtered to [actors] for the live_output channel.
  /// mesh_event still arrives for every actor regardless of this filter.
  void connect(List<String> actors);

  void dispose();
}
