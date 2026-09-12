import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/breakpoints.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/header.dart';

import 'fakes.dart';

// Issue #423: the brand row is ~25% taller (56 -> 70px) and the nav labels
// render ~25% larger (13 -> 16px) with Material's own text-button padding
// around them. These tests measure what is laid out — label glyph height, the
// inset between label and button surface, and where the buttons land in the
// row — rather than reading the ButtonStyle literals back.

Widget _header({
  required DashboardStore store,
  required ValueChanged<DashboardView> onSelect,
  required double width,
  VisualDensity visualDensity = VisualDensity.compact,
}) => MaterialApp(
  // Desktop web's default density. The test platform would resolve to
  // standard density, which hides how the old zero-minimum / shrink-wrap
  // overrides collapsed the buttons' vertical padding to nothing on desktop.
  theme: buildMeshTheme().copyWith(visualDensity: visualDensity),
  home: Scaffold(
    body: SizedBox(
      width: width,
      child: MeshHeader(
        store: store,
        selected: DashboardView.actors,
        onSelect: onSelect,
      ),
    ),
  ),
);

Future<DashboardStore> _store(
  WidgetTester tester, {
  bool halted = false,
  List<String>? schedulerWarning,
}) async {
  final api = FakeApi()
    ..threadsResult = [makeThread('root', created: 't0')]
    ..halted = halted
    ..schedulerWarning = schedulerWarning;
  final store = DashboardStore(api: api, stream: FakeStream());
  await tester.runAsync(store.init);
  addTearDown(() => tester.runAsync(store.dispose));
  return store;
}

// The default 800x600 test surface would clamp a wider header into its
// two-tier <850px layout; size the surface to match the width under test.
Future<void> _surface(WidgetTester tester, double width) async {
  await tester.binding.setSurfaceSize(Size(width, 800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
}

Finder _button(String label) => find.widgetWithText(TextButton, label);

/// The button's visible surface (the ink box), as opposed to the outer
/// tap-target margin that `getRect(_button(...))` would include.
Rect _surfaceOf(WidgetTester tester, String label) => tester.getRect(
  find.descendant(of: _button(label), matching: find.byType(Material)),
);

void main() {
  testWidgets('desktop brand row is 70px and nav labels render ~25% larger '
      'with Material text-button padding around them', (tester) async {
    final store = await _store(tester);
    await _surface(tester, 1100);
    final selected = <DashboardView>[];
    await tester.pumpWidget(
      _header(store: store, onSelect: selected.add, width: 1100),
    );
    await tester.pump();

    final header = tester.getRect(find.byType(MeshHeader));
    expect(header.height, 56 * 1.25 + 1); // 70px row + 1px bottom border.

    for (final destination in kDashboardDestinations) {
      final label = destination.label;
      // The test font's line box is exactly the font size, so the rendered
      // label height is the effective text size: ~25% over the original 13px.
      final text = tester.getRect(find.text(label));
      expect(text.height, closeTo(13 * 1.25, 0.5), reason: '$label size');

      // "The typical amount of padding": the label sits inset from its
      // button surface by at least Material 3's text-button padding
      // (12px horizontal, 8px vertical). Before #423 the zero-minimum /
      // shrink-wrap overrides left no vertical room at desktop density.
      final surface = _surfaceOf(tester, label);
      expect(text.left - surface.left, greaterThanOrEqualTo(12), reason: label);
      expect(
        surface.right - text.right,
        greaterThanOrEqualTo(12),
        reason: label,
      );
      expect(text.top - surface.top, greaterThanOrEqualTo(8), reason: label);
      expect(
        surface.bottom - text.bottom,
        greaterThanOrEqualTo(8),
        reason: label,
      );

      // The full button, tap-target margin included, still fits the row.
      final button = tester.getRect(_button(label));
      expect(button.top, greaterThanOrEqualTo(header.top), reason: label);
      expect(button.bottom, lessThanOrEqualTo(header.bottom), reason: label);
    }

    // The restructured button (no shrink-wrap, no outer padding) still routes
    // a tap on its label to the selection callback.
    await tester.tap(find.text('Work'));
    await tester.pump();
    expect(selected, [DashboardView.work]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('standard density centers 48px nav targets in the 70px brand row',
      (tester) async {
    final store = await _store(tester);
    await _surface(tester, 1100);
    await tester.pumpWidget(
      _header(
        store: store,
        onSelect: (_) {},
        width: 1100,
        visualDensity: VisualDensity.standard,
      ),
    );
    await tester.pump();

    // Material's standard text-button target is 48px: it fits with 11px on
    // each side in the 70px brand row, so its surface and ink remain centered.
    for (final destination in kDashboardDestinations) {
      final button = tester.getRect(_button(destination.label));
      expect(button.height, 48);
      expect(button.top, 11);
      expect(button.bottom, 59);
      expect(button.center.dy, 35);
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('at the narrowest inline-nav width every nav button lays out '
      'inside the 70px brand row above the quota tier', (tester) async {
    // Below kNarrowBreakpoint the app hands the header a drawer and the inline
    // nav is not rendered, so this is the tightest width the nav must fit.
    final store = await _store(tester);
    await _surface(tester, kNarrowBreakpoint);
    await tester.pumpWidget(
      _header(store: store, onSelect: (_) {}, width: kNarrowBreakpoint),
    );
    await tester.pump();

    final header = tester.getRect(find.byType(MeshHeader));
    // Two-tier: the brand row keeps its 70px and the quota row stacks below.
    expect(header.height, greaterThan(71));
    for (final destination in kDashboardDestinations) {
      final button = tester.getRect(_button(destination.label));
      expect(button.top, greaterThanOrEqualTo(0), reason: destination.label);
      expect(button.bottom, lessThanOrEqualTo(70), reason: destination.label);
      expect(
        button.right,
        lessThanOrEqualTo(header.right),
        reason: destination.label,
      );
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('lit status badges push the nav into its scroller instead of '
      'overflowing the row', (tester) async {
    final store = await _store(
      tester,
      halted: true,
      schedulerWarning: const ['scheduler drift'],
    );
    await _surface(tester, kNarrowBreakpoint);
    await tester.pumpWidget(
      _header(store: store, onSelect: (_) {}, width: kNarrowBreakpoint),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);

    // The last destination starts off the right edge of the header...
    final header = tester.getRect(find.byType(MeshHeader));
    final last = kDashboardDestinations.last.label;
    expect(tester.getRect(_button(last)).right, greaterThan(header.right));

    // ...and the horizontal scroller brings it into view.
    await tester.ensureVisible(_button(last));
    await tester.pumpAndSettle();
    expect(
      tester.getRect(_button(last)).right,
      lessThanOrEqualTo(header.right),
    );
  });
}
