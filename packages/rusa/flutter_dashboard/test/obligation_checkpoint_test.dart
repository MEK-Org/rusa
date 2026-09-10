import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/obligation_card.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

/// The owner-rewritten standing an arc obligation carries: where the work is
/// now, not how it got there.
const standing =
    'head 8bdc01d; migration 0043 in flight; CI green; next: operator schema approval';

void main() {
  group('ObligationDto checkpoint', () {
    test('reads the standing and its stamp off the wire', () {
      final dto = ObligationDto.fromJson({
        'id': 'arc',
        'ownerId': 'actor-a',
        'status': 'waiting',
        'effectivePriority': 1.0,
        'checkpoint': standing,
        'checkpointAt': '2026-09-07T11:00:00.000Z',
        'checkpointBy': 'actor-a',
      });

      expect(dto.checkpoint, standing);
      expect(dto.checkpointAt, '2026-09-07T11:00:00.000Z');
      expect(dto.checkpointBy, 'actor-a');
      expect(dto.hasCheckpoint, isTrue);
    });

    test('an obligation with no standing recorded has none to render', () {
      final dto = ObligationDto.fromJson({
        'id': 'arc',
        'ownerId': 'actor-a',
        'status': 'ready',
        'effectivePriority': 1.0,
      });

      expect(dto.checkpoint, isNull);
      expect(dto.hasCheckpoint, isFalse);
    });
  });

  group('checkpointStampLabel', () {
    test('resolves the author to a handle and the time to local wall clock', () {
      final ob = makeObligation(
        'arc',
        checkpoint: standing,
        checkpointBy: 'actor-a',
        checkpointAt: '2026-09-07T11:00:00.000Z',
      );

      final label = checkpointStampLabel(ob, (id) => 'steward-handle');

      expect(label, startsWith('steward-handle · '));
      // Never the raw id: the same rule every other identity line follows.
      expect(label, isNot(contains('actor-a')));
    });

    test('says Operator for a human author', () {
      final ob = makeObligation(
        'arc',
        checkpoint: standing,
        checkpointBy: 'human:operator',
      );

      expect(checkpointStampLabel(ob, (id) => null), startsWith('Operator · '));
    });
  });

  testWidgets('the obligation card renders the standing under the title', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final store = DashboardStore(api: FakeApi(), stream: FakeStream());
      await store.init();

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ObligationRow(
              obligation: makeObligation(
                'arc',
                intent: 'Persistence arc',
                checkpoint: standing,
                checkpointBy: 'actor-a',
              ),
              store: store,
            ),
          ),
        ),
      );
      await tester.pump();

      expect(find.text('Standing'), findsOneWidget);
      expect(find.text(standing), findsOneWidget);

      await store.dispose();
    });
  });

  testWidgets('a card with no standing shows no standing panel', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final store = DashboardStore(api: FakeApi(), stream: FakeStream());
      await store.init();

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ObligationRow(
              obligation: makeObligation('arc', intent: 'Persistence arc'),
              store: store,
            ),
          ),
        ),
      );
      await tester.pump();

      expect(find.text('Standing'), findsNothing);

      await store.dispose();
    });
  });

  testWidgets('the work tree shows standing on the node, and the detail view stamps it', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [makeThread('root')]
        ..obligationsResult = [
          makeObligation(
            'arc',
            ownerId: 'root',
            intent: 'Persistence arc',
            status: 'waiting',
            checkpoint: standing,
            checkpointBy: 'root',
          ),
        ];

      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: WorkTab(store: store, onSelectView: (_) {})),
        ),
      );
      await tester.pump();
      await tester.pump();

      // The tree is an index: one line of standing beside the heading, so an
      // arc can be scanned without opening every node.
      expect(find.text(standing), findsOneWidget);

      await tester.tap(find.text('Persistence arc'));
      await tester.pump();
      await tester.pump();

      // Opened, the same standing carries its author and time.
      expect(find.text('Standing'), findsOneWidget);
      expect(find.textContaining('root-handle · '), findsOneWidget);

      await store.dispose();
    });
  });

  testWidgets('a mounted Work tab reloads when a checkpoint rewrite arrives', (
    tester,
  ) async {
    await tester.runAsync(() async {
      const oldStanding =
          'head 0f8372e; review in flight; next: answer questions';
      const newStanding = 'head 71d5bca; amendment pushed; next: wait for CI';
      final api = FakeApi()
        ..threadsResult = [makeThread('root')]
        ..obligationsResult = [
          makeObligation(
            'arc',
            ownerId: 'root',
            intent: 'Persistence arc',
            checkpoint: oldStanding,
            checkpointBy: 'root',
          ),
        ];
      final stream = FakeStream();
      final store = DashboardStore(api: api, stream: stream);
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
      expect(find.text(oldStanding), findsOneWidget);

      api.obligationsResult = [
        makeObligation(
          'arc',
          ownerId: 'root',
          intent: 'Persistence arc',
          checkpoint: newStanding,
          checkpointBy: 'root',
        ),
      ];
      stream.meshCtrl.add(
        const MeshEvent(
          id: 'checkpoint-rewrite',
          ts: '2026-09-07T12:30:00.000Z',
          kind: 'obligation_checkpoint_set',
          actorId: 'root',
          detail: 'arc',
          body: null,
          payload: '{"cleared":false}',
          success: null,
        ),
      );
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 10));
      }

      expect(api.fetchObligationForestCalls, hasLength(2));
      expect(find.text(newStanding), findsOneWidget);
      expect(find.text(oldStanding), findsNothing);

      await store.dispose();
    });
  });

  testWidgets(
    'a mounted Work tab refreshes the open detail view on checkpoint rewrite without losing completion paging state',
    (tester) async {
      await tester.runAsync(() async {
        await tester.binding.setSurfaceSize(const Size(1200, 1600));
        addTearDown(() => tester.binding.setSurfaceSize(null));

        const oldStanding =
            'head 0f8372e; review in flight; next: answer questions';
        const newStanding =
            'head 71d5bca; amendment pushed; next: wait for CI';
        final initialOb = makeObligation(
          'arc',
          ownerId: 'root',
          intent: 'Persistence arc',
          status: 'ready',
          checkpoint: oldStanding,
          checkpointBy: 'root',
          checkpointAt: '2026-09-07T11:00:00.000Z',
          recurrencePolicy: 'cron',
          recurrenceCron: '0 3 * * *',
        );

        final page3 = ObligationCompletionDto(
          id: 'c-3',
          obligationId: 'arc',
          sequence: 3,
          completedAt: '2026-09-02T03:00:00.000Z',
          note: 'ran clean cycle 3',
          resolutionRef: 'run:job-43',
        );
        final page2 = ObligationCompletionDto(
          id: 'c-2',
          obligationId: 'arc',
          sequence: 2,
          completedAt: '2026-09-01T03:00:00.000Z',
          note: 'ran clean',
          resolutionRef: 'run:job-42',
        );
        final page1 = ObligationCompletionDto(
          id: 'c-1',
          obligationId: 'arc',
          sequence: 1,
          completedAt: '2026-08-31T03:00:00.000Z',
          resolutionRef: 'run:job-41',
        );

        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [initialOb];

        api.obligationDetailByOffset = (id, offset) {
          final ob = api.obligationsResult.firstWhere(
            (o) => o.id == id,
            orElse: () => makeObligation(id),
          );
          final completions = (offset ?? 0) == 0 ? [page2] : [page1];
          return ObligationDetailSnapshot(
            obligation: ob,
            children: const [],
            blockingChildren: const [],
            completions: completions,
            completionsTotal: 2,
            completionsHasMore: (offset ?? 0) == 0,
          );
        };

        final stream = FakeStream();
        final store = DashboardStore(api: api, stream: stream);
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

        // Open the detail view for 'arc'
        await tester.tap(find.text('Persistence arc'));
        await tester.pump();
        await tester.pump();

        // Standing is visible in both the sidebar tree node and the detail view
        expect(find.text(oldStanding), findsNWidgets(2));
        expect(find.text('Standing'), findsOneWidget);

        // Page the completion history so earlier completions are loaded
        expect(find.textContaining('Cycle 2'), findsOneWidget);
        expect(find.textContaining('Cycle 1'), findsNothing);
        expect(
          find.textContaining('Load earlier completions (1 remaining)'),
          findsOneWidget,
        );

        await tester.ensureVisible(
          find.textContaining('Load earlier completions'),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.textContaining('Load earlier completions'));
        await tester.pump();
        await tester.pump();

        // Both cycles are now loaded and paging controls cleared
        expect(find.textContaining('Cycle 2'), findsOneWidget);
        expect(find.textContaining('Cycle 1'), findsOneWidget);
        expect(find.textContaining('Load earlier completions'), findsNothing);

        // Upstream completes a new cycle (c-3 at sequence 3) and rewrites the
        // obligation's checkpoint
        api.obligationsResult = [
          makeObligation(
            'arc',
            ownerId: 'root',
            intent: 'Persistence arc',
            status: 'ready',
            checkpoint: newStanding,
            checkpointBy: 'root',
            checkpointAt: '2026-09-07T12:30:00.000Z',
            recurrencePolicy: 'cron',
            recurrenceCron: '0 3 * * *',
          ),
        ];

        // The DB returns completions in descending sequence order (newest first):
        // offset 0 now returns c-3 (seq 3), offset 1 returns c-2 (seq 2),
        // and offset 2 returns c-1 (seq 1). Total is 3.
        api.obligationDetailByOffset = (id, offset) {
          final ob = api.obligationsResult.firstWhere(
            (o) => o.id == id,
            orElse: () => makeObligation(id),
          );
          final completions = switch (offset ?? 0) {
            0 => [page3],
            1 => [page2],
            _ => [page1],
          };
          return ObligationDetailSnapshot(
            obligation: ob,
            children: const [],
            blockingChildren: const [],
            completions: completions,
            completionsTotal: 3,
            completionsHasMore: (offset ?? 0) < 2,
          );
        };

        // An invalidation event arrives for an unrelated obligation; the open
        // detail view for 'arc' ignores it and does not refetch.
        stream.meshCtrl.add(
          const MeshEvent(
            id: 'unrelated-checkpoint',
            ts: '2026-09-07T12:20:00.000Z',
            kind: 'obligation_checkpoint_set',
            actorId: 'root',
            detail: 'other-arc',
            body: null,
            payload: '{"cleared":false}',
            success: null,
          ),
        );
        for (var i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 10));
        }

        // The detail view for 'arc' still displays the unrefreshed standing and cycles
        expect(find.text(oldStanding), findsOneWidget);
        expect(find.textContaining('Cycle 3'), findsNothing);

        // Now the targeted invalidation event arrives for 'arc'
        stream.meshCtrl.add(
          const MeshEvent(
            id: 'checkpoint-rewrite',
            ts: '2026-09-07T12:30:00.000Z',
            kind: 'obligation_checkpoint_set',
            actorId: 'root',
            detail: 'arc',
            body: null,
            payload: '{"cleared":false}',
            success: null,
          ),
        );
        for (var i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 10));
        }

        // The old standing is completely gone
        expect(find.text(oldStanding), findsNothing);

        // Both the tree node and the open detail view reflect the new standing
        expect(find.text(newStanding), findsNWidgets(2));
        expect(find.text('Standing'), findsOneWidget);

        // Completion paging state is preserved by stable identity and descending
        // sequence order: newly arrived Cycle 3, previously loaded Cycle 2, and
        // paged Cycle 1 are all visible without dropping rows or duplicating loads.
        expect(find.textContaining('Cycle 3'), findsOneWidget);
        expect(find.textContaining('Cycle 2'), findsOneWidget);
        expect(find.textContaining('Cycle 1'), findsOneWidget);
        expect(find.textContaining('Load earlier completions'), findsNothing);

        await store.dispose();
      });
    },
  );

  group('mergeCompletions', () {
    test('preserves descending sequence order and prevents seam row dropping', () {
      final existing = [
        ObligationCompletionDto(
          id: 'c-2',
          obligationId: 'ob-1',
          sequence: 2,
          completedAt: '2026-09-01T00:00:00.000Z',
        ),
        ObligationCompletionDto(
          id: 'c-1',
          obligationId: 'ob-1',
          sequence: 1,
          completedAt: '2026-08-31T00:00:00.000Z',
        ),
      ];
      final incoming = [
        ObligationCompletionDto(
          id: 'c-3',
          obligationId: 'ob-1',
          sequence: 3,
          completedAt: '2026-09-02T00:00:00.000Z',
        ),
      ];

      final merged = mergeCompletions(incoming, existing);

      expect(merged.map((c) => c.sequence).toList(), [3, 2, 1]);
      expect(merged.map((c) => c.id).toList(), ['c-3', 'c-2', 'c-1']);
    });

    test('deduplicates by ID and prefers incoming updates', () {
      final existing = [
        ObligationCompletionDto(
          id: 'c-1',
          obligationId: 'ob-1',
          sequence: 1,
          completedAt: '2026-08-31T00:00:00.000Z',
          note: 'original note',
        ),
      ];
      final incoming = [
        ObligationCompletionDto(
          id: 'c-1',
          obligationId: 'ob-1',
          sequence: 1,
          completedAt: '2026-08-31T00:00:00.000Z',
          note: 'updated note',
        ),
      ];

      final merged = mergeCompletions(incoming, existing);

      expect(merged, hasLength(1));
      expect(merged.first.note, 'updated note');
    });
  });
}
