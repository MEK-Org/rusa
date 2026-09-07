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
}
