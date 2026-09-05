import 'dart:async';

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

  testWidgets(
    'a stale filtered load cannot overwrite a newer unfiltered one while '
    'Show Done is on (#241)',
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
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [liveRoot, quietTerminalRoot];

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

        expect(api.fetchObligationForestCalls, hasLength(1));
        expect(find.text('Live root'), findsOneWidget);
        expect(find.text('Stale done stub'), findsNothing);

        // Gate the next two forest calls so the test controls which one
        // resolves first: a plain refresh (older, still filtered) started
        // just before a Show Done toggle (newer, unfiltered).
        final refreshGate = Completer<void>();
        final showDoneGate = Completer<void>();
        api.forestGates.addAll([refreshGate, showDoneGate]);

        await tester.tap(find.byTooltip('Refresh Queue'));
        await tester.pump();
        await tester.tap(find.byTooltip('Show Done'));
        await tester.pump();

        expect(api.fetchObligationForestCalls, hasLength(3));

        // The newer (Show Done, unfiltered) request resolves first.
        showDoneGate.complete();
        for (int i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 10));
        }

        expect(find.text('Stale done stub'), findsOneWidget);

        // The older (refresh, filtered) request finishes late. It must not
        // clobber the newer, unfiltered result now on screen even though
        // Show Done is still on.
        refreshGate.complete();
        for (int i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 10));
        }

        expect(find.text('Stale done stub'), findsOneWidget);
        expect(find.text('Live root'), findsOneWidget);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'a stale focus-link widening response cannot overwrite a newer refresh '
    "that has since picked up a new root (#241)",
    (tester) async {
      await tester.runAsync(() async {
        final liveRootA = makeObligation(
          'root-live-a',
          ownerId: 'root',
          intent: 'Live root A',
        );
        final quietRoot = makeObligation(
          'root-quiet',
          ownerId: 'root',
          intent: 'Stale done root',
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
          ..obligationsResult = [liveRootA, quietRoot, child];

        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        store.setFocusedObligationId('child-under-quiet-root');

        // Gate the initial load so the widget mounts with an empty forest
        // first, matching how the real widen trigger fires.
        final initialGate = Completer<void>();
        final widenGate = Completer<void>();
        api.forestGates.addAll([initialGate, widenGate]);

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );
        await tester.pump();

        // Initial filtered load resolves: the quiet root (and the focused
        // child under it) is excluded, so the focus link can't be resolved
        // and a widening reload starts automatically. That widening call's
        // result is computed right now, from today's data, but held open on
        // widenGate — mirroring a real request that is merely slow to
        // return.
        initialGate.complete();
        for (int i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 10));
        }

        expect(find.text('Live root A'), findsOneWidget);
        expect(api.fetchObligationForestCalls, hasLength(2));
        expect(
          api.fetchObligationForestCalls.last.includeTerminalRoots,
          isTrue,
        );

        // Before the widening reload resolves, the user navigates away from
        // the focused obligation, a second live root appears, and a plain
        // refresh (newer than the pending widen) picks it up.
        store.setFocusedObligationId(null);
        final liveRootB = makeObligation(
          'root-live-b',
          ownerId: 'root',
          intent: 'Live root B',
        );
        api.obligationsResult = [liveRootA, liveRootB, quietRoot, child];
        await tester.tap(find.byTooltip('Refresh Queue'));
        for (int i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 10));
        }

        expect(api.fetchObligationForestCalls, hasLength(3));
        expect(find.text('Live root B'), findsOneWidget);

        // The stale widen response — computed before root B existed —
        // finishes late. It must not erase root B by reverting to the
        // snapshot it captured back when its request was made.
        widenGate.complete();
        for (int i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 10));
        }

        expect(find.text('Live root A'), findsOneWidget);
        expect(find.text('Live root B'), findsOneWidget);

        await store.dispose();
      });
    },
  );
}
