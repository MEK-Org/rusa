import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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
}
