// #595: a cited reference the server answered "pending" (its provider read
// outlived the 250ms first-response budget) converges in the open detail view
// through a bounded refetch, without a reload, a selection change or a write.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

const _ref = 'gchat:spaces/AAAA/messages/abc.def';

ReferenceDto _pending() => const ReferenceDto(
  ref: _ref,
  scheme: 'gchat',
  title: _ref,
  unavailable: 'loading context',
  cacheState: 'pending',
);

ReferenceDto _resolved() => const ReferenceDto(
  ref: _ref,
  scheme: 'gchat',
  title: 'Chat message',
  entity: {'type': 'gchat_message', 'contents': 'Late but real'},
  cacheState: 'fresh',
);

ReferenceDto _unavailable() => const ReferenceDto(
  ref: _ref,
  scheme: 'gchat',
  title: _ref,
  unavailable: 'could not load context',
  cacheState: 'unavailable',
);

/// Total wait across every scheduled retry, plus slack.
Duration get _pastCeiling =>
    pendingReferenceRetryDelays.fold(Duration.zero, (a, b) => a + b) +
    const Duration(seconds: 5);

void main() {
  late FakeApi api;
  late DashboardStore store;
  late List<String> detailCalls;

  final obA = makeObligation('ob-a', ownerId: 'root', intent: 'Cites a chat');
  final obB = makeObligation('ob-b', ownerId: 'root', intent: 'Other work');

  /// Serves ob-a's artifact as [referenceFor] answers on each successive call.
  void serve(ReferenceDto Function(int call) referenceFor) {
    var calls = 0;
    api.obligationDetailByOffset = (id, _) {
      detailCalls.add(id);
      final ob = id == obA.id ? obA : obB;
      return ObligationDetailSnapshot(
        obligation: ob,
        children: const [],
        blockingChildren: const [],
        artifacts: [
          if (id == obA.id)
            ObligationArtifactDto(ref: _ref, reference: referenceFor(calls++)),
        ],
      );
    };
  }

  Future<void> open(WidgetTester tester, String intent) async {
    await tester.tap(find.text(intent));
    await tester.pump();
    await tester.pump();
  }

  setUp(() {
    detailCalls = [];
    api = FakeApi()
      ..threadsResult = [makeThread('root')]
      ..obligationsResult = [obA, obB];
    store = DashboardStore(api: api, stream: FakeStream());
  });

  Future<void> mount(WidgetTester tester) async {
    await store.init();
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: WorkTab(store: store, onSelectView: (_) {}),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
  }

  testWidgets('a pending card becomes the resolved message in the same view', (
    tester,
  ) async {
    serve((call) => call == 0 ? _pending() : _resolved());
    await mount(tester);
    await open(tester, 'Cites a chat');

    expect(find.text('loading context'), findsOneWidget);
    expect(find.text('Late but real'), findsNothing);

    await tester.pump(pendingReferenceRetryDelays.first);
    await tester.pump();

    expect(find.text('loading context'), findsNothing);
    expect(find.text('Late but real'), findsOneWidget);

    // Resolved is terminal: nothing more is fetched.
    final settled = detailCalls.length;
    await tester.pump(_pastCeiling);
    expect(detailCalls.length, settled);
    expect(detailCalls.where((id) => id == obA.id), hasLength(2));
    await tester.runAsync(store.dispose);
  });

  testWidgets('stops on a terminal unavailable answer, showing generic text', (
    tester,
  ) async {
    serve((call) => call == 0 ? _pending() : _unavailable());
    await mount(tester);
    await open(tester, 'Cites a chat');

    await tester.pump(_pastCeiling);
    await tester.pump();

    expect(find.text('could not load context'), findsOneWidget);
    expect(find.text('loading context'), findsNothing);
    expect(detailCalls.where((id) => id == obA.id), hasLength(2));
    await tester.runAsync(store.dispose);
  });

  testWidgets('gives up after the retry ceiling and shows it unavailable', (
    tester,
  ) async {
    serve((_) => _pending());
    await mount(tester);
    await open(tester, 'Cites a chat');

    for (final delay in pendingReferenceRetryDelays) {
      await tester.pump(delay);
      await tester.pump();
    }
    await tester.pump(_pastCeiling);
    await tester.pump();

    expect(
      detailCalls.where((id) => id == obA.id),
      hasLength(1 + pendingReferenceRetryDelays.length),
    );
    expect(find.text('loading context'), findsNothing);
    expect(find.text('could not load context'), findsOneWidget);
    await tester.runAsync(store.dispose);
  });

  testWidgets('navigating away cancels the retry and never updates the new '
      'selection', (tester) async {
    serve((call) => call == 0 ? _pending() : _resolved());
    await mount(tester);
    await open(tester, 'Cites a chat');
    expect(find.text('loading context'), findsOneWidget);

    await open(tester, 'Other work');
    final afterNavigation = detailCalls.length;
    await tester.pump(_pastCeiling);
    await tester.pump();

    expect(detailCalls.skip(afterNavigation), isEmpty);
    expect(detailCalls.last, obB.id);
    expect(find.text('Late but real'), findsNothing);
    expect(find.text('loading context'), findsNothing);
    await tester.runAsync(store.dispose);
  });

  testWidgets('a pending linked issue/PR converges too', (tester) async {
    var calls = 0;
    final linked = makeObligation(
      'ob-linked',
      ownerId: 'root',
      intent: 'Linked work',
      externalRef: 'github:MEK-Org/rusa/issues/1',
    );
    api.obligationsResult = [linked];
    api.obligationDetailByOffset = (id, _) {
      detailCalls.add(id);
      final first = calls++ == 0;
      return ObligationDetailSnapshot(
        obligation: linked,
        children: const [],
        blockingChildren: const [],
        externalReference: ReferenceDto(
          ref: 'github:MEK-Org/rusa/issues/1',
          scheme: 'github',
          title: first ? 'github:MEK-Org/rusa/issues/1' : 'The linked issue',
          unavailable: first ? 'loading context' : null,
          cacheState: first ? 'pending' : 'fresh',
          entity: first
              ? null
              : const {
                  'type': 'github_issue',
                  'title': 'The linked issue',
                  'description': 'Issue body',
                },
        ),
      );
    };
    await mount(tester);
    await open(tester, 'Linked work');
    expect(find.text('loading context'), findsOneWidget);

    await tester.pump(pendingReferenceRetryDelays.first);
    await tester.pump();

    expect(find.text('loading context'), findsNothing);
    expect(find.textContaining('The linked issue'), findsWidgets);
    await tester.runAsync(store.dispose);
  });
}
