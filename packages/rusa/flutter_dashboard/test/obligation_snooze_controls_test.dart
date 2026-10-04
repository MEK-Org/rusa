// Dashboard snooze controls (#893): presets, the custom date/time picker,
// replacing and clearing, refusals, warnings and refresh, over the existing
// owner-only snooze endpoint.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/obligation_card.dart';
import 'package:rusa_dashboard/widgets/obligation_snooze.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

void main() {
  group('snooze deadlines', () {
    test('hour, day and week are fixed durations from the given time', () {
      final from = DateTime(2026, 10, 4, 13, 5, 7);
      expect(
        snoozePresetDeadline(SnoozePreset.hour, from),
        DateTime(2026, 10, 4, 14, 5, 7),
      );
      expect(
        snoozePresetDeadline(SnoozePreset.day, from),
        from.add(const Duration(hours: 24)),
      );
      expect(
        snoozePresetDeadline(SnoozePreset.week, from),
        from.add(const Duration(days: 7)),
      );
    });

    test('a month is one calendar month, clamped to the last day', () {
      expect(
        snoozePresetDeadline(SnoozePreset.month, DateTime(2026, 10, 4, 13, 5)),
        DateTime(2026, 11, 4, 13, 5),
      );
      expect(
        addCalendarMonth(DateTime(2027, 1, 31, 9, 30)),
        DateTime(2027, 2, 28, 9, 30),
      );
      expect(
        addCalendarMonth(DateTime(2028, 1, 31, 9, 30)),
        DateTime(2028, 2, 29, 9, 30),
      );
      expect(addCalendarMonth(DateTime(2026, 3, 31)), DateTime(2026, 4, 30));
      expect(
        addCalendarMonth(DateTime(2026, 12, 15, 8)),
        DateTime(2027, 1, 15, 8),
      );
      final utc = addCalendarMonth(DateTime.utc(2026, 8, 31, 23, 59));
      expect(utc, DateTime.utc(2026, 9, 30, 23, 59));
      expect(utc.isUtc, isTrue);
    });
  });

  group('DashboardApi.setObligationSnooze', () {
    test(
      'sends a UTC deadline with its Z offset and returns the warning',
      () async {
        final client = MockClient((req) async {
          expect(req.method, 'POST');
          expect(req.url.path, '/api/mesh/obligations/ob-1/snooze');
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          expect(body.keys, ['until']);
          expect(body['until'], '2026-10-05T12:30:00.000Z');
          return http.Response(
            jsonEncode({
              'ok': true,
              'obligation': makeObligation(
                'ob-1',
                snoozedUntil: '2026-10-05T12:30:00.000Z',
              ).toJson(),
              'warning':
                  'snooze saved, but its wake timer could not be armed (x)',
            }),
            200,
          );
        });
        final api = DashboardApi(
          client: client,
          base: Uri.parse('http://localhost:3000'),
        );
        final result = await api.setObligationSnooze(
          'ob-1',
          DateTime.utc(2026, 10, 5, 12, 30),
        );
        expect(result.obligation.snoozedUntil, '2026-10-05T12:30:00.000Z');
        expect(result.warning, contains('could not be armed'));
      },
    );

    test('clears with an explicit null and surfaces a refusal', () async {
      final bodies = <Object?>[];
      final client = MockClient((req) async {
        bodies.add(jsonDecode(req.body));
        if (bodies.length == 1) {
          return http.Response(
            jsonEncode({
              'ok': true,
              'obligation': makeObligation('ob-1').toJson(),
            }),
            200,
          );
        }
        return http.Response(
          jsonEncode({
            'error':
                "only the obligation's current owner may snooze or unsnooze it",
          }),
          403,
        );
      });
      final api = DashboardApi(
        client: client,
        base: Uri.parse('http://localhost:3000'),
      );
      final cleared = await api.setObligationSnooze('ob-1', null);
      expect(cleared.obligation.snoozedUntil, isNull);
      expect(cleared.warning, isNull);
      expect(bodies.single, {'until': null});
      await expectLater(
        api.setObligationSnooze('ob-1', DateTime.utc(2030)),
        throwsA(
          isA<DashboardApiException>().having((e) => e.status, 'status', 403),
        ),
      );
    });
  });

  group('who is offered Snooze', () {
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

    Future<List<String>> menuLabels(
      WidgetTester tester,
      ObligationDto ob,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ObligationRow(obligation: ob, store: store),
          ),
        ),
      );
      await tester.tap(find.byTooltip('Obligation Actions'));
      await tester.pumpAndSettle();
      final labels = tester
          .widgetList<Text>(
            find.descendant(
              of: find.byType(PopupMenuItem<String>),
              matching: find.byType(Text),
            ),
          )
          .map((t) => t.data ?? '')
          .toList();
      await tester.tapAt(Offset.zero);
      await tester.pumpAndSettle();
      return labels;
    }

    testWidgets('the viewer\'s own rows, under either id, beside Done/Cancel', (
      tester,
    ) async {
      api.dashboardConfigResult = const DashboardConfigDto(
        quotaProviders: {},
        userPrincipalId: 'user-1',
      );
      await store.refreshDashboardConfig();

      expect(
        await menuLabels(tester, makeObligation('mine', ownerId: 'user-1')),
        ['Mark Done', 'Cancel', 'Snooze...', 'Reparent...', 'Add Child...'],
      );
      // A row still owned by the legacy alias is the viewer's; the server
      // resolves the alias the same way.
      expect(
        await menuLabels(
          tester,
          makeObligation('legacy', ownerId: 'human:operator'),
        ),
        contains('Snooze...'),
      );
      expect(
        await menuLabels(
          tester,
          makeObligation(
            'snoozed',
            ownerId: 'user-1',
            snoozedUntil: '2030-01-01T00:00:00.000Z',
          ),
        ),
        contains('Change Snooze...'),
      );
    });

    testWidgets('never on an actor-owned or another human\'s row', (
      tester,
    ) async {
      api.dashboardConfigResult = const DashboardConfigDto(
        quotaProviders: {},
        userPrincipalId: 'user-1',
      );
      await store.refreshDashboardConfig();

      final actorRow = await menuLabels(
        tester,
        makeObligation('theirs', ownerId: 'worker'),
      );
      expect(actorRow, containsAll(['Cancel', 'Reparent...']));
      expect(actorRow.where((l) => l.contains('Snooze')), isEmpty);
      final otherHuman = await menuLabels(
        tester,
        makeObligation('other', ownerId: 'human:someone'),
      );
      expect(otherHuman.where((l) => l.contains('Snooze')), isEmpty);
      expect(
        canSnoozeObligation(
          store,
          makeObligation('done', ownerId: 'user-1', status: 'done'),
        ),
        isFalse,
      );
    });
  });

  group('WorkTab detail header', () {
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

    Future<void> openDetail(WidgetTester tester, String title) async {
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
      await tester.tap(find.text(title).first);
      await tester.pumpAndSettle();
    }

    testWidgets(
      'snoozes from a preset, reports the saved deadline and refreshes',
      (tester) async {
        api.obligationsResult = [
          makeObligation(
            'ob-mine',
            ownerId: 'human:operator',
            intent: 'My Task',
          ),
        ];
        await openDetail(tester, 'My Task');

        expect(find.byTooltip('Mark Done'), findsOneWidget);
        expect(find.byTooltip('Cancel Obligation'), findsOneWidget);
        expect(find.byTooltip('Snooze'), findsOneWidget);
        final fetchesBefore = api.obligationDetailCallCount;

        await tester.tap(find.byTooltip('Snooze'));
        await tester.pumpAndSettle();
        expect(find.text('Snooze obligation'), findsOneWidget);
        expect(find.text('Not snoozed.'), findsOneWidget);
        expect(find.text('Clear snooze'), findsNothing);

        final before = DateTime.now();
        await tester.tap(find.byKey(const ValueKey('snooze-option-day')));
        await tester.pumpAndSettle();
        final after = DateTime.now();

        final call = api.snoozeCalls.single;
        expect(call.id, 'ob-mine');
        expect(
          call.until!.isBefore(before.add(const Duration(days: 1))),
          isFalse,
        );
        expect(
          call.until!.isAfter(after.add(const Duration(days: 1))),
          isFalse,
        );
        expect(find.textContaining('Snoozed until '), findsWidgets);
        // The pane refetched and now shows the persisted snooze.
        expect(api.obligationDetailCallCount, greaterThan(fetchesBefore));
        expect(find.byTooltip('Change snooze'), findsOneWidget);
      },
    );

    testWidgets('is absent on an actor-owned obligation', (tester) async {
      api.obligationsResult = [
        makeObligation('ob-actor', ownerId: 'worker', intent: 'Actor Task'),
      ];
      await openDetail(tester, 'Actor Task');
      expect(find.byTooltip('Cancel Obligation'), findsOneWidget);
      expect(find.byTooltip('Snooze'), findsNothing);
      expect(find.byTooltip('Change snooze'), findsNothing);
    });
  });

  group('snooze flow', () {
    late FakeApi api;
    late DashboardStore store;
    late DateTime clock;
    late int updates;

    setUp(() {
      api = FakeApi();
      store = DashboardStore(
        api: api,
        stream: FakeStream(),
        quotaCache: FakeQuotaCache(),
        treePreferencesCache: FakeTreePreferencesCache(),
      );
      clock = DateTime(2026, 10, 4, 10, 0);
      updates = 0;
    });

    Future<void> open(WidgetTester tester, ObligationDto ob) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showSnoozeObligationDialog(
                  context,
                  store,
                  ob,
                  onUpdated: () => updates++,
                  now: () => clock,
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
    }

    final mine = makeObligation(
      'ob-1',
      ownerId: 'human:operator',
      intent: 'Mine',
    );

    testWidgets(
      'presets are computed when chosen, not when the dialog opened',
      (tester) async {
        await open(tester, mine);
        expect(find.text('Until Wed 2026-11-04 10:00'), findsOneWidget);
        clock = DateTime(2026, 10, 4, 10, 42);
        await tester.tap(find.byKey(const ValueKey('snooze-option-month')));
        await tester.pumpAndSettle();
        expect(api.snoozeCalls.single.until, DateTime(2026, 11, 4, 10, 42));
        expect(updates, 1);
      },
    );

    testWidgets('custom date then time snoozes until that local moment', (
      tester,
    ) async {
      await open(tester, mine);
      await tester.tap(find.byKey(const ValueKey('snooze-option-custom')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('20'));
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      // Time picker starts an hour ahead of now.
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      expect(api.snoozeCalls.single.until, DateTime(2026, 10, 20, 11, 0));
      expect(
        find.textContaining('Snoozed until 2026-10-20 11:00:00'),
        findsOneWidget,
      );
      expect(updates, 1);
    });

    testWidgets('a custom time no longer in the future writes nothing', (
      tester,
    ) async {
      await open(tester, mine);
      await tester.tap(find.byKey(const ValueKey('snooze-option-custom')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('4'));
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      // 11:00 today was ahead when the pickers opened, but not any more.
      clock = DateTime(2026, 10, 4, 12, 0);
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      expect(api.snoozeCalls, isEmpty);
      expect(
        find.text(
          'Snooze not changed: Sun 2026-10-04 11:00 is not in the future.',
        ),
        findsOneWidget,
      );
      expect(updates, 0);
    });

    testWidgets('dismissing the dialog or either picker writes nothing', (
      tester,
    ) async {
      await open(tester, mine);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('snooze-option-custom')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('snooze-option-custom')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(api.snoozeCalls, isEmpty);
      expect(updates, 0);
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets('replaces an existing snooze and clears it early', (
      tester,
    ) async {
      final snoozed = makeObligation(
        'ob-1',
        ownerId: 'human:operator',
        intent: 'Mine',
        snoozedUntil: '2026-10-05T09:00:00.000Z',
      );
      api.obligationsResult = [snoozed];
      await open(tester, snoozed);
      expect(find.textContaining('A new choice replaces it.'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('snooze-option-week')));
      await tester.pumpAndSettle();
      expect(api.snoozeCalls.single.until, DateTime(2026, 10, 11, 10, 0));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Clear snooze'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Clear snooze'));
      await tester.pumpAndSettle();
      expect(api.snoozeCalls.last.until, isNull);
      // The replacement's snackbar is still showing; this one queues behind it.
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
      expect(find.text('Snooze cleared'), findsOneWidget);
      expect(updates, 2);
    });

    testWidgets('shows the server refusal and does not refresh', (
      tester,
    ) async {
      api.snoozeError = DashboardApiException(
        Uri.parse('http://localhost/api/mesh/obligations/ob-1/snooze'),
        403,
        jsonEncode({
          'error':
              "only the obligation's current owner may snooze or unsnooze it",
        }),
      );
      await open(tester, mine);
      await tester.tap(find.byKey(const ValueKey('snooze-option-hour')));
      await tester.pumpAndSettle();
      expect(api.snoozeCalls.single.until, DateTime(2026, 10, 4, 11, 0));
      expect(
        find.text(
          "Failed to snooze: only the obligation's current owner may snooze or unsnooze it",
        ),
        findsOneWidget,
      );
      expect(updates, 0);
    });

    testWidgets('reports a saved snooze whose timer did not arm', (
      tester,
    ) async {
      api.snoozeWarning =
          'snooze saved, but its wake timer could not be armed (at: not found); '
          'it is retried in-process and re-armed on restart';
      await open(tester, mine);
      await tester.tap(find.byKey(const ValueKey('snooze-option-hour')));
      await tester.pumpAndSettle();
      expect(
        find.textContaining(
          'Warning: snooze saved, but its wake timer could not be armed',
        ),
        findsOneWidget,
      );
      expect(updates, 1);
    });
  });
}
