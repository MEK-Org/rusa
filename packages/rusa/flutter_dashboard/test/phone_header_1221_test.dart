import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/mobile_nav_drawer.dart';

import 'fakes.dart';

Future<DashboardStore> _createStore() async {
  final api = FakeApi()..threadsResult = [makeThread('root', created: 't0')];
  final store = DashboardStore(api: api, stream: FakeStream());
  await store.init();
  return store;
}

Widget _app(
  DashboardStore store, {
  required Size size,
  EdgeInsets viewPadding = EdgeInsets.zero,
}) {
  return MaterialApp(
    home: MediaQuery(
      data: MediaQueryData(
        size: size,
        padding: viewPadding,
        viewPadding: viewPadding,
      ),
      child: Scaffold(
        body: DashboardBody(store: store),
      ),
    ),
  );
}

void main() {
  group('MEK-Org/rusa#1221: Phone header status bar & nav bar insets', () {
    testWidgets('phone header insets below status bar when viewPadding.top is present', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final store = await _createStore();
        addTearDown(store.dispose);

        const phoneSize = Size(390, 844);
        const topPadding = 40.0;
        const bottomPadding = 48.0;

        await tester.binding.setSurfaceSize(phoneSize);
        addTearDown(() => tester.binding.setSurfaceSize(null));

        await tester.pumpWidget(
          _app(
            store,
            size: phoneSize,
            viewPadding: const EdgeInsets.only(
              top: topPadding,
              bottom: bottomPadding,
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));

        // Header widget itself must extend behind status bar (70 + 1px border + topPadding)
        final headerSize = tester.getSize(find.byType(MeshHeader));
        expect(
          headerSize.height,
          71.0 + topPadding,
          reason: 'Header container height must include top view padding',
        );

        // Hamburger icon must be positioned below the status bar
        final menuIcon = find.byIcon(Icons.menu);
        expect(menuIcon, findsOneWidget);
        final menuTop = tester.getTopLeft(menuIcon).dy;
        expect(
          menuTop,
          greaterThanOrEqualTo(topPadding),
          reason: 'Hamburger must be below status bar top padding of $topPadding, but was at $menuTop',
        );

        // Page title ("Overview") must also be positioned below the status bar
        final title = find.descendant(
          of: find.byType(MeshHeader),
          matching: find.text('Overview'),
        );
        expect(title, findsOneWidget);
        final titleTop = tester.getTopLeft(title).dy;
        expect(
          titleTop,
          greaterThanOrEqualTo(topPadding),
          reason: 'Page title must be below status bar top padding of $topPadding, but was at $titleTop',
        );
      });
    });

    testWidgets('tapping hamburger opens drawer on phone with status bar', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final store = await _createStore();
        addTearDown(store.dispose);

        const phoneSize = Size(390, 844);
        const topPadding = 40.0;
        const bottomPadding = 48.0;

        await tester.binding.setSurfaceSize(phoneSize);
        addTearDown(() => tester.binding.setSurfaceSize(null));

        await tester.pumpWidget(
          _app(
            store,
            size: phoneSize,
            viewPadding: const EdgeInsets.only(
              top: topPadding,
              bottom: bottomPadding,
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));

        final menuIcon = find.byIcon(Icons.menu);
        await tester.tap(menuIcon);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));

        expect(find.byType(MobileNavDrawer), findsOneWidget);
      });
    });

    testWidgets('bottom safe area insets content above 3-button navigation bar', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final store = await _createStore();
        addTearDown(store.dispose);

        const phoneSize = Size(390, 844);
        const topPadding = 40.0;
        const bottomPadding = 48.0;

        await tester.binding.setSurfaceSize(phoneSize);
        addTearDown(() => tester.binding.setSurfaceSize(null));

        await tester.pumpWidget(
          _app(
            store,
            size: phoneSize,
            viewPadding: const EdgeInsets.only(
              top: topPadding,
              bottom: bottomPadding,
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));

        // The nested Scaffold's body inside DashboardBody must be wrapped in SafeArea
        // so bottomPadding (48.0) is not overlapped by body content.
        final safeArea = find.descendant(
          of: find.byType(DashboardBody),
          matching: find.byType(SafeArea),
        );
        expect(safeArea, findsAtLeastNWidgets(1));

        final safeAreaWidget = tester.widget<SafeArea>(safeArea.first);
        expect(safeAreaWidget.bottom, isTrue);
      });
    });

    testWidgets('desktop header keeps 71px height (70px content + 1px border) without top padding', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final store = await _createStore();
        addTearDown(store.dispose);

        const desktopSize = Size(1200, 800);

        await tester.binding.setSurfaceSize(desktopSize);
        addTearDown(() => tester.binding.setSurfaceSize(null));

        await tester.pumpWidget(
          _app(store, size: desktopSize),
        );
        await tester.pump(const Duration(milliseconds: 50));

        final headerSize = tester.getSize(find.byType(MeshHeader));
        expect(headerSize.height, 71.0);
      });
    });
  });
}
