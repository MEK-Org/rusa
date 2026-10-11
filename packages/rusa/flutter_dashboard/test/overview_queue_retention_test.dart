import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/obligation_store.dart';
import 'package:rusa_dashboard/obligation_sync.dart';
import 'package:rusa_dashboard/obligations_cache.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

/// Overview's My Queue renders a projection of the dashboard's shared
/// obligation store (#992): a return to Overview paints what the store holds
/// while any refresh is still in flight, and a request behind one view
/// updates every other.
Widget _overview(DashboardStore store) => MaterialApp(
  home: Scaffold(body: OverviewTab(store: store)),
);

Widget _work(DashboardStore store) => MaterialApp(
  home: Scaffold(
    body: WorkTab(store: store, onSelectView: (_) {}),
  ),
);

const _scope = 'http://localhost:4040';
const _otherViewer = '00000000-0000-4000-8000-000000000002';

DashboardConfigDto _configFor(String principal) =>
    DashboardConfigDto(quotaProviders: const {}, userPrincipalId: principal);

ObligationQuery _query(String principal, ObligationQueue queue) =>
    ObligationQuery(ownerId: principal, queue: queue);

List<ObligationQuery> _queuesOf(String principal) => [
  for (final queue in ObligationQueue.values) _query(principal, queue),
];

PersistedObligationEntitiesSnapshot _capture(
  String principal,
  List<String> readyIntents, {
  String scope = _scope,
  DateTime? now,
}) => PersistedObligationEntitiesSnapshot.capture(
  scope: scope,
  principalId: principal,
  queries: _queuesOf(principal),
  entities: ObligationEntities(
    byId: {
      for (final intent in readyIntents)
        'cap-$intent': makeObligation(
          'cap-$intent',
          ownerId: principal,
          intent: intent,
        ),
    },
  ),
  now: now ?? DateTime.timestamp(),
);

ObligationDto _stamped(ObligationDto o, String updatedAt) =>
    ObligationDto.fromJson({...o.toJson(), 'updatedAt': updatedAt});

List<ObligationDto> _rows(DashboardStore store, ObligationQueue queue) {
  final queries = store.viewerQueues();
  if (queries.isEmpty) return const [];
  return store.obligations.current.select(queries[queue.index]);
}

List<String> _readyIntents(DashboardStore store) => [
  for (final o in _rows(store, ObligationQueue.ready)) o.intent ?? '',
];

/// Subscribes to the viewer's queues the way a mounted Overview does, so
/// changes refresh them.
void _watchViewerQueues(DashboardStore store) {
  final sub = store.obligations.watch(store.viewerQueues()).listen((_) {});
  addTearDown(sub.cancel);
}

/// Ready intents of every projection published after the current one, so a
/// stale response that is later overwritten is still caught.
List<List<String>> _recordPublications(DashboardStore store) {
  final queries = store.viewerQueues();
  final published = <List<String>>[];
  final sub = store.obligations
      .watch(queries)
      .skip(1)
      .listen(
        (p) => published.add([
          for (final o in p.of(queries[ObligationQueue.ready.index]))
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

/// [api]'s obligations with `ob-ready` replaced by [replacement].
List<ObligationDto> _replacingReady(FakeApi api, ObligationDto replacement) => [
  for (final o in api.obligationsResult)
    if (o.id == 'ob-ready') replacement else o,
];

void _emit(
  FakeStream stream,
  String id,
  String kind, {
  String? detail,
  String? payload,
}) => stream.meshCtrl.add(
  makeEvent(id, kind, actor: 'worker-1', detail: detail, payload: payload),
);

void main() {
  testWidgets(
    'a return to Overview paints the previous queue while the refresh is held',
    (tester) async {
      await tester.runAsync(() async {
        final api = _populatedApi();
        final stream = FakeStream();
        final store = DashboardStore(api: api, stream: stream);
        await store.init();
        addTearDown(store.dispose);

        await tester.pumpWidget(_overview(store));
        await tester.pump();
        await tester.pump();
        expect(find.text('Ready decision'), findsOneWidget);
        expect(find.text('Waiting decision'), findsOneWidget);

        await tester.pumpWidget(_elsewhere());
        // While away, a change touches a row the queue shows.
        _emit(
          stream,
          'e-away',
          'obligation_checkpoint_set',
          detail: 'ob-ready',
        );
        await pumpEventQueue();
        final gate = Completer<void>();
        api.obligationQueuePagesGate = gate;
        final requestsBefore = api.fetchObligationsCalls.length;

        final mounted = Stopwatch()..start();
        await tester.pumpWidget(_overview(store));

        // First frame of the return, with the revalidation still held.
        expect(find.text('Ready decision'), findsOneWidget);
        mounted.stop();
        expect(find.text('Waiting decision'), findsOneWidget);
        expect(find.text('2 obligations'), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsNothing);
        // Every section is revalidated behind the stored rows.
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

  testWidgets('every return revalidates, sharing a request still in flight', (
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
      expect(api.fetchObligationsCalls, hasLength(3));

      final gate = api.obligationQueuePagesGate = Completer<void>();
      await tester.pumpWidget(_elsewhere());
      await tester.pumpWidget(_overview(store));
      await tester.pump();
      expect(find.text('Ready decision'), findsOneWidget);
      expect(api.fetchObligationsCalls, hasLength(6));
      // A return while those are out shares them.
      await tester.pumpWidget(_elsewhere());
      await tester.pumpWidget(_overview(store));
      await tester.pump();
      expect(find.text('Ready decision'), findsOneWidget);
      expect(api.fetchObligationsCalls, hasLength(6));

      gate.complete();
      api.obligationQueuePagesGate = null;
      await Future<void>.delayed(Duration.zero);
      await tester.pump();
      await tester.tap(find.byTooltip('Refresh Queue'));
      await Future<void>.delayed(Duration.zero);
      await tester.pump();
      expect(api.fetchObligationsCalls, hasLength(9));
    });
  });

  testWidgets(
    'a reload paints the persisted store before the held response arrives',
    (tester) async {
      await tester.runAsync(() async {
        final cache = FakeObligationsCache()
          ..saveEntities(_capture(testUserPrincipalId, ['Kept decision']));
        final api = _populatedApi()
          ..obligationQueuePagesGate = Completer<void>();
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          obligationsCache: cache,
        );
        // Nothing is exposed before the viewer resolves.
        expect(store.viewerQueues(), isEmpty);
        expect(store.obligations.current.byId, isEmpty);
        await store.init();
        addTearDown(store.dispose);

        final mounted = Stopwatch()..start();
        await tester.pumpWidget(_overview(store));
        expect(find.text('Kept decision'), findsOneWidget);
        mounted.stop();
        expect(find.text('1 obligation'), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsNothing);
        await tester.pump();
        // A replayed capture is shown, never trusted: every section is asked.
        expect(api.fetchObligationsCalls, hasLength(3));
        _recordFirstUsefulContent('reload', mounted, 3);

        api.obligationQueuePagesGate!.complete();
        await Future<void>.delayed(Duration.zero);
        await tester.pump();
        await tester.pump();
        expect(find.text('Kept decision'), findsNothing);
        expect(find.text('Ready decision'), findsOneWidget);
        final saved = cache.loadEntities(
          scope: _scope,
          principalId: testUserPrincipalId,
        )!;
        expect(saved.queries.toSet(), _queuesOf(testUserPrincipalId).toSet());
        expect(saved.entities.byId.keys.toSet(), {
          'ob-ready',
          'ob-waiting',
          'ob-blocker',
        });
        expect(saved.entities.blockers, {
          'ob-waiting': ['ob-blocker'],
        });
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

  testWidgets('a failed refresh over an empty queue shows the error alone', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi(base: Uri.parse(_scope));
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      addTearDown(store.dispose);
      await tester.pumpWidget(_overview(store));
      await tester.pump();
      await tester.pump();
      expect(find.text('No obligations in your queue.'), findsOneWidget);

      api.obligationQueuePagesError = StateError('offline');
      await tester.tap(find.byTooltip('Refresh Queue'));
      await Future<void>.delayed(Duration.zero);
      await tester.pump();
      expect(find.textContaining('Queue unavailable:'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(find.text('No obligations in your queue.'), findsNothing);
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
      expect(store.obligations.current.blockers, isEmpty);

      api.obligationDetailGate!.complete();
      await Future<void>.delayed(Duration.zero);
      await tester.pump();
      expect(
        store.obligations.current.blockersOf('ob-waiting')!.single.id,
        'ob-blocker',
      );
    });
  });

  group('across views', () {
    testWidgets('a Work load paints Overview before its own request answers', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final api = _populatedApi();
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);
        int queueRequests() =>
            api.fetchObligationsCalls.where((c) => c.queue != null).length;

        // A cold session opens Work first.
        await tester.pumpWidget(_work(store));
        await tester.pump();
        await tester.pump();
        expect(api.fetchObligationForestCalls, isNotEmpty);
        expect(find.text('Ready decision'), findsOneWidget);
        expect(queueRequests(), 0);

        final gate = api.obligationQueuePagesGate = Completer<void>();
        await tester.pumpWidget(_overview(store));
        // First frame: Work's response, while Overview's requests are held.
        expect(find.text('Ready decision'), findsOneWidget);
        expect(find.text('Waiting decision'), findsOneWidget);
        await tester.pump();
        expect(queueRequests(), 3);
        gate.complete();
      });
    });

    testWidgets('a forest the previous viewer asked for never reaches the '
        "next viewer's store", (tester) async {
      await tester.runAsync(() async {
        final api = _populatedApi();
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);
        final gate = Completer<void>();
        api.forestGates.add(gate);
        await tester.pumpWidget(_work(store));
        await tester.pump();
        expect(api.fetchObligationForestCalls, hasLength(1));

        // What the next viewer's own requests find.
        api.obligationsResult = [
          makeObligation(
            'ob-other',
            ownerId: _otherViewer,
            intent: 'Other viewer live',
          ),
        ];
        api.dashboardConfigResult = _configFor(_otherViewer);
        await store.refreshDashboardConfig();
        gate.complete();
        await Future<void>.delayed(Duration.zero);
        await tester.pump();
        await tester.pump();
        expect(store.obligations['ob-ready'], isNull);
        expect(store.obligations['ob-waiting'], isNull);
      });
    });

    testWidgets('an Overview refresh updates the Work rows beside it', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(2400, 1600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.runAsync(() async {
        final api = _populatedApi();
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Row(
                children: [
                  Expanded(child: OverviewTab(store: store)),
                  Expanded(
                    child: WorkTab(store: store, onSelectView: (_) {}),
                  ),
                ],
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.text('Ready decision'), findsNWidgets(2));
        final forestRequests = api.fetchObligationForestCalls.length;

        api.obligationsResult = _replacingReady(
          api,
          makeObligation(
            'ob-ready',
            ownerId: testUserPrincipalId,
            intent: 'Revised decision',
          ),
        );
        await tester.tap(
          find.descendant(
            of: find.byType(OverviewTab),
            matching: find.byTooltip('Refresh Queue'),
          ),
        );
        await Future<void>.delayed(Duration.zero);
        await tester.pump();
        await tester.pump();
        expect(find.text('Ready decision'), findsNothing);
        expect(find.text('Revised decision'), findsNWidgets(2));
        expect(api.fetchObligationForestCalls, hasLength(forestRequests));
      });
    });

    testWidgets('a row an Overview refresh no longer finds shows its current '
        'copy in Work and its detail, never the old forest row', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(2400, 1600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.runAsync(() async {
        final api = _populatedApi()
          ..obligationsResult = [
            for (final o in _populatedApi().obligationsResult)
              _stamped(o, '2026-10-10T12:00:00.000Z'),
          ];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Row(
                children: [
                  Expanded(child: OverviewTab(store: store)),
                  Expanded(
                    child: WorkTab(store: store, onSelectView: (_) {}),
                  ),
                ],
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        Finder inWork(String text) => find.descendant(
          of: find.byType(WorkTab),
          matching: find.text(text),
        );
        Finder inOverview(String text) => find.descendant(
          of: find.byType(OverviewTab),
          matching: find.text(text),
        );
        await tester.tap(inWork('Ready decision'));
        await tester.pump();
        await tester.pump();
        // The row and its open detail.
        expect(inWork('Ready decision'), findsNWidgets(2));
        expect(inOverview('Ready decision'), findsOneWidget);
        expect(inWork('Waiting decision'), findsOneWidget);
        final forestRequests = api.fetchObligationForestCalls.length;

        // Reassigned elsewhere and reworded: no viewer queue page returns it,
        // so only its detail can say where it went.
        api.obligationsResult = _replacingReady(
          api,
          _stamped(
            makeObligation(
              'ob-ready',
              ownerId: 'worker-9',
              intent: 'Handed off decision',
            ),
            '2026-10-10T12:00:05.000Z',
          ),
        );
        // And the waiting row was deleted outright.
        api
          ..obligationsResult = [
            for (final o in api.obligationsResult)
              if (o.id != 'ob-waiting') o,
          ]
          ..deletedObligationIds = {'ob-waiting'};
        await tester.tap(
          find.descendant(
            of: find.byType(OverviewTab),
            matching: find.byTooltip('Refresh Queue'),
          ),
        );
        for (var i = 0; i < 3; i++) {
          await Future<void>.delayed(Duration.zero);
          await tester.pump();
        }
        expect(inOverview('Ready decision'), findsNothing);
        expect(inOverview('Handed off decision'), findsNothing);
        expect(inWork('Ready decision'), findsNothing);
        expect(inWork('Handed off decision'), findsNWidgets(2));
        expect(store.obligations['ob-ready']!.ownerId, 'worker-9');
        // Only the server's "not found" takes a row out of Work.
        expect(inWork('Waiting decision'), findsNothing);
        expect(inOverview('Waiting decision'), findsNothing);
        // The rest of Work's forest is untouched.
        expect(store.obligations['ob-blocker'], isNotNull);
        expect(api.fetchObligationForestCalls, hasLength(forestRequests));
      });
    });
  });

  group('DashboardStore', () {
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
      await store.obligationSync.refresh(store.viewerQueues());
      for (final q in store.viewerQueues()) {
        expect(store.obligationSync.freshnessOf(q).error, isNull);
      }
      expect(_rows(store, ObligationQueue.waiting), hasLength(2));
      expect(store.obligations.current.blockers.keys, ['ob-waiting-2']);
      await store.dispose();
    });

    test('concurrent refreshes share one request per section', () async {
      final api = _populatedApi();
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      await Future.wait([
        store.obligationSync.refresh(store.viewerQueues()),
        store.obligationSync.refresh(store.viewerQueues()),
        store.obligationSync.refresh(store.viewerQueues()),
      ]);
      expect(api.fetchObligationsCalls, hasLength(3));
      await store.dispose();
    });

    test(
      'a response for the previous viewer cannot populate the next one',
      () async {
        final cache = FakeObligationsCache()
          ..saveEntities(_capture(_otherViewer, ['Other viewer kept']));
        final api = _populatedApi();
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          obligationsCache: cache,
        );
        await store.init();
        await store.obligationSync.refresh(store.viewerQueues());
        expect(_readyIntents(store), ['Ready decision']);

        final gate = api.obligationQueuePagesGate = Completer<void>();
        final inFlight = store.obligationSync.refresh(store.viewerQueues());
        await pumpEventQueue();
        api.dashboardConfigResult = _configFor(_otherViewer);
        await store.refreshDashboardConfig();
        // The switch replaces the prior viewer's store with the next viewer's
        // own capture, never a mix.
        expect(store.viewerQueues(), _queuesOf(_otherViewer));
        expect(_readyIntents(store), ['Other viewer kept']);
        expect(store.obligations['ob-ready'], isNull);
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
        await store.obligationSync.refresh(store.viewerQueues());
        expect(_readyIntents(store), ['Other viewer live']);
        expect(store.obligations['ob-ready'], isNull);
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
        final saved = cache.loadEntities(
          scope: _scope,
          principalId: _otherViewer,
        )!;
        expect(saved.entities.byId.keys, ['ob-other']);
        await store.dispose();
      },
    );

    test('a viewer switch without a capture clears the prior rows', () async {
      final api = _populatedApi();
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      await store.obligationSync.refresh(store.viewerQueues());
      api.dashboardConfigResult = _configFor(_otherViewer);
      await store.refreshDashboardConfig();
      expect(store.obligations.current.byId, isEmpty);
      for (final q in store.viewerQueues()) {
        final f = store.obligationSync.freshnessOf(q);
        expect(f.known, isFalse);
        expect(f.error, isNull);
      }
      await store.dispose();
    });

    test('a first request a viewer switch overtook is asked again when the '
        'viewer returns', () async {
      final api = _populatedApi();
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      _watchViewerQueues(store);
      final gate = api.obligationQueuePagesGate = Completer<void>();
      final first = store.obligationSync.refresh(store.viewerQueues());
      await pumpEventQueue();

      api.dashboardConfigResult = _configFor(_otherViewer);
      await store.refreshDashboardConfig();
      api.dashboardConfigResult = _configFor(testUserPrincipalId);
      await store.refreshDashboardConfig();
      expect(store.viewerQueues(), _queuesOf(testUserPrincipalId));
      final returned = store.obligationSync.refresh(store.viewerQueues());

      api.obligationQueuePagesGate = null;
      gate.complete();
      await Future.wait([first, returned]);
      // The held requests belong to the first visit; the return got its own.
      expect(
        api.fetchObligationsCalls.where(
          (c) => c.ownerId == testUserPrincipalId,
        ),
        hasLength(6),
      );
      expect(_readyIntents(store), ['Ready decision']);
      expect(
        store.obligationSync.freshnessOf(store.viewerQueues().first).known,
        isTrue,
      );
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
        _watchViewerQueues(store);
        await store.obligationSync.refresh(store.viewerQueues());
        // One save per settled section, and one after the blockers.
        expect(cache.entitySaveCount, 4);

        final gate = api.obligationQueuePagesGate = Completer<void>();
        final inFlight = store.obligationSync.refresh(store.viewerQueues());
        await pumpEventQueue();
        api.obligationsResult = _replacingReady(
          api,
          makeObligation(
            'ob-ready',
            ownerId: testUserPrincipalId,
            intent: 'Ready decision',
            status: 'done',
          ),
        );
        await store.mutateObligations(() async {});
        expect(
          cache.loadEntities(scope: _scope, principalId: testUserPrincipalId),
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
        expect(_rows(store, ObligationQueue.waiting), hasLength(1));
        expect(api.fetchObligationsCalls, hasLength(9));
        final saved = cache.loadEntities(
          scope: _scope,
          principalId: testUserPrincipalId,
        )!;
        expect(saved.entities.byId.containsKey('ob-ready'), isFalse);
        expect(
          saved.queries,
          contains(_query(testUserPrincipalId, ObligationQueue.ready)),
        );
        await store.dispose();
      },
    );

    test(
      'while a view watches, an event that can move a section refreshes it',
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
        await store.obligationSync.refresh(store.viewerQueues());
        final baseline = api.fetchObligationsCalls.length;
        var events = 0;
        void emit(String kind, {String? detail, String? payload}) => _emit(
          stream,
          'e-${events++}',
          kind,
          detail: detail,
          payload: payload,
        );

        // Unwatched, the capture is dropped and the next mount refreshes.
        emit('obligation_checkpoint_set', detail: 'ob-ready');
        await pumpEventQueue();
        expect(api.fetchObligationsCalls.length, baseline);
        expect(cache.entityInvalidateCount, 1);
        final ready = _query(testUserPrincipalId, ObligationQueue.ready);
        expect(store.obligationSync.freshnessOf(ready).stale, isTrue);
        await store.obligationSync.refresh([ready]);
        expect(api.fetchObligationsCalls.length, baseline + 1);
        expect(store.obligationSync.freshnessOf(ready).stale, isFalse);

        _watchViewerQueues(store);
        emit('obligation_checkpoint_set', detail: 'someone-elses');
        emit(
          'obligation_status_changed',
          payload: '{"changes":[{"id":"someone-elses","status":"done"}]}',
        );
        await pumpEventQueue();
        expect(api.fetchObligationsCalls.length, baseline + 1);
        expect(cache.entityInvalidateCount, 1);

        // A waiting row's blocker is part of what the waiting section shows.
        emit('obligation_checkpoint_set', detail: 'ob-blocker');
        await pumpEventQueue();
        expect(api.fetchObligationsCalls.length, baseline + 2);
        expect(api.fetchObligationsCalls.last.queue, 'waiting');

        api.obligationsResult = _replacingReady(
          api,
          makeObligation(
            'ob-ready',
            ownerId: testUserPrincipalId,
            intent: 'Ready decision',
            checkpoint: 'Now halfway',
          ),
        );
        emit('obligation_checkpoint_set', detail: 'ob-ready');
        await pumpEventQueue();
        expect(api.fetchObligationsCalls.length, baseline + 3);
        expect(store.obligations['ob-ready']!.checkpoint, 'Now halfway');

        // An obligation entering the queue is not among the rows shown, so
        // every section it could enter is asked.
        api.obligationsResult = [
          ...api.obligationsResult,
          makeObligation(
            'ob-new',
            ownerId: testUserPrincipalId,
            intent: 'Newly ready',
          ),
        ];
        emit(
          'obligation_status_changed',
          payload: '{"changes":[{"id":"ob-new","status":"ready"}]}',
        );
        await pumpEventQueue();
        expect(api.fetchObligationsCalls.length, baseline + 5);
        expect(
          api.fetchObligationsCalls.skip(baseline + 3).map((c) => c.queue),
          unorderedEquals(['ready', 'waiting']),
        );
        expect(_readyIntents(store), ['Newly ready', 'Ready decision']);
        await store.dispose();
      },
    );

    test('a response an event overtook shows its rows but neither marks rows '
        'absent nor persists', () async {
      final cache = FakeObligationsCache();
      final api = _populatedApi();
      final stream = FakeStream();
      final store = DashboardStore(
        api: api,
        stream: stream,
        obligationsCache: cache,
      );
      await store.init();
      _watchViewerQueues(store);
      await store.obligationSync.refresh(store.viewerQueues());
      final ready = _query(testUserPrincipalId, ObligationQueue.ready);

      final held = api.obligationQueuePagesGate = Completer<void>();
      final inFlight = store.obligationSync.refresh([ready]);
      await pumpEventQueue();
      // After the held page was computed, another view learns of a newly
      // ready row, and its status event arrives.
      final late = makeObligation(
        'ob-late',
        ownerId: testUserPrincipalId,
        intent: 'Late arrival',
      );
      api.obligationsResult = [...api.obligationsResult, late];
      store.obligations.upsert([late]);
      final followUp = api.obligationQueuePagesGate = Completer<void>();
      _emit(
        stream,
        'e-late',
        'obligation_status_changed',
        payload: '{"changes":[{"id":"ob-late","status":"ready"}]}',
      );
      await pumpEventQueue();
      final saves = cache.entitySaveCount;

      held.complete();
      await pumpEventQueue();
      // The held page lacks `ob-late`, but the event may be why: it stays.
      expect(_readyIntents(store), contains('Late arrival'));
      expect(store.obligationSync.freshnessOf(ready).stale, isTrue);
      expect(
        cache.loadEntities(scope: _scope, principalId: testUserPrincipalId),
        isNull,
      );
      expect(cache.entitySaveCount, saves);

      api.obligationQueuePagesGate = null;
      followUp.complete();
      await inFlight;
      expect(_readyIntents(store), ['Late arrival', 'Ready decision']);
      expect(store.obligationSync.freshnessOf(ready).stale, isFalse);
      expect(cache.entitySaveCount, greaterThan(saves));
      expect(
        cache
            .loadEntities(scope: _scope, principalId: testUserPrincipalId)!
            .entities
            .byId
            .keys,
        containsAll(['ob-ready', 'ob-late']),
      );
      await store.dispose();
    });

    test('an unusable capture is dropped instead of replayed', () async {
      final cache = FakeObligationsCache()
        ..saveEntities(
          _capture(
            testUserPrincipalId,
            ['Stale'],
            now: DateTime.timestamp().subtract(const Duration(days: 8)),
          ),
        )
        ..saveEntities(
          _capture(_otherViewer, ['Elsewhere'], scope: 'http://other:1'),
        );
      final api = _populatedApi();
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        obligationsCache: cache,
      );
      await store.init();
      expect(store.obligations.current.byId, isEmpty);
      for (final q in store.viewerQueues()) {
        expect(store.obligationSync.freshnessOf(q).known, isFalse);
      }
      expect(
        cache.loadEntities(scope: _scope, principalId: testUserPrincipalId),
        isNull,
      );
      await store.dispose();
    });
  });

  group('ObligationStore', () {
    const owner = testUserPrincipalId;
    final ready = _query(owner, ObligationQueue.ready);

    ObligationDto readyRow(String id, double priority) =>
        makeObligation(id, ownerId: owner, effectivePriority: priority);

    test(
      'a projection follows the server order and re-emits on change',
      () async {
        final store = ObligationStore();
        addTearDown(store.close);
        store.upsert([
          readyRow('b', 2),
          readyRow('a', 2),
          readyRow('c', 1),
          makeObligation('w', ownerId: owner, status: 'waiting'),
          makeObligation('x', ownerId: _otherViewer),
        ]);
        expect(store.current.select(ready).map((o) => o.id), ['c', 'a', 'b']);

        final seen = <List<String>>[];
        expect(store.isWatched(ready), isFalse);
        final sub = store
            .watch([ready])
            .listen((p) => seen.add([for (final o in p.of(ready)) o.id]));
        await pumpEventQueue();
        expect(store.isWatched(ready), isTrue);
        // Writing a row the projection does not show publishes nothing.
        store.upsert([makeObligation('y', ownerId: _otherViewer)]);
        await pumpEventQueue();
        store.upsert([readyRow('d', 0)]);
        await pumpEventQueue();
        expect(seen, [
          ['c', 'a', 'b'],
          ['d', 'c', 'a', 'b'],
        ]);
        await sub.cancel();
        expect(store.isWatched(ready), isFalse);
      },
    );

    test('a page marks what it left out absent from its query alone, and '
        'keeps the obligation for every other view', () {
      final store = ObligationStore();
      addTearDown(store.close);
      final a = readyRow('a', 1);
      final c = readyRow('c', 3);
      final waiting = makeObligation('w', ownerId: owner, status: 'waiting');
      final elsewhere = ObligationDto.fromJson({
        ...readyRow('x', 0).toJson(),
        'ownerId': 'someone',
      });
      store.upsert([a, readyRow('b', 2), c, waiting, elsewhere]);

      final missing = store.applyPage(
        ready,
        ObligationPage(
          obligations: [readyRow('b', 2)],
          total: 3,
          hasMore: true,
        ),
        reconcile: true,
      );
      // `a` sorts before the page's last row, so the server would have
      // returned it; `c` lies past the page and is left alone.
      expect(missing, ['a']);
      expect(store.current.select(ready).map((o) => o.id), ['b', 'c']);
      expect(store['a'], same(a));
      expect(store['w'], same(waiting));
      expect(store['x'], same(elsewhere));

      expect(
        store.applyPage(
          ready,
          ObligationPage(
            obligations: [readyRow('b', 2)],
            total: 1,
            hasMore: false,
          ),
          reconcile: false,
        ),
        isEmpty,
      );
      expect(store.current.select(ready).map((o) => o.id), ['b', 'c']);

      expect(
        store.applyPage(
          ready,
          ObligationPage(
            obligations: [readyRow('b', 2)],
            total: 1,
            hasMore: false,
          ),
          reconcile: true,
        ),
        unorderedEquals(['a', 'c']),
      );
      expect(store.current.select(ready).map((o) => o.id), ['b']);
      expect(store['a'], same(a));
      expect(store['c'], same(c));
      expect(store.current.deleted, isEmpty);
    });

    test('an empty partial page marks nothing absent', () {
      final store = ObligationStore();
      addTearDown(store.close);
      store.upsert([readyRow('a', 1)]);
      expect(
        store.applyPage(
          ready,
          const ObligationPage(obligations: [], total: 4, hasMore: true),
          reconcile: true,
        ),
        isEmpty,
      );
      expect(store.current.select(ready).single.id, 'a');
    });

    test('absence lifts only for a newer copy, a detail read, or a page of '
        'the query that shows the obligation again', () {
      final store = ObligationStore();
      addTearDown(store.close);
      final old = _stamped(readyRow('a', 1), '2026-10-10T12:00:00.000Z');
      store.upsert([old]);
      void markAbsent() => store.applyPage(
        ready,
        const ObligationPage(obligations: [], total: 0, hasMore: false),
        reconcile: true,
      );
      List<String> shown() => [
        for (final o in store.current.select(ready)) o.id,
      ];

      markAbsent();
      expect(shown(), isEmpty);
      // A re-read of the same write, as a later forest load returns, does not
      // contradict the page.
      store.upsert([_stamped(readyRow('a', 1), '2026-10-10T12:00:00.000Z')]);
      expect(shown(), isEmpty);
      store.upsert([_stamped(readyRow('a', 1), '2026-10-10T12:00:05.000Z')]);
      expect(shown(), ['a']);

      markAbsent();
      store.applyDetail(store['a']!);
      expect(shown(), ['a']);

      markAbsent();
      store.applyPage(
        ready,
        ObligationPage(obligations: [store['a']!], total: 1, hasMore: false),
        reconcile: true,
      );
      expect(shown(), ['a']);
    });

    test('a detail read moves the obligation to the queries its current '
        'fields name', () {
      final store = ObligationStore();
      addTearDown(store.close);
      final waitingQuery = _query(owner, ObligationQueue.waiting);
      final elsewhere = _query('someone', ObligationQueue.ready);
      store.upsert([
        _stamped(readyRow('a', 1), '2026-10-10T12:00:00.000Z'),
        _stamped(readyRow('b', 2), '2026-10-10T12:00:00.000Z'),
      ]);
      store.applyPage(
        ready,
        const ObligationPage(obligations: [], total: 0, hasMore: false),
        reconcile: true,
      );

      store.applyDetail(
        _stamped(
          makeObligation('a', ownerId: owner, status: 'waiting'),
          '2026-10-10T12:00:03.000Z',
        ),
      );
      store.applyDetail(
        _stamped(
          makeObligation('b', ownerId: 'someone', effectivePriority: 9),
          '2026-10-10T12:00:03.000Z',
        ),
      );
      expect(store.current.select(ready), isEmpty);
      expect(store.current.select(waitingQuery).single.id, 'a');
      expect(store.current.select(elsewhere).single.effectivePriority, 9);
    });

    test('only a deletion removes an obligation, with its blockers', () {
      final store = ObligationStore();
      addTearDown(store.close);
      final waitingQuery = _query(owner, ObligationQueue.waiting);
      store.upsert([makeObligation('w', ownerId: owner, status: 'waiting')]);
      store.setBlockers('w', [makeObligation('b1', parentId: 'w')]);
      expect(store.current.blockersOf('w')!.single.id, 'b1');
      expect(store['b1'], isNotNull);

      store.applyPage(
        waitingQuery,
        const ObligationPage(obligations: [], total: 0, hasMore: false),
        reconcile: true,
      );
      expect(store['w'], isNotNull);
      expect(store.current.blockersOf('w')!.single.id, 'b1');

      store.delete('w');
      expect(store['w'], isNull);
      expect(store.current.blockers, isEmpty);
      expect(store.current.absent, isEmpty);
      expect(store.current.deleted, {'w'});
      expect(store['b1'], isNotNull);

      // A response sent before the deletion never brings it back.
      final late = _stamped(
        makeObligation('w', ownerId: owner, status: 'waiting'),
        '2099-01-01T00:00:00.000Z',
      );
      store.upsert([late]);
      store.applyDetail(late);
      store.applyPage(
        waitingQuery,
        ObligationPage(obligations: [late], total: 1, hasMore: false),
        reconcile: true,
      );
      expect(store['w'], isNull);
      expect(store.current.select(waitingQuery), isEmpty);
    });

    test('a section shows its first page at most, in order', () {
      final store = ObligationStore();
      addTearDown(store.close);
      final count = ObligationQuery.pageLimit + 10;
      store.upsert([
        for (var i = count; i > 0; i--)
          readyRow('r${i.toString().padLeft(3, '0')}', i.toDouble()),
      ]);
      final shown = store.current.select(_query(owner, ObligationQueue.ready));
      expect(shown, hasLength(ObligationQuery.pageLimit));
      expect(shown.first.id, 'r001');
      expect(
        shown.last.id,
        'r${ObligationQuery.pageLimit.toString().padLeft(3, '0')}',
      );
    });

    test('a strictly older row never overwrites a newer one', () {
      final store = ObligationStore();
      addTearDown(store.close);
      final newer = _stamped(readyRow('a', 1), '2026-10-10T12:00:01.000Z');
      store.upsert([newer]);
      store.upsert([_stamped(readyRow('a', 9), '2026-10-10T12:00:00.000Z')]);
      expect(store['a'], same(newer));
      store.applyDetail(_stamped(readyRow('a', 9), '2026-10-10T12:00:00.000Z'));
      expect(store['a'], same(newer));

      final sameStamp = _stamped(readyRow('a', 5), '2026-10-10T12:00:01.000Z');
      store.upsert([sameStamp]);
      expect(store['a'], same(sameStamp));

      final unstamped = readyRow('a', 7);
      store.upsert([unstamped]);
      expect(store['a'], same(unstamped));
    });
  });

  group('ObligationSync', () {
    final query = _query(testUserPrincipalId, ObligationQueue.ready);

    test('an unwatched change only marks its query; a failure keeps what was '
        'known', () async {
      final api = _populatedApi();
      final store = ObligationStore();
      final sync = ObligationSync(api: api, store: store);
      addTearDown(store.close);
      addTearDown(sync.close);

      await sync.refresh([query]);
      expect(api.fetchObligationsCalls, hasLength(1));
      sync.obligationsChanged({'ob-ready'});
      await pumpEventQueue();
      expect(api.fetchObligationsCalls, hasLength(1));
      expect(sync.freshnessOf(query).stale, isTrue);

      api.obligationQueuePagesError = StateError('offline');
      await sync.refresh([query]);
      expect(sync.freshnessOf(query).error, isA<StateError>());
      expect(sync.freshnessOf(query).known, isTrue);
      expect(store['ob-ready'], isNotNull);
      api.obligationQueuePagesError = null;
      await sync.refresh([query]);
      expect(sync.freshnessOf(query).error, isNull);
      expect(sync.freshnessOf(query).stale, isFalse);
    });

    test('a request the viewer\'s own change overtook is asked again for '
        'whoever shares it', () async {
      final api = _populatedApi();
      final store = ObligationStore();
      final sync = ObligationSync(api: api, store: store);
      addTearDown(store.close);
      addTearDown(sync.close);
      final sub = store.watch([query]).listen((_) {});
      addTearDown(sub.cancel);

      final gate = api.obligationQueuePagesGate = Completer<void>();
      final first = sync.refresh([query]);
      await pumpEventQueue();
      api.obligationsResult = _replacingReady(
        api,
        makeObligation(
          'ob-ready',
          ownerId: testUserPrincipalId,
          intent: 'Changed by me',
        ),
      );
      sync.mutated();
      final shared = sync.refresh([query]);
      api.obligationQueuePagesGate = null;
      gate.complete();
      await Future.wait([first, shared]);
      expect(api.fetchObligationsCalls, hasLength(2));
      expect(
        [for (final o in store.current.select(query)) o.intent],
        ['Changed by me'],
      );
    });

    test(
      'an event naming a row past the shown page marks its query stale',
      () async {
        final api = _populatedApi();
        final store = ObligationStore();
        final sync = ObligationSync(api: api, store: store);
        addTearDown(store.close);
        addTearDown(sync.close);
        await sync.refresh([query]);
        store.upsert([
          for (var i = 1; i <= ObligationQuery.pageLimit; i++)
            makeObligation(
              'p$i',
              ownerId: testUserPrincipalId,
              effectivePriority: i.toDouble(),
            ),
          makeObligation(
            'late',
            ownerId: testUserPrincipalId,
            effectivePriority: 1000,
          ),
        ]);
        expect(
          store.current.select(query).map((o) => o.id),
          isNot(contains('late')),
        );
        sync.obligationsChanged({'late'});
        expect(sync.freshnessOf(query).stale, isTrue);
      },
    );

    test('a replayed query is known but still asked', () async {
      final api = _populatedApi();
      final store = ObligationStore();
      final sync = ObligationSync(api: api, store: store);
      addTearDown(store.close);
      addTearDown(sync.close);
      sync.reset(replayed: [query]);
      expect(sync.freshnessOf(query).known, isTrue);
      expect(sync.settledQueries, [query]);
      await sync.refresh([query]);
      expect(api.fetchObligationsCalls, hasLength(1));
    });

    test('a malformed status event marks every known query stale', () async {
      final api = _populatedApi();
      final store = ObligationStore();
      var dropped = 0;
      final sync = ObligationSync(
        api: api,
        store: store,
        onStale: () => dropped++,
      );
      addTearDown(store.close);
      addTearDown(sync.close);
      await sync.refresh([query]);
      sync.statusesChanged(const {});
      expect(sync.freshnessOf(query).stale, isTrue);
      expect(dropped, 1);
    });

    test('a row a settled page left out is read in detail: its current copy '
        'replaces it, not found deletes it, a failure keeps it', () async {
      const viewer = testUserPrincipalId;
      const before = '2026-10-10T12:00:00.000Z';
      const after = '2026-10-10T12:00:05.000Z';
      ObligationDto row(String id, {String owner = viewer, String? intent}) =>
          _stamped(makeObligation(id, ownerId: owner, intent: intent), before);
      final api = FakeApi(base: Uri.parse(_scope))
        ..obligationsResult = [
          row('handed-off'),
          row('closed'),
          row('deleted'),
          row('unreadable'),
          row('kept'),
          row('unrelated', owner: 'worker-1'),
        ];
      final store = ObligationStore();
      final sync = ObligationSync(api: api, store: store);
      addTearDown(store.close);
      addTearDown(sync.close);
      // Work's forest load put every row in the store; Overview's first page
      // showed the viewer's.
      store.upsert(api.obligationsResult);
      await sync.refresh([query]);
      expect(store.current.select(query), hasLength(5));
      final unreadable = store['unreadable'];
      final unrelated = store['unrelated'];

      api
        ..obligationsResult = [
          _stamped(
            makeObligation(
              'handed-off',
              ownerId: 'worker-9',
              intent: 'Handed off',
            ),
            after,
          ),
          _stamped(
            makeObligation('closed', ownerId: viewer, status: 'done'),
            after,
          ),
          _stamped(
            makeObligation('unreadable', ownerId: viewer, status: 'done'),
            after,
          ),
          row('kept'),
          row('unrelated', owner: 'worker-1'),
        ]
        ..deletedObligationIds = {'deleted'}
        ..obligationDetailErrors = {'unreadable': StateError('offline')};
      final detailsBefore = api.obligationDetailCallCount;
      await sync.refresh([query]);

      expect(store.current.select(query).map((o) => o.id), ['kept']);
      // Reads were for the four rows the page left out, nothing else.
      expect(api.obligationDetailCallCount - detailsBefore, 4);
      expect(store['handed-off']!.ownerId, 'worker-9');
      expect(store['handed-off']!.intent, 'Handed off');
      expect(store['closed']!.status, 'done');
      expect(store['deleted'], isNull);
      expect(store.current.deleted, {'deleted'});
      // A failed read proves nothing: the copy stays for every other view,
      // and only the page's query leaves it out.
      expect(store['unreadable'], same(unreadable));
      expect(store['unrelated'], same(unrelated));

      api.obligationDetailErrors = {};
      await sync.refresh([query]);
      expect(store['unreadable']!.status, 'done');
      expect(store.current.select(query).map((o) => o.id), ['kept']);
    });

    test('a row whose new priority put it past the first page comes back in '
        'its new place', () async {
      const viewer = testUserPrincipalId;
      ObligationDto row(String id, double priority, String at) => _stamped(
        makeObligation(id, ownerId: viewer, effectivePriority: priority),
        at,
      );
      const before = '2026-10-10T12:00:00.000Z';
      final api = FakeApi(base: Uri.parse(_scope))
        ..obligationPageLimit = 2
        ..obligationsResult = [
          row('a', 1, before),
          row('b', 2, before),
          row('c', 3, before),
        ];
      final store = ObligationStore();
      final sync = ObligationSync(api: api, store: store);
      addTearDown(store.close);
      addTearDown(sync.close);
      store.upsert(api.obligationsResult);
      await sync.refresh([query]);
      expect(store.current.select(query).map((o) => o.id), ['a', 'b', 'c']);

      // `a` was reprioritised: its cached priority still sorts it first, so
      // the first page's absence is all the client sees.
      api.obligationsResult = [
        row('b', 2, before),
        row('c', 3, before),
        row('a', 9, '2026-10-10T12:00:05.000Z'),
      ];
      await sync.refresh([query]);
      expect(store.current.select(query).map((o) => o.id), ['b', 'c', 'a']);
      expect(store['a']!.effectivePriority, 9);
    });
  });

  group('PersistedObligationEntitiesSnapshot', () {
    final now = DateTime.utc(2026, 10, 10, 12);

    test('round-trips through its stored encoding', () {
      final entities = ObligationEntities(
        byId: {
          'r': makeObligation(
            'r',
            ownerId: testUserPrincipalId,
            intent: 'Ready',
          ),
          'w': makeObligation(
            'w',
            ownerId: testUserPrincipalId,
            status: 'waiting',
          ),
          's': makeObligation(
            's',
            ownerId: testUserPrincipalId,
            status: 'scheduled',
            nextReadyAt: '2026-10-11T00:00:00.000Z',
          ),
          'b': makeObligation('b', parentId: 'w'),
          'unrelated': makeObligation('unrelated', ownerId: _otherViewer),
        },
        blockers: {
          'w': ['b'],
          'unrelated': ['b'],
        },
      );
      final snapshot = PersistedObligationEntitiesSnapshot.capture(
        scope: _scope,
        principalId: testUserPrincipalId,
        queries: _queuesOf(testUserPrincipalId),
        entities: entities,
        now: now,
      );
      // Only the captured queries' rows and their blockers are kept.
      expect(snapshot.entities.byId.keys.toSet(), {'r', 'w', 's', 'b'});
      expect(snapshot.entities.blockers, {
        'w': ['b'],
      });
      final back = PersistedObligationEntitiesSnapshot.fromJson(
        jsonDecode(snapshot.encode()),
      )!;
      expect(back.queries, _queuesOf(testUserPrincipalId));
      expect(
        back.entities.byId.map((id, o) => MapEntry(id, o.toJson())),
        snapshot.entities.byId.map((id, o) => MapEntry(id, o.toJson())),
      );
      expect(back.entities.blockers, snapshot.entities.blockers);
      expect(back.savedAt, now.toIso8601String());
    });

    test('rejects other versions, malformed shapes and oversized payloads', () {
      final good = _capture(testUserPrincipalId, ['x'], now: now).toJson();
      expect(PersistedObligationEntitiesSnapshot.fromJson(good), isNotNull);
      for (final bad in <Object?>[
        {...good, 'version': 99},
        {...good, 'obligations': 'nope'},
        {
          ...good,
          'obligations': ['nope'],
        },
        {...good, 'blockers': 'nope'},
        {
          ...good,
          'blockers': {'w': 'nope'},
        },
        {...good, 'queries': 'nope'},
        {
          ...good,
          'queries': [
            {'ownerId': 'o', 'queue': 'elsewhere'},
          ],
        },
        'garbage',
      ]) {
        expect(PersistedObligationEntitiesSnapshot.fromJson(bad), isNull);
      }
      expect(
        PersistedObligationEntitiesSnapshot.fromJson(
          good,
          serializedByteCount:
              PersistedObligationEntitiesSnapshot.maxSerializedBytes + 1,
        ),
        isNull,
      );
      final huge = _capture(testUserPrincipalId, [
        'x' * (PersistedObligationEntitiesSnapshot.maxSerializedBytes + 1),
      ], now: now);
      expect(
        PersistedObligationEntitiesSnapshot.rawFitsStorageBudget(huge.encode()),
        isFalse,
      );
      expect(
        PersistedObligationEntitiesSnapshot.fromJson(huge.toJson()),
        isNull,
      );
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
  });
}
