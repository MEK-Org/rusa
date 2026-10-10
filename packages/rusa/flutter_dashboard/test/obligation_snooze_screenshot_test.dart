// Screenshot harness for #893's snooze controls on synthetic fixtures. Run:
//
//   flutter test test/obligation_snooze_screenshot_test.dart
//
// It writes `screenshots/893_*_after.png`. The detail and menu scenes use only
// widgets that predate #893, so the same file run against staging with
// `--dart-define=SHOT_SUFFIX=before` writes the matching `_before` images; the
// dialog and picker scenes exist only once Snooze does.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/inbox_tab.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const String _suffix = String.fromEnvironment(
  'SHOT_SUFFIX',
  defaultValue: 'after',
);

DateTime _minute(DateTime t) =>
    DateTime.utc(t.year, t.month, t.day, t.hour, t.minute);

void main() {
  setUpAll(() async {
    await loadFonts();
  });

  const sizes = [('wide', Size(1280, 800)), ('phone', Size(390, 844))];

  Future<void> harness(
    WidgetTester tester,
    Size size,
    Widget Function(DashboardStore store) body,
    Future<void> Function(FakeApi api, GlobalKey key, Future<void> Function())
    scenes,
  ) => tester.runAsync(() async {
    final api = FakeApi()
      ..obligationsResult = [
        makeObligation(
          'ob-release',
          ownerId: '00000000-0000-4000-8000-000000000001',
          title: 'Review the release notes',
          intent:
              'Review the release notes\n'
              'Check the upgrade section before the next cut.',
        ),
        makeObligation(
          'ob-changelog',
          parentId: 'ob-release',
          ownerId: '00000000-0000-4000-8000-000000000001',
          title: 'Confirm changelog wording',
          // Relative to the live clock the views read, as the quota scenes
          // in screenshots_test.dart are, so the snooze is always ahead.
          snoozedUntil: _minute(
            DateTime.now().toUtc().add(
              const Duration(days: 1, hours: 20, minutes: 30),
            ),
          ).toIso8601String(),
        ),
      ];
    final store = DashboardStore(
      api: api,
      stream: FakeStream(),
      quotaCache: FakeQuotaCache(),
      treePreferencesCache: FakeTreePreferencesCache(),
    );
    addTearDown(store.dispose);
    // The view, not just the surface, so MediaQuery (and with it the
    // pickers' portrait/landscape layout) matches the device.
    tester.view
      ..physicalSize = size
      ..devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final key = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: buildMeshTheme(),
        // Around the Navigator, so dialogs, menus and pickers are captured.
        builder: (context, child) => RepaintBoundary(key: key, child: child),
        home: Scaffold(
          backgroundColor: MeshColors.bgPrimary,
          body: body(store),
        ),
      ),
    );
    Future<void> settle() async {
      for (var i = 0; i < 8; i++) {
        await tester.pump(const Duration(milliseconds: 60));
      }
    }

    await settle();
    await scenes(api, key, settle);
    // Every scene backs out; the harness never writes.
    expect(api.snoozeCalls, isEmpty);
  });

  for (final (name, size) in sizes) {
    String path(String scene, [String suffix = _suffix]) =>
        '$_outDir/893_${scene}_${name}_$suffix.png';

    testWidgets('detail header, dialog and pickers — $name', (tester) async {
      await harness(
        tester,
        size,
        (store) => WorkTab(store: store, onSelectView: (_) {}),
        (api, key, settle) async {
          await tester.tap(find.text('Review the release notes').first);
          await settle();
          await captureBoundary(key, path('detail'));

          final snooze = find.byTooltip('Snooze');
          if (snooze.evaluate().isEmpty) return;
          await tester.tap(snooze);
          await settle();
          await captureBoundary(key, path('dialog', 'after'));
          await tester.tap(find.byKey(const ValueKey('snooze-option-custom')));
          await settle();
          await captureBoundary(key, path('date_picker', 'after'));
          await tester.tap(find.text('OK'));
          await settle();
          await captureBoundary(key, path('time_picker', 'after'));
          await tester.tap(find.text('Cancel'));
          await settle();
        },
      );
    });

    testWidgets('owner queue row menu — $name', (tester) async {
      await harness(
        tester,
        size,
        (store) => InboxTab(
          actorId: '00000000-0000-4000-8000-000000000001',
          store: store,
        ),
        (api, key, settle) async {
          final menu = find.byTooltip('Obligation Actions');
          await tester.tap(menu.first);
          await settle();
          await captureBoundary(key, path('menu'));
          await tester.tapAt(Offset.zero);
          await settle();

          final change = find.text('Change Snooze...');
          await tester.tap(menu.last);
          await settle();
          if (change.evaluate().isEmpty) return;
          await captureBoundary(key, path('menu_snoozed', 'after'));
          await tester.tap(change);
          await settle();
          await captureBoundary(key, path('dialog_snoozed', 'after'));
          await tester.tap(find.text('Close'));
          await settle();
        },
      );
    });
  }
}
