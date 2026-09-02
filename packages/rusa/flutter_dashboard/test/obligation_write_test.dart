import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/inbox_tab.dart';
import 'package:rusa_dashboard/widgets/obligation_card.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

void main() {
  group('DashboardApi Obligation Write Methods', () {
    test(
      'createObligation sends POST with correct payload and returns ObligationDto',
      () async {
        final mockClient = MockClient((req) async {
          expect(req.url.path, '/api/mesh/obligations');
          expect(req.method, 'POST');
          final parsed = jsonDecode(req.body) as Map<String, dynamic>;
          expect(parsed['ownerId'], 'cloudy-porpoise');
          expect(parsed['title'], 'Test create');
          expect(parsed['intent'], 'Test create body');
          expect(parsed['priority'], 50.0);

          return http.Response(
            jsonEncode({
              'obligation': {
                'id': 'ob-new-1',
                'parentId': null,
                'ownerId': 'cloudy-porpoise',
                'title': 'Test create',
                'intent': 'Test create body',
                'externalRef': null,
                'status': 'ready',
                'priority': 50.0,
                'effectivePriority': 50.0,
                'prioritySourceId': 'ob-new-1',
              },
            }),
            201,
          );
        });

        final api = DashboardApi(
          client: mockClient,
          base: Uri.parse('http://localhost:3000'),
        );
        final result = await api.createObligation(
          ownerId: 'cloudy-porpoise',
          title: 'Test create',
          intent: 'Test create body',
          priority: 50.0,
        );

        expect(result.id, 'ob-new-1');
        expect(result.ownerId, 'cloudy-porpoise');
        expect(result.title, 'Test create');
        expect(result.heading, 'Test create');
        expect(result.effectivePriority, 50.0);
      },
    );

    test('setObligationStatus sends POST and transitions status', () async {
      final mockClient = MockClient((req) async {
        expect(req.url.path, '/api/mesh/obligations/ob-123/status');
        expect(req.method, 'POST');
        final parsed = jsonDecode(req.body) as Map<String, dynamic>;
        expect(parsed['status'], 'done');

        return http.Response(
          jsonEncode({
            'ok': true,
            'obligation': {
              'id': 'ob-123',
              'parentId': null,
              'ownerId': 'root',
              'intent': 'Discharged task',
              'externalRef': null,
              'status': 'done',
              'priority': 100.0,
              'effectivePriority': 100.0,
              'prioritySourceId': 'ob-123',
            },
          }),
          200,
        );
      });

      final api = DashboardApi(
        client: mockClient,
        base: Uri.parse('http://localhost:3000'),
      );
      final result = await api.setObligationStatus('ob-123', 'done');

      expect(result.id, 'ob-123');
      expect(result.status, 'done');
      expect(result.isDone, true);
    });

    test(
      'setObligationStatus sends the note and parses terminalNote back',
      () async {
        final mockClient = MockClient((req) async {
          final parsed = jsonDecode(req.body) as Map<String, dynamic>;
          expect(parsed['status'], 'cancelled');
          expect(parsed['note'], 'Superseded by #61.');

          return http.Response(
            jsonEncode({
              'ok': true,
              'obligation': {
                'id': 'ob-123',
                'parentId': null,
                'ownerId': 'root',
                'intent': 'Dropped task',
                'externalRef': null,
                'status': 'cancelled',
                'priority': 100.0,
                'effectivePriority': 100.0,
                'prioritySourceId': 'ob-123',
                'terminalNote': 'Superseded by #61.',
              },
            }),
            200,
          );
        });

        final api = DashboardApi(
          client: mockClient,
          base: Uri.parse('http://localhost:3000'),
        );
        final result = await api.setObligationStatus(
          'ob-123',
          'cancelled',
          note: 'Superseded by #61.',
        );

        expect(result.terminalNote, 'Superseded by #61.');
      },
    );

    test(
      'setObligationStatus omits a blank note rather than sending an empty reason',
      () async {
        final mockClient = MockClient((req) async {
          final parsed = jsonDecode(req.body) as Map<String, dynamic>;
          // Absent, not ''. The server records "no reason given" as null, and an
          // empty string would trip the column's own CHECK.
          expect(parsed.containsKey('note'), false);

          return http.Response(
            jsonEncode({
              'ok': true,
              'obligation': {
                'id': 'ob-123',
                'parentId': null,
                'ownerId': 'root',
                'intent': 'Quiet task',
                'externalRef': null,
                'status': 'done',
                'priority': 100.0,
                'effectivePriority': 100.0,
                'prioritySourceId': 'ob-123',
                'terminalNote': null,
              },
            }),
            200,
          );
        });

        final api = DashboardApi(
          client: mockClient,
          base: Uri.parse('http://localhost:3000'),
        );
        final result = await api.setObligationStatus(
          'ob-123',
          'done',
          note: '   ',
        );

        expect(result.terminalNote, isNull);
      },
    );

    test(
      'setObligationExternalRef sends the raw ref and parses the result',
      () async {
        final mockClient = MockClient((req) async {
          expect(req.url.path, '/api/mesh/obligations/ob-1/external-ref');
          final parsed = jsonDecode(req.body) as Map<String, dynamic>;
          // Sent verbatim: the grammar is the server's to define, and validating
          // it twice gives two places to disagree.
          expect(parsed['externalRef'], 'github:MEK-Org/rusa');
          return http.Response(
            jsonEncode({
              'ok': true,
              'obligation': {
                'id': 'ob-1',
                'ownerId': 'root',
                'title': 'Keep rusa releasable',
                'externalRef': {'key': 'github:MEK-Org/rusa'},
                'status': 'ready',
                'effectivePriority': 1.0,
              },
            }),
            200,
          );
        });

        final api = DashboardApi(
          client: mockClient,
          base: Uri.parse('http://localhost:3000'),
        );
        final result = await api.setObligationExternalRef(
          'ob-1',
          '  github:MEK-Org/rusa  ',
        );
        expect(result.externalRef, 'github:MEK-Org/rusa');
      },
    );

    test('a blank ref is sent as null, meaning unlink', () async {
      final mockClient = MockClient((req) async {
        final parsed = jsonDecode(req.body) as Map<String, dynamic>;
        expect(parsed['externalRef'], isNull);
        return http.Response(
          jsonEncode({
            'ok': true,
            'obligation': {
              'id': 'ob-1',
              'ownerId': 'root',
              'title': 'Unlinked',
              'externalRef': null,
              'status': 'ready',
              'effectivePriority': 1.0,
            },
          }),
          200,
        );
      });

      final api = DashboardApi(
        client: mockClient,
        base: Uri.parse('http://localhost:3000'),
      );
      expect(
        (await api.setObligationExternalRef('ob-1', '   ')).externalRef,
        isNull,
      );
    });

    test(
      'reorderObligation sends POST with previousId, nextId, and scope',
      () async {
        final mockClient = MockClient((req) async {
          expect(req.url.path, '/api/mesh/obligations/ob-target/reorder');
          expect(req.method, 'POST');
          final parsed = jsonDecode(req.body) as Map<String, dynamic>;
          expect(parsed['previousId'], 'ob-prev');
          expect(parsed['nextId'], 'ob-next');
          expect(parsed['scope'], 'subtree');

          return http.Response(
            jsonEncode({
              'ok': true,
              'obligation': {
                'id': 'ob-target',
                'parentId': null,
                'ownerId': 'root',
                'intent': 'Reordered',
                'externalRef': null,
                'status': 'ready',
                'priority': 150.0,
                'effectivePriority': 150.0,
                'prioritySourceId': 'ob-target',
              },
            }),
            200,
          );
        });

        final api = DashboardApi(
          client: mockClient,
          base: Uri.parse('http://localhost:3000'),
        );
        final result = await api.reorderObligation(
          'ob-target',
          previousId: 'ob-prev',
          nextId: 'ob-next',
          scope: 'subtree',
        );

        expect(result.id, 'ob-target');
        expect(result.effectivePriority, 150.0);
      },
    );

    test('reparentObligation sends POST with parentId', () async {
      final mockClient = MockClient((req) async {
        expect(req.url.path, '/api/mesh/obligations/ob-child/reparent');
        expect(req.method, 'POST');
        final parsed = jsonDecode(req.body) as Map<String, dynamic>;
        expect(parsed['parentId'], 'ob-new-parent');

        return http.Response(
          jsonEncode({
            'ok': true,
            'obligation': {
              'id': 'ob-child',
              'parentId': 'ob-new-parent',
              'ownerId': 'root',
              'intent': 'Reparented child',
              'externalRef': null,
              'status': 'ready',
              'priority': null,
              'effectivePriority': 200.0,
              'prioritySourceId': 'ob-new-parent',
            },
          }),
          200,
        );
      });

      final api = DashboardApi(
        client: mockClient,
        base: Uri.parse('http://localhost:3000'),
      );
      final result = await api.reparentObligation(
        'ob-child',
        parentId: 'ob-new-parent',
      );

      expect(result.id, 'ob-child');
      expect(result.parentId, 'ob-new-parent');
    });

    test('reassignObligation sends POST with the new owner', () async {
      final mockClient = MockClient((req) async {
        expect(req.url.path, '/api/mesh/obligations/ob-owner/reassign');
        expect(req.method, 'POST');
        expect(jsonDecode(req.body), {'ownerId': 'human:operator'});
        return http.Response(
          jsonEncode({
            'ok': true,
            'obligation': {
              'id': 'ob-owner',
              'parentId': null,
              'ownerId': 'human:operator',
              'intent': 'Reassigned task',
              'externalRef': null,
              'status': 'ready',
              'priority': 100.0,
              'effectivePriority': 100.0,
              'prioritySourceId': 'ob-owner',
            },
          }),
          200,
        );
      });
      final api = DashboardApi(
        client: mockClient,
        base: Uri.parse('http://localhost:3000'),
      );
      final result = await api.reassignObligation(
        'ob-owner',
        ownerId: 'human:operator',
      );
      expect(result.ownerId, 'human:operator');
    });
  });

  group('WorkTab Interactive Write UI', () {
    late FakeApi api;
    late DashboardStore store;

    setUp(() {
      api = FakeApi();
      final stream = FakeStream();
      store = DashboardStore(
        api: api,
        stream: stream,
        quotaCache: FakeQuotaCache(),
        treePreferencesCache: FakeTreePreferencesCache(),
      );
    });

    testWidgets(
      'renders work tab with obligation tree and interactive action buttons',
      (tester) async {
        tester.view.physicalSize = const Size(1280, 900);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPhysicalSize);

        final ob1 = makeObligation(
          'ob-root-1',
          intent: 'Root Feature',
          status: 'ready',
        );
        final ob2 = makeObligation(
          'ob-child-1',
          parentId: 'ob-root-1',
          intent: 'Child Task',
          status: 'ready',
        );
        api.obligationsResult = [ob1, ob2];

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );

        await tester.pumpAndSettle();

        expect(find.text('WORK QUEUE'), findsOneWidget);
        expect(find.text('Root Feature'), findsOneWidget);
        expect(find.byTooltip('New Root Obligation'), findsOneWidget);

        // Tap on the root obligation in the tree
        await tester.tap(find.text('Root Feature'));
        await tester.pumpAndSettle();

        // Check detail view sections
        expect(find.text('OBLIGATION ACTIONS'), findsOneWidget);
        expect(find.text('Mark Done'), findsOneWidget);
        expect(find.text('Cancel Obligation'), findsOneWidget);
        expect(find.text('Reassign...'), findsOneWidget);
        expect(find.text('Reparent...'), findsOneWidget);
        expect(find.text('Add Child...'), findsOneWidget);

        // Tap Mark Done and confirm dialog
        await tester.tap(find.text('Mark Done'));
        await tester.pumpAndSettle();

        expect(find.text('Mark Done Obligation?'), findsOneWidget);
        // Confirm the action
        await tester.tap(
          find.descendant(
            of: find.byType(AlertDialog),
            matching: find.widgetWithText(ElevatedButton, 'Mark Done'),
          ),
        );
        await tester.pumpAndSettle();

        // Verify the status transition was recorded in the api
        expect(api.statusCalls.length, 1);
        expect(api.statusCalls.first.id, 'ob-root-1');
        expect(api.statusCalls.first.status, 'done');
        // No reason typed is no reason recorded, not an empty one.
        expect(api.statusCalls.first.note, isNull);
      },
    );

    testWidgets('carries the operator\'s typed reason through to the API', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);

      api.obligationsResult = [
        makeObligation('ob-root-1', intent: 'Root Feature', status: 'ready'),
      ];

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: WorkTab(store: store, onSelectView: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Root Feature'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel Obligation'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.byType(TextField),
        ),
        'Superseded by the ancestry projection.',
      );
      await tester.tap(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.widgetWithText(ElevatedButton, 'Cancel'),
        ),
      );
      await tester.pumpAndSettle();

      expect(api.statusCalls.single.status, 'cancelled');
      expect(
        api.statusCalls.single.note,
        'Superseded by the ancestry projection.',
      );
    });

    testWidgets('shows why a terminal obligation ended', (tester) async {
      final done = makeObligation(
        'ob-done-1',
        intent: 'Pick a stack',
        ownerId: 'human:operator',
        status: 'done',
        terminalNote: 'Flutter — the tooling is already wired here.',
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ObligationRow(obligation: done, store: store),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Completed because:'), findsOneWidget);
      expect(
        find.text('Flutter — the tooling is already wired here.'),
        findsOneWidget,
      );
    });

    testWidgets('says nothing about a reason when none was recorded', (
      tester,
    ) async {
      final cancelled = makeObligation(
        'ob-quiet',
        intent: 'Dropped',
        status: 'cancelled',
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ObligationRow(obligation: cancelled, store: store),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Cancelled because:'), findsNothing);
    });

    testWidgets('owner panel labels the category instead of repeating the id', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);

      // Neither owner is a live actor this dashboard knows, so the panel's
      // primary line falls back to the raw id. Printing the id again beneath it
      // says nothing and drops the cue the old `Kind: ACTOR` line carried.
      final operatorOwned = makeObligation(
        'ob-op',
        ownerId: 'human:operator',
        intent: 'Operator Work',
      );
      final ghostOwned = makeObligation(
        'ob-ghost',
        ownerId: 'actor-ghost',
        intent: 'Ghost Work',
      );
      api.obligationsResult = [operatorOwned, ghostOwned];

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: WorkTab(store: store, onSelectView: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Operator Work'));
      await tester.pumpAndSettle();
      expect(find.text('OWNER'), findsOneWidget);
      expect(find.text('human:operator'), findsOneWidget);
      expect(find.text('Operator'), findsOneWidget);

      await tester.tap(find.text('Ghost Work'));
      await tester.pumpAndSettle();
      expect(find.text('actor-ghost'), findsOneWidget);
      expect(find.text('Actor — not in this mesh view'), findsOneWidget);
    });

    testWidgets('opens the external-ref dialog and unlinks through the API', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);

      api.obligationsResult = [
        makeObligation(
          'ob-linked',
          intent: 'Linked work',
          externalRef: 'github:MEK-Org/rusa/issues/33',
        ),
      ];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: WorkTab(store: store, onSelectView: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Linked work'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Change or unlink'));
      await tester.pumpAndSettle();
      expect(find.text('External Reference'), findsOneWidget);

      await tester.enterText(find.byType(TextField), '');
      await tester.tap(find.widgetWithText(ElevatedButton, 'Save'));
      await tester.pumpAndSettle();

      expect(api.externalRefCalls.single.id, 'ob-linked');
      expect(api.externalRefCalls.single.ref, '');
      expect(find.text('External Reference'), findsNothing);
    });

    testWidgets(
      'keeps the external-ref dialog open and shows the server error',
      (tester) async {
        tester.view.physicalSize = const Size(1280, 900);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPhysicalSize);

        api.externalRefError = StateError(
          'external ref must name a GitHub target',
        );
        api.obligationsResult = [
          makeObligation('ob-linkable', intent: 'Linkable work'),
        ];
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.text('Linkable work'));
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Link an issue, PR or repo'));
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byType(TextField),
          'github:MEK-Org/rusa/comments/9',
        );
        await tester.tap(find.widgetWithText(ElevatedButton, 'Save'));
        await tester.pumpAndSettle();

        expect(find.text('External Reference'), findsOneWidget);
        expect(
          find.text('Bad state: external ref must name a GitHub target'),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'does not offer external-ref editing for a terminal obligation',
      (tester) async {
        tester.view.physicalSize = const Size(1280, 900);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPhysicalSize);

        api.obligationsResult = [
          makeObligation(
            'ob-done',
            intent: 'Finished work',
            externalRef: 'github:MEK-Org/rusa',
            status: 'done',
          ),
        ];
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byTooltip('Show Done'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Finished work'));
        await tester.pumpAndSettle();

        expect(find.text('github:MEK-Org/rusa'), findsOneWidget);
        expect(find.byTooltip('Change or unlink'), findsNothing);
        expect(find.byTooltip('Link an issue, PR or repo'), findsNothing);
      },
    );

    testWidgets('allows creating a new root obligation from sidebar', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);

      api.obligationsResult = [];

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: WorkTab(store: store, onSelectView: (_) {}),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Tap the + button in sidebar
      await tester.tap(find.byTooltip('New Root Obligation'));
      await tester.pumpAndSettle();

      expect(find.text('Create Root Obligation'), findsOneWidget);

      // Fields in order: title, intent (body), owner.
      await tester.enterText(
        find.byType(TextFormField).at(0),
        'Brand New Root Task',
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byType(TextFormField).at(1),
        'What should become true when this is done.',
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextFormField).at(2), 'root');
      await tester.pumpAndSettle();

      // Tap Create
      await tester.tap(find.widgetWithText(ElevatedButton, 'Create'));
      await tester.pumpAndSettle();

      expect(api.createObligationCalls.length, 1);
      expect(api.createObligationCalls.first.title, 'Brand New Root Task');
      expect(
        api.createObligationCalls.first.intent,
        'What should become true when this is done.',
      );
      expect(api.createObligationCalls.first.parentId, null);
    });

    testWidgets('an empty body is sent as no body, not as an empty string', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: WorkTab(store: store, onSelectView: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('New Root Obligation'));
      await tester.pumpAndSettle();

      // Title only — a heading with no body is a legitimate obligation, and is
      // the cheap shape the interview flow depends on.
      await tester.enterText(find.byType(TextFormField).at(0), 'Game Type');
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextFormField).at(2), 'root');
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(ElevatedButton, 'Create'));
      await tester.pumpAndSettle();

      expect(api.createObligationCalls.single.title, 'Game Type');
      expect(api.createObligationCalls.single.intent, isNull);
    });

    testWidgets('allows reparenting an obligation', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);

      final ob1 = makeObligation(
        'ob-1',
        intent: 'Task to Reparent',
        status: 'ready',
      );
      api.obligationsResult = [ob1];

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: WorkTab(store: store, onSelectView: (_) {}),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Select obligation
      await tester.tap(find.text('Task to Reparent'));
      await tester.pumpAndSettle();

      // Tap Reparent...
      await tester.tap(find.text('Reparent...'));
      await tester.pumpAndSettle();

      expect(find.text('Reparent Obligation'), findsOneWidget);

      // Tap Attach to Parent button
      await tester.tap(find.text('Attach to Parent'));
      await tester.pumpAndSettle();

      // Enter new parent ID
      await tester.enterText(
        find.widgetWithText(TextFormField, '').first,
        'ob-new-target-parent',
      );
      await tester.pumpAndSettle();

      // Tap Reparent submit
      await tester.tap(find.widgetWithText(ElevatedButton, 'Reparent'));
      await tester.pumpAndSettle();

      expect(api.reparentCalls.length, 1);
      expect(api.reparentCalls.first.id, 'ob-1');
      expect(api.reparentCalls.first.parentId, 'ob-new-target-parent');
    });
  });

  group('InboxTab Interactive Write UI', () {
    late FakeApi api;
    late DashboardStore store;

    setUp(() {
      api = FakeApi();
      final stream = FakeStream();
      store = DashboardStore(
        api: api,
        stream: stream,
        quotaCache: FakeQuotaCache(),
        treePreferencesCache: FakeTreePreferencesCache(),
      );
    });

    testWidgets('renders ready obligations with reorder controls and actions', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);

      final ob1 = makeObligation(
        'ob-1',
        ownerId: 'actor-a',
        intent: 'First Ready',
        effectivePriority: 10.0,
      );
      final ob2 = makeObligation(
        'ob-2',
        ownerId: 'actor-a',
        intent: 'Second Ready',
        effectivePriority: 20.0,
      );
      api.obligationsResult = [ob1, ob2];

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: InboxTab(
              actorId: 'actor-a',
              store: store,
              onSelectView: (_) {},
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      expect(find.text('Ready Obligations'), findsOneWidget);
      expect(find.text('First Ready'), findsOneWidget);
      expect(find.text('Second Ready'), findsOneWidget);
      expect(find.text('New Obligation'), findsOneWidget);

      // Reorder: Move second item up
      final moveUpButtons = find.byTooltip('Move Up in Priority');
      expect(moveUpButtons, findsNWidgets(2));

      // The second item's Move Up button is active
      await tester.tap(moveUpButtons.last);
      await tester.pumpAndSettle();

      expect(api.reorderCalls.length, 1);
      expect(api.reorderCalls.first.id, 'ob-2');
      expect(api.reorderCalls.first.previousId, null);
      expect(api.reorderCalls.first.nextId, 'ob-1');
    });
  });
}
