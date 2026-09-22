import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/obligation_card.dart';
import 'package:rusa_dashboard/widgets/obligation_status.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

ObligationDto obligation({bool? marker, bool effective = false}) =>
    ObligationDto.fromJson({
      'id': 'urgent',
      'ownerId': 'worker',
      'title': 'Investigate the queued work',
      'status': 'ready',
      'responsive': marker,
      'effectiveResponsive': effective,
    });

void main() {
  test(
    'reads explicit and inherited responsiveness, defaults old payloads',
    () {
      expect(obligation(marker: true, effective: true).responsive, isTrue);
      final inherited = obligation(effective: true);
      expect(inherited.responsive, isNull);
      expect(inherited.effectiveResponsive, isTrue);
      expect(ObligationDto.fromJson({}).effectiveResponsive, isFalse);
    },
  );

  for (final marker in [true, null]) {
    testWidgets('responsive row shows status with accessible bolt ($marker)', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final store = DashboardStore(api: FakeApi(), stream: FakeStream());
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ObligationRow(
              obligation: obligation(marker: marker, effective: true),
              store: store,
            ),
          ),
        ),
      );
      expect(find.text('READY'), findsOneWidget);
      expect(find.text('RESPONSIVE'), findsNothing);
      expect(find.byIcon(Icons.bolt), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(ObligationStatusChip),
          matching: find.byIcon(Icons.bolt),
        ),
        findsOneWidget,
      );
      expect(
        find.bySemanticsLabel(
          marker == true
              ? 'Responsive: prioritized for immediate attention'
              : 'Responsive: inherited from a parent obligation',
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      semantics.dispose();
      await store.dispose();
    });
  }

  testWidgets('ordinary obligations have no responsive bolt', (tester) async {
    final store = DashboardStore(api: FakeApi(), stream: FakeStream());
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ObligationRow(obligation: obligation(), store: store),
        ),
      ),
    );
    expect(find.text('READY'), findsOneWidget);
    expect(find.text('RESPONSIVE'), findsNothing);
    expect(find.byIcon(Icons.bolt), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
    await store.dispose();
  });

  testWidgets('work tree and detail both identify inherited responsiveness', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final item = obligation(effective: true);
      final api = FakeApi()..obligationsResult = [item];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: WorkTab(store: store, onSelectView: (_) {}),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      expect(
        find.descendant(
          of: find.byType(ObligationStatusDot),
          matching: find.byIcon(Icons.bolt),
        ),
        findsOneWidget,
      );
      await tester.tap(find.text(item.heading));
      await tester.pump();
      await tester.pump();
      expect(find.text('RESPONSIVE'), findsNothing);
      expect(
        find.descendant(
          of: find.byType(ObligationStatusChip),
          matching: find.byIcon(Icons.bolt),
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      await store.dispose();
    });
  });
}
