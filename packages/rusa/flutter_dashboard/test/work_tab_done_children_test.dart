import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

/// The detail view's CHILDREN section hides done children by default so the
/// outstanding ones stay prominent (#396), with an explicit control to reveal
/// them. Only `done` counts as completed: a cancelled child stays listed.
void main() {
  Future<DashboardStore> pumpWorkTab(
    WidgetTester tester,
    FakeApi api, {
    required String open,
  }) async {
    // Tall enough that the CHILDREN section is laid out without scrolling.
    await tester.binding.setSurfaceSize(const Size(1200, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
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
    await tester.tap(find.text(open));
    await tester.pump();
    await tester.pump();
    expect(find.text('CHILDREN'), findsOneWidget);
    return store;
  }

  testWidgets(
    'hides only done children by default, keeping the rest in order',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [
            makeObligation('parent', intent: 'Ship the feature'),
            makeObligation(
              'c-done',
              parentId: 'parent',
              intent: 'Write the spec',
              status: 'done',
            ),
            makeObligation(
              'c-first',
              parentId: 'parent',
              intent: 'Build the thing',
            ),
            makeObligation(
              'c-cancelled',
              parentId: 'parent',
              intent: 'Abandoned approach',
              status: 'cancelled',
            ),
            // Done with ledger rows is still done: the detail view does not
            // carry the work-queue tree's completion-history exception.
            makeObligation(
              'c-ledger',
              parentId: 'parent',
              intent: 'Nightly backup',
              status: 'done',
              hasCompletionHistory: true,
            ),
            makeObligation(
              'c-second',
              parentId: 'parent',
              intent: 'Review the thing',
              status: 'waiting',
            ),
          ];
        final store = await pumpWorkTab(tester, api, open: 'Ship the feature');

        expect(find.text('Build the thing'), findsOneWidget);
        expect(find.text('Abandoned approach'), findsOneWidget);
        expect(find.text('Review the thing'), findsOneWidget);
        expect(find.text('Write the spec'), findsNothing);
        expect(find.text('Nightly backup'), findsNothing);
        // Remaining children keep the server's relative order.
        final build = tester.getTopLeft(find.text('Build the thing')).dy;
        final dropped = tester.getTopLeft(find.text('Abandoned approach')).dy;
        final review = tester.getTopLeft(find.text('Review the thing')).dy;
        expect(build, lessThan(dropped));
        expect(dropped, lessThan(review));
        expect(find.text('Show 2 done children'), findsOneWidget);
        expect(find.text('Hide done children'), findsNothing);

        await store.dispose();
      });
    },
  );

  testWidgets('the reveal control shows done children and toggles back', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [makeThread('root')]
        ..obligationsResult = [
          makeObligation('parent', intent: 'Ship the feature'),
          makeObligation(
            'c-done',
            parentId: 'parent',
            intent: 'Write the spec',
            status: 'done',
          ),
          makeObligation(
            'c-open',
            parentId: 'parent',
            intent: 'Build the thing',
          ),
        ];
      final store = await pumpWorkTab(tester, api, open: 'Ship the feature');

      await tester.tap(find.text('Show 1 done child'));
      await tester.pump();

      expect(find.text('Write the spec'), findsOneWidget);
      expect(find.text('Build the thing'), findsOneWidget);
      expect(find.text('Hide done children'), findsOneWidget);
      expect(find.text('Show 1 done child'), findsNothing);

      await tester.tap(find.text('Hide done children'));
      await tester.pump();

      expect(find.text('Write the spec'), findsNothing);
      expect(find.text('Build the thing'), findsOneWidget);
      expect(find.text('Show 1 done child'), findsOneWidget);

      await store.dispose();
    });
  });

  testWidgets(
    'says all children are done instead of calling the obligation a leaf',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [
            makeObligation('parent', intent: 'Ship the feature'),
            makeObligation(
              'c-done-1',
              parentId: 'parent',
              intent: 'Write the spec',
              status: 'done',
            ),
            makeObligation(
              'c-done-2',
              parentId: 'parent',
              intent: 'Build the thing',
              status: 'done',
            ),
          ];
        final store = await pumpWorkTab(tester, api, open: 'Ship the feature');

        expect(find.text('All 2 children are done.'), findsOneWidget);
        expect(find.textContaining('leaf node'), findsNothing);
        expect(find.text('Write the spec'), findsNothing);

        await tester.tap(find.text('Show 2 done children'));
        await tester.pump();

        expect(find.text('All 2 children are done.'), findsNothing);
        expect(find.text('Write the spec'), findsOneWidget);
        expect(find.text('Build the thing'), findsOneWidget);

        await store.dispose();
      });
    },
  );

  testWidgets('offers no reveal control when nothing is hidden', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [makeThread('root')]
        ..obligationsResult = [
          makeObligation('parent', intent: 'Ship the feature'),
          makeObligation(
            'c-open',
            parentId: 'parent',
            intent: 'Build the thing',
          ),
        ];
      final store = await pumpWorkTab(tester, api, open: 'Ship the feature');

      expect(find.text('Build the thing'), findsOneWidget);
      expect(find.textContaining('done child'), findsNothing);

      await store.dispose();
    });
  });

  testWidgets('a lone cancelled child is listed, not reported as done', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [makeThread('root')]
        ..obligationsResult = [
          makeObligation('parent', intent: 'Ship the feature'),
          makeObligation(
            'c-cancelled',
            parentId: 'parent',
            intent: 'Abandoned approach',
            status: 'cancelled',
          ),
        ];
      final store = await pumpWorkTab(tester, api, open: 'Ship the feature');

      expect(find.text('Abandoned approach'), findsOneWidget);
      expect(find.textContaining('is done'), findsNothing);
      expect(find.textContaining('done child'), findsNothing);

      await store.dispose();
    });
  });

  testWidgets('revealing done children is per obligation, not sticky', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [makeThread('root')]
        ..obligationsResult = [
          makeObligation('parent-a', intent: 'Ship the feature'),
          makeObligation(
            'a-done',
            parentId: 'parent-a',
            intent: 'Write the spec',
            status: 'done',
          ),
          makeObligation('parent-b', intent: 'Fix the bug'),
          makeObligation(
            'b-done',
            parentId: 'parent-b',
            intent: 'Reproduce it',
            status: 'done',
          ),
        ];
      final store = await pumpWorkTab(tester, api, open: 'Ship the feature');

      await tester.tap(find.text('Show 1 done child'));
      await tester.pump();
      expect(find.text('Write the spec'), findsOneWidget);

      await tester.tap(find.text('Fix the bug'));
      await tester.pump();
      await tester.pump();

      expect(find.text('Reproduce it'), findsNothing);
      expect(find.text('Show 1 done child'), findsOneWidget);

      await store.dispose();
    });
  });
}
