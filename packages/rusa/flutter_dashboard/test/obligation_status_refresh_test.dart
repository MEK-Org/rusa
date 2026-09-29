import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/obligation_status.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

/// The open detail pane's header chip for [id]: the only bordered status chip
/// the Work tab draws, so the sidebar tree's chips never satisfy it.
Finder detailHeaderStatus(String id) => find.byWidgetPredicate(
  (w) => w is ObligationStatusChip && w.bordered && w.obligation.id == id,
);

String? detailHeaderStatusOf(WidgetTester tester, String id) {
  final chips = tester.widgetList<ObligationStatusChip>(detailHeaderStatus(id));
  return chips.isEmpty ? null : chips.single.obligation.status;
}

MeshEvent statusChanged(String obligationId) => MeshEvent(
  id: 'status-$obligationId',
  ts: '2026-09-29T13:30:00.000Z',
  kind: 'obligation_status_changed',
  actorId: 'root',
  detail: obligationId,
  body: null,
  payload: '{"status":"done"}',
  success: null,
);

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 10));
  }
}

void main() {
  testWidgets(
    'a status change delivered over SSE invalidates obligations cache and updates the open detail header (#771)',
    (tester) async {
      await tester.runAsync(() async {
        await tester.binding.setSurfaceSize(const Size(1280, 900));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final cache = FakeObligationsCache();
        final api = FakeApi()
          ..dashboardConfigResult = const DashboardConfigDto(
            quotaProviders: {},
            userPrincipalId: 'test-user',
          )
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [
            makeObligation('arc', ownerId: 'root', intent: 'Persistence arc'),
          ];
        final stream = FakeStream();
        final store = DashboardStore(
          api: api,
          stream: stream,
          obligationsCache: cache,
        );
        await store.init();
        await pumpEventQueue();

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );
        await settle(tester);
        await tester.tap(find.text('Persistence arc'));
        await settle(tester);
        expect(detailHeaderStatusOf(tester, 'arc'), 'ready');

        // Another client or an actor closes it; only the event reaches us.
        api.obligationsResult = [
          makeObligation(
            'arc',
            ownerId: 'root',
            intent: 'Persistence arc',
            status: 'done',
          ),
        ];
        store.saveObligationsSnapshot([
          ObligationTreeDto(
            obligation: makeObligation('arc'),
            children: const [],
            blockingChildren: const [],
          ),
        ]);
        expect(store.cachedObligationTrees, isNotNull);
        final invalidationsBefore = cache.invalidateCount;

        stream.meshCtrl.add(statusChanged('arc'));
        await settle(tester);

        expect(cache.invalidateCount, greaterThan(invalidationsBefore));
        expect(detailHeaderStatusOf(tester, 'arc'), 'done');

        await store.dispose();
      });
    },
  );

  testWidgets(
    'marking the open obligation done updates its detail header without '
    'waiting for an event (#771)',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final api = FakeApi()
        ..obligationsResult = [
          makeObligation('arc', intent: 'Persistence arc'),
        ];
      // No event ever arrives: the local write alone must refresh the pane.
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        quotaCache: FakeQuotaCache(),
        treePreferencesCache: FakeTreePreferencesCache(),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: WorkTab(store: store, onSelectView: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Persistence arc'));
      await tester.pumpAndSettle();
      expect(detailHeaderStatusOf(tester, 'arc'), 'ready');

      await tester.tap(find.byTooltip('Mark Done'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.widgetWithText(ElevatedButton, 'Mark Done'),
        ),
      );
      await tester.pumpAndSettle();

      expect(api.statusCalls.single.status, 'done');
      expect(find.byType(AlertDialog), findsNothing);
      expect(detailHeaderStatusOf(tester, 'arc'), 'done');
    },
  );
}
