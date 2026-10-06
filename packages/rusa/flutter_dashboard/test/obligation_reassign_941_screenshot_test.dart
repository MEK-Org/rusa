// Screenshot harness for #941's reassignment message on synthetic fixtures.
// Run:
//
//   flutter test test/obligation_reassign_941_screenshot_test.dart
//
// It writes `screenshots/941_*_after.png`. Both scenes use widgets that
// predate #941, so the same file run against staging with
// `--dart-define=SHOT_SUFFIX=before` writes the matching `_before` images.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const String _suffix = String.fromEnvironment(
  'SHOT_SUFFIX',
  defaultValue: 'after',
);

const _message =
    'Seat 2 asked whether the provider cap was measured. Please answer on the thread, then hand it back.';

void main() {
  setUpAll(loadFonts);

  const sizes = [('wide', Size(1280, 800)), ('phone', Size(390, 844))];

  for (final (name, size) in sizes) {
    String path(String scene) => '$_outDir/941_${scene}_${name}_$_suffix.png';

    testWidgets('reassign dialog and history — $name', (tester) async {
      await tester.runAsync(() async {
        final ob = makeObligation(
          'review',
          ownerId: 'coder',
          creatorId: 'coder',
          title: 'Review PR #431: export run history',
          intent: 'Review PR #431 before it merges.',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('coder')]
          ..obligationsResult = [ob]
          ..obligationDetails['review'] = ObligationDetailSnapshot.fromJson({
            'obligation': {
              'id': 'review',
              'ownerId': 'coder',
              'creatorId': 'coder',
              'title': 'Review PR #431: export run history',
              'intent': 'Review PR #431 before it merges.',
              'status': 'ready',
              'effectivePriority': 1.0,
            },
            'history': [
              {
                'id': 1,
                'mutationKind': 'reassign',
                'actingPrincipal': 'human:operator',
                'timestamp': '2026-10-06T15:00:00.000Z',
                'before': {'ownerId': 'human:operator'},
                'after': {'ownerId': 'coder', 'message': _message},
              },
            ],
          });
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          quotaCache: FakeQuotaCache(),
          treePreferencesCache: FakeTreePreferencesCache(),
        );
        await store.init();
        addTearDown(store.dispose);
        store.setFocusedObligationId('review');
        tester.view
          ..physicalSize = size
          ..devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        final key = GlobalKey();
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildMeshTheme(),
            // Around the Navigator, so the dialog is captured.
            builder: (context, child) =>
                RepaintBoundary(key: key, child: child),
            home: Scaffold(
              backgroundColor: MeshColors.bgPrimary,
              body: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );
        Future<void> settle() async {
          for (var i = 0; i < 8; i++) {
            await tester.pump(const Duration(milliseconds: 60));
          }
        }

        await settle();
        await tester.ensureVisible(find.text('HISTORY'));
        await settle();
        await captureBoundary(key, path('history'));

        await tester.ensureVisible(find.byTooltip('Reassign obligation'));
        await settle();
        await tester.tap(find.byTooltip('Reassign obligation'));
        await settle();
        await tester.enterText(
          find.widgetWithText(
            TextFormField,
            'e.g. cloudy-porpoise, operator, or UUID',
          ),
          'operator',
        );
        // Close the owner suggestions so both runs show the bare dialog.
        FocusManager.instance.primaryFocus?.unfocus();
        await settle();
        final message = find.widgetWithText(
          TextFormField,
          'Message (optional)',
        );
        if (message.evaluate().isNotEmpty) {
          await tester.enterText(message, _message);
        }
        await settle();
        await captureBoundary(key, path('dialog'));
        await tester.tap(find.text('Cancel'));
        await settle();
        // The harness never writes.
        expect(api.reassignCalls, isEmpty);
      });
    });
  }
}
