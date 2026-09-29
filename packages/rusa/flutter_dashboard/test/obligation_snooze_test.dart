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

  test('ObligationDto considers a snoozed obligation as waiting', () {
    final snoozed = makeObligation(
      'ob-snoozed',
      status: 'ready',
      snoozedUntil: '2026-09-30T00:00:00.000Z',
    );
    expect(snoozed.isReady, isFalse);
    expect(snoozed.isWaiting, isTrue);
    expect(snoozed.isScheduled, isFalse);
    expect(
      snoozed.presentationState(activelyWorked: false),
      ObligationPresentationState.waiting,
    );
    expect(
      snoozed.presentationState(activelyWorked: true),
      ObligationPresentationState.waiting,
    );

    final snoozedScheduled = makeObligation(
      'ob-snoozed-sched',
      status: 'scheduled',
      snoozedUntil: '2026-09-30T00:00:00.000Z',
    );
    expect(snoozedScheduled.isReady, isFalse);
    expect(snoozedScheduled.isWaiting, isTrue);
    expect(snoozedScheduled.isScheduled, isFalse);
    expect(
      snoozedScheduled.presentationState(activelyWorked: false),
      ObligationPresentationState.waiting,
    );

    final plainReady = makeObligation('ob-ready', status: 'ready');
    expect(plainReady.isReady, isTrue);
    expect(plainReady.isWaiting, isFalse);
    expect(
      plainReady.presentationState(activelyWorked: false),
      ObligationPresentationState.ready,
    );
    expect(
      plainReady.presentationState(activelyWorked: true),
      ObligationPresentationState.active,
    );
  });

  testWidgets(
    'Inbox moves a snoozed obligation down to the waiting obligations section',
    (tester) async {
      final until = DateTime.now()
          .toUtc()
          .add(const Duration(days: 2))
          .toIso8601String();
      final activeReady = makeObligation(
        'ob-active-ready',
        ownerId: 'actor-a',
        intent: 'Active ready work',
        status: 'ready',
      );
      final snoozedReady = makeObligation(
        'ob-snoozed',
        ownerId: 'actor-a',
        intent: 'Deferred review',
        status: 'ready',
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
        ..obligationsResult = [activeReady, snoozedReady, parent, snoozedChild]
        ..inboxResultsByStatus['unhandled'] = {'entries': []}
        ..inboxResultsByStatus['handled'] = {'entries': []};
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        quotaCache: FakeQuotaCache(),
        treePreferencesCache: FakeTreePreferencesCache(),
      );

      await pumpInbox(tester, store);

      // Ready Obligations section has only the active ready work.
      expect(find.text('Ready Obligations'), findsOneWidget);
      expect(find.text('1 ready'), findsOneWidget);

      // Waiting Obligations section includes both the snoozed obligation and the parent.
      expect(find.text('Waiting Obligations'), findsOneWidget);
      expect(find.text('2 waiting'), findsOneWidget);

      expect(find.textContaining('Intentionally deferred until'), findsOneWidget);
      expect(
        find.textContaining('Approve release notes'),
        findsWidgets,
      );
      expect(find.textContaining('— snoozed until '), findsOneWidget);
    },
  );

  testWidgets(
    'Inbox pages each section on its own, so snoozed rows crowd out none',
    (tester) async {
      final until = DateTime.now()
          .toUtc()
          .add(const Duration(days: 2))
          .toIso8601String();
      // Server queue order: a full page of actionable ready rows, then a full
      // page of snoozed scheduled rows (waiting group), then one unsnoozed
      // scheduled row.
      final api = FakeApi()
        ..obligationPageLimit = 50
        ..obligationsResult = [
          for (var i = 0; i < 50; i++)
            makeObligation('ob-ready-$i', ownerId: 'actor-a', status: 'ready'),
          for (var i = 0; i < 50; i++)
            makeObligation(
              'ob-snoozed-$i',
              ownerId: 'actor-a',
              status: 'scheduled',
              snoozedUntil: until,
            ),
          makeObligation(
            'ob-scheduled',
            ownerId: 'actor-a',
            intent: 'Nightly digest',
            status: 'scheduled',
            nextReadyAt: '2026-10-01T06:00:00.000Z',
          ),
        ]
        ..inboxResultsByStatus['unhandled'] = {'entries': []}
        ..inboxResultsByStatus['handled'] = {'entries': []};
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        quotaCache: FakeQuotaCache(),
        treePreferencesCache: FakeTreePreferencesCache(),
      );

      await pumpInbox(tester, store);

      expect(find.text('50 ready'), findsOneWidget);
      expect(find.text('50 waiting'), findsOneWidget);
      expect(find.text('1 scheduled'), findsOneWidget);
    },
  );
}
