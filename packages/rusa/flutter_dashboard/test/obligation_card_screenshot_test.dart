// Screenshot harness for #610: an actor whose selected inbox item is a GitHub
// review on a PR its obligation owns. The overview card shows that obligation
// rather than the raw event. Run with:
//
//   flutter test test/obligation_card_screenshot_test.dart
//
// and it writes `screenshots/610_actor_card_after.png`; the `_before` image is
// the same test run against staging, before the server tied entries.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';

void main() {
  setUpAll(() async {
    await loadFonts();
  });

  testWidgets('renders an actor card whose inbox item is tied to an '
      'obligation (#610)', (tester) async {
    await tester.runAsync(() async {
      final review = InboxEntryDto.fromJson({
        'id': 'entry-review',
        'actorId': 'worker',
        'source': 'github:rusa-e2e/scratch/pulls/3',
        'deliveredAt': '2026-10-01T12:00:00.000Z',
        'payload': {
          'type': 'pull_request_review.submitted',
          'reviewId': 1,
          'priority': 'responsive',
        },
        'reference': {
          'ref': 'github:rusa-e2e/scratch/pulls/3',
          'scheme': 'github',
          'title': 'rusa-e2e/scratch#3 — Tighten inbox payload validation',
          'url': 'https://github.com/rusa-e2e/scratch/pull/3',
          'entity': {
            'type': 'github_pull_request',
            'title': 'Tighten inbox payload validation',
            'state': 'open',
          },
        },
        'obligationId': 'ob-pr',
      });
      final api = FakeApi()
        ..runtimeCursor = const RuntimeCursor(streamId: 's', revision: 0)
        ..threadsResult = [
          makeThread('root', runState: RunState.idle),
          makeThread(
            'worker',
            parent: 'root',
            title: 'Worker',
            runState: RunState.running,
            selectedInboxItem: review,
            moreInboxItemsCount: 2,
          ),
        ]
        ..obligationsResult = [
          makeObligation(
            'ob-pr',
            ownerId: 'worker',
            title: 'Land the validation PR',
            intent:
                'Land the validation PR\n'
                'Answer review threads and get it merged.',
            externalRef: 'github:rusa-e2e/scratch/pulls/3',
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      addTearDown(store.dispose);
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final key = GlobalKey();
      await tester.binding.setSurfaceSize(const Size(900, 760));
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildMeshTheme(),
          home: Scaffold(
            backgroundColor: MeshColors.bgPrimary,
            body: RepaintBoundary(
              key: key,
              child: DashboardBody(store: store),
            ),
          ),
        ),
      );
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }

      expect(find.byType(OverviewTab), findsOneWidget);
      expect(find.text('(+2 more)'), findsOneWidget);
      await captureBoundary(key, '$_outDir/610_actor_card_after.png');
      expect(tester.takeException(), isNull);
    });
  });
}
