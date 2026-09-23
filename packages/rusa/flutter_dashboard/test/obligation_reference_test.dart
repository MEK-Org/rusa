import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/inbox_item_row.dart';
import 'package:rusa_dashboard/widgets/inbox_tab.dart';
import 'package:rusa_dashboard/widgets/obligation_card.dart';
import 'package:rusa_dashboard/widgets/obligation_status.dart';
import 'package:rusa_dashboard/widgets/reference_preview.dart';

import 'fakes.dart';

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(body: SingleChildScrollView(child: child)),
);

Map<String, dynamic> _readyHeadPayload(String obligationId) => {
  'type': 'obligation.ready_head',
  'obligationId': obligationId,
  'intent': 'Carried intent for $obligationId',
};

void main() {
  group('ObligationRow', () {
    testWidgets('leads its title with an OBLIGATION chip and follows it '
        'with status', (tester) async {
      final store = DashboardStore(api: FakeApi(), stream: FakeStream());
      await tester.pumpWidget(
        _host(
          ObligationRow(
            obligation: makeObligation(
              'ob-1',
              title: 'Ship the fix',
              intent: 'Ship the fix\nThen verify it in staging.',
            ),
            store: store,
            showActions: false,
            trailing: const Text('trailing-action'),
          ),
        ),
      );

      final chip = tester.getRect(find.byType(ReferenceKindChip));
      final title = tester.getRect(find.text('Ship the fix'));
      final status = tester.getRect(find.byType(ObligationStatusChip));
      // Chip, title, then status, all on one row.
      expect(chip.right, lessThanOrEqualTo(title.left));
      expect(chip.top, lessThan(title.bottom));
      expect(chip.bottom, greaterThan(title.top));
      expect(status.left, greaterThan(title.right));
      // The intent sits below that row, starting under the chip.
      final intent = tester.getRect(
        find.textContaining('verify it in staging'),
      );
      expect(intent.top, greaterThanOrEqualTo(chip.bottom));
      expect(intent.left, chip.left);
      expect(
        tester.getRect(find.text('trailing-action')).left,
        greaterThan(chip.right),
      );
    });

    testWidgets('can leave the chip off where the list already says so', (
      tester,
    ) async {
      final store = DashboardStore(api: FakeApi(), stream: FakeStream());
      await tester.pumpWidget(
        _host(
          ObligationRow(
            obligation: makeObligation('ob-1', title: 'Ship the fix'),
            store: store,
            showKindChip: false,
          ),
        ),
      );

      expect(find.text('OBLIGATION'), findsNothing);
      expect(find.text('Ship the fix'), findsOneWidget);
    });
  });

  group('referenceKindLabel', () {
    test('names what the reference is, else its source', () {
      expect(referenceKindLabel('mesh', 'mesh_message'), 'MESH MESSAGE');
      expect(referenceKindLabel('github', 'github_pull_request'), 'GITHUB PR');
      expect(referenceKindLabel('github', 'github_issue'), 'GITHUB ISSUE');
      expect(referenceKindLabel('slack', 'slack_message'), 'SLACK MESSAGE');
      expect(referenceKindLabel('github', null), 'GITHUB');
    });
  });

  group('ready-head inbox entries', () {
    test('share one obligation lookup across rebuilds', () async {
      final api = FakeApi();
      final store = DashboardStore(api: api, stream: FakeStream());

      final first = await store.obligationById('ob-1');
      final second = await store.obligationById('ob-1');

      expect(first?.id, 'ob-1');
      expect(second?.id, 'ob-1');
      expect(api.obligationDetailCallCount, 1);
    });

    testWidgets('render in the inbox tab as the obligation, with dismiss', (
      tester,
    ) async {
      final api = FakeApi()
        ..obligationsResult = [
          makeObligation('ob-1', ownerId: 'actor-a', title: 'Ship the fix'),
        ]
        ..inboxResultsByStatus['unhandled'] = {
          'entries': [
            {
              'id': 'entry-1',
              'source': 'obligation:ob-1',
              'deliveredAt': '2026-08-30T12:00:00.000Z',
              'payload': _readyHeadPayload('ob-1'),
            },
          ],
        }
        ..inboxResultsByStatus['handled'] = {'entries': []};
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        quotaCache: FakeQuotaCache(),
        treePreferencesCache: FakeTreePreferencesCache(),
      );
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

      expect(find.text('OBLIGATION.READY_HEAD'), findsNothing);
      expect(find.text('obligation:ob-1'), findsNothing);
      // One card for the inbox entry; the Ready Obligations list shows the
      // same obligation without a chip.
      expect(find.text('OBLIGATION'), findsOneWidget);
      expect(find.text('Ship the fix'), findsNWidgets(2));

      await tester.tap(find.text('Dismiss'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ElevatedButton, 'Dismiss'));
      await tester.pumpAndSettle();
      expect(api.markInboxHandledCalls.single.entryId, 'entry-1');
    });

    testWidgets('render on an overview row as the obligation card', (
      tester,
    ) async {
      final api = FakeApi()
        ..obligationsResult = [makeObligation('ob-1', title: 'Ship the fix')];
      final store = DashboardStore(api: api, stream: FakeStream());
      final entry = InboxEntryDto(
        id: 'entry-1',
        actorId: 'actor-1',
        source: 'obligation:ob-1',
        deliveredAt: '2026-08-30T12:00:00.000Z',
        payload: {..._readyHeadPayload('ob-1'), 'priority': 'responsive'},
      );
      expect(InboxItemRow.rendersOwnFrame(entry), isTrue);

      await tester.pumpWidget(
        _host(InboxItemRow(entry: entry, moreCount: 3, store: store)),
      );
      await tester.pumpAndSettle();

      expect(find.text('OBLIGATION'), findsOneWidget);
      expect(find.text('Ship the fix'), findsOneWidget);
      expect(find.text('RESPONSIVE'), findsOneWidget);
      expect(find.text('(+3 more)'), findsOneWidget);
      expect(find.byType(InboxChip), findsNothing);
    });

    testWidgets('fall back to the carried intent when the obligation cannot '
        'load', (tester) async {
      final api = FakeApi()
        ..obligationDetailByOffset = (id, _) => throw StateError('not found');
      final store = DashboardStore(api: api, stream: FakeStream());
      final entry = InboxEntryDto(
        id: 'entry-1',
        actorId: 'actor-1',
        source: 'obligation:ob-gone',
        deliveredAt: '2026-08-30T12:00:00.000Z',
        payload: _readyHeadPayload('ob-gone'),
      );

      await tester.pumpWidget(_host(InboxItemRow(entry: entry, store: store)));
      await tester.pumpAndSettle();

      expect(find.text('OBLIGATION'), findsOneWidget);
      expect(find.text('Carried intent for ob-gone'), findsOneWidget);
    });
  });
}
