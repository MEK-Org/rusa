// Screenshot harness for #1076's My Queue ancestor paths on synthetic
// fixtures. Run:
//
//   flutter test test/queue_ancestor_path_1076_screenshot_test.dart
//
// It writes `screenshots/1076_queue_<viewport>_paths.png`, and
// `screenshots/1076_queue_<viewport>_hidden_ancestors.png` with the … list
// open. The file uses only APIs staging already has, so running it against
// staging with `--dart-define=SHOT_SUFFIX=before` writes the matching
// `_paths_before` images, where cards show no path.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const String _suffix = String.fromEnvironment('SHOT_SUFFIX');

/// Root first.
const _chain = [
  ('goal', 'Company operating plan for the fiscal year'),
  ('eng', 'Engineering platform and developer productivity'),
  ('rel', 'Reliability and incident response programme'),
  ('dash', 'Mesh dashboard improvements for operators'),
  ('crumbs', 'Ancestor breadcrumbs for queue cards'),
];

void main() {
  setUpAll(loadFonts);

  const sizes = [('wide', Size(1180, 820)), ('phone', Size(390, 844))];

  for (final (viewport, size) in sizes) {
    testWidgets('#1076 queue $viewport ancestor paths', (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..obligationsResult = [
            for (var i = 0; i < _chain.length; i++)
              makeObligation(
                _chain[i].$1,
                parentId: i == 0 ? null : _chain[i - 1].$1,
                ownerId: 'worker-1',
                intent: _chain[i].$2,
              ),
            makeObligation('ops', ownerId: 'worker-1', intent: 'Operations'),
            makeObligation(
              'hiring',
              parentId: 'ops',
              ownerId: 'worker-1',
              intent: 'Hiring',
            ),
            makeObligation(
              'ob-deep',
              parentId: 'crumbs',
              ownerId: testUserPrincipalId,
              intent: 'Approve the breadcrumb design',
              effectivePriority: 100,
            ),
            makeObligation(
              'ob-short',
              parentId: 'hiring',
              ownerId: testUserPrincipalId,
              intent: 'Sign the offer letter',
              effectivePriority: 200,
            ),
            makeObligation(
              'ob-root',
              ownerId: testUserPrincipalId,
              intent: 'Pick the offsite venue',
              effectivePriority: 300,
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
            // Around the navigator, so the … list's route is captured too.
            builder: (context, child) =>
                RepaintBoundary(key: key, child: child),
            home: Scaffold(body: OverviewTab(store: store)),
          ),
        );
        for (var i = 0; i < 5; i++) {
          await Future<void>.delayed(Duration.zero);
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(find.text('Approve the breadcrumb design'), findsOneWidget);
        expect(tester.takeException(), isNull);
        final name = _suffix.isEmpty ? 'paths' : 'paths_$_suffix';
        await captureBoundary(key, '$_outDir/1076_queue_${viewport}_$name.png');

        final more = find.byKey(const ValueKey('ancestor-path-more'));
        if (more.evaluate().isEmpty) return;
        await tester.tap(more);
        for (var i = 0; i < 5; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(tester.takeException(), isNull);
        await captureBoundary(
          key,
          '$_outDir/1076_queue_${viewport}_hidden_ancestors.png',
        );
      });
    });
  }
}
