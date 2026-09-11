import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/brand_mark.dart';
import 'package:rusa_dashboard/widgets/header.dart';

import 'fakes.dart';

// Issue #412: the dashboard's upper-left mark is the operator-supplied
// antler/tree SVG, the routine status indicator is gone, and an active halt
// still surfaces a visible badge. The SVG loads asynchronously, so each test
// runs in a real async zone and pumps until the asset future completes.

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

Future<void> _pumpUntilMarkLoads(WidgetTester tester) async {
  await tester.pump();
  // Let the SvgPicture.asset future resolve against the real asset bundle.
  await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  await tester.pump();
}

void main() {
  testWidgets('renders the antler/tree mark upper-left with crop padding', (
    tester,
  ) async {
    final api = FakeApi()..threadsResult = [makeThread('root', created: 't0')];
    final store = DashboardStore(api: api, stream: FakeStream());
    await tester.runAsync(store.init);

    await tester.pumpWidget(_header(store));
    await _pumpUntilMarkLoads(tester);

    final mark = find.byType(BrandMark);
    expect(mark, findsOneWidget);
    // The artwork itself is an SvgPicture inside a crop-compensating Padding.
    final svg = find.descendant(of: mark, matching: find.byType(SvgPicture));
    expect(svg, findsOneWidget);
    final padding = tester.widget<Padding>(
      find.ancestor(of: svg, matching: find.byType(Padding)).first,
    );
    expect(padding.padding, const EdgeInsets.all(BrandMark.kPadding));
    // The artwork is not distorted: its painted aspect ratio matches the
    // 687x596 viewBox, letterboxed by BoxFit.contain instead.
    final svgSize = tester.getSize(svg);
    expect(svgSize.height / svgSize.width, moreOrLessEquals(596 / 687));

    // Upper-left: the mark starts left of the RUSA wordmark.
    expect(
      tester.getTopLeft(mark).dx,
      lessThan(tester.getTopLeft(find.text('RUSA')).dx),
    );
    await tester.runAsync(store.dispose);
  });

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
