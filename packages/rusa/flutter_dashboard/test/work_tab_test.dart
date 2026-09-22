import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/obligations_cache.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/obligation_card.dart';
import 'package:rusa_dashboard/widgets/obligation_status.dart';
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
    'shows "Operator" for a human-owned obligation with durable user principal (#538)',
    (tester) async {
      await tester.runAsync(() async {
        const durableUser = '9f1c2e58-0000-4000-8000-00000000abcd';
        final ob = makeObligation(
          'ob-human-owner',
          ownerId: durableUser,
          intent: 'Operator decision task',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..dashboardConfigResult = const DashboardConfigDto(
            quotaProviders: {},
            userPrincipalId: durableUser,
          )
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
        await tester.tap(find.text('Operator decision task'));
        await tester.pump();
        await tester.pump();

        expect(find.text('OWNER'), findsOneWidget);
        expect(find.text('Operator'), findsOneWidget);
        expect(find.text('Unknown actor'), findsNothing);
        expect(find.text(durableUser), findsNothing);
        expect(find.text('View Owner Queue →'), findsOneWidget);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'shows "Operator" for a human creator with durable user principal (#538)',
    (tester) async {
      await tester.runAsync(() async {
        const durableUser = '9f1c2e58-0000-4000-8000-00000000abcd';
        final ob = makeObligation(
          'ob-human-creator-durable',
          ownerId: 'root',
          creatorId: durableUser,
          intent: 'Filed by the durable operator',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..dashboardConfigResult = const DashboardConfigDto(
            quotaProviders: {},
            userPrincipalId: durableUser,
          )
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
        await tester.tap(find.text('Filed by the durable operator'));
        await tester.pump();
        await tester.pump();

        expect(find.text('CREATOR'), findsOneWidget);
        expect(find.text('Operator'), findsOneWidget);
        expect(find.text('Unknown actor'), findsNothing);
        expect(find.text(durableUser), findsNothing);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'ObligationRow names a durable-principal owner, checkpoint author and '
    'blocker owner as "Operator" (#538)',
    (tester) async {
      await tester.runAsync(() async {
        const durableUser = '9f1c2e58-0000-4000-8000-00000000abcd';
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..dashboardConfigResult = const DashboardConfigDto(
            quotaProviders: {},
            userPrincipalId: durableUser,
          );
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        // A stateless row reads the principal at build; wait for the config
        // route (which init does not await) so the fixture is deterministic.
        await store.dashboardConfig.firstWhere(
          (c) => c?.userPrincipalId == durableUser,
        );

        final blocker = makeObligation(
          'ob-blocker',
          ownerId: durableUser,
          intent: 'Approve the schema',
        );
        final ob = makeObligation(
          'ob-durable-row',
          ownerId: durableUser,
          status: 'waiting',
          intent: 'Land the migration',
          checkpoint: 'head abc123; waiting on approval',
          checkpointAt: '2026-09-07T11:00:00.000Z',
          checkpointBy: durableUser,
        );
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SingleChildScrollView(
                child: ObligationRow(
                  obligation: ob,
                  store: store,
                  blockers: [blocker],
                  showOwner: true,
                ),
              ),
            ),
          ),
        );
        await tester.pump();

        expect(find.text('Owner: Operator'), findsOneWidget);
        expect(
          find.textContaining('Approve the schema (Operator)'),
          findsOneWidget,
        );
        expect(find.textContaining('Operator · '), findsOneWidget);
        expect(find.textContaining(durableUser), findsNothing);
        expect(find.textContaining('Unknown actor'), findsNothing);

        await store.dispose();
      });
    },
  );

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
    'keeps detail actions at the title start when the header wraps (#476)',
    (tester) async {
      await tester.runAsync(() async {
        await tester.binding.setSurfaceSize(const Size(1600, 800));
        addTearDown(() => tester.binding.setSurfaceSize(null));

        final ob = makeObligation(
          'header-actions',
          ownerId: 'root',
          title: 'Actions beside the obligation title',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [ob];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        store.setFocusedObligationId(ob.id);

        await tester.pumpWidget(
          MaterialApp(
            theme: buildMeshTheme(),
            home: Scaffold(
              body: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        await tester.pump();

        final title = find.byKey(const ValueKey('obligation-detail-title'));
        final actions = find.byKey(const ValueKey('obligation-detail-actions'));
        final editableRender = tester.allRenderObjects
            .whereType<RenderEditable>()
            .where((render) => render.plainText == ob.heading)
            .single;
        final wideTitleRect = tester.getRect(title);
        final wideActionsRect = tester.getRect(actions);
        // The controls are adjacent to the title rather than at the far edge
        // of the wide detail pane.

        expect(wideActionsRect.left, closeTo(wideTitleRect.right + 8, 1));
        // The title and adjacent controls share the same visual axis (#508).
        expect(wideActionsRect.center.dy, closeTo(wideTitleRect.center.dy, 1.0));
        final status = find.descendant(of: actions, matching: find.byType(ObligationStatusChip));
        expect(tester.getRect(status).center.dy, closeTo(wideTitleRect.center.dy, 1.0));
        for (final tooltip in [
          'Mark Done',
          'Cancel Obligation',
          'Reassign obligation',
          'Add child obligation',
        ]) {
          final controlRect = tester.getRect(find.byTooltip(tooltip));
          expect(controlRect.center.dy, closeTo(wideTitleRect.center.dy, 1.0));
        }

        expect(
          editableRender
              .getBoxesForSelection(
                TextSelection(baseOffset: 0, extentOffset: ob.heading.length),
              )
              .map((box) => box.top)
              .toSet(),
          hasLength(1),
          reason: 'short title unexpectedly wrapped',
        );

        await tester.binding.setSurfaceSize(const Size(400, 800));
        await tester.pump();
        await tester.pump();

        final narrowTitleRect = tester.getRect(title);
        final narrowActionsRect = tester.getRect(actions);

        // A two-line title moves the controls to a start-aligned run. The
        // controls themselves can wrap instead of overflowing the pane.
        expect(
          narrowTitleRect.height,
          closeTo(62, 1),
          reason: 'long title should grow to exactly two visible lines',
        );
        expect(narrowActionsRect.top, greaterThan(narrowTitleRect.bottom));
        expect(narrowActionsRect.left, closeTo(narrowTitleRect.left, 0.1));
        expect(narrowActionsRect.right, lessThanOrEqualTo(400));
        for (final tooltip in [
          'Mark Done',
          'Cancel Obligation',
          'Reassign obligation',
          'Add child obligation',
        ]) {
          final control = find.byTooltip(tooltip);
          expect(control, findsOneWidget);
          expect(tester.getRect(control).right, lessThanOrEqualTo(400));
        }

        await store.dispose();
      });
    },
  );

  testWidgets(
    'keeps detail actions usable with large text on a narrow pane (#476)',
    (tester) async {
      await tester.runAsync(() async {
        await tester.binding.setSurfaceSize(const Size(420, 800));
        addTearDown(() => tester.binding.setSurfaceSize(null));

        final ob = makeObligation(
          'large-text-header-actions',
          ownerId: 'system:mesh',
          title: 'Actions beside the obligation title',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [ob];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        store.setFocusedObligationId(ob.id);

        await tester.pumpWidget(
          MediaQuery(
            data: MediaQueryData(textScaler: TextScaler.linear(2)),
            child: MaterialApp(
              home: Scaffold(
                body: WorkTab(store: store, onSelectView: (_) {}),
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        await tester.pump();

        final title = find.byKey(const ValueKey('obligation-detail-title'));
        final actions = find.byKey(const ValueKey('obligation-detail-actions'));
        final titleRect = tester.getRect(title);
        final actionsRect = tester.getRect(actions);

        expect(titleRect.height, greaterThan(70));
        expect(actionsRect.top, greaterThan(titleRect.bottom));
        expect(actionsRect.left, closeTo(titleRect.left, 0.1));
        expect(actionsRect.right, lessThanOrEqualTo(420));
        for (final tooltip in [
          'Mark Done',
          'Cancel Obligation',
          'Reassign obligation',
          'Add child obligation',
        ]) {
          final control = find.byTooltip(tooltip);
          expect(control, findsOneWidget);
          expect(tester.getRect(control).right, lessThanOrEqualTo(420));
        }

        await store.dispose();
      });
    },
  );

  testWidgets(
    'aligns obligation title and actions on the same visual axis across dashboard widths (#508)',
    (tester) async {
      await tester.runAsync(() async {
        final ob = makeObligation(
          'visual-axis-header',
          ownerId: 'root',
          title: 'Aligned Title',
        );
        final terminalOb = makeObligation(
          'terminal-visual-axis',
          ownerId: 'root',
          title: 'Terminal Aligned Title',
          status: 'done',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [ob, terminalOb];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        store.setFocusedObligationId(ob.id);

        // Wide and standard desktop widths where title and action controls sit side-by-side
        for (final width in [1600.0, 1200.0]) {
          await tester.binding.setSurfaceSize(Size(width, 800));
          addTearDown(() => tester.binding.setSurfaceSize(null));

          await tester.pumpWidget(
            MaterialApp(
              theme: buildMeshTheme(),
              home: Scaffold(
                body: WorkTab(store: store, onSelectView: (_) {}),
              ),
            ),
          );
          await tester.pump();
          await tester.pump();
          await tester.pump();

          final title = find.byKey(const ValueKey('obligation-detail-title'));
          final actions = find.byKey(const ValueKey('obligation-detail-actions'));
          final titleRect = tester.getRect(title);
          final actionsRect = tester.getRect(actions);

          // The title occupies only its 1 line of height rather than inflating to 2 lines
          expect(titleRect.height, lessThan(40.0));

          // Shared horizontal visual axis between title and control wrap
          expect(
            actionsRect.center.dy,
            closeTo(titleRect.center.dy, 1.0),
            reason: 'Actions not centered with title at width $width',
          );

          // Status chip on the same visual axis
          final status = find.descendant(of: actions, matching: find.byType(ObligationStatusChip));
          expect(
            tester.getRect(status).center.dy,
            closeTo(titleRect.center.dy, 1.0),
            reason: 'Status chip not centered with title at width $width',
          );

          // Each individual action button on the same visual axis
          for (final tooltip in [
            'Mark Done',
            'Cancel Obligation',
            'Reassign obligation',
            'Add child obligation',
          ]) {
            final btnRect = tester.getRect(find.byTooltip(tooltip));
            expect(
              btnRect.center.dy,
              closeTo(titleRect.center.dy, 1.0),
              reason: '$tooltip button not centered with title at width $width',
            );
          }
        }

        // Narrow width where controls wrap to the next line
        await tester.binding.setSurfaceSize(const Size(400, 800));
        await tester.pump();
        await tester.pump();

        final narrowTitle = find.byKey(const ValueKey('obligation-detail-title'));
        final narrowActions = find.byKey(const ValueKey('obligation-detail-actions'));
        final narrowTitleRect = tester.getRect(narrowTitle);
        final narrowActionsRect = tester.getRect(narrowActions);

        expect(narrowActionsRect.top, greaterThanOrEqualTo(narrowTitleRect.bottom));
        // Inside the wrapped actions, controls remain aligned on the same visual axis
        final narrowStatus = find.descendant(of: narrowActions, matching: find.byType(ObligationStatusChip));
        final narrowStatusRect = tester.getRect(narrowStatus);
        final doneBtnRect = tester.getRect(find.byTooltip('Mark Done'));
        expect(
          narrowStatusRect.center.dy,
          closeTo(doneBtnRect.center.dy, 1.0),
          reason: 'Status chip not centered with action buttons in wrapped run',
        );

        // Verify terminal header visual axis alignment as well
        store.setFocusedObligationId(terminalOb.id);
        await tester.binding.setSurfaceSize(const Size(1200, 800));
        await tester.pumpWidget(
          MaterialApp(
            theme: buildMeshTheme(),
            home: Scaffold(
              body: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        await tester.pump();

        final terminalStatus = find.byType(ObligationStatusChip);
        final terminalTitle = find.byType(SelectableText).first;
        expect(
          tester.getRect(terminalStatus).center.dy,
          closeTo(tester.getRect(terminalTitle).center.dy, 1.0),
          reason: 'Terminal status chip not centered with terminal title',
        );

        await store.dispose();
      });
    },
  );

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
        final cache = FakeObligationsCache();
        final api = FakeApi(base: Uri.parse('http://localhost:4040'))
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [
            liveRoot,
            quietTerminalRoot,
            recurringTerminalRoot,
          ]
          ..dashboardConfigResult = const DashboardConfigDto(
            quotaProviders: {},
            userPrincipalId: 'test-user',
          );

        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          obligationsCache: cache,
        );
        await store.init();
        await pumpEventQueue();
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
        expect(
          cache.stored!.trees.map((tree) => tree.obligation.id),
          isNot(contains('root-quiet-done')),
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
        expect(
          cache.stored!.trees.map((tree) => tree.obligation.id),
          isNot(contains('root-quiet-done')),
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
    'renders both dependency directions with titles and navigable GitHub-backed rows',
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
              body: WorkTab(store: store, onSelectView: (_) {}),
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
        expect(find.text('Prerequisite Non-GitHub Title'), findsNWidgets(2));
        expect(find.text('Prerequisite with GitHub Issue'), findsNWidgets(2));
        expect(find.text('github:MEK-Org/rusa/issues/101'), findsOneWidget);

        // Check BLOCKS section
        expect(find.text('BLOCKS'), findsOneWidget);
        expect(find.text('Dependent with GitHub PR'), findsNWidgets(2));
        expect(find.text('github:MEK-Org/rusa/pulls/202'), findsOneWidget);
        expect(find.text('Dependent Non-GitHub Title'), findsNWidgets(2));

        // Tapping a GitHub-backed obligation opens its detail view, whose
        // existing reference card owns the resolved external link.
        await tester.tap(find.text('Prerequisite with GitHub Issue').last);
        for (int i = 0; i < 5; i++) {
          await tester.pump(const Duration(milliseconds: 10));
        }
        expect(store.focusedObligationId.value, 'prereq-gh');

        await store.dispose();
      });
    },
  );

  testWidgets(
    'shows bounded dependency page remainder without paging state',
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
          ..obBlockedBy = {
            'ob-target': [item1],
          }
          ..obBlockedByTotal = {
            'ob-target': 3,
          }
          ..obBlockedByHasMore = {
            'ob-target': true,
          }
          ..obBlocks = {
            'ob-target': [item2],
          }
          ..obBlocksTotal = {
            'ob-target': 5,
          }
          ..obBlocksHasMore = {
            'ob-target': true,
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

        expect(find.text('and 2 more'), findsOneWidget);
        expect(find.text('and 4 more'), findsOneWidget);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'measures cached and cold first useful content against the same delayed forest response (#505)',
    (tester) async {
      await tester.runAsync(() async {
        const forestResponseDelay = Duration(seconds: 2);
        final cachedOb = makeObligation(
          'cached-ob-1',
          ownerId: 'root',
          title: 'Cached Fast Loading Obligation',
        );
        final cachedTree = ObligationTreeDto(
          obligation: cachedOb,
          children: const [],
          blockingChildren: const [],
        );
        final snapshot = PersistedObligationsSnapshot.capture(
          scope: 'http://localhost:4040',
          principalId: 'test-user',
          trees: [cachedTree],
          now: DateTime.utc(2026, 9, 22, 12),
        );
        final serverOb = makeObligation(
          'server-ob-1',
          ownerId: 'root',
          title: 'Authoritative Obligation After Refresh',
        );

        Future<Duration> measureFirstUsefulContent({
          required ObligationsCache cache,
          required String firstUsefulTitle,
          required bool expectBeforeForestResponse,
        }) async {
          final gate = Completer<void>();
          final api = FakeApi(base: Uri.parse('http://localhost:4040'))
            ..threadsResult = [makeThread('root')]
            ..obligationsResult = [serverOb]
            ..dashboardConfigResult = const DashboardConfigDto(
              quotaProviders: {},
              userPrincipalId: 'test-user',
            )
            ..forestGates.add(gate);
          final store = DashboardStore(
            api: api,
            stream: FakeStream(),
            obligationsCache: cache,
          );

          await store.init();
          await store.dashboardConfig.firstWhere(
            (config) => config?.userPrincipalId == 'test-user',
          );
          if (expectBeforeForestResponse) {
            expect(store.cachedObligationTrees, isNotNull);
          }
          // Both measurements start at the same point: the Work tab begins
          // rendering after the authenticated principal has resolved. That
          // keeps the comparison focused on the forest response the cache
          // avoids waiting for, rather than timing an unrelated config call.
          final stopwatch = Stopwatch()..start();
          final forestResponse = Future<void>.delayed(
            forestResponseDelay,
            gate.complete,
          );
          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(
                body: WorkTab(store: store, onSelectView: (_) {}),
              ),
            ),
          );
          await tester.pump();

          // This is the rendered first-useful-content observation: the forest
          // request is still held below, so a cache hit must already be visible
          // and a cold load cannot yet show the server result.
          if (expectBeforeForestResponse) {
            expect(find.text(firstUsefulTitle), findsOneWidget);
            expect(find.text('WORK QUEUE'), findsOneWidget);
            expect(
              find.descendant(
                of: find.byType(WorkTab),
                matching: find.byType(CircularProgressIndicator),
              ),
              findsOneWidget,
            );
            stopwatch.stop();
          } else {
            expect(find.text(firstUsefulTitle), findsNothing);
          }

          await forestResponse;
          await pumpEventQueue();
          await tester.pump();
          await tester.pump();

          if (!expectBeforeForestResponse) stopwatch.stop();
          expect(
            find.text('Authoritative Obligation After Refresh'),
            findsOneWidget,
          );

          final elapsed = stopwatch.elapsed;
          await store.dispose();
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump();
          return elapsed;
        }

        final cachedFirstUseful = await measureFirstUsefulContent(
          cache: FakeObligationsCache(snapshot),
          firstUsefulTitle: 'Cached Fast Loading Obligation',
          expectBeforeForestResponse: true,
        );
        final coldFirstUseful = await measureFirstUsefulContent(
          cache: FakeObligationsCache(),
          firstUsefulTitle: 'Authoritative Obligation After Refresh',
          expectBeforeForestResponse: false,
        );

        // The cold control is the pre-cache path: it cannot render useful
        // obligations until the controlled forest response arrives.
        // The cached path is observed in a rendered frame before that response.
        expect(cachedFirstUseful, lessThan(forestResponseDelay));
        expect(coldFirstUseful, greaterThanOrEqualTo(forestResponseDelay));
        expect(coldFirstUseful, greaterThan(cachedFirstUseful));
        // Keep the actual before/after values in the test output so the PR can
        // report observed evidence without presenting a fabricated fixed time.
        // ignore: avoid_print
        print(
          'first useful content (#505, controlled ${forestResponseDelay.inMilliseconds}ms forest): '
          'cached=${cachedFirstUseful.inMilliseconds}ms, cold=${coldFirstUseful.inMilliseconds}ms',
        );
      });
    },
  );

  testWidgets(
    'never renders another principal’s cached obligations while config resolves (#505)',
    (tester) async {
      await tester.runAsync(() async {
        final aliceTree = ObligationTreeDto(
          obligation: makeObligation('alice-obligation', title: 'Alice private obligation'),
          children: const [],
          blockingChildren: const [],
        );
        final bobTree = ObligationTreeDto(
          obligation: makeObligation('bob-obligation', title: 'Bob cached obligation'),
          children: const [],
          blockingChildren: const [],
        );
        final configGate = Completer<DashboardConfigDto>();
        final firstForestGate = Completer<void>();
        final secondForestGate = Completer<void>();
        final api = FakeApi(base: Uri.parse('http://localhost:4040'))
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [makeObligation('fresh-bob', title: 'Bob authoritative obligation')]
          ..dashboardConfigGate = configGate
          ..forestGates.addAll([firstForestGate, secondForestGate]);
        final cache = FakeObligationsCache(
          PersistedObligationsSnapshot.capture(
            scope: 'http://localhost:4040',
            principalId: 'user-alice',
            trees: [aliceTree],
            now: DateTime.utc(2026, 9, 22, 12),
          ),
        )..save(
          PersistedObligationsSnapshot.capture(
            scope: 'http://localhost:4040',
            principalId: 'user-bob',
            trees: [bobTree],
            now: DateTime.utc(2026, 9, 22, 12),
          ),
        );
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          obligationsCache: cache,
        );
        await store.init();

        await tester.pumpWidget(
          MaterialApp(home: Scaffold(body: WorkTab(store: store, onSelectView: (_) {}))),
        );
        await tester.pump();
        expect(find.text('Alice private obligation'), findsNothing);

        configGate.complete(const DashboardConfigDto(
          quotaProviders: {},
          userPrincipalId: 'user-bob',
        ));
        await pumpEventQueue();
        await tester.pump();

        expect(find.text('Alice private obligation'), findsNothing);
        expect(find.text('Bob cached obligation'), findsOneWidget);

        firstForestGate.complete();
        secondForestGate.complete();
        await pumpEventQueue();
        await tester.pump();
        await tester.pump();

        expect(find.text('Alice private obligation'), findsNothing);
        expect(find.text('Bob authoritative obligation'), findsOneWidget);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'retains cached view and displays actionable retry banner when background refresh fails (#505)',
    (tester) async {
      await tester.runAsync(() async {
        final cachedOb = makeObligation(
          'cached-ob-err',
          ownerId: 'root',
          title: 'Cached Obligation Preserved On Error',
        );
        final cachedTree = ObligationTreeDto(
          obligation: cachedOb,
          children: const [],
          blockingChildren: const [],
        );
        final snapshot = PersistedObligationsSnapshot.capture(
          scope: 'http://localhost:4040',
          principalId: 'test-user',
          trees: [cachedTree],
          now: DateTime.utc(2026, 9, 22, 12),
        );
        final cache = FakeObligationsCache(snapshot);
        final api = FakeApi(base: Uri.parse('http://localhost:4040'))
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [cachedOb]
          ..dashboardConfigResult = const DashboardConfigDto(
            quotaProviders: {},
            userPrincipalId: 'test-user',
          )
          ..forestError = Exception('Network error during background sync');

        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          obligationsCache: cache,
        );
        await store.init();
        await pumpEventQueue();

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();

        // Even though fetch failed, the cached obligation MUST remain visible (no full-page error!)
        expect(find.text('Cached Obligation Preserved On Error'), findsOneWidget);

        // Actionable error banner and Retry button are displayed
        expect(find.textContaining('Failed to refresh:'), findsOneWidget);
        expect(find.textContaining('Network error during background sync'), findsNothing);
        expect(find.text('Retry'), findsOneWidget);

        // Clear error on API and tap Retry
        api.forestError = null;
        await tester.tap(find.text('Retry'));
        await pumpEventQueue();
        await tester.pump();
        await tester.pump();

        // Error banner is dismissed after successful retry
        expect(find.textContaining('Failed to refresh:'), findsNothing);
        expect(find.text('Cached Obligation Preserved On Error'), findsOneWidget);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'invalidates cache and reloads on obligation mutation in WorkTab (#505)',
    (tester) async {
      await tester.runAsync(() async {
        final cachedOb = makeObligation(
          'cached-ob-mut',
          ownerId: 'root',
          title: 'Before Mutation',
        );
        final cachedTree = ObligationTreeDto(
          obligation: cachedOb,
          children: const [],
          blockingChildren: const [],
        );
        final snapshot = PersistedObligationsSnapshot.capture(
          scope: 'http://localhost:4040',
          principalId: 'test-user',
          trees: [cachedTree],
          now: DateTime.utc(2026, 9, 22, 12),
        );
        final cache = FakeObligationsCache(snapshot);
        final api = FakeApi(base: Uri.parse('http://localhost:4040'))
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [cachedOb]
          ..dashboardConfigResult = const DashboardConfigDto(
            quotaProviders: {},
            userPrincipalId: 'test-user',
          );

        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          obligationsCache: cache,
        );
        await store.init();
        await pumpEventQueue();

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.text('Before Mutation'), findsOneWidget);

        // The shared store mutation seam covers callbacks outside WorkTab too.
        final created = await store.mutateObligations(
          () => api.createObligation(ownerId: 'root', title: 'Newly Created Child'),
        );
        expect(created.id, isNotNull);

        // The successful mutation invalidates the principal-scoped snapshot.
        expect(cache.invalidateCount, 1);
        expect(store.cachedObligationTrees, isNull);

        await store.dispose();
      });
    },
  );
}
