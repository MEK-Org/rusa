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

  testWidgets('shows "Operator" for a human creator, never the raw human: id', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final ob = makeObligation(
        'ob-human-creator',
        ownerId: 'root',
        creatorId: 'human:operator',
        intent: 'Filed by the operator',
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
      await tester.tap(find.text('Filed by the operator'));
      await tester.pump();
      await tester.pump();

      expect(find.text('CREATOR'), findsOneWidget);
      expect(find.text('Operator'), findsOneWidget);
      expect(find.text('human:operator'), findsNothing);

      await store.dispose();
    });
  });

  testWidgets(
    'shows "Unknown actor" for a creator id no lookup can find, never the '
    'raw id',
    (tester) async {
      await tester.runAsync(() async {
        final ob = makeObligation(
          'ob-retired-creator',
          ownerId: 'root',
          creatorId: 'retired-actor-999',
          intent: 'Filed by someone gone from this mesh view',
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
        await tester.tap(
          find.text('Filed by someone gone from this mesh view'),
        );
        await tester.pump();
        await tester.pump();

        expect(find.text('CREATOR'), findsOneWidget);
        expect(find.text('Unknown actor'), findsOneWidget);
        expect(find.text('retired-actor-999'), findsNothing);

        await store.dispose();
      });
    },
  );

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

  testWidgets(
    'excludes quiet terminal roots from the default load, fetches them on '
    'Show Done (#241)',
    (tester) async {
      await tester.runAsync(() async {
        final liveRoot = makeObligation(
          'root-live',
          ownerId: 'root',
          intent: 'Live root',
        );
        final quietTerminalRoot = makeObligation(
          'root-quiet-done',
          ownerId: 'root',
          intent: 'Stale done stub',
          status: 'done',
        );
        final recurringTerminalRoot = makeObligation(
          'root-recurring-done',
          ownerId: 'root',
          intent: 'Recurring but currently done',
          status: 'done',
          recurrencePolicy: 'cron',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [
            liveRoot,
            quietTerminalRoot,
            recurringTerminalRoot,
          ];

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

        expect(find.text('Live root'), findsOneWidget);
        expect(find.text('Recurring but currently done'), findsOneWidget);
        expect(find.text('Stale done stub'), findsNothing);
        expect(api.fetchObligationForestCalls, hasLength(1));
        expect(
          api.fetchObligationForestCalls.single.includeTerminalRoots,
          isFalse,
        );

        await tester.tap(find.byTooltip('Show Done'));
        await tester.pump();
        await tester.pump();

        expect(find.text('Stale done stub'), findsOneWidget);
        expect(api.fetchObligationForestCalls, hasLength(2));
        expect(
          api.fetchObligationForestCalls.last.includeTerminalRoots,
          isTrue,
        );

        await store.dispose();
      });
    },
  );

  testWidgets(
    'widens to include terminal roots to resolve a focus link the default '
    'load excluded (#241)',
    (tester) async {
      await tester.runAsync(() async {
        final quietRoot = makeObligation(
          'root-quiet',
          ownerId: 'root',
          intent: 'Stale done stub',
          status: 'done',
        );
        final child = makeObligation(
          'child-under-quiet-root',
          parentId: 'root-quiet',
          ownerId: 'root',
          intent: 'Focused child under a quiet root',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [quietRoot, child];

        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        store.setFocusedObligationId('child-under-quiet-root');

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        await tester.pump();
        await tester.pump();
        await tester.pump();
        await tester.pump();

        expect(api.fetchObligationForestCalls, hasLength(2));
        expect(
          api.fetchObligationForestCalls.first.includeTerminalRoots,
          isFalse,
        );
        expect(
          api.fetchObligationForestCalls.last.includeTerminalRoots,
          isTrue,
        );
        expect(
          find.text('Focused child under a quiet root'),
          findsWidgets,
        );

        await store.dispose();
      });
    },
  );
}
