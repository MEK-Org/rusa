import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/mobile_nav_drawer.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';

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
    testWidgets('phone layout insets header below status bar, consumes insets for body, and opens drawer', (
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

        // 1. Header widget container extends behind status bar (70 + 1px border + topPadding)
        final headerSize = tester.getSize(find.byType(MeshHeader));
        expect(
          headerSize.height,
          71.0 + topPadding,
          reason: 'Header container height must include top view padding',
        );

        // 2. Hamburger icon & title positioned below the status bar
        final menuIcon = find.byIcon(Icons.menu);
        expect(menuIcon, findsOneWidget);
        final menuTop = tester.getTopLeft(menuIcon).dy;
        expect(
          menuTop,
          greaterThanOrEqualTo(topPadding),
          reason: 'Hamburger must be below status bar top padding of $topPadding, but was at $menuTop',
        );

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

        // 3. Body content layout bounds: rendered bottom bound must stop above the navigation bar
        final overviewFinder = find.byType(OverviewTab);
        expect(overviewFinder, findsOneWidget);
        final overviewBounds = tester.getRect(overviewFinder);
        expect(
          overviewBounds.bottom,
          lessThanOrEqualTo(phoneSize.height - bottomPadding),
          reason: 'Body content must stop above bottom navigation bar of $bottomPadding',
        );

        // 4. MediaQuery.padding inside body below MeshHeader must have consumed top and bottom insets
        final innerContext = tester.element(overviewFinder);
        final innerPadding = MediaQuery.paddingOf(innerContext);
        expect(
          innerPadding.top,
          0.0,
          reason: 'Top padding must be consumed for child scroll views below MeshHeader',
        );
        expect(
          innerPadding.bottom,
          0.0,
          reason: 'Bottom padding must be consumed by SafeArea for child scroll views',
        );

        // 5. Tapping hamburger opens MobileNavDrawer
        await tester.tap(menuIcon);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        expect(find.byType(MobileNavDrawer), findsOneWidget);
      });
    });

    testWidgets('wide/landscape Android viewport insets header and protects bottom nav bar', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final store = await _createStore();
        addTearDown(store.dispose);

        const landscapeSize = Size(844, 390);
        const topPadding = 24.0;
        const bottomPadding = 48.0;

        await tester.binding.setSurfaceSize(landscapeSize);
        addTearDown(() => tester.binding.setSurfaceSize(null));

        await tester.pumpWidget(
          _app(
            store,
            size: landscapeSize,
            viewPadding: const EdgeInsets.only(
              top: topPadding,
              bottom: bottomPadding,
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));

        // At 844 width (< 850), twoTier is active (70px brand + 12px quota tier + 1px border = 83px base).
        // Header height includes topPadding even though drawerNav is false.
        final headerSize = tester.getSize(find.byType(MeshHeader));
        expect(
          headerSize.height,
          83.0 + topPadding,
          reason: 'Landscape/wide header must include top view padding',
        );

        // Header content (e.g. RUSA wordmark) must be below the top status bar padding
        final wordmark = find.text('RUSA');
        expect(wordmark, findsOneWidget);
        final wordmarkTop = tester.getTopLeft(wordmark).dy;
        expect(
          wordmarkTop,
          greaterThanOrEqualTo(topPadding),
          reason: 'RUSA wordmark must be below top padding of $topPadding, but was at $wordmarkTop',
        );

        // On a short landscape viewport (height 390 < kShortViewportHeight 500),
        // landingViewFor selects DashboardView.actors, rendering ActorTree.
        // Body content stops above bottom nav bar.
        final treeFinder = find.byType(ActorTree);
        expect(treeFinder, findsOneWidget);
        final treeBounds = tester.getRect(treeFinder);
        expect(
          treeBounds.bottom,
          lessThanOrEqualTo(landscapeSize.height - bottomPadding),
        );

        // Inner body has consumed top and bottom padding
        final innerContext = tester.element(treeFinder);
        final innerPadding = MediaQuery.paddingOf(innerContext);
        expect(innerPadding.top, 0.0);
        expect(innerPadding.bottom, 0.0);
      });
    });

    testWidgets('short-viewport walkie mode hides header and insets top via SafeArea', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final store = await _createStore();
        addTearDown(store.dispose);
        store.setWalkieActive(true);

        const shortSize = Size(390, 450);
        const topPadding = 40.0;
        const bottomPadding = 48.0;

        await tester.binding.setSurfaceSize(shortSize);
        addTearDown(() => tester.binding.setSurfaceSize(null));

        await tester.pumpWidget(
          _app(
            store,
            size: shortSize,
            viewPadding: const EdgeInsets.only(
              top: topPadding,
              bottom: bottomPadding,
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));

        // MeshHeader must not be rendered
        expect(find.byType(MeshHeader), findsNothing);

        // Body content must be inset below status bar (top >= topPadding)
        final chromeFinder = find.descendant(
          of: find.byType(SafeArea),
          matching: find.byType(ColoredBox),
        );
        expect(chromeFinder, findsWidgets);
        final chromeTop = tester.getTopLeft(chromeFinder.first).dy;
        expect(chromeTop, greaterThanOrEqualTo(topPadding));
      });
    });

    testWidgets('short-viewport walkie transition preserves body element and state under stable wrapper ancestry', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final store = await _createStore();
        addTearDown(store.dispose);

        const shortSize = Size(390, 450);
        const topPadding = 40.0;
        const bottomPadding = 48.0;

        await tester.binding.setSurfaceSize(shortSize);
        addTearDown(() => tester.binding.setSurfaceSize(null));

        await tester.pumpWidget(
          _app(
            store,
            size: shortSize,
            viewPadding: const EdgeInsets.only(
              top: topPadding,
              bottom: bottomPadding,
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));

        // On short viewport without walkie: landing view selects actors (ActorTree), header is visible.
        expect(find.byType(MeshHeader), findsOneWidget);
        final treeFinder = find.byType(ActorTree);
        expect(treeFinder, findsOneWidget);

        // Capture the element of the mounted body widget before the transition
        final elementBefore = tester.element(treeFinder);

        // Activate walkie: on short viewport (height 450 < 500), hideHeader becomes true.
        store.setWalkieActive(true);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        // Header is now hidden
        expect(find.byType(MeshHeader), findsNothing);

        // Body content remains mounted with the EXACT SAME Element instance (no reparenting / state loss)
        expect(find.byType(ActorTree), findsOneWidget);
        final elementDuring = tester.element(find.byType(ActorTree));
        expect(
          identical(elementBefore, elementDuring),
          isTrue,
          reason: 'Body element must be preserved across walkie toggle under stable Builder/MediaQuery wrapper',
        );

        // Deactivate walkie: header returns, element identity remains preserved
        store.setWalkieActive(false);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.byType(MeshHeader), findsOneWidget);
        expect(find.byType(ActorTree), findsOneWidget);
        final elementAfter = tester.element(find.byType(ActorTree));
        expect(
          identical(elementBefore, elementAfter),
          isTrue,
          reason: 'Body element must remain preserved when returning from walkie mode',
        );
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
