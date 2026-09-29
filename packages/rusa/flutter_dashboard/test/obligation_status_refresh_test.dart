import 'dart:convert';

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

/// The event another client's or an actor's committed status write produces
/// (#773): ids and statuses only, in write order.
MeshEvent statusChanged(String eventId, Map<String, String> changes) =>
    makeEvent(
      eventId,
      'obligation_status_changed',
      actor: 'worker-1',
      detail: changes.keys.first,
      payload: jsonEncode({
        'changes': [
          for (final MapEntry(:key, :value) in changes.entries)
            {'id': key, 'status': value},
        ],
      }),
    );

Future<void> pumpWorkTab(WidgetTester tester, DashboardStore store) async {
  tester.view.physicalSize = const Size(1280, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: WorkTab(store: store, onSelectView: (_) {}),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

DashboardStore storeFor(FakeApi api, FakeStream stream) => DashboardStore(
  api: api,
  stream: stream,
  quotaCache: FakeQuotaCache(),
  treePreferencesCache: FakeTreePreferencesCache(),
);

void main() {
  testWidgets(
    'marking the open obligation done updates its detail header (#771)',
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

  testWidgets(
    "another client's close re-readies the open parent without a reload (#773)",
    (tester) async {
      final api = FakeApi()
        ..obligationsResult = [
          makeObligation('arc', intent: 'Persistence arc', status: 'waiting'),
          makeObligation('step', parentId: 'arc', intent: 'Last step'),
        ];
      final stream = FakeStream();
      final store = storeFor(api, stream);
      await store.init();
      await pumpWorkTab(tester, store);
      await tester.tap(find.text('Persistence arc'));
      await tester.pumpAndSettle();
      expect(detailHeaderStatusOf(tester, 'arc'), 'waiting');
      final forestLoads = api.fetchObligationForestCalls.length;

      // Another client closes the last live child; the server re-readies the
      // parent in the same commit.
      api.obligationsResult = [
        makeObligation('arc', intent: 'Persistence arc'),
        makeObligation(
          'step',
          parentId: 'arc',
          intent: 'Last step',
          status: 'done',
        ),
      ];
      stream.meshCtrl.add(
        statusChanged('evt-close', {'step': 'done', 'arc': 'ready'}),
      );
      await tester.pumpAndSettle();

      expect(api.statusCalls, isEmpty);
      expect(detailHeaderStatusOf(tester, 'arc'), 'ready');
      // One commit, one tree reload — not one per changed row.
      expect(api.fetchObligationForestCalls.length, forestLoads + 1);
      await tester.runAsync(store.dispose);
    },
  );

  testWidgets(
    "an actor's close of the open obligation updates its header (#773)",
    (tester) async {
      final api = FakeApi()
        ..obligationsResult = [
          makeObligation('arc', intent: 'Persistence arc'),
          makeObligation('other', intent: 'Unrelated arc'),
        ];
      final stream = FakeStream();
      final store = storeFor(api, stream);
      await store.init();
      await pumpWorkTab(tester, store);
      await tester.tap(find.text('Persistence arc'));
      await tester.pumpAndSettle();
      final detailLoads = api.obligationDetailCallCount;

      stream.meshCtrl.add(statusChanged('evt-other', {'other': 'cancelled'}));
      await tester.pumpAndSettle();
      expect(api.obligationDetailCallCount, detailLoads);

      api.obligationsResult = [
        makeObligation('arc', intent: 'Persistence arc', status: 'cancelled'),
        makeObligation('other', intent: 'Unrelated arc', status: 'cancelled'),
      ];
      stream.meshCtrl.add(statusChanged('evt-arc', {'arc': 'cancelled'}));
      await tester.pumpAndSettle();

      expect(detailHeaderStatusOf(tester, 'arc'), 'cancelled');
      await tester.runAsync(store.dispose);
    },
  );

  testWidgets(
    'the echo of a local Mark Done refetches and still shows done (#773)',
    (tester) async {
      final api = FakeApi()
        ..obligationsResult = [
          makeObligation('arc', intent: 'Persistence arc'),
        ];
      final stream = FakeStream();
      final store = storeFor(api, stream);
      await store.init();
      await pumpWorkTab(tester, store);
      await tester.tap(find.text('Persistence arc'));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Mark Done'));
      await tester.pumpAndSettle();
      api.obligationsResult = [
        makeObligation('arc', intent: 'Persistence arc', status: 'done'),
      ];
      await tester.tap(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.widgetWithText(ElevatedButton, 'Mark Done'),
        ),
      );
      await tester.pumpAndSettle();
      expect(detailHeaderStatusOf(tester, 'arc'), 'done');
      final detailLoads = api.obligationDetailCallCount;
      final forestLoads = api.fetchObligationForestCalls.length;

      stream.meshCtrl.add(statusChanged('evt-echo', {'arc': 'done'}));
      await tester.pumpAndSettle();

      // Touch-based: the echo is not suppressed. The pane and tree reload
      // again (the tree may also widen for the now-terminal focused root,
      // #241) and converge on the same status.
      expect(api.obligationDetailCallCount, greaterThan(detailLoads));
      expect(api.fetchObligationForestCalls.length, greaterThan(forestLoads));
      expect(detailHeaderStatusOf(tester, 'arc'), 'done');
      await tester.runAsync(store.dispose);
    },
  );

  test(
    'a status change drops cached reference lookups and refreshes Recent Activity only when terminal (#773)',
    () async {
      final api = FakeApi()
        ..obligationsResult = [makeObligation('arc'), makeObligation('gate')];
      final stream = FakeStream();
      final store = storeFor(api, stream);
      await store.init();
      await pumpEventQueue();

      expect((await store.obligationById('arc'))?.status, 'ready');
      api.obligationsResult = [
        makeObligation('arc', status: 'waiting'),
        makeObligation('gate'),
      ];
      expect((await store.obligationById('arc'))?.status, 'ready');
      final activityLoads = api.recentActivityCallCount;

      stream.meshCtrl.add(statusChanged('evt-block', {'arc': 'waiting'}));
      await pumpEventQueue();
      expect((await store.obligationById('arc'))?.status, 'waiting');
      expect(api.recentActivityCallCount, activityLoads);

      stream.meshCtrl.add(
        statusChanged('evt-done', {'gate': 'done', 'arc': 'ready'}),
      );
      await pumpEventQueue();
      expect(api.recentActivityCallCount, activityLoads + 1);
      await store.dispose();
    },
  );
}
