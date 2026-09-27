import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/obligation_card.dart';

import 'fakes.dart';
import 'inbox_scheduled_test.dart' show pumpInbox;

void main() {
  test('ObligationDto round-trips snoozedUntil and omits it when unset', () {
    final dto = ObligationDto.fromJson({
      'id': 'ob-1',
      'ownerId': 'actor-a',
      'status': 'ready',
      'effectivePriority': 100.0,
      'snoozedUntil': '2026-09-28T09:00:00.000Z',
    });
    expect(dto.snoozedUntil, '2026-09-28T09:00:00.000Z');
    expect(dto.isSnoozed, isTrue);
    expect(dto.toJson()['snoozedUntil'], '2026-09-28T09:00:00.000Z');

    final plain = ObligationDto.fromJson({
      'id': 'ob-2',
      'ownerId': 'actor-a',
      'status': 'ready',
      'effectivePriority': 100.0,
    });
    expect(plain.isSnoozed, isFalse);
    expect(plain.toJson().containsKey('snoozedUntil'), isFalse);
  });

  test('snoozeLabel reads as a deliberate deferral and names parent blocking', () {
    final until = DateTime.now()
        .toUtc()
        .add(const Duration(hours: 3))
        .toIso8601String();
    final root = makeObligation('ob-root', snoozedUntil: until);
    final child = makeObligation(
      'ob-child',
      parentId: 'ob-root',
      snoozedUntil: until,
    );
    expect(snoozeLabel(root), startsWith('Intentionally deferred until '));
    expect(snoozeLabel(root), isNot(contains('still blocks its parent')));
    expect(snoozeLabel(child), endsWith('; still blocks its parent'));
  });

  testWidgets(
    'Inbox shows a snoozed row as deferred and a snoozed blocker with its deadline',
    (tester) async {
      final until = DateTime.now()
          .toUtc()
          .add(const Duration(days: 2))
          .toIso8601String();
      final snoozedReady = makeObligation(
        'ob-snoozed',
        ownerId: 'actor-a',
        intent: 'Deferred review',
        snoozedUntil: until,
      );
      final parent = makeObligation(
        'ob-parent',
        ownerId: 'actor-a',
        intent: 'Ship release',
        status: 'waiting',
      );
      final snoozedChild = makeObligation(
        'ob-child',
        parentId: 'ob-parent',
        ownerId: 'human:operator',
        intent: 'Approve release notes',
        snoozedUntil: until,
      );

      final api = FakeApi()
        ..obligationsResult = [snoozedReady, parent, snoozedChild]
        ..inboxResultsByStatus['unhandled'] = {'entries': []}
        ..inboxResultsByStatus['handled'] = {'entries': []};
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        quotaCache: FakeQuotaCache(),
        treePreferencesCache: FakeTreePreferencesCache(),
      );

      await pumpInbox(tester, store);

      expect(find.textContaining('Intentionally deferred until'), findsOneWidget);
      expect(
        find.textContaining('Approve release notes'),
        findsWidgets,
      );
      expect(find.textContaining('— snoozed until '), findsOneWidget);
    },
  );
}
