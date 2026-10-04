// Screenshot harness for #897's resizable sidebars on synthetic fixtures. Run:
//
//   flutter test test/resizable_sidebar_screenshot_test.dart
//
// It writes `screenshots/897_*_after.png`. The resting scenes use only widgets
// that predate #897, so the same file run against staging with
// `--dart-define=SHOT_SUFFIX=before` writes the matching `_before` images; the
// drag and clamp scenes exist only once the divider does.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const String _suffix = String.fromEnvironment(
  'SHOT_SUFFIX',
  defaultValue: 'after',
);

final _divider = find.byKey(const ValueKey('sidebar-divider'));

void main() {
  setUpAll(() async {
    await loadFonts();
  });

  Future<void> harness(
    WidgetTester tester,
    Size size,
    String view,
    Future<void> Function(GlobalKey key, Future<void> Function()) scenes,
  ) => tester.runAsync(() async {
    final api = FakeApi()
      ..threadsResult = [
        makeThread('root', title: 'Steward'),
        makeThread('w-docs', parent: 'root', title: 'Release notes writer'),
        makeThread('w-ci', parent: 'root', title: 'Build pipeline keeper'),
        makeThread('w-ui', parent: 'w-ci', title: 'Dashboard layout coder'),
      ]
      ..obligationsResult = [
        makeObligation(
          'ob-release',
          ownerId: 'w-docs',
          title: 'Publish the autumn release notes',
        ),
        makeObligation(
          'ob-upgrade',
          ownerId: 'w-docs',
          parentId: 'ob-release',
          title: 'Write the upgrade section with migration steps',
        ),
        makeObligation(
          'ob-pipeline',
          ownerId: 'w-ci',
          title: 'Keep the nightly build green across all platforms',
        ),
        makeObligation(
          'ob-sidebar',
          ownerId: 'w-ui',
          title: 'Let operators widen the left panels',
        ),
      ];
    final store = DashboardStore(
      api: api,
      stream: FakeStream(),
      treePreferencesCache: FakeTreePreferencesCache(
        storedWorkExpanded: {'ob-release'},
      ),
    );
    await store.init();
    addTearDown(store.dispose);
    store.clickActor('w-ui');
    tester.view
      ..physicalSize = size
      ..devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final key = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: buildMeshTheme(),
        builder: (context, child) => RepaintBoundary(key: key, child: child),
        home: Scaffold(
          backgroundColor: MeshColors.bgPrimary,
          body: DashboardBody(store: store),
        ),
      ),
    );
    Future<void> settle() async {
      for (var i = 0; i < 8; i++) {
        await tester.pump(const Duration(milliseconds: 60));
      }
    }

    await settle();
    if (size.width >= 700) {
      await tester.tap(find.widgetWithText(InkWell, view));
    } else {
      await tester.tap(find.byIcon(Icons.menu));
      await settle();
      await tester.tap(find.text(view).last);
    }
    await settle();
    await scenes(key, settle);
    await tester.pumpWidget(const SizedBox());
  });

  for (final view in ['Actors', 'Work']) {
    final slug = view.toLowerCase();
    String path(String scene, [String suffix = _suffix]) =>
        '$_outDir/897_${slug}_${scene}_$suffix.png';

    testWidgets('$view — wide resting, mid-drag, dragged and clamped', (
      tester,
    ) async {
      await harness(tester, const Size(1280, 800), view, (key, settle) async {
        await captureBoundary(key, path('wide'));
        if (_divider.evaluate().isEmpty) return;

        final drag = await tester.startGesture(tester.getCenter(_divider));
        await drag.moveBy(const Offset(90, 0));
        await drag.moveBy(const Offset(90, 0));
        await settle();
        await captureBoundary(key, path('wide_dragging', 'after'));
        await drag.up();
        await settle();
        await captureBoundary(key, path('wide_dragged', 'after'));

        tester.view.physicalSize = const Size(760, 800);
        await settle();
        await captureBoundary(key, path('clamped_760', 'after'));
      });
    });

    testWidgets('$view — phone layout', (tester) async {
      await harness(tester, const Size(390, 844), view, (key, settle) async {
        await captureBoundary(key, path('phone'));
        expect(_divider, findsNothing);
      });
    });
  }
}
