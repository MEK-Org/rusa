import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/principals.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/obligation_dialogs.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';

import 'fakes.dart';

const kDurableUser = '9f1c2e58-0000-4000-8000-00000000abcd';

DashboardConfigDto _configWithUser(String? userPrincipalId) =>
    DashboardConfigDto(
      quotaProviders: const {},
      userPrincipalId: userPrincipalId,
    );

/// Hosts a dialog opened from a real BuildContext so the dialog's own owner
/// resolution — not a re-implementation of it — is what the test exercises.
Widget _dialogHost(
  DashboardStore store,
  Future<void> Function(BuildContext) open,
) => MaterialApp(
  home: Scaffold(
    body: Builder(
      builder: (context) =>
          TextButton(onPressed: () => open(context), child: const Text('open')),
    ),
  ),
);

void main() {
  group('durable principal attribution (#460)', () {
    testWidgets(
      'My Queue lists work owned by the durable user principal and by unmigrated alias rows',
      (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..threadsResult = [makeThread('root')]
            ..dashboardConfigResult = _configWithUser(kDurableUser)
            ..obligationsResult = [
              makeObligation(
                'ob-migrated',
                ownerId: kDurableUser,
                intent: 'Migrated decision',
                status: 'ready',
              ),
              makeObligation(
                'ob-legacy',
                ownerId: kLegacyOperatorPrincipalId,
                intent: 'Unmigrated decision',
                status: 'ready',
              ),
              makeObligation(
                'ob-actor',
                ownerId: 'worker-1',
                intent: 'Actor job',
                status: 'ready',
              ),
            ];
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();
          addTearDown(store.dispose);

          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(body: OverviewTab(store: store)),
            ),
          );
          await tester.pump();
          await tester.pump();

          // The durable owner is queried at all — the pre-#460 build asked
          // only for the alias, so a migrated row never appeared here.
          expect(
            api.fetchObligationsCalls.map((c) => c.ownerId).toSet(),
            containsAll(<String>{kDurableUser, kLegacyOperatorPrincipalId}),
          );
          expect(find.text('Migrated decision'), findsOneWidget);
          expect(find.text('Unmigrated decision'), findsOneWidget);
          expect(find.text('Actor job'), findsNothing);
          expect(find.text('2 obligations'), findsOneWidget);
        });
      },
    );

    testWidgets(
      'creating from My Queue attributes the obligation to the durable principal, not the alias',
      (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..threadsResult = [makeThread('root')]
            ..dashboardConfigResult = _configWithUser(kDurableUser);
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();
          addTearDown(store.dispose);

          await tester.binding.setSurfaceSize(const Size(1200, 900));
          addTearDown(() => tester.binding.setSurfaceSize(null));
          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(body: OverviewTab(store: store)),
            ),
          );
          await tester.pump();
          await tester.pump();

          await tester.tap(find.text('New Obligation'));
          await tester.pumpAndSettle();

          // The field still reads as the person, so the durable id is an
          // attribution detail rather than something to type out.
          expect(find.text(kOperatorDisplayHandle), findsOneWidget);
          await tester.enterText(
            find.widgetWithText(TextFormField, 'e.g. Game Type'),
            'Decide the cutover date',
          );
          await tester.tap(find.widgetWithText(ElevatedButton, 'Create'));
          await tester.pumpAndSettle();

          expect(api.createObligationCalls.single.ownerId, kDurableUser);
        });
      },
    );

    testWidgets(
      'typing "operator" in the reassign dialog names the durable principal',
      (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..dashboardConfigResult = _configWithUser(kDurableUser)
            ..obligationsResult = [makeObligation('ob-1', ownerId: 'worker-1')];
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();
          addTearDown(store.dispose);

          await tester.pumpWidget(
            _dialogHost(
              store,
              (context) => showReassignObligationDialog(
                context,
                store,
                api.obligationsResult.single,
              ),
            ),
          );
          await tester.tap(find.text('open'));
          await tester.pumpAndSettle();

          await tester.enterText(
            find.widgetWithText(
              TextFormField,
              'e.g. cloudy-porpoise, operator, or UUID',
            ),
            'operator',
          );
          await tester.tap(find.widgetWithText(ElevatedButton, 'Reassign'));
          await tester.pumpAndSettle();

          expect(api.reassignCalls.single.ownerId, kDurableUser);
        });
      },
    );

    testWidgets(
      'selecting the profile label keeps its durable principal separate',
      (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..dashboardConfigResult = _configWithUser(kDurableUser)
            ..obligationsResult = [makeObligation('ob-1', ownerId: 'worker-1')];
          final store = DashboardStore(
            api: api,
            stream: FakeStream(),
            operatorDisplayName: 'Ada Lovelace',
          );
          await store.init();
          addTearDown(store.dispose);

          await tester.pumpWidget(
            _dialogHost(
              store,
              (context) => showReassignObligationDialog(
                context,
                store,
                api.obligationsResult.single,
              ),
            ),
          );
          await tester.tap(find.text('open'));
          await tester.pumpAndSettle();

          await tester.enterText(
            find.widgetWithText(
              TextFormField,
              'e.g. cloudy-porpoise, operator, or UUID',
            ),
            'Ada',
          );
          await tester.pumpAndSettle();
          await tester.tap(find.text('Ada Lovelace'));
          await tester.pumpAndSettle();
          await tester.tap(find.widgetWithText(ElevatedButton, 'Reassign'));
          await tester.pumpAndSettle();

          expect(api.reassignCalls.single.ownerId, kDurableUser);
        });
      },
    );

    testWidgets(
      'creating after selecting the profile label keeps its durable principal separate',
      (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..dashboardConfigResult = _configWithUser(kDurableUser);
          final store = DashboardStore(
            api: api,
            stream: FakeStream(),
            operatorDisplayName: 'Ada Lovelace',
          );
          await store.init();
          addTearDown(store.dispose);

          await tester.pumpWidget(
            _dialogHost(
              store,
              (context) => showCreateObligationDialog(context, store),
            ),
          );
          await tester.tap(find.text('open'));
          await tester.pumpAndSettle();
          await tester.enterText(
            find.widgetWithText(TextFormField, 'e.g. Game Type'),
            'Keep durable owner',
          );
          await tester.enterText(
            find.widgetWithText(TextFormField, 'e.g. root, cloudy-porpoise'),
            'Ada',
          );
          await tester.pumpAndSettle();
          await tester.tap(find.text('Ada Lovelace'));
          await tester.pumpAndSettle();
          await tester.tap(find.widgetWithText(ElevatedButton, 'Create'));
          await tester.pumpAndSettle();

          expect(api.createObligationCalls.single.ownerId, kDurableUser);
        });
      },
    );

    testWidgets(
      'without a durable user the dialogs still fall back to the alias the server accepts',
      (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..dashboardConfigResult = _configWithUser(null)
            ..obligationsResult = [makeObligation('ob-1', ownerId: 'worker-1')];
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();
          addTearDown(store.dispose);

          await tester.pumpWidget(
            _dialogHost(
              store,
              (context) => showReassignObligationDialog(
                context,
                store,
                api.obligationsResult.single,
              ),
            ),
          );
          await tester.tap(find.text('open'));
          await tester.pumpAndSettle();

          await tester.enterText(
            find.widgetWithText(
              TextFormField,
              'e.g. cloudy-porpoise, operator, or UUID',
            ),
            'operator',
          );
          await tester.tap(find.widgetWithText(ElevatedButton, 'Reassign'));
          await tester.pumpAndSettle();

          expect(api.reassignCalls.single.ownerId, kLegacyOperatorPrincipalId);
        });
      },
    );

    test('interruptActor sends no client-chosen acting principal', () async {
      Map<String, dynamic>? sentBody;
      final client = MockClient((req) async {
        expect(req.url.path, '/api/mesh/actors/actor-1/interrupt');
        sentBody = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(jsonEncode({'ok': true}), 200);
      });
      final api = DashboardApi(
        client: client,
        base: Uri.parse('http://localhost:3000'),
      );

      await api.interruptActor('actor-1');

      // The server binds the acting principal; a `by` here could only be the
      // legacy alias or a guess.
      expect(sentBody, isEmpty);
    });
  });

  group('viewer principal helpers', () {
    test('reads under both ids, writes under the durable one', () {
      expect(viewerPrincipalIds(kDurableUser), [
        kDurableUser,
        kLegacyOperatorPrincipalId,
      ]);
      expect(viewerPrincipalIds(null), [kLegacyOperatorPrincipalId]);
      expect(viewerPrincipalIds(kLegacyOperatorPrincipalId), [
        kLegacyOperatorPrincipalId,
      ]);
      expect(viewerOwnerId(kDurableUser), kDurableUser);
      expect(viewerOwnerId(null), kLegacyOperatorPrincipalId);
      expect(
        isViewerPrincipal(kLegacyOperatorPrincipalId, kDurableUser),
        isTrue,
      );
      expect(
        isVerifiedViewerPrincipal(kLegacyOperatorPrincipalId, kDurableUser),
        isFalse,
      );
      expect(isVerifiedViewerPrincipal(kDurableUser, kDurableUser), isTrue);
      expect(isViewerPrincipal('worker-1', kDurableUser), isFalse);
      expect(isOperatorOwnerText(' operator ', kDurableUser), isTrue);
      expect(isOperatorOwnerText(kDurableUser, kDurableUser), isTrue);
      expect(isOperatorOwnerText('cloudy-porpoise', kDurableUser), isFalse);
      // A profile label is presentation data, not a principal alias: a real
      // actor is allowed to have the same handle without becoming the viewer.
      expect(isOperatorOwnerText('Ada Lovelace', kDurableUser), isFalse);
    });

    test('profile labels require the resolved durable principal', () async {
      final api = FakeApi()
        ..dashboardConfigResult = _configWithUser(kDurableUser);
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        operatorDisplayName: 'Ada Lovelace',
      );
      await store.init();
      await store.refreshDashboardConfig();
      addTearDown(store.dispose);

      expect(store.actorDisplay(kDurableUser), 'Ada Lovelace');
      expect(store.actorDisplay(kLegacyOperatorPrincipalId), 'Operator');
      expect(store.actorDisplay('human:another-user'), 'Operator');
      expect(store.ownerLabel(kDurableUser), 'Ada Lovelace');
      expect(store.ownerLabel(kLegacyOperatorPrincipalId), 'Operator');
    });
  });
}
