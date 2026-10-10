// Screenshot harness for #992's failed Overview refresh on synthetic fixtures.
// Run:
//
//   flutter test test/overview_retained_992_screenshot_test.dart
//
// It writes `screenshots/992_overview_<viewport>_refresh_failed.png`: My Queue
// loads, then a refresh fails. The file uses only APIs staging already has, so
// running it against staging with `--dart-define=SHOT_SUFFIX=before` writes the
// matching `_before` images, where the failure replaces the rows.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const String _suffix = String.fromEnvironment('SHOT_SUFFIX');

/// Fails Overview's queue pages while [failQueue] is set.
class _FlakyQueueApi extends FakeApi {
  bool failQueue = false;

  @override
  Future<ObligationPage> fetchObligations({
    String? ownerId,
    String? status,
    String? queue,
    bool? rootsOnly,
    int? limit,
    int? offset,
  }) {
    if (failQueue && queue != null) {
      return Future.error(StateError('HTTP 503 from /api/obligations'));
    }
    return super.fetchObligations(
      ownerId: ownerId,
      status: status,
      queue: queue,
      rootsOnly: rootsOnly,
      limit: limit,
      offset: offset,
    );
  }
}

void main() {
  setUpAll(loadFonts);

  const sizes = [('wide', Size(1180, 820)), ('phone', Size(390, 844))];

  for (final (viewport, size) in sizes) {
    testWidgets('#992 overview $viewport refresh failed', (tester) async {
      await tester.runAsync(() async {
        final api = _FlakyQueueApi()
          ..obligationsResult = [
            makeObligation(
              'ob-ready',
              ownerId: testUserPrincipalId,
              intent: 'Approve the quarterly budget',
            ),
            makeObligation(
              'ob-waiting',
              ownerId: testUserPrincipalId,
              intent: 'Pick the launch date',
              status: 'waiting',
            ),
            makeObligation(
              'ob-child',
              parentId: 'ob-waiting',
              ownerId: 'worker-1',
              intent: 'Collect venue quotes',
            ),
          ];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);
        tester.view
          ..physicalSize = size
          ..devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);
        final key = GlobalKey();
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildMeshTheme(),
            home: RepaintBoundary(
              key: key,
              child: Scaffold(body: OverviewTab(store: store)),
            ),
          ),
        );
        for (var i = 0; i < 5; i++) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(find.text('Approve the quarterly budget'), findsOneWidget);

        api.failQueue = true;
        await tester.tap(find.byTooltip('Refresh Queue'));
        for (var i = 0; i < 5; i++) {
          await Future<void>.delayed(Duration.zero);
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(find.textContaining('Queue unavailable:'), findsOneWidget);
        expect(tester.takeException(), isNull);
        final name = _suffix.isEmpty
            ? 'refresh_failed'
            : 'refresh_failed_$_suffix';
        await captureBoundary(
          key,
          '$_outDir/992_overview_${viewport}_$name.png',
        );
      });
    });
  }
}
