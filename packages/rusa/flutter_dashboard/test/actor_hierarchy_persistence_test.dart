import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/actor_hierarchy_cache.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';

import 'fakes.dart';

/// Stale-while-revalidate for the actor hierarchy (#273): the tree paints the
/// previous session's actors immediately, then the authoritative
/// `/api/mesh/threads` snapshot replaces them wholesale. These tests pin the
/// two things that make that safe — a restored tree never claims liveness, and
/// server truth always wins, including over deltas that race the fetch.
void main() {
  final now = DateTime.timestamp();
  final scope = DashboardStore.cacheScopeFor(Uri.base);

  PersistedActorHierarchy capture(
    List<ThreadDto> threads, {
    String? forScope,
    DateTime? at,
  }) => PersistedActorHierarchy.capture(
    scope: forScope ?? scope,
    threads: threads,
    now: at ?? now,
  );

  ActorRuntimeStateDelta runtime(
    int revision,
    String actorId,
    RunState runState, {
    String streamId = 'stream-a',
  }) => ActorRuntimeStateDelta(
    streamId: streamId,
    revision: revision,
    actorId: actorId,
    runState: runState,
  );

  ThreadsSnapshot snapshot(List<ThreadDto> threads, {RuntimeCursor? cursor}) =>
      ThreadsSnapshot(
        halted: false,
        threads: threads,
        runtimeCursor:
            cursor ?? const RuntimeCursor(streamId: 'stream-a', revision: 0),
      );

  test(
    'seeds the tree from the persisted hierarchy at construction, before any '
    'fetch — the 0ms first paint on reload',
    () async {
      final cache = FakeActorHierarchyCache(
        capture([
          makeThread('root', created: 't0'),
          makeThread('child', parent: 'root', created: 't1'),
        ]),
      );
      final store = DashboardStore(
        api: FakeApi(),
        stream: FakeStream(),
        actorHierarchyCache: cache,
      );

      // No init(), no fetch: the tree renders straight off flattenedVisible().
      expect(store.flattenedVisible().map((t) => t.id), ['root', 'child']);
      expect(store.actorsStale.value, isTrue);

      await store.dispose();
    },
  );

  test('a restored actor never paints as running or queued', () async {
    final cache = FakeActorHierarchyCache(
      capture([
        makeThread('busy', created: 't0', runState: RunState.running),
        makeThread(
          'waiting',
          created: 't1',
          runState: RunState.queued,
          queuePosition: 2,
        ),
      ]),
    );
    final store = DashboardStore(
      api: FakeApi(),
      stream: FakeStream(),
      actorHierarchyCache: cache,
    );

    expect(store.dotFor('busy'), DotState.idle);
    expect(store.dotFor('waiting'), DotState.idle);
    expect(store.runningActors, isEmpty);
    expect(store.queuedActors, isEmpty);
    // The halt banner is live safety state and is likewise never restored.
    expect(store.halted.value, isFalse);

    await store.dispose();
  });

  test(
    'a capture from another dashboard server is neither shown nor kept',
    () async {
      final cache = FakeActorHierarchyCache(
        capture([makeThread('foreign')], forScope: 'https://elsewhere.example'),
      );
      final store = DashboardStore(
        api: FakeApi(),
        stream: FakeStream(),
        actorHierarchyCache: cache,
      );

      expect(store.flattenedVisible(), isEmpty);
      expect(store.actorsStale.value, isFalse);
      expect(cache.clearCount, 1);
      expect(cache.stored, isNull);

      await store.dispose();
    },
  );

  test('a capture older than maxAge is neither shown nor kept', () async {
    final cache = FakeActorHierarchyCache(
      capture([
        makeThread('ancient'),
      ], at: now.subtract(PersistedActorHierarchy.maxAge * 2)),
    );
    final store = DashboardStore(
      api: FakeApi(),
      stream: FakeStream(),
      actorHierarchyCache: cache,
    );

    expect(store.flattenedVisible(), isEmpty);
    expect(cache.clearCount, 1);

    await store.dispose();
  });

  test(
    'unavailable storage degrades to today\'s cold load, not a crash',
    () async {
      final store = DashboardStore(
        api: FakeApi()..threadsResult = [makeThread('root', created: 't0')],
        stream: FakeStream(),
        // The web cache answers null for a disabled/blocked/corrupt store.
        actorHierarchyCache: FakeActorHierarchyCache(),
      );
      expect(store.flattenedVisible(), isEmpty);
      expect(store.actorsStale.value, isFalse);

      await store.init();
      await pumpEventQueue();
      expect(store.flattenedVisible().map((t) => t.id), ['root']);

      await store.dispose();
    },
  );

  test('the authoritative snapshot replaces the restored tree wholesale — a '
      'retired-and-removed actor does not survive as a cached row', () async {
    final cache = FakeActorHierarchyCache(
      capture([
        makeThread('root', created: 't0'),
        makeThread('gone', parent: 'root', created: 't1'),
      ]),
    );
    final api = FakeApi()
      ..threadsResult = [
        makeThread('root', created: 't0'),
        makeThread('fresh', parent: 'root', created: 't2'),
      ];
    final store = DashboardStore(
      api: api,
      stream: FakeStream(),
      actorHierarchyCache: cache,
    );
    expect(store.flattenedVisible().map((t) => t.id), ['root', 'gone']);

    await store.init();
    await pumpEventQueue();

    expect(store.flattenedVisible().map((t) => t.id), ['root', 'fresh']);
    expect(store.actor('gone'), isNull);
    expect(store.actorsStale.value, isFalse);

    await store.dispose();
  });

  test('a live runtime delta that races the first fetch is held until server '
      'truth lands, then applied on top of it', () async {
    final cache = FakeActorHierarchyCache(
      capture([makeThread('root', created: 't0')]),
    );
    final stream = FakeStream();
    final gate = Completer<ThreadsSnapshot>();
    final api = FakeApi()..threadSnapshotGates.add(gate);
    final store = DashboardStore(
      api: api,
      stream: stream,
      actorHierarchyCache: cache,
    );

    final booting = store.init();
    await pumpEventQueue();
    // Restored rows are on screen while the fetch is still in flight.
    expect(store.flattenedVisible().map((t) => t.id), ['root']);
    expect(store.actorsStale.value, isTrue);

    // A delta arrives mid-flight. It must NOT be applied to a cached row:
    // the store has no runtime cursor yet, so it cannot know where this
    // delta sits relative to the snapshot it is about to receive.
    stream.runtimeStatesCtrl.add(runtime(1, 'root', RunState.running));
    await pumpEventQueue();
    expect(store.dotFor('root'), DotState.idle);

    gate.complete(
      snapshot([
        makeThread('root', created: 't0'),
        makeThread('child', parent: 'root', created: 't1'),
      ]),
    );
    await booting;
    await pumpEventQueue();

    // Server truth first, then the buffered delta replayed on top of it.
    expect(store.flattenedVisible().map((t) => t.id), ['root', 'child']);
    expect(store.dotFor('root'), DotState.active);
    expect(store.actorsStale.value, isFalse);

    await store.dispose();
  });

  test(
    'a delta for an actor the server has removed cannot resurrect it',
    () async {
      final cache = FakeActorHierarchyCache(
        capture([
          makeThread('root', created: 't0'),
          makeThread('gone', parent: 'root', created: 't1'),
        ]),
      );
      final stream = FakeStream();
      final gate = Completer<ThreadsSnapshot>();
      final api = FakeApi()
        ..threadSnapshotGates.add(gate)
        ..threadsResult = [makeThread('root', created: 't0')];
      final store = DashboardStore(
        api: api,
        stream: stream,
        actorHierarchyCache: cache,
      );

      final booting = store.init();
      await pumpEventQueue();
      stream.runtimeStatesCtrl.add(runtime(1, 'gone', RunState.running));
      await pumpEventQueue();

      gate.complete(snapshot([makeThread('root', created: 't0')]));
      await booting;
      await pumpEventQueue();

      expect(store.actor('gone'), isNull);
      expect(store.flattenedVisible().map((t) => t.id), ['root']);

      await store.dispose();
    },
  );

  test('a selection made against a cached row the server no longer lists is '
      'dropped when server truth arrives', () async {
    final cache = FakeActorHierarchyCache(
      capture([
        makeThread('root', created: 't0'),
        makeThread('gone', parent: 'root', created: 't1'),
      ]),
    );
    final gate = Completer<ThreadsSnapshot>();
    final api = FakeApi()..threadSnapshotGates.add(gate);
    final store = DashboardStore(
      api: api,
      stream: FakeStream(),
      actorHierarchyCache: cache,
    );

    final booting = store.init();
    await pumpEventQueue();
    // The operator clicks a restored row before revalidation lands.
    store.clickActor('gone');
    expect(store.selection.value, {'gone'});

    gate.complete(snapshot([makeThread('root', created: 't0')]));
    await booting;
    await pumpEventQueue();

    expect(store.selection.value, isEmpty);
    expect(store.primary.value, isNull);

    await store.dispose();
  });

  test('each authoritative sync is persisted for the next cold load', () async {
    final cache = FakeActorHierarchyCache();
    final api = FakeApi()
      ..threadsResult = [
        makeThread('root', created: 't0', runState: RunState.running),
        makeThread('child', parent: 'root', created: 't1'),
      ];
    final store = DashboardStore(
      api: api,
      stream: FakeStream(),
      actorHierarchyCache: cache,
    );
    await store.init();
    await pumpEventQueue();

    expect(cache.saveCount, greaterThanOrEqualTo(1));
    expect(cache.stored?.scope, scope);
    expect(cache.stored?.threads.map((t) => t.id), ['root', 'child']);
    // The capture drops per-run state in memory as well as on the wire, so
    // nothing downstream can replay a run that has already ended.
    expect(
      cache.stored?.threads.map((t) => t.runState),
      everyElement(RunState.unknown),
    );

    await store.dispose();
  });

  test(
    'a failed revalidation keeps the restored tree on screen and still marked '
    'cached',
    () async {
      final cache = FakeActorHierarchyCache(
        capture([makeThread('root', created: 't0')]),
      );
      final api = FakeApi()
        ..threadsError = DashboardApiException(
          Uri.parse('/api/mesh/threads'),
          500,
          'boom',
        );
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        actorHierarchyCache: cache,
      );

      await store.init();
      await pumpEventQueue();

      expect(store.flattenedVisible().map((t) => t.id), ['root']);
      expect(store.actorsStale.value, isTrue);
      expect(store.error.value, isNotNull);
      // A failed fetch must not overwrite the last good capture.
      expect(cache.saveCount, 0);
      expect(cache.stored, isNotNull);

      await store.dispose();
    },
  );

  test('the cache scope names the dashboard server, port included', () {
    expect(
      DashboardStore.cacheScopeFor(Uri.parse('https://mesh.example/actors')),
      'https://mesh.example',
    );
    expect(
      DashboardStore.cacheScopeFor(Uri.parse('http://localhost:7777/work/x')),
      'http://localhost:7777',
    );
    expect(
      DashboardStore.cacheScopeFor(Uri.parse('https://mesh.example:8443/')),
      isNot(DashboardStore.cacheScopeFor(Uri.parse('https://mesh.example/'))),
    );
  });
}
