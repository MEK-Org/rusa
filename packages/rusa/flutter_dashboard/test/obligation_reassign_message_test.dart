// Reassigning with a message (#941): the dialog field, the request body, and
// the history entry that carries the message back to whoever reads it.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/obligation_dialogs.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

Future<Map<String, dynamic>> _sentBody(String? message) async {
  late Map<String, dynamic> sent;
  final api = DashboardApi(
    client: MockClient((req) async {
      sent = jsonDecode(req.body) as Map<String, dynamic>;
      return http.Response(
        jsonEncode({
          'ok': true,
          'obligation': {
            'id': 'ob-1',
            'ownerId': 'worker-1',
            'intent': 'Review',
            'status': 'ready',
            'effectivePriority': 1.0,
          },
        }),
        200,
      );
    }),
    base: Uri.parse('http://localhost:3000'),
  );
  await api.reassignObligation('ob-1', ownerId: 'worker-1', message: message);
  return sent;
}

void main() {
  group('reassign with a message (#941)', () {
    test('sends the message, and omits a blank one', () async {
      expect(await _sentBody('Please answer seat 2.'), {
        'ownerId': 'worker-1',
        'message': 'Please answer seat 2.',
      });
      expect(await _sentBody('   '), {'ownerId': 'worker-1'});
      expect(await _sentBody(null), {'ownerId': 'worker-1'});
    });

    testWidgets('the dialog sends what was typed in the message field', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..obligationsResult = [makeObligation('ob-1', ownerId: 'human:operator')];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Builder(
                builder: (context) => TextButton(
                  onPressed: () => showReassignObligationDialog(
                    context,
                    store,
                    api.obligationsResult.single,
                  ),
                  child: const Text('open'),
                ),
              ),
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
          'worker-1',
        );
        await tester.enterText(
          find.widgetWithText(TextFormField, 'Message (optional)'),
          '  Seat 2 asked about the cap; back to you.  ',
        );
        await tester.tap(find.widgetWithText(ElevatedButton, 'Reassign'));
        await tester.pumpAndSettle();

        expect(api.reassignCalls.single, (
          id: 'ob-1',
          ownerId: 'worker-1',
          message: 'Seat 2 asked about the cap; back to you.',
        ));
      });
    });

    testWidgets('history shows the message under the owner change', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final ob = makeObligation(
          'review',
          ownerId: 'worker-1',
          title: 'Review the export PR',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('worker-1')]
          ..obligationsResult = [ob]
          ..obligationDetails['review'] = ObligationDetailSnapshot.fromJson({
            'obligation': {
              'id': 'review',
              'ownerId': 'worker-1',
              'title': ob.heading,
              'status': 'ready',
              'effectivePriority': 1.0,
            },
            'history': [
              {
                'id': 1,
                'mutationKind': 'reassign',
                'actingPrincipal': 'human:operator',
                'timestamp': '2026-10-06T15:00:00.000Z',
                'before': {'ownerId': 'human:operator'},
                'after': {
                  'ownerId': 'worker-1',
                  'message': 'Seat 2 asked about the cap; back to you.',
                },
              },
            ],
          });
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);
        store.setFocusedObligationId('review');

        await tester.binding.setSurfaceSize(const Size(1600, 1000));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(body: WorkTab(store: store, onSelectView: (_) {})),
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.textContaining('reassigned from'), findsOneWidget);
        expect(
          find.text('Seat 2 asked about the cap; back to you.'),
          findsOneWidget,
        );
      });
    });
  });
}
