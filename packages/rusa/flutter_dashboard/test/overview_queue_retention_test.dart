import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/obligations_cache.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';

import 'fakes.dart';

/// Overview's My Queue belongs to the store, not the mounted tab (#992): a
/// return to Overview paints the rows it last showed while the refresh is
/// still in flight.
Widget _overview(DashboardStore store) => MaterialApp(
  home: Scaffold(body: OverviewTab(store: store)),
);

const _scope = 'http://localhost:4040';
const _otherViewer = '00000000-0000-4000-8000-000000000002';

DashboardConfigDto _configFor(String principal) =>
    DashboardConfigDto(quotaProviders: const {}, userPrincipalId: principal);

PersistedOverviewQueueSnapshot _capture(
  String principal,
  List<String> readyIntents, {
  String scope = _scope,
  DateTime? now,
}) => PersistedOverviewQueueSnapshot.capture(
  scope: scope,
  principalId: principal,
  queue: OverviewQueue(
    ready: [
      for (final intent in readyIntents)
        makeObligation('cap-$intent', ownerId: principal, intent: intent),
    ],
    waiting: const [],
    scheduled: const [],
  ),
  now: now ?? DateTime.timestamp(),
);

/// Ready intents of every publication after the current one, so a stale
/// response that is later overwritten is still caught.
List<List<String>> _recordPublications(DashboardStore store) {
  final published = <List<String>>[];
  final sub = store.overviewQueue
      .skip(1)
      .listen(
        (state) => published.add([
          for (final o in state.queue?.ready ?? <ObligationDto>[])
            o.intent ?? '',
        ]),
      );
  addTearDown(sub.cancel);
  return published;
}

/// Receipt line for the held cases: wall time from mounting Overview to the
/// first frame with rows, and the requests that frame waited on (none).
void _recordFirstUsefulContent(String label, Stopwatch mounted, int requests) {
  // ignore: avoid_print
  print(
    '[#992] $label: rows on first frame after ${mounted.elapsedMicroseconds}us; '
    'requests in flight: $requests, answered before rows: 0',
  );
}

List<String> _readyIntents(DashboardStore store) => [
  for (final o in store.overviewQueue.value.queue?.ready ?? <ObligationDto>[])
    o.intent ?? '',
];

Widget _elsewhere() =>
    const MaterialApp(home: Scaffold(body: Text('Another view')));

FakeApi _populatedApi() =>
    FakeApi(base: Uri.parse(_scope))
      ..obligationsResult = [
        makeObligation(
          'ob-ready',
          ownerId: testUserPrincipalId,
          intent: 'Ready decision',
        ),
        makeObligation(
          'ob-waiting',
          ownerId: testUserPrincipalId,
          intent: 'Waiting decision',
          status: 'waiting',
        ),
        makeObligation(
          'ob-blocker',
          parentId: 'ob-waiting',
          ownerId: 'worker-1',
          intent: 'Child work',
        ),
      ];

void main() {
  testWidgets(
    'a return to Overview paints the previous queue while the refresh is held',
    (tester) async {
      await tester.runAsync(() async {
        final api = _populatedApi();
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);

        await tester.pumpWidget(_overview(store));
        await tester.pump();
        await tester.pump();
        expect(find.text('Ready decision'), findsOneWidget);
        expect(find.text('Waiting decision'), findsOneWidget);

        await tester.pumpWidget(_elsewhere());
        final gate = Completer<void>();
        api.obligationQueuePagesGate = gate;
        final requestsBefore = api.fetchObligationsCalls.length;

        final mounted = Stopwatch()..start();
        await tester.pumpWidget(_overview(store));

        // First frame of the return, with every queue page still held.
        expect(find.text('Ready decision'), findsOneWidget);
        mounted.stop();
        expect(find.text('Waiting decision'), findsOneWidget);
        expect(find.text('2 obligations'), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsNothing);
        // Revalidation is still sent: one page per section.
        await tester.pump();
        expect(api.fetchObligationsCalls.length - requestsBefore, 3);
        _recordFirstUsefulContent('tab return', mounted, 3);

        api.obligationsResult = [
          ...api.obligationsResult,
          makeObligation(
            'ob-new',
            ownerId: testUserPrincipalId,
            intent: 'Newly ready',
          ),
        ];
        gate.complete();
        await Future<void>.delayed(Duration.zero);
        await tester.pump();
        await tester.pump();
        // The held response was computed before `ob-new` existed.
        expect(find.text('Newly ready'), findsNothing);
        expect(find.text('Ready decision'), findsOneWidget);
      });
    },
  );

  testWidgets(
    'a reload paints the persisted queue before the held response arrives',
    (tester) async {
      await tester.runAsync(() async {
        final cache = FakeObligationsCache()
          ..saveOverviewQueue(_capture(testUserPrincipalId, ['Kept decision']));
        final api = _populatedApi()
          ..obligationQueuePagesGate = Completer<void>();
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          obligationsCache: cache,
        );
        // Nothing is exposed before the viewer resolves.
        expect(store.overviewQueue.value.queue, isNull);
        await store.init();
        addTearDown(store.dispose);

        final mounted = Stopwatch()..start();
        await tester.pumpWidget(_overview(store));
        expect(find.text('Kept decision'), findsOneWidget);
        mounted.stop();
        expect(find.text('1 obligation'), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsNothing);
        await tester.pump();
        expect(api.fetchObligationsCalls, hasLength(3));
        _recordFirstUsefulContent('reload', mounted, 3);

        api.obligationQueuePagesGate!.complete();
        await Future<void>.delayed(Duration.zero);
        await tester.pump();
        await tester.pump();
        expect(find.text('Kept decision'), findsNothing);
        expect(find.text('Ready decision'), findsOneWidget);
        final saved = cache.loadOverviewQueue(
          scope: _scope,
          principalId: testUserPrincipalId,
        )!;
        expect(saved.queue.ready.single.id, 'ob-ready');
        expect(saved.queue.waiting.single.id, 'ob-waiting');
        expect(saved.queue.blockers['ob-waiting']!.single.id, 'ob-blocker');
      });
    },
  );

  testWidgets('a failed refresh keeps the rows and offers the retry', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = _populatedApi();
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      addTearDown(store.dispose);
      await tester.pumpWidget(_overview(store));
      await tester.pump();
      await tester.pump();

      api.obligationQueuePagesError = StateError('offline');
      await tester.tap(find.byTooltip('Refresh Queue'));
      await Future<void>.delayed(Duration.zero);
      await tester.pump();
      expect(find.text('Ready decision'), findsOneWidget);
      expect(find.text('Waiting decision'), findsOneWidget);
      expect(find.textContaining('Queue unavailable:'), findsOneWidget);

      api.obligationQueuePagesError = null;
      await tester.tap(find.text('Retry'));
      await Future<void>.delayed(Duration.zero);
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('Queue unavailable:'), findsNothing);
      expect(find.text('Ready decision'), findsOneWidget);
    });
  });

  testWidgets('a cold failure still shows the existing error and retry', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = _populatedApi()
        ..obligationQueuePagesError = StateError('offline');
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      addTearDown(store.dispose);
      await tester.pumpWidget(_overview(store));
      await Future<void>.delayed(Duration.zero);
      await tester.pump();
      expect(find.textContaining('Queue unavailable:'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(find.text('No obligations in your queue.'), findsNothing);
    });
  });

  testWidgets('waiting rows paint before their blocker details answer', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = _populatedApi()..obligationDetailGate = Completer<void>();
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      addTearDown(store.dispose);
      await tester.pumpWidget(_overview(store));
      await Future<void>.delayed(Duration.zero);
      await tester.pump();

      expect(find.text('Ready decision'), findsOneWidget);
      expect(find.text('Waiting decision'), findsOneWidget);
      expect(store.overviewQueue.value.queue!.blockers, isEmpty);

      api.obligationDetailGate!.complete();
      await Future<void>.delayed(Duration.zero);
      await tester.pump();
      expect(
        store.overviewQueue.value.queue!.blockers['ob-waiting']!.single.id,
        'ob-blocker',
      );
    });
  });

  group('store', () {
    test('a failed blocker detail leaves only that row unenriched', () async {
      final api = _populatedApi()
        ..obligationsResult = [
          ..._populatedApi().obligationsResult,
          makeObligation(
            'ob-waiting-2',
            ownerId: testUserPrincipalId,
            status: 'waiting',
          ),
          makeObligation('ob-blocker-2', parentId: 'ob-waiting-2'),
        ]
        ..obligationDetailByHistory = (id, _) {
          if (id == 'ob-waiting') throw StateError('detail failed');
          return ObligationDetailSnapshot(
            obligation: makeObligation(id),
            parent: null,
            children: const [],
            blockingChildren: [makeObligation('ob-blocker-2')],
            blockedBy: const [],
            blockedByTotal: 0,
            blockedByHasMore: false,
            blocks: const [],
            blocksTotal: 0,
            blocksHasMore: false,
          );
        };
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      await store.refreshOverviewQueue();
      final state = store.overviewQueue.value;
      expect(state.error, isNull);
      expect(state.queue!.waiting, hasLength(2));
      expect(state.queue!.blockers.keys, ['ob-waiting-2']);
      await store.dispose();
    });

    test('concurrent refreshes share one set of requests', () async {
      final api = _populatedApi();
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      await Future.wait([
        store.refreshOverviewQueue(),
        store.refreshOverviewQueue(),
      ]);
      expect(api.fetchObligationsCalls, hasLength(3));
      await store.dispose();
    });

    test(
      'a response for the previous viewer cannot populate the next one',
      () async {
        final cache = FakeObligationsCache()
          ..saveOverviewQueue(_capture(_otherViewer, ['Other viewer kept']));
        final api = _populatedApi();
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          obligationsCache: cache,
        );
        await store.init();
        await store.refreshOverviewQueue();
        expect(_readyIntents(store), ['Ready decision']);

        final gate = api.obligationQueuePagesGate = Completer<void>();
        final inFlight = store.refreshOverviewQueue();
        await pumpEventQueue();
        api.dashboardConfigResult = _configFor(_otherViewer);
        await store.refreshDashboardConfig();
        // The switch replaces the prior viewer's rows with the next viewer's
        // own capture, never a mix.
        expect(_readyIntents(store), ['Other viewer kept']);
        final published = _recordPublications(store);

        api.obligationsResult = [
          ...api.obligationsResult,
          makeObligation(
            'ob-other',
            ownerId: _otherViewer,
            intent: 'Other viewer live',
          ),
        ];
        gate.complete();
        api.obligationQueuePagesGate = null;
        await inFlight;
        expect(_readyIntents(store), ['Other viewer live']);
        await pumpEventQueue();
        expect(published, isNotEmpty);
        expect(
          published.where((ready) => ready.contains('Ready decision')),
          isEmpty,
        );
        expect(api.fetchObligationsCalls.map((c) => c.ownerId).toSet(), {
          testUserPrincipalId,
          _otherViewer,
        });
        expect(
          cache
              .loadOverviewQueue(scope: _scope, principalId: _otherViewer)!
              .queue
              .ready
              .single
              .id,
          'ob-other',
        );
        await store.dispose();
      },
    );

    test('a viewer switch without a capture clears the prior rows', () async {
      final api = _populatedApi();
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      await store.refreshOverviewQueue();
      api.dashboardConfigResult = _configFor(_otherViewer);
      await store.refreshDashboardConfig();
      expect(store.overviewQueue.value.queue, isNull);
      expect(store.overviewQueue.value.error, isNull);
      await store.dispose();
    });

    test(
      "the viewer's mutation drops the response it overtook and refreshes",
      () async {
        final cache = FakeObligationsCache();
        final api = _populatedApi();
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          obligationsCache: cache,
        );
        await store.init();
        await store.refreshOverviewQueue();
        expect(cache.overviewSaveCount, 2);

        final gate = api.obligationQueuePagesGate = Completer<void>();
        final inFlight = store.refreshOverviewQueue();
        await pumpEventQueue();
        api.obligationsResult = [
          for (final o in api.obligationsResult)
            if (o.id == 'ob-ready')
              makeObligation(
                'ob-ready',
                ownerId: testUserPrincipalId,
                intent: 'Ready decision',
                status: 'done',
              )
            else
              o,
        ];
        await store.mutateObligations(() async {});
        expect(
          cache.loadOverviewQueue(
            scope: _scope,
            principalId: testUserPrincipalId,
          ),
          isNull,
        );
        // Rows stay on screen while the follow-up runs.
        expect(_readyIntents(store), ['Ready decision']);
        final published = _recordPublications(store);

        gate.complete();
        api.obligationQueuePagesGate = null;
        await inFlight;
        // The held response predates the mutation; only the follow-up landed.
        expect(_readyIntents(store), isEmpty);
        await pumpEventQueue();
        expect(published, isNotEmpty);
        expect(published.where((ready) => ready.isNotEmpty), isEmpty);
        expect(store.overviewQueue.value.queue!.waiting, hasLength(1));
        expect(api.fetchObligationsCalls, hasLength(9));
        expect(
          cache
              .loadOverviewQueue(
                scope: _scope,
                principalId: testUserPrincipalId,
              )!
              .queue
              .ready,
          isEmpty,
        );
        await store.dispose();
      },
    );

    test(
      'an event for a queued obligation refreshes; an unrelated one does not',
      () async {
        final cache = FakeObligationsCache();
        final api = _populatedApi();
        final stream = FakeStream();
        final store = DashboardStore(
          api: api,
          stream: stream,
          obligationsCache: cache,
        );
        await store.init();
        await store.refreshOverviewQueue();
        final baseline = api.fetchObligationsCalls.length;

        stream.meshCtrl.add(
          makeEvent(
            'e-unrelated',
            'obligation_checkpoint_set',
            actor: 'worker-1',
            detail: 'someone-elses',
          ),
        );
        await pumpEventQueue();
        expect(api.fetchObligationsCalls.length, baseline);
        expect(cache.overviewInvalidateCount, 0);

        api.obligationsResult = [
          for (final o in api.obligationsResult)
            if (o.id == 'ob-ready')
              makeObligation(
                'ob-ready',
                ownerId: testUserPrincipalId,
                intent: 'Ready decision',
                checkpoint: 'Now halfway',
              )
            else
              o,
        ];
        stream.meshCtrl.add(
          makeEvent(
            'e-queued',
            'obligation_checkpoint_set',
            actor: 'worker-1',
            detail: 'ob-ready',
          ),
        );
        await pumpEventQueue();
        expect(api.fetchObligationsCalls.length, baseline + 3);
        expect(cache.overviewInvalidateCount, 1);
        expect(
          store.overviewQueue.value.queue!.ready.single.checkpoint,
          'Now halfway',
        );

        stream.meshCtrl.add(
          makeEvent(
            'e-status',
            'obligation_status_changed',
            actor: 'worker-1',
            payload: '{"changes":[{"id":"ob-blocker","status":"done"}]}',
          ),
        );
        await pumpEventQueue();
        expect(api.fetchObligationsCalls.length, baseline + 6);
        await store.dispose();
      },
    );

    test(
      'an event during a refresh lets it land but persists only the follow-up',
      () async {
        final cache = FakeObligationsCache();
        final api = _populatedApi();
        final stream = FakeStream();
        final store = DashboardStore(
          api: api,
          stream: stream,
          obligationsCache: cache,
        );
        await store.init();
        await store.refreshOverviewQueue();
        final saves = cache.overviewSaveCount;

        final gate = api.obligationQueuePagesGate = Completer<void>();
        final inFlight = store.refreshOverviewQueue();
        await pumpEventQueue();
        stream.meshCtrl.add(
          makeEvent(
            'e-queued',
            'obligation_checkpoint_set',
            actor: 'worker-1',
            detail: 'ob-ready',
          ),
        );
        await pumpEventQueue();
        api.obligationQueuePagesGate = null;
        gate.complete();
        await inFlight;
        // Held refresh (pages + details) is not saved; the follow-up's two
        // publications are.
        expect(cache.overviewSaveCount, saves + 2);
        expect(api.fetchObligationsCalls, hasLength(9));
        await store.dispose();
      },
    );
  });

  group('PersistedOverviewQueueSnapshot', () {
    final now = DateTime.utc(2026, 10, 10, 12);

    test('round-trips through its stored encoding', () {
      final queue = OverviewQueue(
        ready: [makeObligation('r', intent: 'Ready')],
        waiting: [makeObligation('w', status: 'waiting')],
        scheduled: [
          makeObligation('s', nextReadyAt: '2026-10-11T00:00:00.000Z'),
        ],
        blockers: {
          'w': [makeObligation('b', parentId: 'w')],
        },
      );
      final raw = PersistedOverviewQueueSnapshot.capture(
        scope: _scope,
        principalId: testUserPrincipalId,
        queue: queue,
        now: now,
      ).encode();
      final back = PersistedOverviewQueueSnapshot.fromJson(jsonDecode(raw))!;
      expect(back.queue.toJson(), queue.toJson());
      expect(back.savedAt, now.toIso8601String());
    });

    test('rejects other versions, malformed shapes and oversized payloads', () {
      final good = _capture(testUserPrincipalId, ['x'], now: now).toJson();
      expect(PersistedOverviewQueueSnapshot.fromJson(good), isNotNull);
      expect(
        PersistedOverviewQueueSnapshot.fromJson({...good, 'version': 99}),
        isNull,
      );
      expect(
        PersistedOverviewQueueSnapshot.fromJson({...good, 'queue': 'nope'}),
        isNull,
      );
      expect(
        PersistedOverviewQueueSnapshot.fromJson({
          ...good,
          'queue': {'ready': 'nope'},
        }),
        isNull,
      );
      expect(PersistedOverviewQueueSnapshot.fromJson('garbage'), isNull);
      expect(
        PersistedOverviewQueueSnapshot.fromJson(
          good,
          serializedByteCount:
              PersistedOverviewQueueSnapshot.maxSerializedBytes + 1,
        ),
        isNull,
      );
      final huge = _capture(testUserPrincipalId, [
        'x' * (PersistedOverviewQueueSnapshot.maxSerializedBytes + 1),
      ], now: now);
      expect(
        PersistedOverviewQueueSnapshot.rawFitsStorageBudget(huge.encode()),
        isFalse,
      );
      expect(PersistedOverviewQueueSnapshot.fromJson(huge.toJson()), isNull);
    });

    test('is usable only for its scope and viewer within its age', () {
      final snapshot = _capture(testUserPrincipalId, ['x'], now: now);
      bool usable({
        String scope = _scope,
        String principal = testUserPrincipalId,
        required DateTime at,
      }) => snapshot.isUsableAt(scope: scope, principalId: principal, now: at);
      expect(usable(at: now), isTrue);
      expect(usable(at: now, scope: 'http://elsewhere:4040'), isFalse);
      expect(usable(at: now, principal: _otherViewer), isFalse);
      expect(usable(at: now.add(const Duration(days: 8))), isFalse);
      expect(usable(at: now.subtract(const Duration(minutes: 2))), isFalse);
    });

    test('an unusable capture is dropped instead of replayed', () async {
      final cache = FakeObligationsCache()
        ..saveOverviewQueue(
          _capture(
            testUserPrincipalId,
            ['Stale'],
            now: DateTime.timestamp().subtract(const Duration(days: 8)),
          ),
        )
        ..saveOverviewQueue(
          _capture(_otherViewer, ['Elsewhere'], scope: 'http://other:1'),
        );
      final api = _populatedApi()..obligationQueuePagesGate = Completer();
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        obligationsCache: cache,
      );
      await store.init();
      expect(store.overviewQueue.value.queue, isNull);
      expect(
        cache.loadOverviewQueue(
          scope: _scope,
          principalId: testUserPrincipalId,
        ),
        isNull,
      );
      api.obligationQueuePagesGate!.complete();
      await store.dispose();
    });
  });
}
