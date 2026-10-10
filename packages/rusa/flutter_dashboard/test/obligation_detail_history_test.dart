import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';
import 'fakes.dart';

void main() {
  testWidgets(
    'history retries earlier pages and keeps them across standing refresh',
    (tester) async {
      await tester.runAsync(() async {
        await tester.binding.setSurfaceSize(const Size(1600, 1600));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final ob = makeObligation(
          'detail',
          ownerId: 'root',
          title: 'History detail',
        );
        var failEarlier = true;
        var refreshed = false;
        ObligationHistoryDto entry(String id, String text, String time) =>
            ObligationHistoryDto(
              id: id,
              kind: 'checkpoint',
              by: 'root',
              timestamp: time,
              after: {'checkpoint': text},
            );
        final newest = entry(
          'history:0002',
          'Newest standing',
          '2026-10-03T12:00:00Z',
        );
        final earlier = entry(
          'history:0001',
          'Earlier standing',
          '2026-10-03T11:00:00Z',
        );
        final added = entry(
          'history:0003',
          'Refreshed standing',
          '2026-10-03T13:00:00Z',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [ob]
          ..obligationDetailByHistory = (id, before) {
            if (before != null && failEarlier) {
              throw StateError('synthetic unavailable');
            }
            return ObligationDetailSnapshot(
              obligation: ob,
              children: const [],
              blockingChildren: const [],
              history: before != null
                  ? [earlier]
                  : [if (refreshed) added, newest],
              historyNextBefore: before == null
                  ? '2026-10-03T12:00:00Z|history:0002'
                  : null,
            );
          };
        final stream = FakeStream();
        final store = DashboardStore(api: api, stream: stream);
        await store.init();
        addTearDown(store.dispose);
        store.setFocusedObligationId('detail');
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: WorkTab(store: store, onSelectView: (_) {}),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Newest standing'), findsOneWidget);
        await tester.tap(find.text('Show more updates'));
        await tester.pumpAndSettle();
        expect(
          find.text('Earlier history unavailable. Try again.'),
          findsOneWidget,
        );
        expect(find.text('Newest standing'), findsOneWidget);
        failEarlier = false;
        await tester.tap(find.text('Show more updates'));
        await tester.pumpAndSettle();
        expect(find.text('Earlier standing'), findsOneWidget);
        expect(find.text('Show more updates'), findsNothing);
        refreshed = true;
        stream.meshCtrl.add(
          const MeshEvent(
            id: 'refresh',
            actorId: 'root',
            kind: 'obligation_checkpoint_set',
            ts: '2026-10-03T13:00:00Z',
            detail: 'detail',
            body: null,
            payload: '{}',
            success: null,
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Refreshed standing'), findsOneWidget);
        expect(find.text('Newest standing'), findsOneWidget);
        expect(find.text('Earlier standing'), findsOneWidget);
        expect(find.text('Show more updates'), findsNothing);
      });
    },
  );

  testWidgets('history labels explicit responsive marks and removals (#903)', (
    tester,
  ) async {
    await tester.runAsync(() async {
      await tester.binding.setSurfaceSize(const Size(1600, 1600));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final ob = makeObligation('detail', ownerId: 'root', title: 'Responsive');
      final api = FakeApi()
        ..threadsResult = [makeThread('root')]
        ..obligationsResult = [ob]
        ..obligationDetailByHistory = (id, before) => ObligationDetailSnapshot(
          obligation: ob,
          children: const [],
          blockingChildren: const [],
          history: const [
            ObligationHistoryDto(
              id: 'history:0002',
              kind: 'responsive',
              by: 'root',
              timestamp: '2026-10-03T12:00:00Z',
              before: {'responsive': true},
              after: {'responsive': null},
            ),
            ObligationHistoryDto(
              id: 'history:0001',
              kind: 'responsive',
              by: 'root',
              timestamp: '2026-10-03T11:00:00Z',
              before: {'responsive': null},
              after: {'responsive': true},
            ),
          ],
        );
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      addTearDown(store.dispose);
      store.setFocusedObligationId('detail');
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: WorkTab(store: store, onSelectView: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining(' marked responsive · '), findsOneWidget);
      expect(find.textContaining(' cleared responsive · '), findsOneWidget);
      expect(find.textContaining('updated obligation'), findsNothing);
    });
  });
}
