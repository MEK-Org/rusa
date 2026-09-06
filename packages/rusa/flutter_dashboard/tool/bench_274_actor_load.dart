// Disposable #274 client-path microbenchmark. This imports the dashboard's
// actual DTO parser and store/tree logic, but never opens a listener or reads
// production data. Run it with the SDK binary directly when the Flutter
// wrapper cannot update its shared cache:
//
//   /path/to/dart-sdk/bin/dart run tool/bench_274_actor_load.dart
//
// It is intentionally a local CPU measurement, not a handset measurement.

import 'dart:convert';
import 'dart:io';

import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/mesh_stream.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';

const _actors = 1000;
const _sweeps = 7;

class _BenchApi extends DashboardApi {
  _BenchApi(this.snapshot) : super(base: Uri.parse('http://bench.invalid/'));

  final ThreadsSnapshot snapshot;

  @override
  Future<ThreadsSnapshot> fetchThreads() async => snapshot;
}

class _BenchStream implements MeshStreamSource {
  @override
  Stream<MeshEvent> get meshEvents => const Stream.empty();

  @override
  Stream<LiveOutputChunk> get liveOutput => const Stream.empty();

  @override
  Stream<void> get elided => const Stream.empty();

  @override
  Stream<RuntimeHello> get runtimeHello => const Stream.empty();

  @override
  Stream<ActorRuntimeStateDelta> get runtimeStates => const Stream.empty();

  @override
  void connect(List<String> actors) {}

  @override
  void dispose() {}
}

String _preview(int actor) {
  // Deterministic, varied, public-safe text for a non-uniform DTO fixture.
  var state = actor + 1;
  final out = StringBuffer('Synthetic benchmark actor $actor. ');
  for (var i = 0; i < 22; i++) {
    state = (state * 1664525 + 1013904223) & 0x7fffffff;
    out.write(state.toRadixString(36).padLeft(6, '0'));
    out.write(' ');
  }
  return out.toString();
}

Map<String, Object?> _fixture() => {
  'halted': false,
  'runtimeCursor': {'streamId': 'bench-stream', 'revision': 0},
  'threads': [
    for (var actor = 0; actor < _actors; actor++)
      {
        'id': 'actor-$actor',
        'handle': 'synthetic-$actor',
        'parentId': actor == 0 ? null : 'actor-0',
        'status': 'active',
        'provider': 'synthetic',
        'model': 'benchmark',
        'charterPreview': _preview(actor),
        'title': 'Synthetic actor $actor',
        'createdAt': '2026-01-01T00:00:00.000Z',
        'runState': 'idle',
        'chatDisabled': false,
      },
  ],
};

double _median(List<double> values) {
  final sorted = [...values]..sort();
  return sorted[sorted.length ~/ 2];
}

int _treeRowWork(DashboardStore store, List<ThreadDto> visible) {
  // This follows ActorTree's child-presence work for each visible row. The two
  // flatten calls in its StreamBuilder are measured separately above. Widget
  // layout and rasterization are outside this source-level harness.
  var childRows = 0;
  for (final thread in visible) {
    if (store.actorStates.value.actors.values.any(
      (candidate) =>
          candidate.thread.parentId == thread.id &&
          store.isThreadVisible(candidate.thread),
    )) {
      childRows++;
    }
  }
  return childRows;
}

Future<void> main() async {
  final raw = _fixture();
  final encoded = jsonEncode(raw);
  final parseMilliseconds = <double>[];
  final updateMilliseconds = <double>[];
  final flattenMilliseconds = <double>[];
  final visibleRowScanMilliseconds = <double>[];
  var visibleRows = 0;
  var childRows = 0;

  for (var sweep = 0; sweep < _sweeps; sweep++) {
    final parseWatch = Stopwatch()..start();
    final snapshot = ThreadsSnapshot.fromJson(
      jsonDecode(encoded) as Map<String, dynamic>,
    );
    parseWatch.stop();
    parseMilliseconds.add(parseWatch.elapsedMicroseconds / 1000);

    final store = DashboardStore(
      api: _BenchApi(snapshot),
      stream: _BenchStream(),
    );
    final updateWatch = Stopwatch()..start();
    await store.refreshThreads();
    updateWatch.stop();
    updateMilliseconds.add(updateWatch.elapsedMicroseconds / 1000);

    final flattenWatch = Stopwatch()..start();
    final visible = store.flattenedVisible();
    store.flattenedVisible();
    flattenWatch.stop();
    flattenMilliseconds.add(flattenWatch.elapsedMicroseconds / 1000);

    final rowScanWatch = Stopwatch()..start();
    childRows = _treeRowWork(store, visible);
    rowScanWatch.stop();
    visibleRowScanMilliseconds.add(rowScanWatch.elapsedMicroseconds / 1000);
    visibleRows = store.flattenedVisible().length;
    store.dispose();
  }

  stdout.writeln(
    const JsonEncoder.withIndent('  ').convert({
      'dataset': {
        'actorCount': _actors,
        'topology': 'one root with 999 direct children',
        'jsonBytes': utf8.encode(encoded).length,
        'sweeps': _sweeps,
      },
      'clientSourcePath': {
        'parse': {
          'milliseconds': parseMilliseconds,
          'medianMilliseconds': _median(parseMilliseconds),
        },
        'stateUpdate': {
          'milliseconds': updateMilliseconds,
          'medianMilliseconds': _median(updateMilliseconds),
        },
        'treePreparation': {
          'twoFlattenCalls': {
            'milliseconds': flattenMilliseconds,
            'medianMilliseconds': _median(flattenMilliseconds),
          },
          'allVisibleRowsChildScan': {
            'milliseconds': visibleRowScanMilliseconds,
            'medianMilliseconds': _median(visibleRowScanMilliseconds),
          },
          'visibleRows': visibleRows,
          'rowsWithVisibleChildren': childRows,
        },
      },
    }),
  );
}
