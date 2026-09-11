import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/reference_preview.dart';
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
        expect(find.text('Focused child under a quiet root'), findsWidgets);

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

  testWidgets(
    'shows parent link when obligation has a parent and navigates on tap in wide layout',
    (tester) async {
      await tester.runAsync(() async {
        final parent = makeObligation(
          'parent-ob',
          ownerId: 'root',
          intent: 'Parent obligation heading',
          title: 'Parent obligation heading',
        );
        final child = makeObligation(
          'child-ob',
          parentId: 'parent-ob',
          ownerId: 'root',
          intent: 'Child obligation heading',
          title: 'Child obligation heading',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [parent, child];

        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        store.setFocusedObligationId('child-ob');

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

        // Child detail view is shown
        expect(find.text('Child obligation heading'), findsWidgets);
        expect(find.text('PARENT'), findsOneWidget);
        expect(find.text('Parent obligation heading'), findsWidgets);

        // Scroll to and tap the parent row in the PARENT section
        await tester.ensureVisible(find.text('Parent obligation heading').last);
        await tester.pump();
        await tester.tap(find.text('Parent obligation heading').last);
        for (int i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 10));
        }

        // Verified that focusedObligationId was updated
        expect(store.focusedObligationId.value, 'parent-ob');
        // Parent detail view is now shown
        expect(find.text('Parent obligation heading'), findsWidgets);
        // Parent is a root obligation, so it should not show a PARENT section or misleading parent action
        expect(find.text('PARENT'), findsNothing);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'navigates to parent obligation from detail view in narrow layout',
    (tester) async {
      await tester.runAsync(() async {
        await tester.binding.setSurfaceSize(const Size(500, 800));
        addTearDown(() => tester.binding.setSurfaceSize(null));

        final parent = makeObligation(
          'parent-ob',
          ownerId: 'root',
          intent: 'Parent obligation heading',
          title: 'Parent obligation heading',
        );
        final child = makeObligation(
          'child-ob',
          parentId: 'parent-ob',
          ownerId: 'root',
          intent: 'Child obligation heading',
          title: 'Child obligation heading',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [parent, child];

        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        store.setFocusedObligationId('child-ob');

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

        // In narrow layout, child detail view is displayed with the back bar
        expect(find.text('Back to List'), findsOneWidget);
        expect(find.text('Child obligation heading'), findsWidgets);
        expect(find.text('PARENT'), findsOneWidget);
        expect(find.text('Parent obligation heading'), findsWidgets);

        // Tap the parent row in the PARENT section
        await tester.tap(find.text('Parent obligation heading').last);
        for (int i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 10));
        }

        // Focused obligation updated and parent detail view displayed in narrow mode
        expect(store.focusedObligationId.value, 'parent-ob');
        expect(find.text('Parent obligation heading'), findsWidgets);
        expect(find.text('PARENT'), findsNothing);
        expect(find.text('Back to List'), findsOneWidget);

        // Tap Back to List icon returns to sidebar list
        await tester.tap(find.byIcon(Icons.arrow_back));
        await tester.pump();
        await tester.pump();

        expect(find.text('WORK QUEUE'), findsOneWidget);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'renders external reference card when obligation has externalRef',
    (tester) async {
      await tester.runAsync(() async {
        final ob = makeObligation(
          'ob-with-ref',
          ownerId: 'root',
          intent: 'Task with external link',
          externalRef: 'github:MEK-Org/rusa#345',
        );
        const refDto = ReferenceDto(
          ref: 'github:MEK-Org/rusa#345',
          scheme: 'github',
          title: 'Make external link a reference card',
          author: 'root',
          body: 'Reference card in obligation view preview snippet',
          url: 'https://github.com/MEK-Org/rusa/issues/345',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [ob]
          ..obExternalReferences['ob-with-ref'] = refDto;

        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        final openedLinks = <String>[];

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: WorkTab(
                store: store,
                onSelectView: (_) {},
                openLink: openedLinks.add,
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        await tester.tap(find.text('Task with external link'));
        await tester.pump();
        await tester.pump();

        expect(find.text('EXTERNAL LINK'), findsOneWidget);
        expect(find.byType(ReferencePreview), findsOneWidget);
        expect(find.text('GITHUB'), findsOneWidget);
        expect(find.text('Make external link a reference card'), findsOneWidget);
        expect(find.text('root-handle'), findsOneWidget);
        expect(
          find.text('Reference card in obligation view preview snippet'),
          findsOneWidget,
        );

        // Tap open link icon button
        expect(find.byTooltip('Open in new tab'), findsOneWidget);
        await tester.tap(find.byTooltip('Open in new tab'));
        expect(openedLinks, ['https://github.com/MEK-Org/rusa/issues/345']);

        // Tap edit button to open edit dialog
        expect(find.byTooltip('Change or unlink'), findsOneWidget);
        await tester.tap(find.byTooltip('Change or unlink'));
        await tester.pump();
        await tester.pump();

        expect(find.text('External Reference'), findsOneWidget);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'hides change/unlink edit button on external reference card when obligation is terminal',
    (tester) async {
      await tester.runAsync(() async {
        final ob = makeObligation(
          'ob-terminal-with-ref',
          ownerId: 'root',
          intent: 'Terminal task with external link',
          externalRef: 'github:MEK-Org/rusa#345',
          status: 'done',
        );
        const refDto = ReferenceDto(
          ref: 'github:MEK-Org/rusa#345',
          scheme: 'github',
          title: 'Done obligation with reference card',
          url: 'https://github.com/MEK-Org/rusa/issues/345',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [ob]
          ..obExternalReferences['ob-terminal-with-ref'] = refDto;

        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        store.setFocusedObligationId('ob-terminal-with-ref');

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );
        // Let widening / initial loads complete
        for (int i = 0; i < 5; i++) {
          await tester.pump();
        }

        expect(find.text('EXTERNAL LINK'), findsOneWidget);
        expect(find.byType(ReferencePreview), findsOneWidget);
        expect(find.text('Done obligation with reference card'), findsOneWidget);
        expect(find.byTooltip('Open in new tab'), findsOneWidget);
        expect(find.byTooltip('Change or unlink'), findsNothing);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'renders fallback reference card when externalReference is not yet resolved',
    (tester) async {
      await tester.runAsync(() async {
        final ob = makeObligation(
          'ob-unresolved-ref',
          ownerId: 'root',
          intent: 'Unresolved external reference task',
          externalRef: 'github:MEK-Org/rusa#999',
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
        await tester.tap(find.text('Unresolved external reference task'));
        await tester.pump();
        await tester.pump();

        expect(find.text('EXTERNAL LINK'), findsOneWidget);
        expect(find.byType(ReferencePreview), findsOneWidget);
        expect(find.text('GITHUB'), findsOneWidget);
        expect(find.text('GitHub reference'), findsOneWidget);
        expect(find.text('Not resolvable yet.'), findsOneWidget);
        expect(find.byTooltip('Change or unlink'), findsOneWidget);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'renders unlinked placeholder and edit button when obligation has no externalRef',
    (tester) async {
      await tester.runAsync(() async {
        final ob = makeObligation(
          'ob-no-ref',
          ownerId: 'root',
          intent: 'Task without external link',
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
        await tester.tap(find.text('Task without external link'));
        await tester.pump();
        await tester.pump();

        expect(find.text('EXTERNAL LINK'), findsOneWidget);
        expect(find.byType(ReferencePreview), findsNothing);
        expect(
          find.text('Not linked to an issue, PR or repository.'),
          findsOneWidget,
        );
        expect(find.byTooltip('Link an issue, PR or repo'), findsOneWidget);

        // Tap link button to open edit dialog
        await tester.tap(find.byTooltip('Link an issue, PR or repo'));
        await tester.pump();
        await tester.pump();

        expect(find.text('External Reference'), findsOneWidget);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'renders empty state for BLOCKED BY and BLOCKS when no dependencies exist',
    (tester) async {
      await tester.runAsync(() async {
        await tester.binding.setSurfaceSize(const Size(1200, 1600));
        addTearDown(() => tester.binding.setSurfaceSize(null));

        final ob = makeObligation(
          'ob-no-deps',
          ownerId: 'root',
          intent: 'Standalone task',
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
        await tester.tap(find.text('Standalone task'));
        await tester.pump();
        await tester.pump();

        expect(find.text('BLOCKED BY'), findsOneWidget);
        expect(
          find.text('Not blocked by any obligations or issues.'),
          findsOneWidget,
        );
        expect(find.text('BLOCKS'), findsOneWidget);
        expect(
          find.text('Does not block any obligations or issues.'),
          findsOneWidget,
        );

        await store.dispose();
      });
    },
  );

  testWidgets(
    'renders both dependency directions (BLOCKED BY and BLOCKS) with human-readable titles and navigable links',
    (tester) async {
      await tester.runAsync(() async {
        await tester.binding.setSurfaceSize(const Size(1200, 1600));
        addTearDown(() => tester.binding.setSurfaceSize(null));

        final targetOb = makeObligation(
          'ob-target',
          ownerId: 'root',
          intent: 'Main target obligation',
        );
        final prereqNonGh = makeObligation(
          'prereq-non-gh',
          ownerId: 'root',
          title: 'Prerequisite Non-GitHub Title',
        );
        final prereqGh = makeObligation(
          'prereq-gh',
          ownerId: 'root',
          title: 'Prerequisite with GitHub Issue',
          externalRef: 'github:MEK-Org/rusa/issues/101',
        );
        final depGh = makeObligation(
          'dep-gh',
          ownerId: 'root',
          title: 'Dependent with GitHub PR',
          externalRef: 'github:MEK-Org/rusa/pulls/202',
        );
        final depNonGh = makeObligation(
          'dep-non-gh',
          ownerId: 'root',
          title: 'Dependent Non-GitHub Title',
        );

        final openedLinks = <String>[];
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [
            targetOb,
            prereqNonGh,
            prereqGh,
            depGh,
            depNonGh,
          ]
          ..obBlockedBy = {
            'ob-target': [prereqNonGh, prereqGh],
          }
          ..obBlocks = {
            'ob-target': [depGh, depNonGh],
          };

        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: WorkTab(
                store: store,
                onSelectView: (_) {},
                openLink: openedLinks.add,
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        await tester.tap(find.text('Main target obligation'));
        await tester.pump();
        await tester.pump();

        // Check BLOCKED BY section
        expect(find.text('BLOCKED BY'), findsOneWidget);
        expect(find.text('Prerequisite Non-GitHub Title'), findsWidgets);
        expect(find.text('Prerequisite with GitHub Issue'), findsWidgets);
        expect(find.text('github:MEK-Org/rusa/issues/101'), findsOneWidget);

        // Check BLOCKS section
        expect(find.text('BLOCKS'), findsOneWidget);
        expect(find.text('Dependent with GitHub PR'), findsWidgets);
        expect(find.text('github:MEK-Org/rusa/pulls/202'), findsOneWidget);
        expect(find.text('Dependent Non-GitHub Title'), findsWidgets);

        // Tapping the external reference link opens the derived GitHub URL
        await tester.tap(find.text('github:MEK-Org/rusa/issues/101'));
        expect(openedLinks, ['https://github.com/MEK-Org/rusa/issues/101']);

        await tester.tap(find.text('github:MEK-Org/rusa/pulls/202'));
        expect(openedLinks, [
          'https://github.com/MEK-Org/rusa/issues/101',
          'https://github.com/MEK-Org/rusa/pull/202',
        ]);

        // Tapping an obligation row focuses it
        await tester.tap(find.text('Prerequisite Non-GitHub Title').last);
        for (int i = 0; i < 5; i++) {
          await tester.pump(const Duration(milliseconds: 10));
        }
        expect(store.focusedObligationId.value, 'prereq-non-gh');

        await store.dispose();
      });
    },
  );

  testWidgets(
    'supports pagination load more buttons for BLOCKED BY and BLOCKS',
    (tester) async {
      await tester.runAsync(() async {
        await tester.binding.setSurfaceSize(const Size(1200, 1600));
        addTearDown(() => tester.binding.setSurfaceSize(null));

        final targetOb = makeObligation(
          'ob-target',
          ownerId: 'root',
          intent: 'Paged obligation',
        );
        final item1 = makeObligation('item-1', ownerId: 'root', title: 'Item 1');
        final item2 = makeObligation('item-2', ownerId: 'root', title: 'Item 2');

        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [targetOb, item1, item2]
          ..obligationDetails = {
            'ob-target': ObligationDetailSnapshot(
              obligation: targetOb,
              parent: null,
              children: [],
              blockingChildren: [],
              blockedBy: [item1],
              blockedByTotal: 3,
              blockedByHasMore: true,
              blocks: [item2],
              blocksTotal: 5,
              blocksHasMore: true,
            ),
          };

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
        await tester.tap(find.text('Paged obligation'));
        await tester.pump();
        await tester.pump();

        expect(find.text('Load more (2 remaining)'), findsOneWidget);
        expect(find.text('Load more (4 remaining)'), findsOneWidget);

        await store.dispose();
      });
    },
  );
}
