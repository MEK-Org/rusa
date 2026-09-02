import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/inbox_tab.dart';

import 'fakes.dart';

Map<String, dynamic> entry(
  String id, {
  String source = 'mesh:root',
  String? handledAt,
  String? handledNote,
}) => {
  'id': id,
  'source': source,
  'deliveredAt': '2026-08-30T12:00:00.000Z',
  'handledAt': handledAt,
  'handledNote': handledNote,
  'payload': {'type': 'mesh.message', 'content': 'Body of $id'},
};

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
  group('DashboardApi.markInboxHandled', () {
    test('posts the entry id and the operator reason', () async {
      late String body;
      final mockClient = MockClient((req) async {
        expect(req.method, 'POST');
        expect(req.url.path, '/api/mesh/actors/actor-a/inbox/handled');
        body = req.body;
        return http.Response(jsonEncode({'ok': true}), 200);
      });

      final api = DashboardApi(
        client: mockClient,
        base: Uri.parse('http://localhost:3000'),
      );
      await api.markInboxHandled(
        'actor-a',
        'entry-1',
        reason: 'run cancelled by hand',
      );

      expect(jsonDecode(body), {
        'entryId': 'entry-1',
        'reason': 'run cancelled by hand',
      });
    });

    test('omits the reason entirely when none is given', () async {
      late String body;
      final mockClient = MockClient((req) async {
        body = req.body;
        return http.Response(jsonEncode({'ok': true}), 200);
      });

      final api = DashboardApi(
        client: mockClient,
        base: Uri.parse('http://localhost:3000'),
      );
      await api.markInboxHandled('actor-a', 'entry-1');

      // Absent rather than null: the server reads a missing reason as "no
      // reason given" and still records who cleared it.
      expect(jsonDecode(body), {'entryId': 'entry-1'});
    });

    test('throws on a non-200 so the UI can surface the failure', () async {
      final mockClient = MockClient(
        (req) async =>
            http.Response(jsonEncode({'error': 'inbox entry not found'}), 404),
      );

      final api = DashboardApi(
        client: mockClient,
        base: Uri.parse('http://localhost:3000'),
      );

      expect(
        () => api.markInboxHandled('actor-a', 'gone'),
        throwsA(isA<DashboardApiException>()),
      );
    });
  });

  group('InboxTab dismiss', () {
    late FakeApi api;
    late DashboardStore store;

    setUp(() {
      api = FakeApi();
      store = DashboardStore(
        api: api,
        stream: FakeStream(),
        quotaCache: FakeQuotaCache(),
        treePreferencesCache: FakeTreePreferencesCache(),
      );
    });

    testWidgets('dismisses an outstanding entry with a typed reason', (
      tester,
    ) async {
      api.inboxResultsByStatus['unhandled'] = {
        'entries': [entry('entry-1')],
      };
      api.inboxResultsByStatus['handled'] = {'entries': []};

      await pumpInbox(tester, store);

      expect(find.text('Outstanding inbox signals'), findsOneWidget);
      await tester.tap(find.text('Dismiss'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byType(TextField),
        'prod sent this to staging',
      );
      // The dialog's confirm button, not the card's trigger behind it.
      await tester.tap(find.widgetWithText(ElevatedButton, 'Dismiss'));
      await tester.pumpAndSettle();

      expect(api.markInboxHandledCalls.length, 1);
      expect(api.markInboxHandledCalls.first.actorId, 'actor-a');
      expect(api.markInboxHandledCalls.first.entryId, 'entry-1');
      expect(
        api.markInboxHandledCalls.first.reason,
        'prod sent this to staging',
      );
    });

    testWidgets('sends no reason when the operator types none', (tester) async {
      api.inboxResultsByStatus['unhandled'] = {
        'entries': [entry('entry-1')],
      };
      api.inboxResultsByStatus['handled'] = {'entries': []};

      await pumpInbox(tester, store);
      await tester.tap(find.text('Dismiss'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ElevatedButton, 'Dismiss'));
      await tester.pumpAndSettle();

      expect(api.markInboxHandledCalls.single.reason, isNull);
    });

    testWidgets('cancelling clears nothing', (tester) async {
      api.inboxResultsByStatus['unhandled'] = {
        'entries': [entry('entry-1')],
      };
      api.inboxResultsByStatus['handled'] = {'entries': []};

      await pumpInbox(tester, store);
      await tester.tap(find.text('Dismiss'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();

      expect(api.markInboxHandledCalls, isEmpty);
    });

    testWidgets('a resolved entry offers no dismiss', (tester) async {
      api.inboxResultsByStatus['unhandled'] = {'entries': []};
      api.inboxResultsByStatus['handled'] = {
        'entries': [
          entry(
            'entry-done',
            handledAt: '2026-08-30T13:00:00.000Z',
            handledNote: 'answered on the PR',
          ),
        ],
      };

      await pumpInbox(tester, store);

      expect(find.text('Recently resolved signals'), findsOneWidget);
      // Its note is already someone's account of it; the server would refuse to
      // overwrite that, so the UI does not offer to.
      expect(find.text('Dismiss'), findsNothing);
    });

    testWidgets('a failure surfaces instead of looking like it worked', (
      tester,
    ) async {
      api.inboxResultsByStatus['unhandled'] = {
        'entries': [entry('entry-1')],
      };
      api.inboxResultsByStatus['handled'] = {'entries': []};
      api.markInboxHandledError = Exception('inbox entry not found');

      await pumpInbox(tester, store);
      await tester.tap(find.text('Dismiss'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ElevatedButton, 'Dismiss'));
      await tester.pumpAndSettle();

      expect(find.byType(SnackBar), findsOneWidget);
      expect(find.textContaining('Failed to dismiss'), findsOneWidget);
    });
  });
}
