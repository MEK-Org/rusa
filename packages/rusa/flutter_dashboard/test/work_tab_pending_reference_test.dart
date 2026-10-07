// #595: a cited reference the server answered "pending" (its provider read
// outlived the 250ms first-response budget) converges in the open detail view
// through a bounded re-ask, without a reload, a selection change or a write.
// Since #940 the re-ask goes to `/api/mesh/references` alone: the detail is
// fetched once.

import 'dart:async';
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
  late FakeStream stream;

  final obA = makeObligation('ob-a', ownerId: 'root', intent: 'Cites a chat');
  final obB = makeObligation('ob-b', ownerId: 'root', intent: 'Other work');

  /// Serves ob-a citing [_ref], answered as [referenceFor] gives on each
  /// successive ask.
  void serve(ReferenceDto Function(int ask) referenceFor) {
    var asks = 0;
    api.obligationDetailByOffset = (id, _) {
      detailCalls.add(id);
      final ob = id == obA.id ? obA : obB;
      return ObligationDetailSnapshot(
        obligation: ob,
        children: const [],
        blockingChildren: const [],
        artifacts: [if (id == obA.id) const ObligationArtifactDto(ref: _ref)],
      );
    };
    api.referenceFor = (ref) => ref == _ref ? referenceFor(asks++) : null;
  }

  /// How many reference batches asked for [ref].
  int asksFor(String ref) =>
      api.referenceRequests.where((batch) => batch.contains(ref)).length;

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
    stream = FakeStream();
    store = DashboardStore(api: api, stream: stream);
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
    expect(find.text('Chat message'), findsOneWidget);
    await tester.tap(find.byTooltip('View reference context'));
    await tester.pumpAndSettle();
    expect(find.text('Late but real'), findsOneWidget);
    await tester.tap(find.text('Close'));
    await tester.pumpAndSettle();

    // Resolved is terminal: nothing more is asked, and the detail itself was
    // fetched once.
    await tester.pump(_pastCeiling);
    expect(asksFor(_ref), 2);
    expect(detailCalls, [obA.id]);
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
    expect(asksFor(_ref), 2);
    expect(detailCalls, [obA.id]);
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

    expect(asksFor(_ref), 1 + pendingReferenceRetryDelays.length);
    expect(detailCalls, [obA.id]);
    expect(find.text('loading context'), findsNothing);
    expect(find.text('could not load context'), findsOneWidget);
    await tester.runAsync(store.dispose);
  });

  testWidgets('a citation that turns pending after another gave up gets its '
      'own retries', (tester) async {
    const refB = 'github:MEK-Org/rusa/issues/2';
    var withB = false;
    var asksOfB = 0;
    api.obligationDetailByOffset = (id, _) {
      detailCalls.add(id);
      return ObligationDetailSnapshot(
        obligation: obA,
        children: const [],
        blockingChildren: const [],
        artifacts: [
          const ObligationArtifactDto(ref: _ref),
          if (withB) const ObligationArtifactDto(ref: refB),
        ],
      );
    };
    api.referenceFor = (ref) {
      if (ref == _ref) return _pending();
      if (ref != refB) return null;
      final bFirst = asksOfB++ == 0;
      return ReferenceDto(
        ref: refB,
        scheme: 'github',
        title: bFirst ? refB : 'The second issue',
        unavailable: bFirst ? 'loading context' : null,
        cacheState: bFirst ? 'pending' : 'fresh',
        entity: bFirst
            ? null
            : const {
                'type': 'github_issue',
                'title': 'The second issue',
                'description': 'Second body',
              },
      );
    };
    await mount(tester);
    await open(tester, 'Cites a chat');
    for (final delay in pendingReferenceRetryDelays) {
      await tester.pump(delay);
      await tester.pump();
    }
    await tester.pump(_pastCeiling);
    await tester.pump();
    expect(find.text('could not load context'), findsOneWidget);
    final spent = asksFor(_ref);

    // A second citation is attached; the write's event refreshes the pane.
    withB = true;
    stream.meshCtrl.add(
      MeshEvent(
        id: 'attach-b',
        ts: '2026-10-01T21:00:00.000Z',
        kind: 'obligation_checkpoint_set',
        actorId: 'root',
        detail: obA.id,
        body: null,
        payload: '{"cleared":false}',
        success: null,
      ),
    );
    // The store relays the event, then the pane refetches and rebuilds.
    for (var i = 0; i < 4; i += 1) {
      await tester.pump();
    }

    // The new citation starts its own ladder; the one that gave up stays put.
    expect(find.text('loading context'), findsOneWidget);
    expect(find.text('could not load context'), findsOneWidget);

    await tester.pump(pendingReferenceRetryDelays.first);
    await tester.pump();
    expect(find.text('loading context'), findsNothing);
    expect(find.textContaining('The second issue'), findsWidgets);
    expect(find.text('could not load context'), findsOneWidget);

    // Only the new citation is pending now, and it resolved: nothing more.
    // The refetch re-asked the citation that gave up once; its ladder did
    // not restart.
    await tester.pump(_pastCeiling);
    expect(asksFor(refB), 2);
    expect(asksFor(_ref) - spent, 1);
    expect(detailCalls, [obA.id, obA.id]);
    await tester.runAsync(store.dispose);
  });

  testWidgets('navigating away cancels the retry and never updates the new '
      'selection', (tester) async {
    serve((call) => call == 0 ? _pending() : _resolved());
    await mount(tester);
    await open(tester, 'Cites a chat');
    expect(find.text('loading context'), findsOneWidget);

    await open(tester, 'Other work');
    final afterNavigation = api.referenceRequests.length;
    await tester.pump(_pastCeiling);
    await tester.pump();

    expect(api.referenceRequests.skip(afterNavigation), isEmpty);
    expect(detailCalls, [obA.id, obB.id]);
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
      return ObligationDetailSnapshot(
        obligation: linked,
        children: const [],
        blockingChildren: const [],
      );
    };
    api.referenceFor = (ref) {
      final first = calls++ == 0;
      return ReferenceDto(
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

  testWidgets('navigating A -> B -> A drops slow response from first A load', (tester) async {
    final gateA1 = Completer<void>();
    api.obligationDetailByOffset = (id, _) {
      detailCalls.add(id);
      return ObligationDetailSnapshot(
        obligation: id == obA.id ? obA : obB,
        children: const [],
        blockingChildren: const [],
        artifacts: id == obA.id ? const [ObligationArtifactDto(ref: _ref)] : const [],
      );
    };
    api.referencesGate = gateA1;
    api.referencesResult = {_ref: const ReferenceDto(ref: _ref, scheme: 'gchat', title: 'Obsolete title')};

    await mount(tester);
    await open(tester, 'Cites a chat');
    expect(find.text('loading context'), findsOneWidget);

    await open(tester, 'Other work');
    api.referencesGate = null;
    api.referencesResult = {_ref: _resolved()};
    await open(tester, 'Cites a chat');
    await tester.pump();
    expect(find.text('Chat message'), findsOneWidget);

    gateA1.complete();
    await tester.pump();

    expect(find.text('Chat message'), findsOneWidget);
    expect(find.text('Obsolete title'), findsNothing);
    await tester.runAsync(store.dispose);
  });
}

