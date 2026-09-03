import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

void main() {
  testWidgets(
    'shows retained completion history after recurrence has been disabled',
    (tester) async {
      await tester.runAsync(() async {
        final completedOb = makeObligation(
          'ob-retained-ledger',
          ownerId: 'root',
          intent: 'Formerly recurring work',
          status: 'done',
          hasCompletionHistory: true,
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [completedOb]
          ..obligationDetailByOffset = (_, _) => ObligationDetailSnapshot(
            obligation: completedOb,
            children: const [],
            blockingChildren: const [],
            completions: [
              ObligationCompletionDto(
                id: 'c-retained',
                obligationId: completedOb.id,
                sequence: 1,
                completedAt: '2026-09-01T03:00:00.000Z',
                note: 'kept for audit',
              ),
            ],
            completionsTotal: 1,
            completionsHasMore: false,
          );

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
        await tester.tap(find.text('Formerly recurring work'));
        await tester.pump();
        await tester.pump();

        expect(find.text('COMPLETION HISTORY'), findsOneWidget);
        expect(find.textContaining('Cycle 1'), findsOneWidget);
        await store.dispose();
      });
    },
  );

  testWidgets(
    '"Load earlier completions" extends the visible history instead of replacing it, and renders resolutionRef',
    (tester) async {
      await tester.runAsync(() async {
        final recurringOb = makeObligation(
          'ob-recurring',
          ownerId: 'root',
          intent: 'Nightly backup',
          status: 'ready',
          recurrencePolicy: 'cron',
          recurrenceCron: '0 3 * * *',
        );

        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [recurringOb];

        // Two pages of completion history: the first (most recent) page
        // returned at offset 0, the second (earlier) page returned once
        // "Load earlier completions" requests offset 1.
        final page1 = ObligationCompletionDto(
          id: 'c-2',
          obligationId: 'ob-recurring',
          sequence: 2,
          completedAt: '2026-09-01T03:00:00.000Z',
          note: 'ran clean',
          resolutionRef: 'run:job-42',
        );
        final page2 = ObligationCompletionDto(
          id: 'c-1',
          obligationId: 'ob-recurring',
          sequence: 1,
          completedAt: '2026-08-31T03:00:00.000Z',
          resolutionRef: 'run:job-41',
        );

        api.obligationDetailByOffset = (id, offset) {
          final completions = (offset ?? 0) == 0 ? [page1] : [page2];
          return ObligationDetailSnapshot(
            obligation: recurringOb,
            children: const [],
            blockingChildren: const [],
            completions: completions,
            completionsTotal: 2,
            completionsHasMore: (offset ?? 0) == 0,
          );
        };

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

        await tester.tap(find.text('Nightly backup'));
        await tester.pump();
        await tester.pump();

        // First page: most recent cycle plus its resolutionRef, "Load
        // earlier" offered for the one remaining cycle.
        expect(find.textContaining('Cycle 2'), findsOneWidget);
        expect(find.text('run:job-42'), findsOneWidget);
        expect(
          find.textContaining('Load earlier completions (1 remaining)'),
          findsOneWidget,
        );
        expect(find.textContaining('Cycle 1'), findsNothing);

        await tester.tap(find.textContaining('Load earlier completions'));
        await tester.pump();
        await tester.pump();

        // Both cycles are now visible together — the second page extended
        // the list rather than replacing the first page's row.
        expect(find.textContaining('Cycle 2'), findsOneWidget);
        expect(find.text('run:job-42'), findsOneWidget);
        expect(find.textContaining('Cycle 1'), findsOneWidget);
        expect(find.text('run:job-41'), findsOneWidget);
        expect(find.textContaining('Load earlier completions'), findsNothing);

        await store.dispose();
      });
    },
  );
}
