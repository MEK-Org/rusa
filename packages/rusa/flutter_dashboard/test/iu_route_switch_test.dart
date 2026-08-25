import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/header.dart';

import 'fakes.dart';

// ISSUE_NUM: IU node and report views live under ONE top-level `IU` destination,
// switched from inside the route. These tests pin the two halves of that: the
// header carries a single IU button that stays lit for either sub-view, and the
// body carries the Nodes/Reports switch that selects between them.
//
// Same convention as widget_test.dart: the store does real async I/O and the
// dashboard runs repeating animations, so drive inside tester.runAsync and pump
// fixed durations rather than pumpAndSettle.

Future<DashboardStore> _store() async {
  final api = FakeApi()..threadsResult = [makeThread('root', created: 't0')];
  final store = DashboardStore(api: api, stream: FakeStream());
  await store.init();
  return store;
}

Widget _headerHarness({
  required DashboardStore store,
  required DashboardView selected,
  required ValueChanged<DashboardView> onSelect,
}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 1100,
      child: MeshHeader(store: store, selected: selected, onSelect: onSelect),
    ),
  ),
);

Widget _bodyHarness(DashboardStore store) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 1100,
      height: 800,
      child: DashboardBody(
        store: store,
        understandingBuilder: (_) => const Text('NODE-VIEW'),
        reportsBuilder: (_) => const Text('REPORT-VIEW'),
      ),
    ),
  ),
);

void main() {
  testWidgets('header carries one IU item, not a separate reports destination', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final store = await _store();
      await tester.pumpWidget(
        _headerHarness(
          store: store,
          selected: DashboardView.actors,
          onSelect: (_) {},
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('IU'), findsOneWidget);
      // The pre-ISSUE_NUM labels are gone: reports is no longer top-level, and the
      // IU button is labelled `IU` at every width.
      expect(find.text('IU Reports'), findsNothing);
      expect(find.text('Reports'), findsNothing);
      expect(find.text('Integrated Understanding'), findsNothing);
      expect(find.text('Understanding'), findsNothing);
      // The destinations it sits beside are untouched.
      expect(find.text('Overview'), findsOneWidget);
      expect(find.text('Actors'), findsOneWidget);

      await store.dispose();
    });
  });

  testWidgets('tapping IU while on the report sub-view keeps that sub-view', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final store = await _store();
      final selections = <DashboardView>[];
      await tester.pumpWidget(
        _headerHarness(
          store: store,
          selected: DashboardView.reports,
          onSelect: selections.add,
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));

      // The one IU button is what represents the reports sub-view now, so it
      // must still be there to tap.
      expect(find.text('IU'), findsOneWidget);
      await tester.tap(find.text('IU'));
      await tester.pump(const Duration(milliseconds: 50));

      // Not `understanding` — a tap on the already-active IU button must not
      // throw away the sub-view the user is reading.
      expect(selections, [DashboardView.reports]);

      await store.dispose();
    });
  });

  testWidgets('the IU route switches between node and report views', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final store = await _store();
      await tester.pumpWidget(_bodyHarness(store));
      await tester.pump(const Duration(milliseconds: 50));

      // Off the web the URL helper is stubbed to `overview`, so start there and
      // navigate in: neither IU sub-view is showing yet.
      expect(find.text('NODE-VIEW'), findsNothing);
      expect(find.text('REPORT-VIEW'), findsNothing);

      await tester.tap(find.text('IU'));
      await tester.pump(const Duration(milliseconds: 50));

      // Node view is the IU route's default landing sub-view.
      expect(find.text('NODE-VIEW'), findsOneWidget);
      expect(find.text('REPORT-VIEW'), findsNothing);
      // The in-route switch is present alongside it.
      expect(find.text('Nodes'), findsOneWidget);
      expect(find.text('Reports'), findsOneWidget);

      await tester.tap(find.text('Reports'));
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('REPORT-VIEW'), findsOneWidget);
      expect(find.text('NODE-VIEW'), findsNothing);
      // Still inside IU: the switch stays, and the header did not sprout a
      // second top-level destination.
      expect(find.text('Nodes'), findsOneWidget);
      expect(find.text('IU'), findsOneWidget);
      expect(find.text('IU Reports'), findsNothing);

      await tester.tap(find.text('Nodes'));
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('NODE-VIEW'), findsOneWidget);
      expect(find.text('REPORT-VIEW'), findsNothing);

      await store.dispose();
    });
  });

  testWidgets('each IU sub-view falls back to its own placeholder', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final store = await _store();
      // No builders injected — the non-web/test path. Selecting IU must still
      // render the route (switch + placeholder), not an empty pane.
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 1100,
              height: 800,
              child: DashboardBody(store: store),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));

      await tester.tap(find.text('IU'));
      await tester.pump(const Duration(milliseconds: 50));
      expect(
        find.text('Integrated Understanding view unavailable in this build.'),
        findsOneWidget,
      );

      await tester.tap(find.text('Reports'));
      await tester.pump(const Duration(milliseconds: 50));
      expect(
        find.text('IU Reports view unavailable in this build.'),
        findsOneWidget,
      );

      await store.dispose();
    });
  });
}
