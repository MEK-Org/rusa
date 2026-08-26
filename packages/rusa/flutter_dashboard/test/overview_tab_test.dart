import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

Widget _app(DashboardStore store, {ValueChanged<DashboardView>? onSelectView}) =>
    MaterialApp(home: Scaffold(body: OverviewTab(store: store, onSelectView: onSelectView)));

void main() {
  testWidgets(
    'yield rows do not overflow at mobile (~390px) width ',
    (tester) async {
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
    },
  );

  testWidgets(
    'OverviewTab renders empty state when human:operator has no obligations ',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [
            makeObligation('actor-ob', ownerKind: 'actor', ownerId: 'root', intent: 'Actor task'),
          ];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        expect(find.text('My Queue'), findsOneWidget);
        expect(find.text('No obligations in your queue.'), findsOneWidget);
        expect(find.text('0 obligations'), findsOneWidget);
        expect(find.widgetWithText(ElevatedButton, 'Create Obligation'), findsOneWidget);

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
          ownerKind: 'human',
          ownerId: 'human:operator',
          intent: 'Approve PR review',
          status: 'ready',
          priority: 50.0,
          effectivePriority: 50.0,
          externalRef: 'github_pr:dummy-org/dummy-repoISSUE_NUM',
        );
        final waitingOb = makeObligation(
          'ob-waiting',
          ownerKind: 'human',
          ownerId: 'human:operator',
          intent: 'Merge deploy release',
          status: 'waiting',
          effectivePriority: 60.0,
        );
        final blockerChild = makeObligation(
          'ob-blocker',
          parentId: 'ob-waiting',
          ownerKind: 'actor',
          ownerId: 'worker-1',
          intent: 'CI pass',
          status: 'ready',
        );
        final actorOnlyOb = makeObligation(
          'ob-actor-only',
          ownerKind: 'actor',
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

        await tester.pumpWidget(_app(store, onSelectView: (v) => navigatedView = v));
        await tester.pump();
        await tester.pump();

        // Check header and counts
        expect(find.text('My Queue'), findsOneWidget);
        expect(find.text('2 obligations'), findsOneWidget);
        expect(find.text('1 ready'), findsOneWidget);
        expect(find.text('1 waiting'), findsOneWidget);

        // Check ready items
        expect(find.text('Approve PR review'), findsOneWidget);
        expect(find.text('github_pr:dummy-org/dummy-repoISSUE_NUM'), findsOneWidget);

        // Check waiting items and blocker
        expect(find.text('Merge deploy release'), findsOneWidget);
        expect(find.text('Blocked by direct children:'), findsOneWidget);
        expect(find.textContaining('CI pass (actor: worker-1)'), findsOneWidget);

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

  testWidgets(
    'OverviewTab reorders ready obligations in My Queue ',
    (tester) async {
      await tester.runAsync(() async {
        final ob1 = makeObligation(
          'ob-1',
          ownerKind: 'human',
          ownerId: 'human:operator',
          intent: 'Decision 1',
          status: 'ready',
          effectivePriority: 10.0,
        );
        final ob2 = makeObligation(
          'ob-2',
          ownerKind: 'human',
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
    },
  );

  testWidgets(
    'WorkTab owner panel shows View Owner Queue for human owners and navigates to overview ',
    (tester) async {
      await tester.runAsync(() async {
        final humanOb = makeObligation(
          'ob-human',
          ownerKind: 'human',
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

  testWidgets(
    'OverviewTab reactively synchronizes running and queued actors and status dots from ActorStateSnapshot ',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [
            makeThread('root', created: 't0', runState: RunState.idle),
            makeThread('w1', parent: 'root', created: 't1', runState: RunState.queued),
            makeThread('w2', parent: 'root', created: 't2', runState: RunState.running),
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

        // SSE: w1 transitions from queued to running (run_start)
        stream.meshCtrl.add(makeEvent('e1', 'run_start', actor: 'w1'));
        await tester.pump();
        await tester.pump();

        // Now: 2 running (w1, w2), 0 queued
        expect(find.text('2 running'), findsOneWidget);
        expect(find.text('0 queued'), findsOneWidget);
        expect(find.text('No actors are queued.'), findsOneWidget);

        // SSE: w2 finishes (run_end)
        stream.meshCtrl.add(makeEvent('e2', 'run_end', actor: 'w2'));
        await tester.pump();
        await tester.pump();

        // Now: 1 running (w1), 0 queued
        expect(find.text('1 running'), findsOneWidget);
        expect(find.text('0 queued'), findsOneWidget);

        // SSE: root queued (run_queued)
        stream.meshCtrl.add(makeEvent('e3', 'run_queued', actor: 'root'));
        await tester.pump();
        await tester.pump();

        // Now: 1 running (w1), 1 queued (root)
        expect(find.text('1 running'), findsOneWidget);
        expect(find.text('1 queued'), findsOneWidget);
        expect(find.text('root-handle'), findsOneWidget);

        await store.dispose();
      });
    },
  );

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
}
