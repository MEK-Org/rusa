import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

void main() {
  testWidgets('shows the creator handle when the obligation has one', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final ob = makeObligation(
        'ob-with-creator',
        ownerId: 'root',
        creatorId: 'creator-1',
        intent: 'Filed by someone else',
      );
      final api = FakeApi()
        ..threadsResult = [makeThread('root'), makeThread('creator-1')]
        ..obligationsResult = [ob];

      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: WorkTab(store: store, onSelectView: (_) {}),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      await tester.tap(find.text('Filed by someone else'));
      await tester.pump();
      await tester.pump();

      expect(find.text('CREATOR'), findsOneWidget);
      expect(find.text('creator-1-handle'), findsOneWidget);
      // Owner and creator differ here — the raw creator id should not leak
      // into the primary line, only the resolved handle should.
      expect(find.text('creator-1'), findsNothing);

      await store.dispose();
    });
  });

  testWidgets('shows an honest unknown state for a legacy null creator', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final ob = makeObligation(
        'ob-legacy',
        ownerId: 'root',
        intent: 'Predates creator attribution',
      );
      final api = FakeApi()
        ..threadsResult = [makeThread('root')]
        ..obligationsResult = [ob];

      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: WorkTab(store: store, onSelectView: (_) {}),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      await tester.tap(find.text('Predates creator attribution'));
      await tester.pump();
      await tester.pump();

      expect(find.text('CREATOR'), findsOneWidget);
      expect(
        find.text('Unknown — predates creator attribution'),
        findsOneWidget,
      );

      await store.dispose();
    });
  });
}
