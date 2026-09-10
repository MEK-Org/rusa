import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/obligation_card.dart';
import 'package:rusa_dashboard/widgets/obligation_status.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

/// The colour a status chip's label is drawn in — the chip's whole point, and
/// the thing a reader actually distinguishes at a glance.
Color chipLabelColor(WidgetTester tester, String label) =>
    tester.widget<Text>(find.text(label)).style!.color!;

Color dotColor(WidgetTester tester) {
  final container = tester.widget<Container>(
    find.descendant(
      of: find.byType(ObligationStatusDot),
      matching: find.byType(Container),
    ),
  );
  return (container.decoration! as BoxDecoration).color!;
}

ActorStateSnapshot snapshotOf(List<ThreadDto> threads) => ActorStateSnapshot(
  actors: {
    for (final t in threads)
      t.id: ActorViewState(thread: t, runState: t.runState),
  },
  orderedIds: [for (final t in threads) t.id],
);

void main() {
  group('presentation state', () {
    test('each persisted status maps to its own state', () {
      expect(
        ObligationPresentationState.fromStatus('waiting'),
        ObligationPresentationState.waiting,
      );
      expect(
        ObligationPresentationState.fromStatus('ready'),
        ObligationPresentationState.ready,
      );
      expect(
        ObligationPresentationState.fromStatus('scheduled'),
        ObligationPresentationState.scheduled,
      );
      expect(
        ObligationPresentationState.fromStatus('done'),
        ObligationPresentationState.done,
      );
      expect(
        ObligationPresentationState.fromStatus('cancelled'),
        ObligationPresentationState.cancelled,
      );
    });

    test('a status this client has never heard of stays unknown', () {
      expect(
        ObligationPresentationState.fromStatus('parked'),
        ObligationPresentationState.unknown,
      );
      expect(
        makeObligation('o', status: 'parked')
            .presentationState(activelyWorked: true),
        ObligationPresentationState.unknown,
      );
    });

    test('a worked live obligation reads active, ready or waiting alike', () {
      expect(
        makeObligation('o', status: 'ready')
            .presentationState(activelyWorked: true),
        ObligationPresentationState.active,
      );
      expect(
        makeObligation('o', status: 'waiting')
            .presentationState(activelyWorked: true),
        ObligationPresentationState.active,
      );
    });

    test('a terminal or scheduled status outranks an in-flight run', () {
      for (final status in ['done', 'cancelled', 'scheduled']) {
        expect(
          makeObligation('o', status: status)
              .presentationState(activelyWorked: true),
          ObligationPresentationState.fromStatus(status),
          reason: '$status is a durable fact, not a live one',
        );
      }
    });

    test('with no actor on it, a live obligation keeps its own status', () {
      expect(
        makeObligation('o', status: 'ready')
            .presentationState(activelyWorked: false),
        ObligationPresentationState.ready,
      );
      expect(
        makeObligation('o', status: 'waiting')
            .presentationState(activelyWorked: false),
        ObligationPresentationState.waiting,
      );
    });
  });

  group('isObligationActive', () {
    final focus = makeObligation('arc', ownerId: 'worker');

    test('true while the owning run is live', () {
      for (final state in [RunState.running, RunState.windingDown]) {
        final snap = snapshotOf([
          makeThread('worker', runState: state, selectedObligation: focus),
        ]);
        expect(snap.isObligationActive('arc'), isTrue, reason: '$state');
      }
    });

    test('false for a queued or idle actor still carrying a focus', () {
      // The store clears the focus at that boundary, but a thread payload that
      // still carries one must not be enough to claim someone is working.
      for (final state in [RunState.queued, RunState.idle, RunState.unknown]) {
        final snap = snapshotOf([
          makeThread('worker', runState: state, selectedObligation: focus),
        ]);
        expect(snap.isObligationActive('arc'), isFalse, reason: '$state');
      }
    });

    test('false when the live run is focused on a different obligation', () {
      final snap = snapshotOf([
        makeThread(
          'worker',
          runState: RunState.running,
          selectedObligation: makeObligation('other', ownerId: 'worker'),
        ),
      ]);
      expect(snap.isObligationActive('arc'), isFalse);
    });

    test('false when no actor has any focus at all', () {
      final snap = snapshotOf([
        makeThread('worker', runState: RunState.running),
      ]);
      expect(snap.isObligationActive('arc'), isFalse);
    });

    test('true when any actor works it, not only its owner', () {
      // Ownership can be reassigned mid-run; the colour follows the run.
      final snap = snapshotOf([
        makeThread('idle-owner', runState: RunState.idle),
        makeThread(
          'helper',
          runState: RunState.running,
          selectedObligation: focus,
        ),
      ]);
      expect(snap.isObligationActive('arc'), isTrue);
    });
  });

  group('colour mapping', () {
    test('follows the actor palette, with blue done and red cancelled', () {
      expect(
        ObligationStatusColors.of(ObligationPresentationState.waiting).dot,
        MeshColors.statusRetired,
      );
      expect(
        ObligationStatusColors.of(ObligationPresentationState.ready).dot,
        MeshColors.statusIdle,
      );
      expect(
        ObligationStatusColors.of(ObligationPresentationState.active).dot,
        MeshColors.statusActive,
      );
      expect(
        ObligationStatusColors.of(ObligationPresentationState.done).dot,
        const Color(0xFF3B82F6),
      );
      expect(
        ObligationStatusColors.of(ObligationPresentationState.cancelled).dot,
        MeshColors.statusHalted,
      );
    });

    test('green belongs to active alone', () {
      final greens = ObligationPresentationState.values
          .where(
            (s) =>
                ObligationStatusColors.of(s).dot == MeshColors.statusActive ||
                ObligationStatusColors.of(s).chipForeground ==
                    const Color(0xFF34D399),
          )
          .toList();
      expect(greens, [ObligationPresentationState.active]);
    });

    test('the label is the status, except for the synthetic state', () {
      final ob = makeObligation('arc', status: 'ready');
      expect(
        obligationStatusLabel(ob, ObligationPresentationState.ready),
        'READY',
      );
      expect(
        obligationStatusLabel(ob, ObligationPresentationState.active),
        'ACTIVE',
      );
      // An unknown status still says what the server said.
      expect(
        obligationStatusLabel(
          makeObligation('arc', status: 'parked'),
          ObligationPresentationState.unknown,
        ),
        'PARKED',
      );
    });
  });

  testWidgets('a row chip turns green while a run works it, and back', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final focus = makeObligation(
        'arc',
        ownerId: 'worker',
        status: 'ready',
        intent: 'The arc',
      );
      final api = FakeApi()
        ..runtimeCursor = const RuntimeCursor(
          streamId: 'colours',
          revision: 0,
        )
        ..threadsResult = [makeThread('worker', runState: RunState.idle)];
      final stream = FakeStream();
      final store = DashboardStore(api: api, stream: stream);
      await store.init();

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ObligationRow(obligation: focus, store: store),
          ),
        ),
      );
      await tester.pump();

      // Nobody is on it: ready, in the queued-actor yellow.
      expect(find.text('READY'), findsOneWidget);
      expect(chipLabelColor(tester, 'READY'), const Color(0xFFFBBF24));

      api.threadsResult = [
        makeThread(
          'worker',
          runState: RunState.running,
          selectedObligation: focus,
        ),
      ];
      stream.runtimeStatesCtrl.add(
        const ActorRuntimeStateDelta(
          streamId: 'colours',
          revision: 1,
          actorId: 'worker',
          runState: RunState.running,
          refreshThreadSnapshot: true,
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(find.text('READY'), findsNothing);
      expect(find.text('ACTIVE'), findsOneWidget);
      expect(chipLabelColor(tester, 'ACTIVE'), const Color(0xFF34D399));

      // The run ends. Nothing is working the obligation any more, so the chip
      // falls back to the persisted status rather than staying green.
      api
        ..threadsResult = [makeThread('worker', runState: RunState.idle)]
        ..runtimeCursor = const RuntimeCursor(
          streamId: 'colours',
          revision: 2,
        );
      stream.runtimeStatesCtrl.add(
        const ActorRuntimeStateDelta(
          streamId: 'colours',
          revision: 2,
          actorId: 'worker',
          runState: RunState.idle,
          refreshThreadSnapshot: true,
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(find.text('ACTIVE'), findsNothing);
      expect(find.text('READY'), findsOneWidget);

      await store.dispose();
    });
  });

  testWidgets('the work tree dot reads the same state as the chip', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final focus = makeObligation(
        'arc',
        ownerId: 'worker',
        status: 'waiting',
        intent: 'The arc',
      );
      final api = FakeApi()
        ..threadsResult = [
          makeThread(
            'worker',
            runState: RunState.running,
            selectedObligation: focus,
          ),
        ]
        ..obligationsResult = [focus];

      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: WorkTab(store: store, onSelectView: (_) {})),
        ),
      );
      await tester.pump();
      await tester.pump();

      // Waiting, but its owner is mid-run on it: green, like the actor dot.
      expect(dotColor(tester), MeshColors.statusActive);

      await store.dispose();
    });
  });

  testWidgets('an unworked waiting obligation reads grey, and done reads blue', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [makeThread('worker', runState: RunState.idle)];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Column(
              children: [
                ObligationRow(
                  obligation: makeObligation(
                    'waiting-arc',
                    status: 'waiting',
                    intent: 'Waiting arc',
                  ),
                  store: store,
                ),
                ObligationRow(
                  obligation: makeObligation(
                    'done-arc',
                    status: 'done',
                    intent: 'Done arc',
                  ),
                  store: store,
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pump();

      expect(chipLabelColor(tester, 'WAITING'), const Color(0xFF94A3B8));
      expect(chipLabelColor(tester, 'DONE'), const Color(0xFF60A5FA));

      await store.dispose();
    });
  });
}
