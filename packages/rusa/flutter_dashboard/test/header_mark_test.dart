import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/brand_mark.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/mobile_nav_drawer.dart';

import 'fakes.dart';

// Issue #429 replaces the dashboard's upper-left mark with the simplified
// antler/tree SVG. The normal-hidden status and active-halt badge behavior
// landed in #412 and remain covered here. The SVG loads asynchronously, so each
// test runs in a real async zone and pumps until the asset future completes.

Widget _header(DashboardStore store) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 1100,
      child: MeshHeader(
        store: store,
        selected: DashboardView.actors,
        onSelect: (_) {},
      ),
    ),
  ),
);

Widget _drawer(DashboardStore store) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 304,
      child: MobileNavDrawer(
        store: store,
        selected: DashboardView.overview,
        onSelect: (_) {},
      ),
    ),
  ),
);

Future<void> _pumpUntilMarkLoads(WidgetTester tester) async {
  await tester.pump();
  // Let the SvgPicture.asset future resolve against the real asset bundle.
  await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  await tester.pump();
}

void main() {
  testWidgets(
    'renders the simplified antler/tree mark upper-left in desktop header with bounds and crop margins',
    (tester) async {
      final api = FakeApi()..threadsResult = [makeThread('root', created: 't0')];
      final store = DashboardStore(api: api, stream: FakeStream());
      await tester.runAsync(store.init);

      await tester.binding.setSurfaceSize(const Size(1100, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(_header(store));
      await _pumpUntilMarkLoads(tester);

      final mark = find.byType(BrandMark);
      expect(mark, findsOneWidget);
      final svg = find.descendant(of: mark, matching: find.byType(SvgPicture));
      expect(svg, findsOneWidget);
      final header = find.byType(MeshHeader);
      expect(header, findsOneWidget);
      final text = find.text('RUSA');
      expect(text, findsOneWidget);

      final headerRect = tester.getRect(header);
      final markRect = tester.getRect(mark);
      final svgRect = tester.getRect(svg);
      final textRect = tester.getRect(text);

      // Overall desktop header height: 70px row + 1px bottom border = 71px.
      expect(headerRect.height, 71.0);

      // The 70px brand row containing the mark.
      final brandRow = find.ancestor(of: mark, matching: find.byType(SizedBox)).first;
      final brandRowRect = tester.getRect(brandRow);
      expect(brandRowRect.height, 70.0);

      // Artwork box constraint is 22px high and preserves 193:241 aspect ratio.
      expect(svgRect.height, 22.0);
      expect(svgRect.height / svgRect.width, moreOrLessEquals(193 / 241, epsilon: 0.01));

      // BrandMark footprint: vertical footprint is 32px (22 + 2*5 padding),
      // horizontal footprint is ~37.47px (22 * 241 / 193 + 2*5).
      expect(markRect.height, 32.0);
      expect(markRect.width, moreOrLessEquals(22 * 241 / 193 + 10, epsilon: 0.1));

      // Visual breathing room / crop-compensation margins:
      // Artwork has 5px internal clearance from the BrandMark container on all sides.
      expect(svgRect.top - markRect.top, 5.0);
      expect(markRect.bottom - svgRect.bottom, 5.0);
      expect(svgRect.left - markRect.left, 5.0);
      expect(markRect.right - svgRect.right, 5.0);

      // Vertical centering within 70px brand row:
      // (70 - 32) / 2 = 19px margin for BrandMark, 24px margin to artwork pixels.
      expect(markRect.top - brandRowRect.top, 19.0);
      expect(brandRowRect.bottom - markRect.bottom, 19.0);
      expect(svgRect.top - brandRowRect.top, 24.0);
      expect(brandRowRect.bottom - svgRect.bottom, 24.0);

      // Left-margin from viewport edge (20px header padding + 5px crop padding).
      expect(markRect.left - headerRect.left, 20.0);
      expect(svgRect.left - headerRect.left, 25.0);

      // Spacing to RUSA wordmark (10px container gap + 5px internal padding = 15px artwork gap).
      expect(textRect.left - markRect.right, 10.0);
      expect(textRect.left - svgRect.right, moreOrLessEquals(15.0, epsilon: 0.1));

      // Upper-left: mark sits strictly left of the wordmark.
      expect(markRect.left, lessThan(textRect.left));

      await tester.runAsync(store.dispose);
    },
  );

  testWidgets(
    'renders the simplified antler/tree mark in phone drawer with proper bounds and spacing',
    (tester) async {
      final api = FakeApi()..threadsResult = [makeThread('root', created: 't0')];
      final store = DashboardStore(api: api, stream: FakeStream());
      await tester.runAsync(store.init);

      await tester.pumpWidget(_drawer(store));
      await _pumpUntilMarkLoads(tester);

      final drawer = find.byType(MobileNavDrawer);
      expect(drawer, findsOneWidget);
      final mark = find.descendant(of: drawer, matching: find.byType(BrandMark));
      expect(mark, findsOneWidget);
      final svg = find.descendant(of: mark, matching: find.byType(SvgPicture));
      expect(svg, findsOneWidget);
      final text = find.descendant(of: drawer, matching: find.text('RUSA'));
      expect(text, findsOneWidget);

      final drawerRect = tester.getRect(drawer);
      final markRect = tester.getRect(mark);
      final svgRect = tester.getRect(svg);
      final textRect = tester.getRect(text);

      // Artwork box constraint is 22px high and preserves 193:241 aspect ratio.
      expect(svgRect.height, 22.0);
      expect(svgRect.height / svgRect.width, moreOrLessEquals(193 / 241, epsilon: 0.01));

      // BrandMark footprint in drawer.
      expect(markRect.height, 32.0);
      expect(markRect.width, moreOrLessEquals(22 * 241 / 193 + 10, epsilon: 0.1));

      // In the drawer, outer padding is (15, 15, 20, 11) to compensate for 5px mark padding,
      // landing the artwork at exactly 20px from drawer top and left edges.
      expect(markRect.left - drawerRect.left, 15.0);
      expect(markRect.top - drawerRect.top, 15.0);
      expect(svgRect.left - drawerRect.left, 20.0);
      expect(svgRect.top - drawerRect.top, 20.0);

      // Spacing to RUSA wordmark (10px container gap, ~15px artwork clearance).
      expect(textRect.left - markRect.right, 10.0);
      expect(textRect.left - svgRect.right, moreOrLessEquals(15.0, epsilon: 0.1));

      // Mark sits cleanly above the divider.
      final divider = find.descendant(of: drawer, matching: find.byType(Divider)).first;
      final dividerRect = tester.getRect(divider);
      expect(markRect.bottom, lessThan(dividerRect.top));

      await tester.runAsync(store.dispose);
    },
  );

  testWidgets('shows no routine status indicator during normal operation', (
    tester,
  ) async {
    final api = FakeApi()..threadsResult = [makeThread('root', created: 't0')];
    final store = DashboardStore(api: api, stream: FakeStream());
    await tester.runAsync(store.init);

    await tester.pumpWidget(_header(store));
    await _pumpUntilMarkLoads(tester);

    expect(find.text('Active'), findsNothing);
    expect(find.text('Halted'), findsNothing);
    await tester.runAsync(store.dispose);
  });

  testWidgets('shows the halted badge while an active halt exists', (
    tester,
  ) async {
    final api = FakeApi()
      ..halted = true
      ..threadsResult = [makeThread('root', created: 't0')];
    final store = DashboardStore(api: api, stream: FakeStream());
    await tester.runAsync(store.init);

    await tester.pumpWidget(_header(store));
    await _pumpUntilMarkLoads(tester);

    expect(find.text('Halted'), findsOneWidget);
    expect(find.text('Active'), findsNothing);
    // The mark stays put while halted.
    expect(find.byType(BrandMark), findsOneWidget);
    await tester.runAsync(store.dispose);
  });

  testWidgets('phone shape swaps the mark for the menu but keeps the brand', (
    tester,
  ) async {
    final api = FakeApi()..threadsResult = [makeThread('root', created: 't0')];
    final store = DashboardStore(api: api, stream: FakeStream());
    await tester.runAsync(store.init);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 390,
            child: MeshHeader(
              store: store,
              selected: DashboardView.actors,
              onSelect: (_) {},
              onMenuTap: () {},
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 50));

    // The drawer header carries the mark (checked in mobile_navigation tests);
    // the phone header row spends its single leading slot on the hamburger.
    expect(find.byIcon(Icons.menu), findsOneWidget);
    expect(find.text('RUSA'), findsOneWidget);
    await tester.runAsync(store.dispose);
  });
}
