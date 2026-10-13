import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';
import 'fakes.dart';

ObligationHistoryDto entry(int n) => ObligationHistoryDto(
  id: 'history:${n.toString().padLeft(4, '0')}',
  kind: 'checkpoint',
  by: 'root',
  timestamp: DateTime.utc(2026, 10, 3, 0, n).toIso8601String(),
  after: {'checkpoint': 'standing $n'},
);
Future<void> showDetail(
  WidgetTester tester,
  FakeApi api, {
  FakeStream? stream,
  Size size = const Size(1600, 4000),
  DashboardStore? store,
  void Function(DashboardView)? onSelectView,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final effectiveStore =
      store ?? DashboardStore(api: api, stream: stream ?? FakeStream());
  if (store == null) {
    await effectiveStore.init();
    addTearDown(effectiveStore.dispose);
  }
  effectiveStore.setFocusedObligationId('detail');
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: WorkTab(
          store: effectiveStore,
          onSelectView: onSelectView ?? (_) {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

class MixedHistoryApi extends FakeApi {
  /// When set, the next earlier-history page waits for this before answering.
  Completer<void>? holdHistory;

  @override
  Future<ObligationDetailSnapshot> fetchObligationDetail(
    String id, {
    String? historyBefore,
    int? historyLimit,
    int? childrenOffset,
    int? blockingOffset,
    int? completionsOffset,
    int? limit,
  }) async {
    final hold = historyBefore == null ? null : holdHistory;
    holdHistory = null;
    await hold?.future;
    return _snapshot(id, historyBefore, completionsOffset);
  }

  ObligationDetailSnapshot _snapshot(
    String id,
    String? historyBefore,
    int? completionsOffset,
  ) => ObligationDetailSnapshot(
    obligation: obligationsResult.first,
    children: const [],
    blockingChildren: const [],
    history: [entry(historyBefore == null ? 4 : 2)],
    historyNextBefore: historyBefore == null ? 'earlier' : null,
    completions: [
      ObligationCompletionDto(
        id: completionsOffset == null ? 'cycle-2' : 'cycle-1',
        obligationId: id,
        sequence: completionsOffset == null ? 2 : 1,
        completedAt: entry(completionsOffset == null ? 3 : 1).timestamp,
        note: completionsOffset == null ? 'new cycle' : 'old cycle',
      ),
    ],
    completionsTotal: 2,
    completionsHasMore: completionsOffset == null,
  );
}

void main() {
  for (final updatesFirst in [true, false]) {
    testWidgets('mixed timeline stays ordered, updatesFirst=$updatesFirst', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final api = MixedHistoryApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [
            makeObligation('detail', ownerId: 'root', title: 'Mixed history'),
          ];
        await showDetail(tester, api);
        final controls = [
          'Show more updates',
          'Load earlier completions (1 remaining)',
        ];
        for (final text in updatesFirst ? controls : controls.reversed) {
          await tester.ensureVisible(find.text(text));
          await tester.tap(find.text(text));
          await tester.pumpAndSettle();
        }
        expect(find.text('Show more updates'), findsNothing);
        expect(find.textContaining('Load earlier completions'), findsNothing);
        final labels = ['standing 4', 'new cycle', 'standing 2', 'old cycle'];
        final positions = [
          for (final label in labels) tester.getTopLeft(find.text(label)).dy,
        ];
        expect(positions, orderedEquals([...positions]..sort()));
      });
    });
  }
  testWidgets('completion page during history load releases Loading…', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = MixedHistoryApi()
        ..threadsResult = [makeThread('root')]
        ..obligationsResult = [
          makeObligation('detail', ownerId: 'root', title: 'Mixed history'),
        ];
      await showDetail(tester, api);
      final hold = api.holdHistory = Completer<void>();
      await tester.ensureVisible(find.text('Show more updates'));
      await tester.tap(find.text('Show more updates'));
      await tester.pump();
      expect(find.text('Loading…'), findsOneWidget);
      final completions = find.text('Load earlier completions (1 remaining)');
      await tester.ensureVisible(completions);
      await tester.tap(completions);
      await tester.pumpAndSettle();
      hold.complete();
      await tester.pumpAndSettle();
      expect(find.text('Loading…'), findsNothing);
      await tester.ensureVisible(find.text('Show more updates'));
      await tester.tap(find.text('Show more updates'));
      await tester.pumpAndSettle();
      expect(find.text('Show more updates'), findsNothing);
      expect(find.text('standing 2'), findsOneWidget);
      expect(find.text('old cycle'), findsOneWidget);
    });
  });
  for (final exhausted in [false, true]) {
    testWidgets('refresh burst bridges history gap, exhausted=$exhausted', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final ob = makeObligation(
          'detail',
          ownerId: 'root',
          title: 'History detail',
        );
        var head = 30;
        final stream = FakeStream();
        final cursors = <String?>[];
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [ob]
          ..obligationDetailByHistory = (_, before) {
            cursors.add(before);
            final upper = before == null
                ? head
                : int.parse(before.split(':').last) - 1;
            final lower = (upper - 9).clamp(1, upper);
            return ObligationDetailSnapshot(
              obligation: ob,
              children: const [],
              blockingChildren: const [],
              history: [for (var n = upper; n >= lower; n--) entry(n)],
              historyNextBefore: lower == 1
                  ? null
                  : '${entry(lower).timestamp}|${entry(lower).id}',
            );
          };
        await showDetail(tester, api, stream: stream);
        await tester.ensureVisible(find.text('Show more updates'));
        await tester.tap(find.text('Show more updates'));
        await tester.pumpAndSettle();
        expect(find.text('standing 11'), findsOneWidget);
        if (exhausted) {
          await tester.ensureVisible(find.text('Show more updates'));
          await tester.tap(find.text('Show more updates'));
          await tester.pumpAndSettle();
          expect(find.text('standing 1'), findsOneWidget);
          expect(find.text('Show more updates'), findsNothing);
        }
        head = 41;
        stream.meshCtrl.add(
          const MeshEvent(
            id: 'refresh',
            actorId: 'root',
            kind: 'obligation_checkpoint_set',
            ts: '2026-10-03T01:00:00Z',
            detail: 'detail',
            body: null,
            payload: '{}',
            success: null,
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('standing 41'), findsOneWidget);
        expect(find.text('standing 30'), findsOneWidget);
        expect(find.text('Show more updates'), findsOneWidget);
        await tester.ensureVisible(find.text('Show more updates'));
        await tester.tap(find.text('Show more updates'));
        await tester.pumpAndSettle();
        expect(find.text('standing 31'), findsOneWidget);
        expect(cursors.last, '${entry(32).timestamp}|${entry(32).id}');
        expect(find.text('standing 30'), findsOneWidget);
        if (exhausted) expect(find.text('standing 1'), findsOneWidget);
      });
    });
  }
  for (final hasEarlier in [true, false]) {
    testWidgets('standing absence uses loaded evidence, earlier=$hasEarlier', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final ob = makeObligation(
          'detail',
          ownerId: 'root',
          title: 'Standing detail',
          checkpoint: 'current text',
          checkpointBy: 'root',
          checkpointAt: '2026-10-03T00:01:00.000Z',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [ob]
          ..obligationDetailByHistory = (_, before) => ObligationDetailSnapshot(
            obligation: ob,
            children: const [],
            blockingChildren: const [],
            history: before == null
                ? [entry(11)]
                : [
                    ObligationHistoryDto(
                      id: 'recorded',
                      kind: 'checkpoint',
                      by: 'root',
                      timestamp: ob.checkpointAt!,
                      after: {'checkpoint': ob.checkpoint},
                    ),
                  ],
            historyNextBefore: hasEarlier && before == null ? 'earlier' : null,
          );
        await showDetail(tester, api);
        if (hasEarlier) {
          expect(
            find.text(
              'Standing text from before history recording is unavailable.',
            ),
            findsNothing,
          );
          expect(
            find.text('This standing update is not in the loaded history.'),
            findsOneWidget,
          );
          await tester.tap(find.text('Show more updates'));
          await tester.pumpAndSettle();
          expect(
            find.byWidgetPredicate(
              (w) => w is SelectableText && w.data == 'current text',
            ),
            findsOneWidget,
          );
          expect(
            find.text('This standing update is not in the loaded history.'),
            findsNothing,
          );
        } else {
          expect(
            find.text(
              'Standing text from before history recording is unavailable.',
            ),
            findsOneWidget,
          );
        }
      });
    });
  }
  testWidgets('slim mesh title and narrow rich context are safe', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final ob = makeObligation(
        'detail',
        ownerId: 'root',
        title: 'Mesh reference detail',
        externalRef: 'mesh:messages/synthetic',
      );
      const reference = ReferenceDto(
        ref: 'mesh:messages/synthetic',
        scheme: 'mesh',
        title: 'root → peer',
        body:
            'Synthetic long reference context that wraps within a narrow dialog without losing content.',
        entity: {
          'type': 'mesh_message',
          'senderId': 'root',
          'recipientId': 'peer',
        },
      );
      final api = FakeApi()
        ..threadsResult = [makeThread('root'), makeThread('peer')]
        ..obligationsResult = [ob]
        ..referencesResult[reference.ref] = reference;
      await showDetail(tester, api, size: const Size(390, 844));
      expect(find.text('root → peer'), findsNothing);
      expect(find.text('root-handle → peer-handle'), findsOneWidget);
      await tester.ensureVisible(find.byTooltip('View reference context'));
      await tester.tap(find.byTooltip('View reference context'));
      await tester.pumpAndSettle();
      expect(find.text('root-handle → peer-handle'), findsNWidgets(2));
      final rect = tester.getRect(find.byType(AlertDialog));
      expect(rect.left, greaterThanOrEqualTo(0));
      expect(rect.right, lessThanOrEqualTo(390));
      final previewText = find.text(reference.body!);
      expect(previewText, findsOneWidget);
      expect(tester.getRect(previewText).width, lessThan(390));
      expect(tester.takeException(), isNull);
    });
  });

  testWidgets(
    'terminal done obligation places the status chip adjacent to the title without floating right',
    (tester) async {
      await tester.runAsync(() async {
        final ob = makeObligation(
          'detail',
          ownerId: 'root',
          title: 'Export run history as CSV',
          status: 'done',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root')]
          ..obligationsResult = [ob];
        await showDetail(tester, api, size: const Size(1600, 1000));

        final title = find.byKey(const ValueKey('obligation-detail-title'));
        final actions = find.byKey(const ValueKey('obligation-detail-actions'));
        expect(title, findsOneWidget);
        expect(actions, findsOneWidget);

        final titleRect = tester.getRect(title);
        final actionsRect = tester.getRect(actions);
        // The title hugs its text rather than expanding across the header, so
        // the done chip follows the last glyph instead of the right edge.
        final painter = TextPainter(
          text: TextSpan(
            text: ob.heading,
            style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
          ),
          textDirection: TextDirection.ltr,
        )..layout();
        addTearDown(painter.dispose);
        // Allow for the selectable text's caret padding, nothing more.
        expect(
          titleRect.width,
          inInclusiveRange(painter.width, painter.width + 16),
        );
        expect(actionsRect.left, closeTo(titleRect.right + 8, 1));
        expect(actionsRect.center.dy, closeTo(titleRect.center.dy, 1.0));

        // Done status chip is inside actions.
        expect(
          find.descendant(of: actions, matching: find.text('DONE')),
          findsOneWidget,
        );
        // Terminal obligation does not render action buttons.
        expect(find.byTooltip('Mark Done'), findsNothing);
        expect(find.byTooltip('Cancel Obligation'), findsNothing);
        expect(tester.takeException(), isNull);
      });
    },
  );

  testWidgets(
    'people list entries are clickable to navigate to actor inbox and omit explicit inbox icon button',
    (tester) async {
      await tester.runAsync(() async {
        final ob = makeObligation(
          'detail',
          ownerId: 'coder',
          creatorId: 'steward',
          title: 'Task with actor people',
          status: 'ready',
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('coder'), makeThread('steward')]
          ..obligationsResult = [ob];

        DashboardView? navigatedView;
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);

        await showDetail(
          tester,
          api,
          store: store,
          onSelectView: (v) => navigatedView = v,
        );

        // Explicit inbox icon button is removed.
        expect(find.byIcon(Icons.inbox_outlined), findsNothing);

        // Both owner and creator entries have tooltips and are clickable.
        expect(find.byTooltip('View Owner Inbox →'), findsOneWidget);
        expect(find.byTooltip('View Creator Inbox →'), findsOneWidget);

        // Tap owner entry: navigates to coder's inbox.
        await tester.tap(find.byTooltip('View Owner Inbox →'));
        await tester.pumpAndSettle();

        expect(store.primary.value, 'coder');
        expect(store.detailPanelIndex.value, 4);
        expect(navigatedView, DashboardView.actors);

        // Tap creator entry: navigates to steward's inbox.
        await tester.tap(find.byTooltip('View Creator Inbox →'));
        await tester.pumpAndSettle();

        expect(store.primary.value, 'steward');
        expect(store.detailPanelIndex.value, 4);
        expect(navigatedView, DashboardView.actors);

        expect(tester.takeException(), isNull);
      });
    },
  );
}
