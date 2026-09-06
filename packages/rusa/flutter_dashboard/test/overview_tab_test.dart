import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/util.dart';
import 'package:rusa_dashboard/widgets/avatar.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

Widget _app(
  DashboardStore store, {
  ValueChanged<DashboardView>? onSelectView,
}) => MaterialApp(
  home: Scaffold(
    body: OverviewTab(store: store, onSelectView: onSelectView),
  ),
);

void main() {
  testWidgets('yield rows do not overflow at mobile (~390px) width ', (
    tester,
  ) async {
    await tester.runAsync(() async {
      const actor = '11111111-1111-4111-8111-111111111111';
      final api = FakeApi()
        ..threadsResult = [makeThread(actor)]
        ..eventPages = [
          EventPage(
            events: [
              makeEvent(
                'e1',
                'run_yielded',
                actor: actor,
                detail: 'complete',
                body:
                    'A long yield summary note that would overflow a '
                    'fixed-width timestamp + avatar + pill row on a '
                    'narrow mobile viewport if it were not stacked.',
              ),
            ],
            nextCursor: null,
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(_app(store));
      // Let the widget's initState refreshYieldEvents() fetch resolve.
      await tester.pump();
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(find.textContaining('A long yield summary note'), findsOneWidget);

      await store.dispose();
    });
  });

  testWidgets(
    'OverviewTab renders empty state when human:operator has no obligations ',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [
            makeObligation('actor-ob', ownerId: 'root', intent: 'Actor task'),
          ];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        expect(find.text('My Queue'), findsOneWidget);
        expect(find.text('No obligations in your queue.'), findsOneWidget);
        expect(find.text('0 obligations'), findsOneWidget);
        expect(
          find.widgetWithText(ElevatedButton, 'Create Obligation'),
          findsOneWidget,
        );

        await store.dispose();
      });
    },
  );

  testWidgets(
    'OverviewTab renders ready and waiting obligations for human:operator with focus link ',
    (tester) async {
      await tester.runAsync(() async {
        final readyOb = makeObligation(
          'ob-ready',
          ownerId: 'human:operator',
          intent: 'Approve PR review',
          status: 'ready',
          priority: 50.0,
          effectivePriority: 50.0,
          externalRef: 'github_pr:dummy-org/dummy-repoISSUE_NUM',
        );
        final waitingOb = makeObligation(
          'ob-waiting',
          ownerId: 'human:operator',
          intent: 'Merge deploy release',
          status: 'waiting',
          effectivePriority: 60.0,
        );
        final blockerChild = makeObligation(
          'ob-blocker',
          parentId: 'ob-waiting',
          ownerId: 'worker-1',
          intent: 'CI pass',
          status: 'ready',
        );
        final actorOnlyOb = makeObligation(
          'ob-actor-only',
          ownerId: 'worker-1',
          intent: 'Unrelated actor job',
          status: 'ready',
        );

        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [readyOb, waitingOb, blockerChild, actorOnlyOb];

        DashboardView? navigatedView;
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(
          _app(store, onSelectView: (v) => navigatedView = v),
        );
        await tester.pump();
        await tester.pump();

        // Check header and counts
        expect(find.text('My Queue'), findsOneWidget);
        expect(find.text('2 obligations'), findsOneWidget);
        expect(find.text('1 ready'), findsOneWidget);
        expect(find.text('1 waiting'), findsOneWidget);

        // Check ready items
        expect(find.text('Approve PR review'), findsOneWidget);
        expect(
          find.text('github_pr:dummy-org/dummy-repoISSUE_NUM'),
          findsOneWidget,
        );

        // Check waiting items and blocker
        expect(find.text('Merge deploy release'), findsOneWidget);
        expect(find.text('Blocked by direct children:'), findsOneWidget);
        expect(find.textContaining('CI pass (worker-1)'), findsOneWidget);

        // Unrelated actor obligation is NOT in My Queue
        expect(find.text('Unrelated actor job'), findsNothing);

        // Test deep-link navigation by tapping the row directly
        await tester.tap(find.text('Approve PR review'));
        await tester.pump();

        expect(store.focusedObligationId.value, 'ob-ready');
        expect(navigatedView, DashboardView.work);

        await store.dispose();
      });
    },
  );

  testWidgets('OverviewTab reorders ready obligations in My Queue ', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final ob1 = makeObligation(
        'ob-1',
        ownerId: 'human:operator',
        intent: 'Decision 1',
        status: 'ready',
        effectivePriority: 10.0,
      );
      final ob2 = makeObligation(
        'ob-2',
        ownerId: 'human:operator',
        intent: 'Decision 2',
        status: 'ready',
        effectivePriority: 20.0,
      );

      final api = FakeApi()
        ..threadsResult = [makeThread('root')]
        ..obligationsResult = [ob1, ob2];

      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(_app(store));
      await tester.pump();
      await tester.pump();

      expect(find.byIcon(Icons.arrow_downward), findsWidgets);
      final downArrow = find.byTooltip('Move Down in Priority');
      expect(downArrow, findsWidgets);

      await tester.tap(downArrow.first);
      await tester.pump();

      expect(api.reorderCalls.length, 1);
      expect(api.reorderCalls.first.id, 'ob-1');
      expect(api.reorderCalls.first.previousId, 'ob-2');

      await store.dispose();
    });
  });

  testWidgets(
    'WorkTab owner panel shows View Owner Queue for human owners and navigates to overview ',
    (tester) async {
      await tester.runAsync(() async {
        final humanOb = makeObligation(
          'ob-human',
          ownerId: 'human:operator',
          intent: 'Human obligation',
          status: 'ready',
        );

        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [humanOb];

        DashboardView? selectedView;
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: WorkTab(
                store: store,
                onSelectView: (v) => selectedView = v,
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();

        // Select the obligation in the tree
        await tester.tap(find.text('Human obligation'));
        await tester.pump();
        await tester.pump();

        expect(find.text('View Owner Queue →'), findsOneWidget);
        await tester.tap(find.text('View Owner Queue →'));
        await tester.pump();

        expect(selectedView, DashboardView.overview);

        await store.dispose();
      });
    },
  );

  testWidgets('OverviewTab reacts to authoritative runtime state deltas', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..runtimeCursor = const RuntimeCursor(streamId: 'stream-a', revision: 0)
        ..threadsResult = [
          makeThread('root', created: 't0', runState: RunState.idle),
          makeThread(
            'w1',
            parent: 'root',
            created: 't1',
            runState: RunState.queued,
          ),
          makeThread(
            'w2',
            parent: 'root',
            created: 't2',
            runState: RunState.running,
          ),
        ];
      final stream = FakeStream();
      final store = DashboardStore(api: api, stream: stream);
      await store.init();

      await tester.pumpWidget(_app(store));
      await tester.pump();
      await tester.pump();

      // Initial state: 1 running (w2), 1 queued (w1)
      expect(find.text('1 running'), findsOneWidget);
      expect(find.text('1 queued'), findsOneWidget);
      expect(find.text('w2-handle'), findsOneWidget);
      expect(find.text('w1-handle'), findsOneWidget);

      // The authoritative stream transitions w1 from queued to running.
      stream.runtimeStatesCtrl.add(
        const ActorRuntimeStateDelta(
          streamId: 'stream-a',
          revision: 1,
          actorId: 'w1',
          runState: RunState.running,
        ),
      );
      await tester.pump();
      await tester.pump();

      // Now: 2 running (w1, w2), 0 queued
      expect(find.text('2 running'), findsOneWidget);
      expect(find.text('0 queued'), findsOneWidget);
      expect(find.text('No actors are queued.'), findsOneWidget);

      // w2 finishes.
      stream.runtimeStatesCtrl.add(
        const ActorRuntimeStateDelta(
          streamId: 'stream-a',
          revision: 2,
          actorId: 'w2',
          runState: RunState.idle,
        ),
      );
      await tester.pump();
      await tester.pump();

      // Now: 1 running (w1), 0 queued
      expect(find.text('1 running'), findsOneWidget);
      expect(find.text('0 queued'), findsOneWidget);

      // root becomes queued.
      stream.runtimeStatesCtrl.add(
        const ActorRuntimeStateDelta(
          streamId: 'stream-a',
          revision: 3,
          actorId: 'root',
          runState: RunState.queued,
        ),
      );
      await tester.pump();
      await tester.pump();

      // Now: 1 running (w1), 1 queued (root)
      expect(find.text('1 running'), findsOneWidget);
      expect(find.text('1 queued'), findsOneWidget);
      expect(find.text('root-handle'), findsOneWidget);

      await store.dispose();
    });
  });

  testWidgets(
    'OverviewTab fetches quota history on mount and does not poll on an interval',
    (tester) async {
      final api = FakeApi()
        ..threadsResult = [makeThread('root')]
        ..quotaHistoryResult = const QuotaHistoryDto(
          generatedAt: 'test-hist',
          historySince: '2026-07-01T00:00:00.000Z',
          history: [],
        );
      final store = DashboardStore(api: api, stream: FakeStream());

      expect(api.quotaHistoryCallCount, 0);

      await tester.pumpWidget(_app(store));
      await tester.pump();

      expect(api.quotaHistoryCallCount, 1);
      expect(store.quotaHistory.value?.generatedAt, 'test-hist');

      // Advance 5 minutes while mounted: no periodic timer fires
      await tester.pump(const Duration(minutes: 5));
      expect(api.quotaHistoryCallCount, 1);

      // Advance another 5 minutes while mounted: count remains 1
      await tester.pump(const Duration(minutes: 5));
      expect(api.quotaHistoryCallCount, 1);

      await store.dispose();
    },
  );

  testWidgets(
    'OverviewTab renders scheduled obligations for human:operator via their own filtered fetch',
    (tester) async {
      await tester.runAsync(() async {
        final scheduledOb = makeObligation(
          'ob-scheduled',
          ownerId: 'human:operator',
          intent: 'Weekly review',
          status: 'scheduled',
          recurrencePolicy: 'cron',
          recurrenceCron: '0 9 * * 1',
          nextReadyAt: '2026-09-07T09:00:00.000Z',
        );

        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [scheduledOb];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        expect(find.text('Scheduled Obligations'), findsOneWidget);
        expect(find.text('Weekly review'), findsOneWidget);
        expect(find.text('1 scheduled'), findsOneWidget);

        // Regression guard: a "My Queue" that only ever fetched an
        // unfiltered owner page had no way to present scheduled work at
        // all, since it only ever derived ready/waiting from that page.
        expect(
          api.fetchObligationsCalls.any(
            (c) => c.ownerId == 'human:operator' && c.status == 'scheduled',
          ),
          isTrue,
        );
        await store.dispose();
      });
    },
  );

  testWidgets(
    'OverviewTab lists queued actors in estimated run order with estimate labels',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [
            makeThread('root', runState: RunState.idle),
            makeThread(
              'late',
              parent: 'root',
              runState: RunState.queued,
              estimatedStartAt: '2026-01-01T00:00:30.000Z',
            ),
            makeThread(
              'early',
              parent: 'root',
              runState: RunState.queued,
              estimatedStartAt: '2026-01-01T00:00:10.000Z',
            ),
            makeThread(
              'unknown',
              parent: 'root',
              runState: RunState.queued,
              queuePosition: 2,
            ),
          ];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        expect(find.text('3 queued'), findsOneWidget);
        expect(
          find.text('Estimated start ${formatTs('2026-01-01T00:00:10.000Z')}'),
          findsOneWidget,
        );
        expect(
          find.text('Estimated start ${formatTs('2026-01-01T00:00:30.000Z')}'),
          findsOneWidget,
        );
        expect(find.text('Lane position 3'), findsOneWidget);

        // Rendered in estimated run order: early, then late, then unknown.
        final earlyY = tester.getTopLeft(find.text('early-handle')).dy;
        final lateY = tester.getTopLeft(find.text('late-handle')).dy;
        final unknownY = tester.getTopLeft(find.text('unknown-handle')).dy;
        expect(earlyY, lessThan(lateY));
        expect(lateY, lessThan(unknownY));
        await store.dispose();
      });
    },
  );

  testWidgets(
    'OverviewTab shows running actor context and live focus changes without a queued placeholder',
    (tester) async {
      await tester.runAsync(() async {
        final initialRunning = makeObligation(
          'running-focus',
          ownerId: 'running',
          title: 'Initial running focus',
        );
        final api = FakeApi()
          ..runtimeCursor = const RuntimeCursor(
            streamId: 'overview-focus',
            revision: 0,
          )
          ..threadsResult = [
            makeThread('root', runState: RunState.idle),
            makeThread(
              'running',
              parent: 'root',
              title: 'Running actor title',
              runState: RunState.running,
              selectedObligation: initialRunning,
            ),
            makeThread(
              'queued',
              parent: 'root',
              title: 'Queued actor title',
              runState: RunState.queued,
              queuePosition: 0,
            ),
            makeThread(
              'without-focus',
              parent: 'root',
              title: 'No current focus',
              runState: RunState.running,
            ),
          ];
        final stream = FakeStream();
        final store = DashboardStore(api: api, stream: stream);
        await store.init();

        await tester.binding.setSurfaceSize(const Size(390, 844));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        expect(find.text('running-handle'), findsOneWidget);
        expect(find.text('Running actor title'), findsOneWidget);
        expect(find.text('queued-handle'), findsOneWidget);
        expect(find.text('Queued actor title'), findsOneWidget);
        expect(find.text('Initial running focus'), findsOneWidget);
        expect(find.text('Queued focus'), findsNothing);
        expect(find.text('No current focus'), findsOneWidget);
        expect(find.byType(ActorAvatarWithStatus), findsNWidgets(3));
        expect(tester.takeException(), isNull);

        final updatedRunning = makeObligation(
          'updated-running-focus',
          ownerId: 'running',
          title: 'Updated running focus',
        );
        api.threadsResult = [
          makeThread('root', runState: RunState.idle),
          makeThread(
            'running',
            parent: 'root',
            title: 'Running actor title',
            runState: RunState.running,
            selectedObligation: updatedRunning,
          ),
          makeThread(
            'queued',
            parent: 'root',
            title: 'Queued actor title',
            runState: RunState.queued,
            queuePosition: 0,
          ),
          makeThread(
            'without-focus',
            parent: 'root',
            title: 'No current focus',
            runState: RunState.running,
          ),
        ];
        stream.runtimeStatesCtrl.add(
          const ActorRuntimeStateDelta(
            streamId: 'overview-focus',
            revision: 1,
            actorId: 'running',
            runState: RunState.running,
            refreshThreadSnapshot: true,
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.text('Updated running focus'), findsOneWidget);
        expect(find.text('Initial running focus'), findsNothing);

        api.threadsResult = [
          makeThread('root', runState: RunState.idle),
          makeThread(
            'running',
            parent: 'root',
            title: 'Running actor title',
            runState: RunState.running,
          ),
          makeThread(
            'queued',
            parent: 'root',
            title: 'Queued actor title',
            runState: RunState.queued,
            queuePosition: 0,
          ),
          makeThread(
            'without-focus',
            parent: 'root',
            title: 'No current focus',
            runState: RunState.running,
          ),
        ];
        stream.runtimeStatesCtrl.add(
          const ActorRuntimeStateDelta(
            streamId: 'overview-focus',
            revision: 2,
            actorId: 'running',
            runState: RunState.running,
            refreshThreadSnapshot: true,
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.text('Updated running focus'), findsNothing);
        expect(tester.takeException(), isNull);

        await store.dispose();
      });
    },
  );
}
