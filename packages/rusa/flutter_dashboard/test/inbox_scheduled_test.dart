import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/inbox_tab.dart';

import 'fakes.dart';

Future<void> pumpInbox(WidgetTester tester, DashboardStore store) async {
  tester.view.physicalSize = const Size(1280, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: InboxTab(actorId: 'actor-a', store: store),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'InboxTab fetches scheduled obligations as their own filtered page and renders them',
    (tester) async {
      final scheduledOb = makeObligation(
        'ob-scheduled',
        ownerId: 'actor-a',
        intent: 'Nightly digest',
        status: 'scheduled',
        recurrencePolicy: 'cron',
        recurrenceCron: '0 6 * * *',
        nextReadyAt: '2026-09-03T06:00:00.000Z',
      );

      final api = FakeApi()
        ..obligationsResult = [scheduledOb]
        ..inboxResultsByStatus['unhandled'] = {'entries': []}
        ..inboxResultsByStatus['handled'] = {'entries': []};

      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        quotaCache: FakeQuotaCache(),
        treePreferencesCache: FakeTreePreferencesCache(),
      );

      await pumpInbox(tester, store);

      expect(find.text('Scheduled'), findsOneWidget);
      expect(find.text('Nightly digest'), findsOneWidget);
      expect(find.text('1 scheduled'), findsOneWidget);

      // Regression guard for the truncation bug: scheduled rows must come
      // from their own filtered fetch, not from partitioning a single
      // unfiltered owner page (which could silently drop scheduled rows once
      // ready/waiting rows fill that page's limit).
      expect(
        api.fetchObligationsCalls.any(
          (c) => c.ownerId == 'actor-a' && c.status == 'scheduled',
        ),
        isTrue,
      );
    },
  );
}
