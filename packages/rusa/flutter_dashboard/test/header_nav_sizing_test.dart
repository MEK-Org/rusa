import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/header.dart';

import 'fakes.dart';

// Issue #423: the top bar is ~25% taller (56 -> 70px) and its nav buttons
// carry ~25% larger text (13 -> 16px) with typical TextButton padding
// (16px horizontal, 8px vertical). These tests pin the requested numbers and
// prove the buttons still fire their selection callback at both desktop and
// compact widths — behavior, not pixels.

Widget _header({
  required DashboardStore store,
  required ValueChanged<DashboardView> onSelect,
  DashboardView selected = DashboardView.actors,
  double width = 1100,
}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: width,
      child: MeshHeader(
        store: store,
        selected: selected,
        onSelect: onSelect,
      ),
    ),
  ),
);

ButtonStyle _styleOf(WidgetTester tester, String label) {
  final button = tester.widget<TextButton>(
    find.widgetWithText(TextButton, label),
  );
  return button.style ?? const ButtonStyle();
}

Future<DashboardStore> _store(WidgetTester tester) async {
  final api = FakeApi()..threadsResult = [makeThread('root', created: 't0')];
  final store = DashboardStore(api: api, stream: FakeStream());
  await tester.runAsync(store.init);
  addTearDown(() => tester.runAsync(store.dispose));
  return store;
}

// The default 800x600 test surface would clamp a 1100px header into its
// two-tier <850px layout; size the surface to match the width under test.
Future<void> _surface(WidgetTester tester, Size size) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
}

void main() {
  testWidgets('desktop top bar is 70px tall with 16px nav text on typical padding', (
    tester,
  ) async {
    final store = await _store(tester);
    await _surface(tester, const Size(1100, 800));
    await tester.pumpWidget(
      _header(store: store, onSelect: (_) {}, width: 1100),
    );
    await tester.pump();

    final header = tester.getRect(find.byType(MeshHeader));
    expect(header.height, 71.0); // 70px row + 1px bottom border.

    for (final destination in kDashboardDestinations) {
      final style = _styleOf(tester, destination.label);
      final textStyle = style.textStyle?.resolve(<WidgetState>{});
      expect(
        textStyle?.fontSize,
        16.0,
        reason: '${destination.label} label should be ~25% larger than 13px',
      );

      final padding = style.padding?.resolve(<WidgetState>{})! as EdgeInsets;
      expect(padding.horizontal, 32.0); // 16px per side.
      expect(padding.vertical, 16.0); // 8px per side.

      // The enlarged label at typical padding still fits the taller row.
      final buttonRect = tester.getRect(
        find.widgetWithText(TextButton, destination.label),
      );
      expect(header.top, lessThanOrEqualTo(buttonRect.top));
      expect(buttonRect.bottom, lessThanOrEqualTo(header.bottom));
    }

    expect(tester.takeException(), isNull);
  });

  testWidgets('compact width keeps all nav buttons visible with tighter padding', (
    tester,
  ) async {
    final store = await _store(tester);
    await _surface(tester, const Size(480, 800));
    await tester.pumpWidget(
      _header(store: store, onSelect: (_) {}, width: 480),
    );
    await tester.pump();

    // Every destination still renders below the compact breakpoint; the nav
    // scrolls horizontally rather than overflowing.
    for (final destination in kDashboardDestinations) {
      expect(find.text(destination.label), findsOneWidget);
      final style = _styleOf(tester, destination.label);
      final padding = style.padding?.resolve(<WidgetState>{})! as EdgeInsets;
      expect(padding.horizontal, 24.0); // 12px per side, down from 16px.
      expect(padding.vertical, 16.0);
    }

    expect(tester.takeException(), isNull);
  });

  testWidgets('enlarged nav buttons still select their destination', (
    tester,
  ) async {
    final store = await _store(tester);
    await _surface(tester, const Size(1100, 800));
    final selected = <DashboardView>[];
    await tester.pumpWidget(
      _header(store: store, onSelect: selected.add, width: 1100),
    );
    await tester.pump();

    await tester.tap(find.widgetWithText(TextButton, 'Work'));
    await tester.pump();
    expect(selected, [DashboardView.work]);

    // Tapping the lit destination keeps the current view rather than
    // re-jumping (targetFrom returns the already-selected view).
    await tester.tap(find.widgetWithText(TextButton, 'Actors'));
    await tester.pump();
    expect(selected, [DashboardView.work, DashboardView.actors]);
  });
}
