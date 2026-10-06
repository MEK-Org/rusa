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

  const ids = ['root', 'example-worker'];

  Future<DashboardStore> createStore() async {
    final activeEntry = InboxEntryDto.fromJson({
      'id': 'entry-active',
      'actorId': 'example-worker',
      'source': 'github:MEK-Org/rusa/pulls/871',
      'deliveredAt': '2026-10-04T12:00:00.000Z',
      'payload': {
        'type': 'pull_request_review.submitted',
        'reviewId': 1,
        'priority': 'responsive',
      },
      'reference': {
        'ref': 'github:MEK-Org/rusa/pulls/871',
        'scheme': 'github',
        'title': 'MEK-Org/rusa#871 — Remove room header on short screens',
        'url': 'https://github.com/MEK-Org/rusa/pull/871',
        'entity': {
          'type': 'github_pull_request',
          'title': 'Remove room header on short screens',
          'state': 'open',
        },
      },
      'obligationId': 'ob-871',
    });

    final api = FakeApi()
      ..runtimeCursor = const RuntimeCursor(streamId: 's', revision: 0)
      ..threadsResult = [
        makeThread('root', runState: RunState.idle),
        makeThread(
          'example-worker',
          parent: 'root',
          title: 'Example Worker',
          runState: RunState.running,
          selectedInboxItem: activeEntry,
        ),
      ]
      ..obligationsResult = [
        makeObligation(
          'ob-898',
          ownerId: 'human:operator',
          title: 'Open external link from obligation card',
          intent:
              'Deliver MEK-Org/rusa#898 as Matt wrote it:\n'
              'Obligation cards get an icon button next to status and remove bottom reference URL.',
          externalRef: 'github:MEK-Org/rusa/issues/898',
          status: 'ready',
        ),
        makeObligation(
          'ob-871',
          ownerId: 'example-worker',
          title: 'Remove room header on short screens',
          intent: 'Omit Room header on <=520px height narrow screens.',
          externalRef: 'github:MEK-Org/rusa/pulls/871',
          status: 'waiting',
        ),
      ];

    final store = DashboardStore(api: api, stream: FakeStream());
    await store.init();
    return store;
  }

  testWidgets('captures obligation card after screenshots (#898)', (
    tester,
  ) async {
    await tester.runAsync(() async {
      HttpOverrides.global = FakeImageHttpOverrides(await portraits(ids));
      addTearDown(() => HttpOverrides.global = null);
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final store = await createStore();
      addTearDown(store.dispose);

      final key = GlobalKey();

      // Wide viewport: 1200x800
      await tester.binding.setSurfaceSize(const Size(1200, 800));
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
      if (!File('$_outDir/898_obligation_card_wide_before.png').existsSync()) {
        await captureBoundary(
          key,
          '$_outDir/898_obligation_card_wide_before.png',
        );
      }
      await captureBoundary(key, '$_outDir/898_obligation_card_wide_after.png');

      // Phone viewport: 390x800
      await tester.binding.setSurfaceSize(const Size(390, 800));
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
      if (!File('$_outDir/898_obligation_card_phone_before.png').existsSync()) {
        await captureBoundary(
          key,
          '$_outDir/898_obligation_card_phone_before.png',
        );
      }
      await captureBoundary(
        key,
        '$_outDir/898_obligation_card_phone_after.png',
      );

      expect(tester.takeException(), isNull);
    });
  });
}
