import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/breakpoints.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/avatar.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/inbox_item_row.dart';
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
  testWidgets(
    'Overview uses columns wide and stacks My Queue above quota pacing narrow',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi();
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);
        addTearDown(() => tester.binding.setSurfaceSize(null));

        await tester.binding.setSurfaceSize(const Size(1200, 900));
        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        final wideQueue = tester.getRect(find.text('My Queue'));
        final wideQuota = tester.getRect(
          find.textContaining('Quota Pacing'),
        );
        expect(wideQueue.left, lessThan(wideQuota.left));
        expect(wideQueue.bottom, greaterThan(wideQuota.top));
        expect(wideQuota.bottom, greaterThan(wideQueue.top));
        expect(find.text('New Obligation'), findsOneWidget);

        await tester.binding.setSurfaceSize(const Size(390, 844));
        await tester.pump();

        final narrowQueue = tester.getRect(find.text('My Queue'));
        final narrowQuota = tester.getRect(
          find.textContaining('Quota Pacing'),
        );
        expect(narrowQueue.left, closeTo(narrowQuota.left, 1));
        expect(narrowQueue.top, lessThan(narrowQuota.top));
        expect(find.text('New Obligation'), findsNothing);
        expect(find.byIcon(Icons.add), findsOneWidget);

        // Just below kNarrowBreakpoint (700): 20px tab padding on each side (40 total).
        // Surface width 739 gives maxWidth 699 < 700 -> stacked vertically.
        await tester.binding.setSurfaceSize(
          const Size(kNarrowBreakpoint + 40 - 1, 900),
        );
        await tester.pump();

        final justBelowQueue = tester.getRect(find.text('My Queue'));
        final justBelowQuota = tester.getRect(
          find.textContaining('Quota Pacing'),
        );
        expect(justBelowQueue.left, closeTo(justBelowQuota.left, 1));
        expect(justBelowQueue.top, lessThan(justBelowQuota.top));

        // At kNarrowBreakpoint (700): surface width 740 gives maxWidth 700 -> two columns.
        await tester.binding.setSurfaceSize(
          const Size(kNarrowBreakpoint + 40, 900),
        );
        await tester.pump();

        final atBoundaryQueue = tester.getRect(find.text('My Queue'));
        final atBoundaryQuota = tester.getRect(
          find.textContaining('Quota Pacing'),
        );
        expect(atBoundaryQueue.left, lessThan(atBoundaryQuota.left));
        expect(atBoundaryQueue.bottom, greaterThan(atBoundaryQuota.top));
        expect(atBoundaryQuota.bottom, greaterThan(atBoundaryQueue.top));
      });
    },
  );

  testWidgets('Recent Activity renders handled cards with addressed note', (
    tester,
  ) async {
    await tester.runAsync(() async {
      const actor = '11111111-1111-4111-8111-111111111111';
      final api = FakeApi()
        ..threadsResult = [makeThread(actor)]
        ..recentActivityResult = [
          const RecentActivityItem(
            id: 'inbox_1',
            kind: 'handled_inbox',
            time: '2026-09-23T14:21:37.000Z',
            actorId: actor,
            actorHandle: 'kestrel-coder',
            actorModel: 'claude-opus-4-6, high',
            sourceKind: 'GITHUB ISSUE',
            sourceRef: 'github:MEK-Org/rusa/issues/664',
            summary: 'UI proposal feedback on #664',
            handledTime: '2026-09-23T14:21:37.000Z',
            addressedNote: 'Packaged design proposal into PR #665',
            linkedObligation:
                'Obligation: Render work-outcome dashboard mock-up',
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.binding.setSurfaceSize(const Size(1500, 1400));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(_app(store));
      await tester.pump();
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(find.text('Recent Activity'), findsOneWidget);
      expect(find.text('kestrel-coder'), findsOneWidget);
      expect(
        find.textContaining('Packaged design proposal into PR #665'),
        findsOneWidget,
      );
      expect(
        find.text('Obligation: Render work-outcome dashboard mock-up'),
        findsOneWidget,
      );

      await store.dispose();
    });
  });

  testWidgets('Recent Activity renders terminal obligation transitions', (
    tester,
  ) async {
    await tester.runAsync(() async {
      const actor = '11111111-1111-4111-8111-111111111111';
      final api = FakeApi()
        ..threadsResult = [makeThread(actor)]
        ..recentActivityResult = [
          const RecentActivityItem(
            id: 'ob_1',
            kind: 'terminal_obligation',
            time: '2026-09-23T14:21:37.000Z',
            actorId: actor,
            actorHandle: 'kestrel-coder',
            actorModel: 'claude-opus-4-6, high',
            sourceKind: 'OBLIGATION',
            sourceRef: 'github:MEK-Org/rusa/issues/664',
            summary: 'Render work-outcome dashboard mock-up',
            obligationId: '0e655f00-0000-4000-8000-000000000001',
            terminalStatus: 'done',
            terminalNote: 'Landed mock-up and tests',
            resolutionRef: 'github:MEK-Org/rusa/pulls/665',
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      await tester.binding.setSurfaceSize(const Size(1500, 1400));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(_app(store));
      await tester.pump();
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(find.text('Recent Activity'), findsOneWidget);
      expect(find.text('kestrel-coder'), findsOneWidget);
      expect(find.text('DONE'), findsOneWidget);
      expect(find.textContaining('Landed mock-up and tests'), findsOneWidget);
      expect(
        find.text('Resolution: github:MEK-Org/rusa/pulls/665'),
        findsOneWidget,
      );

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
      // Queue admission revalidates the pacing explanation, so model the
      // authoritative snapshot the server has published for this revision.
      api
        ..runtimeCursor = const RuntimeCursor(streamId: 'stream-a', revision: 3)
        ..threadsResult = [
          makeThread('root', created: 't0', runState: RunState.queued),
          makeThread(
            'w1',
            parent: 'root',
            created: 't1',
            runState: RunState.running,
          ),
          makeThread(
            'w2',
            parent: 'root',
            created: 't2',
            runState: RunState.idle,
          ),
        ];
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
    'OverviewTab lists queued actors in admission order with lane-aware labels (#570)',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [
            makeThread('root', runState: RunState.idle),
            makeThread(
              'first',
              parent: 'root',
              runState: RunState.queued,
              queuePosition: 0,
              compatibleLanes: const ['claude'],
              estimatedStartAt: '2026-01-01T00:00:30.000Z',
              pacingIntervalMs: 36000000,
            ),
            // A lane with no pacing gap whose clock was pushed out by an
            // explicit deferral: quote the estimate, never "every 0s".
            makeThread(
              'second',
              parent: 'root',
              runState: RunState.queued,
              queuePosition: 1,
              compatibleLanes: const ['codex'],
              estimatedStartAt: '2026-01-01T00:00:20.000Z',
              pacingIntervalMs: 0,
            ),
            // The earliest estimate, but later in the list: the list shows
            // admission order, not a projection sorted by estimate.
            makeThread(
              'third',
              parent: 'root',
              runState: RunState.queued,
              queuePosition: 2,
              compatibleLanes: const ['claude'],
              estimatedStartAt: '2026-01-01T00:00:10.000Z',
              pacingIntervalMs: 36000000,
            ),
            // Nothing ahead of it shares its lane, so it is next on it.
            makeThread(
              'lone',
              parent: 'root',
              runState: RunState.queued,
              queuePosition: 3,
              compatibleLanes: const ['agy'],
              pacingIntervalMs: 36000000,
            ),
            // Shares a lane with first, third (claude) and lone (agy), not
            // second. This is compatibility context, not a start-order claim.
            makeThread(
              'wide',
              parent: 'root',
              runState: RunState.queued,
              queuePosition: 4,
              compatibleLanes: const ['agy', 'claude'],
              pacingIntervalMs: 36000000,
            ),
            // Global position 5, but only second shares its lane.
            makeThread(
              'narrow',
              parent: 'root',
              runState: RunState.queued,
              queuePosition: 5,
              compatibleLanes: const ['codex'],
              pacingIntervalMs: 36000000,
            ),
          ];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        expect(find.text('6 queued'), findsOneWidget);
        // These estimates have already passed, so those runs are due.
        expect(find.text('Starting shortly'), findsNWidgets(3));
        expect(find.text('Runs when a slot frees up'), findsOneWidget);
        expect(
          find.text('3 earlier queued actors share a compatible lane'),
          findsOneWidget,
        );
        expect(
          find.text('1 earlier queued actor shares a compatible lane'),
          findsOneWidget,
        );
        expect(find.textContaining('Runs after'), findsNothing);
        // The queued list no longer quotes provider pacing.
        expect(find.textContaining('pacing every'), findsNothing);
        expect(find.text('Lanes: agy · claude'), findsOneWidget);
        expect(find.text('Lane: codex'), findsNWidgets(2));
        expect(
          find.textContaining(
            'Manual ordering resets when the leader restarts.',
          ),
          findsOneWidget,
        );

        final ys = [
          for (final id in ['first', 'second', 'third', 'lone', 'wide'])
            tester.getTopLeft(find.text('$id-handle')).dy,
        ];
        for (var i = 1; i < ys.length; i++) {
          expect(ys[i - 1], lessThan(ys[i]));
        }
        await store.dispose();
      });
    },
  );

  testWidgets(
    'OverviewTab names shared compatibility without promising queue order (#570)',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [
            makeThread('root', runState: RunState.idle),
            // Declared claude and codex, but its claim holds codex and never
            // transfers, so it no longer competes for claude.
            makeThread(
              'held',
              parent: 'root',
              runState: RunState.queued,
              queuePosition: 0,
              admissionClaimed: true,
              compatibleLanes: const ['claude', 'codex'],
              claimedLane: 'codex',
            ),
            makeThread(
              'first-shared',
              parent: 'root',
              runState: RunState.queued,
              queuePosition: 1,
              compatibleLanes: const ['claude'],
            ),
            makeThread(
              'incompatible',
              parent: 'root',
              runState: RunState.queued,
              queuePosition: 2,
              compatibleLanes: const ['codex'],
            ),
            makeThread(
              'second-shared',
              parent: 'root',
              runState: RunState.queued,
              queuePosition: 3,
              compatibleLanes: const ['claude'],
            ),
            makeThread(
              'target',
              parent: 'root',
              runState: RunState.queued,
              queuePosition: 4,
              compatibleLanes: const ['claude'],
            ),
          ];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        expect(
          find.text('2 earlier queued actors share a compatible lane'),
          findsOneWidget,
        );
        expect(
          find.text('3 earlier queued actors share a compatible lane'),
          findsNothing,
        );
        // `held` and `first-shared`; `incompatible` and `second-shared` each
        // share one lane with a single earlier entry.
        expect(find.text('Runs when a slot frees up'), findsNWidgets(2));
        expect(
          find.text('1 earlier queued actor shares a compatible lane'),
          findsNWidgets(2),
        );
        expect(find.textContaining('Runs after'), findsNothing);
        await store.dispose();
      });
    },
  );

  group('OverviewTab admission reorder (#570)', () {
    List<ThreadDto> admissionThreads() => [
      makeThread('root', runState: RunState.idle),
      makeThread(
        'held',
        parent: 'root',
        runState: RunState.queued,
        queuePosition: 0,
        admissionClaimed: true,
        compatibleLanes: const ['claude'],
        claimedLane: 'claude',
      ),
      makeThread(
        'alpha',
        parent: 'root',
        runState: RunState.queued,
        queuePosition: 1,
        compatibleLanes: const ['codex'],
      ),
      makeThread(
        'beta',
        parent: 'root',
        runState: RunState.queued,
        queuePosition: 2,
        compatibleLanes: const ['claude', 'codex'],
      ),
    ];

    IconButton moveButton(WidgetTester tester, String tooltip) =>
        tester.widget<IconButton>(
          find.ancestor(
            of: find.byTooltip(tooltip),
            matching: find.byType(IconButton),
          ),
        );

    testWidgets('shows claimed entries; only unclaimed ones move', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final api = FakeApi()..threadsResult = admissionThreads();
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        expect(
          find.text('Claimed · claude, waiting for a run slot'),
          findsOneWidget,
        );
        expect(find.byTooltip('Move up held-handle'), findsNothing);
        expect(find.byTooltip('Move down held-handle'), findsNothing);
        expect(moveButton(tester, 'Move up alpha-handle').onPressed, isNull);
        expect(
          moveButton(tester, 'Move down alpha-handle').onPressed,
          isNotNull,
        );
        expect(moveButton(tester, 'Move up beta-handle').onPressed, isNotNull);
        expect(moveButton(tester, 'Move down beta-handle').onPressed, isNull);
        await store.dispose();
      });
    });

    testWidgets('moves an entry from the keyboard with the order it showed', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final api = FakeApi()..threadsResult = admissionThreads();
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        bool focusedOn(String tooltip) {
          var within = false;
          final context = FocusManager.instance.primaryFocus?.context;
          context?.visitAncestorElements((element) {
            final widget = element.widget;
            if (widget is Tooltip && widget.message == tooltip) {
              within = true;
              return false;
            }
            return true;
          });
          return within;
        }

        for (var i = 0; i < 80 && !focusedOn('Move down alpha-handle'); i++) {
          await tester.sendKeyEvent(LogicalKeyboardKey.tab);
          await tester.pump();
        }
        expect(focusedOn('Move down alpha-handle'), isTrue);

        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        await Future<void>.delayed(Duration.zero);
        await tester.pump();

        expect(api.admissionReorderCalls, hasLength(1));
        final call = api.admissionReorderCalls.single;
        expect(call.threadId, 'alpha');
        expect(call.beforeThreadId, isNull);
        expect(call.observedOrder, ['alpha', 'beta']);
        await store.dispose();
      });
    });

    testWidgets('says so and moves nothing when the queue changed first', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = admissionThreads()
          ..admissionReorderError = DashboardApiException(
            Uri.parse('http://localhost/api/mesh/admission-queue/reorder'),
            409,
            '{"error":"admission queue changed","order":["beta","alpha"]}',
          );
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        await tester.ensureVisible(find.byTooltip('Move up beta-handle'));
        await tester.pump();
        // Another operator's move already landed on the server.
        api.threadsResult = [
          for (final thread in admissionThreads())
            switch (thread.id) {
              'alpha' => thread.copyWith(queuePosition: 2),
              'beta' => thread.copyWith(queuePosition: 1),
              _ => thread,
            },
        ];
        await tester.tap(find.byTooltip('Move up beta-handle'));
        await tester.pump();
        for (var i = 0; i < 5; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          await tester.pump();
        }

        expect(api.admissionReorderCalls.single.beforeThreadId, 'alpha');
        expect(api.admissionReorderCalls.single.observedOrder, [
          'alpha',
          'beta',
        ]);
        expect(
          find.text('The queue changed before your move; nothing was moved.'),
          findsOneWidget,
        );
        // The resync after the 409 rendered the server's changed order.
        expect(
          tester.getTopLeft(find.text('beta-handle')).dy,
          lessThan(tester.getTopLeft(find.text('alpha-handle')).dy),
        );
        await store.dispose();
      });
    });
  });

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
        DashboardView? navigatedView;
        await tester.pumpWidget(
          _app(store, onSelectView: (v) => navigatedView = v),
        );
        await tester.pump();
        await tester.pump();

        expect(find.text('running-handle'), findsOneWidget);
        expect(find.text('Running actor title'), findsOneWidget);
        expect(find.text('charter running'), findsNothing);
        expect(find.text('queued-handle'), findsOneWidget);
        expect(find.text('Queued actor title'), findsOneWidget);
        expect(find.text('Initial running focus'), findsOneWidget);
        expect(find.text('Queued focus'), findsNothing);
        expect(find.text('No current focus'), findsOneWidget);
        expect(find.byType(ActorAvatarWithStatus), findsNWidgets(3));
        expect(tester.takeException(), isNull);

        await tester.tap(find.text('running-handle'));
        await tester.pump();
        expect(store.primary.value, 'running');
        expect(navigatedView, DashboardView.actors);

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

  testWidgets(
    'OverviewTab renders selected inbox items with (+N more) and single-item cases',
    (tester) async {
      await tester.runAsync(() async {
        final runningInboxItem = makeInboxEntry(
          'item-running',
          content: 'Working on critical task',
          type: 'message',
          priority: 'responsive',
        );
        final queuedSingleItem = makeInboxEntry(
          'item-queued-single',
          content: 'Single queued item task',
          type: 'obligation.ready_head',
        );
        final queuedMultiItem = makeInboxEntry(
          'item-queued-multi',
          content: 'Multi queued item task',
          type: 'message',
          priority: 'responsive',
        );
        final runningWithObligationItem = makeInboxEntry(
          'item-ignored',
          content: 'Should be ignored because obligation is present',
        );
        final obligation = makeObligation(
          'ob-1',
          title: 'Active obligation work',
        );

        final api = FakeApi()
          ..runtimeCursor = const RuntimeCursor(streamId: 's', revision: 0)
          ..threadsResult = [
            makeThread('root', runState: RunState.idle),
            // 1. Running actor with inbox item and multiple items -> shows item and (+2 more)
            makeThread(
              'running-inbox',
              parent: 'root',
              title: 'Running Actor',
              runState: RunState.running,
              selectedInboxItem: runningInboxItem,
              moreInboxItemsCount: 2,
            ),
            // 2. Queued actor single-item case -> shows item and NO (+N more)
            makeThread(
              'queued-single',
              parent: 'root',
              title: 'Queued Single',
              runState: RunState.queued,
              queuePosition: 0,
              selectedInboxItem: queuedSingleItem,
              moreInboxItemsCount: 0,
            ),
            // 3. Queued actor with multiple items -> shows item and (+10 more)
            makeThread(
              'queued-multi',
              parent: 'root',
              title: 'Queued Multi',
              runState: RunState.queued,
              queuePosition: 1,
              selectedInboxItem: queuedMultiItem,
              moreInboxItemsCount: 10,
            ),
            // 4. Running actor with both obligation and inbox item -> shows obligation only
            makeThread(
              'running-ob',
              parent: 'root',
              title: 'Running with Obligation',
              runState: RunState.running,
              selectedObligation: obligation,
              selectedInboxItem: runningWithObligationItem,
            ),
          ];

        final stream = FakeStream();
        final store = DashboardStore(api: api, stream: stream);
        await store.init();

        await tester.binding.setSurfaceSize(const Size(600, 1000));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        // 1. Running actor with inbox item and moreCount = 2
        expect(find.text('Working on critical task'), findsOneWidget);
        expect(find.text('(+2 more)'), findsOneWidget);

        // 2. Queued actor with single item
        expect(find.text('Single queued item task'), findsOneWidget);
        // No (+0 more) or (+N more) for queued-single
        expect(find.text('(+0 more)'), findsNothing);

        // 3. Queued actor with multi item and moreCount = 10
        expect(find.text('Multi queued item task'), findsOneWidget);
        expect(find.text('(+10 more)'), findsOneWidget);

        // 4. Running actor with obligation renders obligation, not inbox item
        expect(find.text('Active obligation work'), findsOneWidget);
        expect(
          find.text('Should be ignored because obligation is present'),
          findsNothing,
        );

        await store.dispose();
      });
    },
  );

  group('queued actor cards', () {
    const reservedHandle = 'reserved-handle (synthetic-reserved-model, high)';

    Future<DashboardStore> bootQueued() async {
      final api = FakeApi()
        ..runtimeCursor = const RuntimeCursor(streamId: 's', revision: 0)
        ..threadsResult = [
          makeThread('root', runState: RunState.idle),
          makeThread(
            'reserved',
            parent: 'root',
            title: 'Reserved actor',
            runState: RunState.queued,
            queuePosition: 0,
            selectedProvider: 'synthetic-alias',
            selectedModel: 'synthetic-reserved-model',
            selectedEffort: 'high',
            selectedInboxItem: makeInboxEntry(
              'item-reserved',
              actorId: 'reserved',
              content: 'Queued inbox content',
            ),
          ),
          makeThread(
            'unreserved',
            parent: 'root',
            title: 'Unreserved actor',
            runState: RunState.queued,
            queuePosition: 1,
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      return store;
    }

    testWidgets(
      'wide cards put the inbox item in a third column beside the wait estimate',
      (tester) async {
        await tester.runAsync(() async {
          final store = await bootQueued();
          await tester.binding.setSurfaceSize(const Size(1500, 1400));
          addTearDown(() => tester.binding.setSurfaceSize(null));
          await tester.pumpWidget(_app(store));
          await tester.pump();
          await tester.pump();

          final handle = tester.getRect(find.text(reservedHandle));
          final title = tester.getRect(find.text('Reserved actor'));
          final start = tester.getRect(find.text('Runs when a slot frees up'));
          final inbox = tester.getRect(find.text('Queued inbox content'));
          // The start estimate sits under the title, in the identity column.
          expect(start.top, greaterThanOrEqualTo(title.bottom));
          expect(start.left, handle.left);
          expect(inbox.left, greaterThan(start.right));
          // Same row: the inbox column spans the header's line rather than
          // starting below it.
          final inboxBox = tester.getRect(find.byType(InboxItemRow));
          expect(inboxBox.top, lessThan(handle.center.dy));
          expect(inboxBox.bottom, greaterThan(handle.center.dy));
          // The actor sits at the top of the card, level with the inbox card.
          expect(handle.top, closeTo(inboxBox.top, 4));
          // The avatar heads the identity cluster, level with the handle.
          final header = find
              .ancestor(
                of: find.text(reservedHandle),
                matching: find.byType(InkWell),
              )
              .first;
          final avatar = find.descendant(
            of: header,
            matching: find.byType(ActorAvatarWithStatus),
          );
          expect(
            tester.getRect(avatar).top,
            closeTo(tester.getRect(header).top + 12, 2),
          );
          // The identity takes a quarter of the card, the inbox three quarters.
          expect(
            inboxBox.width,
            greaterThan(3 * (inboxBox.left - handle.left)),
          );
          expect(tester.takeException(), isNull);
          await store.dispose();
        });
      },
    );

    testWidgets('narrow cards keep the inbox item below the header', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final store = await bootQueued();
        await tester.binding.setSurfaceSize(const Size(600, 1400));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        final handle = tester.getRect(find.text(reservedHandle));
        final inbox = tester.getRect(find.text('Queued inbox content'));
        expect(inbox.top, greaterThan(handle.bottom));
        expect(tester.takeException(), isNull);
        await store.dispose();
      });
    });

    testWidgets('quotes a future estimate relative to now', (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [
            makeThread('root', runState: RunState.idle),
            makeThread(
              'soon',
              parent: 'root',
              runState: RunState.queued,
              estimatedStartAt: DateTime.now()
                  .add(const Duration(minutes: 8, seconds: 10))
                  .toUtc()
                  .toIso8601String(),
            ),
          ];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        expect(find.text('Runs in ~8 min'), findsOneWidget);
        await store.dispose();
      });
    });

    testWidgets(
      'names the reserved model after the handle only when one is reserved',
      (tester) async {
        await tester.runAsync(() async {
          final store = await bootQueued();
          await tester.binding.setSurfaceSize(const Size(1500, 1400));
          addTearDown(() => tester.binding.setSurfaceSize(null));
          await tester.pumpWidget(_app(store));
          await tester.pump();
          await tester.pump();

          expect(find.text(reservedHandle), findsOneWidget);
          expect(find.text('unreserved-handle'), findsOneWidget);
          await store.dispose();
        });
      },
    );
  });

  testWidgets(
    'an inbox item with its own reference card is not framed or labelled again',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [
            makeThread('root', runState: RunState.idle),
            makeThread(
              'queued',
              parent: 'root',
              runState: RunState.queued,
              queuePosition: 0,
              moreInboxItemsCount: 2,
              selectedInboxItem: makeInboxEntry(
                'item-mesh',
                actorId: 'queued',
                source: 'mesh:root',
                type: 'mesh.message',
                priority: 'responsive',
                reference: const ReferenceDto(
                  ref: 'mesh:messages/m-1',
                  scheme: 'mesh',
                  title: 'root → queued',
                  body: 'Mesh message body',
                  timestamp: '2026-09-01T10:00:00.000Z',
                  entity: {
                    'type': 'mesh_message',
                    'senderId': 'root',
                    'recipientId': 'queued',
                  },
                ),
              ),
            ),
          ];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        await tester.binding.setSurfaceSize(const Size(1500, 1400));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(_app(store));
        await tester.pump();
        await tester.pump();

        expect(find.text('Mesh message body'), findsOneWidget);
        expect(find.byType(InboxChip), findsNothing);
        expect(find.text('mesh:root'), findsNothing);
        // The row's badges move into the reference card's header.
        expect(find.text('RESPONSIVE'), findsOneWidget);
        expect(find.text('(+2 more)'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await store.dispose();
      });
    },
  );

  group('running actor cards', () {
    testWidgets(
      'name the run\'s model after the handle from its run_start, then follow live starts',
      (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..runtimeCursor = const RuntimeCursor(streamId: 's', revision: 0)
            ..threadsResult = [
              makeThread('root', runState: RunState.idle),
              makeThread(
                'running',
                parent: 'root',
                title: 'Running actor',
                runState: RunState.running,
              ),
              makeThread(
                'effortless',
                parent: 'root',
                title: 'Effortless actor',
                runState: RunState.running,
              ),
            ]
            ..latestRunStarts['running'] = makeEvent(
              'start-1',
              'run_start',
              actor: 'running',
              payload:
                  '{"provider":"synthetic-alias","model":"synthetic-run-model","effort":"xhigh"}',
            )
            ..latestRunStarts['effortless'] = makeEvent(
              'start-2',
              'run_start',
              actor: 'effortless',
              payload: '{"provider":"synthetic-alias","model":"bare-model"}',
            );
          final stream = FakeStream();
          final store = DashboardStore(api: api, stream: stream);
          await store.init();
          await tester.binding.setSurfaceSize(const Size(1500, 1400));
          addTearDown(() => tester.binding.setSurfaceSize(null));
          await tester.pumpWidget(_app(store));
          await tester.pump();
          await tester.pump();

          expect(
            find.text('running-handle (synthetic-run-model, xhigh)'),
            findsOneWidget,
          );
          expect(find.text('effortless-handle (bare-model)'), findsOneWidget);

          stream.meshCtrl.add(
            makeEvent(
              'start-3',
              'run_start',
              actor: 'running',
              payload:
                  '{"provider":"synthetic-alias","model":"synthetic-fallback","effort":"low"}',
            ),
          );
          await tester.pump();
          await tester.pump();
          expect(
            find.text('running-handle (synthetic-fallback, low)'),
            findsOneWidget,
          );
          expect(tester.takeException(), isNull);
          await store.dispose();
        });
      },
    );
  });
}
